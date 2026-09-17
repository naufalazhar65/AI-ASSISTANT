// freeride.ts — mandiri FreeRide for Mia (no ~/.openclaw, lokal .data/freeride)
// Ranks OpenRouter free models, fallback chain, watcher 60s — companion to ByteRover/Summarize/Humanizer
// Storage: <appRoot>/.data/freeride/{config.json,cache.json,watcher-state.json} (atomic, capped)
// Provider: OPENROUTER_API_KEY from .env.local (sk-or-v1-...), fallback to 9router free when OpenRouter down

import { mkdirSync, readFileSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { appRoot } from "./users";

const DIR = join(appRoot(), ".data", "freeride");
const CONFIG_FILE = join(DIR, "config.json");
const CACHE_FILE = join(DIR, "cache.json");
const WATCHER_FILE = join(DIR, "watcher-state.json");

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6h
const FETCH_TIMEOUT = 15000;
const PROBE_TIMEOUT = 20000;
// A probe costs one free-model request — the same quota real turns draw from
// (OpenRouter free tier: ~20/min, low daily cap). The watcher ticks every 60s,
// so throttle the actual probe instead of probing 1440×/day.
const PROBE_MIN_INTERVAL_MS = 1000 * 60 * 60; // 1h

type CacheEntry = { fetchedAt: string; models: FreerideModel[] };
type WatcherState = { lastCheck?: string; lastProbeAt?: string; status?: string; model?: string };
type FreerideModel = { id: string; name: string; context_length: number; pricing: { prompt: string; completion: string }; top_provider?: { max_completion_tokens?: number } };
type Config = { primary: string | null; fallbacks: string[]; updatedAt: string; source: string };

function ensureDir(): void {
  mkdirSync(DIR, { recursive: true });
}
function atomicWrite(file: string, data: unknown): void {
  ensureDir();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}
function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

// ── Fetch & rank ──
async function fetchFreeModels(): Promise<FreerideModel[]> {
  const key = process.env.OPENROUTER_API_KEY || "";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(OPENROUTER_MODELS_URL, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!res.ok) throw new Error(`openrouter models ${res.status}`);
  const json = (await res.json()) as { data: FreerideModel[] };
  const free = (json.data || []).filter((m) => m.pricing && m.pricing.prompt === "0" && m.pricing.completion === "0");
  return free;
}

function rankModels(models: FreerideModel[]): FreerideModel[] {
  // FreeRide ranking: quality heuristic — qwen/nemotron/deepseek first, then context_length desc, then name
  const priority = ["qwen/qwen3-coder", "qwen/qwq", "nvidia/nemotron", "deepseek", "meta-llama", "google/gemma", "minimax"];
  return [...models].sort((a, b) => {
    const pa = priority.findIndex((p) => a.id.includes(p));
    const pb = priority.findIndex((p) => b.id.includes(p));
    const sa = pa === -1 ? 999 : pa;
    const sb = pb === -1 ? 999 : pb;
    if (sa !== sb) return sa - sb;
    if (b.context_length !== a.context_length) return b.context_length - a.context_length;
    return a.id.localeCompare(b.id);
  });
}

/**
 * What counts as a LIVE model, given a probe response. OpenRouter answers a
 * failing model with HTTP 200 plus an `error` body ("Upstream error from
 * Nvidia…", "Rate limit exceeded: free-models-per-min"), so `res.ok` alone
 * keeps dead models in the chain — the whole point of the watcher/rotate.
 */
export function isProbeAliveResponse(status: number, body: unknown): boolean {
  if (status < 200 || status >= 300) return false;
  if (!body || typeof body !== "object") return false;
  const b = body as { error?: unknown; choices?: unknown };
  if (b.error) return false;
  return Array.isArray(b.choices);
}

/** Is a real probe due? Probes spend the shared free-model quota, so the 60s
 *  watcher must not probe every tick. */
export function shouldProbeNow(lastProbeAt: string | undefined, now = Date.now()): boolean {
  const last = lastProbeAt ? Date.parse(lastProbeAt) : NaN;
  if (!Number.isFinite(last)) return true;
  return now - last >= PROBE_MIN_INTERVAL_MS;
}

/** Probe one OpenRouter model with a tiny completion. `openrouter/free` is a
 *  real model id (the free auto-router) — use ids exactly as stored. */
async function probeOpenRouterModel(id: string): Promise<boolean> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return false;
  const res = await fetch(OPENROUTER_CHAT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: id, messages: [{ role: "user", content: "hi" }], max_tokens: 5 }),
    signal: AbortSignal.timeout(PROBE_TIMEOUT),
  });
  const body = await res.json().catch(() => null);
  return isProbeAliveResponse(res.status, body);
}

