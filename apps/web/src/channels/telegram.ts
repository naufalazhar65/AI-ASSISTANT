import { broadcastMiaState } from "@/lib/miaState";
import { chunkText, TELEGRAM_MAX, interimWaitText } from "./replyChunk";

/**
 * Telegram channel adapter (PRD v2.0 §8.1 FR-101).
 *
 * Connects Mia to a private Telegram bot via grammY long-polling. Every incoming
 * text is pushed through the SAME shared core (`runAssistantTurn` in
 * `@/lib/agent`) that the web route and other channels use, so memory, persona,
 * tools, and confirmation all behave identically here. Risky tools pause for a
 * "Balas 'ya' / 'tidak'" confirmation inline in the chat.
 *
 * This adapter is started from Next.js `instrumentation.ts` so the whole
 * assistant runs as ONE process (single-instance personal deploy).
 *
 * Security (invariant 5 / trust boundary): only an allow-listed owner is served
 * (from env), and the bot token lives server-side only.
 *
 * Env (apps/web/.env.local):
 *   TELEGRAM_BOT_TOKEN             required
 *   TELEGRAM_ALLOWED_USER_ID       owner chat/user id (number, or comma list)
 *   TELEGRAM_ALLOWED_USERNAME      owner telegram username (or comma list)
 *   TELEGRAM_PROVIDER              default AI provider (default "groq")
 *   TELEGRAM_USER                  fallback user key for persona (default from
 *                                  the telegram username, else "naufal")
 */

import { Bot, Context, InputFile } from "grammy";
import { runAssistantTurn, ChatMessage } from "@/lib/agent";
import { ToolCall } from "@/lib/tools";
import { subscribeReminders, Reminder } from "@/lib/reminders";
import { reminderMessage } from "@/lib/reminderMessage";
import { saveUpload } from "@/lib/uploads";
import { transcribeAudio } from "@/lib/stt";
import { synthesizeSpeech } from "@/lib/tts";
import { registerPushTarget } from "./pushTarget";
import { classifyAssistantError } from "@/lib/assistantError";
import { defaultProviderId } from "@/lib/providers";
import { buildStatusReport } from "@/lib/status";
import { handleUnifiedCommand, ChatSessionState } from "@/lib/channelMessage";

/**
 * Escape helper for Telegram legacy Markdown (parse_mode="Markdown"), which only
 * recognises `_italic_`, `*bold*`, `` `code` ``, ```code block``` and
 * `[links](url)`. We protect code/inline-code blocks and then escape stray
 * markup characters in prose so an LLM answer renders as emphasis instead of
 * literal `*`/`_`. If Telegram still rejects the entities (e.g. an unmatched
 * `**`), `replyMia` falls back to sending the raw text — the bot never fails to
 * deliver a message.
 */
function toTelegramMarkdown(text: string): string {
  const placeholders: string[] = [];
  const protect = (slice: string): string => {
    placeholders.push(slice);
    return `\u0000${placeholders.length - 1}\u0000`;
  };
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    // Code block: ``` ... ```
    if (text.startsWith("```", i)) {
      const end = text.indexOf("```", i + 3);
      if (end !== -1) {
        out += protect(text.slice(i, end + 3));
        i = end + 3;
        continue;
      }
    }
    // Inline code: ` ... `
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        out += protect(text.slice(i, end + 1));
        i = end + 1;
        continue;
      }
    }
    // Escape characters that could start unintended markup in plain prose.
    const c = text[i];
    if (c === "\\" || c === "[" || c === "`") {
      out += "\\" + c;
    } else {
      out += c;
    }
    i += 1;
  }
  for (let k = 0; k < placeholders.length; k++) {
    out = out.replaceAll(`\u0000${k}\u0000`, placeholders[k]);
  }
  return out;
}

function isMarkdownEntityError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /can't parse|parse entities|unmatched/i.test(msg);
}

