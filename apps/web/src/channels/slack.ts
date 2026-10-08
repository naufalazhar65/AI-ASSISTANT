import { App, LogLevel } from "@slack/bolt";
import { broadcastMiaState } from "../lib/miaState";
import {
  COMMAND_EMPTY_FALLBACK,
  EMPTY_REPLY_FALLBACK,
  SLACK_MAX,
  chunkText,
  clockLabel,
  parseConfirmReply,
  pendingConfirmPrompt,
} from "./replyChunk";

/**
 * Slack channel adapter (PRD v2.0 §8.1: "adding a channel = adding an
 * adapter, no core change").
 *
 * Mirrors the Discord trio — one Slack app per agent (Mia / Agnes / Michelle),
 * three bot tokens, three app-level tokens — but TEXT ONLY: no voice, no
 * vision, no uploads. Every incoming message runs through the SAME shared core
 * (`runAssistantTurn` in `@/lib/agent`), so persona, memory, tools, and the
 * FR-014 confirmation behave identically to Discord and Telegram.
 *
 * Transport is **Socket Mode** (`@slack/bolt` + an `xapp-…` app-level token):
 * Slack opens the websocket to US, so there is no public URL, no ngrok, and
 * nothing to expose. That is the reason this adapter can live inside the same
 * single Next.js process as the web app and the other bots (started from
 * `instrumentation-node.ts`).
 *
 * ## The one thing Discord CANNOT do: bots talking to bots
 *
 * `discord.ts` starts its `messageCreate` handler with
 * `if (!msg.author || msg.author.bot) return;` — so on Discord the trio is
 * blind to each other and only gets bus/avatar attribution via
 * `detectDelegation`. The owner explicitly asked for the trio to be able to
 * talk to ONE ANOTHER in Slack, so this adapter accepts bot-authored messages
 * and gates them with `lib/slackTurnGuard` instead: a sibling may reply ONCE,
 * self-echo is refused, and a burst is capped per owner turn. The guard is the
 * only thing standing between "trio can converse" and "three bots amplifying
 * each other until Slack rate-limits us", so it is enforced BEFORE any tool
 * runs, not as a prompt instruction.
 *
 * Replies are threaded (`thread_ts`, falling back to the channel root) so a
 * busy channel never turns into one wall of bot text.
 *
 * Security (invariant 5): only allow-listed users are served, and bot/app
 * tokens live server-side only.
 *
 * Env (apps/web/.env.local):
 *   SLACK_BOT_TOKEN, SLACK_APP_TOKEN                required for Mia
 *   SLACK_BOT_TOKEN_AGNES, SLACK_APP_TOKEN_AGNES    optional second trio member
 *   SLACK_BOT_TOKEN_MICHELLE, SLACK_APP_TOKEN_MICHELLE  optional third
 *   SLACK_ALLOWED_USER_ID            owner user ids (comma list; bot user ids
 *                                    are always accepted — see isAllowedAuthor)
 *   SLACK_ALLOWED_CHANNEL_ID         optional channel allow-list (comma list)
 *   SLACK_CHANNEL_ID_MIA/_AGNES/_MICHELLE   dedicated channel per agent
 *   SLACK_PROVIDER                   default AI provider
 *   SLACK_USER                       fallback user key for persona/memory
 */

import { runAssistantTurn, type ChatMessage } from "../lib/agent";
import type { ToolCall } from "../lib/tools";
import { subscribeReminders, type Reminder } from "../lib/reminders";
import { canonicalUserKey, OWNER_KEY } from "../lib/identity";
import { reminderMessage } from "../lib/reminderMessage";
import { registerPushTarget } from "./pushTarget";
import { classifyAssistantError } from "../lib/assistantError";
import { defaultProviderId } from "../lib/providers";
import { buildStatusReport } from "../lib/status";
import { handleUnifiedCommand, type ChatSessionState } from "../lib/channelMessage";
import { alreadyProcessed, alreadyStarted } from "../lib/once";
import {
  ROUTING_NAMES,
  SLACK_MENTION_RE,
  addressedAgentByName,
  addressesThisBot,
  routingDropReason,
  hasForeignMention,
  shouldRespondToAgent,
  type AgentLabel,
} from "../lib/agentRouting";
import { evaluateSlackMessage } from "../lib/slackTurnGuard";

