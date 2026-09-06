// Price/Search request verbs (Indonesian + English).
export const PRICE_RE = /\b(harga|berapa\s+harga|cek\s+harga|price\s+of|check\s+price)\b/i;

export interface PriceIntent {
  subject: string;
}

/**
 * Watch out: "monitorin harga bitcoin" / "pantau harga solana" is a WATCH
 * request, not a price query — detected here and excluded (the monitor path
 * owns it). Clause continuations ("... harga solana aja, kasih tau kalau di
 * atas 150") and polite fillers are cut off so the subject stays clean.
 */
export function detectPriceIntent(text: string): PriceIntent | null {
  if (/\b(?:monitor(?:in|ing|kan)?|pantau|awasi|ikuti|cek\s+berkala)\b/i.test(text)) return null; // watch request, not a price query
  if (!PRICE_RE.test(text)) return null;

  const match = text.match(PRICE_RE);
  if (!match) return null;

  let subject = text
    .slice(match.index! + match[0].length)
    .trim()
    .replace(/\b(?:sekarang|saat\s+ini|hari\s+ini|berapa|harganya|dong|ya|beb|mas|bang|kak|sih|a)\b.*$/i, "")
    .replace(/\b(?:aja|kalau|jika|kalo|dan|lalu|terus|untuk)\b.*$/i, "")
    .replace(/[?。.!,;:)]+$/g, "")
    .replace(/^[\s\-:"]+|[\s\-:"]+$/g, "")
    .trim();

  if (!subject) return null;
  return { subject };
}
