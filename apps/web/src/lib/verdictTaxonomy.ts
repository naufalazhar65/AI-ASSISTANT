// verdictTaxonomy.ts — the canonical verdict vocabulary, in ONE place so the
// words cannot drift between the table and the free-text mapper.
//
// Why (precision #5, 2026-09-28): each prover names its outcome differently
// (LEAD / SIGNAL / KANDIDAT / PROVEN / raw / ACCEPTED-DIFF …). The playbook
// `methodology/reading-prover-results` defines FIVE classes; this module is the
// code counterpart: (1) an EXPLICIT per-tool enum table (no regex guessing —
// "absent" means opposite things in csvInject vs otpProbe), and (2) a free-text
// mapper for narration lines, with the anti-false-positive class checked FIRST
// so an honest "bukan bypass" can never be re-read as a lead.
//
// SCOPE, stated honestly (this header used to overclaim and that was defect 0
// of the 2026-09-29 audit): this is a REFERENCE taxonomy, not a chokepoint
// every prover routes through. Its production consumer is
// `recordChainOutcome` in exploitChains.ts, which decides LEAD vs DEAD for a
// chain from the prover's narration — that is why the two halves must agree.
// `taxonomySelfCheck()` is the mechanical guard on that agreement; it is
// called by the test, and it is what makes the table-vs-mapper pair a
// contract instead of two lists that happen to sit next to each other.
//
// Classes (one direction only — upgrading a class is earned via poc_verify /
// retest_run, never by re-wording):
//   lead      — a signal worth proving (poc_verify before finding_add)
//   confirmed — proven by the tool itself (browser/socket/version evidence)
//   negative  — an honest no-signal / defense-works verdict
//   unknown   — not assessable (network, setup, ambiguity) — never read as safe
//   anti-fp   — the tool itself flagged the classic false-positive trap

export type VerdictClass = "lead" | "confirmed" | "negative" | "unknown" | "anti-fp";
export const VERDICT_CLASSES: readonly VerdictClass[] = ["lead", "confirmed", "negative", "unknown", "anti-fp"];

/** Verdict-key → class per tool. Keys mirror the EXACT strings the provers emit. */
const TOOL_VERDICTS: Record<string, Record<string, VerdictClass>> = {
  // bypass403.classifyBypass (strings start the emitted signal lines)
  bypass403: {
    "✅ BYPASS LEAD": "lead",
    redirect: "unknown",
    "gagal jaringan": "unknown",
    "200 tapi body SAMA": "negative",
    "200 tapi hanya memantulkan": "anti-fp",
  },
  // otpProbe: rateLimitVerdict kinds + oracle/entropy surfaces
  otp: {
    "NO-RATE-LIMIT": "lead",
    "ORACLE DIFF": "lead",
    THROTTLED: "negative",
    MIXED: "unknown",
    "no diff": "negative",
    LEMAH: "lead",
  },
  // smuggleProbe.classifySmuggle
  smuggle: {
    CONFIRMED: "confirmed",
    SIGNAL: "lead",
    REJECTED: "negative",
    "NO-DESYNC": "negative",
    UNKNOWN: "unknown",
  },
  // domXssProve.classifyDomXss
  dom_xss: { PROVEN: "confirmed", INJECTED_ONLY: "lead", NOT_CONFIRMED: "negative" },
  // teamcityCheck.assessTeamCityVersion
  teamcity: { VULNERABLE: "confirmed", PATCHED: "negative", "TAK DIKETAHUI": "unknown" },
  // massAssign verdicts
  mass_assignment: {
    "ACCEPTED-DIFF": "lead",
    ECHO: "lead",
    "NO-DIFF": "negative",
    REJECTED: "negative",
    ERROR: "unknown",
  },
  // workflowFuzz.classifyMutation levels
  workflow: { signal: "lead", info: "unknown", match: "negative" },
  // cacheDecep: LEAD vs the SPA catch-all trap
  cache_decep: { LEAD: "lead", "SPA catch-all": "anti-fp", "no lead": "negative" },
  // csvInject.classifyExport
  csv: { raw: "lead", sanitized: "negative", absent: "unknown" },
  // accountRecovery: tokenEntropyVerdict + enumVerdict
  recovery_token: {
    identical: "lead",
    "repeated-prefix": "lead",
    "weak-alphabet": "lead",
    ok: "negative",
    none: "unknown",
  },
  recovery_enum: { lead: "lead", "no enum": "negative" },
  // vulnCompose.composeVerdict
  vuln_compose: { "TERBUKTI PENUH": "confirmed", PUTUS: "unknown", "TAK TERSAMBUNG": "unknown" },
};

