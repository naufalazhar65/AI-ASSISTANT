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
export const LIVE_WRITE_TOOLS = [
  "remind_me",
  "edit_reminder",
  "cancel_reminder",
  "save_note",
  "add_task",
  "complete_task",
  "calendar_add",
  "calendar_mac_add",
] as const;

/** How long an unanswered spoken question stays authoritative. */
export const PENDING_TTL_MS = 3 * 60_000;

/**
 * Affirmation words that count as "ya" (plus common variants). Checked
 * against the USER's transcript, never the model's prose.
 */
const AFFIRM_RE = /\b(ya|iyaa?|boleh|oke|ok|setuju|lanjut(kan)?|baik|siap|tentu)\b/i;

/** Refusal/stop words — checked FIRST, so "ya, tapi jangan" never confirms. */
const REFUSE_RE = /\b(jangan|tidak|nggak|enggak|gak|batal|nanti|tunda|ganti|berhenti|stop)\b/i;

/**
 * True when the user's own transcribed speech carries an affirmation with no
 * refusal in the same breath. Pure — the consent signal for the flag-less
 * path in `decideLiveToolCalls`.
 */
export function isAffirmation(heard: string): boolean {
  if (!heard || !heard.trim()) return false;
  if (REFUSE_RE.test(heard)) return false;
  return AFFIRM_RE.test(heard);
}

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
 *
 * A write executes when the model re-issues it after the user spoke AND
 * EITHER the call carries `confirmed: true` OR the user's own transcribed
 * speech affirms (`heard`, via `isAffirmation`). The second arm exists
 * because models chronically drop the flag on the re-call (owner 2026-10-01:
 * two emissions, zero executions, false "done" claim) — and it is the
 * STRONGER consent proof: the flag is set by the model itself, while `heard`
 * is what the user actually said. A refusal word anywhere in the breath
 * fails closed to ask, always.
 */
export function decideLiveToolCalls(
  state: LiveConfirmState,
  calls: LiveToolCall[],
  heard: string = "",
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
    const affirmed = existing?.userSpokeSinceAsk && isAffirmation(heard);
    if (existing && existing.userSpokeSinceAsk && (confirmedFlag || affirmed)) {
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
  if (call.name === "add_task") {
    const text = typeof args.text === "string" ? args.text.slice(0, 120) : "tugas";
    return `menambahkan tugas '${text}'`;
  }
  if (call.name === "complete_task") {
    const what =
      typeof args.match === "string"
        ? `'${args.match.slice(0, 120)}'`
        : typeof args.number === "string"
          ? `nomor ${args.number}`
          : "tugas";
    return `menandai selesai ${what}`;
  }
  if (call.name === "calendar_add") {
    const title = typeof args.title === "string" ? args.title.slice(0, 120) : "acara";
    return `menjadwalkan '${title}'`;
  }
  if (call.name === "calendar_mac_add") {
    const title = typeof args.title === "string" ? args.title.slice(0, 120) : "acara";
    return `menjadwalkan '${title}' di aplikasi Kalender Mac`;
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
    `Kalau user menjawab ya/iya/boleh/oke: PANGGIL LAGI tool ini dengan ` +
    `confirmed:true — jangan menjawab dengan kata-kata. Kalau user menolak ` +
    `atau ganti topik, jangan panggil lagi. ATURAN KERAS: katakan "sudah ` +
    `dikerjakan/sudah ditambahkan" HANYA SETELAH tool mengembalikan hasil ` +
    `sukses — tidak pernah sebelumnya, tidak pernah sebagai pengganti panggilan.`
  );
}