async function getCachedOrFetch(): Promise<{ models: FreerideModel[]; cached: boolean }> {
  const cached = readJson<CacheEntry | null>(CACHE_FILE, null);
  if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < CACHE_TTL_MS && cached.models.length > 0) {
    return { models: cached.models, cached: true };
  }
  try {
    const free = await fetchFreeModels();
    const ranked = rankModels(free);
    atomicWrite(CACHE_FILE, { fetchedAt: new Date().toISOString(), models: ranked } satisfies CacheEntry);
    return { models: ranked, cached: false };
  } catch (e) {
    if (cached) return { models: cached.models, cached: true };
    throw e;
  }
}

function loadConfig(): Config {
  return readJson<Config>(CONFIG_FILE, { primary: null, fallbacks: [], updatedAt: new Date(0).toISOString(), source: "none" });
}
function saveConfig(c: Config): void {
  atomicWrite(CONFIG_FILE, c);
}

// ── Public API ──
export async function freerideList(limit = 10): Promise<FreerideModel[]> {
  const { models } = await getCachedOrFetch();
  return models.slice(0, Math.max(1, Math.min(30, limit)));
}

export async function freerideStatus(): Promise<string> {
  const cfg = loadConfig();
  const cache = readJson<CacheEntry | null>(CACHE_FILE, null);
  const count = cache?.models.length ?? 0;
  const age = cache ? `${Math.round((Date.now() - new Date(cache.fetchedAt).getTime()) / 60000)}m ago` : "never";
  const primary = cfg.primary ?? "—";
  const fallbacks = cfg.fallbacks.length ? cfg.fallbacks.join(", ") : "—";
  // Report the watcher's real last outcome — a failed probe must not read as "alive".
  const w = readJson<WatcherState>(WATCHER_FILE, {});
  const watcher = !w.lastCheck
    ? "not running"
    : w.status === "ok"
      ? `alive (probe ${w.lastProbeAt ?? w.lastCheck})`
      : `${w.status ?? "unknown"} — probe ${w.lastProbeAt ?? w.lastCheck}`;
  return `📊 FREERIDE STATUS\n━━━━━━━━━━━━━━━━━━\n\nPrimary: ${primary}\nFallbacks (${cfg.fallbacks.length}): ${fallbacks}\nUpdated: ${cfg.updatedAt} via ${cfg.source}\nCache: ${count} free models (${age})\nWatcher: ${watcher}\n\nOPENROUTER_API_KEY: ${process.env.OPENROUTER_API_KEY ? "set" : "not set"} (free at openrouter.ai/keys)`;
}

export async function freerideAuto(opts?: { keepPrimary?: boolean; count?: number }): Promise<string> {
  const keep = !!opts?.keepPrimary;
  const want = Math.max(1, Math.min(10, opts?.count ?? 5));
  const { models, cached } = await getCachedOrFetch();
  if (!models.length) return "Error: no free models found (cache empty + fetch failed)";
  const cfg = loadConfig();
  // Catalog ids are already OpenRouter ids (`nvidia/…:free`) — use them as-is.
  const freeIds = models.map((m) => m.id);
  const primary = keep && cfg.primary ? cfg.primary : freeIds[0];
  const fallbacks: string[] = [];
  // spec: first fallback always openrouter/free
  fallbacks.push("openrouter/free");
  for (const id of freeIds) {
    if (id === primary) continue;
    if (fallbacks.includes(id)) continue;
    fallbacks.push(id);
    if (fallbacks.length >= want) break;
  }
  const next: Config = { primary, fallbacks: fallbacks.slice(0, want), updatedAt: new Date().toISOString(), source: cached ? "cache" : "live" };
  saveConfig(next);
  return `✅ FreeRide auto: primary ${primary} + ${next.fallbacks.length} fallbacks\nFallbacks: ${next.fallbacks.join(", ")}\nCache: ${cached ? "hit" : "miss"} (${models.length} free)\n\nNext: no gateway restart needed for Mia (providers.ts reads .data/freeride/config.json). Test with /status or freeride_status.`;
}

