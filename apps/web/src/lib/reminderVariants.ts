// Model-authored reminder variety (Mia feature 2026-09-07).
//
// When a reminder is created, the model writes a small pool of Mia-style
// message variants ONCE (fire-and-forget, never delays the turn) and the pool
// is stored on the reminder. Push time then rotates the pool (takeDueReminders)
// instead of using the static BODIES/TAILS templates in reminderMessage.ts —
// same cheap delivery, but the wording is model-authored.
//
// Best-effort everywhere: any failure (no provider, HTTP error, bad output)
// leaves the reminder untouched and the template fallback keeps working.

import { attachVariants } from "./reminders";
import { providerHeaders } from "./providers";
import { clockLabel, wibDay, wibParts } from "./time";

const VARIANT_PROMPT = [
  "Kamu Mia, asisten pribadi perempuan yang hangat dan playful. Tulis 5 variasi pesan ",
  "reminder pendek dalam bahasa Indonesia santai (gaya DM ke teman dekat), masing-masing ",
  "maksimal sekitar 12 kata, boleh satu emoji (🌸/😄/⏰/💧/☀️). ",
  "WAJIB sesuai jam pengingat yang diberikan: jangan menebak periode waktu. Kalau pengingat ",
  "berbunyi malam, jangan tulis 'makan siang' — begitulah sebaliknya. Kalau teks reminder ",
  "sendiri menyebut periode (mis. 'sarapan'), pertahankan. ",
  "Balas HANYA 5 baris pesan itu — tanpa nomor, tanpa tanda kutip, tanpa penjelasan.",
].join("");

/** Coarse daypart for a WIB hour — the word the writer is allowed to use. */
export function periodForHour(hour: number): string {
  if (hour < 5) return "larut malam";
  if (hour < 11) return "pagi";
  if (hour < 15) return "siang";
  if (hour < 18) return "sore";
  return "malam";
}

/**
 * The clock the variant writer never used to get (live 2026-10-13): an 18:59
 * "waktunya makan" reminder came out as "makan siang dulu ya" because the pool
 * was written from the bare text with no idea what time it was. Reminder wording
 * is authored ONCE at creation and pushed later, so the writer must be told the
 * moment it fires in WIB — the same clock the chat prompts carry.
 */
export function variantClockContext(at: number = Date.now()): string {
  const { h } = wibParts(at);
  const clock = clockLabel(at);
  return (
    `Pengingat ini berbunyi pada ${wibDay(at)} pukul ${clock} WIB — periode ${periodForHour(h)}. ` +
    `Tulis variasi yang cocok dengan jam itu (jangan sebut periode yang berbeda), ` +
    `dan jangan tulis jam/tanggal di dalam pesannya — label jam ditambahkan sistem saat push.`
  );
}

export interface ReminderProvider {
  url: string;
  apiKey: string;
  defaultModel: string;
}

/** Parse the model's reply into clean variant lines (bullets/numbers stripped). */
export function parseVariantLines(content: string): string[] {
  const out: string[] = [];
  for (const raw of content.split(/\n+/)) {
    const line = raw
      .trim()
      .replace(/^(?:\d{1,2}[.)\]]|[-•*])\s*/, "")
      .replace(/^["'“”]+|["'“”]+$/g, "")
      .trim();
    if (!line || line.length > 160) continue;
    if (out.some((v) => v.toLowerCase() === line.toLowerCase())) continue;
    out.push(line);
    if (out.length >= 5) break;
  }
  return out;
}

/**
 * Ask the model for 5 reminder-wording variants and attach them to the reminder
 * that was just created with `reminderText`. Never throws; never awaited by
 * callers. Returns the number of variants stored (0 on any failure).
 */
/** Daypart words the writer may use, longest phrase first ("malam" is inside "larut malam"). */
const DAYPART_WORDS = ["larut malam", "larut", "malam", "sore", "siang", "pagi"] as const;
/** "larut" and "malam" both read as night; either one is fine at either hour. */
const NIGHT_ALIASES = ["malam", "larut malam", "larut"];
/** Sleep-topic wording is only honest at night — the exact bug seen live. */
const SLEEP_TOPIC_RE = /\b(tidur|tidurkan|bobo|reban|rebahan|istirahat|ngantuk|mengantuk|off dulu|sleep)\b/i;

/**
 * A variant whose daypart word (or sleep topic) contradicts the fire time is
 * discarded: the model ignores the clock line often enough (live 2026-10-16: a
 * 10:00 wake-up produced "waktunya siap-siap tidur dan istirahat") that a prompt
 * instruction alone is not a guarantee. Silence (no signal at all) is kept.
 */
export function daypartMismatch(variant: string, hour: number): boolean {
  const low = variant.toLowerCase();
  const wanted = periodForHour(hour);
  const night = wanted === "malam" || wanted === "larut malam";
  for (const w of DAYPART_WORDS) {
    if (!low.includes(w)) continue;
    if (w === wanted) return false;
    if (NIGHT_ALIASES.includes(w) && night) return false;
    if (NIGHT_ALIASES.includes(wanted) && NIGHT_ALIASES.includes(w)) return false;
    return true;
  }
  return !night && SLEEP_TOPIC_RE.test(variant);
}

export async function enrichReminderVariants(
  rawUser: unknown,
  reminderText: string,
  provider: ReminderProvider,
  opts: { at?: number } = {}
): Promise<number> {
  try {
    if (!reminderText.trim() || !provider.url || !provider.apiKey || !provider.defaultModel) return 0;
    // The clock the reminder will RING at, not the clock right now — otherwise a
    // morning reminder created at night gets night wording (live 2026-10-16).
    const at = opts.at ?? Date.now();
    const res = await fetch(provider.url, {
      method: "POST",
      headers: providerHeaders(provider, "mia-reminder-variants"),
      body: JSON.stringify({
        model: provider.defaultModel,
        messages: [
          { role: "system", content: VARIANT_PROMPT },
          {
            role: "user",
            content: `Reminder untuk di variasikan: "${reminderText.trim()}"\n${variantClockContext(at)}`,
          },
        ],
        stream: false,
        temperature: 0.9,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return 0;
    const json = (await res.json().catch(() => null)) as {
      choices?: { message?: { content?: string | null } }[];
    } | null;
    const content = json?.choices?.[0]?.message?.content;
    if (!content) return 0;
    const fireHour = wibParts(at).h;
    const rawLines = parseVariantLines(content);
    const variants = rawLines.filter((v) => !daypartMismatch(v, fireHour));
    if (variants.length < 2) return 0;
    const ok = attachVariants(rawUser, reminderText, variants);
    if (ok) console.log("[reminderVariants] attached", variants.length, "variant(s) for:", reminderText.slice(0, 60));
    return ok ? variants.length : 0;
  } catch (err) {
    console.warn("[reminderVariants] enrichment skipped:", err instanceof Error ? err.message : String(err));
    return 0;
  }
}
