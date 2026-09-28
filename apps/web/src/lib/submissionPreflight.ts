// submissionPreflight.ts — the owner's pre-submission checklist (report
// checklist §11) as CODE instead of a habit. Pure, so it is unit-testable and
// so the answer cannot drift with the model's mood.
//
// Design rule that shapes everything here: a preflight that only says "looks
// fine" is worse than none, because it is read as a sign-off. Every item
// therefore reports one of
//   FAIL — will get triaged out (missing Expected/Actual, no proof, English
//          violation, overclaimed impact, secret in the evidence)
//   WARN — a reviewer may push back (generic remediation, no references,
//          severity not derived from a vector, IDOR rated on breadth untested)
//   PASS — nothing to raise from what is stored
// and every non-PASS line quotes the concrete field it is talking about, so the
// fix is obvious without re-reading the finding.

import type { Finding } from "./security";
import { vulnClass, isGenericRemediation, expectedActualFor, remediationFor, cvssVersionFor, dupTitleKey, xssProofAdvisory } from "./findingPolicy";
import { overclaimVerdict } from "./impactOverclaim";
import { redactorResidues } from "./redactScan";
import { pathOfUrl, hostOfUrl } from "./urlMatch";

export type PreflightLevel = "FAIL" | "WARN" | "PASS";

export type PreflightItem = {
  /** Stable id so a test (and the model) can cite the item. */
  id: string;
  level: PreflightLevel;
  text: string;
};

export type PreflightResult = {
  findingId: string;
  title: string;
  target: string;
  /** The single worst level across all items — what the summary line shows. */
  worst: PreflightLevel;
  items: PreflightItem[];
};

/** Order matters only for readability; the worst level drives the verdict. */
const LEVEL_ORDER: Record<PreflightLevel, number> = { PASS: 0, WARN: 1, FAIL: 2 };

function worstLevel(items: PreflightItem[]): PreflightLevel {
  return items.reduce<PreflightLevel>((acc, i) => (LEVEL_ORDER[i.level] > LEVEL_ORDER[acc] ? i.level : acc), "PASS");
}

/** Does the finding claim to be a draft / unverified? */
function isDraftish(f: Finding): boolean {
  return /belum diverifikasi|draft|\bTODO\b|\bTBD\b/i.test(`${f.title} ${f.evidence}`);
}

/**
 * The LOWEST score a severity may claim (checklist 3.x: a rating must be
 * defensible). The inverse direction is the one that matters — "critical" with
 * a 5.3 is the inflation a triager disputes, while a 9.8 filed as "high" is
 * only ever self-penalising.
 */
const BAND_MIN: Record<string, number> = { critical: 9, high: 7, medium: 4, low: 0.1, info: 0 };

/**
 * Run the whole checklist against one finding. Pure.
 *
 * `extraProofText` is optional caller-supplied proof context (e.g. the text of a
 * `poc_verify` / `retest_run` result the caller already has in hand). When it is
 * omitted the preflight judges the FINDING ALONE and says so on the proof item,
 * instead of pretending the store contains proof it never read.
 *
 * `siblings` are the OTHER stored findings, used for the duplicate check
 * (checklist 1.1-1.3) — without them that item cannot be judged at all, so it
 * reports itself as unchecked rather than passing.
 */
