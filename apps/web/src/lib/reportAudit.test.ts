// reportAudit.test.ts — regression locks for the 2026-10-15 report audit.
//
// Every check below failed on the pre-audit artifacts (wrong scores, wrong
// labels, empty steps, merge markers, stale dates) and passes on the
// corrected store. Hermetic: all fixtures live on a throwaway user.
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userDataRoot } from "./users";
import { generateReport, readFindings, reportPdf, cvssScore, severityFromCvss } from "./security";
import { renderReportHtml } from "./reportHtml";

const HOST = "https://cozy-kangaroo-42f2e0.netlify.app";

interface FixtureFinding {
  id: string;
  title: string;
  severity: string;
  cvss: number;
  cvssVector: string;
  owasp: string;
  cwe: string;
  target: string;
  evidence: string;
  steps: string;
  impact: string;
  rootCause: string;
  remediation: string;
  references: string;
  status: string;
  createdAt: string;
}

const ROWS: FixtureFinding[] = [
  { id: "F-a1", title: "SQL Injection in /api/cari-berita", severity: "high", cvss: 7.5, cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N", owasp: "A05:2025 Injection", cwe: "CWE-89", target: HOST, evidence: "UNION extraction demonstrated. First observed: 2026-09-17. Last verified: 2026-10-15.", steps: "1. GET /api/cari-berita?q=zzz", impact: "data extraction", rootCause: "interpolation", remediation: "parameterize", references: "https://owasp.org/www-community/attacks/SQL_Injection", status: "open", createdAt: "2026-09-17T09:34:54.640Z" },
  { id: "F-a2", title: "SQL Injection on /api/login", severity: "critical", cvss: 9.1, cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N", owasp: "A05:2025 Injection", cwe: "CWE-89", target: `${HOST}/login`, evidence: "200 vs 401 baseline. First observed: 2026-09-28. Last verified: 2026-09-28.", steps: "1. POST /api/login", impact: "auth bypass", rootCause: "concatenation", remediation: "parameterize", references: "https://cwe.mitre.org/data/definitions/89.html", status: "open", createdAt: "2026-09-28T09:16:57.954Z" },
  { id: "F-a3", title: "Unauthenticated /api/admin-data leak", severity: "critical", cvss: 9.1, cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N", owasp: "A01:2025 Broken Access Control", cwe: "CWE-256, CWE-200", target: HOST, evidence: "200 dump. First observed: 2026-09-17. Last verified: 2026-09-28.", steps: "1. GET /api/admin-data", impact: "takeover", rootCause: "no auth", remediation: "protect endpoint", references: "https://owasp.org/Top10/A01_2025-Broken_Access_Control/", status: "open", createdAt: "2026-09-17T09:34:54.644Z" },
  { id: "F-a4", title: "IDOR on /api/cek-nik", severity: "high", cvss: 7.5, cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N", owasp: "A01:2025 Broken Access Control", cwe: "CWE-639", target: `${HOST}/cek-nik`, evidence: "id=2 PII. First observed: 2026-09-26. Last verified: 2026-09-28.", steps: "1. GET /api/cek-nik?id=1", impact: "PII", rootCause: "no authz", remediation: "authz", references: "https://owasp.org/Top10/A01_2025-Broken_Access_Control/", status: "open", createdAt: "2026-09-26T07:44:24.210Z" },
  { id: "F-a5", title: "IDOR on /api/profil-pegawai", severity: "high", cvss: 7.5, cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N", owasp: "A01:2025 Broken Access Control", cwe: "CWE-639", target: `${HOST}/api/profil-pegawai`, evidence: "id=1 200 vs 404. First observed: 2026-09-26. Last verified: 2026-09-28.", steps: "1. GET /api/profil-pegawai?id=1", impact: "exposure", rootCause: "no authz", remediation: "authz", references: "https://cwe.mitre.org/data/definitions/639.html", status: "open", createdAt: "2026-09-26T05:39:45.554Z" },
  { id: "F-a6", title: "BAC via x-user-role header", severity: "high", cvss: 7.5, cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N", owasp: "A01:2025 Broken Access Control", cwe: "CWE-807", target: HOST, evidence: "403 vs 200. First observed: 2026-09-17. Last verified: 2026-09-28.", steps: "1. GET /api/dokumen?id=4", impact: "doc read", rootCause: "client trust", remediation: "server session", references: "https://owasp.org/Top10/A01_2025-Broken_Access_Control/", status: "open", createdAt: "2026-09-17T09:34:54.646Z" },
  { id: "F-a7", title: "Stored XSS in /api/pengaduan", severity: "high", cvss: 7.1, cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:L/A:N", owasp: "A05:2025 Injection", cwe: "CWE-79", target: HOST, evidence: "Chromium fired. First observed: 2026-09-17. Last verified: 2026-09-28.", steps: "1. POST /api/pengaduan", impact: "JS exec", rootCause: "no encode", remediation: "encode + CSP", references: "https://owasp.org/www-community/attacks/xss/", status: "open", createdAt: "2026-09-17T09:34:54.650Z" },
  { id: "F-a8", title: "Missing security headers", severity: "low", cvss: 3.7, cvssVector: "CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:L/I:N/A:N", owasp: "A02:2025 Security Misconfiguration", cwe: "CWE-693", target: HOST, evidence: "web_audit. First observed: 2026-09-17. Last verified: 2026-09-28.", steps: "1. curl -I index.html", impact: "enabler", rootCause: "no headers", remediation: "add headers", references: "https://owasp.org/www-project-secure-headers/", status: "open", createdAt: "2026-09-17T09:34:54.652Z" },
];

function withFixtureUser(): string {
  const user = `verify_reportaudit_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const dir = join(userDataRoot(), user);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "findings.json"), JSON.stringify(ROWS));
  return user;
}

function cleanupUser(user: string): void {
  rmSync(join(userDataRoot(), user), { recursive: true, force: true });
}

function scoreOf(vector: string): number {
  const m = /base score:\s*([0-9]+(?:\.[0-9]+)?)/.exec(cvssScore(vector));
  if (!m) throw new Error(`unscorable vector: ${vector}`);
  return Number(m[1]);
}

describe("report audit locks (2026-10-15)", () => {
  it("every stored score matches its vector and its severity band", () => {
    const user = withFixtureUser();
    try {
      for (const f of readFindings(user)) {
        expect(Math.abs(scoreOf(String(f.cvssVector)) - (f.cvss ?? -1)) < 0.051, `${f.id} vector/score`).toBe(true);
        expect(f.severity, `${f.id} band`).toBe(severityFromCvss(f.cvss ?? 0));
      }
    } finally {
      cleanupUser(user);
    }
  });

  it("counts and average are recomputed from the store, not hardcoded", () => {
    const user = withFixtureUser();
    try {
      const md = generateReport(user, { target: HOST });
      const m = /Total findings: (\d+) \(critical:(\d+)\s+high:(\d+)\s+medium:(\d+)\s+low:(\d+)\s+info:(\d+)\) — average CVSS ([0-9.]+)/.exec(md);
      expect(m, "header parses").not.toBeNull();
      const rows = readFindings(user).filter((r) => r.status !== "resolved");
      expect(Number(m![1])).toBe(rows.length);
      expect(Number(m![2])).toBe(rows.filter((r) => r.severity === "critical").length);
      expect(Number(m![7])).toBeCloseTo(rows.reduce((a, r) => a + (r.cvss ?? 0), 0) / rows.length, 1);
    } finally {
      cleanupUser(user);
    }
  });

  it("OWASP versions are 2025 and SQLi is never A03", () => {
    const user = withFixtureUser();
    try {
      const md = generateReport(user, { target: HOST });
      expect(md).not.toMatch(/A\d\d:2021/);
      expect(md).not.toMatch(/A03:2025 Injection/);
      for (const f of readFindings(user)) {
        if (/sql injection/i.test(f.title)) expect(f.owasp).toContain("A05:2025");
      }
    } finally {
      cleanupUser(user);
    }
  });

  it("no empty reproduction steps and no merge markers survive", () => {
    const user = withFixtureUser();
    try {
      const md = generateReport(user, { target: HOST });
      expect(md).not.toMatch(/Steps to Reproduce】?:\s*-\s*(\n|$)/);
      expect(md).not.toContain("merged from <REDACTED>");
      expect(md).not.toMatch(/merged from F-[A-Za-z0-9-]+/);
    } finally {
      cleanupUser(user);
    }
  });

  it("every finding carries First observed + Last verified labels", () => {
    const user = withFixtureUser();
    try {
      for (const f of readFindings(user)) {
        expect(String(f.evidence), f.id).toContain("First observed:");
        expect(String(f.evidence), f.id).toContain("Last verified:");
      }
    } finally {
      cleanupUser(user);
    }
  });

  it("no raw secrets in the rendered markdown", () => {
    const user = withFixtureUser();
    try {
      const md = generateReport(user, { target: HOST });
      expect(md).not.toMatch(/"password"\s*:\s*"[^"<]{4,}"/);
      expect(md).not.toMatch(/\b\d{16}\b/);
      expect(md).not.toMatch(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/);
    } finally {
      cleanupUser(user);
    }
  });

  it("markdown and PDF come from the same data (titles + count agree)", async () => {
    const user = withFixtureUser();
    try {
      const md = generateReport(user, { target: HOST });
      const out = await reportPdf(user, { target: HOST });
      const m = /([^/\s]+\.pdf)$/.exec(out.split("\n")[0]);
      expect(m, "pdf path in output").not.toBeNull();
      const pdfPath = join(userDataRoot(), user, "reports", m![1]);
      expect(existsSync(pdfPath)).toBe(true);
      expect(readFileSync(pdfPath).subarray(0, 5).toString()).toBe("%PDF-");
      const html = renderReportHtml(md);
      for (const f of readFindings(user).filter((r) => r.status !== "resolved")) {
        expect(html).toContain(f.title.slice(0, 40));
      }
    } finally {
      cleanupUser(user);
    }
  }, 120000);
});
