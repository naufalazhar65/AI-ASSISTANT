/**
 * Context-aware native message reactions (Discord + Telegram).
 *
 * Decides WHICH emoji (never how to send it — each adapter owns its API).
 * Zero LLM calls: agent routing metadata + turn outcome + narrow regexes.
 *
 * Two modes (spec §4):
 * - conversational: one emoji matching the message mood (greetings, thanks,
 *   jokes, ideas...). Never on serious/sad/stressful messages, never on
 *   every message — silence is the default.
 * - task lifecycle: ack when work starts, ✅/⚠️ when it really ends. ✅ only
 *   on verified completion, never for merely calling a tool.
 *
 * Routing default is `routed_agent_only`: exactly the agent that answers the
 * turn may react, once per message unless a task transition justifies an
 * update. State lives on `globalThis` (HMR-safe, same reason as pushTarget).
 */

import { detectMoodIntent } from "./moodIntent";
import { isInternalTurn } from "./memoryNoise";
import { SWEEP_REFUSAL_HEAD } from "./sweepGate";

export type ReactionPlatform = "discord" | "telegram";
export type ReactionMode = "routed_agent_only" | "participating_agents" | "all_agents";

/** Per-agent emoji budgets. Conversational picks stay inside these. */
const AGENT_EMOJI: Record<string, readonly string[]> = {
  mia: ["👀", "🫡", "✅", "🎉", "👋", "❤️", "🙏", "💡", "😮", "🤔", "😂", "👌"],
  agnes: ["🔎", "🤔", "💡", "👀", "✅", "👋", "🙏", "👌"],
  michelle: ["👀", "🛠️", "💡", "✅", "👋", "🤔", "🙏", "👌"],
};

export function agentEmojiSet(agent: string): readonly string[] {
  return AGENT_EMOJI[agent] ?? AGENT_EMOJI.mia;
}

/** Moods that forbid every playful reaction (only 👀/✅/task states survive). */
const SERIOUS_MOODS = new Set(["stressed", "anxious", "sad", "tired", "angry"]);

export interface ReactionConfig {
  enabled: boolean;
  discord: boolean;
  telegram: boolean;
  mode: ReactionMode;
  agents: readonly string[];
  maxPerMessage: number;
  /** Human-like pause before the first reaction lands (ms). */
  delayMs: number;
}

export function reactionConfig(): ReactionConfig {
  const on = (v: string | undefined, dflt: boolean): boolean =>
    v === undefined ? dflt : !/^(0|false|off|no)$/i.test(v.trim());
  const agents = (process.env.REACTIONS_AGENTS ?? "mia,agnes,michelle")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const mode = (process.env.REACTIONS_MODE ?? "routed_agent_only") as ReactionMode;
  return {
    enabled: on(process.env.REACTIONS_ENABLED, true),
    discord: on(process.env.REACTIONS_DISCORD, true),
    telegram: on(process.env.REACTIONS_TELEGRAM, true),
    mode: mode === "participating_agents" || mode === "all_agents" ? mode : "routed_agent_only",
    agents,
    maxPerMessage: 1,
    delayMs: Math.max(0, Number(process.env.REACTIONS_DELAY_MS ?? 3000) || 0),
  };
}

export interface ReactDecision {
  /** Emoji to apply, or "" for silence. */
  emoji: string;
  /** Why (audit log + tests). */
  reason: string;
}

const GREETING_RE = /^(halo|hai|hi|hey|hei|pagi|siang|sore|malam|assalamu|permisi|tes|test|ping|p)\b/i;
const THANKS_RE = /\b(makasih|makasi|terima\s*kasih|thanks?|thank\s*you|nuhun|hatur\s*nuhun)\b/i;
const FUNNY_RE = /\b(haha+|wkwk+|hehe+|lucu|ngakak|kocak|😂|🤣)\b/i;
const CONGRATS_RE = /\b(selamat|lulus|diterima|dapat\s+kerja|menang|berhasil| congrats|syukur|alhamdulillah)\b/i;
const IDEA_RE = /\b(ide\b|gimana\s+kalau|bagaimana\s+kalau|usulan|saran)\b/i;
const WOW_RE = /(\bwow\b|\bwah\b|serius\?|masa\s+sih\?|luar\s+biasa[!?]|keren[!?]+)/i;
const THOUGHTFUL_Q_RE = /(gimana|bagaimana|kenapa|mengapa|menurut|sebaiknya|pilih|mana yang|apakah.*baik)/i;
const AFFECTION_RE = /\b(sayang|love\s*(you|u)|peluk|muach)\b/i;

