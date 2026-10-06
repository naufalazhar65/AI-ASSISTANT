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
 *
 * The caveat itself is voice-aware (see placeNudge): this nudge is appended
 * after the register/glyph firewall, so a hard-coded Mia-shaped string would
 * smuggle her glyph and her formal closing back into a colleague's reply.
 */

import { isAgentLabel, type AgentLabel } from "./agentRole";

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
 * Mia's own nudge.
 *
 * Rewritten 2026-10-06: the legacy wording stacked a SECOND signature glyph on a reply that already
 * carried hers, used written Indonesian ("siapa tau", should be "siapa tahu"), and handed the
 * owner a to-do list ("cek dulu di Google ya") for a casual recommendation — exactly what the
 * office style contract bans. The caveat itself is kept; only the shape changed, so Mia is
 * honest AND clean.
 */
const MIA_NUDGE =
  " (dari ingatan ya, jam bukanya bisa berubah)";

/**
 * Agnes / Michelle nudge.
 *
 * Live 2026-10-05 23:09 exposed why this needed a second shape. This nudge is
 * appended by the agent AFTER the voice firewall runs, so the SYSTEM — not the
 * model — pasted Mia's 🌸 into a colleague's answer and closed it with a formal
 * delegating clause ("cek dulu di Google ya"), both of which break that
 * colleague's hard rules (no glyph; no formal closing offer; no handing work
 * back to the owner).
 *
 * So: same honesty, spoken register. Everyday words ("dari ingatan ya", "siapa
 * tahu" not "siapa tau"), no glyph, no parenthetical formal label, and NO
 * instruction to the owner to go check it themselves — the caveat is a caveat,
 * not a to-do list.
 */
const TRIO_NUDGE = " (dari ingatan ya, jam bukanya bisa berubah)";

/**
 * Decide + build the honesty nudge for a place-recommendation/status turn.
 * Returns "" (no nudge) when the answer was verified via web_search or already
 * hedged; otherwise a short caveat so the assistant never presents unverified
 * local data as confidently-current fact. Pure & deterministic — unit-testable.
 *
 * `agent` selects the register: Mia keeps her original wording byte-for-byte;
 * the trio members get the casual variant. Fails closed to Mia's shape for an
 * unknown or missing label.
 */
export function placeNudge(text: string, usedWebSearch: boolean, agent?: AgentLabel | null): string {
  if (usedWebSearch) return "";
  const t = (text || "").trim();
  if (!t) return "";
  if (ALREADY_HEDGED_RE.test(t)) return "";
  return isAgentLabel(agent) && agent !== "mia" ? TRIO_NUDGE : MIA_NUDGE;
}
