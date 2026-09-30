/**
 * Spoken-confirmation loop for Live voice write tools (Phase B, gap #2).
 *
 * Live tool calls are synchronous and the Live UI has no confirmation
 * control, yet FR-014 requires confirmation for write tools. So the browser
 * cannot execute a voice write on first sight the way it does reads. Instead
 * this pure state machine splits every incoming tool call:
 *   - read tools (and everything outside the write set) → execute now;
 *   - a write tool seen the FIRST time (or re-called without proof the user
 *     agreed) → hold in `pending` and answer with an ask-first instruction
 *     the model speaks aloud ("Mau aku ingetin ..., ya?");
 *   - the SAME write call re-issued with `confirmed: true` AFTER the user
 *     spoke → execute.
 *
 * Two guards make a lazy model unable to skip the question: the `confirmed`
 * flag alone is never enough (the first sighting always asks), and a repeat
 * without intervening user speech asks again. Pending entries expire
 * (3 min) so a stale question can never authorize a later turn.
 *
 * Pure + tested; the hook owns one instance in a ref. Server-side, the tool
 * route independently refuses unconfirmed write calls, so a tampered client
 * that skips this module still executes nothing.
 */

import type { LiveToolCall } from "./geminiLive";

/** Write tools allowed in Live at all — everything else executes immediately. */
export const LIVE_WRITE_TOOLS = ["remind_me", "save_note"] as const;

/** How long an unanswered spoken question stays authoritative. */
export const PENDING_TTL_MS = 3 * 60_000;

export interface PendingWriteCall {
  name: string;
  /** Args minus `confirmed`, so a flag flip cannot fork a second pending. */
  argsKey: string;
  args: Record<string, unknown>;
  askedAt: number;
  userSpokeSinceAsk: boolean;
}

export interface LiveConfirmState {
  pending: PendingWriteCall[];
}

export function emptyConfirmState(): LiveConfirmState {
  return { pending: [] };
}

/** Stable key for args with the transient `confirmed` flag removed. */
export function pendingArgsKey(args: Record<string, unknown>): string {
  const { confirmed: _drop, ...rest } = args;
  void _drop;
  const keys = Object.keys(rest).sort();
  return keys.map((k) => `${k}=${JSON.stringify(rest[k])}`).join("&");
}

function prune(state: LiveConfirmState, now: number): LiveConfirmState {
  return { pending: state.pending.filter((p) => now - p.askedAt < PENDING_TTL_MS) };
}

/** Mark that the user spoke: any pending question may now be answerable. */
export function markUserSpoke(state: LiveConfirmState, now: number = Date.now()): LiveConfirmState {
  const pruned = prune(state, now);
  return { pending: pruned.pending.map((p) => ({ ...p, userSpokeSinceAsk: true })) };
}

export interface ConfirmDecision {
  /** Calls to execute now (reads + confirmed writes). */
  execute: LiveToolCall[];
  /** Write calls to hold: answer these with `askFirstInstruction`. */
  ask: LiveToolCall[];
  state: LiveConfirmState;
}

/**
 * Split incoming Live tool calls into execute-now vs ask-first. Never throws;
 * a malformed call is held (asking is always safer than running).
 */
export function decideLiveToolCalls(
  state: LiveConfirmState,
  calls: LiveToolCall[],
  now: number = Date.now()
): ConfirmDecision {
  const pruned = prune(state, now);
  const pending = [...pruned.pending];
  const execute: LiveToolCall[] = [];
  const ask: LiveToolCall[] = [];
  for (const call of calls) {
    if (!(LIVE_WRITE_TOOLS as readonly string[]).includes(call.name)) {
      execute.push(call);
      continue;
    }
    const key = pendingArgsKey(call.args ?? {});
    const idx = pending.findIndex((p) => p.name === call.name && p.argsKey === key);
    const existing = idx >= 0 ? pending[idx] : undefined;
    const confirmedFlag = (call.args ?? {}).confirmed === true;
    if (existing && existing.userSpokeSinceAsk && confirmedFlag) {
      pending.splice(idx, 1);
      execute.push(call);
    } else {
      const entry: PendingWriteCall = {
        name: call.name,
        argsKey: key,
        args: call.args ?? {},
        askedAt: now,
        userSpokeSinceAsk: existing?.userSpokeSinceAsk ?? false,
      };
      if (idx >= 0) pending[idx] = entry;
      else pending.push(entry);
      ask.push(call);
    }
  }
  return { execute, ask, state: { pending } };
}

/** Short human summary of a write call, for the spoken question. */
function describeWriteCall(call: LiveToolCall): string {
  const args = call.args ?? {};
  if (call.name === "remind_me") {
    const text = typeof args.text === "string" ? args.text.slice(0, 120) : "pengingat";
    const when = typeof args.when === "string" ? args.when : "jadwal yang kamu sebut";
    return `mengingetin '${text}' ${when}`;
  }
  if (call.name === "save_note") {
    const content = typeof args.content === "string" ? args.content.slice(0, 120) : "catatan";
    return `mencatat '${content}'`;
  }
  return `menjalankan ${call.name}`;
}

/**
 * The toolResponse result for a held write call: instructs the model to ask
 * aloud with the concrete question (never to claim the action is done), and
 * to re-call with `confirmed: true` only on an affirmative answer.
 */
export function askFirstInstruction(call: LiveToolCall): string {
  const what = describeWriteCall(call);
  return (
    `PERLU KONFIRMASI LISAN: tanyakan dulu ke user dengan suara, ` +
    `persis maksudnya: "Mau aku ${what}, ya?" — JANGAN klaim sudah dikerjakan. ` +
    `Panggil lagi tool ini dengan confirmed:true hanya kalau user menjawab ` +
    `ya/iya/boleh/oke; kalau user menolak atau ganti topik, jangan panggil lagi.`
  );
}
