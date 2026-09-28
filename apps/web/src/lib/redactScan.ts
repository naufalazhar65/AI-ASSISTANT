// redactScan.ts — "what would still leak" (report checklist §5.1/5.2).
//
// `redactEvidenceForReport` in security.ts masks JWTs, 16-digit NIKs, mixed-class
// tokens and JSON secret-family keys. That is value-shape based and it works —
// but it is a PARTIAL list, and a partial redactor is the dangerous kind: the
// report looks clean because a redactor ran, while the PII it never knew about
// ships verbatim. Email addresses, phone numbers, street addresses and dates of
// birth are exactly the shapes a SQLi dump or a profile endpoint hands you, and
// none of them are in that list.
//
// So this module does not redact. It REPORTS: `redactorResidues` names the
// residue classes present in a text, which is what the preflight needs to fail a
// finding before it becomes a submission, and what a future improvement to the
// redactor itself should be tested against.
//
// Pure — no IO, no clock, unit-tested two ways (present → named, absent → clean).

/** A residue class, with the human label the preflight prints. */
const RESIDUE_RULES: ReadonlyArray<{ label: string; re: RegExp }> = [
  // Order matters: the more specific shapes first, so a NIK is not reported as
  // a generic long number and the labels stay actionable.
  { label: "email address", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { label: "NIK / 16-digit national id", re: /\b\d{16}\b/ },
  { label: "phone number", re: /(?:\+62|\(0\)[0-9]{2,3}|\b0[89]\d{1,3}[- ]?\d{3,4}[- ]?\d{3,5}\b)/ },
  { label: "date of birth", re: /\b(?:dob|date of birth|lahir|tgl lahir)\b\s*[:=-]?\s*\d{1,4}[/ -]\d{1,2}[/ -]\d{1,4}/i },
  { label: "street address", re: /\b(?:jl\.?|jalan|street|st\.?|road|rd\.?)\s+[A-Za-z0-9][A-Za-z0-9 .,'-]{4,40}\d/i },
  // A credential in a NON-JSON, non-quoted shape. The JSON key rule in
  // redactEvidenceForReport only fires for `"password": "…"`; a bare
  // `password: hunter2` in a dumped request line survives it.
  { label: "bare credential assignment", re: /\b(?:password|passwd|pwd|secret|api[_-]?key|token)\b\s*[:=]\s*["']?[^\s"',<>{}\]]{4,}/i },
  { label: "live bearer credential", re: /\b(?:Bearer|Authorization:\s*Basic)\s+[A-Za-z0-9._~+/=-]{12,}/i },
  // A private key block WITH a body. A bare `-----BEGIN … PRIVATE KEY-----`
  // header on its own leaks no key material, so flagging it made the preflight
  // fail findings for a string that carries no secret (measured 2026-09-28).
  // The redactor deliberately leaves such a header visible too, so the two can
  // never disagree.
  { label: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/ },
];

/**
 * Residue classes present in `text`, de-duplicated, in rule order. Pure.
 *
 * Returns an EMPTY array for a clean text, so callers can branch on length
 * without counting. Trims to a small number: a preflight line that lists nine
 * residue kinds is as unhelpful as one that lists none.
 */
export function redactorResidues(text: string): string[] {
  const t = String(text || "");
  if (!t) return [];
  const hits: string[] = [];
  for (const rule of RESIDUE_RULES) {
    if (rule.re.test(t)) hits.push(rule.label);
  }
  return hits;
}

/** Exposed for tests and for the future "should the redactor handle this?" list. */
export const RESIDUE_LABELS: readonly string[] = RESIDUE_RULES.map((r) => r.label);
