import { describe, it, expect } from "vitest";
import { preflightFinding, preflightFindings, formatPreflight } from "./submissionPreflight";
import type { Finding } from "./security";

/** A complete, submission-shaped finding — the shape the preflight should PASS. */
function good(over: Partial<Finding> = {}): Finding {
  return {
    id: "F-good",
    title: "SQL injection in /api/user via the id parameter",
    severity: "high",
    cvss: 8.5,
    owasp: "A03:2025 Injection",
    cwe: "CWE-89",
    target: "https://lab.example",
    evidence: "poc_verify: STABIL 3/3 PASS — GET /api/user?id=1' OR 1=1-- returns 42 rows instead of 1",
    steps: "1. Send GET /api/user?id=1' OR 1=1--\n2. Observe 42 rows returned",
    impact: "Any user can read the 42 user records the query returns, including password hashes.",
    rootCause: "The id parameter is concatenated into the SQL string.",
    remediation: "Replace the concatenation with a parameterised query for the id parameter.",
    references: "https://owasp.org/www-community/attacks/SQL_Injection",
    expected: "The id parameter must be bound as a query parameter, so a non-numeric id returns an error.",
    actual: "A non-numeric id is concatenated into the query and returns 42 rows.",
    cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
    status: "open",
    createdAt: "2026-09-28T00:00:00Z",
    ...over,
  };
}

/** The finding the audit was written from: overclaimed impact, no expected/actual. */
function overclaimed(): Finding {
  return good({
    id: "F-bad",
    title: "SQL injection in /api/user",
    impact: "An unauthenticated attacker can read the ENTIRE database.",
    expected: "",
    actual: "",
    evidence: "GET /api/user?id=1 -> 200",
    steps: "1. GET /api/user?id=1",
    cvssVector: "",
  });
}

const PROOF = "poc_verify STABIL 3/3 PASS";

describe("preflightFinding", () => {
  it("passes a complete submission-shaped finding", () => {
    const r = preflightFinding(good(), { extraProofText: PROOF, siblings: [good()] });
    expect(r.items.filter((i) => i.level === "FAIL")).toEqual([]);
    expect(r.worst).not.toBe("FAIL");
  });

  it("FAILS an overclaimed whole-database impact", () => {
    const r = preflightFinding(overclaimed());
    const item = r.items.find((i) => i.id === "impact-not-overclaimed");
    expect(item?.level).toBe("FAIL");
    expect(r.worst).toBe("FAIL");
  });

  it("FAILS a finding with neither tester Expected/Actual nor a class baseline", () => {
    const r = preflightFinding(good({ cwe: "", owasp: "", title: "Odd dashboard behaviour", expected: "", actual: "" }));
    const item = r.items.find((i) => i.id === "expected-actual");
    expect(item?.level).toBe("FAIL");
  });

  it("WARNs (never FAILs) when the Expected/Actual gap is covered by a class baseline", () => {
    const r = preflightFinding(good({ expected: "", actual: "" }));
    expect(r.items.find((i) => i.id === "expected-actual")?.level).toBe("WARN");
  });

  it("FAILS a severity that cannot hold its own numeric score", () => {
    const r = preflightFinding(good({ severity: "critical", cvss: 5.3 }));
    expect(r.items.find((i) => i.id === "severity-vs-score")?.level).toBe("FAIL");
  });

  it("FAILS PII that would ship with the report", () => {
    const r = preflightFinding(good({ evidence: "dump: ahmad@contoh.co.id | 0812-3456-7890 | password=hunter2000" }));
    expect(r.items.find((i) => i.id === "no-secrets")?.level).toBe("FAIL");
  });

  it("FAILS a finding that still says DRAFT", () => {
    expect(preflightFinding(good({ title: "[DRAFT] SQL injection in /api/user" })).items.find((i) => i.id === "not-draft")?.level).toBe("FAIL");
  });

  it("FAILS a placeholder title", () => {
    expect(preflightFinding(good({ title: "TODO" })).items.find((i) => i.id === "title-quality")?.level).toBe("FAIL");
  });

  it("FAILS a missing target", () => {
    expect(preflightFinding(good({ target: "" })).items.find((i) => i.id === "target")?.level).toBe("FAIL");
  });

  it("judges the proof item only when proof context is supplied", () => {
    const without = preflightFinding(good(), { siblings: [good()] }).items.find((i) => i.id === "proof");
    expect(without?.level).toBe("WARN");
    expect(without?.text).toMatch(/pass the poc_verify/i);
    expect(preflightFinding(good(), { extraProofText: PROOF, siblings: [good()] }).items.find((i) => i.id === "proof")?.level).toBe("PASS");
    expect(preflightFinding(good(), { extraProofText: "nothing ran", siblings: [good()] }).items.find((i) => i.id === "proof")?.level).toBe("FAIL");
  });

  it("WARNs on a baseline remediation instead of passing it off as analysis", () => {
    expect(preflightFinding(good({ remediation: "" })).items.find((i) => i.id === "remediation")?.level).toBe("WARN");
  });

  it("WARNs when the evidence was auto-stamped from http_history", () => {
    const r = preflightFinding(good({ evidence: "[auto from http_history] GET /api/user?id=1 -> 200" }));
    expect(r.items.find((i) => i.id === "evidence-matches-endpoint")?.level).toBe("WARN");
  });

  it("WARNs about a missing CVSS vector but never FAILs on it", () => {
    expect(preflightFinding(good({ cvssVector: "" })).items.find((i) => i.id === "cvss-vector")?.level).toBe("WARN");
  });

  it("asks for a browser proof on an XSS finding that only has a payload", () => {
    const r = preflightFinding(
      good({ cwe: "CWE-79", title: "Stored XSS in /api/pengaduan", evidence: "payload stored in the comment table", steps: "1. post the payload" })
    );
    expect(r.items.find((i) => i.id === "class-proof")?.level).toBe("WARN");
  });

  it("runs the whole checklist on every finding, and every item id is unique", () => {
    const items = preflightFinding(good(), { siblings: [good()] }).items;
    expect(items.length).toBeGreaterThanOrEqual(20);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });

  it("FAILS a reworded duplicate of an already-recorded finding (checklist 1.1-1.3)", () => {
    const recorded = good({ id: "F-first", title: "SQL injection in /api/user via the id parameter" });
    const rerun = good({ id: "F-second", title: "SQLi on /api/user id parameter" });
    const r = preflightFinding(rerun, { siblings: [recorded] });
    expect(r.items.find((i) => i.id === "unique-title")?.level).toBe("FAIL");
  });

  it("does not call a finding on a different host a duplicate", () => {
    const recorded = good({ id: "F-first", target: "https://other-lab.example" });
    const r = preflightFinding(good({ id: "F-second" }), { siblings: [recorded] });
    expect(r.items.find((i) => i.id === "unique-title")?.level).toBe("PASS");
  });
});

describe("preflightFindings + formatPreflight", () => {
  it("sorts the worst finding first so the actionable one leads", () => {
    const out = preflightFindings([good(), overclaimed()]);
    expect(out[0].findingId).toBe("F-bad");
    expect(out[0].worst).toBe("FAIL");
  });

  it("prints a line per item with its id, so the fix is findable", () => {
    const text = formatPreflight(preflightFinding(overclaimed()));
    expect(text).toContain("PRECHECK");
    expect(text).toContain("[impact-not-overclaimed]");
    expect(text.split("\n").length).toBeGreaterThanOrEqual(21);
  });
});
