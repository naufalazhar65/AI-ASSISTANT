/**
 * Audit of claims the model makes ABOUT a SET OF FINDINGS against the store.
 *
 * Origin — two defects from the live 2026-09-28 17:12 Discord turn (owner lab
 * `6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app`, report
 * `report-2026-09-28T10-12-48-255Z.pdf`), both in one sentence:
 *
 *   "Laporannya sudah lengkap dengan 8 temuan krusial yang aku temukan…"
 *
 *   (B) SEVERITY INFLATION — the store holds 3 critical / 3 high / 2 medium,
 *       so "8 krusial" overstates five of them. The store already knows the
 *       real breakdown; nothing checked the prose against it.
 *   (C) DISCOVERY AUTHORSHIP — the turn recorded ZERO findings (audit rows
 *       10:09:25-10:12:48 contain no `finding_add` at all), so "yang aku
 *       temukan" presents a pre-existing set as this turn's work.
 *
 * Both facets are ONE rule over one shape: a clause that talks about findings
 * (a count, or an attributed set) and then says something about their severity
 * or their origin. The trigger is vocabulary-as-data; the VERDICT is a fact
 * lookup. That split is the house pattern — vocabulary decides whether to
 * look, facts decide whether to accuse — and it is why this module has a
 * generative meta-test instead of a pile of one-off patterns.
 *
 * Deliberately NOT accused, because it is TRUE and common: a present-tense
 * "tadi aku nemu bug SQLi" about a probe the turn actually ran (live 16:25 —
 * the model POSTed a real payload and recorded the finding). Discovery in the
 * present tense is honest work; only a claim about a SET this turn did not
 * record is the defect.
 *
 * Facts in, note out. Pure — no store reads, no I/O, no cycle: the caller
 * builds the snapshot and passes it down, and the structural `TurnMsg` type
 * below keeps this module free of an import back into `agent.ts`.
 */

/* ------------------------------------------------------------------ *
 * Severity vocabulary — the word CLAIMS a bucket, the store decides.
 * ------------------------------------------------------------------ */

/** Canonical buckets, most severe first. Order is the escalation order. */
import { severityFromCvss } from "./security";

export const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"] as const;

export type SeverityBucket = (typeof SEVERITY_ORDER)[number];

/**
 * Word -> bucket. Indonesian and English together, because the deliverables
 * are English-first while the chat is Indonesian and the model mixes them
 * freely (a single live reply used "8 temuan krusial" and "SQL Injection").
 *
 * `berat` / `parah` are intentionally ABSENT: they are feelings, not severity
 * labels, and the store has no number to refute them with. Masking them would
 * make the guard accuse about a word it cannot verify.
 */
export const SEVERITY_CLAIM_WORDS: Readonly<Record<string, SeverityBucket>> = {
  kritis: "critical",
  krusial: "critical",
  critical: "critical",
  tinggi: "high",
  high: "high",
  sedang: "medium",
  medium: "medium",
  moderate: "medium",
  rendah: "low",
  low: "low",
  informasi: "info",
  info: "info",
};

/** Escapes a vocabulary key for use inside a RegExp source. */
function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SEVERITY_ALT = Object.keys(SEVERITY_CLAIM_WORDS)
  .sort((a, b) => b.length - a.length)
  .map(esc)
  .join("|");

/** Any word that CLAIMS a severity. Built from the table so it cannot drift. */
export const SEVERITY_CLAIM_RE = new RegExp(`\\b(${SEVERITY_ALT})\\b`, "gi");

/** The object of the claim: a finding set in either language. */
const FINDING_NOUN =
  "temuan|findings?|celah(?:an)?|vulnerabilit(?:y|ies)|kerentanan|bugs?";

/** A discovery verb, i.e. "I found it" rather than "I recorded it". */
/**
 * ACTIVE first-person discovery only.
 *
 * The live 2026-09-28 drill (18:0x) fired this facet on a 2045-char reply that
 * contained no authorship claim at all, because the old vocabulary counted
 * `nemu|ketemu|found|discover` and then allowed the pronoun, the verb and the
 * finding noun to sit anywhere in a clause with 20/40-char windows. In a long
 * reply full of "aku" and "temuan" that matches almost inevitably, and the
 * note then told the user their own accurate summary was not their discovery.
 *
 * So the trigger is now ONE tight shape — a first-person subject in front of an
 * ACTIVE discovery verb — and the passive/stative forms are excluded on purpose:
 * "temuan yang sudah ditemukan" is a statement about findings, not a claim of
 * authorship, and accusing it is the worse error direction.
 */
const DISCOVERY_ACTIVE = "(?:menemukan|temukan|mendeteksi|menyingkirkan)";