/** Send a Mia reply with light Markdown, falling back to plain text on error. */
async function replyMia(ctx: Context, text: string): Promise<void> {
  const safe = text ?? "";
  for (const chunk of chunkText(safe, TELEGRAM_MAX)) {
    try {
      await ctx.reply(toTelegramMarkdown(chunk), { parse_mode: "Markdown" });
      console.log(`[telegram] replied (markdown) to chat ${ctx.chat?.id ?? "?"}`);
    } catch (err) {
      if (isMarkdownEntityError(err)) {
        console.log(`[telegram] markdown rejected (${isMarkdownEntityError(err) ? "entity" : ""}); sending plain`);
        await ctx.reply(chunk).catch(() => {});
      } else {
        console.error("[telegram] reply error (rethrow):", err instanceof Error ? err.message : String(err));
        throw err;
      }
    }
  }
}

type ChatState = {
  provider: string;
  model?: string;
  /** Persistent text-only conversation (user/assistant) used as LLM context. */
  history: ChatMessage[];
  /** Waiting for a yes/no confirmation of a risky tool (FR-014). */
  pending: { messages: ChatMessage[]; call: ToolCall } | null;
};

const PROVIDER_DEFAULT = process.env.TELEGRAM_PROVIDER || defaultProviderId();

const ALLOWED_USER_IDS = (process.env.TELEGRAM_ALLOWED_USER_ID || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ALLOWED_USERNAMES = (process.env.TELEGRAM_ALLOWED_USERNAME || "")
  .split(",")
  .map((s) => s.trim().toLowerCase().replace(/^@/, ""))
  .filter(Boolean);

/**
 * Owner chat to send proactive reminder pushes to. Prefer an explicit
 * `TELEGRAM_CHAT_ID` / `TELEGRAM_ALLOWED_USER_ID`, but also remember the chat
 * id of the last message from the owner so a username-only allow-list still
 * delivers reminders (the proactive push would otherwise silently never fire).
 */
const ownerChatId = process.env.TELEGRAM_CHAT_ID
  ? Number(process.env.TELEGRAM_CHAT_ID)
  : ALLOWED_USER_IDS[0]
    ? Number(ALLOWED_USER_IDS[0])
    : null;
let lastSeenOwnerChat: number | null = null;

/** Best-effort target for proactive pushes: explicit id, else the owner's chat. */
function pushTarget(): number | null {
  return ownerChatId ?? lastSeenOwnerChat;
}

function isAllowedUser(ctx: Context): boolean {
  const from = ctx.from;
  if (!from) return false;
  if (ALLOWED_USER_IDS.length && ALLOWED_USER_IDS.includes(String(from.id))) return true;
  if (ALLOWED_USERNAMES.length && from.username && ALLOWED_USERNAMES.includes(from.username.toLowerCase())) return true;
  return ALLOWED_USER_IDS.length === 0 && ALLOWED_USERNAMES.length === 0;
}

/** User key for per-user persona/memory; falls back to the telegram username. */
function userKeyFor(ctx: Context): string {
  const fromUsername = (ctx.from?.username || "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 60);
  return fromUsername || process.env.TELEGRAM_USER || "naufal";
}

export function isValidTelegramConfig(): boolean {
  return !!process.env.TELEGRAM_BOT_TOKEN && (ALLOWED_USER_IDS.length > 0 || ALLOWED_USERNAMES.length > 0 || !!process.env.TELEGRAM_USER);
}

/** Singleton guard: only one bot instance per process (Next invokes register
 *  more than once in dev; two getUpdates long-pollers would 409 each other). */
let startAttempted = false;

export async function startTelegramBot(): Promise<void> {
  if (startAttempted) return;
  startAttempted = true;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log("[telegram] TELEGRAM_BOT_TOKEN not set — bot not started");
    return;
  }
  if (!ALLOWED_USER_IDS.length && !ALLOWED_USERNAMES.length && !process.env.TELEGRAM_USER) {
    console.log("[telegram] no owner allow-list configured (TELEGRAM_ALLOWED_USER_ID/USERNAME) — bot not started");
    return;
  }

  const bot = new Bot(token);
  const sessions = new Map<number, ChatState>();

  const getState = (chatId: number): ChatState => {
    let s = sessions.get(chatId);
    if (!s) {
      s = { provider: PROVIDER_DEFAULT, history: [], pending: null };
      sessions.set(chatId, s);
    }
    return s;
  };

  bot.on("message:text", async (ctx) => {
    try {
      if (!isAllowedUser(ctx)) {
        return; // ignore unknown senders (single-user trust boundary)
      }
      // Remember the owner's chat so proactive pushes (reminders) have a target
      // even when only a username allow-list is configured (no explicit chat id).
      lastSeenOwnerChat = ctx.chat.id;
      const chatId = ctx.chat.id;
      const text = (ctx.message.text || "").trim();
      const state = getState(chatId);
      const user = userKeyFor(ctx);

      if (text.startsWith("/")) {
        await handleCommand(ctx, state, text, user);
        return;
      }

      // Waiting for a yes/no confirmation of a risky tool.
      if (state.pending) {
        await handleConfirmation(ctx, state, user, text);
        return;
      }

      await runTurn(ctx, state, user, undefined, text);
    } catch (err) {
      console.error("[telegram] handler error:", err instanceof Error ? (err.stack || err.message) : String(err));
      await ctx.reply("Maaf, ada kendala internal. Coba lagi ya.").catch(() => {});
    }
  });

  // Voice note: transcribe (shared STT pipeline) then feed the transcript into
  // the SAME conversation flow as a typed message.
  bot.on("message:voice", async (ctx) => {
    try {
      if (!isAllowedUser(ctx)) return;
      lastSeenOwnerChat = ctx.chat.id;
      const voice = ctx.message.voice;
      if (!voice) return;
      await bot.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});
      const file = await ctx.getFile();
      const filePath = file.file_path;
      if (!filePath) {
        await ctx.reply("Voice belum tersedia, coba kirim lagi ya.").catch(() => {});
        return;
      }
      const buffer = await downloadTelegramFile(filePath);
      const transcript = await transcribeAudio({
        bytes: buffer,
        contentType: voice.mime_type || "audio/ogg",
      });
      const text = transcript.trim();
      if (!text) {
        await replyMia(ctx, "Aku kurang menangkap suaranya. Coba kirim lagi ya. 🎤");
        return;
      }
      console.log(`[telegram] voice transcribed (${text.length} chars)`);
      await runTurn(ctx, getState(ctx.chat.id), userKeyFor(ctx), undefined, text, true);
    } catch (err) {
      console.error("[telegram] voice handler error:", err instanceof Error ? err.message : String(err));
      await ctx.reply("Maaf, gagal membaca voice-mu. Coba lagi ya.").catch(() => {});
    }
  });

  // File upload: text documents are read and folded into the conversation as
  // context so the assistant can act on them; images/binary are saved only.
  const downloadTelegramFile = async (filePath: string): Promise<Buffer> => {
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };
  bot.on("message:document", async (ctx) => {
    try {
      if (!isAllowedUser(ctx)) return;
      lastSeenOwnerChat = ctx.chat.id;
      const doc = ctx.message.document;
      if (!doc) return;
      const file = await ctx.getFile();
      const filePath = file.file_path;
      if (!filePath) {
        await ctx.reply("Gagal membaca berkas (file belum tersedia).").catch(() => {});
        return;
      }
      const buffer = await downloadTelegramFile(filePath);
      const meta = saveUpload(
        userKeyFor(ctx),
        doc.file_name || "document.bin",
        doc.mime_type || "application/octet-stream",
        buffer
      );
      if (meta.isText && meta.textContent !== undefined) {
        await replyMia(
          ctx,
          `File \`${meta.name}\` tersimpan (${(meta.size / 1024).toFixed(1)} KB). Isinya kubaca:\n\`\`\`\n${meta.textContent.slice(0, 1500)}\n\`\`\`\nApa yang mau aku lakukan dengan file ini?`
        );
      } else {
        const kind = meta.isImage ? "gambar" : "berkas";
        await replyMia(ctx, `Berkas \`${meta.name}\` (${kind}, ${(meta.size / 1024).toFixed(1)} KB) tersimpan. `);
      }
    } catch (err) {
      console.error("[telegram] document handler error:", err instanceof Error ? err.message : String(err));
      await ctx.reply("Maaf, gagal menyimpan berkas itu.").catch(() => {});
    }
  });

  bot.on("message:photo", async (ctx) => {
    try {
      if (!isAllowedUser(ctx)) return;
      lastSeenOwnerChat = ctx.chat.id;
      const photo = ctx.message.photo;
      if (!photo || !photo.length) return;
      const file = await ctx.getFile();
      const filePath = file.file_path;
      if (!filePath) return;
      const buffer = await downloadTelegramFile(filePath);
      const user = userKeyFor(ctx);
      saveUpload(user, "photo.jpg", "image/jpeg", buffer);
      const caption = (ctx.message.caption || "").trim();
      const state = getState(Number(ctx.chat?.id ?? 0));
      const b64 = buffer.toString("base64");
      const dataUrl = `data:image/jpeg;base64,${b64}`;
      const visionContent = [
        { type: "text" as const, text: caption || "Tolong jelaskan gambar ini dengan rapi" },
        { type: "image_url" as const, image_url: { url: dataUrl } },
      ];
      await runTurnWithVision(ctx, state, user, visionContent, false);
    } catch (err) {
      console.error("[telegram] photo handler error:", err instanceof Error ? err.message : String(err));
      await ctx.reply("Maaf, gagal memproses foto itu.").catch(() => {});
    }
  });

  // Proactive reminder push: deliver due reminders to the owner's chat.
  subscribeReminders((reminder: Reminder) => {
    const target = pushTarget();
    if (target == null) return;
    const at = new Date(reminder.at);
    const timeLabel = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    bot.api
      .sendMessage(target, toTelegramMarkdown(`🌸 *Mia* — ${reminderMessage(reminder.text, timeLabel)}`), { parse_mode: "Markdown" })
      .catch((e) => {
        console.warn("[telegram] reminder push failed:", e instanceof Error ? e.message : String(e));
      });
  });

  // Register this bot as the proactive-output sink (scheduled automation results).
  registerPushTarget("telegram", async (content: string) => {
    const target = pushTarget();
    if (target == null) throw new Error("no telegram owner chat seen");
    return bot.api.sendMessage(target, toTelegramMarkdown(content), { parse_mode: "Markdown" });
  });

  console.log("[telegram] starting long-polling bot…");
  // Surface every per-update / middleware error so a broken reply is diagnosable
  // (grammY swallows these without an explicit catch handler).
  bot.catch((err) => {
    console.error("[telegram] update error:", err.error instanceof Error ? err.error.message : String(err.error));
  });
  // Do NOT await bot.start() here: it is a long-running poll loop that never
  // resolves, and instrumentation's `register` must complete before Next serves
  // requests (awaiting it would block server readiness). Run it fire-and-forget
  // with error handling so the bot lives in the background of the same process.
  void bot.start({ allowed_updates: ["message"] }).catch((err) => {
    console.error("[telegram] bot poll error:", err instanceof Error ? err.message : String(err));
  });
}

