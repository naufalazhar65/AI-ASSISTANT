// Price/crypto watchlist monitor (Mia feature #6). Server-side only.
//
// Per-user list of targets the assistant watches and alerts on. A monitor has:
//   - kind "crypto": a CoinGecko asset id/symbol (e.g. "bitcoin" / "btc"); price
//     is fetched from CoinGecko's public API (no key).
//   - kind "web": a public http(s) URL whose page embeds a number (an e-commerce
//     price); we fetch the page (SSRF-guarded like fetch_url) and extract the
//     first currency-looking number. Best-effort — page markup varies.
//   - threshold + direction ("above"|"below"): we alert once when the price
//     crosses the threshold, and re-arm once it returns to the safe side.
//
// Store mirrors the mood/tasks/reminders pattern (atomic write, sanitized user):
// apps/web/.data/users/<user>/monitors.json.
//
// The heartbeat tick calls `checkMonitorsAndAlert` for every user and pushes
// crossing alerts to the owner via pushToOwner — same proactive sink as
// overdue-task nudges. No separate scheduler needed.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";

export type MonitorKind = "crypto" | "web" | "device";

/** Valid subjects for kind "device" (local Mac health metrics, percent 0-100). */
export const DEVICE_SUBJECTS = ["battery", "storage"] as const;

export interface MonitorTarget {
  id: string;
  /** Short name the user gives, e.g. "Bitcoin" or "Monitor headphones". */
  name: string;
  kind: MonitorKind;
  /** crypto: CoinGecko id or symbol; web: public page URL. */
  subject: string;
  /** Optional price to alert on (crypto USD, web page-number). */
  threshold?: number;
  /** Only meaningful with a threshold. */
  direction?: "above" | "below";
  /** Last observed value (undefined until first check). */
  lastValue?: number | null;
  /** When the threshold was last tripped (undefined = armed). */
  alertedAt?: number;
  at: number;
}

const MAX_MONITORS = 25;
const FETCH_TIMEOUT_MS = 10_000;

// A few common crypto aliases → CoinGecko ids, so users can say "btc" / "eth"
// and we don't always need the full lowercase name.
const COINGECKO_ALIASES: Record<string, string> = {
  btc: "bitcoin",
  eth: "ethereum",
  xrp: "ripple",
  sol: "solana",
  ada: "cardano",
  dot: "polkadot",
  avax: "avalanche-2",
  doge: "dogecoin",
  link: "chainlink",
  matic: "matic-network",
  ltc: "litecoin",
  bnb: "binancecoin",
  uni: "uniswap",
  atom: "cosmos",
  shib: "shiba-inu",
};

function monitorsPath(userKey: string): string {
  return join(userDataRoot(), userKey, "monitors.json");
}

export function readMonitors(rawUser?: unknown): MonitorTarget[] {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return [];
  try {
    const raw = readFileSync(monitorsPath(userKey), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is MonitorTarget =>
        !!e &&
        typeof (e as MonitorTarget).id === "string" &&
        typeof (e as MonitorTarget).name === "string" &&
        ((e as MonitorTarget).kind === "crypto" ||
          (e as MonitorTarget).kind === "web" ||
          (e as MonitorTarget).kind === "device") &&
        typeof (e as MonitorTarget).subject === "string" &&
        typeof (e as MonitorTarget).at === "number"
    );
  } catch {
    return [];
  }
}

function writeMonitors(monitors: MonitorTarget[], userKey: string): void {
  const file = monitorsPath(userKey);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(monitors, null, 2));
  renameSync(tmp, file);
}