/** Short conversational asks that deserve no reaction at all. */
function isBareCommand(text: string): boolean {
  return text.trim().startsWith("/");
}

/** A bare summons ("@Agnes" alone arrives as "agnes", "miche;;e", "ness"):
 *  the owner is calling the agent, which is greeting-like contact. Measured
 *  live 2026-10-15: summon debris never matches GREETING_RE, so Agnes and
 *  Michelle stayed silent on the exact messages meant to summon them. */
const AGENT_NAMES = ["mia", "agnes", "michelle"];
function isBareSummon(norm: string): boolean {
  if (!norm || norm.length < 3 || norm.length > 12) return false;
  return AGENT_NAMES.some((n) => {
    if (n.startsWith(norm) || n.includes(norm) || norm.includes(n)) return true;
    let common = 0;
    while (common < norm.length && common < n.length && norm[common] === n[common]) common += 1;
    return common >= 4;
  });
}

/** Discord autocomplete turns "@Agnes" into "<@id>" — the mention is addressing, not content. */
function stripLeadingMentions(text: string): string {
  return String(text || "").replace(/^(\s*<@[!&]?\d+>\s*)+/, "").trim();
}

/** Neutral "I read that" picks for plain chat that carries no signal.
 *  Measured live 2026-10-15: without these, ordinary lines ("duhh", "sip")
 *  drew silence on every agent and the feature read as broken. Kept boring on
 *  purpose — no playful emoji here, and never on a serious message. */
const LIGHT_EMOJI = ["👀", "🫡", "👌"] as const;
const LIGHT_FALLBACK_MAX_CHARS = 60;

function lightFallback(t: string, allowed: Set<string>): ReactDecision {
  if (t.length > LIGHT_FALLBACK_MAX_CHARS) return { emoji: "", reason: "no-signal" };
  const usable = LIGHT_EMOJI.filter((e) => allowed.has(e));
  if (!usable.length) return { emoji: "", reason: "no-signal" };
  const emoji = usable[t.length % usable.length] as string;
  return { emoji, reason: "light-fallback" };
}

/** Fallback reactions are cooldown-gated per agent+chat (default 20s) so rapid
 *  chat does not turn into a wall of emoji. Signals are never gated.
 *  Measured live 2026-10-15: a 2-minute cooldown swallowed every reaction when
 *  the owner tested a few messages in a row — indistinguishable from "broken". */
const LIGHT_COOLDOWN_MS = Math.max(0, Number(process.env.REACTIONS_FALLBACK_COOLDOWN_MS ?? 20000) || 0);

function lightCooldownStore(): Map<string, number> {
  const g = globalThis as unknown as { __miaReactionLight?: Map<string, number> };
  if (!g.__miaReactionLight) g.__miaReactionLight = new Map();
  return g.__miaReactionLight;
}

export function lightFallbackDue(platform: ReactionPlatform, chatId: string, agent: string): boolean {
  if (LIGHT_COOLDOWN_MS <= 0) return true;
  const last = lightCooldownStore().get(`${platform}:${chatId}:${agent}`) ?? 0;
  return Date.now() - last >= LIGHT_COOLDOWN_MS;
}

export function noteLightFallback(platform: ReactionPlatform, chatId: string, agent: string): void {
  lightCooldownStore().set(`${platform}:${chatId}:${agent}`, Date.now());
}

/**
 * Conversational pick. Returns "" for silence — the common case. Order is
 * priority: affection/greeting first, questions last (a "?" alone is not a
 * reaction, only a thoughtful one is). `allowLightFallback` is the adapter's
 * cooldown decision for signal-free chat.
 */