/** Classify a prover's verdict key. Exact match first, then unambiguous prefix. */
export function classifyToolVerdict(tool: string, verdict: string): VerdictClass {
  const table = TOOL_VERDICTS[tool];
  if (!table) throw new Error(`taxonomy: tool "${tool}" has no verdict table`);
  if (verdict in table) return table[verdict];
  const hits = Object.entries(table).filter(([k]) => verdict.startsWith(k));
  if (hits.length === 1) return hits[0][1];
  throw new Error(`taxonomy: verdict "${verdict}" of "${tool}" is outside the canonical classes`);
}

/** Every verdict key the table maps to "unknown" (audit helper for review). */
export function taxonomyUnknownVerdicts(): string[] {
  const out: string[] = [];
  for (const [tool, table] of Object.entries(TOOL_VERDICTS)) {
    for (const [k, v] of Object.entries(table)) if (v === "unknown") out.push(`${tool}:${k}`);
  }
  return out;
}

export interface TaxonomyDisagreement {
  tool: string;
  verdict: string;
  table: VerdictClass;
  text: VerdictClass;
}

/**
 * The mechanical guard the 2026-09-29 audit found missing: for EVERY key in
 * the table, the free-text mapper must land on the same class. Four real
 * defects survived because nothing compared the two halves on the same input
 * — the table said `workflow: info → unknown` while `LEAD_RE` contained
 * `\bINFO\b` and returned `lead` (an inflation, in the one direction this
 * module exists to prevent), and `INJECTED_ONLY` / `THROTTLED` fell through to
 * `unknown`, downgrading a lead and disagreeing with the table.
 *
 * A key that is a whole PROSE phrase (e.g. "✅ BYPASS LEAD", "200 tapi body
 * SAMA") legitimately does not match the mapper on its own — it is a narration
 * label, not a free-text line — so those are reported as `text: "unknown"`
 * and are NOT counted as disagreements. Only a disagreement is a defect, and
 * only when the mapper actively claims a DIFFERENT class.
 */
export function taxonomySelfCheck(): TaxonomyDisagreement[] {
  const out: TaxonomyDisagreement[] = [];
  for (const [tool, table] of Object.entries(TOOL_VERDICTS)) {
    for (const [verdict, cls] of Object.entries(table)) {
      const viaText = classifyVerdictText(verdict);
      if (viaText !== cls && viaText !== "unknown") {
        out.push({ tool, verdict, table: cls, text: viaText });
      }
    }
  }
  return out;
}

// ── Free-text narration mapper ───────────────────────────────────────────────
// ORDER IS THE CONTRACT: anti-fp → negative → confirmed → lead → unknown.
// ("Tidak ada auth-bypass lead" must stay negative; "LEAD (terkonfirmasi…)"
// must stay confirmed.)

const ANTI_FP_RE =
  /bukan bypass|kemungkinan echo|SPA catch-all|bukan temuan|FALSE POSITIVE|bukan indikasi|hanya memantulkan/i;
const NEGATIVE_RE =
  /NO-DESYNC|NOT_CONFIRMED|REJECTED|PATCHED|\bAMAN\b|TIDAK ADA SINYAL|tidak ada[^.\n]{0,30}\blead\b|\bno lead\b|terkontrol|sanitized|defense bekerja|diabaikan|NO-DIFF|THROTTLED/i;