/** Add a watchlist target. Returns the saved target or throws on bad input. */
export function addMonitor(opts: {
  name: unknown;
  kind: unknown;
  subject: unknown;
  threshold?: unknown;
  direction?: unknown;
  rawUser?: unknown;
}): MonitorTarget {
  const userKey = sanitizeUser(opts.rawUser);
  if (!userKey) throw new Error("invalid user");
  const name = String(opts.name ?? "").trim().slice(0, 120);
  const subject = String(opts.subject ?? "").trim().slice(0, 500);
  if (!name) throw new Error("nama/description wajib diisi");
  if (!subject) throw new Error("subjek wajib diisi (crypto id/symbol atau URL produk)");
  const kind: MonitorKind =
    opts.kind === "web" ? "web" : opts.kind === "device" ? "device" : "crypto";
  if (kind === "device") {
    // Mac health monitor: subject is battery or storage, threshold is a
    // percent. Battery alerts when it drops to/below the threshold, storage
    // when it rises to/above it.
    const subj = subject.toLowerCase();
    if (!(DEVICE_SUBJECTS as readonly string[]).includes(subj)) {
      throw new Error("monitor device subject harus 'battery' atau 'storage'");
    }
    const th = Number(opts.threshold);
    if (!Number.isFinite(th) || th < 1 || th > 100) {
      throw new Error("threshold device monitor harus persen 1-100");
    }
    const direction = subj === "battery" ? "below" : "above";
    const target: MonitorTarget = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: subj === "battery" ? "Baterai Mac" : "Storage Mac",
      kind,
      subject: subj,
      threshold: th,
      direction,
      at: Date.now(),
    };
    const monitors = readMonitors(opts.rawUser);
    if (monitors.length >= MAX_MONITORS) throw new Error(`watchlist penuh (maks ${MAX_MONITORS})`);
    const existing = monitors.find((m) => m.kind === "device" && m.subject === subj);
    if (existing) {
      existing.name = target.name;
      existing.threshold = th;
      existing.direction = direction;
      writeMonitors(monitors, userKey);
      return existing;
    }
    monitors.push(target);
    writeMonitors(monitors, userKey);
    return target;
  }

  let threshold: number | undefined;
  const th = Number(opts.threshold);
  if (opts.threshold !== undefined && opts.threshold !== null && opts.threshold !== "" && !Number.isNaN(th)) {
    threshold = th;
    if (threshold <= 0) throw new Error("threshold harus angka positif");
  }

  let direction: "above" | "below" | undefined;
  if (opts.direction === "above" || opts.direction === "below") {
    direction = opts.direction;
  } else if (threshold !== undefined) {
    direction = "above"; // sane default: alert when it goes above
  }

  if (threshold !== undefined && !direction) throw new Error("direction harus 'above' atau 'below' saat threshold dipakai");

  const target: MonitorTarget = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    kind,
    subject,
    ...(threshold !== undefined ? { threshold, direction } : {}),
    at: Date.now(),
  };
  const monitors = readMonitors(opts.rawUser);
  if (monitors.length >= MAX_MONITORS) throw new Error(`watchlist penuh (maks ${MAX_MONITORS})`);
  // Merge into an existing, identical watchlist entry (same kind+subject+rule)
  // instead of stacking duplicates — e.g. the 9router model both answers and
  // emits a real `monitor_add` in one turn, or the user re-asks the same thing.
  // The existing entry keeps its id/lastValue/alertedAt and just gets the name
  // refreshed, so repeated asks never flood the store (mirrors reminders' merge).
  const sameRule = (m: MonitorTarget): boolean =>
    m.kind === kind &&
    m.subject.toLowerCase() === subject.toLowerCase() &&
    ((m.threshold === undefined) === (threshold === undefined));
  const existing = monitors.find((m) => sameRule(m) && (threshold === undefined || m.threshold === threshold) && (direction === undefined || m.direction === direction));
  if (existing) {
    existing.name = name;
    writeMonitors(monitors, userKey);
    return existing;
  }
  monitors.push(target);
  writeMonitors(monitors, userKey);
  return target;
}

/** Remove a monitor by id. Returns true when it existed. */
export function removeMonitor(id: string, rawUser?: unknown): boolean {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return false;
  const monitors = readMonitors(rawUser);
  const next = monitors.filter((m) => m.id !== id);
  if (next.length === monitors.length) return false;
  writeMonitors(next, userKey);
  return true;
}

/** Human-readable watchlist, newest first. */
export function listMonitors(rawUser?: unknown): string {
  const monitors = readMonitors(rawUser);
  if (!monitors.length) return "Belum ada yang dipantau. Contoh: 'monitorin harga bitcoin' atau 'pantau harga headphone di link ini'.";
  return monitors
    .map((m) => {
      const isDevice = m.kind === "device";
      const unit = isDevice ? "%" : "";
      const val = m.lastValue === undefined || m.lastValue === null
        ? "belum dicek"
        : isDevice ? `${m.lastValue}%` : `Rp ${fmtPrice(m.lastValue)}`;
      const th = m.threshold !== undefined ? ` (alert ${m.direction === "below" ? "di bawah" : "di atas"} ${fmtPrice(m.threshold)}${unit})` : "";
      const kindLabel = m.kind === "crypto" ? "crypto" : m.kind === "device" ? "device" : "web";
      return `- ${m.name} [${kindLabel}]: ${val}${th}`;
    })
    .join("\n");
}

function fmtPrice(n: number): string {
  return n.toLocaleString("id-ID", { maximumFractionDigits: 2 });
}

// ---- price fetching ----