export function selectConversationalReaction(
  text: string,
  agent: string,
  opts?: { allowLightFallback?: boolean }
): ReactDecision {
  const t = stripLeadingMentions(text);
  if (!t || isBareCommand(t) || isInternalTurn(t)) return { emoji: "", reason: "skip" };
  const allowed = new Set(agentEmojiSet(agent));
  const pick = (emoji: string, reason: string): ReactDecision =>
    allowed.has(emoji) ? { emoji, reason } : { emoji: "", reason: "not-in-agent-set" };
  // Serious/sensitive first: playful picks are all suppressed.
  const mood = detectMoodIntent(t);
  if (mood && SERIOUS_MOODS.has(mood.mood)) return { emoji: "", reason: "serious-mood" };
  if (AFFECTION_RE.test(t)) return pick("❤️", "affection");
  if (THANKS_RE.test(t)) return pick("🙏", "thanks");
  if (FUNNY_RE.test(t)) return pick("😂", "funny");
  if (CONGRATS_RE.test(t)) return pick("🎉", "congrats");
  if (IDEA_RE.test(t)) return pick("💡", "idea");
  if (WOW_RE.test(t)) return pick("😮", "wow");
  if (/\?\s*$/.test(t) && THOUGHTFUL_Q_RE.test(t)) return pick("🤔", "thoughtful-question");
  if (GREETING_RE.test(t) && t.length <= 40) return pick("👋", "greeting");
  if (isBareSummon(t.toLowerCase().replace(/[^a-z]/g, ""))) return pick("👋", "summon");
  if (opts?.allowLightFallback) return lightFallback(t, allowed);
  return { emoji: "", reason: "no-signal" };
}

/** Task-shaped asks earn an acknowledgment (agent-specific). */
const TASK_ASK_RE =
  /\b(buatkan|bikin|buat|tolong|minta|coba|cek|lihat|uji|test|testkan|cari|carikan|carilah|ingatkan|ingetin|jadwal|jadwalkan|kirim|kirimkan|teliti|riset|analisis|analisa|audit|periksa|tulis|tuliskan|implement|perbaiki|fix|debug|refactor|deploy|ringkas|rangkum|buatin)\b/i;

export function looksLikeTaskAsk(text: string): boolean {
  const t = stripLeadingMentions(text);
  if (!t || isBareCommand(t) || isInternalTurn(t)) return false;
  return TASK_ASK_RE.test(t);
}

const ACK_EMOJI: Record<string, string> = { mia: "👀", agnes: "🔎", michelle: "👀" };

export function ackEmoji(agent: string): string {
  return ACK_EMOJI[agent] ?? "👀";
}

/** Turn outcome, derived from the turn's own tool results (never prose). */
export interface TurnOutcomeFacts {
  executedTools: readonly string[];
  /** True when a tool result was an error/refusal this turn. */
  toolError: boolean;
}

/** Minimal turn message shape (same structural style as claimAuditHost). */
export interface TurnMessageLike {
  role?: string;
  content?: unknown;
  tool_calls?: Array<{ id?: string; function?: { name?: string } }>;
  tool_call_id?: string;
}

/** Real executions this turn + whether any errored. Refusal placeholders ("Not
 *  selected" / auto-declined / out-of-window) are not executions. */
