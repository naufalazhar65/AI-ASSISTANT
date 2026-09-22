// providerHealth.ts — provider-level auto-failover + quota watchdog (single owner).
// Tracks per-provider health in .data/provider-health/state.json so runAssistantTurn can
// pick the first healthy provider in a ranked chain: when the default brain dies (e.g.
// OpenCode Go 429 monthly GoUsageLimitError), turns fall back to 9router/groq instead of
// erroring, and the brain auto-restores when it recovers — no manual .env.local surgery.
//
// Cost discipline:
//  - A provider marked down in a cooldown is skipped by the chain (no pointless 429 spam).
//  - Billed monthly providers (opencodego) are NEVER probed: a probe spends its monthly
//    quota. They restore via cooldown expiry (24h) + a real turn attempt after that.
//  - Free/cheap providers (groq, 9router, openrouter) may be probed 1×/hour while down.

import { mkdirSync, readFileSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { appRoot } from "./users";
import { ProviderId, resolveProvider, providerHeaders } from "./providers";
import { isProviderRetryable } from "./assistantError";

const DIR = join(appRoot(), ".data", "provider-health");
const STATE_FILE = join(DIR, "state.json");

/** Billed quota resets slowly (Go monthly). Re-enter the chain daily after a quota hit. */
const QUOTA_COOLDOWN_MS = 1000 * 60 * 60 * 24;
/** 5xx / short rate-limit dips recover in minutes. */
const TRANSIENT_COOLDOWN_MS = 1000 * 60 * 5;
/** Transient failures before a provider is marked down. */
const FAIL_THRESHOLD = 3;
/** Don't probe down providers more often than this (probes cost quota/latency). */
const PROBE_MIN_INTERVAL_MS = 1000 * 60 * 60;

/** Desired order when the default is unavailable: best brain first. */
const DESIRED_ORDER: ProviderId[] = ["opencodego", "9router", "groq", "openrouter", "opencode"];
/** Probes only these — cheap/free to test. opencodego is quota-billed, opencode is local-Agent. */
export const PROBE_ELIGIBLE: ProviderId[] = ["groq", "9router", "openrouter"];

const QUOTA_RE =
  /(goUsageLimitError|usage limit reached|monthly limit|quota|out of tokens|insufficient credits|payment required|\b402\b|billing|topped? up)/i;

export type ProviderHealth = {
  status: "ok" | "down";
  failCount: number;
  lastCheckedAt?: string;
  quotaHitAt?: string;
  cooldownUntil?: string;
  lastError?: string;
  lastProbeAt?: string;
};
type HealthState = { providers: Record<string, ProviderHealth>; updatedAt: string };

function nowIso(now = Date.now()): string {
  return new Date(now).toISOString();
}
function parseIso(s?: string): number {
  return s ? Date.parse(s) : NaN;
}

function ensureDir(): void {
  mkdirSync(DIR, { recursive: true });
}
function atomicWrite(data: HealthState): void {
  ensureDir();
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, STATE_FILE);
}
function readState(): HealthState {
  try {
    if (!existsSync(STATE_FILE)) return { providers: {}, updatedAt: nowIso() };
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as HealthState;
    if (!parsed || typeof parsed !== "object" || !parsed.providers) return { providers: {}, updatedAt: nowIso() };
    return parsed;
  } catch {
    return { providers: {}, updatedAt: nowIso() };
  }
}
function blank(): ProviderHealth {
  return { status: "ok", failCount: 0, lastCheckedAt: nowIso() };
}

/** Pure: apply one failure to a health record. Quota hits = long cooldown (billed
 *  reset); transient retryable failures build a failCount before going down short. */
export function applyFailure(h: ProviderHealth, err: unknown, now = Date.now()): ProviderHealth {
  const detail = err instanceof Error ? err.message : String(err ?? "");
  if (!isProviderRetryable(err)) return h; // code/tool errors are not provider health
  const next: ProviderHealth = { ...h, lastCheckedAt: nowIso(now), lastError: detail.slice(0, 200) };
  if (QUOTA_RE.test(detail)) {
    next.status = "down";
    next.failCount = h.failCount + 1;
    next.quotaHitAt = nowIso(now);
    next.cooldownUntil = nowIso(now + QUOTA_COOLDOWN_MS);
  } else {
    next.failCount = h.failCount + 1;
    if (next.failCount >= FAIL_THRESHOLD) {
      next.status = "down";
      next.cooldownUntil = nowIso(now + TRANSIENT_COOLDOWN_MS);
    }
  }
  return next;
}

/** Pure: restore a healthy record. */
export function applySuccess(h: ProviderHealth | undefined, now = Date.now()): ProviderHealth {
  if (!h || h.status === "ok") return h ?? blank();
  return { ...h, status: "ok", failCount: 0, lastCheckedAt: nowIso(now), cooldownUntil: undefined, lastError: undefined };
}

function record(fn: (h: ProviderHealth) => ProviderHealth, id: ProviderId): ProviderHealth {
  const state = readState();
  const prev = state.providers[id] ?? blank();
  const next = fn(prev);
  state.providers[id] = next;
  state.updatedAt = nowIso();
  atomicWrite(state);
  return next;
}

/** Record a failed provider attempt (only marks when the error is provider-retryable). */
export function markProviderFailure(id: ProviderId, err: unknown, now = Date.now()): void {
  record((h) => applyFailure(h, err, now), id);
}
/** Record a successful attempt (clears down/cooldown → provider re-enters the chain). */
export function markProviderHealthy(id: ProviderId, now = Date.now()): void {
  record((h) => applySuccess(h, now), id);
}

export type ResolvedProvider = NonNullable<ReturnType<typeof resolveProvider>>;

