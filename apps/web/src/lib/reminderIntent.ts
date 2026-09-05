/**
 * Deterministic parsing of "set me a reminder / wake me at" intents for the
 * OpenCode voice path. OpenCode's agent runs without the FR-014 server-side
 * tool loop that Groq/9router use, so `remind_me` was never callable there.
 * Instead of teaching OpenCode to emit tool calls, we detect the intent and a
 * target time directly in the transcript and schedule the reminder with the
 * same `addReminder` store the `remind_me` tool uses. This keeps the OpenCode
 * turn fast and safe (no tool-permission stalls) while making reminders work.
 */

const INTENT_RE = /\b(bangunin|banguni|bangunkan|bangun|ingetkan|ingatkan|ingetin|ingatkan|ingat|remind|reminder|set( an)? alarm|alarm|wake( me)? up|jangan lupa|kasih tahu|beritahu|bangun aku)\b/i;

// "setiap hari / tiap hari / every day / harian" → recurring daily reminder.
const REPEAT_RE = /\b(setiap\s*hari|tiap\s*hari|tiap[\s-]*tiap\s*hari|every\s*day|daily|harian)\b/i;

// "ganti ganti pesannya / ganti-ganti / beda-beda / variasi" → rotate the
// delivered message each day instead of repeating the same line.
const VARIETY_RE = /\b(ganti[-\s]*ganti|ganti\s*pesan(nya)?|beda[-\s]*beda|variasi|selang[-\s]*seling|ganti[- ]*ganti|jangan\s*sama)\b/i;

type ParsedTime = { hour: number; minute: number };

/**
 * Normalize a clock match ("9", "9:30", suffix pagi/siang/sore/malam/...) to a
 * 24h {hour, minute}. Returns null for invalid input (hour > 23 etc.).
 */
function normalizeClock(hourStr: string, minuteStr: string | undefined, suffix: string | undefined): ParsedTime | null {
  let hour = parseInt(hourStr, 10);
  let minute = minuteStr ? parseInt(minuteStr, 10) : 0;
  if (hour > 23 || Number.isNaN(hour)) return null;
  if (minute > 59 || Number.isNaN(minute)) minute = 0;
  const s = (suffix || "").toLowerCase().trim();

  if (s === "pm" || s === "malam" || s === "sore") {
    if (hour < 12) hour += 12;
  } else if (s === "am" && hour === 12) {
    hour = 0;
  } else if (s === "pagi") {
    if (hour >= 12) hour -= 12;
  } else if (s === "siang" && hour <= 11) {
    hour = 12;
  } else if (s === "subuh" || s === "dini hari") {
    if (hour >= 12) hour -= 12;
  }
  return { hour, minute };
}

/**
 * Extract all HH:MM-ish times from text, in order. Null when none. Supports
 * "jam 9", "9 pagi", "jam 9 pagi", "9:30", "09:30", "9am/pm".
 */
export function parseClockTimes(text: string): ParsedTime[] {
  const out: ParsedTime[] = [];
  const re = /(\d{1,2})(?:[.:](\d{2}))?\s*(am|pm|\bpagi\b|\bsiang\b|\bsore\b|\bmalam\b|\bsubuh\b|\bdini\s*hari\b)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const t = normalizeClock(m[1], m[2], m[3]);
    if (t) out.push(t);
  }
  return out;
}

/**
 * Extract the first HH:MM-ish time from text (kept for backward compat with
 * single-time callers). Returns null when no clear-clock time is found.
 */
export function parseClockTime(text: string): ParsedTime | null {
  return parseClockTimes(text)[0] ?? null;
}

/**
 * Next epoch-ms matching the given clock time (today, or tomorrow if already
 * past / within a small margin for "tomorrow morning").
 */
export function nextOccurrence(hour: number, minute: number, now = Date.now()): number {
  const d = new Date(now);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute, 0, 0);
  // If the time already passed today, push to tomorrow (early-morning wakeups).
  if (target.getTime() <= now) target.setDate(target.getDate() + 1);
  return target.getTime();
}

/** Mia-style varied morning/wake-up lines for "ganti ganti pesannya". */
const WAKE_VARIANTS = [
  "Bangun, hari baru dimulai! Semangat ya 🌸",
  "Pagi, ayo bangun! Matahari udah naik nih ☀️",
  "Beb, waktu bangun! Jangan molor terus ya 😄",
  "Bangun bangun, hari menantimu! Aku tungguin di sini 🌸",
  "Pagi-pagi, semangat! Udah waktunya bangun lho ⏰",
];

export type ReminderIntent = {
  text: string;
  atMs: number;
  /** "daily" when the user wants the reminder to repeat every day. */
  repeat?: "daily";
  /** Rotating message pool when the user wants the wording varied each time. */
  variants?: string[];
};

/**
 * Split a compound reminder request ("…jam 1 siang ingetin makan siang, dan jam
 * 8 malam ingetin makan malam…") into per-time segments. Each segment pairs one
 * clock time with the clause text that mentions it, so the scheduled reminder
 * and its subsequent push both carry "makan siang" vs "makan malam" instead of
 * the whole sentence repeated at every time.
 */
export function splitReminderRequests(userText: string): Array<{ text: string; hour: number; minute: number }> {
  const clauseRe = /\s*[,;，]|\s+\band\b|\s+dan\s+|\s+lalu\s+|\s+terus\s+/i;
  const clauses = userText.split(clauseRe);
  return clauses.flatMap((clause) => {
    const times = parseClockTimes(clause);
    if (!times.length) return [];
    const text = clause.trim();
    return times.slice(0, 1).map((t) => ({ text, ...t }));
  });
}

/**
 * Detect a reminder request and ALL its target times in one user message.
 * Returns null unless BOTH an intent keyword and at least one clock time are
 * present.
 *
 * "setiap hari" → repeat "daily" (one persistent record firing every day).
 * "ganti ganti pesannya" → a rotating `variants` pool so each day is worded
 * differently instead of repeating the user's original sentence verbatim.
 */
export function detectReminderIntents(userText: string, now = Date.now()): ReminderIntent[] | null {
  if (!userText || !INTENT_RE.test(userText)) return null;
  const repeat = REPEAT_RE.test(userText) ? ("daily" as const) : undefined;
  const variants = VARIETY_RE.test(userText) ? WAKE_VARIANTS : undefined;
  const normalized = userText.replace(/\s+/g, " ").trim().slice(0, 200);
  const segments = splitReminderRequests(normalized);
  if (!segments.length) return null;
  return segments.map((seg) => ({
    text: seg.text,
    atMs: nextOccurrence(seg.hour, seg.minute, now),
    ...(repeat ? { repeat } : {}),
    ...(variants?.length ? { variants } : {}),
  }));
}

/**
 * Detect a single reminder intent (first time only). Kept for the single-time
 * callers; compound asks ("jam 1 siang dan jam 8 malam") use the plural form.
 */
export function detectReminderIntent(userText: string, now = Date.now()): ReminderIntent | null {
  return detectReminderIntents(userText, now)?.[0] ?? null;
}
