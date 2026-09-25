// The PDF export renders our report markdown into a styled document. These lock
// the structure (severity badges, header band, executive summary, remediation
// priority, TOC, numbered steps, BUKTI panel) so a future edit cannot quietly
// go back to "headings + <br/>" walls of text.

import { describe, expect, it } from "vitest";
import { execSummary, parseReport, renderReportHtml, reportFooterTemplate, sevTags, splitSteps, topRemediation } from "./reportHtml";

const MD = `# Pentest Report

Generated: 2026-09-17T10:44:04.944Z
Total findings: 2 (critical:1  high:1  medium:0  low:0  info:0) — average CVSS 8.7

> Engagement: ENG-test-1 — demo lab
> Authorization: Authorized Pentest Target
> Scope: lab.example.test

## 1. [CRITICAL · CVSS 9.8] SQL Injection di /api/cari-berita

- **Category**: A05:2025 Injection / CWE-89, CWE-200
- **Steps to Reproduce**: 1. GET /api/cari-berita?q=zzz → hasil kosong. 2. Tambahkan kutip: q=zzz' → error shape. 3. UNION SELECT 1,2,3,4-- - → kolom bocor.
- **Evidence**: GET /api/cari-berita?q=zzz' UNION SELECT id,username FROM users
{"results":[{"id":1,"judul":"admin"}]}
poc_verify 3/3 PASS (status 200, body identik).
- **Remediation**: parameterized query

## 2. [HIGH · CVSS 7.5] Broken Access Control

- **Category**: A01:2025 / CWE-639
- **Impact**: Penyerang anonim membaca dokumen internal.
Role dipercaya dari header klien, bukan sesi server.
`;

describe("parseReport", () => {
  it("extracts the summary, scope, findings and wrapped field values", () => {
    const doc = parseReport(MD);
    expect(doc.title).toBe("Pentest Report");
    expect(doc.counts).toEqual({ total: 2, bySev: { critical: 1, high: 1, medium: 0, low: 0, info: 0 }, avg: "8.7" });
    expect(doc.scope).toContain("Authorized Pentest Target");
    expect(doc.findings.map((f) => f.sev)).toEqual(["critical", "high"]);
    expect(doc.findings[0].cvss).toBe("9.8");
    expect(doc.findings[0].title).toBe("SQL Injection di /api/cari-berita");
    const ev = doc.findings[0].rows.find((r) => r.label === "Evidence");
    expect(ev?.value).toContain("UNION SELECT");
    expect(ev?.value).toContain('"judul":"admin"'); // continuation line kept
  });

  it("still parses the legacy Indonesian dialect (old .md files on disk)", () => {
    const legacy = parseReport(
      `# Laporan Pentest\n\nDibuat: 2026-09-20T00:00:00Z\nTotal temuan: 1 (critical:1  high:0  medium:0  low:0  info:0) — rata-rata CVSS 9.8\n\n> Izin: test\n\n## 1. [CRITICAL · CVSS 9.8] SQLi\n\n- **Kategori**: A05:2025 / CWE-89\n`
    );
    expect(legacy.counts).toEqual({ total: 1, bySev: { critical: 1, high: 0, medium: 0, low: 0, info: 0 }, avg: "9.8" });
    expect(legacy.findings).toHaveLength(1);
    const html = renderReportHtml(
      `# Laporan Pentest\n\nDibuat: 2026-09-20T00:00:00Z\nTotal temuan: 1 (critical:1  high:0  medium:0  low:0  info:0) — rata-rata CVSS 9.8\n`
    );
    expect(html).toContain('class="chip critical"');
    expect(html).toContain('class="chip"><div class="n">9.8</div>');
    expect(html).toContain("Generated 2026-09-20");
  });
});

