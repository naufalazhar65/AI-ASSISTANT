/**
 * Discord channel adapter (PRD v2.0 §8.1 FR-101 / ROADMAP Fase 2.3).
 *
 * Connects Mia to a private Discord bot via discord.js (WebSocket gateway — the
 * platform equivalent of Telegram's long-polling). Every incoming text in an
 * allow-listed DM/channel is pushed through the SAME shared core
 * (`runAssistantTurn` in `@/lib/agent`), so memory, persona, tools, and risky-tool
 * confirmation behave identically here. Discord renders GitHub-flavoured Markdown
 * natively (**bold**, *italic*, `code`, ```code block```), so we give the model a
 * Discord-flavoured formatting hint and send the text as-is (no escape/markup
 * transformation like Telegram needs).
 *
 * Started from Next.js `instrumentation.ts` so the whole assistant runs as ONE
 * process (single-instance personal deploy), mirroring the Telegram adapter.
 *
 * Security (invariant 5 / trust boundary): only an allow-listed owner is served
 * (from env), and the bot token lives server-side only.
 *
 * Env (apps/web/.env.local):
 *   DISCORD_BOT_TOKEN             required
 *   DISCORD_ALLOWED_USER_ID       owner discord user id (snowflake string, or comma list)
 *   DISCORD_ALLOWED_CHANNEL_ID    optional: only serve this channel id (or comma list)
 *   DISCORD_PROVIDER              default AI provider (default "groq")
 *   DISCORD_USER                  fallback user key for persona (default "naufal")
 */

import { Client, Events, GatewayIntentBits, Message, Partials } from "discord.js";
import { runAssistantTurn, ChatMessage } from "@/lib/agent";
import { ToolCall } from "@/lib/tools";
import { subscribeReminders, Reminder } from "@/lib/reminders";
import { reminderMessage } from "@/lib/reminderMessage";
import { saveUpload } from "@/lib/uploads";
import { registerPushTarget } from "@/channels/pushTarget";
import { classifyAssistantError } from "@/lib/assistantError";
import { buildStatusReport } from "@/lib/status";
import { handleUnifiedCommand, ChatSessionState } from "@/lib/channelMessage";

/** Minimal sendable text surface we rely on (any discord.js text channel). */
type SendableChannel = { send: (content: string) => Promise<Message> };

type ChatState = {
  provider: string;
  model?: string;
  /** Persistent text-only conversation (user/assistant) used as LLM context. */
  history: ChatMessage[];
  /** Waiting for a yes/no confirmation of a risky tool (FR-014). */
  pending: { messages: ChatMessage[]; call: ToolCall } | null;
};

const PROVIDER_DEFAULT = process.env.DISCORD_PROVIDER || "groq";