export async function freerideSwitch(model: string, fallbackOnly?: boolean): Promise<string> {
  const id = model.trim();
  if (!id) return "Error: model required";
  if (id.startsWith("-")) return "Error: model must not start with '-'";
  const cfg = loadConfig();
  if (fallbackOnly) {
    if (cfg.fallbacks.includes(id)) return `Already fallback: ${id}`;
    cfg.fallbacks.unshift(id);
    cfg.fallbacks = cfg.fallbacks.slice(0, 6);
    cfg.updatedAt = new Date().toISOString();
    cfg.source = "switch -f";
    saveConfig(cfg);
    return `Added fallback: ${id}\nFallbacks: ${cfg.fallbacks.join(", ")}`;
  }
  cfg.primary = id;
  // ensure primary not also in fallbacks
  cfg.fallbacks = cfg.fallbacks.filter((f) => f !== id);
  cfg.updatedAt = new Date().toISOString();
  cfg.source = "switch";
  saveConfig(cfg);
  return `Switched primary to ${id}\nFallbacks: ${cfg.fallbacks.join(", ") || "—"}`;
}

export async function freerideRefresh(): Promise<string> {
  const free = await fetchFreeModels();
  const ranked = rankModels(free);
  atomicWrite(CACHE_FILE, { fetchedAt: new Date().toISOString(), models: ranked } satisfies CacheEntry);
  return `Refreshed ${ranked.length} free models (top: ${ranked.slice(0, 3).map((m) => m.id).join(", ")})`;
}

export async function freerideRotate(): Promise<string> {
  // Live-test and rebuild — probe each fallback, keep alive ones
  const cfg = loadConfig();
  const models = cfg.fallbacks.length ? cfg.fallbacks : (await getCachedOrFetch()).models.map((m) => m.id);
  const alive: string[] = [];
  // No key → cannot verify, so keep the chain as-is rather than emptying it.
  if (!process.env.OPENROUTER_API_KEY) return "Rotate: OPENROUTER_API_KEY kosong — chain dipertahankan";
  for (const id of models.slice(0, 5)) {
    try {
      if (await probeOpenRouterModel(id)) alive.push(id);
    } catch {}
  }
  if (alive.length === 0) return "Rotate: no alive models probed — keeping existing chain";
  cfg.fallbacks = alive;
  cfg.updatedAt = new Date().toISOString();
  cfg.source = "rotate";
  saveConfig(cfg);
  return `Rotated — alive fallbacks: ${alive.join(", ")}`;
}

export function freerideGetConfig(): Config {
  return loadConfig();
}

export async function freerideWatcherOnce(): Promise<string> {
  const cfg = loadConfig();
  if (!cfg.primary) return "Watcher: no primary — run freeride_auto first";
  const probeModel = cfg.primary;
  const now = new Date().toISOString();
  const state = readJson<WatcherState>(WATCHER_FILE, {});

  // Throttle: a probe spends the account's free-model quota, shared with real
  // turns, and the watcher ticks every 60s.
  if (!shouldProbeNow(state.lastProbeAt)) {
    const sinceMin = Math.round((Date.now() - Date.parse(state.lastProbeAt as string)) / 60000);
    atomicWrite(WATCHER_FILE, { ...state, lastCheck: now });
    return `Watcher: skip — diprobe ${sinceMin}m lalu (interval ${PROBE_MIN_INTERVAL_MS / 60000}m)`;
  }

  // Every chain id comes from the OpenRouter catalog (e.g. nvidia/*:free,
  // openrouter/free) — so probe it there. A non-OpenRouter primary (a 9router
  // name without "/") can't be probed this way; just record the check.
  if (!probeModel.includes("/")) {
    atomicWrite(WATCHER_FILE, { lastCheck: now, status: "ok", model: probeModel });
    return `Watcher OK (bukan model OpenRouter) — primary ${probeModel}`;
  }
  if (!process.env.OPENROUTER_API_KEY) {
    atomicWrite(WATCHER_FILE, { lastCheck: now, status: "unprobed", model: probeModel });
    return `Watcher: primary ${probeModel} tak diprobe (OPENROUTER_API_KEY kosong)`;
  }
  try {
    if (!(await probeOpenRouterModel(probeModel))) throw new Error("probe gagal / provider error");
    atomicWrite(WATCHER_FILE, { lastCheck: now, lastProbeAt: now, status: "ok", model: probeModel });
    return `Watcher OK — primary ${probeModel} alive`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // auto-rotate on failure
    try {
      await freerideRotate();
    } catch {}
    // lastProbeAt is recorded even on failure, so a persistently dead primary
    // is re-checked once per interval (not every 60s).
    atomicWrite(WATCHER_FILE, { lastCheck: now, lastProbeAt: now, status: `failed: ${msg}`, model: probeModel });
    return `Watcher failed for ${probeModel}: ${msg} — rotated fallbacks`;
  }
}