describe("pure helpers (Paket B)", () => {
  it("sevTags splits on / and , only — OWASP labels survive", () => {
    expect(sevTags("A05:2025 Injection / CWE-89, CWE-200")).toEqual(["A05:2025 Injection", "CWE-89", "CWE-200"]);
    expect(sevTags("A01:2025 Broken Access Control / CWE-807, CWE-639")).toHaveLength(3);
    expect(sevTags("")).toEqual([]);
  });

  it("splitSteps splits single-line numbered recipes but not decimals", () => {
    const steps = splitSteps("1. GET /api → 200. 2. Add quote. 3. UNION → leak");
    expect(steps).toEqual(["GET /api → 200.", "Add quote.", "UNION → leak"]);
    // Decimal guard: "1.240.000.000" and "1299 byte" must not split.
    expect(splitSteps("Selisih 1.240.000.000 dalam 1299 byte")).toBeNull();
    // Multi-line values stay evidence-style.
    expect(splitSteps("1. a\n2. b")).toBeNull();
  });

  it("execSummary is deterministic and honest for zero findings", () => {
    expect(execSummary({ total: 2, bySev: { critical: 1, high: 1, medium: 0, low: 0, info: 0 }, avg: "8.7" })).toContain(
      "Found 2 findings: 1 critical, 1 high"
    );
    expect(execSummary({ total: 3, bySev: { critical: 0, high: 0, medium: 3, low: 0, info: 0 }, avg: "6.1" })).toContain(
      "overall risk level MEDIUM"
    );
    expect(execSummary(null)).toBe("");
  });

  it("topRemediation ranks by severity then CVSS", () => {
    const doc = parseReport(MD);
    expect(topRemediation(doc.findings, 1)[0].sev).toBe("critical");
    expect(topRemediation(doc.findings).map((f) => f.sev)).toEqual(["critical", "high"]);
    expect(topRemediation([])).toEqual([]);
  });
});

describe("renderReportHtml (Paket B)", () => {
  const html = renderReportHtml(MD);

  it("renders the dark header band with host + confidentiality mark", () => {
    expect(html).toContain('class="band"');
    expect(html).toContain("lab.example.test"); // host moved into the band
    expect(html).toContain("CONFIDENTIAL — INTERNAL");
    expect(html).toContain("ENG-test-1"); // engagement in the band sub
  });

  it("keeps severity badges, chips and the executive summary", () => {
    expect(html).toContain('class="badge" style="background:#dc2626">CRITICAL</span>'); // new critical red
    expect(html).toContain('class="chip critical"');
    expect(html).toContain('class="chip"><div class="n">8.7</div>');
    expect(html).toContain('class="exec"');
    expect(html).toContain("Found 2 findings: 1 critical, 1 high");
  });

  it("renders remediation priority and the finding TOC", () => {
    expect(html).toContain("Remediation Priority");
    expect(html).toContain("Findings Index");
    const prio = html.slice(html.indexOf("Remediation Priority"), html.indexOf("Findings Index"));
    expect(prio.indexOf("SQL Injection")).toBeLessThan(prio.indexOf("Broken Access Control"));
  });

  it("renders numbered steps, category tags and the BUKTI panel with poc chip", () => {
    expect(html).toContain('class="steps"');
    expect(html).toContain("<li>GET /api/cari-berita?q=zzz → hasil kosong.</li>");
    expect(html).toContain('class="tag">CWE-89</span>');
    expect(html).toContain("A05:2025 Injection"); // OWASP label intact
    expect(html).toContain('class="ptitle">EVIDENCE</span>');
    expect(html).toContain("✔ poc_verify 3/3 PASS");
  });

  it("labels every field and keeps evidence monospace", () => {
    expect(html).toContain("<dt>Remediation</dt>");
    expect(html).toContain('<dd class="pre">'); // Impact / Root Cause stay pre
    expect(html).toContain('<span class="ptitle">EVIDENCE</span>'); // evidence is the EVIDENCE panel
    expect(html).toContain('section class="finding sev-critical"');
  });

  it("leaves no raw markdown syntax in the output", () => {
    expect(/\*\*/.test(html)).toBe(false);
    expect(/^## /m.test(html)).toBe(false);
    expect(html).not.toContain("&gt; Engagement");
  });

  it("escapes HTML in the source to stay safe", () => {
    const evil = renderReportHtml("# T\n\n## 1. [HIGH · CVSS 8.1] <img src=x onerror=alert(1)>");
    expect(evil).toContain("&lt;img src=x");
    expect(evil).not.toContain("<img src=x");
  });

  it("keeps a non-URL scope as a callout instead of a host badge", () => {
    const h = renderReportHtml(`# L\n\nDibuat: 2026-09-26T00:00:00Z\n\n> Scope: LAB MILIK OWNER / aset sendiri (berizin).\n`);
    expect(h).not.toContain('class="band-host"'); // nothing host-like in the band
    expect(h).toContain('class="scope"');
    expect(h).toContain("LAB MILIK OWNER");
  });
});

describe("reportFooterTemplate", () => {
  it("keeps the Playwright page counters and inline styles", () => {
    const f = reportFooterTemplate("Laporan Pentest");
    expect(f).toContain('class="pageNumber"');
    expect(f).toContain('class="totalPages"');
    expect(f).toContain("font-size:8pt");
    expect(f).toContain("Laporan Pentest");
  });
  it("escapes the title", () => {
    expect(reportFooterTemplate("<b>x</b>")).toContain("&lt;b&gt;");
  });
});