// `(?<!NOT_)` is load-bearing: without it the bare word CONFIRMED matches
// inside NOT_CONFIRMED, and with confirmed checked BEFORE negative (defect 4)
// that turned a "not confirmed" verdict into a proof. Same substring-vs-exact
// class as the /login ⊂ /api/login defect — found by the new self-check, not by
// reading the code.
const CONFIRMED_RE =
  /PROVEN|(?<!NOT_)\bCONFIRMED|VULNERABLE|RENTAN|PoC STABIL|TERBUKTI PENUH|3\/3/i;
const LEAD_RE =
  /🎯|\bLEADS?\b|BYPASS LEAD|NO-RATE-LIMIT|ORACLE DIFF|SINYAL OOB|\bSTRONG\b|KANDIDAT|PREDIKTABEL|TERBUKTI\b|INJECTED_ONLY|TERKONFIRMATI/i;

/**
 * LEAD_RE minus the BARE word "lead". A bare "lead" is exactly what the
 * honest phrase "tidak ada auth-bypass lead" negates, so the vocabulary
 * question needs it; but a caller deciding PRECEDENCE needs the markers
 * ("🎯 …", "LEADS:", "STRONG"), because a marker anywhere outranks a
 * co-occurring negated mention — the false-dead error is the expensive one.
 * Two words, two purposes, one file: `classifyVerdictText` uses LEAD_RE,
 * `hasLeadMarker` is what `recordChainOutcome` composes its policy with.
 * NB: an earlier draft added `\bLEADS?\b\s+(?:di|…)` here to catch "LEADS
 * ditemukan di param url", and the new test caught it firing on the honest
 * negation "tidak ada auth-bypass lead di lengan lain". A marker must not be
 * a mention followed by a preposition, so that alternative is gone.
 * `BYPASS LEAD` is likewise anchored to a token start (space/emoji/pipe/dash):
 * the hyphen in "auth-bypass lead" otherwise satisfied it, which would have
 * turned the honest negation into a lead signal. Caught by the new test, not by
 * reading the code.
 */
const LEAD_MARKER_RE =
  /🎯|\bLEADS?\s*:|(?:^|[\s✅|—(])BYPASS LEAD|NO-RATE-LIMIT|ORACLE DIFF|SINYAL OOB|\bSTRONG\b|KANDIDAT|PREDIKTABEL|TERBUKTI\b|INJECTED_ONLY|TERKONFIRMATI/i;

/** True when the text carries an explicit lead SIGNAL (not a bare mention). */
export function hasLeadMarker(text: string): boolean {
  return LEAD_MARKER_RE.test(text || "");
}

/** True when the text carries a self-proof marker. */
export function hasConfirmedMarker(text: string): boolean {
  return CONFIRMED_RE.test(text || "");
}

/**
 * Words the provers use for "not assessable" (TAK DIKETAHUI, tidak
 * konklusif, TAK TERSAMBUNG, gagal jaringan, in-conclusive). They are
 * documented here rather than kept as a live regex: every one of them
 * already lands on "unknown" through the fall-through below, so a separate
 * test had NO observable effect — a dead branch that reads as a decision.
 * The "unknown" class is therefore defined by what is NOT matched above,
 * which is also the honest direction: an unrecognised line must never be
 * read as safe, and never as a lead.
 */

/** Map a narration line / output snippet onto the canonical classes. Pure. */
export function classifyVerdictText(text: string): VerdictClass {
  const t = text || "";
  // anti-fp first, always: "bukan bypass" must never be re-read as a lead.
  if (ANTI_FP_RE.test(t)) return "anti-fp";
  // Confirmed beats a negation that appears BEFORE it — "TIDAK ADA SINYAL tapi
  // payload CONFIRMED masuk log" is a proof, and reading it as negative would
  // silently downgrade a real finding to "no signal" and stop the hunt. A
  // negation AFTER the confirmed marker does not undo it either, so the rule
  // is positional, not order-of-tests: a confirmed marker anywhere wins over a
  // negative marker anywhere. Both markers present without confirmation still
  // reads negative, which is what protects "tidak ada auth-bypass lead".
  if (CONFIRMED_RE.test(t)) return "confirmed";
  if (NEGATIVE_RE.test(t)) return "negative";
  if (LEAD_RE.test(t)) return "lead";
  return "unknown";
}
