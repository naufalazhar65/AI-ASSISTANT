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
    : f.evidence || "(belum ada bukti mentah — jalankan poc_verify/evidence_capture)";

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
    `${title}. ${f.impact ? f.impact : "Dampak dirinci di bawah setelah verifikasi."}`,
    ``,
    `## Steps to reproduce`,
    f.steps ? f.steps : `1. Autentikasi/iapkan sesi sesuai target (${f.target || "asset"}).`,
    f.steps ? "" : `2. Kirim request di bagian Evidence.`,
    f.steps ? "" : `3. Amati bahwa respons berbeda dari yang seharusnya (lihat Expected vs Actual).`,
    ``,
    `## Evidence (raw)`,
    "```",
    rawReq.slice(0, 1800),
    "```",
    ``,
    `## Impact`,
    f.impact || "Jelaskan data/aksi yang bisa diakses penyerang dan siapa yang terdampak.",
    ``,
    `## Root cause`,
    f.rootCause || "(isi setelah trace source→sink)",
    ``,
    `## Remediation`,
    f.remediation || "Validasi otorisasi/integritas di server; jangan percaya nilai dari klien.",
    ``,
    f.references ? `## References\n${f.references}\n` : "",
    unverified ? `> ⚠️ **STATUS: DRAFT — belum diverifikasi.** Jalankan \`poc_verify\` dan lampirkan bukti deterministik sebelum submit.\n` : "",
  ];
  return lines.filter((l) => l !== "").join("\n");
}

/** Writeup for a finding by id, or the newest when no id is given. */
export function writeupText(rawUser: unknown, opts: { id?: string; platform?: string } = {}): string {
  const all = readFindings(rawUser);
  if (!all.length) return "Belum ada temuan. Catat dulu (finding_add) atau jalankan bounty_run.";
  const f = opts.id ? all.find((x) => x.id === opts.id) : all[all.length - 1];
  if (!f) return `Finding "${opts.id}" tidak ditemukan.`;
  return renderWriteup(f, { platform: opts.platform });
}