/** Send the assistant's answer as spoken WAV audio (Groq Orpheus; Indonesian
 *  reads in English pronunciation, same as the web). Audio-only (no text
 *  caption) — used for voice-note turns so there is no duplicate text. Falls
 *  back to returning false (caller sends text) on ANY failure, so a throttled
 *  TTS never blocks the reply. Enable via TELEGRAM_VOICE_REPLY=0. */
const voiceEnabled =
  process.env.TELEGRAM_VOICE_REPLY !== "0" && process.env.BOT_VOICE_REPLY !== "0";
async function sendVoiceReply(ctx: Context, text: string): Promise<boolean> {
  if (!voiceEnabled || !text) return false;
  try {
    const wav = await synthesizeSpeech({ text });
    await ctx.replyWithAudio(new InputFile(wav, "mia-voice.wav"), { title: "Mia 🌸" });
    return true;
  } catch (err) {
    console.warn("[telegram] voice reply skipped (text fallback):", err instanceof Error ? err.message : String(err));
    return false;
  }
}

async function handleCommand(ctx: Context, state: ChatState, text: string, user: string): Promise<void> {
  if (text.startsWith("/status")) {
    await replyMia(
      ctx,
      buildStatusReport(
        { provider: state.provider, model: state.model, historyLen: state.history.length, user },
        "Mia 2026.9 (scheduled automation)"
      )
    );
    return;
  }
  const res = handleUnifiedCommand(state as ChatSessionState, text);
  if (res.handled) {
    await replyMia(ctx, res.replyText || "…");
    return;
  }
}

