// Writeup generator — turn a recorded finding (+ its evidence) into a
// submission-ready report: impact-first, reproducible, with the raw request and
// a concrete remediation. Good writeups are what stop a valid bug from being
// closed as N/A / informational.

import { readFindings, platformSeverity, type Finding } from "./security";

/**
 * Render one finding as a Bugcrowd/HackerOne-style markdown writeup. Pure —
 * unit-tested.
 */
export function renderWriteup(f: Finding, opts: { platform?: string } = {}): string {
  const unverified = /belum diverifikasi|draft/i.test(f.title);
  const title = f.title.replace(/^\[DRAFT[^\]]*\]\s*/i, "").trim();
  const sev = `${f.severity.toUpperCase()}${f.cvss !== null ? ` (CVSS ${f.cvss})` : ""}`;
  const platform = platformSeverity({ cvss: f.cvss ?? undefined, severity: f.severity });
  const rawReq = f.evidence.includes("[auto from http_history]") || f.evidence.includes("GET ") || f.evidence.includes("POST ")
    ? f.evidence
    : f.evidence || "(no raw evidence yet — run poc_verify/evidence_capture)";

  const lines = [
    `# ${title}`,
    ``,
    `**Severity:** ${sev}  `,
    `**Platform mapping:** ${platform}  `,
    f.owasp ? `**OWASP:** ${f.owasp}  ` : "",
    f.cwe ? `**CWE:** ${f.cwe}  ` : "",
    f.target ? `**Affected asset:** ${f.target}  ` : "",
    f.createdAt ? `**Reported:** ${f.createdAt.slice(0, 10)}` : "",
    ``,
    `## Summary`,
    `${title}. ${f.impact ? f.impact : "Impact detailed below after verification."}`,
    ``,
    `## Steps to reproduce`,
    f.steps ? f.steps : `1. Authenticate/set up a session against the target (${f.target || "asset"}).`,
    f.steps ? "" : `2. Send the request shown under Evidence.`,
    f.steps ? "" : `3. Observe that the response differs from the intended behavior (see Expected vs Actual).`,
    ``,
    `## Evidence (raw)`,
    "```",
    rawReq.slice(0, 1800),
    "```",
    ``,
    `## Impact`,
    f.impact || "Describe the data/actions an attacker can access and who is affected.",
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

/** Writeup for a finding by id, or the newest when no id is given. */
export function writeupText(rawUser: unknown, opts: { id?: string; platform?: string } = {}): string {
  const all = readFindings(rawUser);
  if (!all.length) return "No findings recorded yet. Add one (finding_add) or run bounty_run first.";
  const f = opts.id ? all.find((x) => x.id === opts.id) : all[all.length - 1];
  if (!f) return `Finding "${opts.id}" not found.`;
  return renderWriteup(f, { platform: opts.platform });
}
