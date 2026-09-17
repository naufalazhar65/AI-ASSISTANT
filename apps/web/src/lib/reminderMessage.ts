// Mia-style reminder push messages (Fase 3).
//
// A proactive reminder push should sound like Mia talking, not a raw
// "Reminder:" template — but it must stay fast and cheap: no LLM turn, just
// formatting (🌸, informal Indonesian tone, a 24-hour WIB clock).
//
// DESIGN: the reminder TEXT is used AS-IS. It is already a complete sentence
// (the model/users write "Mas Naufal, udah makan siang belum? Jangan skip ya 😄"),
// and wrapping it in a template produced nonsense in production:
//   "saatnya Bangun tidur Mas Naufal!"      (template + greeting)
//   "…belum? Jangan skip ya 😄, yuk."        (question + ", yuk.")
//   "Beb, Mas Naufal, udah makan siang…"     (double vocative)
// A template is only applied to a TERSE nudge ("makan", "minum air"), which has
// no sentence of its own to keep.

const BODIES = [
  "{text}",
  "{text}",
  "Beb, {text} 🌸",
  "{text} — udah waktunya nih.",
  "saatnya {text} 🌸",
  "{text}, yuk.",
];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * True when a body already closes itself (emoji, "!", "?", or a final particle
 * like "ya/yuk/dong/beb"). Pure — unit-tested.
 */
export function hasOwnCloser(body: string): boolean {
  const b = (body || "").trim();
  if (!b) return false;
  if (/[\p{S}!?]\s*$/u.test(b)) return true;
  const core = b.replace(/[\p{S}\p{P}\s]+$/u, "").trim();
  return /\b(ya|yuk|dong|nih|deh|beb|sayang)\b$/iu.test(core);
}

/** A bare noun-ish nudge ("makan", "minum air") — the only case that gets a template. */
export function isTerseReminder(text: string): boolean {
  const raw = (text || "").trim();
  if (!raw) return false;
  return raw.split(/\s+/).length <= 2 && !/[\p{S}\p{P}]/u.test(raw);
}

/**
 * Format a friendly Mia-style reminder line for a due reminder.
 * `timeLabel` is a short "HH:MM" string shown to reinforce the schedule.
 */
export function reminderMessage(text: string, timeLabel?: string): string {
  const raw = (text || "").trim();
  const time = timeLabel ? ` · pukul ${timeLabel}` : "";
  if (!raw) return time.replace(/^\s*·\s*/, "");
  let body = raw;
  if (isTerseReminder(raw)) {
    // Prefer a wording that closes itself so no extra sentence is needed.
    const closing = BODIES.map((b) => b.replace("{text}", raw)).filter((b) => hasOwnCloser(b));
    body = pick(closing.length ? closing : BODIES).replace("{text}", raw);
  }
  // The channel wrapper already prefixes "🌸 Mia — "; a second flower read as a
  // duplicate (live: "🌸 Mia — saatnya Selamat pagi … 🌸"). Keep exactly one.
  return `${body}${time}`
    .replace(/\s*🌸\s*/gu, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();
}
