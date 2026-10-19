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

import { Client, Events, GatewayIntentBits, Message, MessageFlags, Partials, REST, Routes, SlashCommandBuilder, type ButtonInteraction} from "discord.js";
import { runAssistantTurn, ChatMessage } from "../lib/agent";
import { ToolCall } from "../lib/tools";
import { subscribeReminders, Reminder } from "../lib/reminders";
import { reminderMessage } from "../lib/reminderMessage";
import { saveUpload } from "../lib/uploads";
import { transcribeAudio } from "../lib/stt";
import { synthesizeSpeech } from "../lib/tts";
import { registerPushTarget } from "./pushTarget";
import { startDiscordVoice, stopAllDiscordVoice, isVoiceActive, voiceCommandHelp } from "./discordVoice";
import { classifyAssistantError } from "../lib/assistantError";
import { defaultProviderId } from "../lib/providers";
import { buildStatusReport } from "../lib/status";
import { handleUnifiedCommand, ChatSessionState } from "../lib/channelMessage";
import { alreadyProcessed, alreadyStarted } from "../lib/once";
import { evaluateBotBurst, evaluateSlackMessage, slackChainKey } from "../lib/slackTurnGuard";
import { discordRestTokenHeal } from "../lib/discordRestTokenHeal";
import {
  addressedAgentByName,
  isNameFragmentOnly,
  shouldRespondToAgent,
  type AgentLabel,
} from "../lib/agentRouting";
import {
  ackEmoji,
  claimReactionSlot,
  getReactionRecord,
  lightFallbackDue,
  looksLikeTaskAsk,
  noteLightFallback,
  reactionConfig,
  replaceDiscordReaction,
  selectConversationalReaction,
  selectFinalReaction,
  sendDiscordReaction,
  setReactionEmoji,
  setReactionTimer,
  takeReactionTimer,
  turnOutcomeFromMessages,
} from "../lib/messageReactions";
import {
  approvalCustomId,
  approvalMessage,
  approvalStatusEmbed,
  createApprovalRequest,
  decideApproval,
  disabledApprovalRow,
  getApproval,
  isApprovalAuthorized,
  markApproval,
  parseApprovalCustomId,
} from "./discordApproval";
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
  pending: { messages: ChatMessage[]; calls: ToolCall[]; peerAgent?: string | null; approvalId?: string } | null;
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
  /** Raw configured channel for office delivery (NOT first-claim-wins filtered). */
  officeChannels: string[];
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

/** Full per-agent config resolved from env (shared values are fallbacks).
 *
 *  Dedicated channels are made EXCLUSIVE here. Measured 2026-10-06: all three
 *  of `DISCORD_CHANNEL_ID_MIA` / `_AGNES` / `_MICHELLE` pointed at the same id,
 *  and since `shouldRespondToAgent` ends in `return opts.inDedicatedChannel`
 *  for the siblings, every message in that channel was answered by all three
 *  bots. The routing contract has always said a sibling joins unaddressed
 *  chatter only inside its OWN dedicated channel — "own" was the part a shared
 *  id silently broke. First claimant (AGENT_SPECS order: mia, agnes, michelle)
 *  keeps the id; the rest get an empty list, which restores "Mia answers
 *  unaddressed chatter here" instead of a three-way pile-on. */
