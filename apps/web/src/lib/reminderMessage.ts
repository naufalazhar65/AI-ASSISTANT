// Mia-style reminder push messages (Fase 3).
//
// A proactive reminder push should sound like Mia talking, not a raw
// "Reminder:" template — but it must stay fast and cheap: no LLM turn, just a
// small randomized template that matches Mia's casual Indonesian persona (🌸,
// informal tone). Prompt-driven voice/tone lives in the persona; this helper
// only formats the push line.

const BODIES = [
  "waktunya {text} nih!",
  "udah waktunya {text}, ya.",
  "jangan lupa {text}, ya!",
  "mumpung masih inget, {text} dulu yuk.",
  "saatnya {text} 🌸",
];

const TAILS = [
  "Sip, jangan lupa ya hehe 🌸",
  "Semangat! 🌸",
  "Oke, ku pastiin kamu inget. 🌸",
  "Jangan sampek bolos ya 😄",
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** True when `text` ends with a "ya" final particle (ignoring trailing emoji/punct). */
function hasFinalYa(text: string): boolean {
  const core = text.replace(/[\p{S}\p{P}\s]+$/u, "").trim();
  return /\bya\b$/iu.test(core);
}

/** Drop a trailing "ya" before a final emoji so a template's own "…, ya!" doesn't
 *  collide with it: "Semangat ya 🌸" → "Semangat 🌸". */
function dropYa(text: string): string {
  return text.replace(/\bya\b\s*(?=\s*[\p{S}\p{P}]*$)/iu, "").replace(/[\s,]+$/u, "").trim();
}

/**
 * Format a friendly Mia-style reminder line for a due reminder.
 * `timeLabel` is a short "HH:MM" string shown to reinforce the schedule.
 */
export function reminderMessage(text: string, timeLabel?: string): string {
  let body = pick(BODIES);
  // Bodies whose own suffix carries a "ya" would read stuttery when the text
  // already ends in one ("…Semangat ya 🌸" → "…Semangat ya 🌸, ya!"), so strip it.
  const yaSuffix = /,\s*ya[.!]?\s*$|ya\.\s*$/i.test(body.replace("{text}", ""));
  const content = yaSuffix && hasFinalYa(text) ? dropYa(text) : text.trim();
  body = body.replace("{text}", content);
  const tail = pick(TAILS);
  const time = timeLabel ? ` (pukul ${timeLabel})` : "";
  return `${body}${time}\n${tail}`;
}
