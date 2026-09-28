import { describe, it, expect } from "vitest";
import { renderWriteup, writeupEndpoint, writeupText } from "./writeup";
import type { Finding } from "./security";



// Locks the §8 house submission format: suggested-severity framing (never a
// final platform rating), CVSS vector block, Expected vs Actual, endpoint
// extraction, PR:N → no-auth prerequisites, and redacted evidence.
const baseFinding: Finding = {
  id: "F-test",
  title: "Cookie tanpa HttpOnly",
  severity: "low",
  cvss: 3.1,
  owasp: "A02:2025",
  cwe: "CWE-1004",
  target: "app.example.com",
  evidence: "[auto from http_history] GET https://app.example.com/x → 200",
  steps: "1. GET /api/x\n2. Observe missing flags",
  impact: "session theft",
  rootCause: "",
  remediation: "set HttpOnly",
  references: "",
  status: "open",
  createdAt: new Date().toISOString(),
};

describe("renderWriteup (§8 submission format)", () => {
  it("keeps the DRAFT warning and core sections", () => {
    const out = renderWriteup({ ...baseFinding, title: "[DRAFT, belum diverifikasi] Cookie tanpa HttpOnly" });
    for (const needle of ["# Cookie tanpa HttpOnly", "Suggested: LOW", "Steps to reproduce", "Expected Behavior", "Actual Behavior", "Evidence", "Remediation", "STATUS: DRAFT"]) {
      expect(out).toContain(needle);
    }
    expect(out).toContain("NOT a final platform rating");
  });

  it("renders PR:N vector as no-auth prerequisites even when prose is vague", () => {
    const out = renderWriteup({
      ...baseFinding,
      title: "Stored XSS in /api/x",
      severity: "medium",
      cvss: 7.1,
      cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:L/A:N",
      steps: 'POST /api/x {"isi":"<script>alert(1)</script>"}',
    });
    expect(out).toContain("None — no authentication");
  });

  it("redacts secrets but keeps proof tokens in steps/evidence/impact", () => {
    const out = renderWriteup({
      ...baseFinding,
      title: "Leak",
      steps: '1. login admin / K0h0na_Sup3rAdmin!\n2. GET /api/x',
      evidence: 'dump {"password":"<REDACTED>","isi":"mia_xss_marker_miashxlyx7l<img src=x>"}',
      impact: "all 5 passwords <REDACTED> were extractable; date 2026-09-26 intact",
    });
    expect(out).not.toContain("K0h0na_Sup3rAdmin");
    expect(out).toContain("mia_xss_marker_miashxlyx7l");
    expect(out).toContain("2026-09-26");
  });

  it("extracts the tested endpoint from the request line first", () => {
    const f: Finding = {
      ...baseFinding,
      title: "IDOR on /api/cek-nik",
      target: "https://lab.example/cek-nik",
      steps: "1. GET /api/cek-nik?id=1 → 200",
    };
    expect(writeupEndpoint(f)).toBe("/api/cek-nik?id=1");
  });

  it("uses the measured page path for site-wide findings, origin for bare hosts", () => {
    const f: Finding = { ...baseFinding, title: "Missing headers", target: "https://lab.example/index.html", steps: "", evidence: "" };
    expect(writeupEndpoint(f)).toBe("/index.html");
    const bare: Finding = { ...f, target: "https://lab.example" };
    expect(writeupEndpoint(bare)).toBe("https://lab.example");
  });

  it("prefix-matches a truncated id only when exactly one row starts with it", async () => {
    // Live 2026-09-26 drill: the model dropped the random suffix of the id and
    // writeupText answered "not found". Prefix-match the UNIQUE candidate.
    const U = `verify_wu_${Date.now()}`;
    try {
      // writeupText imports the real store — seed via the module's own path.
      const { addFinding } = await import("./security");
      const a = addFinding(U, { title: "IDOR A unique", severity: "high", cvss: 8.1, target: "https://a.example/x" });
      const b = addFinding(U, { title: "BOLA B unique", severity: "medium", cvss: 6.5, target: "https://b.example/y" });

      // The ids are `F-<Date.now().toString(36)>-<rand>` (security.ts:629), so how
      // much of the head the two rows share depends on WHERE the millisecond
      // counter happened to be: same millisecond → identical middle segment,
      // next second → same head with a different tail, and near a base-36 carry
      // → a different head entirely. Two earlier versions of this test therefore
      // failed intermittently: one truncated to the whole middle segment (ambiguous
      // whenever both rows landed in the same second) and one waited for a
      // millisecond boundary (which put B in the SAME second as A just as often as
      // not). Deriving both prefixes FROM THE ACTUAL IDS makes the preconditions
      // true by construction instead of hoping for a favourable clock.
      const ids = [a.id, b.id];
      // Truncated (drill shape): the SHORTEST prefix of a's id that only a matches.
      let trunc = a.id;
      while (ids.some((id) => id !== a.id && id.startsWith(trunc))) trunc = trunc.slice(0, -1);
      expect(writeupText(U, { id: trunc })).toContain("IDOR A unique");
      // Ambiguous prefix → honest miss: the shortest prefix BOTH rows start with.
      let shared = "";
      for (let n = 1; n <= a.id.length; n++) {
        const p = a.id.slice(0, n);
        if (ids.every((id) => id.startsWith(p))) { shared = p; break; }
      }
      expect(shared).not.toBe("");
      expect(writeupText(U, { id: shared })).toContain("not found");
    } finally {
      const { rmSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { userDataRoot } = await import("./users");
      rmSync(join(userDataRoot(), U), { recursive: true, force: true });
    }
  });
});
