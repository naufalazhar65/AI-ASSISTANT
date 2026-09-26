// Writeup generator — turn a recorded finding (+ its evidence) into a
// submission-ready report: impact-first, reproducible, with the raw request and
// a concrete remediation. Good writeups are what stop a valid bug from being
// closed as N/A / informational.
//
// Structure follows the owner's bug-bounty checklist §8 (one vulnerability =
// one root cause = one clear PoC): Summary → Affected Asset → Endpoint → Type →
// Severity (SUGGESTED, not a final platform rating) → CVSS vector →
// Prerequisites → Steps → Expected vs Actual → Impact → Evidence → Root cause
// → Remediation → References. Evidence/Impact are passed through the report
// redactor so live credentials/PII never reach a submission.

import { readFindings, platformSeverity, redactEvidenceForReport, normalizeOwaspYear, type Finding } from "./security";

const normalizeOwasp = (s: string) => normalizeOwaspYear(s);

/** First API path or absolute URL mentioned in a finding — the tested endpoint. Pure. */
export function writeupEndpoint(f: Finding): string {
  const text = [f.steps, f.evidence, f.target].filter(Boolean).join("\n");
  // 1) request-line relative paths (GET /api/…, POST /api/…?x=) — the actual
  //    tested request beats any other mention
  const rel = text.match(/(?:GET|POST)\s+(\/[A-Za-z0-9_./-]*(?:\?[^\s)\\]*)?)/);
  if (rel) return rel[1].replace(/[).,;]+$/, "");
  // 2) any relative api path (with optional query)
  const anyPath = text.match(/(?:^|\s)(\/api\/[A-Za-z0-9_./-]*(?:\?[^\s)\\]*)?)/);
  if (anyPath) return anyPath[1];
  // 3) absolute URLs that point beyond the bare asset root
  const abs = [...text.matchAll(/https?:\/\/[^\s"'`<>\\)]+/g)].map((m) => m[0].replace(/[).,;]+$/, ""));
  const apiAbs = abs.find((u) => {
    try {
      const p = new URL(u);
      return p.pathname.length > 1 || !!p.search;
    } catch {
      return false;
    }
  });
  if (apiAbs) {
    try {
      const p = new URL(apiAbs);
      return p.pathname + (p.search || "");
    } catch {
      /* unreachable */
    }
  }
  // 4) site-wide findings → the asset origin
  try {
    const t = new URL(f.target || "");
    return t.origin;
  } catch {
    return f.target || "-";
  }
}

/**
 * Render one finding as a Bugcrowd/HackerOne-style markdown writeup. Pure —
 * unit-tested.
 */
export function renderWriteup(f: Finding, opts: { platform?: string } = {}): string {
  const unverified = /belum diverifikasi|draft/i.test(f.title);
  const title = f.title.replace(/^\[DRAFT[^\]]*\]\s*/i, "").trim();
  const sev = `${f.severity.toUpperCase()}${f.cvss !== null ? ` (CVSS ${f.cvss})` : ""}`;
  const platform = platformSeverity({ cvss: f.cvss ?? undefined, severity: f.severity }).replace(/^📊 Platform severity — /, "");
  const endpoint = writeupEndpoint(f);
  const summary = f.actual?.trim() || `${title}.`;
  const rawReq = f.evidence.includes("[auto from http_history]") || f.evidence.includes("GET ") || f.evidence.includes("POST ")
    ? f.evidence
    : f.evidence || "(no raw evidence yet — run poc_verify/evidence_capture)";

  const lines = [
    `# ${title}`,
    ``,
    `## Summary`,
    summary,
    ``,
    `## Affected Asset`,
    f.target || "-",
    ``,
    `## Endpoint`,
    endpoint,
    ``,
    `## Vulnerability Type`,
    [f.owasp ? normalizeOwasp(f.owasp) : "", f.cwe].filter(Boolean).join(" · ") || "-",
    ``,
    `## Severity`,
    `Suggested: ${sev} — platform mapping ${platform} (baseline suggestion, NOT a final platform rating).`,
    ``,
    `## CVSS v3.1`,
    f.cvssVector ? "```\n" + f.cvssVector + "\n```" : "(vector not recorded — score derives from the numeric CVSS only)",
    ``,
    `## Prerequisites`,
    /PR:N/.test(f.cvssVector || "") || /unauthenticated|no authentication|without (any )?authentication/i.test([f.title, f.steps, f.actual].join(" "))
      ? "None — no authentication or special access is required beyond network reachability of the asset."
      : "A low-privilege session for the target application.",
    ``,
    `## Steps to reproduce`,
    redactEvidenceForReport(f.steps ? f.steps : `1. Authenticate/set up a session against the target (${f.target || "asset"}).`),
    f.steps ? "" : `2. Send the request shown under Evidence.`,
    f.steps ? "" : `3. Observe that the response differs from the intended behavior (see Expected vs Actual).`,
    ``,
    `## Expected Behavior`,
    f.expected || "Unauthenticated/unauthorized requests should be rejected (401/403) and no sensitive record returned.",
    ``,
    `## Actual Behavior`,
    f.actual || "The endpoint returns HTTP 200 with the sensitive record without authentication.",
    ``,
    `## Evidence`,
    "```",
    redactEvidenceForReport(rawReq).slice(0, 1800),
    "```",
    ``,
    `## Impact`,
    redactEvidenceForReport(f.impact || "Describe the data/actions an attacker can access and who is affected."),
    ``,
    `## Root cause`,
    f.rootCause || "(fill in after tracing source→sink)",
    ``,
    `## Remediation`,
    f.remediation || "Enforce authorization/integrity checks server-side; never trust client-supplied values.",
    ``,
    f.references ? `## References\n${f.references}\n` : "",
    unverified ? `> ⚠️ **STATUS: DRAFT — not yet verified.** Run \`poc_verify\` and attach deterministic proof before submitting.\n` : "",
  ];
  return lines.filter((l) => l !== "").join("\n");
}

/**
 * Writeup for a finding by id, or the newest when no id is given. A truncated
 * id (live 2026-09-26 drill: the model asked for `F-muig4nqx` while the row is
 * `F-muig4nqx-7h6v`) prefix-matches the single newest row whose id starts with
 * it — only when exactly one candidate exists, so it can never pick the wrong
 * finding.
 */
export function writeupText(rawUser: unknown, opts: { id?: string; platform?: string } = {}): string {
  const all = readFindings(rawUser);
  if (!all.length) return "No findings recorded yet. Add one (finding_add) or run bounty_run first.";
  const wanted = opts.id ?? "";
  let f = wanted ? all.find((x) => x.id === wanted) : all[all.length - 1];
  if (!f && wanted) {
    const prefix = all.filter((x) => x.id.startsWith(wanted));
    if (prefix.length === 1) f = prefix[0];
  }
  if (!f) return `Finding "${opts.id}" not found.`;
  return renderWriteup(f, { platform: opts.platform });
}
