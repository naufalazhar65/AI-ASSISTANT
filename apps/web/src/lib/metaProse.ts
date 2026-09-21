/**
 * Meta-prose detector: catches assistant replies written in an imperative
 * "stage-direction" register instead of talking TO the user. Live 2026-09-21
 * (Discord 3:17 PM): a full-pentest ask produced "Beri tahu Mas Naufal PDF
 * sudah ada di folder laporan." — the model echoed the hint's imperative
 * voice ("TERIMA permintaannya dan jawab positif") as user-facing prose.
 * The user got a stage instruction ABOUT them, not a message TO them.
 *
 * Trigger phrases are narrow (second-person named addressee + delivery verbs
 * in the imperative) so ordinary sentences like "kabari ya" never match.
 * Pure + unit-tested (turnRouting.test.ts).
 */

const META_PATTERNS: RegExp[] = [
  /\b(?:beri\s+tahu|bilang(?:in)?|kasih\s+tahu|kabari)\s+(?:mas|pak|bang|mbak|bu|om|kak)?\s*naufal\b/i,
  /\b(?:beri\s+tahu|bilang(?:in)?|kasih\s+tahu|kabari)\s+(?:owner|user|dia|beliau)\b/i,
  /\b(?:tambahkan|catat)\s+(?:catatan|note)\s+(?:bahwa|:)/i,
  /\bsebutkan\s+(?:kepada|ke)\s+(?:mas|pak)?\s*naufal\b/i,
];

export function metaProseNote(text: string): string {
  if (!text || !text.trim()) return "";
  if (!META_PATTERNS.some((re) => re.test(text))) return "";
  return " (Beb, maaf — tadi aku salah gaya nulis. Yang jelas begini ya: laporannya sudah ada, cek folder laporanmu 🌸)";
}