type ChatState = {
  provider: string;
  model?: string;
  /** Persistent text-only conversation (user/assistant) used as LLM context. */
  history: ChatMessage[];
  /** Waiting for a yes/no confirmation of risky tool(s) (FR-014). */
  pending: { messages: ChatMessage[]; calls: ToolCall[]; peerAgent?: string } | null;
};

interface SlackBotConfig {
  label: AgentLabel;
  displayName: string;
  /** Suffix used in env var names ("" for Mia). */
  envSuffix: string;
  /** Suffix appended to the per-agent user key so each agent keeps its own
   *  conversational persona, exactly like the Discord trio. Pentest/finding
   *  state stays owner-scoped by `resolveOwnerScopedKey`. */
  userSuffix: string;
  providerEnv: string;
  userEnv: string;
  channelEnv: string;
  pushLabels: string[];
}

/**
 * Agent specs mirror `AGENT_SPECS` in discord.ts, but stay LOCAL on purpose:
 * those carry Discord-specific env names and bot-token plumbing that Slack
 * does not have. Only the parts that must agree across channels — the label and
 * the display name — come from `lib/agentRouting`, which is the single owner of
 * routing. `verify.ts` asserts the display names still match.
 */
const SLACK_AGENT_SPECS: SlackBotConfig[] = [
  { label: "mia", displayName: "Mia", envSuffix: "", userSuffix: "", providerEnv: "SLACK_PROVIDER", userEnv: "SLACK_USER", channelEnv: "SLACK_CHANNEL_ID_MIA", pushLabels: ["slack", "slack-mia"] },
  { label: "agnes", displayName: "Agnes", envSuffix: "_AGNES", userSuffix: ".agnes", providerEnv: "SLACK_PROVIDER_AGNES", userEnv: "SLACK_USER_AGNES", channelEnv: "SLACK_CHANNEL_ID_AGNES", pushLabels: ["slack-agnes"] },
  { label: "michelle", displayName: "Michelle", envSuffix: "_MICHELLE", userSuffix: ".michelle", providerEnv: "SLACK_PROVIDER_MICHELLE", userEnv: "SLACK_USER_MICHELLE", channelEnv: "SLACK_CHANNEL_ID_MICHELLE", pushLabels: ["slack-michelle"] },
];

