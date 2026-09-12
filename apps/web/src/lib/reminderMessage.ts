// Mia-style reminder push messages (Fase 3).
//
// A proactive reminder push should sound like Mia talking, not a raw
// "Reminder:" template — but it must stay fast and cheap: no LLM turn, just a
// small randomized template that matches Mia's casual Indonesian persona (🌸,
// informal tone). Prompt-driven voice/tone lives in the persona; this helper
// only formats the push line.

const BODIES = [
  "eh, {text} dulu nih.",
  "udah waktunya {text}, ya.",
  "jangan lupa {text}, ya!",
  "mumpung masih inget, {text} dulu yuk.",
  "saatnya {text} 🌸",
  "prt prt, {text} udah jadwalnya nih.",
  "{text} — jangan kabur dulu.",
  "sempetin {text} dulu deh.",
  "jamnya {text} nih, gas.",
  "aku ingetin lagi: {text}, pelan-pelan aja.",
  "{text}, sekarang deh, bukan nanti sore lagi.",
];

const TAILS = [
  "jangan lupa ya hehe 🌸",
  "Semangat! 🌸",
  "Jangan sampe kelewat ya 😄",
  "aku jagain jadwalmu, tinggal jalan.",
  "oke, nanti ku kabari lagi.",
  "sip — dulu-duluan dikit, sisanya nyusul.",
  "lurus aja, aku di sini.",
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
  // A body starting "jangan lupa …" doubled up when the stored reminder text
  // already begins with the same imperative ("jangan lupa Jangan lupa makan
  // siang …"), so drop any leading repeated "jangan lupa" from the text.
  const isRemindBody = /^jangan\s*lupa/i.test(body);
  let content = (isRemindBody ? text.trim().replace(/^(?:jangan\s+lupa\s*)+/iu, "") : text.trim());
  if (yaSuffix && hasFinalYa(content)) content = dropYa(content);
  // Avoid a trailing-emoji collision when the body already ends in one
  // ("saatnya … 🌸" + text ending "🌸" → one 🌸, not two).
  const bodyTrail = body.replace("{text}", "").trimEnd();
  if (/[\p{S}]$/u.test(bodyTrail)) {
    content = content.replace(/[\p{S}\p{P}]+$/u, "").trimEnd();
  }
  body = body.replace("{text}", content);
  const tail = pick(TAILS);
  const time = timeLabel ? ` (pukul ${timeLabel})` : "";
  return `${body}${time}\n${tail}`;
}