/** "N <findings>" — the count that makes a set claim checkable. */
const COUNT_BEFORE = new RegExp(`\\b(\\d{1,3})\\s+(?:${FINDING_NOUN})\\b`, "i");
const COUNT_AFTER = new RegExp(`\\b(?:${FINDING_NOUN})\\b[^.?!\\n]{0,12}?\\b(\\d{1,3})\\b`, "i");

/**
 * A fuzzy number cannot be refuted: "sekitar 8" against a store of 3 is not
 * a lie about severity, it is imprecision. Presence of one of these silences
 * the whole severity facet for that clause.
 */
// A hedged count cannot refute anything, so it silences the facet. The word
// alternatives need `\b`; the SYMBOL alternatives must NOT have it — `±` is not
// a word character, so one `\b(?:\d\s*\+|±)\b` group never matched at the start
// of a clause and "± 8 temuan kritis" accused anyway. Split, so each
// alternative is anchored correctly for its own kind of token.
const FUZZY_COUNT_RE =
  /\b(?:sekitar|kira-?kira|approx(?:imately)?|around|about|lebih\s+dari)\b|[>≥]\s*\d|\d\s*\+|±/i;

/**
 * A clause that names a DIFFERENT target is out of scope: the store snapshot
 * is host-scoped, so a claim about another host cannot be refuted by it.
 */
const FOREIGN_TARGET_RE = /https?:\/\/|\b[a-z0-9-]+\.(?:netlify\.app|vercel\.app|trycloudflare\.com|com|net|org|io|app|dev)\b/i;

/* ------------------------------------------------------------------ *
 * The fact snapshot
 * ------------------------------------------------------------------ */

export type FindingClaimFacts = {
  /** Open findings in the store, scoped to the host(s) this turn touched. */
  total: number;
  /** How many of those are in each severity bucket. */
  bySeverity: Readonly<Record<string, number>>;
  /** A `finding_add` SUCCEEDED in this turn (so some of the set may be new). */
  recordedThisTurn: boolean;
  /**
   * At least one row's stored severity disagrees with the band its own CVSS
   * score implies, so the store contradicts itself.
   *
   * Measured 2026-09-28: the owner host carries "Stored XSS in /api/pengaduan"
   * at `cvss 7.1` with `severity: medium`, while `resolveFindingSeverity`
   * (a supplied score wins) bands 7.1 as HIGH. Re-adding that exact row through
   * `addFinding` produced high, so a fresh copy of the same findings counts
   * 3C/4H/1M where the stored rows count 3C/3H/2M. A store that disagrees with
   * itself cannot refute anybody's prose, so the severity facet goes SILENT
   * rather than accuse a report summary that is faithful to what is on disk.
   */
  selfInconsistent: boolean;
};

/** An empty snapshot: the store could not be read. */
export function emptyFindingClaimFacts(): FindingClaimFacts {
  return { total: 0, bySeverity: {}, recordedThisTurn: false, selfInconsistent: false };
}

/** Builds a snapshot from the store rows the caller already read. */
export function findingClaimFacts(
  rows: ReadonlyArray<{ severity: string; target: string; status: string; cvss?: number | null }>,
  opts: { recordedThisTurn: boolean }
): FindingClaimFacts {
  const bySeverity: Record<string, number> = {};
  let total = 0;
  let selfInconsistent = false;
  for (const r of rows) {
    if (r.status === "resolved") continue;
    total += 1;
    const bucket = (r.severity || "").trim().toLowerCase();
    if (bucket) bySeverity[bucket] = (bySeverity[bucket] ?? 0) + 1;
    // The band is owned by `security.ts` — never a second copy of the table.
    if (
      typeof r.cvss === "number" &&
      r.cvss >= 0 &&
      r.cvss <= 10 &&
      bucket &&
      severityFromCvss(r.cvss) !== bucket
    ) {
      selfInconsistent = true;
    }
  }
  return { total, bySeverity, recordedThisTurn: opts.recordedThisTurn, selfInconsistent };
}

/* ------------------------------------------------------------------ *
 * Shared clause machinery
 * ------------------------------------------------------------------ */

/** Splits prose into clauses, keeping the terminator kind out of the body. */
function clauses(text: string): string[] {
  return (text || "")
    .split(/(?<=[.!?\n])/)
    .map((c) => c.trim())
    .filter(Boolean);
}

