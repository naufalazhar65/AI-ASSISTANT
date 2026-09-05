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

import { Client, Events, GatewayIntentBits, Message, Partials, REST, Routes, SlashCommandBuilder } from "discord.js";
import { runAssistantTurn, ChatMessage } from "@/lib/agent";
import { ToolCall } from "@/lib/tools";
import { subscribeReminders, Reminder } from "@/lib/reminders";
import { reminderMessage } from "@/lib/reminderMessage";
import { saveUpload } from "@/lib/uploads";
import { registerPushTarget } from "./pushTarget";
import { classifyAssistantError } from "@/lib/assistantError";
import { defaultProviderId } from "@/lib/providers";
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

const PROVIDER_DEFAULT = process.env.DISCORD_PROVIDER || defaultProviderId();

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
// Set once the client is ready so proactive pushes / send_channel can fall back
// to the owner's DM when no owner message has been seen since server start.
let activeClient: Client | null = null;

/**
 * Resolve the owner's DM as a sendable target. Falls back to the first
 * allow-listed owner user id; returns null when unavailable.
 */
async function ownerDmTarget(): Promise<SendableChannel | null> {
  const client = activeClient;
  const ownerId = ALLOWED_USER_IDS[0];
  if (!client || !ownerId) return null;
  try {
    const user = await client.users.fetch(ownerId);
    const dm = await user.createDM();
    return dm as unknown as SendableChannel;
  } catch {
    return null;
  }
}

/** Best-effort target for proactive pushes: the owner's last-seen channel,
 *  falling back to the owner's DM so a push never fails just because the owner
 *  hasn't messaged since restart. */
