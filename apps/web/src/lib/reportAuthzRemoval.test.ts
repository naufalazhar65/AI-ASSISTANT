import { describe, it, expect } from "vitest";
import { renderWriteup } from "./writeup";
import { expectedActualPair, renderReportHtml } from "./reportHtml";
import type { Finding } from "./security";

/**
 * Bounty-audit §4.2 / §6 / §3.1. The old renderer printed an AUTHORIZATION
 * Expected/Actual pair for every finding class and a hardcoded "## CVSS v3.1"
 * heading, so an XSS or SQLi submission claimed "unauthorized requests should be
 * rejected (401/403)" — the fastest way to get a valid bug triaged as
 * not-a-bug. These tests lock the corrected behaviour in both renderers.
 */
function f(over: Partial<Finding> = {}): Finding {
  return {
    id: "F-x",
    title: "SQL injection in /api/user via the id parameter",
    severity: "high",
    cvss: 8.5,
    owasp: "A03:2025",
    cwe: "CWE-89",
    target: "https://lab.example",
    evidence: "GET /api/user?id=1' OR 1=1-- -> 200",
    steps: "1. GET /api/user?id=1' OR 1=1--",
    impact: "Any user can read the 42 user records the query returns.",
    rootCause: "The id parameter is concatenated into the SQL string.",
    remediation: "Use a parameterised query for the id parameter.",
    references: "https://owasp.org",
    status: "open",
    createdAt: "2026-09-28T00:00:00Z",
    ...over,
  };
}

describe("writeup: Expected vs Actual", () => {
  it("uses the class baseline for a SQLi finding — never an authorization sentence", () => {
    const out = renderWriteup(f());
    expect(out).toContain("## Expected Behavior");
    expect(out).not.toMatch(/should be rejected \(401\/403\)/);
  });

  it("OMITS both sections when the class is unknown and the tester wrote nothing", () => {
    const out = renderWriteup(f({ cwe: "", owasp: "", title: "Odd dashboard behaviour", expected: "", actual: "" }));
    expect(out).not.toContain("## Expected Behavior");
    expect(out).not.toContain("## Actual Behavior");
  });

  it("does not leave a dangling 'see Expected vs Actual' in the auto-generated steps", () => {
    const out = renderWriteup(f({ cwe: "", owasp: "", title: "Odd dashboard behaviour", steps: "", expected: "", actual: "" }));
    expect(out).not.toContain("Expected vs Actual");
  });

  it("prefers the tester's own text when both sides are present", () => {
    const out = renderWriteup(f({ expected: "The id must be bound as a parameter.", actual: "It is concatenated, so a non-numeric id returns 42 rows." }));
    expect(out).toContain("The id must be bound as a parameter.");
    expect(out).toContain("so a non-numeric id returns 42 rows.");
  });
});

describe("writeup: CVSS heading", () => {
  it("does not claim v3.1 when no vector was recorded", () => {
    const out = renderWriteup(f());
    expect(out).toContain("## CVSS\n");
    expect(out).not.toContain("## CVSS v3.1");
  });

  it("pins the version the vector actually declares", () => {
    expect(renderWriteup(f({ cvssVector: "CVSS:4.0/AV:N/AC:L" }))).toContain("## CVSS v4.0");
    expect(renderWriteup(f({ cvssVector: "CVSS:3.1/AV:N/AC:L" }))).toContain("## CVSS v3.1");
  });
});

describe("writeup: remediation provenance", () => {
  it("labels a class baseline instead of passing it off as analysis", () => {
    expect(renderWriteup(f({ remediation: "" }))).toContain("Baseline remediation for this vulnerability class");
  });

  it("says nothing extra when the tester wrote real remediation", () => {
    expect(renderWriteup(f())).not.toContain("Baseline remediation");
  });
});

describe("expectedActualPair", () => {
  const rows = (o: Record<string, string>) => Object.entries(o).map(([label, value]) => ({ label, value }));

  it("pairs both sides when both exist", () => {
    expect(expectedActualPair(rows({ "Expected Behavior": "E", "Actual Behavior": "A" }))).toEqual({ expected: "E", actual: "A" });
  });

  it("returns null when a side is missing — no half-filled contrast panel", () => {
    expect(expectedActualPair(rows({ "Expected Behavior": "E" }))).toBeNull();
    expect(expectedActualPair(rows({ "Expected Behavior": "   " }))).toBeNull();
  });

  it("renders the pair as its own PDF panel, not two more grid rows", () => {
    const md = [
      "# Pentest Report",
      "Total findings: 1 (high 1) — average CVSS 8.5",
      "",
      "## 1. [HIGH · CVSS 8.5] SQL injection in /api/user",
      "- **Expected Behavior**: The id must be bound as a parameter.",
      "- **Actual Behavior**: It is concatenated; 42 rows returned.",
      "- **Impact**: reads 42 records",
      "",
    ].join("\n");
    const html = renderReportHtml(md);
    expect(html).toContain("EXPECTED vs ACTUAL");
    expect(html).toContain("The id must be bound as a parameter.");
    // The grid must not repeat them.
    expect(html.split("The id must be bound as a parameter.").length - 1).toBe(1);
  });
});
