// coverage.test.ts — Strix-adapted coverage ledger, two-way locked.
// FIRE: dishonest/incomplete records are rejected (closing outcomes without
// evidence, unknown outcomes, missing surface/risk_area). SILENT: honest
// records round-trip, dedupe by surface×risk_area, and summarize correctly.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  OUTCOMES_REQUIRING_EVIDENCE,
  canonicalOutcome,
  coverageValidate,
  coverageProgress,
  coverageReportSection,
  listCoverage,
  normalizeSurface,
  outcomeCounts,
  recordCoverage,
  updateCoverage,
} from "./coverage";
import { appRoot } from "./users";

const U = "verify_coverage_ut";
const LAB = "https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app";

beforeAll(() => {
  try {
    rmSync(join(appRoot(), ".data", "users", U), { recursive: true, force: true });
  } catch {
    /* cleanup best-effort */
  }
});

afterAll(() => {
  try {
    rmSync(join(appRoot(), ".data", "users", U), { recursive: true, force: true });
  } catch {
    /* cleanup best-effort */
  }
});

describe("normalizeSurface / canonicalOutcome (pure)", () => {
  it("FIRE: empty input normalizes to empty / unknown outcome to null", () => {
    expect(normalizeSurface("")).toBe("");
    expect(canonicalOutcome("fixed")).toBeNull();
    expect(canonicalOutcome("")).toBeNull();
  });

  it("SILENT: scheme/trailing-slash/case variants collapse onto one key", () => {
    expect(normalizeSurface(`${LAB}/api/cek-nik?id=1`)).toBe(
      "6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app/api/cek-nik?id=1",
    );
    expect(normalizeSurface(`${LAB}/api/cek-nik?id=1/`)).toBe(normalizeSurface(`${LAB}/api/cek-nik?id=1`));
    expect(canonicalOutcome("Ruled-Out")).toBe("ruled_out");
    expect(canonicalOutcome("NO ISSUE FOUND")).toBe("no_issue_found");
  });
});

describe("coverageValidate — closing outcomes REQUIRE evidence (Strix honesty rule)", () => {
  it("FIRE: ruled_out / not_applicable / needs_follow_up without evidence are rejected", () => {
    for (const o of OUTCOMES_REQUIRING_EVIDENCE) {
      expect(coverageValidate({ surface: `${LAB}/api/x`, risk_area: "idor", outcome: o })).toMatch(/WAJIB evidence/i);
    }
  });

  it("FIRE: missing surface/risk_area and unknown outcomes are rejected", () => {
    expect(coverageValidate({ surface: "", risk_area: "idor", outcome: "reported" })).toMatch(/surface wajib/i);
    expect(coverageValidate({ surface: LAB, risk_area: "  ", outcome: "reported" })).toMatch(/risk_area wajib/i);
    expect(coverageValidate({ surface: LAB, risk_area: "idor", outcome: "done" })).toMatch(/outcome harus/i);
  });

  it("SILENT: honest closing records and evidence-free no_issue_found pass", () => {
    expect(
      coverageValidate({ surface: `${LAB}/api/x`, risk_area: "idor", outcome: "ruled_out", evidence: "A/B sessions returned identical 200 — in-token binding" }),
    ).toBeNull();
    expect(coverageValidate({ surface: `${LAB}/api/x`, risk_area: "sqli", outcome: "no_issue_found" })).toBeNull();
  });
});

describe("recordCoverage / updateCoverage / listCoverage (store round-trip)", () => {
  it("FIRE: store layer re-validates — a dishonest record throws and writes nothing", () => {
    expect(() => recordCoverage(U, { surface: `${LAB}/api/x`, risk_area: "idor", outcome: "ruled_out" })).toThrow(/WAJIB evidence/);
    expect(listCoverage(U)).toHaveLength(0);
  });

  it("SILENT: honest records round-trip and dedupe by surface×risk_area", () => {
    const a = recordCoverage(U, { surface: `${LAB}/api/cek-nik?id=1`, risk_area: "IDOR", outcome: "reported", target: LAB });
    const b = recordCoverage(U, { surface: `${LAB}/api/cek-nik?id=1/`, risk_area: "idor", outcome: "no_issue_found", target: LAB });
    expect(b.id).toBe(a.id); // same key → update, not a second row
    expect(b.outcome).toBe("no_issue_found");
    const c = recordCoverage(U, { surface: `${LAB}/api/profil-pegawai?id=1`, risk_area: "idor", outcome: "reported", target: LAB });
    expect(c.id).not.toBe(a.id);
    expect(listCoverage(U, { target: LAB })).toHaveLength(2);
  });

  it("SILENT: updateCoverage patches outcome and enforces evidence on closing outcomes", () => {
    const a = recordCoverage(U, { surface: `${LAB}/api/admin-data`, risk_area: "auth", outcome: "reported", target: LAB });
    expect(() => updateCoverage(U, a.id, { outcome: "not_applicable" })).toThrow(/WAJIB evidence/);
    const patched = updateCoverage(U, a.id, { outcome: "not_applicable", evidence: "endpoint removed from scope by owner" });
    expect(patched.outcome).toBe("not_applicable");
  });
});

describe("summaries (pure)", () => {
  const rows = [
    { surface: "h/a", risk_area: "sqli", outcome: "reported" },
    { surface: "h/b", risk_area: "xss", outcome: "no_issue_found" },
    { surface: "h/c", risk_area: "ssrf", outcome: "ruled_out", evidence: "x" },
    { surface: "h/d", risk_area: "auth", outcome: "needs_follow_up", evidence: "y" },
  ];
  it("FIRE: open work is counted honestly — closed ≠ total", () => {
    const p = coverageProgress(rows as never);
    expect(p).toEqual({ total: 4, closed: 3, open: 1 });
    expect(outcomeCounts(rows as never).reported).toBe(1);
  });

  it("SILENT: report section renders all non-empty outcome groups", () => {
    const sec = coverageReportSection(rows as never);
    expect(sec).toContain("## Coverage");
    expect(sec).toContain("no issue found (1)");
    expect(sec).toContain("needs follow-up (1)");
    expect(sec).toContain("Tested surfaces: 4 (closed 3, open 1)");
  });
});
