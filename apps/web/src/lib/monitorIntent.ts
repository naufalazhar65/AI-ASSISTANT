/**
 * Deterministic price/crypto watchlist intent detection (Mia feature #6).
 *
 * Mirrors reminderIntent.ts: the models we use (esp. 9router and local
 * OpenCode) are inconsistent at emitting the `monitor_add` tool call — they
 * often answer verbatim, write "<tool_call> …" as prose, or return empty.
 * Instead of relying on the model, we detect the intent directly in the user
 * transcript and schedule the watchlist entry with the same `addMonitor` store
 * the `monitor_add` tool uses. This makes "monitorin harga bitcoin" always land
 * on the watchlist regardless of provider/model behavior.
 */

type MonitorIntent = {
  name: string;
  kind: "crypto" | "web" | "device";
  subject: string;
  threshold?: number;
  direction?: "above" | "below";
};

// Watchlist request verbs (Indonesian + English).
const WATCH_RE =
  /\b(monitor(in)?\s*harga|monitor(ing)?\s+watchlist|pantau(in)?\s+harga|pantau\s+(in|in?)?|monitor(ing)?\s*(harga)?\s*|watchlist\s+harga|lihatin\s+harga|ikuti\s+harga|mata-matai|kasih\s+ta(u|hu)|kasih\s+tahu|kabarin|kabari|bilangin|beritahu|informasiin|alert\s+me\s*(kalau|when|if)?)\b/i;

// Common crypto names/symbols we recognize inline (word-boundary, lowercase).
const CRYPTO_WORDS =
  /\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|ripple|cardano|ada|polkadot|dot|avalanche|avax|dogecoin|doge|chainlink|link|matic|polygon|litcoin|ltc|binance\s*coin|bnb|uniswap|uni|cosmos|atom|shiba|shib|ton|pepe|doge)\b/i;

// Threshold phrasing: "lebih dari 100000", "di atas 1000", "turun di bawah 2000",
// "di bawah $50" (also strip currency prefix like $ / Rp / IDR).
const THRESHOLD_RE = /\b(lebih(?: (?:dari|dari))?|di\s*atas|tembus|above|over|lebihlah)\s*[$]?\s*([\d.,]+)|(?:turun\s*di\s*bawah|di\s*bawah|below|under|kurang\s*dari)\s*[$]?\s*([\d.,]+)/i;

function toNumber(s: string): number | null {
  const n = Number(s.replace(/[^\d.]/g, ""));
  return n > 0 && !Number.isNaN(n) ? n : null;
}

/** Pick a short label for the watchlist entry. */
function labelFor(text: string, kind: "crypto" | "web", subject: string): string {
  if (kind === "web") {
    try {
      const u = new URL(subject);
      return u.hostname.replace(/^www\./i, "");
    } catch {
      /* fall through */
    }
    return "Produk";
  }
  const m = text.match(CRYPTO_WORDS);
  if (m) {
    const w = m[0];
    if (/bitcoin|btc/i.test(w)) return "Bitcoin";
    if (/ethereum|eth/i.test(w)) return "Ethereum";
    if (/solana|sol/i.test(w)) return "Solana";
    if (/xrp|ripple/i.test(w)) return "XRP";
    if (/cardano|ada/i.test(w)) return "Cardano";
    if (/polkadot|dot/i.test(w)) return "Polkadot";
    if (/avalanche|avax/i.test(w)) return "Avalanche";
    if (/dogecoin|doge/i.test(w)) return "Dogecoin";
    if (/chainlink|link/i.test(w)) return "Chainlink";
    if (w.length <= 4) return w.toUpperCase();
    return w[0].toUpperCase() + w.slice(1);
  }
  return subject.slice(0, 20);
}

/**
 * Detect a watchlist request in the user's text. Returns null unless a watch
 * verb AND a recognizable crypto symbol (or a product URL) both appear.
 * Threshold ("lebih dari X" → above, "di bawah X" → below) is optional.
 */
export function detectMonitorIntent(userText: string): MonitorIntent | null {
  if (!userText) return null;
  const text = userText.replace(/\s+/g, " ").trim().slice(0, 300);

  const watchMatch = text.match(WATCH_RE);
  if (!watchMatch) return null;

  // Product URL present anywhere → web price monitor.
  const urlMatch = text.match(/https?:\/\/[^\s]+/i);
  if (urlMatch) {
    const threshold = parseThreshold(text);
    return {
      name: labelFor(text, "web", urlMatch[0]),
      kind: "web",
      subject: urlMatch[0].slice(0, 500),
      ...(threshold ? { threshold: threshold.value, direction: threshold.direction } : {}),
    };
  }

  // Crypto symbol present next to the watch verb.
  const coin = text.match(CRYPTO_WORDS);
  if (coin) {
    const threshold = parseThreshold(text);
    const label = labelFor(text, "crypto", coin[0].toLowerCase());
    return {
      name: label,
      kind: "crypto",
      subject: coin[0].toLowerCase(),
      ...(threshold ? { threshold: threshold.value, direction: threshold.direction } : {}),
    };
  }

  // Local Mac health: battery threshold ("batre 20% kasih tau") and storage
  // threshold ("storage 90%" / "hampir penuh"). Percent metrics alert ON the
  // boundary, so battery defaults to below and storage to above.
  const isBattery = /\b(batre|baterai|battery)\b/i.test(text);
  const isStorage = /\b(storage|penyimpanan|disk|ruang)\b/i.test(text) || /hampir\s*penuh|udah\s*penuh|sudah\s*penuh/i.test(text);
  if (isBattery || isStorage) {
    const pct = text.match(/(\d{1,3})\s*%/);
    let threshold = pct ? Number(pct[1]) : null;
    if (isStorage && threshold === null && /penuh/i.test(text)) threshold = 90;
    if (threshold !== null && threshold >= 1 && threshold <= 100) {
      const subject = isBattery ? "battery" : "storage";
      return {
        name: isBattery ? "Baterai Mac" : "Storage Mac",
        kind: "device",
        subject,
        threshold,
        direction: isBattery ? "below" : "above",
      };
    }
  }

  return null;
}

function parseThreshold(text: string): { value: number; direction: "above" | "below" } | null {
  const m = text.match(THRESHOLD_RE);
  if (!m) return null;
  const raw = m[2] ?? m[3];
  const value = toNumber(raw ?? "");
  if (value === null) return null;
  const direction: "above" | "below" = m[2] !== undefined ? "above" : "below";
  return { value, direction };
}

/**
 * Schedule a watchlist entry from a monitor intent, returning a spoken
 * confirmation suffix (or "" when nothing matched). Guarded so it never
 * double-adds when the model already emitted `monitor_add` and the tool ran.
 */
export function hasMonitorIntent(userText: string): boolean {
  return detectMonitorIntent(userText) !== null;
}

/** Extract a crypto symbol ("bitcoin"/"btc"/"eth"/…) from free text, if any. */
export function cryptoSubject(text: string): string | null {
  const m = text.match(CRYPTO_WORDS);
  return m ? m[0].toLowerCase() : null;
}