async function resolvePushTarget(): Promise<SendableChannel | null> {
  return lastSeenOwnerChannel ?? (await ownerDmTarget());
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
  activeClient = client;
  const sessions = new Map<string, ChatState>();

  const getState = (channelKey: string): ChatState => {
    let s = sessions.get(channelKey);
    if (!s) {
      s = { provider: PROVIDER_DEFAULT, history: [], pending: null };
      sessions.set(channelKey, s);
    }
    return s;
  };

  client.on(Events.ClientReady, async () => {
    console.log("[discord] logged in as", client.user?.tag);
    // Register slash commands for Mia so "/status" etc. appear under Mia, not just as prefix.
    // Do it once per startup; Discord dedupes by name. Register both global and per-guild for fast propagation.
    try {
      const commands = [
        new SlashCommandBuilder().setName("status").setDescription("Show Mia status (provider, uptime, counts)").toJSON(),
        new SlashCommandBuilder().setName("help").setDescription("Show help").toJSON(),
        new SlashCommandBuilder().setName("reset").setDescription("Clear this chat history").toJSON(),
        new SlashCommandBuilder()
          .setName("provider")
          .setDescription("Switch AI provider")
          .addStringOption((o) => o.setName("id").setDescription("groq / 9router / openrouter / opencode / mock").setRequired(true))
          .toJSON(),
        new SlashCommandBuilder()
          .setName("model")
          .setDescription("Set model (empty = Auto)")
          .addStringOption((o) => o.setName("id").setDescription("model id or empty for Auto").setRequired(false))
          .toJSON(),
      ];
      const rest = new REST({ version: "10" }).setToken(token);
      await rest.put(Routes.applicationCommands(client.user!.id), { body: commands });
      console.log("[discord] slash commands registered (global)");
      // Also register per-guild for instant availability (global can take 1h)
      for (const guild of client.guilds.cache.values()) {
        try {
          await rest.put(Routes.applicationGuildCommands(client.user!.id, guild.id), { body: commands });
          console.log(`[discord] slash registered for guild ${guild.id}`);
        } catch (e) {
          console.warn(`[discord] guild ${guild.id} slash failed:`, e instanceof Error ? e.message : String(e));
        }
      }
    } catch (e) {
      console.warn("[discord] slash register failed:", e instanceof Error ? e.message : String(e));
    }
  });
  // Surface gateway/connection problems that would otherwise silently drop
  // inbound messages (a zombie gateway is the #1 "bot doesn't respond" cause).
  client.on(Events.Error, (e) => console.error("[discord] client error:", e.message));
  client.on(Events.Warn, (w) => console.warn("[discord] client warn:", w));
  client.on(Events.Invalidated, () => console.warn("[discord] session invalidated"));
  // Debug: log every raw gateway event to see why slash shows "did not respond"
  // with no handler log. Keep it verbose for now.
  client.on(Events.Raw, (packet: { t: string | null; d: unknown }) => {
    // Log all packet types briefly, and full for INTERACTION_CREATE
    if (packet.t) {
      if (packet.t === "INTERACTION_CREATE") {
        console.log("[discord] raw INTERACTION_CREATE", JSON.stringify(packet.d).slice(0, 1500));
      } else if (Math.random() < 0.02) {
        // Sample other events to confirm raw is firing at all
        console.log("[discord] raw", packet.t);
      }
    }
  });
  // Handle slash-command interactions — now that we register them, handle
  // directly instead of guiding to prefix. Keep prefix "/" messages working too.
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      console.log(`[discord] interaction type=${interaction.type} id=${interaction.id} ${interaction.isChatInputCommand() ? `cmd=${interaction.commandName}` : interaction.isAutocomplete() ? "autocomplete" : "other"}`);
      if (interaction.isChatInputCommand()) {
        const cmd = interaction.commandName;
        // Allow-list check (same as messageCreate)
        const userId = interaction.user.id;
        const channelId = interaction.channelId ?? "dm";
        if (ALLOWED_USER_IDS.length && !ALLOWED_USER_IDS.includes(userId)) {
          await interaction.reply({ content: "Maaf, kamu belum di allow-list.", ephemeral: true }).catch(() => {});
          return;
        }
        if (ALLOWED_CHANNEL_IDS.length && channelId && !ALLOWED_CHANNEL_IDS.includes(channelId)) {
          await interaction.reply({ content: "Channel ini belum di allow-list.", ephemeral: true }).catch(() => {});
          return;
        }
        const deferOk = await interaction.deferReply({ ephemeral: false }).then(() => true).catch((e) => {
          console.warn("[discord] deferReply failed:", e instanceof Error ? e.message : String(e));
          return false;
        });
        if (!deferOk && !interaction.deferred && !interaction.replied) {
          await interaction.reply({ content: "Sebentar ya…", ephemeral: false }).catch(() => {});
          return;
        }
        const userKey = (interaction.user.username || interaction.user.id).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 60) || "naufal";
        const state = getState(channelId);
        // Track owner channel for pushes (interaction channel)
        if (interaction.channel && "send" in interaction.channel) {
          lastSeenOwnerChannel = interaction.channel as unknown as SendableChannel;
        }
        let replyText: string;
        if (cmd === "status") {
          replyText = buildStatusReport({ provider: state.provider, model: state.model, historyLen: state.history.length, user: userKey }, "Mia 2026.9");
        } else {
          // Reuse unified command handler by faking a text like "/provider 9router"
          const opt = interaction.options.data.map((o) => String(o.value ?? "")).join(" ").trim();
          const fakeText = `/${cmd}${opt ? ` ${opt}` : ""}`;
          const res = handleUnifiedCommand(state as ChatSessionState, fakeText);
          replyText = res.handled ? (res.replyText || "…") : `Perintah /${cmd} tidak dikenal.`;
        }
        await interaction.editReply(replyText.slice(0, 1900)).catch((e) => console.warn("[discord] editReply failed:", e instanceof Error ? e.message : String(e)));
        return;
      }
      if (interaction.isAutocomplete()) {
        await interaction.respond([]).catch(() => {});
      } else if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "Diterima. Gunakan perintah sebagai pesan biasa ya. 🌸", ephemeral: true }).catch(() => {});
      }
    } catch (e) {
      console.warn("[discord] interaction handling failed:", e instanceof Error ? e.message : String(e));
      try {
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: "Terjadi kendala. Coba lagi ya. 🌸", ephemeral: true });
        } else if (interaction.isRepliable() && interaction.deferred) {
          await interaction.editReply("Terjadi kendala. Coba lagi ya. 🌸");
        }
      } catch { /* ignore */ }
    }
  });

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
  subscribeReminders(async (reminder: Reminder) => {
    const target = await resolvePushTarget();
    if (target == null) return;
    const at = new Date(reminder.at);
    const timeLabel = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    target.send(`🌸 **Mia** — ${reminderMessage(reminder.text, timeLabel)}`).catch((e: unknown) => {
      console.warn("[discord] reminder push failed:", e instanceof Error ? e.message : String(e));
    });
  });

  // Register this bot as the proactive-output sink (scheduled automation results).
  registerPushTarget("discord", async (content: string) => {
    const target = await resolvePushTarget();
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