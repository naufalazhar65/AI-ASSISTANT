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

const VARIANT_PROMPT = [
  "Kamu Mia, asisten pribadi perempuan yang hangat dan playful. Tulis 5 variasi pesan ",
  "reminder pendek dalam bahasa Indonesia santai (gaya DM ke teman dekat), masing-masing ",
  "maksimal sekitar 12 kata, boleh satu emoji (🌸/😄/⏰/💧/☀️). ",
  "Balas HANYA 5 baris pesan itu — tanpa nomor, tanpa tanda kutip, tanpa penjelasan.",
].join("");

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
export async function enrichReminderVariants(
  rawUser: unknown,
  reminderText: string,
  provider: ReminderProvider
): Promise<number> {
  try {
    if (!reminderText.trim() || !provider.url || !provider.apiKey || !provider.defaultModel) return 0;
    const res = await fetch(provider.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: provider.defaultModel,
        messages: [
          { role: "system", content: VARIANT_PROMPT },
          { role: "user", content: `Reminder untuk di variasikan: "${reminderText.trim()}"` },
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
    const variants = parseVariantLines(content);
    if (variants.length < 2) return 0;
    const ok = attachVariants(rawUser, reminderText, variants);
    if (ok) console.log("[reminderVariants] attached", variants.length, "variant(s) for:", reminderText.slice(0, 60));
    return ok ? variants.length : 0;
  } catch (err) {
    console.warn("[reminderVariants] enrichment skipped:", err instanceof Error ? err.message : String(err));
    return 0;
  }
}
