/**
 * Deterministic parsing of "set me a reminder / wake me at" intents for the
 * OpenCode voice path. OpenCode's agent runs without the FR-014 server-side
 * tool loop that Groq/9router use, so `remind_me` was never callable there.
 * Instead of teaching OpenCode to emit tool calls, we detect the intent and a
 * target time directly in the transcript and schedule the reminder with the
 * same `addReminder` store the `remind_me` tool uses. This keeps the OpenCode
 * turn fast and safe (no tool-permission stalls) while making reminders work.
 */

// Imperative reminder verbs only. Bare "ingat" is deliberately EXCLUDED: it's
// the recall verb ("kamu masih ingat mood aku?") not a command, and matching it
// scheduled junk reminders on innocent questions.
const INTENT_RE = /\b(bangunin|banguni|bangunkan|bangun|ingetkan|ingatkan|ingetin|remind|reminder|set( an)? alarm|alarm|wake( me)? up|jangan lupa|kasih tahu|beritahu|bangun aku)\b/i;

// "setiap hari / tiap hari / every day / harian" → recurring daily reminder.
const REPEAT_RE = /\b(setiap\s*hari|tiap\s*hari|tiap[\s-]*tiap\s*hari|every\s*day|daily|harian)\b/i;

// "ganti ganti pesannya / ganti-ganti / beda-beda / variasi" → rotate the
// delivered message each day instead of repeating the same line.
const VARIETY_RE = /\b(ganti[-\s]*ganti|ganti\s*pesan(nya)?|beda[-\s]*beda|variasi|selang[-\s]*seling|ganti[- ]*ganti|jangan\s*sama)\b/i;

// "hapus/cancel/delete/remove" → this clause is a DELETION, not a new reminder.
// "jam 7 pagi hapus aja", "cancel yang jam 8", "hapus reminder sikat gigi".
// "jangan jam 9" (negation of a clock) also cancels that slot — but "jangan
// lupa" is a reminder INTENT (keep it), so "jangan" only cancels when NOT
// followed by "lupa".
const CANCEL_RE = /\b(hapus|hapusin|hapuskan|cancel|delete|remove|buang|ilangin|nggak\s*usah|gak\s*usah|tidak\s*usah|jangan\s*(?!lupa\b)|jangan\s*(dipakai|dilanjutin)|stop)\b/i;

/** Re-point / "just" language: "jam 9 aja ya", "jadiin jam 9", "pindah jam 9",
 *  "ubahlah ke jam 9". These re-affirm an existing slot rather than adding a
 *  fresh reminder, so a matching unfired reminder must NOT be duplicated. */
const REPOINT_RE = /\b(aja|jadiin|jadikan|pindah|ubah|ganti|jadi)\b/i;

type ParsedTime = { hour: number; minute: number; suffixed?: boolean };

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
  const suffixed = !!s;

  if (s === "pm" || s === "malam" || s === "sore") {
    if (hour < 12) hour += 12;
  } else if (s === "am" && hour === 12) {
    hour = 0;
  } else if (s === "pagi") {
    if (hour >= 12) hour -= 12;
  } else if (s === "siang") {
    // Indonesian convention: 12 siang = 12:00 (noon), 1 siang = 13:00,
    // 2 siang = 14:00 … 5 siang = 17:00. But 10/11 "siang" stays morning
    // (11 AM), so only explicitly-afternoon hours (1–5) get +12.
    if (hour >= 1 && hour <= 5) hour += 12;
  } else if (s === "subuh" || s === "dini hari") {
    if (hour >= 12) hour -= 12;
  }
  return { hour, minute, suffixed };
}

/**
 * Extract all HH:MM-ish times from text, in order. Null when none. Supports
 * "jam 9", "9 pagi", "jam 9 pagi", "9:30", "09:30", "9am/pm".
 */
