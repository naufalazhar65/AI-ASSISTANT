import { broadcastMiaState } from "../lib/miaState";
import { OWNER_KEY, canonicalUserKey } from "../lib/identity";
import { COMMAND_EMPTY_FALLBACK, DISCORD_MAX, EMPTY_REPLY_FALLBACK, chunkText, clockLabel, parseConfirmReply, pendingConfirmPrompt, stripMentions } from "./replyChunk";

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
 *   DISCORD_BOT_TOKEN             required (Mia)
 *   DISCORD_BOT_TOKEN_AGNES       optional (Agnes researcher bot)
 *   DISCORD_BOT_TOKEN_MICHELLE    optional (Michelle coder bot)
 *   DISCORD_ALLOWED_USER_ID       owner discord user id (snowflake string, or comma list)
 *   DISCORD_ALLOWED_CHANNEL_ID    optional: only serve this channel id (or comma list)
 *   DISCORD_CHANNEL_ID_MIA / _AGNES / _MICHELLE
 *                                 optional per-agent dedicated channel (that agent
 *                                 replies there without needing a mention)
 *   DISCORD_PROVIDER              default AI provider (default "groq")
 *   DISCORD_USER                  fallback user key for persona (default "naufal")
 * Trio (PRD Pixel Office §8 / ROADMAP Fase 4): one Next process can host up to
 * three bots — Mia (legacy reply-all behavior, unchanged), Agnes and Michelle
 * (reply only when mentioned, DM'd, or in their dedicated channel). Each bot
 * keeps its own sessions, confirmations, reminder scope, and push label, and
 * agent turns run under a suffixed user key (`owner`, `owner.agnes`,
 * `owner.michelle`) so memory/persona never bleed across agents. Agent role
 * files live at `persona/agents/<label>.{IDENTITY,SOUL}.md` and are seeded
 * idempotently into each agent user dir on first contact (Mia keeps her
 * existing persona untouched).
 */

import { Client, Events, GatewayIntentBits, Message, MessageFlags, Partials, REST, Routes, SlashCommandBuilder} from "discord.js";
import { runAssistantTurn, ChatMessage } from "../lib/agent";
import { ToolCall } from "../lib/tools";
import { subscribeReminders, Reminder } from "../lib/reminders";
import { reminderMessage } from "../lib/reminderMessage";
import { saveUpload } from "../lib/uploads";
import { transcribeAudio } from "../lib/stt";
import { synthesizeSpeech } from "../lib/tts";
import { registerPushTarget } from "./pushTarget";
import { classifyAssistantError } from "../lib/assistantError";
import { defaultProviderId } from "../lib/providers";
import { buildStatusReport } from "../lib/status";
import { handleUnifiedCommand, ChatSessionState } from "../lib/channelMessage";
import { alreadyProcessed, alreadyStarted } from "../lib/once";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { appRoot, userDataRoot } from "../lib/users";
import { ensureUserPersona } from "../lib/persona";
import { agentPersonaNeedsReseed } from "../lib/agentRole";

/** Minimal sendable text surface we rely on (any discord.js text channel). */
type SendableChannel = { send: (content: string) => Promise<Message> };

/** Keep Discord's typing indicator on a channel alive while `task` runs. The
 *  indicator fades after ~10s, so we re-trigger it every 8s and stop as soon as
 *  the task settles. Extra separators: best-effort, never fatal. */
async function withTyping<T>(channel: SendableChannel, task: () => Promise<T>): Promise<T> {
  const ch = channel as { sendTyping?: () => Promise<unknown> };
  let timer: ReturnType<typeof setInterval> | null = null;
  const pulse = (): void => {
    ch.sendTyping?.().catch(() => {});
  };
  if (ch.sendTyping) {
    timer = setInterval(pulse, 8000);
    pulse();
  }
  try {
    return await task();
  } finally {
    if (timer) clearInterval(timer);
  }
}

type ChatState = {
  provider: string;
  model?: string;
  /** Persistent text-only conversation (user/assistant) used as LLM context. */
  history: ChatMessage[];
  /** Waiting for a yes/no confirmation of risky tool(s) (FR-014). */
  pending: { messages: ChatMessage[]; calls: ToolCall[] } | null;
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

function parseIdList(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Trio agent label. "mia" is the legacy bot; behavior for Mia is unchanged. */
export type AgentLabel = "mia" | "agnes" | "michelle";

export interface AgentBotConfig {
  label: AgentLabel;
  displayName: string;
  statusName: string;
  token: string;
  providerDefault: string;
  allowedUsers: string[];
  allowedChannels: string[];
  /** Dedicated channel(s) where this agent replies without needing a mention. */
  dedicatedChannels: string[];
  userFallback: string;
  /** Suffix appended to the resolved user key ("" for Mia). Dots are
   *  sanitize-safe, so `owner.agnes` is a distinct user dir automatically. */
  userSuffix: string;
  pushLabels: string[];
  reminderBrand: string;
  /** Reminder slots are delivered only when the slot owner equals this key. */
  reminderScope: string;
  /** Owner gate for startup (same rule as the legacy single bot). */
  ownerConfigured: boolean;
  /** True when >1 trio bot is starting (mention-priority + gated Mia). */
  trioMode: boolean;
}

type AgentSpec = {
  label: AgentLabel;
  displayName: string;
  tokenEnv: string;
  envSuffix: string;
  providerEnv: string;
  userEnv: string;
  channelEnv: string;
  dedicatedEnv: string;
  userSuffix: string;
  pushLabels: string[];
};

const AGENT_SPECS: AgentSpec[] = [
  {
    label: "mia",
    displayName: "Mia",
    tokenEnv: "DISCORD_BOT_TOKEN",
    envSuffix: "",
    providerEnv: "DISCORD_PROVIDER",
    userEnv: "DISCORD_USER",
    channelEnv: "DISCORD_ALLOWED_CHANNEL_ID",
    dedicatedEnv: "DISCORD_CHANNEL_ID_MIA",
    userSuffix: "",
    pushLabels: ["discord", "discord-mia"],
  },
  {
    label: "agnes",
    displayName: "Agnes",
    tokenEnv: "DISCORD_BOT_TOKEN_AGNES",
    envSuffix: "_AGNES",
    providerEnv: "DISCORD_PROVIDER_AGNES",
    userEnv: "DISCORD_USER_AGNES",
    channelEnv: "DISCORD_ALLOWED_CHANNEL_ID_AGNES",
    dedicatedEnv: "DISCORD_CHANNEL_ID_AGNES",
    userSuffix: ".agnes",
    pushLabels: ["discord-agnes"],
  },
  {
    label: "michelle",
    displayName: "Michelle",
    tokenEnv: "DISCORD_BOT_TOKEN_MICHELLE",
    envSuffix: "_MICHELLE",
    providerEnv: "DISCORD_PROVIDER_MICHELLE",
    userEnv: "DISCORD_USER_MICHELLE",
    channelEnv: "DISCORD_ALLOWED_CHANNEL_ID_MICHELLE",
    dedicatedEnv: "DISCORD_CHANNEL_ID_MICHELLE",
    userSuffix: ".michelle",
    pushLabels: ["discord-michelle"],
  },
];

/** Full per-agent config resolved from env (shared values are fallbacks). */
export function agentConfigsFromEnv(): AgentBotConfig[] {
  return AGENT_SPECS.map((s) => {
    const userFallback = process.env[s.userEnv] || process.env.DISCORD_USER || "naufal";
    const ownUsers = parseIdList(process.env[`DISCORD_ALLOWED_USER_ID${s.envSuffix}`]);
    const allowedUsers = ownUsers.length > 0 ? ownUsers : ALLOWED_USER_IDS;
    const ownChannels = parseIdList(process.env[s.channelEnv]);
    const allowedChannels = ownChannels.length > 0 ? ownChannels : ALLOWED_CHANNEL_IDS;
    return {
      label: s.label,
      displayName: s.displayName,
      statusName: `${s.displayName} 2026.9`,
      token: process.env[s.tokenEnv] || "",
      providerDefault: process.env[s.providerEnv] || PROVIDER_DEFAULT,
      allowedUsers,
      allowedChannels,
      dedicatedChannels: parseIdList(process.env[s.dedicatedEnv]),
      userFallback,
      userSuffix: s.userSuffix,
      pushLabels: s.pushLabels,
      reminderBrand: s.displayName,
      reminderScope: s.label === "mia" ? OWNER_KEY : `${OWNER_KEY}${s.userSuffix}`,
      ownerConfigured:
        allowedUsers.length > 0 || !!process.env[s.userEnv] || !!process.env.DISCORD_USER,
      trioMode: false, // set by startDiscordBot once the enabled set is known
    };
  });
}

/** Agents with a token and an owner gate (same rule as the legacy single bot). */
export function enabledAgentConfigs(): AgentBotConfig[] {
  return agentConfigsFromEnv().filter((c) => !!c.token && c.ownerConfigured);
}

/** User key for an agent turn: Mia keeps the legacy key, agents get a
 *  suffixed key (distinct user dir → isolated memory/persona/sessions). */
export function userKeyForAgent(base: string, label: AgentLabel): string {
  const suffix = AGENT_SPECS.find((s) => s.label === label)?.userSuffix ?? "";
  return `${base}${suffix}`;
}

/** Trio routing (prevents triple replies). Solo Mia keeps legacy reply-all.
 *  In trio mode an explicit mention (member `<@id>` or role `<@&id>`
 *  name-match, resolved by trioMentionFlags) wins: a message addressing
 *  sibling bot(s) suppresses everyone not mentioned (DMs always reply).
 *  Unaddressed chatter goes to Mia alone (trio concierge — Mia stays the
 *  center of the owner's experience); a sibling joins unaddressed chatter
 *  only inside its OWN dedicated channel. Pure — unit-tested in verify.ts. */
export function shouldRespondToAgent(
  label: AgentLabel,
  opts: {
    mentioned: boolean;
    isDM: boolean;
    inDedicatedChannel: boolean;
    mentionedOtherTrioBot: boolean;
    trioMode: boolean;
  }
): boolean {
  if (!opts.trioMode) {
    if (label === "mia") return true;
    return opts.mentioned || opts.isDM || opts.inDedicatedChannel;
  }
  if (opts.mentioned) return true;
  if (opts.isDM) return true;
  if (opts.mentionedOtherTrioBot) return false;
  if (label === "mia") return true;
  return opts.inDedicatedChannel;
}

/** Extract lowercase role names from a mentions.roles shape. Accepts arrays
 *  and iterables of roles, plus discord.js Collections (iterables of
 *  [key, role] entries). Anything else yields []. Never throws — a malformed
 *  mentions shape must never break routing. */
function roleNamesFrom(roles: unknown): string[] {
  const out: string[] = [];
  try {
    if (!roles) return out;
    const arr: unknown[] = Array.isArray(roles)
      ? roles
      : typeof (roles as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function"
        ? Array.from(roles as Iterable<unknown>)
        : [];
    for (const item of arr) {
      const r = (Array.isArray(item) ? item[1] : item) as { name?: unknown } | undefined;
      if (typeof r?.name === "string" && r.name) out.push(r.name.toLowerCase());
    }
  } catch {
    // ignore — treated as "no role mentions"
  }
  return out;
}

/** Role-mention-aware mention flags. The owner addresses bots by ROLE name
 *  (`<@&id>`), so `mentions.has(botId)` (member `<@id>` only) misses it.
 *  `mentioned` = member-mention OR a mentioned role named like this agent;
 *  `mentionedOther` = member-mention of a known sibling bot id OR a mentioned
 *  role named like a sibling. Name matching is case-insensitive exact
 *  (`"agnes"` matches role `"Agnes"`, not `"Agnes-fan"`). Pure —
 *  unit-tested in verify.ts (incl. the exact reported `<@&…> halo` shape). */
export function trioMentionFlags(
  mentions: { has: (id: string) => boolean; roles?: unknown },
  botId: string,
  myName: string,
  siblingNames: string[]
): { mentioned: boolean; mentionedOther: boolean } {
  const roleNames = roleNamesFrom(mentions.roles);
  const mine = myName.toLowerCase();
  const mentioned =
    (!!botId && mentions.has(botId)) || roleNames.includes(mine);
  const mentionedOther =
    [...trioBotIds].some((id) => id !== botId && mentions.has(id)) ||
    siblingNames.some((s) => {
      const n = s.toLowerCase();
      return n !== mine && roleNames.includes(n);
    });
  return { mentioned, mentionedOther };
}

/** Seed an agent's role identity files (IDENTITY.md + SOUL.md) from
 *  `persona/agents/<label>.*.md`, idempotently: a file already at
 *  AGENT_PERSONA_VERSION is never touched (owner-customised), an older one is
 *  refreshed from the template. Mia keeps her existing persona. */
export function ensureAgentPersona(label: AgentLabel, rawUser: unknown): void {
  if (label === "mia") return;
  try {
    const userKey = ensureUserPersona(rawUser);
    if (!userKey) return;
    // Guard (added 2026-10-05 after a real mistake): agent personas live in
    // per-agent user dirs (`<owner>.agnes`, `<owner>.michelle`). Seeding with a
    // key that has no agent suffix would write Michelle's/Agnes' persona over
    // the OWNER's own IDENTITY.md + SOUL.md — which happened once during a
    // manual re-seed and was only noticed by inspecting the files afterwards.
    // Refuse rather than clobber: the caller must pass the suffixed key.
    if (!userKey.includes(".")) return;
    const dir = join(userDataRoot(), userKey, "persona");
    mkdirSync(dir, { recursive: true });
    for (const file of ["IDENTITY.md", "SOUL.md"] as const) {
      const target = join(dir, file);
      let body = "";
      try {
        body = existsSync(target) ? readFileSync(target, "utf8") : "";
      } catch {
        body = "";
      }
      if (body && !agentPersonaNeedsReseed(body)) continue;
      const template = join(appRoot(), "persona", "agents", `${label}.${file}`);
      if (!existsSync(template)) continue;
      writeFileSync(target, readFileSync(template, "utf8"));
    }
  } catch {
    // Role seeding must never break startup or chat.
  }
}

const seededAgentPersonas = new Set<string>();
function seedAgentPersona(cfg: AgentBotConfig, userKey: string): void {
  if (cfg.label === "mia") return;
  const k = `${cfg.label}:${userKey}`;
  if (seededAgentPersonas.has(k)) return;
  seededAgentPersonas.add(k);
  ensureAgentPersona(cfg.label, userKey);
}

/** Live discord.js clients by agent (Mia stays the default for drills). */
const botClients: Partial<Record<AgentLabel, Client | null>> = {};

/** User IDs of all trio bots in this process (filled on each ClientReady).
 *  Used for mention-priority: when a message mentions ≥1 trio bot, only the
 *  mentioned ones reply — even inside a shared dedicated channel. */
const trioBotIds = new Set<string>();
export function getDiscordClient(label: AgentLabel): Client | null {
  return botClients[label] ?? null;
}

/** Owner DM/channel for proactive reminder pushes; recorded from any owner msg
 *  (the object itself has `.send`, so no cache/id resolution needed — and when a
 *  `DISCORD_ALLOWED_CHANNEL_ID` is set, that channel IS what the owner messages
 *  land in). */
export interface BotPushContext {
  lastSeen: SendableChannel | null;
  client: Client | null;
  allowedUsers: string[];
}

/** Drill/inspection hook: Mia's client (null before start).
 *  Used by adapter-path drills that drive the real messageCreate handler with a
 *  synthetic message (invalid token → login 401 → NO gateway → no 409 risk). */
export function getActiveDiscordClient(): Client | null {
  return botClients.mia ?? null;
}

/**
 * Resolve the owner's DM as a sendable target. Falls back to the first
 * allow-listed owner user id; returns null when unavailable.
 */
async function ownerDmTarget(ctx: BotPushContext): Promise<SendableChannel | null> {
  const client = ctx.client;
  const ownerId = ctx.allowedUsers[0];
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
async function resolvePushTarget(ctx: BotPushContext): Promise<SendableChannel | null> {
  return ctx.lastSeen ?? (await ownerDmTarget(ctx));
}

function isAllowedUser(msg: Message, allowedUsers: string[]): boolean {
  return !allowedUsers.length || allowedUsers.includes(msg.author.id);
}
function isAllowedChannel(msg: Message, allowedChannels: string[]): boolean {
  return !allowedChannels.length || allowedChannels.includes(msg.channelId);
}
function isAllowedMessage(msg: Message, cfg: AgentBotConfig): boolean {
  return isAllowedUser(msg, cfg.allowedUsers) && isAllowedChannel(msg, cfg.allowedChannels);
}

/** User key for per-user persona/memory; falls back to the owner id slug. */
function userKeyFor(msg: Message, cfg: AgentBotConfig): string {
  const slug = (msg.author.username || msg.author.id).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 60);
  return `${slug || cfg.userFallback}${cfg.userSuffix}`;
}

export function isValidDiscordConfig(): boolean {
  return enabledAgentConfigs().length > 0;
}

/** Singleton guard: only one client per process (Next invokes register twice). */

export async function startDiscordBot(): Promise<void> {
  const cfgs = enabledAgentConfigs();
  if (!cfgs.length) {
    console.log("[discord] no bot token configured — bot not started");
    return;
  }
  for (const cfg of cfgs) {
    // globalThis guard: a re-evaluated module (HMR) must not start a SECOND client.
    if (alreadyStarted(`discord-bot-${cfg.label}`)) continue;
    cfg.trioMode = cfgs.length > 1;
    await startAgentBot(cfg);
  }
}

/** Start one trio bot. The Mia path below is the legacy single-bot flow,
 *  parameterized per agent (sessions, allow-list, user keys, push labels). */
async function startAgentBot(cfg: AgentBotConfig): Promise<void> {
  const token = cfg.token;
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
  botClients[cfg.label] = client;
  const sessions = new Map<string, ChatState>();

  const getState = (channelKey: string): ChatState => {
    let s = sessions.get(channelKey);
    if (!s) {
      s = { provider: cfg.providerDefault, history: [], pending: null };
      sessions.set(channelKey, s);
    }
    return s;
  };

  const ctx: BotPushContext = { lastSeen: null, client, allowedUsers: cfg.allowedUsers };

  client.on(Events.ClientReady, async () => {
    console.log("[discord] logged in as", client.user?.tag);
    if (client.user) trioBotIds.add(client.user.id);
    // Register slash commands for Mia so "/status" etc. appear under Mia, not just as prefix.
    // Do it once per startup; Discord dedupes by name. Register both global and per-guild for fast propagation.
    try {
      const commands = [
        new SlashCommandBuilder().setName("status").setDescription(`Show ${cfg.displayName} status (provider, uptime, counts)`).toJSON(),
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
      if (alreadyProcessed(`discord-interaction-${cfg.label}`, interaction.id)) return;
      console.log(`[discord] interaction type=${interaction.type} id=${interaction.id} ${interaction.isChatInputCommand() ? `cmd=${interaction.commandName}` : interaction.isAutocomplete() ? "autocomplete" : "other"}`);
      if (interaction.isChatInputCommand()) {
        const cmd = interaction.commandName;
        // Allow-list check (same as messageCreate)
        const userId = interaction.user.id;
        const channelId = interaction.channelId ?? "dm";
        if (cfg.allowedUsers.length && !cfg.allowedUsers.includes(userId)) {
          await interaction.reply({ content: "Maaf, kamu belum di allow-list.", ephemeral: true }).catch(() => {});
          return;
        }
        if (cfg.allowedChannels.length && channelId && !cfg.allowedChannels.includes(channelId)) {
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
        const userKey = userKeyForAgent(
          (interaction.user.username || interaction.user.id).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 60) || (cfg.label === "mia" ? "naufal" : cfg.userFallback),
          cfg.label
        );
        const state = getState(channelId);
        // Track owner channel for pushes (interaction channel)
        if (interaction.channel && "send" in interaction.channel) {
          ctx.lastSeen = interaction.channel as unknown as SendableChannel;
        }
        let replyText: string;
        if (cmd === "status") {
          replyText = buildStatusReport({ provider: state.provider, model: state.model, historyLen: state.history.length, user: userKey }, cfg.statusName);
        } else {
          // Reuse unified command handler by faking a text like "/provider 9router"
          const opt = interaction.options.data.map((o) => String(o.value ?? "")).join(" ").trim();
          const fakeText = `/${cmd}${opt ? ` ${opt}` : ""}`;
          const res = handleUnifiedCommand(state as ChatSessionState, fakeText);
          replyText = res.handled ? (res.replyText || COMMAND_EMPTY_FALLBACK) : `Perintah /${cmd} tidak dikenal.`;
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
      // One inbound message = one turn, even if Discord redelivers it (gateway
      // resume/replay) — live bug: the same message ran two full turns and sent
      // two `remind_me` confirmation prompts.
      if (alreadyProcessed(`discord-${cfg.label}`, msg.id)) {
        console.warn(`[discord] duplicate message ignored (${msg.id})`);
        return;
      }
      console.log(`[discord] msg author=${msg.author.id} channel=${msg.channelId} allowedUser=${isAllowedUser(msg, cfg.allowedUsers)} allowedChannel=${isAllowedChannel(msg, cfg.allowedChannels)}`);
      if (!isAllowedMessage(msg, cfg)) return;
      // Trio routing: an explicit mention (member `<@id>` or role `<@&id>`
      // matching the agent's name) wins — only addressed bots reply. DMs
      // always reply. Unaddressed chatter goes to Mia alone (concierge);
      // a sibling joins unaddressed chatter only inside its OWN dedicated
      // channel. Prevents one message triggering three bots at once.
      {
        const botId = client.user?.id ?? "";
        const mf = trioMentionFlags(
          msg.mentions,
          botId,
          cfg.displayName,
          AGENT_SPECS.filter((s) => s.label !== cfg.label).map((s) => s.displayName)
        );
        const mentioned = mf.mentioned;
        const isDM = msg.guildId == null;
        const inDedicated = cfg.dedicatedChannels.includes(msg.channelId);
        const mentionedOtherTrioBot = mf.mentionedOther;
        if (
          !shouldRespondToAgent(cfg.label, {
            mentioned,
            isDM,
            inDedicatedChannel: inDedicated,
            mentionedOtherTrioBot,
            trioMode: cfg.trioMode,
          })
        )
          return;
      }
      const user = userKeyFor(msg, cfg);
      seedAgentPersona(cfg, user);
      // Deal with file attachments first (docs/images), then the text.
      let text = stripMentions(msg.content || "");
      const atts = msg.attachments ? [...msg.attachments.values()] : [];
      const fileContexts: string[] = [];

      // Voice note (Discord native voice messages arrive as an OGG/Opus attachment)
      // → transcribe to text via the shared STT pipeline, then continue as a
      // normal message turn.
      let isVoice = false;
      const voiceAtt = atts.find((a) => (a.contentType || "").toLowerCase().includes("ogg"));
      if (voiceAtt) {
        isVoice = true;
        try {
          const res = await fetch(voiceAtt.url);
          if (res.ok) {
            const buf = Buffer.from(await res.arrayBuffer());
            text = await transcribeAudio({
              bytes: buf,
              contentType: voiceAtt.contentType ?? "audio/ogg",
            });
          }
        } catch (e) {
          console.warn("[discord] voice fetch failed:", e instanceof Error ? e.message : String(e));
        }
        text = text.trim();
        if (!text) {
          await msg.reply("Aku kurang menangkap suaranya. Coba kirim lagi ya. 🎤").catch(() => {});
          return;
        }
        console.log(`[discord] voice transcribed (${text.length} chars)`);
        (msg.channel as { sendTyping: () => Promise<unknown> }).sendTyping().catch(() => {});
      }

      const visionParts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [];
      if (!isVoice) {
        for (const att of atts) {
          try {
            const res = await fetch(att.url);
            if (!res.ok) { console.warn(`[discord] attachment fetch ${res.status}: ${att.name}`); continue; }
            const buf = Buffer.from(await res.arrayBuffer());
            // Discord mobile (camera) may omit contentType — images always have
            // width/height set, so use that as a fallback signal.
            const mime = att.contentType || (att.width && att.height ? "image/png" : "application/octet-stream");
            const meta = saveUpload(user, att.name || "file.bin", mime, buf);
            const kb = (meta.size / 1024).toFixed(1);
            if (meta.isImage && buf.length < 10_000_000) {
              const b64 = buf.toString("base64");
              visionParts.push({ type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } });
              fileContexts.push(`[Image "${meta.name}" (${kb} KB) — sent as vision]`);
              console.log(`[discord] vision image: ${meta.name} ${mime} ${kb}KB`);
            } else if (meta.isText && meta.textContent !== undefined) {
              fileContexts.push(`[The user uploaded file "${meta.name}" (${kb} KB). It is already saved by the system; do not save it again. Its text content:\n${meta.textContent.slice(0, 6000)}\n]`);
            } else {
              fileContexts.push(`[The user uploaded file "${meta.name}" (${kb} KB). It is already saved by the system; do not save it again.]`);
              console.log(`[discord] attachment NOT vision: ${meta.name} ${mime} ${kb}KB isImage=${meta.isImage}`);
            }
          } catch (e) {
            console.warn("[discord] attachment fetch failed:", e instanceof Error ? e.message : String(e));
          }
        }
      }

      // A message that is only a file (no text) still counts if we saved it.
      if (!text && !fileContexts.length) return;

      ctx.lastSeen = msg.channel as unknown as SendableChannel;
      const chatId = msg.channelId;
      const state = getState(chatId);

      const hasVision = visionParts.length > 0;
      if (fileContexts.length && !hasVision) {
        const prefix = fileContexts.join("\n");
        text = text ? `${prefix}\n\n${text}` : prefix;
      }

      if (!hasVision && text.startsWith("/")) {
        await handleCommand(msg, state, text, user, cfg.statusName);
        return;
      }

      if (state.pending) {
        await handleConfirmation(msg, state, user, text, cfg.label);
        return;
      }

      if (hasVision) {
        const visionContent = [{ type: "text" as const, text: text || "Tolong jelaskan gambar ini dengan rapi" }, ...visionParts];
        await runTurnWithVision(msg, state, user, visionContent, isVoice, cfg.label === "mia" ? "" : ` (${cfg.label})`, cfg.label);
      } else {
        await runTurn(msg, state, user, undefined, text, isVoice, cfg.label === "mia" ? "" : ` (${cfg.label})`, cfg.label);
      }
    } catch (err) {
      console.error("[discord] handler error:", err instanceof Error ? (err.stack || err.message) : String(err));
      await msg.reply("Maaf, ada kendala internal. Coba lagi ya.").catch(() => {});
    }
  });

  // Proactive reminder push: deliver due reminders to the owner's channel/dm.
  // Ack: true only when a channel is known (last-seen or owner DM resolvable
  // from the bot's owner id) AND a send is initiated — a slot is never marked
  // delivered when nothing could receive it. Two guards: (1) owner-scope —
  // slots owned by another key are ignored, so one human's reminders never
  // leak into (or get consumed for) another's channel; (2) confirmed-delivery
  // — the async DM-resolve path returns false until a send truly succeeds, so
  // an unresolvable target can no longer burn the slot (deliveredIds caps at
  // 500; a restart may redeliver a still-due slot once — accepted).
  const deliveredReminderIds = new Set<string>();
  subscribeReminders((reminder: Reminder, slotOwner: string): boolean => {
    if (canonicalUserKey(slotOwner) !== cfg.reminderScope) return false;
    if (deliveredReminderIds.has(reminder.id)) return true;
    if (ctx.lastSeen) {
      const target = ctx.lastSeen;
      const at = new Date(reminder.at);
      const timeLabel = clockLabel(at);
      void target.send(`🌸 **${cfg.reminderBrand}** — ${reminderMessage(reminder.text, timeLabel)}`).then(
        () => {
          deliveredReminderIds.add(reminder.id);
          if (deliveredReminderIds.size > 500) {
            const first = deliveredReminderIds.values().next();
            if (!first.done) deliveredReminderIds.delete(first.value);
          }
        },
        (e: unknown) => {
          console.warn("[discord] reminder push failed:", e instanceof Error ? e.message : String(e));
        },
      );
      return true;
    }
    if (!ctx.client || !ctx.allowedUsers[0]) return false;
    void (async () => {
      const target = await resolvePushTarget(ctx);
      if (target == null) return;
      const at = new Date(reminder.at);
      const timeLabel = clockLabel(at);
      try {
        await target.send(`🌸 **${cfg.reminderBrand}** — ${reminderMessage(reminder.text, timeLabel)}`);
        deliveredReminderIds.add(reminder.id);
        if (deliveredReminderIds.size > 500) {
          const first = deliveredReminderIds.values().next();
          if (!first.done) deliveredReminderIds.delete(first.value);
        }
      } catch (e: unknown) {
        console.warn("[discord] reminder push failed:", e instanceof Error ? e.message : String(e));
      }
    })();
    return false;
  });

  // Register this bot as the proactive-output sink (scheduled automation results).
  for (const pushLabel of cfg.pushLabels) {
    registerPushTarget(pushLabel, async (content: string) => {
      const target = await resolvePushTarget(ctx);
      if (target == null) throw new Error("no discord owner channel seen");
      return target.send(content);
    });
  }

  console.log(`[discord] connecting gateway…${cfg.label === "mia" ? "" : ` (${cfg.label})`}`);
  // Login is one-shot; do NOT block readiness (reflects telegram's fire-and-forget).
  void client.login(token).catch((err) => {
    console.error("[discord] login failed:", err instanceof Error ? err.message : String(err));
  });
}

async function replyMia(msg: Message, text: string): Promise<Message> {
  const safe = text ?? "";
  // Discord renders GitHub-flavoured Markdown natively and caps messages at
  // 2000 chars; send as-is (chunked) replying to the triggering message, falling
  // back to a plain channel send per chunk on any error. SuppressEmbeds hides
  // the automatic link-preview cards (e.g. Google News "Comprehensive up-to-date"
  // cards rendered from every news.google.com anchor URL) while anchors stay
  // tappable.
  // A transient connection timeout to Discord (seen: ConnectTimeoutError, 10s)
  // must not leave the user with NO reply — retry the send with backoff.
  let last!: Message;
  for (const chunk of chunkText(safe, DISCORD_MAX)) {
    last = await sendWithRetry(msg, chunk);
  }
  return last;
}

async function sendWithRetry(msg: Message, chunk: string, attempts = 3): Promise<Message> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await msg.reply({ content: chunk, flags: [MessageFlags.SuppressEmbeds] });
    } catch (replyErr) {
      lastErr = replyErr;
      try {
        return (await (msg.channel as unknown as SendableChannel).send(`> ${chunk}`)) as Message;
      } catch (chanErr) {
        lastErr = chanErr;
      }
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
  }
  throw lastErr;
}

// Optionally reply with a spoken WAV (Groq Orpheus) — used ONLY for voice-note
// turns. For text turns we send text alone (no audio). On a voice turn the
// reply is audio-only (no duplicate text, matches the user's preference).
// Falls back to text on ANY failure (quota 429 / 5xx / network).
// Enable via DISCORD_VOICE_REPLY=0 / BOT_VOICE_REPLY=0.
const voiceEnabled =
  process.env.DISCORD_VOICE_REPLY !== "0" && process.env.BOT_VOICE_REPLY !== "0";
async function replyMiaVoice(msg: Message, text: string, voiceTurn = false): Promise<void> {
  if (voiceTurn && voiceEnabled && text) {
    try {
      const wav = await synthesizeSpeech({ text });
      await msg.reply({ files: [{ attachment: wav, name: "mia-voice.wav" }] });
      return;
    } catch (err) {
      console.warn("[discord] voice reply skipped (text fallback):", err instanceof Error ? err.message : String(err));
      // fall through to text
    }
  }
  await replyMia(msg, text);
}

async function handleCommand(msg: Message, state: ChatState, text: string, user: string, statusTag: string): Promise<void> {
  if (text.startsWith("/status")) {
    await replyMia(
      msg,
      buildStatusReport(
        { provider: state.provider, model: state.model, historyLen: state.history.length, user },
        `${statusTag} (scheduled automation)`
      )
    );
    return;
  }
  const res = handleUnifiedCommand(state as ChatSessionState, text);
  if (res.handled) {
    await replyMia(msg, res.replyText || COMMAND_EMPTY_FALLBACK);
    return;
  }
}

async function handleConfirmation(
  msg: Message,
  state: ChatState,
  user: string,
  text: string,
  agent: AgentLabel = "mia"
): Promise<void> {
  const pending = state.pending!;
  const selection = parseConfirmReply(text, pending.calls.length);
  if (!selection) {
    await replyMia(msg, pendingConfirmPrompt(pending.calls));
    return;
  }
  state.pending = null;
  const channel = msg.channel as unknown as SendableChannel;
  const decisions = pending.calls.map((call, i) => ({ call, allow: selection[i] }));
  // Use typing indicator only; the old interimWaitText left a permanent
  // "Bentar, lagi kuproses…" bubble that looked like a real reply.
  let result: Awaited<ReturnType<typeof runAssistantTurn>>;
  try {
    result = await withTyping(channel, () =>
      runAssistantTurn({
        messages: pending.messages,
        provider: state.provider,
        model: state.model,
        user,
        channel: "discord",
        agent,
        confirm_calls: decisions,
      })
    );
  } catch (err) {
    console.error("[discord] confirm failed:", err instanceof Error ? err.message : String(err));
    await replyMia(msg, classifyAssistantError(err).userMessage);
    return;
  }
  if (result.needsConfirmation?.length) {
    // The follow-up asked for another risky tool: keep the confirmation chain
    // going (the agent's own context already has the tool results) instead
    // of silently dropping it and replying a bare "Selesai.".
    state.pending = { messages: result.messages ?? pending.messages, calls: result.needsConfirmation };
    await replyMia(msg, pendingConfirmPrompt(result.needsConfirmation));
    return;
  }
  state.history.push({ role: "assistant", content: result.text });
  let fallback = EMPTY_REPLY_FALLBACK;
  if (!result.text && pending.calls[0]?.name.startsWith("plan_")) {
    fallback = pending.calls[0].name === "plan_create"
      ? `Plan sudah kubuat beb — cek plan_list untuk lihat step-stepnya 🌸`
      : `Siap beb, step sudah kuupdate — lanjut ke step berikutnya yuk 🌸`;
  }
  await replyMiaVoice(msg, result.text || fallback);
}

async function runTurn(
  msg: Message,
  state: ChatState,
  user: string,
  confirmCall: { call: ToolCall; allow: boolean } | undefined,
  userText: string | undefined,
  voiceTurn = false,
  botTag = "",
  agent: AgentLabel = "mia"
): Promise<void> {
  const turnMessages = [...state.history];
  if (userText) {
    turnMessages.push({ role: "user", content: userText });
    state.history.push({ role: "user", content: userText });
  }
  // No interim text bubble — withTyping shows the typing indicator instead
  // (the old interimWaitText left a permanent extra message before the real reply).
  let result: Awaited<ReturnType<typeof runAssistantTurn>>;
  try {
    console.log(`[discord] turn start${botTag} (provider=${state.provider})`);
    broadcastMiaState("PROCESSING");
    result = await withTyping(msg.channel as unknown as SendableChannel, () =>
      runAssistantTurn({
        messages: turnMessages,
        provider: state.provider,
        model: state.model,
        user,
        channel: "discord",
        agent,
        confirm_call: confirmCall,
      })
    );
    console.log(`[discord] turn done${botTag} (text len=${(result.text || "").length})`);
    broadcastMiaState(result.text ? "SPEAKING" : "IDLE", result.text || undefined);
    setTimeout(() => broadcastMiaState("IDLE"), 8000);
  } catch (err) {
    console.error("[discord] turn failed:", err instanceof Error ? err.message : String(err));
    broadcastMiaState("IDLE");
    await replyMia(msg, classifyAssistantError(err).userMessage);
    return;
  }

  if (result.needsConfirmation?.length) {
    // Persist the agent's own context (which already includes the assistant
    // tool_calls message) so the "ya" continuation is a valid pair, not an
    // orphan tool result. All risky calls queue together for batch approval.
    state.pending = { messages: result.messages ?? turnMessages, calls: result.needsConfirmation };
    await replyMia(msg, pendingConfirmPrompt(result.needsConfirmation));
    return;
  }

  state.history.push({ role: "assistant", content: result.text });
  await replyMiaVoice(
    msg,
    result.text || EMPTY_REPLY_FALLBACK,
    voiceTurn
  );
}

async function runTurnWithVision(
  msg: Message,
  state: ChatState,
  user: string,
  visionContent: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>,
  voiceTurn = false,
  botTag = "",
  agent: AgentLabel = "mia"
): Promise<void> {
  const textPart = visionContent.find((p) => p.type === "text")?.text || "";
  const turnMessages = [...state.history, { role: "user", content: visionContent as unknown as string }];
  state.history.push({ role: "user", content: textPart || "[gambar]" });
  let result: Awaited<ReturnType<typeof runAssistantTurn>>;
  try {
    broadcastMiaState("PROCESSING"); console.log(`[discord] vision turn start${botTag} (provider=${state.provider})`);
    result = await withTyping(msg.channel as unknown as SendableChannel, () =>
      runAssistantTurn({ messages: turnMessages as never, provider: state.provider, model: state.model, user, channel: "discord", agent })
    );
    console.log(`[discord] vision turn done${botTag} (text len=${(result.text || "").length})`); broadcastMiaState(result.text ? "SPEAKING" : "IDLE", result.text || undefined); setTimeout(() => broadcastMiaState("IDLE"), 8000);
  } catch (err) {
    broadcastMiaState("IDLE");
    console.error("[discord] vision turn failed:", err instanceof Error ? err.message : String(err));
    await replyMia(msg, classifyAssistantError(err).userMessage);
    return;
  }
  if (result.needsConfirmation?.length) {
    state.pending = { messages: (result.messages ?? turnMessages) as never, calls: result.needsConfirmation };
    await replyMia(msg, pendingConfirmPrompt(result.needsConfirmation));
    return;
  }
  state.history.push({ role: "assistant", content: result.text });
  await replyMiaVoice(msg, result.text || EMPTY_REPLY_FALLBACK, voiceTurn);
}