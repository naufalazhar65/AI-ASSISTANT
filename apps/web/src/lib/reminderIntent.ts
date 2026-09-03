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

type ParsedTime = { hour: number; minute: number };

/**
 * Extract an HH:MM-ish time from text. Returns null when no clear-clock time is
 * found. Supports "jam 9", "9 pagi", "jam 9 pagi", "9:30", "09:30", "9am/pm".
 */
export function parseClockTime(text: string): ParsedTime | null {
  // "9 pagi" / "jam 9 pagi" / "09:30" / "9:00" / "9am"
  const clockRe = /(\d{1,2})(?::(\d{2}))?\s*(am|pm|\bpagi\b|\bsiang\b|\bsore\b|\bmalam\b|\bsubuh\b|\bdini hari\b)?/i;
  const m = text.match(clockRe);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  let minute = m[2] ? parseInt(m[2], 10) : 0;
  const suffix = (m[3] || "").toLowerCase();

  if (hour > 23) return null;
  if (minute > 59) minute = 0;

  if (suffix === "pm" || suffix === "malam" || suffix === "sore") {
    if (hour < 12) hour += 12;
  } else if (suffix === "am" && hour === 12) {
    hour = 0;
  } else if (suffix === "pagi") {
    // 9 pagi → 09 (already morning); keep as-is unless it's 12+ (bad input)
    if (hour >= 12) hour -= 12;
  } else if (suffix === "siang" && hour <= 11) {
    hour = 12;
  } else if (suffix === "subuh" || suffix === "dini hari") {
    // 5 subuh → 05; 2 dini → 02
    if (hour >= 12) hour -= 12;
  }

  // No suffix: assume 12-hour default. 1–11 is probably morning unless PM hints.
  return { hour, minute };
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

export type ReminderIntent = {
  text: string;
  atMs: number;
};

/**
 * Detect a reminder request and its target time in one user message. Returns
 * null unless BOTH an intent keyword and a clock time are present.
 */
export function detectReminderIntent(userText: string, now = Date.now()): ReminderIntent | null {
  if (!userText || !INTENT_RE.test(userText)) return null;
  const time = parseClockTime(userText);
  if (!time) return null;
  const atMs = nextOccurrence(time.hour, time.minute, now);
  const message = userText.replace(/\s+/g, " ").trim().slice(0, 200);
  return { text: message, atMs };
}
