/**
 * Real-world place recommendation / status intent detector.
 *
 * Mia's training data goes stale and local establishments (coffee shops,
 * restaurants, salons, etc.) can close, move, or change hours. Models
 * (especially 9router/local) often free-associate a confident list of venues
 * from memory instead of verifying — as happened with "Arah Coffee", "Kopi
 * Kalyan", "Sejiwa" in Tangerang Selatan, which were already closed.
 *
 * This detector flags messages that ask Mia to recommend an establishment or
 * report on a place's real-world status/openness, so the deterministic
 * post-turn guard can ensure she either verifies or explicitly flags the info
 * as unverified — instead of presenting a stale/guessed list as fact.
 */

// Request verbs: "rekomendasi/enaknya/dimana/mau ... di <tempat>", "mana yang",
// "cafe/resto/kopi around here", "yang buka/masih buka", "dekat/terdekat".
const RECOMMEND_RE =
  /\b(rekomendasi(?:kan)?|enaknya|dimana\s*(?:aja|ya|dong)?|yang\s+(?:paling|bagus|enak|oke|santai|sepi|seru|asik)|mau\s+pergi|mau\s+(?:ngopi|makan|minum)|ngopi\s+dimana|makan\s+dimana|tempat\s+(?:makan|ngopi|kopi|hangout|nongkrong|kerja)|cafe\s+dekat|kopi\s+dekat|terdekat)\b/i;

// Place categories that are establishments whose status changes over time.
const PLACE_CATEGORY_RE =
  /\b(kopi|cafe|café|coffee|kafe|ngopi|kopitan|makan|makanan|sarapan|makan\s+malam|tempat\s+makan|resto|restaurant|restoran|warung|bakso|sate|mie|ayam|food|salon|barber|pangkas|gym|fitness|klinik|apotek|pom|bengkel|laundry|toko|supermarket|minimarket|mall|kegiatan|hangout|nongkrong|kerja|coworking)\b/i;

// Explicit "is-X-open" / "masih ada/tutup" status checks.
const STATUS_RE =
  /\b(masih\s+(?:buka|ada\??)|sudah\s+(?:tutup|bangkrut|beroperasi)|tutup\s+belum|buka\s+jam|jam\s+berapa\s+buka|open\s+now|still\s+open|is\s+it\s+open)\b/i;

/**
 * True when the message asks Mia to recommend an establishment or report a
 * place's real-world (mutable) status.
 */
export function detectPlaceIntent(text: string): boolean {
  if (!text) return false;
  // A bare "tempat" with no category or "rekomendasi" alone isn't enough;
  // require a recommendation verb + a place category, OR an explicit status check.
  const hasStatus = STATUS_RE.test(text);
  const hasRecommend = RECOMMEND_RE.test(text) && PLACE_CATEGORY_RE.test(text);
  return hasStatus || hasRecommend;
}

/** Phrasing the model may have already used to hedge its answer. */
const ALREADY_HEDGED_RE = /cek dulu|verif|google|coba cek|bisa telat|mungkin (?:udah|sudah) (?:tutup|beda)|infoku|tidak (?:yakin|pasti)|belum tentu/i;

/**
 * Decide + build the honesty nudge for a place-recommendation/status turn.
 * Returns "" (no nudge) when the answer was verified via web_search or already
 * hedged; otherwise a short caveat so Mia never presents unverified local data
 * as confidently-current fact. Pure & deterministic — unit-testable.
 */
export function placeNudge(text: string, usedWebSearch: boolean): string {
  if (usedWebSearch) return "";
  const t = (text || "").trim();
  if (!t) return "";
  if (ALREADY_HEDGED_RE.test(t)) return "";
  return " (Catatan: ini rekomendasi dari ingatanku dan bisa telat — cek dulu di Google ya, siapa tau ada yang udah tutup atau pindah 🌸)";
}