/** The nearest integer at or before `at`, refusing digits glued to . or x. */
function nearestNumberBefore(clause: string, at: number): number | null {
  const before = clause.slice(Math.max(0, at - 40), at);
  const m = before.match(/(\d{1,3})(?![\dx.])/g);
  if (!m || !m.length) return null;
  const last = m[m.length - 1];
  // A version, a CVSS decimal, or a multiplier is not a finding count.
  if (/\d\s*x$/i.test(before.slice(-(last.length + 1)))) return null;
  const n = Number(last);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The nearest integer at or after `at`, same rules. */
function nearestNumberAfter(clause: string, at: number): number | null {
  const after = clause.slice(at).match(/^[^\d]{0,12}?(\d{1,3})(?![\dx.])/);
  if (!after) return null;
  const n = Number(after[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** One checkable claim found in a clause. */
type SeverityClaim = { claimed: number; bucket: SeverityBucket; clause: string };

/**
 * Every "N <severity>" claim in the clause.
 *
 * A number must sit NEAR the severity word: "8 temuan krusial" is a claim
 * about 8 findings, while "laporan dengan severity tinggi, 3 temuan" is not a
 * claim that 3 findings are high — it is a label followed by a count. Only
 * the near form is judged, so the guard cannot manufacture a contradiction
 * out of two facts that merely share a sentence.
 */
function severityClaimsIn(clause: string): SeverityClaim[] {
  const out: SeverityClaim[] = [];
  SEVERITY_CLAIM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SEVERITY_CLAIM_RE.exec(clause)) !== null) {
    const word = m[1].toLowerCase();
    const bucket = SEVERITY_CLAIM_WORDS[word];
    if (!bucket) continue;
    const start = m.index;
    const claimed = nearestNumberBefore(clause, start) ?? nearestNumberAfter(clause, start + m[0].length);
    if (claimed === null) continue;
    out.push({ claimed, bucket, clause });
  }
  return out;
}

/** A readable "3 critical, 3 high, 2 medium" from the store. */
export function describeBreakdown(facts: FindingClaimFacts): string {
  const parts = SEVERITY_ORDER.filter((b) => (facts.bySeverity[b] ?? 0) > 0).map(
    (b) => `${facts.bySeverity[b]} ${b}`
  );
  return parts.join(", ") || "tidak ada";
}

/* ------------------------------------------------------------------ *
 * Facet B — severity inflation
 * ------------------------------------------------------------------ */

/**
 * A claim that overstates how severe the recorded findings are.
 *
 * Fires only when the store CAN refute it: a host-scoped snapshot with at
 * least one open finding, a clause with a near count, no fuzzy number, no
 * other target named, and the store holding FEWER findings in that bucket
 * than the prose claims. Understatement is never accused — inflating a
 * severity is what misleads a triager, and a self-deprecating count is not
 * the defect this was written for.
 */
export function severityInflationNote(text: string, facts: FindingClaimFacts): string {
  const t = (text || "").trim();
  if (!t) return "";
  if (!facts.total) return ""; // no store facts -> cannot refute anything
  if (facts.recordedThisTurn) {
    // The turn wrote at least one finding, so a set description legitimately
    // includes work we cannot see yet. The store snapshot is not authoritative
    // for a set the turn is still growing.
    return "";
  }
  if (facts.selfInconsistent) {
    // The store contradicts itself (a stored severity that disagrees with the
    // band its own CVSS implies — measured on the owner host's "Stored XSS …
    // cvss 7.1 / severity medium"). A self-contradicting store cannot refute
    // anybody: the report header counts the STORED severities, so a summary
    // that is faithful to the report is exactly the prose we would accuse.
    return "";
  }
  const offenders: SeverityClaim[] = [];
  for (const c of clauses(t)) {
    if (FUZZY_COUNT_RE.test(c)) continue;
    if (FOREIGN_TARGET_RE.test(c)) continue;
    for (const claim of severityClaimsIn(c)) {
      const actual = facts.bySeverity[claim.bucket] ?? 0;
      if (claim.claimed > actual) offenders.push(claim);
    }
  }
  if (!offenders.length) return "";
  const worst = offenders.reduce((a, b) => (a.claimed > b.claimed ? a : b));
  const actual = facts.bySeverity[worst.bucket] ?? 0;
  const bucketId = worst.bucket === "critical" ? "kritis" : worst.bucket;
  return (
    ` (Catatan jujur: dari ${facts.total} temuan yang tercatat, hanya ${actual} yang ${bucketId}` +
    ` — bukan ${worst.claimed}. Rinciannya: ${describeBreakdown(facts)}.` +
    ` Jadi severity "${worst.claimed} ${bucketId}" itu dilebihkan.)`
  );
}

/* ------------------------------------------------------------------ *
 * Facet C — discovery authorship
 * ------------------------------------------------------------------ */

/** "yang aku temukan" / "temuan yang saya temukan" / "findings I found". */
const ATTRIBUTED_DISCOVERY_RE = new RegExp(
  // "temuan yang AKU temukan" / "temuan itu SAYA yang menemukan" — the noun
  // first, then the pronoun, then the active verb.
  `\\b(?:${FINDING_NOUN})\\b[^.?!\\n]{0,24}?\\b(?:aku|saya|gua|gw)\\b\\s+(?:sudah\\s+|baru\\s+|baru saja\\s+|telah\\s+|berhasil\\s+|cukup\\s+|langsung\\s+|kemudian\\s+)?\\b${DISCOVERY_ACTIVE}\\b` +
    // "AKU menemukan 8 temuan" — the subject first, verb, then the count/noun.
    `|\\b(?:aku|saya|gua|gw)\\b\\s+(?:sudah\\s+|baru\\s+|baru saja\\s+|telah\\s+|berhasil\\s+|cukup\\s+|langsung\\s+|kemudian\\s+)?\\b${DISCOVERY_ACTIVE}\\b[^.?!\\n]{0,40}?\\b(?:${FINDING_NOUN})\\b`,
  "i"
);

/** An honest admission in the CLAIM clause silences the accusation. */
const ATTRIBUTION_ADMISSION_RE =
  /\b(?:sebelum(?:nya)?|tercatat|tersimpan|udah|pernah|ditambahkan|ditemukan\s+(?:sebelum|terakhir)|again|already)\b/i;

/**
 * A claim that presents a finding set as THIS turn's discovery when the turn
 * recorded nothing.
 *
 * The correction is a caveat, not an accusation: the findings are real and the
 * model may well have re-verified them this turn, which is honest work. What
 * is wrong is only the authorship — the user reads "yang aku temukan" as work
 * that just happened, and it did not.
 */
export function discoveryAuthorshipNote(text: string, facts: FindingClaimFacts): string {
  const t = (text || "").trim();
  if (!t) return "";
  if (!facts.total) return "";
  if (facts.recordedThisTurn) return "";
  for (const c of clauses(t)) {
    if (!ATTRIBUTED_DISCOVERY_RE.test(c)) continue;
    if (ATTRIBUTION_ADMISSION_RE.test(c)) continue;
    return (
      ` (Catatan jujur: ${facts.total} temuan di laporan itu SUDAH tercatat di giliran sebelumnya` +
      ` — giliran ini tidak mencatat temuan baru, jadi itu bukan hasil penemuan giliran ini;` +
      ` yang di giliran ini adalah pembacaan ulang + laporan ulang.)`
    );
  }
  return "";
}

/* ------------------------------------------------------------------ *
 * One owner for the "did this turn record anything" fact
 * ------------------------------------------------------------------ */

/**
 * Structural message shape. Declared here instead of importing `ChatMessage`
 * so this module stays free of a cycle back into `agent.ts`; `ChatMessage[]`
 * is assignable to `TurnMsg[]` because every field below is optional.
 */
export type TurnMsg = {
  role?: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: ReadonlyArray<{ id?: string; function?: { name?: string } }>;
};

function toolResultText(m: TurnMsg): string {
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : ""))
      .join(" ");
  }
  return "";
}