export function parseClockTimes(text: string): ParsedTime[] {
  const out: ParsedTime[] = [];
  // `(?<!\w)` keeps embedded digits ("kemarin2", "2005") from being clocks —
  // the "2" in "kemarin2" was the 2026-09-12 junk-reminder bug. Only a
  // standalone number after a non-word boundary parses as a time.
  const re = /(?<!\w)(\d{1,2})(?:[.:](\d{2}))?\s*(am|pm|\bpagi\b|\bsiang\b|\bsore\b|\bmalam\b|\bsubuh\b|\bdini\s*hari\b)?/gi;
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

/**
 * For a BARE clock time (no pagi/sore/malam suffix), pick the interpretation
 * closest in the future: "jam 8" said at 19:50 means 20:00 tonight (not
 * tomorrow 08:00), while "jam 8" said at 22:00 means 08:00 next morning.
 * Candidates are H:00 and (H+12):00 when valid.
 */
export function nearestOccurrence(hour: number, minute: number, now = Date.now()): number {
  let best = nextOccurrence(hour, minute, now);
  if (hour + 12 <= 23) {
    const alt = nextOccurrence(hour + 12, minute, now);
    if (alt < best) best = alt;
  }
  return best;
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
  /** True when this clause is a DELETION ("jam 7 pagi hapus aja") not a new reminder. */
  cancel?: boolean;
  /** True for re-point language ("jam 9 aja / pindah jam 9"): resolves to an
   *  existing slot at that clock instead of stacking a new reminder. */
  repoint?: boolean;
};

/**
 * Split a compound reminder request ("…jam 1 siang ingetin makan siang, dan jam
 * 8 malam ingetin makan malam…") into per-time segments. Each segment pairs one
 * clock time with the clause text that mentions it, so the scheduled reminder
 * and its subsequent push both carry "makan siang" vs "makan malam" instead of
 * the whole sentence repeated at every time.
 */
function cleanReminderText(clause: string): string {
  let s = clause
    .replace(INTENT_RE, " ")
    .replace(/jam\s*\d{1,2}(?:[.:]\d{2})?\s*(pagi|siang|sore|malam|subuh|dini\s*hari|am|pm)?/gi, " ")
    .replace(/\b\d{1,2}(?:[.:]\d{2})?\s*(pagi|siang|sore|malam|subuh|am|pm)?\b/gi, " ")
    .replace(/\b(aku|gue|saya|ya|dong|tolong|plis|please|nanti|yaa|udaa+h+|gak|nggak|menerima|mengeyel|beb|buatin|bikin|buat|mau|di|app|reminders?|mac)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  s = s.replace(/^[,\-–—\s]+|[,\-–—\s]+$/g, "").trim();
  // after strip, "sikat gigi terus tidur sekarang" -> keep; "Udaaah" alone -> fallback
  if (!s || /^[^a-z0-9]+$/i.test(s)) return "pengingat";
  return s;
}

export function splitReminderRequests(userText: string): Array<{ text: string; hour: number; minute: number; suffixed?: boolean; cancel?: boolean }> {
  const clauseRe = /\s*[,;，]|\s+\band\b|\s+dan\s+|\s+lalu\s+|\s+terus\s+/i;
  const clauses = userText.split(clauseRe);
  return clauses.flatMap((clause) => {
    const times = parseClockTimes(clause);
    if (!times.length) return [];
    const text = cleanReminderText(clause);
    const t = times[0];
    return [{ text, hour: t.hour, minute: t.minute, ...(t.suffixed ? {} : { suffixed: false }), ...(CANCEL_RE.test(clause) ? { cancel: true } : {}) }];
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
  const segments = splitReminderRequests(normalized).filter((s) => !s.cancel);
  if (!segments.length) return null;
  return segments.map((seg) => ({
    text: seg.text,
    // Suffixed times ("jam 8 malam") are unambiguous → next occurrence.
    // Bare times ("jam 8 pas") resolve to the interpretation nearest in the
    // future so an evening ask never lands on tomorrow morning.
    atMs: seg.suffixed === false
      ? nearestOccurrence(seg.hour, seg.minute, now)
      : nextOccurrence(seg.hour, seg.minute, now),
    ...(repeat ? { repeat } : {}),
    ...(variants?.length ? { variants } : {}),
    // "jam 9 aja / pindah jam 9 / jadiin jam 9" re-points an existing slot
    // instead of stacking a NEW reminder at that time.
    ...(REPOINT_RE.test(seg.text) ? { repoint: true } : {}),
  }));
}

/**
 * Detect DELETION clauses within a reminder request ("jam 7 pagi hapus aja",
 * "cancel reminder makan siang"). These are not new reminders — they reference
 * a slot/clock to delete. Returns matched clauses as {text (anchor keyword),
 * hour/minute when a clock is present}, or [].
 */
export function detectReminderCancels(userText: string): Array<{ anchor: string; hour?: number; minute?: number }> {
  if (!userText || !INTENT_RE.test(userText)) return [];
  const normalized = userText.replace(/\s+/g, " ").trim().slice(0, 200);
  return splitReminderRequests(normalized)
    .filter((s) => s.cancel)
    .map((s) => ({
      // Anchor = clause text without its clock ("yang jam 7 pagi hapus aja" →
      // "jadi yang hapus aja" after the clock is stripped → keep a safe subset
      // of words to match against reminder titles, e.g. "hapus"). We use the
      // cleaned text minus filler so delete-by-keyword has the best chance.
      anchor: s.text,
      hour: s.hour,
      minute: s.minute,
    }));
}

/**
 * Detect a single reminder intent (first time only). Kept for the single-time
 * callers; compound asks ("jam 1 siang dan jam 8 malam") use the plural form.
 */
export function detectReminderIntent(userText: string, now = Date.now()): ReminderIntent | null {
  return detectReminderIntents(userText, now)?.[0] ?? null;
}
