import { describe, it, expect } from "vitest";
import {
  vulnClass,
  isGenericRemediation,
  expectedActualFor,
  remediationFor,
  cvssVersionFor,
  dupTitleKey,
  xssProofAdvisory,
  type VulnClass,
} from "./findingPolicy";
import type { Finding } from "./security";

/** Minimal finding factory — every field the policy helpers read is explicit. */
function f(over: Partial<Finding> = {}): Finding {
  return {
    id: "F-test",
    title: "SQL injection in /api/user",
    severity: "high",
    cvss: 8.5,
    owasp: "A03:2025 Injection",
    cwe: "CWE-89",
    target: "https://lab.example/api/user",
    evidence: "GET /api/user?id=1' OR 1=1-- -> 200 with 42 rows",
    steps: "1. GET /api/user?id=1' OR 1=1--",
    impact: "Any user can read every row of the users table.",
    rootCause: "id is concatenated into a SQL string.",
    remediation: "Use a parameterised query for the id parameter.",
    references: "https://owasp.org/x",
    status: "open",
    createdAt: "2026-09-28T00:00:00Z",
    ...over,
  };
}

describe("vulnClass", () => {
  it("reads the CWE first, so a vague title cannot mislabel the class", () => {
    expect(vulnClass(f({ title: "Broken thing in /api/x", cwe: "CWE-89" }))).toBe("sqli");
  });

  it("falls back to the title when no CWE was recorded", () => {
    expect(vulnClass(f({ cwe: "", title: "Reflected XSS in search box" }))).toBe("xss");
  });

  it("does not let RCE shadow the underlying injection class", () => {
    // A title that says "RCE via command injection" is a command-injection
    // report; classifying it as plain rce would pick the wrong baseline.
    expect(vulnClass(f({ cwe: "", title: "RCE via command injection in /api/run" }))).toBe("command-injection");
  });

  it("returns other when nothing classifies, instead of guessing", () => {
    expect(vulnClass(f({ cwe: "", title: "Something odd about the dashboard", owasp: "" }))).toBe("other");
  });

  it("maps an OWASP-only finding only when the title itself is specific", () => {
    expect(vulnClass(f({ cwe: "", title: "XXE in /api/import", owasp: "A05:2025 Security Misconfiguration" }))).toBe("xxe");
  });
});

describe("expectedActualFor", () => {
  it("prefers the tester's own text when both sides are present", () => {
    const out = expectedActualFor(f({ expected: "Only staff may read other users.", actual: "Any anonymous caller got 200 with PII." }));
    expect(out).toEqual({ expected: "Only staff may read other users.", actual: "Any anonymous caller got 200 with PII." });
  });

  it("uses the class baseline when the tester wrote nothing", () => {
    const out = expectedActualFor(f());
    expect(out?.expected).toBeTruthy();
    expect(out?.actual).toBeTruthy();
  });

  it("returns null for an unclassifiable finding with no tester text — the caller omits the section", () => {
    expect(expectedActualFor(f({ cwe: "", title: "Something odd", owasp: "", expected: "", actual: "" }))).toBeNull();
  });

  it("does not invent an authorization Expected/Actual for a SQLi finding", () => {
    const out = expectedActualFor(f());
    expect(out?.expected.toLowerCase()).not.toMatch(/401|403/);
  });
});

describe("remediationFor", () => {
  it("reports tester prose as tester prose", () => {
    const out = remediationFor(f());
    expect(out.source).toBe("tester");
    expect(out.text).toContain("parameterised");
  });

  it("labels a class baseline as a baseline, never as an analysis", () => {
    const out = remediationFor(f({ remediation: "" }));
    expect(out.source).toBe("baseline");
    expect(out.text).toBeTruthy();
  });

  it("treats generic enforcement boilerplate as not tester-written", () => {
    expect(isGenericRemediation("Enforce authorization/integrity checks server-side.")).toBe(true);
    expect(isGenericRemediation("Use a parameterised query for the id parameter.")).toBe(false);
  });
});

describe("cvssVersionFor", () => {
  it("pins the version from the vector prefix", () => {
    expect(cvssVersionFor("CVSS:4.0/AV:N/AC:L")).toBe("4.0");
    expect(cvssVersionFor("CVSS:3.1/AV:N/AC:L")).toBe("3.1");
  });

  it("defaults to 3.1 for a vector that carries no prefix", () => {
    expect(cvssVersionFor("AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toBe("3.1");
  });
});

describe("dupTitleKey", () => {
  it("folds case, punctuation and whitespace", () => {
    expect(dupTitleKey("IDOR  on  /api/x!")).toBe(dupTitleKey("idor on api x"));
  });

  it("folds the same class written with a synonym", () => {
    // The audit's reworded-duplicate case: same bug, two vocabularies.
    expect(dupTitleKey("SQL injection at /api/user")).toBe(dupTitleKey("SQLi on /api/user"));
  });

  it("keeps genuinely different endpoints apart", () => {
    expect(dupTitleKey("IDOR on /api/user")).not.toBe(dupTitleKey("IDOR on /api/dokumen"));
  });
});

describe("xssProofAdvisory", () => {
  it("asks for a browser proof on an XSS finding that has none", () => {
    const note = xssProofAdvisory(f({ cwe: "CWE-79", title: "Stored XSS in /api/pengaduan", evidence: "payload stored", steps: "post payload" }));
    expect(note).toBeTruthy();
    expect(note?.toLowerCase()).toMatch(/dom_xss_prove|browser/);
  });

  it("stays silent once a browser execution is in the evidence", () => {
    const note = xssProofAdvisory(
      f({ cwe: "CWE-79", title: "Stored XSS", evidence: "dom_xss_prove: PROVEN — handler fired on the victim's page", steps: "x" })
    );
    expect(note).toBe("");
  });

  it("never fires for a non-XSS class", () => {
    expect(xssProofAdvisory(f())).toBe("");
  });
});

describe("VulnClass coverage", () => {
  it("keeps every declared class distinct from other", () => {
    const declared: VulnClass[] = ["sqli", "nosql", "xss", "idor", "other"];
    expect(new Set(declared).size).toBe(declared.length);
  });
});

describe("classification regressions found by the gate", () => {
  it("does not treat CWE-200 as path traversal — it is information exposure", () => {
    // CWE-200 is "Exposure of Sensitive Information to an Unauthorized Actor".
    // Listing it under traversal handed a stack-trace report a file-traversal
    // Expected/Actual baseline.
    expect(vulnClass(f({ cwe: "CWE-200", title: "Stack trace exposed at /api/x", owasp: "" }))).toBe("info-disclosure");
  });

  it("classifies the missing-cookie-flag report instead of leaving it unclassified", () => {
    expect(vulnClass(f({ cwe: "CWE-1004", title: "Cookie without HttpOnly flag", owasp: "" }))).toBe("info-disclosure");
  });

  it("still classifies real path traversal as traversal", () => {
    expect(vulnClass(f({ cwe: "CWE-22", title: "Path traversal in /api/file", owasp: "" }))).toBe("path-traversal");
  });
});
