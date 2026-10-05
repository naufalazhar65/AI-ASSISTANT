/**
 * Real delegation detection (Pixel Office trio, PRD §13-14).
 *
 * Pure function: given the last user ask, decide whether the turn is
 * delegated to a specialist agent (Michelle = coder, Agnes = researcher).
 * The caller (runAssistantTurn wrapper) emits `agent_delegated` +
 * `task_assigned` and runs the turn under the delegated bus context, so
 * tool events attribute to the specialist and the office avatar walks.
 * The model prompt is untouched — this is system-level attribution.
 *
 * Conservative by design: fires on explicit agent mention or strong
 * multi-step task signals only. Single-shot asks (weather, venues,
 * reminders, moods, spotify, pentest probes, greetings, confirm replies)
 * never match — those stay Mia's own turns.
 */

export type DelegatedAgent = "michelle" | "agnes";

export interface Delegation {
  agent: DelegatedAgent;
  /** Fixed workstation per agent (PRD §7). */
  station: string;
}

export const STATION_FOR: Record<DelegatedAgent, string> = {
  michelle: "pc-2",
  agnes: "pc-1",
};

/** Pentest vocabulary: delegation must never steal security-testing turns. */
const PENTEST_RE =
  /pentest|penetrasi|penetration|kerentanan|vulnerab|exploit|nmap|sqlmap|metasploit|burp|\bcve\b|payload|\bbypass\b|xss|sqli|csrf|idor|ssrf|rce|traversal|injection|hacking|nuclei|ffuf|dirb|nikto|hydra|owasp/i;

/** Explicit agent mention is handled by earliestMatch() below. */

/** Coding-task signals (multi-step, concrete target required). */
const CODING_RES = [
  // buatkan/bikin/tulis + test/fungsi/file/kode
  /(buatkan|buatin|bikin|tulis|tuliskan)\s+.{0,40}(unit\s*test|integration\s*test|test\s+(untuk|buat)|fungsi|function|file|kode|skrip|script|program)/i,
  // perbaiki/fix/debug + error/test/file/kode
  /(perbaiki|benerin|betulkan|fix|debug|debugging)\s+.{0,40}(error|eror|bug|gagal|test|testing|file|kode|fungsi|commit)/i,
  // unit/integration test untuk X
  /(unit\s*test|integration\s*test)\s+(untuk|buat)\s+\S+/i,
  // commit/baca/edit/ubah + file/kode/repo/branch
  /\b(commit|baca|bacakan|edit|ubah|refactor)\b.{0,30}\b(file|kode|repo|repository|branch|commit)/i,
];

/** Research-task signals (deep-dive markers only — plain "cari X" stays web). */
const RESEARCH_RES = [
  // bandingkan X vs/dengan Y (needs two sides)
  /bandingkan\s+\S+.*\b(vs|versus|dengan)\b\s+\S+/i,
  // rangkumkan/ringkas + topic
  /(rangkumkan|rangkum|ringkas|ringkaskan|resume)\s+\S+/i,
  // teliti/riset + topic
  /(teliti|riset|research)\s+(tentang\s+)?\S+/i,
  // cari tahu/pelajari + deep-dive marker (avoids stealing "cari X")
  /(cari\s*tahu|pelajari)\s+.+\b(mendalam|detail|lengkap|komprehensif)\b/i,
];

function earliestMatch(text: string): DelegatedAgent | null {
  const m = text.toLowerCase().match(/\b(michelle|agnes)\b/);
  if (!m) return null;
  return m[1] === "agnes" ? "agnes" : "michelle";
}

/**
 * Detect real delegation for a user ask. Returns null when the turn stays
 * Mia's own (greetings, single-shot asks, pentest, confirm replies, empty).
 */
export function detectDelegation(text: string): Delegation | null {
  const t = (text || "").trim();
  if (!t) return null;
  if (PENTEST_RE.test(t)) return null;
  const explicit = earliestMatch(t);
  if (explicit) return { agent: explicit, station: STATION_FOR[explicit] };
  for (const re of CODING_RES) {
    if (re.test(t)) return { agent: "michelle", station: STATION_FOR.michelle };
  }
  for (const re of RESEARCH_RES) {
    if (re.test(t)) return { agent: "agnes", station: STATION_FOR.agnes };
  }
  return null;
}
