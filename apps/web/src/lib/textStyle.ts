// Deterministic style smoothing for the FINAL assistant text (Fase 2 hardening).
// The persona + system prompts already forbid a comma before a direct-address
// ("call") word — but models still emit "kamu, beb" from time to time. This is
// a narrow, safe last-resort fix applied to the buffered final reply (never to
// live stream partials), so the rule holds even when the model disobeys.

const CALL_WORDS =
  "beb|mas|bang|kak|dek|say|sayang|sis|bro|mbak|pak|bu|naufal|naufalazhar|zigen";

/**
 * Remove a comma that sits immediately before a direct-address word, e.g.
 * "Selalu ada buat kamu, beb 🌸" → "Selalu ada buat kamu beb 🌸".
 * Word-boundary (`\b`) after each term means "bebas"/"masak"/"bangunkan" are
 * NOT matched. No other punctuation or structure is touched.
 */
export function fixAddressComma(text: string): string {
  if (!text) return text;
  return text.replace(new RegExp(`\\s*,\\s*(?=(${CALL_WORDS})\\b)`, "gi"), " ");
}