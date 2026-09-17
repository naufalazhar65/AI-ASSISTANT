// The PDF export renders our report markdown into a styled document. These lock
// the structure (severity badges, summary chips, labelled fields) so a future
// edit cannot quietly go back to "headings + <br/>" walls of text.

import { describe, expect, it } from "vitest";
import { parseReport, renderReportHtml, reportFooterTemplate } from "./reportHtml";

const MD = `# Laporan Pentest

Dibuat: 2026-09-17T10:44:04.944Z
Total temuan: 2 (critical:1  high:1  medium:0  low:0  info:0) — rata-rata CVSS 8.7

> Scope: LAB MILIK OWNER / aset sendiri (berizin).

## 1. [CRITICAL · CVSS 9.8] SQL Injection di /api/cari-berita

- **Kategori**: A05:2025 Injection / CWE-89
- **Evidence**: GET /api/cari-berita?q=zzz' UNION SELECT id,username FROM users
{"results":[{"id":1,"judul":"admin"}]}
- **Remediation**: parameterized query

## 2. [HIGH · CVSS 7.5] Broken Access Control

- **Kategori**: A01:2025 / CWE-639
`;

describe("parseReport", () => {
  it("extracts the summary, scope, findings and wrapped field values", () => {
    const doc = parseReport(MD);
    expect(doc.title).toBe("Laporan Pentest");
    expect(doc.counts).toEqual({ total: 2, bySev: { critical: 1, high: 1, medium: 0, low: 0, info: 0 }, avg: "8.7" });
    expect(doc.scope).toContain("LAB MILIK OWNER");
    expect(doc.findings.map((f) => f.sev)).toEqual(["critical", "high"]);
    expect(doc.findings[0].cvss).toBe("9.8");
    expect(doc.findings[0].title).toBe("SQL Injection di /api/cari-berita");
    const ev = doc.findings[0].rows.find((r) => r.label === "Evidence");
    expect(ev?.value).toContain("UNION SELECT");
    expect(ev?.value).toContain('"judul":"admin"'); // continuation line kept
  });
});

describe("renderReportHtml", () => {
  const html = renderReportHtml(MD);

  it("renders severity badges, chips and a scope callout", () => {
    expect(html).toContain('class="badge" style="background:#b91c1c">CRITICAL</span>');
    expect(html).toContain('class="chip critical"');
    expect(html).toContain('class="chip"><div class="n">8.7</div>');
    expect(html).toContain('class="scope"'); // the "> " quote became a callout box
  });

  it("labels every field and uses monospace for evidence", () => {
    expect(html).toContain("<dt>Kategori</dt>");
    expect(html).toContain('<dd class="pre">');
    expect(html).toContain("section class=\"finding sev-critical\"");
  });

  it("leaves no raw markdown syntax in the output", () => {
    expect(/\*\*/.test(html)).toBe(false);
    expect(/^## /m.test(html)).toBe(false);
    expect(html).not.toContain("&gt; Scope"); // the quote became a callout box
  });

  it("escapes HTML in the source to stay safe", () => {
    const evil = renderReportHtml("# T\n\n## 1. [HIGH · CVSS 8.1] <img src=x onerror=alert(1)>");
    expect(evil).toContain("&lt;img src=x");
    expect(evil).not.toContain("<img src=x");
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