/** Pure: ordered candidate list given a health state. `desired` first, then
 *  ranked fallbacks; configured-only; down-within-cooldown skipped. Empty →
 *  `[]` (caller decides: throw not-configured / best-effort). */
export function buildChain(
  desired: ProviderId,
  state: HealthState,
  resolveFn: (id: ProviderId) => ResolvedProvider | null,
  now = Date.now(),
  order: ProviderId[] = DESIRED_ORDER
): { id: ProviderId; resolved: ResolvedProvider }[] {
  const ranked = [desired, ...order.filter((p) => p !== desired)];
  const out: { id: ProviderId; resolved: ResolvedProvider }[] = [];
  for (const id of ranked) {
    const resolved = resolveFn(id);
    if (!resolved) continue;
    const h = state.providers[id];
    if (h?.status === "down" && h.cooldownUntil && now < parseIso(h.cooldownUntil)) continue;
    out.push({ id, resolved });
  }
  return out;
}

/** Build the ordered provider chain from persisted health. Empty → `[desired]`
 *  (best-effort so the real error surfaces instead of a silent wrong answer). */
export function providerChain(
  desired: ProviderId,
  now = Date.now(),
  resolveFn: (id: ProviderId) => ResolvedProvider | null = resolveProvider
): { id: ProviderId; resolved: ResolvedProvider }[] {
  const out = buildChain(desired, readState(), resolveFn, now);
  if (out.length > 0) return out;
  const resolved = resolveFn(desired);
  return resolved ? [{ id: desired, resolved }] : [];
}

/** Effective provider ids a turn would try, for status display. */
export function effectiveChainFor(desired: ProviderId, now = Date.now()): ProviderId[] {
  return providerChain(desired, now).map((c) => c.id);
}

/** Is a real probe of this down provider due? (free/cheap providers only, 1×/h) */
export function shouldProbeProvider(id: ProviderId, state: HealthState, now = Date.now()): boolean {
  if (!PROBE_ELIGIBLE.includes(id)) return false;
  const h = state.providers[id];
  if (!h || h.status !== "down") return false;
  const last = h.lastProbeAt ? parseIso(h.lastProbeAt) : 0;
  if (Number.isNaN(last)) return true; // malformed timestamp → due (never probed)
  return now - last >= PROBE_MIN_INTERVAL_MS;
}

/** Tiny completion against a provider — a cheap liveness check. */
export async function probeProvider(id: ProviderId, resolveFn: (p: ProviderId) => ResolvedProvider | null = resolveProvider): Promise<boolean> {
  const resolved = resolveFn(id);
  if (!resolved) return false;
  try {
    const res = await fetch(resolved.url, {
      method: "POST",
      headers: providerHeaders(resolved, "mia-probe"),
      body: JSON.stringify({
        model: resolved.defaultModel || undefined,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 5,
        stream: false,
      }),
      signal: AbortSignal.timeout(20000),
    });
    const body: unknown = await res.json().catch(() => null);
    if (res.status < 200 || res.status >= 300) return false;
    if (!body || typeof body !== "object") return false;
    const b = body as { error?: unknown; choices?: unknown };
    if (b.error) return false;
    return Array.isArray(b.choices) && b.choices.length > 0;
  } catch {
    return false;
  }
}

/** Watcher tick: probe down cheap providers (1×/h), restore when alive. Silent when idle. */
export async function providerHealthTick(now = Date.now()): Promise<string> {
  const state = readState();
  const lines: string[] = [];
  for (const provider of PROBE_ELIGIBLE) {
    if (!shouldProbeProvider(provider, state, now)) continue;
    const h = state.providers[provider]!;
    const alive = await probeProvider(provider);
    if (alive) {
      markProviderHealthy(provider, now);
      lines.push(`${provider} restored`);
    } else {
      // Rewrite lastProbeAt even on failure so a dead provider is not re-probed every tick.
      state.providers[provider] = { ...h, lastProbeAt: nowIso(now) };
      state.updatedAt = nowIso(now);
      atomicWrite(state);
    }
  }
  return lines.length ? lines.join(", ") : "";
}

/** Human digest for `provider_status` (read, auto). */
export function providerHealthStatus(): string {
  const state = readState();
  const defaults: Partial<Record<ProviderId, string>> = {
    opencodego: process.env.OPENCODEGO_API_KEY ? "opencodego" : undefined,
    "9router": process.env.LLM_API_KEY ? "9router" : undefined,
    groq: process.env.GROQ_API_KEY ? "groq" : undefined,
    openrouter: process.env.OPENROUTER_API_KEY ? "openrouter" : undefined,
    opencode: process.env.OPENCODE_LLM_BASE ? "opencode" : undefined,
  };
  const desired = (process.env.DEFAULT_AI_PROVIDER && defaults[process.env.DEFAULT_AI_PROVIDER as ProviderId]) || "groq";
  const chain = effectiveChainFor(desired as ProviderId);
  const lines = [`Brain default: ${desired} → chain: ${chain.join(" → ") || "(none configured)"}`];
  for (const id of DESIRED_ORDER) {
    const h = state.providers[id];
    if (!h || h.status === "ok") continue;
    const cooldown = h.cooldownUntil ? ` cooldown s/d ${h.cooldownUntil}` : "";
    const quota = h.quotaHitAt ? ` quotaHit ${h.quotaHitAt}` : "";
    lines.push(`- ${id}: DOWN (${h.failCount} fail)${quota}${cooldown}${h.lastError ? ` — ${h.lastError}` : ""}`);
  }
  lines.push("Env channels: TELEGRAM_PROVIDER/DISCORD_PROVIDER/DEFAULT_AI_PROVIDER dipilih per-turn dari chain ini (bukan hard-swap .env).");
  return lines.join("\n");
}