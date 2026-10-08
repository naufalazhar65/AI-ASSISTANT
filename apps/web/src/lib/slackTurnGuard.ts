// Loop guard for bot-to-bot conversation in a shared channel (Slack trio).
//
// WHY THIS IS NEW — and why it has no Discord counterpart:
// Discord's `messageCreate` starts with `if (!msg.author || msg.author.bot)
// return;` (channels/discord.ts), so bot-authored messages are dropped before
// routing ever sees them. That is why the Discord trio cannot talk to each
// other at all: `detectDelegation` in lib/delegation.ts only re-ATTRIBUTES bus
// events / Pixel Office avatars, it never routes to another bot.
//
// The owner explicitly asked for the Slack trio to "berinteraksi satu sama
// lain (text only)". So Slack must accept bot-authored messages — which
// removes the guard that made Discord safe by accident. Without an explicit
// bound, three bots that can hear each other will keep talking forever: Mia
// answers Agnes, Agnes reads Mia's answer as a new question and answers,
// Michelle joins, and the thread becomes an infinite, expensive loop that also
// spams the owner's channel.
//
// Three independent limits, because each catches a different failure:
//   1. SELF-ECHO REFUSAL — a bot never processes its own message. Slack sends a
//      `message` event back for our own posts in some configurations; without
//      this a bot answers itself forever.
//   2. HOP LIMIT (default 1) — a sibling bot may be answered at most once.
//      With 3 bots, hop=1 means: Mia answers Michelle, and nobody answers Mia.
//      This is a conversation, not a round-robin.
//      The budget is per CHAIN, and a chain starts at a bot message that is NOT
//      a threaded reply (`initiatesChain`). Measured live 2026-10-08: because the
//      initiator consumed the hop too and nothing reset it until the owner spoke
//      or the TTL expired, ONE bot exchange locked the whole channel for five
//      minutes — Mia could ask Agnes once and then every later "ask Michelle"
//      died as `(hop-limit)`, which reads like broken routing rather than a
//      spent budget. A fresh top-level bot message is a new conversation; only a
//      reply inside an existing thread is a hop.
//   3. OWNER REPLY CAP (default 3) — at most N bot replies per owner turn, no
//      matter which bots are involved. This bounds the WIDTH of a burst even
//      if routing bugs let all three answer the same owner message.
//
// TTL: chain state is scoped to (channel, thread) and expires so a dormant
// thread does not resurrect an old budget. The owner speaking again in the
// thread resets everything — a fresh owner turn is a fresh allowance.
//
// State lives on `globalThis` for the same reason as lib/once.ts: Next's dev
// HMR resets module-level state, which would hand every reconnect a brand new
// budget and re-open the loop the limits exist to close.

import type { AgentLabel } from "./agentRouting";

/** Sibling replies allowed per chain before the chain is closed. */
export const BOT_HOP_LIMIT = 1;

/** Bot replies allowed per owner turn, across all bots. */
export const OWNER_TURN_REPLY_CAP = 3;

/** A chain older than this is treated as a new conversation. */
export const CHAIN_TTL_MS = 5 * 60 * 1000;

export type SlackChainVerdict =
  | { allow: true; hops: number; ownerReplies: number }
  | {
      allow: false;
      reason: "self-echo" | "hop-limit" | "ttl-expired" | "owner-cap";
      hops: number;
      ownerReplies: number;
    };

export type SlackChainState = { hops: number; ownerReplies: number; at: number };

/** Chain key: one conversation = one Slack thread. Top-level channel posts
 *  (no thread) use the channel id itself, so an unthreaded reply is still
 *  bounded instead of escaping the budget entirely. */
export function slackChainKey(channel: string, threadTs?: string | null): string {
  const thread = (threadTs || "").trim();
  return `${(channel || "").trim()}:${thread || "(top)"}`;
}

function emptyState(now: number): SlackChainState {
  return { hops: 0, ownerReplies: 0, at: now };
}

/**
 * THE decision — pure, no globals. `state` is the chain as it stands BEFORE
 * this message; the caller applies the mutation, which keeps the rules fully
 * unit-testable without touching module state.
 */
export function decideSlackChain(
  state: SlackChainState,
  msg: {
    fromBot: boolean;
    from: AgentLabel;
    to: AgentLabel;
    /** A bot message that is not a threaded reply: a NEW conversation, not a hop. */
    initiatesChain?: boolean;
  },
  now: number = Date.now()
): SlackChainVerdict {
  const notStale: SlackChainState = now - state.at > CHAIN_TTL_MS ? emptyState(now) : state;
  const fresh: SlackChainState =
    msg.fromBot && msg.initiatesChain ? emptyState(now) : notStale;

  // The owner is never gated. This guard exists to bound BOTS talking to each
  // other; gating a human would be a worse bug than the loop it prevents.
  if (!msg.fromBot) return { allow: true, ...fresh };

  if (msg.from === msg.to) {
    return { allow: false, reason: "self-echo", ...fresh };
  }
  if (fresh.hops >= BOT_HOP_LIMIT) {
    return { allow: false, reason: "hop-limit", ...fresh };
  }
  if (fresh.ownerReplies >= OWNER_TURN_REPLY_CAP) {
    return { allow: false, reason: "owner-cap", ...fresh };
  }
  return { allow: true, ...fresh };
}

type GuardCarrier = { chains?: Map<string, SlackChainState> };

function chains(): Map<string, SlackChainState> {
  const g = globalThis as unknown as GuardCarrier;
  if (!g.chains) g.chains = new Map<string, SlackChainState>();
  return g.chains;
}

function readChain(key: string, now: number): SlackChainState {
  const found = chains().get(key);
  if (!found || now - found.at > CHAIN_TTL_MS) return emptyState(now);
  return { ...found };
}

function writeChain(key: string, state: SlackChainState, now: number): void {
  // Keep the map from growing without bound across a long-lived process.
  if (chains().size > 500) chains().clear();
  chains().set(key, { ...state, at: now });
}

/**
 * Stateful entry point used by the Slack adapter. Applies the verdict:
 * an allowed bot message consumes one hop AND one owner-reply slot; an owner
 * message RESETS the chain (new turn, new allowance).
 */
export function evaluateSlackMessage(
  key: string,
  msg: {
    fromBot: boolean;
    from: AgentLabel;
    to: AgentLabel;
    /** See `decideSlackChain`. Only meaningful for bot-authored messages. */
    initiatesChain?: boolean;
  },
  now: number = Date.now()
): SlackChainVerdict {
  const state = readChain(key, now);
  const verdict = decideSlackChain(state, msg, now);
  if (verdict.allow && msg.fromBot) {
    writeChain(
      key,
      {
        hops: verdict.hops + 1,
        ownerReplies: verdict.ownerReplies + 1,
        at: now,
      },
      now
    );
  } else if (verdict.allow && !msg.fromBot) {
    // Owner spoke: fresh allowance, previous bot chain is over.
    writeChain(key, emptyState(now), now);
  }
  return verdict;
}

/** Test/reset hook — mirrors lib/once.ts. Not used by production code. */
export function __resetSlackTurnGuard(): void {
  (globalThis as unknown as GuardCarrier).chains = new Map<string, SlackChainState>();
}
