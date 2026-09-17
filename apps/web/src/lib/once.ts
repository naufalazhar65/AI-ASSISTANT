// "Exactly once per PROCESS" primitives.
//
// WHY these live on globalThis: Next dev re-evaluates modules (HMR) and the two
// webpack runtimes can load a module twice, which resets a module-level `let`.
// A reset start-guard starts a SECOND bot/timer (duplicate pushes), and a reset
// dedupe lets a redelivered message run a second full turn — observed live: one
// Discord message produced two `remind_me` confirmation prompts, and Telegram
// logged `409 Conflict ... other getUpdates` while a stale instance was alive.

interface Ring {
  order: string[];
  set: Set<string>;
}

const DEDUPE_CAP = 500;

function ring(): Ring {
  const g = globalThis as { __miaProcessedIds?: Ring };
  if (!g.__miaProcessedIds) g.__miaProcessedIds = { order: [], set: new Set() };
  return g.__miaProcessedIds;
}

function flags(): Record<string, boolean> {
  const g = globalThis as { __miaStarted?: Record<string, boolean> };
  if (!g.__miaStarted) g.__miaStarted = {};
  return g.__miaStarted;
}

/**
 * True when this inbound message was ALREADY handled in this process. Platforms
 * redeliver (Discord gateway resume/replay, Telegram long-poll retry), so every
 * channel must call this once, before doing any work, keyed by the platform's own
 * message/update id. Bounded (last 500 ids) so memory cannot grow. Pure-ish —
 * unit-tested.
 */
export function alreadyProcessed(kind: string, id: string | number): boolean {
  const key = `${kind}:${String(id)}`;
  const r = ring();
  if (r.set.has(key)) return true;
  r.set.add(key);
  r.order.push(key);
  if (r.order.length > DEDUPE_CAP) {
    const old = r.order.shift();
    if (old) r.set.delete(old);
  }
  return false;
}

/**
 * Process-wide start guard for bots, runners and timers. Returns true when the
 * caller has already started this key (so it must return early), false the first
 * time. Replaces module-level `let started` flags, which HMR resets.
 */
export function alreadyStarted(key: string): boolean {
  const f = flags();
  if (f[key]) return true;
  f[key] = true;
  return false;
}

/** Allow a restart after the matching stop*() call (product code + tests). */
export function resetStarted(key: string): void {
  delete flags()[key];
}

/** Test-only: forget all state (never used by product code). */
export function __resetOnceForTests(): void {
  const g = globalThis as { __miaProcessedIds?: Ring; __miaStarted?: Record<string, boolean> };
  g.__miaProcessedIds = { order: [], set: new Set() };
  g.__miaStarted = {};
}