export function turnOutcomeFromMessages(messages: TurnMessageLike[]): TurnOutcomeFacts {
  const idToName = new Map<string, string>();
  for (const m of messages ?? []) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc?.function?.name) idToName.set(String(tc.id ?? ""), tc.function.name);
      }
    }
  }
  const refusedIds = new Set<string>();
  let toolError = false;
  for (const m of messages ?? []) {
    if (m.role !== "tool" || typeof m.content !== "string") continue;
    const t = m.content.trim();
    const id = String(m.tool_call_id ?? "");
    // SWEEP_REFUSAL_HEAD ("Error: belum ada pengujian nyata di giliran ini") is a
    // refusal too. Without it, `turnOutcomeFromMessages` counted a refused
    // call as executed, so a workflow's evidence listed a tool that never ran
    // (audit 2026-10-16).
    if (/^(?:Not selected|Not executed|Auto-declined|The user declined)/i.test(t) || t.startsWith(SWEEP_REFUSAL_HEAD)) {
      if (id) refusedIds.add(id);
      continue;
    }
    if (/not available on this provider|refused to execute/i.test(t)) {
      if (id) refusedIds.add(id);
    }
    if (/^Error:/.test(t)) toolError = true;
  }
  // A call only counts as executed when its OWN tool result exists. Found by
  // the eval dataset (`exec-toolcall-without-result-is-not-success`): the model
  // can emit tool_calls and then the turn ends (pending approval, provider
  // error, crash). Counting those as executions marked a task ✅ that never ran
  // — the exact "task appears complete" failure the whole honesty stack exists
  // to prevent. Verified ids = every call that produced a non-refusal result.
  const answeredIds = new Set<string>();
  for (const m of messages ?? []) {
    if (m.role === "tool" && typeof m.content === "string" && m.tool_call_id) {
      const id = String(m.tool_call_id);
      if (!refusedIds.has(id)) answeredIds.add(id);
    }
  }
  const executed = [...new Set([...idToName.entries()].filter(([id]) => answeredIds.has(id)).map(([, n]) => n))];
  return { executedTools: executed, toolError };
}

/** Final reaction: ✅ only on real completed work, ⚠️ on failure, else keep. */
export function selectFinalReaction(facts: TurnOutcomeFacts, current: string): ReactDecision {
  if (facts.toolError) return { emoji: "⚠️", reason: "tool-error" };
  if (facts.executedTools.length > 0) return { emoji: "✅", reason: "tools-completed" };
  return { emoji: current, reason: "keep" };
}

/* ---------------------------------------------------------- per-message state */

export interface ReactionRecord {
  platform: ReactionPlatform;
  chatId: string;
  messageId: string;
  agent: string;
  emoji: string;
  purpose: ReactionRecordPurpose;
  finalized: boolean;
  updatedAt: number;
  /** Pending delayed send (human-like pause). Cleared when fired or preempted. */
  timer?: ReturnType<typeof setTimeout> | undefined;
}

type ReactionRecordPurpose = "chat" | "ack" | "final";

const MAX_RECORDS = 500;

function reactionStore(): Map<string, ReactionRecord> {
  const g = globalThis as unknown as { __miaReactions?: Map<string, ReactionRecord> };
  if (!g.__miaReactions) g.__miaReactions = new Map();
  return g.__miaReactions;
}

function reactionKey(platform: ReactionPlatform, chatId: string, messageId: string, agent: string): string {
  return `${platform}:${chatId}:${messageId}:${agent}`;
}

/**
 * Claim the (agent, message) slot. Returns false when this agent already
 * reacted here (duplicate event) or already finalized (late result must not
 * overwrite a newer state). Prunes oldest entries past the cap.
 */
export function claimReactionSlot(
  platform: ReactionPlatform,
  chatId: string,
  messageId: string,
  agent: string,
  purpose: ReactionRecord["purpose"]
): boolean {
  const store = reactionStore();
  const key = reactionKey(platform, chatId, messageId, agent);
  const existing = store.get(key);
  if (existing) {
    if (existing.finalized) return false;
    if (existing.purpose === purpose) return false;
  }
  if (store.size >= MAX_RECORDS) {
    const oldest = [...store.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0]?.[0];
    if (oldest) store.delete(oldest);
  }
  store.set(key, { platform, chatId, messageId, agent, emoji: "", purpose, finalized: false, updatedAt: Date.now() });
  return true;
}

export function setReactionEmoji(
  platform: ReactionPlatform,
  chatId: string,
  messageId: string,
  agent: string,
  emoji: string,
  finalized: boolean
): void {
  const store = reactionStore();
  const key = reactionKey(platform, chatId, messageId, agent);
  const rec = store.get(key);
  if (!rec) return;
  rec.emoji = emoji;
  rec.finalized = finalized;
  rec.updatedAt = Date.now();
}