function parseIdList(raw: string | undefined): string[] {
  return (raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const ALLOWED_USER_IDS = parseIdList(process.env.SLACK_ALLOWED_USER_ID);
const ALLOWED_CHANNEL_IDS = parseIdList(process.env.SLACK_ALLOWED_CHANNEL_ID);

/** Per-agent config with the resolved env fields attached. */
export type ResolvedSlackBot = SlackBotConfig & {
  token: string;
  appToken: string;
  dedicatedChannel: string | null;
};

export function slackBotConfigsFromEnv(): ResolvedSlackBot[] {
  const out: ResolvedSlackBot[] = [];
  for (const spec of SLACK_AGENT_SPECS) {
    const token = process.env[`SLACK_BOT_TOKEN${spec.envSuffix}`];
    const appToken = process.env[`SLACK_APP_TOKEN${spec.envSuffix}`];
    const dedicated = parseIdList(process.env[spec.channelEnv])[0] || null;
    out.push({ ...spec, token: token || "", appToken: appToken || "", dedicatedChannel: dedicated });
  }
  return out;
}

/** Agents whose bot + app token are both present. */
export function enabledSlackConfigs(
  configs: ResolvedSlackBot[] = slackBotConfigsFromEnv(),
): ResolvedSlackBot[] {
  return configs.filter((c) => !!c.token && !!c.appToken);
}

export function isValidSlackConfig(): boolean {
  const cfgs = enabledSlackConfigs();
  if (!cfgs.length) return false;
  // Solo Mia also needs a user key so persona/memory have somewhere to land.
  if (cfgs.length === 1) return cfgs[0].label === "mia" && !!(ALLOWED_USER_IDS.length || process.env.SLACK_USER);
  return ALLOWED_USER_IDS.length > 0;
}

/**
 * Bot user ids, kept on `globalThis` (NOT module scope) for the same reason
 * `pushTarget.ts` does it: the agent bots register from `instrumentation-node`
 * while the handlers run from route/bundle code, and Next compiles those into
 * separate webpack modules. A module-level map would give each bundle its own
 * copy, so "is this message from a sibling bot?" would silently answer false.
 */
interface SlackBotIds {
  byLabel: Record<string, string>;
  displayNames: Record<string, string>;
}
function botIds(): SlackBotIds {
  const g = globalThis as unknown as { __slackBotIds?: SlackBotIds };
  if (!g.__slackBotIds) g.__slackBotIds = { byLabel: {}, displayNames: {} };
  return g.__slackBotIds;
}

/**
 * Reverse lookup: which trio member authored this Slack id, if any.
 *
 * Accepts EITHER id kind, and this distinction is the whole point. `auth.test`
 * returns both a `user_id` (U…) and a `bot_id` (B…), and the map holds the user
 * id under the label plus the bot id under `${label}:bot` — but a message
 * written by a bot carries `bot_id` and NO `user`, so `event.user || event.bot_id`
 * resolves to the B… form. Live 2026-10-08 16:20: a lookup that only compared
 * `user_id` returned null for every bot-authored message, so `fromLabel` fell
 * back to the receiver's own label, `peerAgent` was never set, and Agnes still
 * answered Mia "Halo Mas Naufal!" — the peer prompt fix was inert because the
 * peer was never identified. Two id kinds, one lookup, so neither caller has to
 * know which one it is holding.
 */
export function slackAuthorLabel(id: string): AgentLabel | null {
  const byLabel = botIds().byLabel;
  for (const { label } of ROUTING_NAMES) {
    if (id && (byLabel[label] === id || byLabel[`${label}:bot`] === id)) return label;
  }
  return null;
}

/** True when this event was authored by `label` itself (either id kind). */
export function isSelfAuthored(botId: string | undefined, label: AgentLabel): boolean {
  if (!botId) return false;
  return slackAuthorLabel(botId) === label;
}

/**
 * Exactly-once namespace for inbound Slack messages, scoped PER AGENT.
 *
 * Slack delivers every channel message to EVERY app installed in that channel,
 * so all three trio bots legitimately receive the same `channel:ts`. A shared
 * namespace made the first bot to arrive claim the id and the other two treat it
 * as a platform redelivery — measured live 2026-10-08: one owner message logged
 * exactly three `duplicate event ignored` lines (one per bot) and NO turn ran.
 * Per-agent namespaces keep the real protection (platform redelivery on socket
 * reconnect) while letting each bot route its own copy. Mirrors discord.ts's
 * `discord-${cfg.label}`; kept pure + exported so the invariant is testable.
 */
export function slackDedupeNamespace(label: AgentLabel): string {
  return `slack-${label}`;
}

/** The owning user's Slack id we last saw, per agent, for proactive pushes. */
function lastSeenTargets(): Record<string, string> {
  const g = globalThis as unknown as { __slackLastSeen?: Record<string, string> };
  if (!g.__slackLastSeen) g.__slackLastSeen = {};
  return g.__slackLastSeen;
}

/**
 * Authorisation. Owner ids come from `SLACK_ALLOWED_USER_ID`; trio SIBLING BOT
 * ids are always allowed, but ONLY for members that are configured — so an
 * unrelated bot in the workspace can never drive the assistant.
 *
 * Fail-open branch, measured 2026-10-08: it used to require "nothing at all is
 * configured" (`ALLOWED_USER_IDS.length === 0 && configured.size === 0`). That
 * condition is unreachable the moment the bot is connected, because
 * `auth.test()` fills `byLabel` BEFORE the first event arrives, so a solo Mia
 * started with only `SLACK_USER` (which `isValidSlackConfig` accepts) silently
 * dropped every owner message with no error logged anywhere. The condition is
 * now about the OWNER allow-list alone; sibling bots stay gated by
 * `configured.has(userId)`, which only ever holds configured labels. In trio
 * mode an allow-list is required by `isValidSlackConfig`, so this branch is
 * single-tenant-only, the same posture the Telegram adapter takes when both of
 * its lists are empty. `isBotAuthor` is a required argument rather than a
 * caller-side `!isBotAuthor &&` short-circuit: Slack delivers bot messages to
 * this same handler (that is the whole point of the trio), so the fail-open
 * branch has to refuse them itself. A default value would have left that
 * invariant one careless call site away from being lost.
 */
export function isAllowedAuthor(authorId: string, isBotAuthor: boolean): boolean {
  if (ALLOWED_USER_IDS.includes(authorId)) return true;
  const configured = new Set(Object.values(botIds().byLabel));
  if (configured.has(authorId)) return true;
  return !isBotAuthor && ALLOWED_USER_IDS.length === 0;
}

function isAllowedChannel(channelId: string): boolean {
  return ALLOWED_CHANNEL_IDS.length === 0 || ALLOWED_CHANNEL_IDS.includes(channelId);
}

/** Per-user key for persona/memory; mirrors `userKeyForAgent` in discord.ts. */
export function userKeyForAgent(base: string, label: AgentLabel): string {
  const cfg = SLACK_AGENT_SPECS.find((c) => c.label === label);
  const suffix = cfg?.userSuffix ?? "";
  const slug = (base || "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 60);
  return `${slug || "naufal"}${suffix}`;
}

/** Strip the `<@U123>` mention tokens so the LLM never sees raw Slack ids. */
function stripSlackMentions(text: string): string {
  return (text || "").replace(/<@[UWB][A-Z0-9]*(\|[^>]*)?>/g, "").replace(/\s{2,}/g, " ").trim();
}

/** Slack "mrkdwn" needs no escaping (it is not a parser that errors), so a
 *  chunked reply can go out verbatim; scrubToolMarkup + scrubHomePath still run
 *  inside `chunkText` exactly like every other channel. */
async function replyMia(
  client: { chat: { postMessage: (args: Record<string, unknown>) => Promise<unknown> } },
  target: { channel: string; thread_ts?: string },
  text: string,
): Promise<void> {
  const safe = text || "";
  for (const chunk of chunkText(safe, SLACK_MAX)) {
    await client.chat.postMessage({ ...target, text: chunk });
  }
}

/**
 * Slack has no native typing indicator, and adding a ⏳ reaction that we then
 * have to remove doubles the API calls on every turn. Instead we keep the
 * background "Mia is working" indicator alive through `broadcastMiaState`, which
 * the orb / Pixel Office already consume.
 */
async function withBusyState<T>(fn: () => Promise<T>): Promise<T> {
  broadcastMiaState("PROCESSING");
  try {
    return await fn();
  } finally {
    setTimeout(() => broadcastMiaState("IDLE"), 8000);
  }
}

async function handleCommand(
  client: { chat: { postMessage: (args: Record<string, unknown>) => Promise<unknown> } },
  target: { channel: string; thread_ts?: string },
  state: ChatState,
  text: string,
  user: string,
  bot: ResolvedSlackBot,
): Promise<void> {
  if (text.startsWith("/status")) {
    await replyMia(
      client,
      target,
      buildStatusReport(
        { provider: state.provider, model: state.model, historyLen: state.history.length, user },
        `${bot.displayName} (slack, socket mode)`
      )
    );
    return;
  }
  const res = handleUnifiedCommand(state as ChatSessionState, text);
  if (res.handled) {
    await replyMia(client, target, res.replyText || COMMAND_EMPTY_FALLBACK);
    return;
  }
}

async function handleConfirmation(
  client: { chat: { postMessage: (args: Record<string, unknown>) => Promise<unknown> } },
  target: { channel: string; thread_ts?: string },
  state: ChatState,
  user: string,
  text: string,
  bot: ResolvedSlackBot,
): Promise<void> {
  const pending = state.pending!;
  const selection = parseConfirmReply(text, pending.calls.length);
  if (!selection) {
    await replyMia(client, target, pendingConfirmPrompt(pending.calls, "*"));
    return;
  }
  state.pending = null;
  const decisions = pending.calls.map((call, i) => ({ call, allow: selection[i] }));
  let result: Awaited<ReturnType<typeof runAssistantTurn>>;
  try {
    result = await withBusyState(() =>
      runAssistantTurn({
        messages: pending.messages,
        provider: state.provider,
        model: state.model,
        user,
        channel: "slack",
        agent: bot.label,
        peerAgent: pending.peerAgent,
        confirm_calls: decisions,
      })
    );
  } catch (err) {
    console.error(`[slack:${bot.label}] confirm failed:`, err instanceof Error ? err.message : String(err));
    await replyMia(client, target, classifyAssistantError(err).userMessage);
    return;
  }
  if (result.needsConfirmation?.length) {
    // Another risky call was proposed: keep the chain going rather than
    // replying a bare "Selesai." (the agent context already holds the results).
    state.pending = { messages: result.messages ?? pending.messages, calls: result.needsConfirmation };
    await replyMia(client, target, pendingConfirmPrompt(result.needsConfirmation, "*"));
    return;
  }
  state.history.push({ role: "assistant", content: result.text });
  let fallback = EMPTY_REPLY_FALLBACK;
  if (!result.text && pending.calls[0]?.name.startsWith("plan_")) {
    fallback = pending.calls[0].name === "plan_create"
      ? `Plan sudah kubuat beb — cek plan_list untuk lihat step-stepnya`
      : `Siap beb, step sudah kuupdate — lanjut ke step berikutnya yuk`;
  }
  await replyMia(client, target, result.text || fallback);
}

async function runTurn(
  client: { chat: { postMessage: (args: Record<string, unknown>) => Promise<unknown> } },
  target: { channel: string; thread_ts?: string },
  state: ChatState,
  user: string,
  confirmCall: { call: ToolCall; allow: boolean } | undefined,
  userText: string | undefined,
  bot: ResolvedSlackBot,
  peerAgent?: string,
): Promise<void> {
  const turnMessages = [...state.history];
  if (userText) {
    turnMessages.push({ role: "user", content: userText });
    state.history.push({ role: "user", content: userText });
  }

  let result: Awaited<ReturnType<typeof runAssistantTurn>>;
  try {
    console.log(`[slack:${bot.label}] turn start (provider=${state.provider})`);
    result = await withBusyState(() =>
      runAssistantTurn({
        messages: turnMessages,
        provider: state.provider,
        model: state.model,
        user,
        channel: "slack",
        agent: bot.label,
        peerAgent,
        confirm_call: confirmCall,
      })
    );
    console.log(`[slack:${bot.label}] turn done (text len=${(result.text || "").length})`);
    broadcastMiaState(result.text ? "SPEAKING" : "IDLE", result.text || undefined);
  } catch (err) {
    console.error(`[slack:${bot.label}] turn failed:`, err instanceof Error ? err.message : String(err));
    broadcastMiaState("IDLE");
    await replyMia(client, target, classifyAssistantError(err).userMessage);
    return;
  }

  if (result.needsConfirmation?.length) {
    state.pending = { messages: result.messages ?? turnMessages, calls: result.needsConfirmation, peerAgent };
    await replyMia(client, target, pendingConfirmPrompt(result.needsConfirmation, "*"));
    return;
  }

  state.history.push({ role: "assistant", content: result.text });
  await replyMia(client, target, result.text || EMPTY_REPLY_FALLBACK);
}

/** One message handler shared by app_mention / message.im / message.channels. */
async function handleIncoming(
  bot: ResolvedSlackBot,
  client: { chat: { postMessage: (args: Record<string, unknown>) => Promise<unknown> } },
  event: {
    type: string;
    user?: string;
    bot_id?: string;
    text?: string;
    channel: string;
    ts: string;
    thread_ts?: string;
    subtype?: string;
    channel_type?: string;
  },
  trioMode: boolean,
  dedicated: Map<string, string>,
): Promise<void> {
  // Subtype messages (channel_join, message_changed, …) are not turns.
  if (event.subtype) return;
  if (!event.text || !event.text.trim()) return;
  // A bot's own echo of its own reply must never come back as a turn.
  // Both id kinds: `event.bot_id` is the B… form, so comparing it against the
  // map's user id never matched and a bot's own reply could come back as a turn
  // (the per-agent dedupe namespace cannot catch this — each agent has its own
  // namespace, so Mia would happily process her own post).
  if (isSelfAuthored(event.bot_id, bot.label)) return;

  const authorId = event.user || event.bot_id || "";
  const isBotAuthor = !!event.bot_id || Object.values(botIds().byLabel).includes(authorId);
  // `mentioned` must mean "this message names ME" — NOT "the author happens to
  // be a bot". Slack sets `event.bot_id` on EVERY message any bot wrote, so the
  // old `!!event.bot_id || …` short-circuit reported all three trio members as
  // mentioned for each other's messages. Measured live 2026-10-08 15:32 WIB in
  // #all-mia-ltd: Mia posted an unaddressed line and Agnes replied to it
  // ("Hehe, malah balik nanya ke aku") even though nobody was named; and when
  // Mia addressed `<@U0C7LPQ3754>`, only the hop-limit guard — an unrelated
  // concern, spent on the previous exchange — kept Mia and Michelle silent. One
  // bot winning a race is not routing: had Mia or Michelle won, the wrong
  // sibling would have answered a message meant for Agnes.
  //
  // For a bot author the ONLY warrant is real `<@ID>` markup in the body: bots
  // cannot use the human autocomplete shortcut, and Slack hands us the literal
  // text they sent. `!!event.bot_id` is kept only for human-authored
  // `app_mention` events, where it is a genuine signal that the mention event
  // fired.
  const mentioned = addressesThisBot(
    event.text || "",
    botIds().byLabel[bot.label],
    isBotAuthor,
    event.bot_id,
  );
  const isDM = event.channel_type === "im";
  const inDedicatedChannel = dedicated.get(event.channel) === bot.label;
  const text = stripSlackMentions(event.text);
  const nameAddressed = addressedAgentByName(text);

  // Routing first (cheap, pure): a message meant for a sibling must not make
  // this bot answer. In a shared channel with no mention and no name, only Mia
  // answers — same contract as the Discord trio.
  const mentionedOtherTrioBot =
    trioMode &&
    Object.entries(botIds().byLabel).some(
      ([label, id]) => label !== bot.label && !!id && event.text!.includes(`<@${id}>`)
    );

  // Measured live 2026-10-08 14:02 WIB: the owner TYPED "@Agnes halo" and
  // Slack's autocomplete replaced the name with `<@U0C7LPQ3754>`. The Agnes
  // app has no bot token yet, so that id is not in botIds().byLabel — meaning
  // after `stripSlackMentions` there was no name left to route on at all, and
  // Mia answered a message meant for her offline sibling. A mention of an id
  // we cannot resolve is proof enough that the owner addressed someone else;
  // we do not need to know WHO (that would need the `users:read` scope).
  const knownBotIds = Object.values(botIds().byLabel).filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  const mentionedForeignUser = hasForeignMention(
    event.text || "",
    knownBotIds,
    SLACK_MENTION_RE,
  );

  const routingOpts = {
    mentioned,
    isDM,
    inDedicatedChannel,
    mentionedOtherTrioBot,
    mentionedForeignUser,
    trioMode,
    nameAddressed,
  };
  if (!shouldRespondToAgent(bot.label, routingOpts)) {
    // Suppressions used to be silent except for one branch, which made a live
    // mis-route indistinguishable from a lost message (measured 2026-10-08:
    // "is Mia answering because of routing, or did the hop limit stop her?").
    // The verdict is `shouldRespondToAgent`'s; this only names the reason.
    const reason = routingDropReason(bot.label, routingOpts);
    if (reason) console.log(`[slack:${bot.label}] drop — ${reason}`);
    return;
  }

  if (!isAllowedAuthor(authorId, isBotAuthor)) return;
  if (!isAllowedChannel(event.channel)) return;

  // The loop guard. Owner turns are never gated; only bot-authored messages
  // are, and only AFTER routing/authorisation so a blocked message cannot burn
  // a sibling's single hop.
  const fromLabel = isBotAuthor ? slackAuthorLabel(authorId) ?? bot.label : bot.label;
  // Who this turn is answering. Live 2026-10-08: Mia asked Agnes something in
  // Slack, Agnes opened with "Halo Mas Naufal!" and Mia's follow-up said "malah
  // balik nanya ke Mas Naufal" — the owner was named in a chain he was not part
  // of, because nothing told the turn that a PEER triggered it (agent.ts's
  // prompt mandates the owner's honorific). Only a KNOWN sibling counts: an
  // unrecognised bot author falls back to normal owner-shaped behaviour rather
  // than addressing a stranger with the concierge's peer clause.
  const peerLabel = isBotAuthor && fromLabel !== bot.label ? fromLabel : null;
  const peerAgent = peerLabel
    ? ROUTING_NAMES.find((r) => r.label === peerLabel)?.displayName
    : undefined;
  // A bot post that is NOT inside a thread starts a new conversation; only a
  // threaded reply is a hop that spends the budget. Live 2026-10-08: without
  // this, the initiator consumed the hop and the whole channel stayed locked
  // until the owner spoke again or the TTL expired, so "ask Michelle" after
  // "ask Agnes" died as `(hop-limit)` — indistinguishable from broken routing.
  const chainThread = (event.thread_ts || "").trim();
  const initiatesChain =
    isBotAuthor && (!chainThread || chainThread === (event.ts || "").trim());
  const gate = evaluateSlackMessage(
    `${event.channel}:${chainThread}`,
    { fromBot: isBotAuthor, from: fromLabel, to: bot.label, initiatesChain },
  );
  if (!gate.allow) {
    console.log(`[slack:${bot.label}] drop ${authorId} message (${gate.reason}) — hops=${gate.hops}`);
    return;
  }

  const threadTs = event.thread_ts || undefined;
  const target = threadTs ? { channel: event.channel, thread_ts: threadTs } : { channel: event.channel };
  const sessionsKey = `${event.channel}:${threadTs || "(top)"}`;
  const providerDefault = process.env[bot.providerEnv] || defaultProviderId();
  const baseUser = process.env[bot.userEnv] || ALLOWED_USER_IDS[0] || "naufal";
  const user = userKeyForAgent(baseUser, bot.label);

  let state = sessions.get(sessionsKey);
  if (!state) {
    state = { provider: providerDefault, history: [], pending: null };
    sessions.set(sessionsKey, state);
  }
  lastSeenTargets()[bot.label] = event.channel;

  try {
    if (text.startsWith("/")) {
      await handleCommand(client, target, state, text, user, bot);
      return;
    }
    if (state.pending) {
      await handleConfirmation(client, target, state, user, text, bot);
      return;
    }
    await runTurn(client, target, state, user, undefined, text, bot, peerAgent);
  } catch (err) {
    console.error(`[slack:${bot.label}] handler error:`, err instanceof Error ? err.message : String(err));
    await replyMia(client, target, "Maaf, ada kendala internal di sisi Mia. Coba lagi ya.").catch(() => {});
  }
}

/** Shared across all three bots in this process. */
const sessions = new Map<string, ChatState>();

/** Start one agent's Slack connection (Socket Mode). */
async function startAgentBot(bot: ResolvedSlackBot, trioMode: boolean, dedicated: Map<string, string>): Promise<void> {
  if (alreadyStarted(`slack-bot-${bot.label}`)) return;

  const app = new App({
    token: bot.token,
    appToken: bot.appToken,
    socketMode: true,
    logLevel: LogLevel.WARN,
  });

  // Resolve our own user id so we can (a) ignore our own echo and (b) let
  // siblings mention us. Recorded on globalThis for the reasons documented on
  // `botIds()`.
  try {
    const auth = (await app.client.auth.test()) as { user_id?: string; bot_id?: string };
    if (auth.user_id) botIds().byLabel[bot.label] = auth.user_id;
    if (auth.bot_id) botIds().byLabel[`${bot.label}:bot`] = auth.bot_id;
    botIds().displayNames[bot.label] = bot.displayName;
    console.log(`[slack:${bot.label}] connected as ${bot.displayName} (${auth.user_id || "?"})`);
  } catch (err) {
    console.warn(`[slack:${bot.label}] auth.test failed (continuing):`, err instanceof Error ? err.message : String(err));
  }

  const client = app.client as unknown as {
    chat: { postMessage: (args: Record<string, unknown>) => Promise<unknown> };
  };

  // Bot-to-bot is the feature Discord lacks, so bot-authored messages are NOT
  // dropped here — they go through the loop guard instead.
  type SlackMessageEvent = Parameters<typeof handleIncoming>[2];
  type ListenerArgs = { event: unknown };

  const onMessage = async ({ event }: ListenerArgs): Promise<void> => {
    const ev = event as SlackMessageEvent;
    const eventId = `${ev.channel}:${ev.ts}`;
    // Per-agent namespace: see slackDedupeKey. A shared one made two of the
    // three bots treat a real message as a platform redelivery and drop it.
    if (alreadyProcessed(slackDedupeNamespace(bot.label), eventId)) {
      console.warn(`[slack:${bot.label}] duplicate event ignored (${eventId})`);
      return;
    }
    await handleIncoming(bot, client, ev, trioMode, dedicated);
  };

  app.event("app_mention", onMessage);
  app.event("message", async (args) => {
    // `message` covers message.im + message.channels; message.groups is not
    // enabled (needs a privileged scope) so nothing to filter out here.
    await onMessage(args as unknown as ListenerArgs);
  });
  app.event("app_error", async (err) => {
    console.error(`[slack:${bot.label}] app_error:`, (err as { message?: string })?.message || String(err));
  });
  app.error(async (err) => {
    console.error(`[slack:${bot.label}] error:`, err instanceof Error ? err.message : String(err));
  });

  // Proactive reminder push. Ack TRUE only when a real target exists AND a send
  // was initiated — otherwise the slot must stay undelivered so Mia can honestly
  // say it was missed (same contract as telegram/discord).
  subscribeReminders((reminder: Reminder, slotOwner: string): boolean => {
    if (canonicalUserKey(slotOwner) !== OWNER_KEY) return false;
    const target = process.env.SLACK_PUSH_CHANNEL_ID || lastSeenTargets()[bot.label];
    if (!target) return false;
    const timeLabel = clockLabel(new Date(reminder.at));
    client.chat
      .postMessage({ channel: target, text: `🌸 ${bot.displayName} — ${reminderMessage(reminder.text, timeLabel)}` })
      .catch((e) => console.warn(`[slack:${bot.label}] reminder push failed:`, e instanceof Error ? e.message : String(e)));
    return true;
  });

  for (const pushLabel of bot.pushLabels) {
    registerPushTarget(pushLabel, async (content: string) => {
      const target = process.env.SLACK_PUSH_CHANNEL_ID || lastSeenTargets()[bot.label];
      if (!target) throw new Error("no slack owner channel seen");
      return client.chat.postMessage({ channel: target, text: content });
    });
  }

  console.log(`[slack:${bot.label}] starting socket-mode connection…`);
  // Do NOT await app.start(): the socket loop never resolves, and
  // instrumentation's register must complete before Next serves requests.
  void app.start().catch((err) => {
    console.error(`[slack:${bot.label}] socket-mode error:`, err instanceof Error ? err.message : String(err));
  });
}

/**
 * Start every configured Slack agent. Dedicated channels are claimed
 * EXCLUSIVELY (first claim wins) for the same reason as in discord.ts: when
 * three agents were given the same channel id, all three answered every
 * message (live 2026-10-06).
 */
export async function startSlackBot(): Promise<void> {
  const configs = enabledSlackConfigs();
  if (!configs.length) {
    console.log("[slack] SLACK_BOT_TOKEN / SLACK_APP_TOKEN not set — bots not started");
    return;
  }
  const dedicated = new Map<string, string>();
  for (const cfg of configs) {
    if (cfg.dedicatedChannel && !dedicated.has(cfg.dedicatedChannel)) {
      dedicated.set(cfg.dedicatedChannel, cfg.label);
    }
  }
  const trioMode = configs.length > 1;
  console.log(`[slack] starting ${configs.length} bot(s): ${configs.map((c) => c.displayName).join(", ")}${trioMode ? " (trio mode)" : ""}`);
  for (const cfg of configs) {
    await startAgentBot(cfg, trioMode, dedicated);
  }
}

/** Routing metadata, re-exported so `verify.ts` can assert Slack and Discord
 *  share one owner of display names instead of two drifting copies. */
export { ROUTING_NAMES, addressedAgentByName, shouldRespondToAgent, type AgentLabel };