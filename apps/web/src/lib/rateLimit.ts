// App-level rate limiting (Fase 5, lightweight): an in-process sliding window
// per user for assistant TURNS (the expensive path — every LLM/agent call flows
// through `runAssistantTurn`). Complements the provider's own 429 handling by
// rejecting bursts BEFORE hitting Groq/9router/opencode.
//
// In-memory by design (a single personal/self-hosted process): a restart resets
// the window, which is acceptable for this threat model (owner-authorized bots
// + webhook secret already gate entry). Config knob: RATE_LIMIT_TURNS_PER_MIN
// via central config (default 30, 0 = unlimited). Throws RateLimitError with a
// friendly message.

import { rateLimitPerMin as rateLimitConfig } from "./config";

const WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();

/** Turns allowed per user per minute. 0 = unlimited. Central config. */
export function limitPerMinute(): number {
  return rateLimitConfig();
}

/** Dedicated error so the web route can map it straight to HTTP 429. */
export class RateLimitError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super("Kamu lagi ngebut banget nih 😅 — coba lagi sebentar lagi ya.");
    this.name = "RateLimitError";
  }
}

/** Reject when the user already used their per-minute turn budget this window. */
export function checkRateLimit(user?: unknown): void {
  const max = limitPerMinute();
  if (!max) return;
  const key = String(user ?? "anonymous").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40) || "anonymous";
  const now = Date.now();
  const windowHits = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (windowHits.length >= max) {
    hits.set(key, windowHits);
    throw new RateLimitError(Math.max(1000, WINDOW_MS - (now - windowHits[0])));
  }
  windowHits.push(now);
  hits.set(key, windowHits);
}