/**
 * Take (and clear) the pending delayed-send timer. The finisher calls this
 * first: a turn that ends before the human-like pause elapses must send the
 * FINAL reaction straight away, never a stale ack afterwards.
 */
export function takeReactionTimer(
  platform: ReactionPlatform,
  chatId: string,
  messageId: string,
  agent: string
): void {
  const rec = reactionStore().get(reactionKey(platform, chatId, messageId, agent));
  if (!rec?.timer) return;
  clearTimeout(rec.timer);
  rec.timer = undefined;
}

export function setReactionTimer(
  platform: ReactionPlatform,
  chatId: string,
  messageId: string,
  agent: string,
  timer: ReturnType<typeof setTimeout>
): void {
  const rec = reactionStore().get(reactionKey(platform, chatId, messageId, agent));
  if (!rec) {
    clearTimeout(timer);
    return;
  }
  if (rec.timer) clearTimeout(rec.timer);
  rec.timer = timer;
}

export function getReactionRecord(
  platform: ReactionPlatform,
  chatId: string,
  messageId: string,
  agent: string
): ReactionRecord | undefined {
  return reactionStore().get(reactionKey(platform, chatId, messageId, agent));
}

export function clearAgentReactionState(): void {
  reactionStore().clear();
}

/** Test-only: reset the registry between cases. */
export function __resetReactionState(): void {
  reactionStore().clear();
}

/* ------------------------------------------------- platform send (mockable) */

/** Structural minimum of a discord.js Message for reactions (tests mock this). */
export interface DiscordMessageLike {
  react(emoji: string): Promise<unknown>;
}

/** Removal handle: resolve one of OUR reactions to un-react it. */
export interface DiscordReactionResolver {
  reactions?: {
    resolve(emoji: string): { users: { remove(userId: string): Promise<unknown> } } | null | undefined;
  };
}

export interface TelegramCtxLike {
  react(emoji: string | string[]): Promise<unknown>;
}

function reactionLog(platform: string, agent: string, messageId: string, emoji: string, err?: string): void {
  console.warn(
    `[reactions:${platform}] agent=${agent} msg=${messageId} emoji=${emoji}${err ? ` failed: ${err}` : " ok"}`
  );
}

/**
 * Add a reaction. Never throws and never blocks the turn: a failure here
 * must not turn a successful task into a failed one (spec §11).
 */
export async function sendDiscordReaction(
  msg: DiscordMessageLike,
  agent: string,
  messageId: string,
  emoji: string
): Promise<boolean> {
  if (!emoji) return false;
  try {
    await msg.react(emoji);
    return true;
  } catch (e) {
    reactionLog("discord", agent, messageId, emoji, e instanceof Error ? e.message : String(e));
    return false;
  }
}

/**
 * Replace OUR OWN interim reaction with the final one. Only the bot's own
 * reaction is ever removed (spec §2) — user/peer reactions are untouched.
 */
export async function replaceDiscordReaction(
  msg: DiscordMessageLike & DiscordReactionResolver,
  selfId: string,
  agent: string,
  messageId: string,
  oldEmoji: string,
  newEmoji: string
): Promise<boolean> {
  if (oldEmoji) {
    try {
      const reaction = msg.reactions?.resolve(oldEmoji);
      await reaction?.users.remove(selfId);
    } catch (e) {
      reactionLog("discord", agent, messageId, `remove:${oldEmoji}`, e instanceof Error ? e.message : String(e));
    }
  }
  return sendDiscordReaction(msg, agent, messageId, newEmoji);
}

/** Telegram setMessageReaction REPLACES the bot's reaction — one call updates. */
export async function sendTelegramReaction(
  ctx: TelegramCtxLike,
  agent: string,
  messageId: string,
  emoji: string
): Promise<boolean> {
  if (!emoji) return false;
  try {
    await ctx.react(emoji);
    return true;
  } catch (e) {
    reactionLog("telegram", agent, messageId, emoji, e instanceof Error ? e.message : String(e));
    return false;
  }
}
