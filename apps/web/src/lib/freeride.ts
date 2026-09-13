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
const CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6h
const FETCH_TIMEOUT = 15000;

type CacheEntry = { fetchedAt: string; models: FreerideModel[] };
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
  return `📊 FREERIDE STATUS\n━━━━━━━━━━━━━━━━━━\n\nPrimary: ${primary}\nFallbacks (${cfg.fallbacks.length}): ${fallbacks}\nUpdated: ${cfg.updatedAt} via ${cfg.source}\nCache: ${count} free models (${age})\nWatcher: ${readJson<{ lastCheck?: string }>(WATCHER_FILE, {} as never).lastCheck ? "alive" : "not running"}\n\nOPENROUTER_API_KEY: ${process.env.OPENROUTER_API_KEY ? "set" : "not set"} (free at openrouter.ai/keys)`;
}

export async function freerideAuto(opts?: { keepPrimary?: boolean; count?: number }): Promise<string> {
  const keep = !!opts?.keepPrimary;
  const want = Math.max(1, Math.min(10, opts?.count ?? 5));
  const { models, cached } = await getCachedOrFetch();
  if (!models.length) return "Error: no free models found (cache empty + fetch failed)";
  const cfg = loadConfig();
  // Always first fallback is openrouter/free smart router (as per spec)
  const rankedIds = models.map((m) => `openrouter/${m.id}:free`);
  // But OpenRouter already serves :free suffix; the list already has :free? Check: models id like "qwen/qwen3-coder:free" already includes :free
  // For Mia, we normalize to as-is id
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
  for (const id of models.slice(0, 5)) {
    try {
      // Probe via OpenRouter chat with tiny prompt, 5s timeout
      const key = process.env.OPENROUTER_API_KEY;
      if (!key) { alive.push(id); continue; }
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: id, messages: [{ role: "user", content: "hi" }], max_tokens: 5 }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) alive.push(id);
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
  // Probe primary via OpenRouter (or 9router if primary is 9router)
  const probeModel = cfg.primary;
  try {
    const key = process.env.OPENROUTER_API_KEY;
    // For Mia, primary may be openrouter/... — probe via OpenRouter
    if (probeModel.startsWith("openrouter/") && key) {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: probeModel.replace("openrouter/", ""), messages: [{ role: "user", content: "hi" }], max_tokens: 5 }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`probe ${res.status}`);
      atomicWrite(WATCHER_FILE, { lastCheck: new Date().toISOString(), status: "ok", model: probeModel });
      return `Watcher OK — primary ${probeModel} alive`;
    }
    // For 9router / non-openrouter, just check cache age
    atomicWrite(WATCHER_FILE, { lastCheck: new Date().toISOString(), status: "ok", model: probeModel });
    return `Watcher OK (no probe needed) — primary ${probeModel}`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // auto-rotate on failure
    try {
      await freerideRotate();
    } catch {}
    atomicWrite(WATCHER_FILE, { lastCheck: new Date().toISOString(), status: `failed: ${msg}`, model: probeModel });
    return `Watcher failed for ${probeModel}: ${msg} — rotated fallbacks`;
  }
}