export function agentConfigsFromEnv(): AgentBotConfig[] {
  const claimedChannels = new Set<string>();
  return AGENT_SPECS.map((s) => {
    const userFallback = process.env[s.userEnv] || process.env.DISCORD_USER || "naufal";
    const ownUsers = parseIdList(process.env[`DISCORD_ALLOWED_USER_ID${s.envSuffix}`]);
    const allowedUsers = ownUsers.length > 0 ? ownUsers : ALLOWED_USER_IDS;
    const ownChannels = parseIdList(process.env[s.channelEnv]);
    const allowedChannels = ownChannels.length > 0 ? ownChannels : ALLOWED_CHANNEL_IDS;
    const wantedDedicated = parseIdList(process.env[s.dedicatedEnv]);
    const dedicatedChannels = wantedDedicated.filter((id) => {
      if (claimedChannels.has(id)) return false;
      claimedChannels.add(id);
      return true;
    });
    return {
      label: s.label,
      displayName: s.displayName,
      // Delivery destination for the office dashboard. Deliberately the RAW
      // configured id, NOT the first-claim-wins `dedicatedChannels`: that
      // filtering exists so only Mia answers unaddressed chatter in a shared
      // channel, and reusing it left Agnes/Michelle with an empty list — so
      // their office results failed with "office channel not configured".
      officeChannels: wantedDedicated.length > 0 ? wantedDedicated : allowedChannels,
      statusName: `${s.displayName} 2026.9`,
      token: process.env[s.tokenEnv] || "",
      providerDefault: process.env[s.providerEnv] || PROVIDER_DEFAULT,
      allowedUsers,
      allowedChannels,
      dedicatedChannels,
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

/* Routing rules moved to lib/agentRouting.ts (2026-10-08, Slack adapter).
 * They were pure functions of their arguments but sat next to env parsing and
 * Discord objects, so a second channel had to either import discord.ts (pulling
 * in discord.js) or copy them and drift. Re-exported here so the public surface of
 * this module — and verify.ts's existing destructuring — keeps working unchanged.
 * verify.ts locks that ROUTING_NAMES display names equal AGENT_SPECS display names. */
export {
  addressedAgentByName,
  isNameFragmentOnly,
  shouldRespondToAgent,
  type AgentLabel,
};

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
 *  unit-tested in verify.ts (incl. the exact reported `<@&…> halo` shape).
 *  `foreignRole` = a role ping nobody can map to an agent (live 2026-10-18:
 *  the owner pinged Michelle's "Engineer" role, no flag matched, and Mia
 *  answered a message explicitly meant for Michelle — Discord's
 *  `mentions.roles` never contains @everyone/@here, so every entry is a real
 *  role addressing someone). */
export function trioMentionFlags(
  mentions: { has: (id: string) => boolean; roles?: unknown },
  botId: string,
  myName: string,
  siblingNames: string[]
): { mentioned: boolean; mentionedOther: boolean; foreignRole: boolean } {
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
  const foreignRole =
    roleNames.length > 0 && !mentioned && !mentionedOther;
  return { mentioned, mentionedOther, foreignRole };
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
/** bot id -> agent label, for the three bots running in THIS process.
 *  Populated at ClientReady alongside `trioBotIds`. Needed because a bot's
 *  REST user id and its gateway identity id can differ, so a single Set of ids
 *  cannot answer "which sibling wrote this?" — the same reason Slack keeps both
 *  `${label}` and `${label}:bot` keys. */
const trioBotLabels = new Map<string, AgentLabel>();
export function getDiscordClient(label: AgentLabel): Client | null {
  return botClients[label] ?? null;
}

/** Which trio member authored this Discord id, if any. Reverse lookup by
 *  value, so callers need not know which id form they hold. */
export function discordAuthorLabel(id: string | undefined | null): AgentLabel | null {
  if (!id) return null;
  return trioBotLabels.get(id) ?? null;
}

/** This process's user id for one trio label (for removing our own reaction). */
function discordSelfId(label: string): string {
  for (const [id, l] of trioBotLabels) if (l === label) return id;
  return "";
}

/**
 * Native message reactions (routed agent only — each client reacts only when
 * IT answers the turn). Fire-and-forget by design: a reaction failure must
 * never touch the turn, so callers never await these.
 */
async function reactStart(msg: Message, agent: string, text: string): Promise<void> {
  const c = reactionConfig();
  if (!c.enabled || !c.discord || !c.agents.includes(agent)) return;
  const task = looksLikeTaskAsk(text);
  const chatId = msg.channelId;
  const allowLight = !task && lightFallbackDue("discord", chatId, agent);
  const decision = selectConversationalReaction(text, agent, { allowLightFallback: allowLight });
  const emoji = task ? ackEmoji(agent) : decision.emoji;
  if (!emoji) return;
  if (!claimReactionSlot("discord", msg.channelId, msg.id, agent, task ? "ack" : "chat")) return;
  if (!task && decision.reason === "light-fallback") noteLightFallback("discord", chatId, agent);
  // Human-like pause: reacting the same millisecond the message arrives reads
  // as robotic (live 2026-10-15). The finisher preempts this timer, so a fast
  // turn never lands a stale ack after its own final reaction.
  setReactionTimer(
    "discord",
    msg.channelId,
    msg.id,
    agent,
    setTimeout(() => {
      void (async () => {
        const ok = await sendDiscordReaction(msg, agent, msg.id, emoji);
        setReactionEmoji("discord", msg.channelId, msg.id, agent, ok ? emoji : "", false);
      })();
    }, c.delayMs)
  );
}

async function reactFinish(msg: Message, agent: string, messages: ChatMessage[]): Promise<void> {
  const c = reactionConfig();
  if (!c.enabled || !c.discord || !c.agents.includes(agent)) return;
  const facts = turnOutcomeFromMessages(messages);
  const current = getReactionRecord("discord", msg.channelId, msg.id, agent)?.emoji ?? "";
  const decision = selectFinalReaction(facts, current);
  if (!decision.emoji || decision.emoji === current) {
    // No final state to report: leave a pending first reaction alone (it
    // still lands on its timer) and lock whatever is already showing.
    if (decision.emoji) setReactionEmoji("discord", msg.channelId, msg.id, agent, decision.emoji, true);
    return;
  }
  // A real final state preempts the pending first reaction: cancel it so a
  // stale ack can never land after its own replacement.
  takeReactionTimer("discord", msg.channelId, msg.id, agent);
  if (!claimReactionSlot("discord", msg.channelId, msg.id, agent, "final")) return;
  const ok = current
    ? await replaceDiscordReaction(msg, discordSelfId(agent), agent, msg.id, current, decision.emoji)
    : await sendDiscordReaction(msg, agent, msg.id, decision.emoji);
  setReactionEmoji("discord", msg.channelId, msg.id, agent, ok ? decision.emoji : current, true);
}

/**
 * DRILL HOOK ONLY — registers a synthetic trio identity, exactly the way
 * ClientReady does for a real bot. Mirrors lib/slackTurnGuard's
 * `__resetSlackTurnGuard` and `getActiveDiscordClient` above: an inspection
 * seam for the adapter drills, never called by production code.
 *
 * It exists because adapter drills deliberately run with an INVALID token, so
 * `client.login()` 401s at REST and ClientReady never fires — without seeding an
 * identity, `discordAuthorLabel()` returns null for every id and the sibling
 * path collapses into a self-echo rejection (from === to), which would make the
 * drill prove a wiring bug that production does not have.
 */
export function __seedDiscordBotIdentity(id: string, label: AgentLabel): void {
  trioBotLabels.set(id, label);
  trioBotIds.add(id);
}

/** True when this message was authored by `label` itself (own echo). */
export function isDiscordSelfAuthored(
  authorId: string | undefined | null,
  botId: string | undefined | null,
  label: AgentLabel
): boolean {
  return discordAuthorLabel(authorId) === label || discordAuthorLabel(botId) === label;
}

/** Owner DM/channel for proactive reminder pushes; recorded from any owner msg
 *  (the object itself has `.send`, so no cache/id resolution needed — and when a
 *  `DISCORD_ALLOWED_CHANNEL_ID` is set, that channel IS what the owner messages
 *  land in). */
export interface BotPushContext {
  lastSeen: SendableChannel | null;
  /**
   * The agent's dedicated channel (the shared office channel). Used ONLY by the
   * `office` push target, so a dashboard result always lands in the office
   * channel instead of wherever the owner happened to talk last.
   */
  dedicatedChannels: string[];
  /** Raw configured channel for office delivery (unfiltered, see agentConfigsFromEnv). */
  officeChannels: string[];
  /**
   * Cache of the resolved office/#general channel. The reminder listener must
   * ACK synchronously (`return true` = "a push was started"), so it needs the
   * sendable object in hand instead of awaiting `channels.fetch` on every tick —
   * awaiting would force the async path, which acks false and marks a DELIVERED
   * daily slot as `missedAt`/`delivered:false` for one tick.
   */
  officeTarget: SendableChannel | null;
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
/** The agent's dedicated channel (office/general), resolved through the client
 *  and CACHED on the context so the reminder listener can ack synchronously. */
async function officeChannelTarget(ctx: BotPushContext): Promise<SendableChannel | null> {
  if (ctx.officeTarget) return ctx.officeTarget;
  const client = ctx.client;
  const id = ctx.officeChannels[0];
  if (!client || !id) return null;
  try {
    const ch = await client.channels.fetch(id);
    if (ch && "send" in ch) {
      ctx.officeTarget = ch as unknown as SendableChannel;
      return ctx.officeTarget;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Send to Discord, splitting an oversized body into ordered parts.
 *
 * Discord rejects any content over 2000 chars with
 * `Invalid Form Body ... content[BASE_TYPE_MAX_LENGTH]`. Every push target that
 * called `target.send(content)` directly therefore died on a long report —
 * AFTER the work was already done, so the failure surfaced as "the send failed"
 * for a result that had been fully researched. The webhook route grew its own
 * `chunkText` call for exactly this reason; doing it here instead covers every
 * push target at the boundary (office results, `send_channel`, reminders,
 * heartbeat), so no caller has to remember.
 *
 * Splits on line boundaries where possible so a chunk never ends mid-sentence.
 * Returns the last sent message (discord.js convention: the caller may need its
 * id), and re-throws whatever the underlying send threw — a partial delivery
 * must still surface as an error rather than a silent success.
 */
async function sendChunked(target: SendableChannel, content: string): Promise<unknown> {
  const parts = chunkText(content, DISCORD_MAX);
  let last: unknown = null;
  for (const part of parts) {
    last = await target.send(part);
  }
  return last;
}

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

/** Best-effort target for proactive pushes, in order: the configured
 *  DISCORD_CHANNEL_ID_* channel (#general), the owner's last-seen channel, then
 *  the owner's DM.
 *
 *  The configured channel comes FIRST on purpose (owner decision 2026-10-17):
 *  `lastSeen` is recorded from any owner message with no channel-type filter, so
 *  a DM used to win over #general and every reminder landed in the DM. The
 *  last-seen/DM steps stay as fallbacks so a push still works without
 *  DISCORD_CHANNEL_ID_* configured. */
export async function resolvePushTarget(ctx: BotPushContext): Promise<SendableChannel | null> {
  return (await officeChannelTarget(ctx)) ?? ctx.lastSeen ?? (await ownerDmTarget(ctx));
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
  // A turn TRIGGERED BY A SIBLING BOT is still the OWNER's turn: its persona,
  // memory and findings belong under the owner's key. Deriving the slug from
  // the author's display name made a delegated turn land in a key named after
  // the sibling — measured live 2026-10-12 as `MichelleEngineer.agnes` (from
  // "Michelle | Engineer"), which silently split the owner's per-agent data
  // and left the delegated agent with a blank persona.
  const slug = msg.author.bot
    ? ""
    : (msg.author.username || msg.author.id).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 60);
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
      // REQUIRED for voice: without GuildVoiceStates Discord never sends the
      // VOICE_STATE_UPDATE / VOICE_SERVER_UPDATE dispatches that
      // `joinVoiceChannel` waits for, so every join aborts after 20s with
      // "The operation was aborted" (measured 2026-10-06). Non-privileged
      // intent — no portal toggle needed.
      GatewayIntentBits.GuildVoiceStates,
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

  const ctx: BotPushContext = { lastSeen: null, dedicatedChannels: cfg.dedicatedChannels, officeChannels: cfg.officeChannels, officeTarget: null, client, allowedUsers: cfg.allowedUsers };

  client.on(Events.ClientReady, async () => {
    console.log("[discord] logged in as", client.user?.tag);
    // Self-heal the REST token on every ready. Without this, ONE transient
    // gateway failure at boot leaves the bot half-alive: gateway up, REST
    // token-less, every send throws "Expected token to be set for this request".
    // See apps/web/src/lib/discordRestTokenHeal.ts for the full 2026-10-07
    // forensics; the short version is that discord.js login() sets the REST
    // token and then destroy() (its own error path) clears it again.
    discordRestTokenHeal(client, token, cfg.label, (m) => console.warn(m));
    // Warm the #general channel cache here, NOT at registration: before the
    // gateway is ready `channels.fetch` fails, and a cold cache forces the FIRST
    // due reminder onto the async path (which acks false -> the delivered daily
    // slot is recorded `missedAt`/`delivered:false` for a tick).
    void officeChannelTarget(ctx).then((t) => {
      if (t) console.log("[discord] office channel ready for proactive pushes");
    });
    if (client.user) {
      trioBotIds.add(client.user.id);
      trioBotLabels.set(client.user.id, cfg.label);
    }
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
  async function disableApprovalOnMessage(
    interaction: ButtonInteraction,
    req: { id: string },
    kind: "approved" | "rejected" | "expired" | "completed" | "failed"
  ): Promise<void> {
    try {
      const full = getApproval(req.id);
      if (!full) return;
      const row = disabledApprovalRow({
        approve: approvalCustomId("ap", req.id),
        reject: approvalCustomId("rj", req.id),
      });
      const target = interaction.message as unknown as { edit(o: unknown): Promise<unknown> };
      if (target && typeof target.edit === "function") {
        await target.edit({ embeds: [approvalStatusEmbed(full, kind).toJSON()], components: [row] });
      }
    } catch (e) {
      console.warn("[discord] approval message edit failed:", e instanceof Error ? e.message : String(e));
    }
  }

  async function sendApprovalFollowUp(interaction: ButtonInteraction, text: string): Promise<void> {
    for (const chunk of chunkText(text || EMPTY_REPLY_FALLBACK, DISCORD_MAX)) {
      try {
        await interaction.followUp({ content: chunk });
      } catch {
        try {
          await (interaction.channel as unknown as SendableChannel).send(`> ${chunk}`);
        } catch { /* best-effort */ }
      }
    }
  }

  /**
   * Native-button decision path. Mirrors handleConfirmation's execution but
   * resolves everything from the server-side request: the click carries only
   * an opaque id, so a forged customId or a second click can never change or
   * re-run the action. Non-owning trio clients stay silent (the owner acks).
   */
  async function handleApprovalButton(
    interaction: ButtonInteraction,
    cfg: AgentBotConfig,
    parsed: { action: "ap" | "rj"; id: string }
  ): Promise<void> {
    const req = getApproval(parsed.id);
    if (!req || req.agentLabel !== cfg.label) return;
    if (!isApprovalAuthorized(cfg.allowedUsers, interaction.user.id)) {
      await interaction.reply({ content: "Tombol ini bukan untukmu — hanya owner yang boleh menyetujui.", ephemeral: true }).catch(() => {});
      return;
    }
    const acked = await interaction.deferUpdate().catch(() => false as const);
    if (acked === false) return;
    const decision = decideApproval(parsed.id, interaction.user.id, parsed.action === "ap");
    console.log(`[discord] button ${parsed.action} req=${parsed.id} by=${interaction.user.id} ok=${decision.ok}${decision.ok ? "" : ` reason=${decision.reason}`}`);
    const state = getState(interaction.channelId ?? "dm");
    if (!decision.ok) {
      if (decision.reason === "missing") {
        await interaction.followUp({ content: "Permintaan tidak ditemukan (mungkin bot restart) — kirim perintahnya lagi ya.", ephemeral: true }).catch(() => {});
        return;
      }
      await disableApprovalOnMessage(interaction, { id: parsed.id }, decision.reason === "expired" ? "expired" : "completed");
      await interaction
        .followUp({
          content:
            decision.reason === "expired"
              ? "⌛ Sudah kedaluwarsa — minta lagi bila masih perlu."
              : `Sudah diproses sebelumnya (${decision.request?.status ?? "decided"}) — tidak dijalankan ulang.`,
          ephemeral: true,
        })
        .catch(() => {});
      return;
    }
    const allow = parsed.action === "ap";
    // Stand the text path down when it points at the same calls (same ref).
    if (state.pending && state.pending.calls === req.calls) state.pending = null;
    if (!allow) {
      await disableApprovalOnMessage(interaction, req, "rejected");
      state.history.push({ role: "assistant", content: `Permintaan ${req.id} ditolak owner — tidak dijalankan.` });
      return;
    }
    markApproval(req.id, "EXECUTING");
    await disableApprovalOnMessage(interaction, req, "approved");
    const decisions = req.calls.map((call) => ({ call, allow: true }));
    let result: Awaited<ReturnType<typeof runAssistantTurn>>;
    try {
      const channel = interaction.channel as unknown as SendableChannel;
      result = await withTyping(channel, () =>
        runAssistantTurn({
          messages: req.messages,
          provider: req.provider,
          model: req.model,
          user: req.userKey,
          channel: "discord",
          agent: (req.agent as AgentLabel) ?? "mia",
          peerAgent: req.peerAgent ?? undefined,
          confirm_calls: decisions,
        })
      );
    } catch (err) {
      markApproval(req.id, "FAILED");
      await disableApprovalOnMessage(interaction, req, "failed");
      console.error("[discord] button-approve failed:", err instanceof Error ? err.message : String(err));
      await sendApprovalFollowUp(interaction, classifyAssistantError(err).userMessage);
      return;
    }
    if (result.needsConfirmation?.length) {
      // Chain: the follow-up wants another risky tool — new request + buttons,
      // same as the text path (which re-prompts instead of dropping it).
      const req2 = createApprovalRequest({
        agentLabel: req.agentLabel,
        agentDisplay: req.agentDisplay,
        userKey: req.userKey,
        provider: req.provider,
        model: req.model,
        agent: req.agent,
        peerAgent: req.peerAgent,
        messages: result.messages ?? req.messages,
        calls: result.needsConfirmation,
      });
      state.pending = { messages: result.messages ?? req.messages, calls: result.needsConfirmation, peerAgent: req.peerAgent, approvalId: req2.id };
      markApproval(req.id, "COMPLETED");
      await disableApprovalOnMessage(interaction, req, "completed");
      const payload = approvalMessage(req2);
      try {
        await interaction.followUp({ content: "Masih ada aksi lanjutan yang butuh persetujuan:", embeds: payload.embeds, components: payload.components });
      } catch {
        /* best-effort */
      }
      return;
    }
    markApproval(req.id, "COMPLETED");
    await disableApprovalOnMessage(interaction, req, "completed");
    // Final reaction lands on the USER's message (fetched — the interaction
    // only carries the approval message). Best-effort; never touches the turn.
    try {
      const ch = interaction.channel as unknown as { messages?: { fetch(id: string): Promise<Message> } };
      const userMsg = req.userMessageId ? await ch.messages?.fetch(req.userMessageId).catch(() => undefined) : undefined;
      if (userMsg) await reactFinish(userMsg, req.agentLabel, result.messages ?? req.messages);
    } catch { /* reactions never touch the turn */ }
    state.history.push({ role: "assistant", content: result.text });
    await sendApprovalFollowUp(interaction, result.text || EMPTY_REPLY_FALLBACK);
  }

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (alreadyProcessed(`discord-interaction-${cfg.label}`, interaction.id)) return;
      // Button approval path (native components, no "ya" text needed). Unknown
      // buttons fall through to the existing branches below.
      if (interaction.isButton()) {
        const parsed = parseApprovalCustomId(interaction.customId);
        if (parsed) {
          await handleApprovalButton(interaction, cfg, parsed);
          return;
        }
      }
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
    // Declared OUTSIDE the try: the `catch` is a sibling scope, so a const
    // assigned inside the try body is invisible there and the failure path
    // could not tell whether it was answering a peer or the owner.
    let peerAgent: string | null = null;
    try {
      // Unwrap a partial message (first-ever DM arrives partly cached).
      if (msg.partial) {
        try {
          await msg.fetch();
        } catch {
          return;
        }
      }
      // Author classification. Discord used to drop EVERY bot-authored
      // message here (`if (!msg.author || msg.author.bot) return;`), which made
      // the trio structurally blind to each other: a sibling delegating work in
      // plain text was invisible to everyone, and because the drop sat before
      // the log below it was also completely silent. Measured 2026-10-11 —
      // Michelle's "Agnes, tolong dicarikan berita..." produced zero events in
      // the log and Agnes never answered. Slack already handled this
      // (`isBotAuthor` + `evaluateSlackMessage` + `peerAgent`); Discord was the
      // drifted copy. Now: own echo is still dropped, a KNOWN sibling passes,
      // and an unknown/foreign bot still passes to the router so it can decide
      // (it will not be named as a peer, so it cannot start a delegation).
      const authorId = msg.author?.id ?? "";
      const isBotAuthor = !!msg.author?.bot || discordAuthorLabel(authorId) !== null;
      if (!msg.author) return;
      if (isDiscordSelfAuthored(authorId, msg.author.bot ? authorId : undefined, cfg.label)) {
        console.log(`[discord] drop own echo (${authorId})`);
        return;
      }
      // One inbound message = one turn, even if Discord redelivers it (gateway
      // resume/replay) — live bug: the same message ran two full turns and sent
      // two `remind_me` confirmation prompts.
      if (alreadyProcessed(`discord-${cfg.label}`, msg.id)) {
        console.warn(`[discord] duplicate message ignored (${msg.id})`);
        return;
      }
      console.log(`[discord] msg author=${msg.author.id} channel=${msg.channelId} allowedUser=${isAllowedUser(msg, cfg.allowedUsers)} allowedChannel=${isAllowedChannel(msg, cfg.allowedChannels)}`);
      // --- Voice channel command (`!voice on|off`) --------------------------
      // Handled by the HOST bot only (env `DISCORD_VOICE_HOST`, default mia):
      // all three bots share this text channel, so without that gate one
      // command would open three sessions and the trio would talk to itself.
      // Runs BEFORE trio routing so the command is never answered as a normal
      // chat turn. Owner 2026-10-06: "bisa ga sih fitur voice channel di
      // aktifkan?".
      //
      // User-gated ONLY (not channel-gated): the owner naturally types this
      // inside the voice channel's own chat, which is typically NOT on the
      // text-channel allow-list — measured 2026-10-06, six `!voice` messages
      // died at `isAllowedMessage` with allowedUser=true/allowedChannel=false
      // and the bot stayed silent. Non-allow-listed users still can't trigger
      // it; ordinary chat turns below stay fully channel-gated.
      // A sibling bot is never in `allowedUsers`, so this gate used to
      // hard-return before trio routing could ever see a delegated message —
      // the second half of the same blindness the author-drop caused. Bots
      // must not trigger voice sessions at all, so skip the block instead of
      // returning; humans keep the exact gate they had.
      if (!isBotAuthor) {
        if (!isAllowedUser(msg, cfg.allowedUsers)) return;
      }
      {
        const host = (process.env.DISCORD_VOICE_HOST || "mia") as AgentLabel;
        const voiceCmd = /^\s*!voice(?:\s+(on|off|stop|start|help))?([\s\S]*)$/i.exec(
          stripMentions(msg.content || "")
        );
        if (cfg.label === host && voiceCmd && !isBotAuthor) {
          const verb = (voiceCmd[1] || "on").toLowerCase();
          if (verb === "help") {
            await msg.reply(voiceCommandHelp()).catch(() => {});
            return;
          }
          if (verb === "off" || verb === "stop") {
            // Sessions are keyed by the SPOKEN-TO agent (michelle), not by the
            // host that received the command (mia) — so `!voice off` must stop
            // everything, or it reports "nothing active" while Michelle is
            // still in the channel (measured 2026-10-06).
            const had = isVoiceActive();
            await stopAllDiscordVoice().catch(() => {});
            await msg
              .reply(
                had
                  ? "Oke, keluar dari voice channel dulu ya."
                  : "Belum ada voice session aktif."
              )
              .catch(() => {});
            return;
          }
          const voiceChannelId = process.env.DISCORD_VOICE_CHANNEL_ID || "";
          if (!voiceChannelId) {
            await msg
              .reply(
                "Voice channel belum dikonfigurasi — set `DISCORD_VOICE_CHANNEL_ID` ke id voice channel-nya, lalu restart."
              )
              .catch(() => {});
            return;
          }
          // "!voice on michelle" is joined by MICHELLE's own bot account (its
          // own gateway client), not the host's — the owner sees who they
          // called in the channel. Falls back to the host client in solo
          // mode (only one bot configured). One voice presence at a time:
          // a new `on` stops any other agent's session first, so two voices
          // never talk over each other.
          const who = addressedAgentByName(voiceCmd[2] || "") ?? cfg.label;
          const key = userKeyForAgent(
            (msg.author.username || msg.author.id).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 60) ||
              cfg.userFallback,
            who
          );
          ensureAgentPersona(who, key);
          const base = (
            process.env.APP_BASE_URL ||
            process.env.NEXT_PUBLIC_APP_URL ||
            "http://127.0.0.1:3000"
          ).replace(/\/+$/, "");
          try {
            await stopAllDiscordVoice().catch(() => {});
            const reply = await startDiscordVoice({
              client: getDiscordClient(who) ?? client,
              guildId: msg.guildId ?? "",
              voiceChannelId,
              ownerId: msg.author.id,
              agent: who,
              userKey: key,
              textChannelId: msg.channelId,
              tokenUrl: `${base}/api/gemini-live/token`,
              toolUrl: `${base}/api/gemini-live/tool`,
            });
            await msg.reply(reply).catch(() => {});
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            console.warn("[discord] voice start failed:", message);
            await msg.reply(`Voice belum bisa nyala: ${message}`).catch(() => {});
          }
          return;
        }
      }
      if (!isAllowedChannel(msg, cfg.allowedChannels)) return;
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
        // Typed name counts as an address (owner 2026-10-06: "halo michelle"
        // must not wake all three). Mentions are stripped first so mention
        // markup can never be read as a name.
        //
        // Computed UNCONDITIONALLY, not just in trio mode. The old
        // `cfg.trioMode ? addressedAgentByName(...) : null` assumed solo mode
        // has "nobody to mis-address" — but solo mode is precisely the state
        // where the mis-addressed sibling is OFFLINE, and the same live failure
        // then happens here: owner writes "@Agnes halo", Agnes has no token, Mia
        // answers. Measured on Slack 2026-10-08 (Mia answering twice in a row);
        // Slack already computed it unconditionally, Discord was the drifted
        // copy. Both adapters now hand the router the same input.
        const nameAddressed = addressedAgentByName(stripMentions(msg.content || ""));
        if (
          !shouldRespondToAgent(cfg.label, {
            mentioned,
            isDM,
            inDedicatedChannel: inDedicated,
            mentionedOtherTrioBot,
            mentionedForeignRole: mf.foreignRole,
            trioMode: cfg.trioMode,
            nameAddressed,
            fromPeerBot: isBotAuthor,
          })
        )
          return;
      }
      // --- Bot-to-bot chain budget + peer identity ------------------------
      // Reuses slackTurnGuard rather than a second, divergent guard: the rules
      // (BOT_HOP_LIMIT, CHAIN_TTL_MS, owner never gated) must not be able to
      // drift between the two adapters. Discord has no thread id, so a channel
      // is the conversation - `slackChainKey(channel, null)` handles that.
      //
      // A bot message that is a REPLY is a hop; one that is not starts a new
      // chain, matching Slack's `initiatesChain` so a fresh delegation from the
      // owner is never blocked by a stale budget.
      //
      // The reply reference lives on `msg.reference`, NOT `msg.messageReference`
      // — measured 2026-10-12 by reading node_modules/discord.js (v14.27.0):
      // `Message` maps the REST `message_reference` payload into `reference`
      // (src/structures/Message.js:371-384), and the only `messageReference` in
      // the typings is the ReplyOptions INPUT, never a Message property. The old
      // read was therefore always `undefined`, so `chainReply` was always false,
      // so EVERY bot reply looked like a fresh chain and re-armed the hop budget
      // from zero: `BOT_HOP_LIMIT` was unreachable and a dead provider produced
      // ~80 alternating turns in one channel instead of stopping at one handoff.
      const chainReply = !!msg.reference?.messageId;
      const fromLabel: AgentLabel = isBotAuthor
        ? discordAuthorLabel(authorId) ?? cfg.label
        : cfg.label;
      const peerLabel = isBotAuthor && fromLabel !== cfg.label ? fromLabel : null;
      peerAgent = peerLabel
        ? (AGENT_SPECS.find((s) => s.label === peerLabel)?.displayName ?? null)
        : null;
      const gate = evaluateSlackMessage(slackChainKey(msg.channelId, null), {
        fromBot: isBotAuthor,
        from: fromLabel,
        to: cfg.label,
        initiatesChain: isBotAuthor && !chainReply,
      });
      if (!gate.allow) {
        console.log(
          `[discord] drop ${authorId} message (${gate.reason}) - hops=${gate.hops}`
        );
        return;
      }
      // Burst brake: a per-channel ceiling that ONLY an owner message resets.
      // The hop budget above is the primary rule, but it is keyed on whether a
      // message is a reply — so a bot post that arrives unthreaded can escape
      // it. This one cannot be escaped by any bot message. It exists because a
      // dead provider turned the failure cascade into ~80 alternating turns on
      // 2026-10-12; the cascade must stay bounded even if routing regresses.
      const brake = evaluateBotBurst(slackChainKey(msg.channelId, null), {
        fromBot: isBotAuthor,
      });
      if (!brake.allow) {
        console.log(
          `[discord] drop ${authorId} message (${brake.reason}) - bot messages in this channel: ${brake.count}`
        );
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

      // Not garbage — a SUMMON with autocomplete debris stuck on the end.
      // Typing "@Agnes" leaves `<@3995>ness`, and `stripMentions` reduces
      // that to `"ness"`: a nonsense word, but the user is calling a bot.
      //
      // An earlier version DROPPED these messages, on the theory that nobody
      // had really asked anything. That was wrong and the owner reported the
      // consequence immediately: "kenapa sekarang mereka tidak merespon ketika
      // saya panggil itu, mis. ness" — the fragment IS how they summon the
      // trio, so dropping it silently un-summoned the bot.
      //
      // So keep the turn and hand the model an honest description of what
      // actually arrived, rather than a bare word fragment it will try to
      // interpret as a request. `shouldRespondToAgent` has already decided
      // who answers, so this cannot wake the whole trio.
      if (isNameFragmentOnly(text) && !fileContexts.length) {
        // Not a status line about ourselves — that wording was itself a
        // template, and the model answered a status line with a status line
        // back ("Juga ... Lagi nyari info apa nih"). The owner DID call, so
        // rewrite the debris into the greeting it actually was. Routing has
        // already chosen who answers, so nothing about the summons is lost.
        text = "halo";
      }

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
        await handleConfirmation(msg, state, user, text, cfg.label, cfg);
        return;
      }

      if (hasVision) {
        const visionContent = [{ type: "text" as const, text: text || "Tolong jelaskan gambar ini dengan rapi" }, ...visionParts];
        await runTurnWithVision(msg, state, user, visionContent, isVoice, cfg.label === "mia" ? "" : ` (${cfg.label})`, cfg.label, peerAgent, cfg);
      } else {
        await runTurn(msg, state, user, undefined, text, isVoice, cfg.label === "mia" ? "" : ` (${cfg.label})`, cfg.label, peerAgent, cfg);
      }
    } catch (err) {
      console.error("[discord] handler error:", err instanceof Error ? (err.stack || err.message) : String(err));
      await reportTurnFailure(msg, err, peerAgent);
    }
  });

  // Proactive reminder push: deliver due reminders through `resolvePushTarget` —
  // the configured DISCORD_CHANNEL_ID_* channel (#general) FIRST, then the owner's
  // last-seen channel, then the owner's DM. It used to short-circuit on
  // `ctx.lastSeen` here, so a reminder went to the DM whenever the owner had last
  // talked there (owner decision 2026-10-17: pushes belong in #general).
  // Ack: true only when a target is resolvable AND a send is initiated — a slot
  // is never marked delivered when nothing could receive it. Owner-scope guard:
  // slots owned by another key are ignored, so one human's reminders never leak
  // into (or get consumed for) another's channel (deliveredIds caps at 500; a
  // restart may redeliver a still-due slot once — accepted).
  const deliveredReminderIds = new Set<string>();
  const pushReminder = (target: SendableChannel, reminder: Reminder): void => {
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
  };
  subscribeReminders((reminder: Reminder, slotOwner: string): boolean => {
    if (canonicalUserKey(slotOwner) !== cfg.reminderScope) return false;
    if (deliveredReminderIds.has(reminder.id)) return true;
    if (!ctx.client || !ctx.allowedUsers[0]) return false;
    // A real sendable channel is already in hand (cached #general, or last-seen):
    // start the push and ACK now, which is what keeps a delivered daily slot from
    // being recorded as `missedAt`/`delivered:false` for one tick.
    const ready = ctx.officeTarget ?? ctx.lastSeen;
    if (ready) {
      pushReminder(ready, reminder);
      return true;
    }
    void (async () => {
      const target = await resolvePushTarget(ctx);
      if (target == null) return;
      pushReminder(target, reminder);
    })();
    return false;
  });

  // Register this bot as the proactive-output sink (scheduled automation results).
  for (const pushLabel of cfg.pushLabels) {
    registerPushTarget(pushLabel, async (content: string) => {
      const target = await resolvePushTarget(ctx);
      if (target == null) throw new Error("no discord owner channel seen");
      return sendChunked(target, content);
    });
  }

  // Office dashboard results go to the DEDICATED channel, never last-seen/DM.
  // Registering a separate label (instead of changing `resolvePushTarget`)
  // keeps reminder/heartbeat routing exactly as it was.
  //
  // ONE LABEL PER AGENT (`office`, `office-agnes`, `office-michelle`): a single
  // shared label would be overwritten by whichever sibling registered last, so a
  // task the dashboard assigned to Agnes was posted by whichever bot booted
  // last (observed live 2026-10-12: Agnes's result arrived as "Mia | PM").
  registerPushTarget(`office${cfg.label === "mia" ? "" : `-${cfg.label}`}`, async (content: string) => {
    const target = await officeChannelTarget(ctx);
    if (target == null) throw new Error("office channel not configured (DISCORD_CHANNEL_ID_*)");
    return sendChunked(target, content);
  });

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

/**
 * Button approval prompt: ONE message carrying the embed + action row, plus a
 * short text-compat line so "ya/tidak" keeps working from the same prompt.
 * Registers the server-side request and links it to `state.pending` (by
 * request id) so whichever path decides first wins and the other stands down.
 */
async function sendApprovalPrompt(
  msg: Message,
  cfg: AgentBotConfig,
  state: ChatState,
  user: string,
  calls: ToolCall[],
  messages: ChatMessage[],
  agent: AgentLabel,
  peerAgent?: string | null
): Promise<void> {
  const req = createApprovalRequest({
    agentLabel: cfg.label,
    agentDisplay: cfg.displayName,
    userKey: user,
    provider: state.provider,
    model: state.model,
    agent,
    peerAgent: peerAgent ?? null,
    messages,
    calls,
    channelId: msg.channelId,
    userMessageId: msg.id,
  });
  state.pending = { messages, calls, peerAgent: peerAgent ?? null, approvalId: req.id };
  const { embeds, components } = approvalMessage(req);
  const content =
    calls.length > 1
      ? "Balas `ya` untuk semua, `ya 1,3` untuk sebagian, atau `tidak` — atau klik tombol di bawah."
      : "Balas `ya` untuk lanjut, `tidak` untuk batal — atau klik tombol di bawah.";
  const payload = { content, embeds, components };
  let sent: Message;
  try {
    sent = await msg.reply(payload);
  } catch {
    sent = (await (msg.channel as unknown as { send(o: unknown): Promise<Message> }).send(payload)) as Message;
  }
  req.messageId = sent.id;
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

/**
 * Report a failed turn to whoever is actually waiting for the answer.
 *
 * A sibling bot is NOT a valid audience. Measured 2026-10-12: with the provider
 * down, Michelle's failure reply became a bot message that woke Agnes, whose
 * failure reply woke Michelle, and the channel produced ~80 alternating turns.
 * A sibling has nothing to do with a failing provider, and telling it produces
 * the cascade instead of information — so a peer-triggered failure stays in the
 * log and the owner is not troubled with a message they did not ask for either.
 */
async function reportTurnFailure(
  msg: Message,
  err: unknown,
  peerAgent?: string | null
): Promise<void> {
  if (peerAgent) {
    console.error(
      `[discord] turn failed for peer ${peerAgent}; not replying (a failure is not a message to hand back)`
    );
    return;
  }
  await replyMia(msg, classifyAssistantError(err).userMessage);
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
  agent: AgentLabel = "mia",
  cfg?: AgentBotConfig
): Promise<void> {
  const pending = state.pending!;
  const selection = parseConfirmReply(text, pending.calls.length);
  if (!selection) {
    await replyMia(msg, pendingConfirmPrompt(pending.calls));
    return;
  }
  // Button interplay: a decided request must never execute twice. If the
  // buttons already settled this request (approved/rejected/expired), the
  // text reply stands down instead of running the calls again.
  if (pending.approvalId) {
    const req = getApproval(pending.approvalId);
    if (req && req.status !== "PENDING") {
      state.pending = null;
      await replyMia(msg, `Permintaan ini sudah diputuskan (${req.status}) — tidak dijalankan ulang.`);
      return;
    }
  }
  state.pending = null;
  const channel = msg.channel as unknown as SendableChannel;
  const decisions = pending.calls.map((call, i) => ({ call, allow: selection[i] }));
  // Consume the button request (if any) so a late click cannot re-run calls
  // the text path just executed — partial selections consume it as COMPLETED.
  if (pending.approvalId) {
    const allAllow = selection.every(Boolean);
    const allDeny = selection.every((s) => !s);
    if (allAllow) decideApproval(pending.approvalId, msg.author.id, true);
    else if (allDeny) decideApproval(pending.approvalId, msg.author.id, false);
    else markApproval(pending.approvalId, "COMPLETED");
  }
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
        // Carried from the proposing turn: a risky tool requested BY a sibling
        // must still be answered to that sibling, not to the owner (Slack parity
        // — slack.ts stores `peerAgent` on `state.pending` for the same reason).
        peerAgent: pending.peerAgent ?? undefined,
        confirm_calls: decisions,
      })
    );
  } catch (err) {
    console.error("[discord] confirm failed:", err instanceof Error ? err.message : String(err));
    if (pending.approvalId) markApproval(pending.approvalId, "FAILED");
    await reportTurnFailure(msg, err, pending.peerAgent);
    return;
  }
  if (result.needsConfirmation?.length) {
    // The follow-up asked for another risky tool: keep the confirmation chain
    // going (the agent's own context already has the tool results) instead
    // of silently dropping it and replying a bare "Selesai.".
    state.pending = { messages: result.messages ?? pending.messages, calls: result.needsConfirmation, peerAgent: pending.peerAgent ?? null };
    if (cfg) {
      await sendApprovalPrompt(msg, cfg, state, user, result.needsConfirmation, result.messages ?? pending.messages, agent, pending.peerAgent ?? null);
    } else {
      await replyMia(msg, pendingConfirmPrompt(result.needsConfirmation));
    }
    return;
  }
  if (pending.approvalId) markApproval(pending.approvalId, "COMPLETED");
  state.history.push({ role: "assistant", content: result.text });
  void reactFinish(msg, agent, result.messages ?? pending.messages);
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
  agent: AgentLabel = "mia",
  peerAgent?: string | null,
  cfg?: AgentBotConfig
): Promise<void> {
  const turnMessages = [...state.history];
  if (userText) {
    turnMessages.push({ role: "user", content: userText });
    state.history.push({ role: "user", content: userText });
    void reactStart(msg, agent, userText);
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
        peerAgent: peerAgent ?? undefined,
        confirm_call: confirmCall,
      })
    );
    console.log(`[discord] turn done${botTag} (text len=${(result.text || "").length})`);
    broadcastMiaState(result.text ? "SPEAKING" : "IDLE", result.text || undefined);
    setTimeout(() => broadcastMiaState("IDLE"), 8000);
  } catch (err) {
    console.error("[discord] turn failed:", err instanceof Error ? err.message : String(err));
    broadcastMiaState("IDLE");
    await reportTurnFailure(msg, err, peerAgent);
    return;
  }

  if (result.needsConfirmation?.length) {
    // Persist the agent's own context (which already includes the assistant
    // tool_calls message) so the "ya" continuation is a valid pair, not an
    // orphan tool result. All risky calls queue together for batch approval.
    state.pending = { messages: result.messages ?? turnMessages, calls: result.needsConfirmation, peerAgent: peerAgent ?? null };
    if (cfg) {
      await sendApprovalPrompt(msg, cfg, state, user, result.needsConfirmation, result.messages ?? turnMessages, agent, peerAgent ?? null);
    } else {
      await replyMia(msg, pendingConfirmPrompt(result.needsConfirmation));
    }
    return;
  }

  state.history.push({ role: "assistant", content: result.text });
  void reactFinish(msg, agent, result.messages ?? turnMessages);
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
  agent: AgentLabel = "mia",
  peerAgent?: string | null,
  cfg?: AgentBotConfig
): Promise<void> {
  const textPart = visionContent.find((p) => p.type === "text")?.text || "";
  const turnMessages = [...state.history, { role: "user", content: visionContent as unknown as string }];
  state.history.push({ role: "user", content: textPart || "[gambar]" });
  if (textPart) void reactStart(msg, agent, textPart);
  let result: Awaited<ReturnType<typeof runAssistantTurn>>;
  try {
    broadcastMiaState("PROCESSING"); console.log(`[discord] vision turn start${botTag} (provider=${state.provider})`);
    result = await withTyping(msg.channel as unknown as SendableChannel, () =>
      runAssistantTurn({ messages: turnMessages as never, provider: state.provider, model: state.model, user, channel: "discord", agent, peerAgent: peerAgent ?? undefined })
    );
    console.log(`[discord] vision turn done${botTag} (text len=${(result.text || "").length})`); broadcastMiaState(result.text ? "SPEAKING" : "IDLE", result.text || undefined); setTimeout(() => broadcastMiaState("IDLE"), 8000);
  } catch (err) {
    broadcastMiaState("IDLE");
    console.error("[discord] vision turn failed:", err instanceof Error ? err.message : String(err));
    await reportTurnFailure(msg, err, peerAgent);
    return;
  }
  if (result.needsConfirmation?.length) {
    state.pending = { messages: (result.messages ?? turnMessages) as never, calls: result.needsConfirmation, peerAgent: peerAgent ?? null };
    if (cfg) {
      await sendApprovalPrompt(msg, cfg, state, user, result.needsConfirmation, (result.messages ?? turnMessages) as never, agent, peerAgent ?? null);
    } else {
      await replyMia(msg, pendingConfirmPrompt(result.needsConfirmation));
    }
    return;
  }
  state.history.push({ role: "assistant", content: result.text });
  void reactFinish(msg, agent, result.messages ?? turnMessages);
  await replyMiaVoice(msg, result.text || EMPTY_REPLY_FALLBACK, voiceTurn);
}