const ALLOWED_USER_IDS = (process.env.DISCORD_ALLOWED_USER_ID || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ALLOWED_CHANNEL_IDS = (process.env.DISCORD_ALLOWED_CHANNEL_ID || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Owner DM/channel for proactive reminder pushes; recorded from any owner msg
 *  (the object itself has `.send`, so no cache/id resolution needed — and when a
 *  `DISCORD_ALLOWED_CHANNEL_ID` is set, that channel IS what the owner messages
 *  land in). */
let lastSeenOwnerChannel: SendableChannel | null = null;

/** Best-effort target for proactive pushes: the owner's last-seen channel. */
function pushTargetChannel(): SendableChannel | null {
  return lastSeenOwnerChannel;
}

function isAllowedUser(msg: Message): boolean {
  return !ALLOWED_USER_IDS.length || ALLOWED_USER_IDS.includes(msg.author.id);
}
function isAllowedChannel(msg: Message): boolean {
  return !ALLOWED_CHANNEL_IDS.length || ALLOWED_CHANNEL_IDS.includes(msg.channelId);
}
function isAllowedMessage(msg: Message): boolean {
  return isAllowedUser(msg) && isAllowedChannel(msg);
}

/** User key for per-user persona/memory; falls back to the owner id slug. */
function userKeyFor(msg: Message): string {
  const slug = (msg.author.username || msg.author.id).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 60);
  return slug || process.env.DISCORD_USER || "naufal";
}

export function isValidDiscordConfig(): boolean {
  return !!process.env.DISCORD_BOT_TOKEN && (ALLOWED_USER_IDS.length > 0 || !!process.env.DISCORD_USER);
}

/** Singleton guard: only one client per process (Next invokes register twice). */
let startAttempted = false;

export async function startDiscordBot(): Promise<void> {
  if (startAttempted) return;
  startAttempted = true;
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.log("[discord] DISCORD_BOT_TOKEN not set — bot not started");
    return;
  }
  if (!ALLOWED_USER_IDS.length && !process.env.DISCORD_USER) {
    console.log("[discord] no owner allow-list configured (DISCORD_ALLOWED_USER_ID) — bot not started");
    return;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    // Allow DM channels / messages that aren't fully cached yet (a first-ever
    // DM arrives as a bare packet; without these partials discord.js drops the
    // messageCreate event even though the raw MESSAGE_CREATE is received).
    partials: [Partials.Channel, Partials.Message],
  });
  const sessions = new Map<string, ChatState>();

  const getState = (channelKey: string): ChatState => {
    let s = sessions.get(channelKey);
    if (!s) {
      s = { provider: PROVIDER_DEFAULT, history: [], pending: null };
      sessions.set(channelKey, s);
    }
    return s;
  };

  client.on(Events.ClientReady, () => {
    console.log("[discord] logged in as", client.user?.tag);
  });
  // Surface gateway/connection problems that would otherwise silently drop
  // inbound messages (a zombie gateway is the #1 "bot doesn't respond" cause).
  client.on(Events.Error, (e) => console.error("[discord] client error:", e.message));
  client.on(Events.Warn, (w) => console.warn("[discord] client warn:", w));
  client.on(Events.Invalidated, () => console.warn("[discord] session invalidated"));

  client.on("messageCreate", async (msg: Message) => {
    try {
      // Unwrap a partial message (first-ever DM arrives partly cached).
      if (msg.partial) {
        try {
          await msg.fetch();
        } catch {
          return;
        }
      }
      // Ignore the bot's own messages and (optionally) non-allow-listed channels.
      if (!msg.author || msg.author.bot) return;
      console.log(`[discord] msg author=${msg.author.id} channel=${msg.channelId} allowedUser=${isAllowedUser(msg)} allowedChannel=${isAllowedChannel(msg)}`);
      if (!isAllowedMessage(msg)) return;
      const user = userKeyFor(msg);
      // Deal with file attachments first (docs/images), then the text.
      let text = (msg.content || "").trim();
      const atts = msg.attachments ? [...msg.attachments.values()] : [];
      const fileContexts: string[] = [];
      for (const att of atts) {
        try {
          const res = await fetch(att.url);
          if (!res.ok) continue;
          const buf = Buffer.from(await res.arrayBuffer());
          const meta = saveUpload(
            user,
            att.name || "file.bin",
            att.contentType || "application/octet-stream",
            buf
          );
          const kb = (meta.size / 1024).toFixed(1);
          if (meta.isText && meta.textContent !== undefined) {
            fileContexts.push(`[The user uploaded file "${meta.name}" (${kb} KB). It is already saved by the system; do not save it again. Its text content:\n${meta.textContent.slice(0, 6000)}\n]`);
          } else {
            fileContexts.push(`[The user uploaded file "${meta.name}" (${kb} KB). It is already saved by the system; do not save it again.]`);
          }
        } catch (e) {
          console.warn("[discord] attachment fetch failed:", e instanceof Error ? e.message : String(e));
        }
      }

      // A message that is only a file (no text) still counts if we saved it.
      if (!text && !fileContexts.length) return;

      lastSeenOwnerChannel = msg.channel as unknown as SendableChannel;
      const chatId = msg.channelId;
      const state = getState(chatId);

      if (fileContexts.length) {
        const prefix = fileContexts.join("\n");
        text = text ? `${prefix}\n\n${text}` : prefix;
      }

      if (text.startsWith("/")) {
        await handleCommand(msg, state, text, user);
        return;
      }

      if (state.pending) {
        await handleConfirmation(msg, state, user, text);
        return;
      }

      await runTurn(msg, state, user, undefined, text);
    } catch (err) {
      console.error("[discord] handler error:", err instanceof Error ? (err.stack || err.message) : String(err));
      await msg.reply("Maaf, ada kendala internal. Coba lagi ya.").catch(() => {});
    }
  });

  // Proactive reminder push: deliver due reminders to the owner's channel/dm.
  subscribeReminders((reminder: Reminder) => {
    const target = pushTargetChannel();
    if (target == null) return;
    const at = new Date(reminder.at);
    const timeLabel = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    target.send(`🌸 **Mia** — ${reminderMessage(reminder.text, timeLabel)}`).catch((e: unknown) => {
      console.warn("[discord] reminder push failed:", e instanceof Error ? e.message : String(e));
    });
  });

  // Register this bot as the proactive-output sink (scheduled automation results).
  registerPushTarget("discord", async (content: string) => {
    const target = pushTargetChannel();
    if (target == null) throw new Error("no discord owner channel seen");
    return target.send(content);
  });

  console.log("[discord] connecting gateway…");
  // Login is one-shot; do NOT block readiness (reflects telegram's fire-and-forget).
  void client.login(token).catch((err) => {
    console.error("[discord] login failed:", err instanceof Error ? err.message : String(err));
  });
}