export function preflightFinding(
  f: Finding,
  opts: { extraProofText?: string; siblings?: readonly Finding[] } = {}
): PreflightResult {
  const items: PreflightItem[] = [];
  const push = (id: string, level: PreflightLevel, text: string) => items.push({ id, level, text });

  // 1. Unique title on the same host (checklist 1.1-1.3 — a duplicate reads as
  //    an unreliable reporter and gets merged into a "not reproducible" thread).
  if (!opts.siblings) {
    push("unique-title", "WARN", "Cannot judge duplicates without the other stored findings.");
  } else {
    const key = dupTitleKey(f.title);
    const myHost = hostOfUrl(f.target || "");
    const dupes = opts.siblings.filter(
      // Exact host equality, NOT a substring test: "other-lab.example" contains
      // "lab.example", and a substring match would call two different labs the
      // same finding — the exact bug class this item exists to catch.
      (o) => o.id !== f.id && o.status !== "resolved" && dupTitleKey(o.title) === key && hostOfUrl(o.target || "") === myHost
    );
    push(
      "unique-title",
      dupes.length ? "FAIL" : "PASS",
      dupes.length
        ? `The same issue is already recorded as ${dupes.map((d) => d.id).join(", ")} — submit ONE report, two copies read as an unreliable reporter.`
        : `Title is specific and not a duplicate: "${f.title.slice(0, 80)}"`
    );
  }

  // 2. English prose (deliverable language).
  const idFields = ["title", "steps", "impact", "root_cause", "remediation", "references"].filter((k) => {
    const v = (f as unknown as Record<string, string>)[k];
    return typeof v === "string" && /yang|dan|dengan|adalah|tidak|untuk|pada|dari|sebagai|akan|sudah|tidak/.test(v);
  });
  push(
    "english-prose",
    idFields.length ? "FAIL" : "PASS",
    idFields.length
      ? `Field(s) ${idFields.join(", ")} look Indonesian — the report/submission must be English.`
      : "Prose fields read as English."
  );

  // 3. Vulnerability class resolved (drives the Expected/Actual baseline).
  const cls = vulnClass(f);
  push("class", cls === "other" ? "WARN" : "PASS", cls === "other" ? "Could not classify the vulnerability class from CWE/title — Expected/Actual and remediation fall back to no baseline." : `Classified as ${cls}.`);

  // 4-5. Expected vs Actual (the part that decides triage).
  const ea = expectedActualFor(f);
  if (f.expected?.trim() && f.actual?.trim()) {
    push("expected-actual", "PASS", "Expected and Actual are both filled in by the tester.");
  } else if (ea) {
    push("expected-actual", "WARN", `Tester left ${!f.actual?.trim() ? "actual" : "expected"} empty; a class baseline was used — state the MEASURED behaviour yourself, reviewers reject generic text.`);
  } else {
    push("expected-actual", "FAIL", "Expected Behavior and Actual Behavior are both empty and no class baseline applies — a reviewer has nothing to judge this against.");
  }

  // 6. CVSS vector present and version-pinned.
  if (f.cvssVector?.trim()) {
    push("cvss-vector", "PASS", `CVSS v${cvssVersionFor(f.cvssVector)} vector recorded: ${f.cvssVector}`);
  } else {
    push("cvss-vector", "WARN", "No CVSS vector — the score cannot be re-derived, and a wrong score is the easiest thing for a triager to dispute.");
  }

  // 7. Severity defensible against the numeric score.
  const floor = BAND_MIN[f.severity] ?? 0;
  push(
    "severity-vs-score",
    f.cvss == null ? "WARN" : f.cvss >= floor ? "PASS" : "FAIL",
    f.cvss == null
      ? `Severity ${f.severity} without a numeric score — a triager cannot re-derive it.`
      : f.cvss >= floor
        ? `Severity ${f.severity} is consistent with CVSS ${f.cvss}.`
        : `Severity ${f.severity} cannot hold CVSS ${f.cvss} (${f.severity} starts at ${floor}).`
  );

  // 8. Evidence is substantive and NOT a whole-system claim.
  const over = overclaimVerdict(f.impact || "", f.evidence || "", f.steps || "");
  push(
    "impact-not-overclaimed",
    over.allow ? "PASS" : "FAIL",
    over.allow ? (over.hedged ? `Impact is a hedged risk statement (${over.claim}) nobody has verified — say what you measured.` : "Impact scope is backed by the stored evidence.") : over.reason
  );

  // 9. No secrets / PII left in the deliverable text.
  const residues = redactorResidues([f.evidence, f.steps, f.impact, f.title].join("\n"));
  push(
    "no-secrets",
    residues.length ? "FAIL" : "PASS",
    residues.length ? `Unredacted ${residues.join(", ")} in the finding text — it reaches the report verbatim.` : "No unredacted secret/PII residue detected."
  );

  // 10. Endpoint is specific (site-wide "the app is vulnerable" gets closed).
  const ep = f.steps || f.evidence || "";
  const hasPath = /\/[A-Za-z0-9._-]{2,}/.test(ep) || pathOfUrl(f.target || "") !== "";
  push("specific-endpoint", hasPath ? "PASS" : "WARN", hasPath ? "A concrete path or URL is named." : "No concrete endpoint named — scope it to a path, or state clearly that it is a site-wide design issue.");

  // 11. Evidence actually speaks for that endpoint (checklist 4.1).
  const autoStamped = /\[auto from http_history\]/.test(f.evidence || "");
  push(
    "evidence-matches-endpoint",
    autoStamped ? "WARN" : "PASS",
    autoStamped
      ? `Evidence is auto-stamped from http_history (${hostOfUrl(f.target || "") || "target"}) — re-read it and confirm it is THIS endpoint's response.`
      : "Evidence is the tester's own raw request/response."
  );

  // 12. Proof of exploitability.
  if (opts.extraProofText == null) {
    push("proof", "WARN", "No proof context supplied to this preflight — pass the poc_verify/retest_run output to have this item judged.");
  } else {
    const ok = /poc_verify|retest_run|STABIL|determin|oast_poll|\bPASS\b|\d+\/\d+\s+PASS/i.test(opts.extraProofText);
    push("proof", ok ? "PASS" : "FAIL", ok ? "A deterministic proof result backs this finding." : "No deterministic proof (poc_verify / retest_run) supports this finding yet.");
  }

  // 13. Class-specific proof where the generic tool cannot help (XSS).
  const xss = xssProofAdvisory(f);
  push("class-proof", xss ? "WARN" : "PASS", xss || "No class-specific proof requirement applies.");

  // 14. Root cause traced.
  push("root-cause", f.rootCause?.trim() ? "PASS" : "WARN", f.rootCause?.trim() ? "Root cause is stated." : "No root cause — most 'informative only' verdicts start here.");

  // 15. Remediation is concrete, not boilerplate.
  const rem = remediationFor(f);
  push(
    "remediation",
    rem.source === "tester" && !isGenericRemediation(rem.text) ? "PASS" : "WARN",
    rem.source === "baseline"
      ? `Remediation is the class baseline ("${rem.text.slice(0, 70)}…") — adapt it to this code path.`
      : isGenericRemediation(rem.text)
        ? "Remediation reads as generic boilerplate."
        : "Remediation is finding-specific."
  );

  // 16. References present.
  push("references", f.references?.trim() ? "PASS" : "WARN", f.references?.trim() ? "References are attached." : "No references — a link to the CWE/OWASP page raises the acceptance rate.");

  // 17. Not marked draft.
  push("not-draft", isDraftish(f) ? "FAIL" : "PASS", isDraftish(f) ? "Still marked DRAFT/unverified — do not submit it like this." : "Not marked as a draft.");

  // 18. Title is not the placeholder shell.
  const shallow = /^(\[|\()?\[?(draft|todo|tbd)\]?/i.test(f.title.trim()) || f.title.trim().length < 12;
  push("title-quality", shallow ? "FAIL" : "PASS", shallow ? "The title is a placeholder, not a description of the bug." : "The title names the bug and its class.");

  // 19. Target is in scope / well-formed.
  const targetOk = /^https?:\/\/[^/]+/.test(f.target || "") || (f.target || "").length > 3;
  push("target", targetOk ? "PASS" : "FAIL", targetOk ? `Target ${f.target}` : "Target is missing or not a URL.");

  // 20. Platform mapping present (checklist 3.2) — a submitter who does not
  //     know where the score lands on HackerOne/Bugcrowd picks the wrong program
  //     or the wrong severity field.
  const mapped = /hackerone|bugcrowd|vrt|platform (?:severity|mapping)|platformFromCvss/i.test(
    `${f.severity} ${f.references || ""} ${f.evidence || ""}`
  );
  push(
    "platform-severity",
    mapped ? "PASS" : "WARN",
    mapped
      ? "A platform mapping is referenced."
      : `No HackerOne/Bugcrowd mapping in the finding — run platform_severity so the submitted severity matches the program's scale (it is a suggestion, not a rating).`
  );

  // 21. Concise enough to be read.
  const long = (f.impact || "").length > 1000;
  push("concise-impact", long ? "WARN" : "PASS", long ? "Impact is very long — lead with the concrete consequence." : "Impact is a readable length.");

  return { findingId: f.id, title: f.title, target: f.target, worst: worstLevel(items), items };
}

/** Human-readable block for one finding. Pure. */
export function formatPreflight(r: PreflightResult): string {
  const icon = { FAIL: "🔴", WARN: "🟡", PASS: "🟢" } as const;
  const lines = r.items.map((i) => `${icon[i.level]} [${i.id}] ${i.text}`);
  return `${icon[r.worst]} PRECHECK ${r.worst} — ${r.title} (${r.findingId})\n${lines.join("\n")}`;
}

/**
 * Preflight for every open finding, worst first. Pure.
 */
export function preflightFindings(
  findings: readonly Finding[],
  opts: { extraProofText?: string; siblings?: readonly Finding[] } = {}
): PreflightResult[] {
  return findings
    .map((f) => preflightFinding(f, { ...opts, siblings: opts.siblings ?? findings }))
    .sort((a, b) => LEVEL_ORDER[b.worst] - LEVEL_ORDER[a.worst] || a.title.localeCompare(b.title));
}
