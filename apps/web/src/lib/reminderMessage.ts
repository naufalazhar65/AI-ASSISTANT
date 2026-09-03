// Mia-style reminder push messages (Fase 3).
//
// A proactive reminder push should sound like Mia talking, not a raw
// "Reminder:" template — but it must stay fast and cheap: no LLM turn, just a
// small randomized template that matches Mia's casual Indonesian persona (🌸,
// informal tone). Prompt-driven voice/tone lives in the persona; this helper
// only formats the push line.

const BODIES = [
  "waktunya {text} nih!",
  "udah waktunya {text} ya.",
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

/**
 * Format a friendly Mia-style reminder line for a due reminder.
 * `timeLabel` is a short "HH:MM" string shown to reinforce the schedule.
 */
export function reminderMessage(text: string, timeLabel?: string): string {
  const body = pick(BODIES).replace("{text}", text.trim());
  const tail = pick(TAILS);
  const time = timeLabel ? ` (pukul ${timeLabel})` : "";
  return `${body}${time}\n${tail}`;
}