async function fetchCryptoUsd(subject: string): Promise<number | null> {
  const s = subject.trim().toLowerCase();
  const id = COINGECKO_ALIASES[s] ?? s.replace(/[^a-z0-9-]/g, "");
  if (!id) return null;
  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd`,
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
  );
  if (!res.ok) return null;
  const data = (await res.json()) as Record<string, Record<string, number>>;
  const usd = data[id]?.usd;
  return typeof usd === "number" && !Number.isNaN(usd) ? usd : null;
}

function tryAsUrl(subject: string): string | null {
  try {
    const u = new URL(subject);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

const CURRENCY_RE =
  /\$\s?([\d,]+(?:\.\d+)?)|(?:Rp|IDR)\s?([\d.,]+)|\b([\d,]+(?:\.\d+)?)\s*(?:juta|rb|ribu)?/i;

/** Best-effort: fetch a public page and pull the first currency-looking number. */
async function fetchWebNumber(subject: string): Promise<number | null> {
  const url = tryAsUrl(subject);
  if (!url) return null;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const html = (await res.text()).slice(0, 400_000);
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]*>/g, " ");
  const m = text.match(CURRENCY_RE);
  if (!m) return null;
  const raw = (m[1] ?? m[2] ?? m[3] ?? "").replace(/[^\d.]/g, "");
  const n = Number(raw);
  return n > 0 ? n : null;
}

/** Current metric for a monitor, or null when it can't be read. Device
 *  monitors read the LOCAL Mac (battery % via pmset/ioreg, storage % via df). */
export async function fetchPrice(m: MonitorTarget): Promise<number | null> {
  if (m.kind === "crypto") return fetchCryptoUsd(m.subject);
  if (m.kind === "device") return fetchDeviceMetric(m.subject);
  return fetchWebNumber(m.subject);
}

import { execFile as cpExecFile } from "node:child_process";
import { promisify } from "node:util";
const cpRun = promisify(cpExecFile);

/** Local Mac battery percent (pmset first, ioreg fallback). */
async function readMacBatteryPct(): Promise<number | null> {
  try {
    const { stdout } = await cpRun("pmset", ["-g", "batt"], { timeout: 5000 });
    const m = stdout.match(/(\d{1,3})%/);
    if (m) return Math.max(0, Math.min(100, Number(m[1])));
  } catch { /* fall through to ioreg */ }
  try {
    const { stdout } = await cpRun("ioreg", ["-rc", "AppleSmartBattery"], { timeout: 5000 });
    const cap = stdout.match(/"Capacity"\s*=\s*(\d+)/);
    const cur = stdout.match(/"CurrentCapacity"\s*=\s*(\d+)/);
    if (cap && cur) {
      return Math.max(0, Math.min(100, Math.round((Number(cur[1]) / Number(cap[1])) * 100)));
    }
  } catch { /* give up */ }
  return null;
}

/** Local Mac used-percent of the DATA volume — on macOS the root `/` is the
 *  sealed system snapshot (~39% always), while /System/Volumes/Data is the
 *  volume System Settings reports (the one that actually "fills up"). */
async function readMacStoragePct(): Promise<number | null> {
  const paths = process.platform === "darwin" ? ["/System/Volumes/Data", "/"] : ["/"];
  for (const p of paths) {
    try {
      const { stdout } = await cpRun("df", ["-k", p], { timeout: 5000 });
      const line = stdout.split("\n").find((l) => l.trim() && !l.startsWith("Filesystem"));
      const pct = line?.match(/(\d{1,3})%/);
      if (pct) return Math.max(0, Math.min(100, Number(pct[1])));
    } catch { /* try next path */ }
  }
  return null;
}

async function fetchDeviceMetric(subject: string): Promise<number | null> {
  return subject === "battery" ? readMacBatteryPct() : readMacStoragePct();
}

/**
 * Check one monitor against its threshold. Returns a message when the threshold
 * just crossed (alerts once, re-arms when back on the safe side), else null.
 */
function evaluateAlert(m: MonitorTarget, value: number): string | null {
  if (m.threshold === undefined || !m.direction) return null;
  const isDevice = m.kind === "device";
  // Percent metrics alert ON the boundary ("batre 20% kasih tau" must fire at
  // exactly 20), while price monitors stay strict.
  const crossed = isDevice
    ? (m.direction === "above" ? value >= m.threshold : value <= m.threshold)
    : (m.direction === "above" ? value > m.threshold : value < m.threshold);
  if (!crossed) return null;
  if (m.alertedAt !== undefined) return null; // already alerted for this crossing
  if (isDevice) {
    return m.subject === "battery"
      ? `🔋 Baterai Mac sekarang ${value}% (ambang ${m.threshold}%) — saatnya cas!`
      : `💾 Storage Mac sekarang ${value}% (ambang ${m.threshold}%) — makin penuh, saatnya bersih-bersih!`;
  }
  const rel = m.direction === "above" ? "tembus di atas" : "turun di bawah";
  return `${m.name} sekarang ${fmtPrice(value)} — ${rel} ambang ${fmtPrice(m.threshold)}.`;
}

/**
 * Check every armed monitor for a user, persist last values + alert state, and
 * return any threshold-crossing alert messages (exactly-once per crossing).
 */
export async function checkMonitorsAndAlert(rawUser?: unknown): Promise<string[]> {
  const userKey = sanitizeUser(rawUser);
  const alerts: string[] = [];
  const monitors = readMonitors(rawUser);
  if (!monitors.length || !userKey) return alerts;

  for (const m of monitors) {
    const value = await fetchPrice(m);
    if (value === null) continue; // transient fetch failure — leave untouched
    m.lastValue = value;
    const alert = evaluateAlert(m, value);
    if (alert) {
      m.alertedAt = Date.now();
      alerts.push(alert);
    } else if (m.alertedAt !== undefined) {
      // Price is back to the safe side — re-arm so the next crossing alerts again.
      delete m.alertedAt;
    }
  }
  writeMonitors(monitors, userKey);
  return alerts;
}