/**
 * Did a `finding_add` SUCCEED in this turn?
 *
 * "Succeeded" means the result is not an `Error:` — a `finding_add` that
 * returned "Error: judul temuan wajib" saved NOTHING, which is the live shape
 * that made the 22:52 fixture fire. Kept here, once, so the two notes above
 * and the pre-existing `unrecordedFindingClaimNote` cannot disagree about the
 * same fact.
 *
 * The fail-open applies to a MISSING RESULT, not to a missing call. A call with
 * no visible result was summarized away, so we do not know: report `true` and
 * stay silent. A turn with NO `finding_add` call at all, on the other hand, is
 * positive evidence that nothing was recorded — the live 17:12 turn had none,
 * and an earlier version returned `true` here, which silently disabled both
 * facets on exactly the turn they were written for.
 */
export function recordedFindingThisTurn(messages: ReadonlyArray<TurnMsg>): boolean {
  const results = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_id) results.set(m.tool_call_id, toolResultText(m));
  }
  for (const m of messages) {
    if (m.role !== "assistant" || !m.tool_calls) continue;
    for (const tc of m.tool_calls) {
      if (tc.function?.name !== "finding_add" || !tc.id) continue;
      const res = results.get(tc.id);
      if (res === undefined) return true; // summarized away -> we do not know
      if (!/^\s*error\b/i.test(res.trim())) return true;
    }
  }
  return false;
}