async function replyMia(msg: Message, text: string): Promise<Message> {
  const safe = text ?? "";
  // Discord renders GitHub-flavoured Markdown natively; send as-is. We reply to
  // the triggering message; fall back to a plain channel send on any error.
  return msg.reply(safe).catch(() => (msg.channel as unknown as SendableChannel).send(`> ${safe}`) as Promise<Message>);
}

async function handleCommand(msg: Message, state: ChatState, text: string, user: string): Promise<void> {
  if (text.startsWith("/status")) {
    await replyMia(
      msg,
      buildStatusReport(
        { provider: state.provider, model: state.model, historyLen: state.history.length, user },
        "Mia 2026.9 (scheduled automation)"
      )
    );
    return;
  }
  const res = handleUnifiedCommand(state as ChatSessionState, text);
  if (res.handled) {
    await replyMia(msg, res.replyText || "…");
    return;
  }
}

async function handleConfirmation(msg: Message, state: ChatState, user: string, text: string): Promise<void> {
  const pending = state.pending!;
  const yes = /^(ya|yes|y|setuju|lanjut|ok|oke)$/i.test(text);
  const no = /^(tidak|no|n|gak|nggak|skip|cancel|batal)$/i.test(text);
  if (!yes && !no) {
    await replyMia(msg, "Balas `ya` untuk melanjutkan, atau `tidak` untuk membatalkan.");
    return;
  }
  state.pending = null;
  await replyMia(msg, "Oke, sebentar ya…");
  let result: Awaited<ReturnType<typeof runAssistantTurn>>;
  try {
    result = await runAssistantTurn({
      messages: pending.messages,
      provider: state.provider,
      model: state.model,
      user,
      channel: "discord",
      confirm_call: { call: pending.call, allow: yes },
    });
  } catch (err) {
    console.error("[discord] confirm failed:", err instanceof Error ? err.message : String(err));
    await replyMia(msg, classifyAssistantError(err).userMessage);
    return;
  }
  state.history.push({ role: "assistant", content: result.text });
  await replyMia(msg, result.text || "Selesai.");
}

async function runTurn(
  msg: Message,
  state: ChatState,
  user: string,
  confirmCall: { call: ToolCall; allow: boolean } | undefined,
  userText: string | undefined
): Promise<void> {
  const turnMessages = [...state.history];
  if (userText) {
    turnMessages.push({ role: "user", content: userText });
    state.history.push({ role: "user", content: userText });
  }

  let result: Awaited<ReturnType<typeof runAssistantTurn>>;
  try {
    console.log(`[discord] turn start (provider=${state.provider})`);
    result = await runAssistantTurn({
      messages: turnMessages,
      provider: state.provider,
      model: state.model,
      user,
      channel: "discord",
      confirm_call: confirmCall,
    });
    console.log(`[discord] turn done (text len=${(result.text || "").length})`);
  } catch (err) {
    console.error("[discord] turn failed:", err instanceof Error ? err.message : String(err));
    await replyMia(msg, classifyAssistantError(err).userMessage);
    return;
  }

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
      msg,
      `Mia ingin melakukan aksi berikut: **${call.name}**${args ? ` — \`${args}\`` : ""}\nBalas \`ya\` untuk lanjut, atau \`tidak\` untuk membatalkan.`
    );
    return;
  }

  state.history.push({ role: "assistant", content: result.text });
  await replyMia(msg, result.text || "…");
}