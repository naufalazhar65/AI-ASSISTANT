/**
 * Client-side reminder helpers (browser only).
 *
 * Client-safe by construction: no node imports, so the web bundle and vitest
 * can both use it. The server owns delivery truth (lib/reminders); this file
 * only owns what the BROWSER may decide on its own:
 *
 * - Dismissing a FIRED receipt ("Udah bunyi: ...") must stick across reloads.
 *   The server replays recent fired receipts on every SSE connect (so a tab
 *   opened after a fire still shows what it missed), which means a dismissal
 *   kept only in React state resurrects on the next refresh. Persisting the
 *   dismissed receipt texts closes that loop.
 * - Dismissing a LIVE due-reminder must NOT stick: a still-due reminder is
 *   genuinely due, and replaying it on the next connect is correct (a same-id
 *   daily reschedules, so suppressing by id would silence tomorrow too).
 */

const DISMISSED_KEY = "mia-dismissed-receipts";
const MAX_DISMISSED = 50;

/** Minimal storage surface, so tests can inject a fake (browser uses localStorage). */
export interface StringStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStore(): StringStore | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * True for fired-receipt history lines the server marks with the "Udah bunyi:"
 * prefix. Live due-reminder frames never carry it — that distinction is what
 * makes dismiss-sticks safe: only history is ever suppressed, never dues.
 */
export function isFiredReceiptText(text: string): boolean {
  return text.startsWith("Udah bunyi:");
}

/** One dismissed banner: the text as shown plus when it was dismissed. */
export interface DismissedReceipt {
  text: string;
  /** Epoch ms of the dismissal; legacy string entries normalize to +Infinity. */
  at: number;
}

/** Read the persisted dismissed-receipt list; empty when storage is unavailable. */
export function loadDismissedReceipts(store?: StringStore | null): DismissedReceipt[] {
  const s = store === undefined ? browserStore() : store;
  if (!s) return [];
  try {
    const raw = s.getItem(DISMISSED_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    const out: DismissedReceipt[] = [];
    for (const x of arr) {
      if (typeof x === "string") {
        // Legacy entries (exact receipt texts, pre-twin rule): they named a
        // fired receipt verbatim, so they keep suppressing exactly that text.
        out.push({ text: x, at: Number.POSITIVE_INFINITY });
      } else if (
        x !== null &&
        typeof x === "object" &&
        typeof (x as { text?: unknown }).text === "string" &&
        typeof (x as { at?: unknown }).at === "number"
      ) {
        out.push({ text: (x as { text: string }).text, at: (x as { at: number }).at });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Remember a dismissal (any banner text, live or receipt). Idempotent for
 * identical entries, so React StrictMode double-invoking the updater that
 * calls this is harmless. Capped so the key cannot grow without bound.
 * The optional `now` exists for deterministic tests; callers omit it.
 */
export function saveDismissedReceipt(text: string, store?: StringStore | null, now: number = Date.now()): void {
  const s = store === undefined ? browserStore() : store;
  if (!s) return;
  try {
    const next = loadDismissedReceipts(s);
    if (!next.some((d) => d.text === text && d.at === now)) next.push({ text, at: now });
    s.setItem(DISMISSED_KEY, JSON.stringify(next.slice(-MAX_DISMISSED)));
  } catch {
    /* dismissal persistence is best-effort; the banner still dismisses locally */
  }
}

/**
 * Twin-suppression decision for a seeded fired-receipt frame.
 *
 * Suppresses only when the receipt CONTAINS a dismissed text AND it fired no
 * later than the dismissal — i.e. dismissing the live banner also dismisses
 * its receipt twin on the next refresh. A later firing of the same text
 * (deliveredAt > dismissal time, e.g. tomorrow's same-id daily) still shows,
 * and live due-frames are never passed through here at all.
 * An unparseable frame id falls back to exact-text match (pre-twin behavior).
 */
export function isDismissedReceipt(
  id: string | undefined,
  text: string,
  dismissed: DismissedReceipt[]
): boolean {
  if (!isFiredReceiptText(text)) return false;
  const m = /^fired-(\d+)$/.exec(id ?? "");
  const deliveredAt = m ? Number(m[1]) : NaN;
  for (const d of dismissed) {
    if (!text.includes(d.text)) continue;
    if (Number.isNaN(deliveredAt)) {
      if (text === d.text) return true;
      continue;
    }
    if (deliveredAt <= d.at) return true;
  }
  return false;
}

/** Where the reminder chime lives (served from `public/`, no auth needed). */
export const REMINDER_CHIME_SRC = "/finish.wav";

/**
 * Play the reminder chime for a newly arrived reminder. The owner asked for
 * exactly this file instead of a system TTS voice (2026-09-30): a chime never
 * mispronounces, never lags on network, and never confuses who is speaking.
 * Returns true only when playback was actually requested. NEVER throws.
 */
export function playReminderChime(
  src: string = REMINDER_CHIME_SRC,
  audioCtor?: new (src: string) => { play(): unknown }
): boolean {
  try {
    const Ctor =
      audioCtor ?? (typeof Audio !== "undefined" ? Audio : undefined);
    if (!Ctor) return false;
    const el = new Ctor(src);
    const r = el.play();
    if (r && typeof (r as Promise<void>).catch === "function") {
      (r as Promise<void>).catch(() => {
        /* autoplay policy or decode failure: the banner still shows */
      });
    }
    return true;
  } catch {
    return false;
  }
}