/**
 * Telegram's "typing…" chat action lasts only ~5s — re-send it every 4.5s
 * while the awaited work runs so the indicator stays alive across long tool
 * rounds / confirm continuations.
 */
async function withTyping<T>(ctx: Context, fn: () => Promise<T>): Promise<T> {
  const chatId = ctx.chat?.id;
  let typing = true;
  const beat = (async () => {
    let last = 0;
    while (typing && chatId !== undefined) {
      if (Date.now() - last >= 4500) {
        last = Date.now();
        await ctx.api.sendChatAction(chatId, "typing").catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  })();
  try {
    return await fn();
  } finally {
    typing = false;
    await beat.catch(() => {});
  }
}

async function handleConfirmation(ctx: Context, state: ChatState, user: string, text: string): Promise<void> {
  const pending = state.pending!;
  const yes = /^(ya|yes|y|setuju|lanjut|ok|oke)$/i.test(text);
  const no = /^(tidak|no|n|gak|nggak|skip|cancel|batal)$/i.test(text);
  if (!yes && !no) {
    await replyMia(ctx, "Balas `ya` untuk melanjutkan, atau `tidak` untuk membatalkan.");
    return;
  }
  state.pending = null;
  await replyMia(ctx, interimWaitText());
  let result: Awaited<ReturnType<typeof runAssistantTurn>>;
  try {
    result = await withTyping(ctx, () =>
      runAssistantTurn({
        messages: pending.messages,
        provider: state.provider,
        model: state.model,
        user,
        channel: "text",
        confirm_call: { call: pending.call, allow: yes },
      })
    );
  } catch (err) {
    console.error("[telegram] confirm failed:", err instanceof Error ? err.message : String(err));
    await replyMia(ctx, classifyAssistantError(err).userMessage);
    return;
  }
  state.history.push({ role: "assistant", content: result.text });
  if (!(await sendVoiceReply(ctx, result.text))) {
    let fallback = "Selesai.";
    if (!result.text && pending.call.name.startsWith("plan_")) {
      fallback = pending.call.name === "plan_create"
        ? `Plan sudah kubuat beb — cek plan_list untuk lihat step-stepnya 🌸`
        : `Siap beb, step sudah kuupdate — lanjut ke step berikutnya yuk 🌸`;
    }
    await replyMia(ctx, result.text || fallback);
  }
}

async function runTurn(
  ctx: Context,
  state: ChatState,
  user: string,
  confirmCall: { call: ToolCall; allow: boolean } | undefined,
  userText: string | undefined,
  voiceTurn = false
): Promise<void> {
  // Append the new user message to the working history (unless this is a
  // confirmation continuation, where the LLM context already has the tool call).
  const turnMessages = [...state.history];
  if (userText) {
    turnMessages.push({ role: "user", content: userText });
    state.history.push({ role: "user", content: userText });
  }

  let result: Awaited<ReturnType<typeof runAssistantTurn>>;
  try {
    console.log(`[telegram] turn start (provider=${state.provider})`);
    broadcastMiaState("PROCESSING");
    result = await withTyping(ctx, () =>
      runAssistantTurn({
        messages: turnMessages,
        provider: state.provider,
        model: state.model,
        user,
        channel: "text",
        confirm_call: confirmCall,
      })
    );
    console.log(`[telegram] turn done (text len=${(result.text || "").length})`);
    broadcastMiaState(result.text ? "SPEAKING" : "IDLE", result.text || undefined);
    setTimeout(() => broadcastMiaState("IDLE"), 8000);
  } catch (err) {
    console.error("[telegram] turn failed:", err instanceof Error ? err.message : String(err));
    broadcastMiaState("IDLE");
    await replyMia(ctx, classifyAssistantError(err).userMessage);
    return;
  }

  // Risky tool requested → pause for inline yes/no confirmation (FR-014).
  if (result.needsConfirmation?.length) {
    state.pending = { messages: turnMessages, call: result.needsConfirmation[0] };
    const call = result.needsConfirmation[0];
    let args = "";
    try {
      args = JSON.stringify(JSON.parse(call.arguments || "{}"));
    } catch {
      /* ignore */
    }
    await replyMia(
      ctx,
      `Mia ingin melakukan aksi berikut: *${call.name}*${args ? ` — \`${args}\`` : ""}\nBalas \`ya\` untuk lanjut, atau \`tidak\` untuk membatalkan.`
    );
    return;
  }

  state.history.push({ role: "assistant", content: result.text });
  if (voiceTurn) {
    if (!(await sendVoiceReply(ctx, result.text))) {
      await replyMia(ctx, result.text || "Hmm, jawabannya kepotong — coba tanya lagi ya 🌸");
    }
  } else {
    await replyMia(ctx, result.text || "…");
  }
}

async function runTurnWithVision(
  ctx: Context,
  state: ChatState,
  user: string,
  visionContent: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>,
  voiceTurn = false
): Promise<void> {
  const textPart = visionContent.find((p) => p.type === "text")?.text || "";
  const turnMessages = [...state.history, { role: "user", content: visionContent as unknown as string }];
  state.history.push({ role: "user", content: textPart || "[gambar]" });
  let result: Awaited<ReturnType<typeof runAssistantTurn>>;
  try {
    broadcastMiaState("PROCESSING"); console.log(`[telegram] vision turn start (provider=${state.provider})`);
    result = await withTyping(ctx, () =>
      runAssistantTurn({ messages: turnMessages as never, provider: state.provider, model: state.model, user, channel: "text" })
    );
    console.log(`[telegram] vision turn done (text len=${(result.text || "").length})`); broadcastMiaState(result.text ? "SPEAKING" : "IDLE", result.text || undefined); setTimeout(() => broadcastMiaState("IDLE"), 8000);
  } catch (err) {
    broadcastMiaState("IDLE");
    console.error("[telegram] vision turn failed:", err instanceof Error ? err.message : String(err));
    await replyMia(ctx, classifyAssistantError(err).userMessage);
    return;
  }
  if (result.needsConfirmation?.length) {
    state.pending = { messages: turnMessages as never, call: result.needsConfirmation[0] };
    const call = result.needsConfirmation[0];
    let args = "";
    try { args = JSON.stringify(JSON.parse(call.arguments || "{}")); } catch {}
    await replyMia(ctx, `Mia ingin melakukan aksi berikut: *${call.name}*${args ? ` — \`${args}\`` : ""}\nBalas \`ya\` untuk lanjut, atau \`tidak\` untuk membatalkan.`);
    return;
  }
  state.history.push({ role: "assistant", content: result.text });
  if (voiceTurn) {
    if (!(await sendVoiceReply(ctx, result.text))) await replyMia(ctx, result.text || "…");
  } else await replyMia(ctx, result.text || "…");
}
