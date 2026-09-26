// threatModel.test.ts — Strix-adapted threat models, two-way locked.
// FIRE: incomplete models (missing/trivial sections) and short amendments are
// rejected. SILENT: a complete model round-trips, merges section updates,
// renders, and feeds the report section.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MIN_SECTION_CHARS,
  SECTION_LABEL,
  amendThreatModel,
  getThreatModel,
  missingSections,
  renderThreatModel,
  saveThreatModel,
  threatModelReportSection,
} from "./threatModel";
import { appRoot } from "./users";

const U = "verify_threatmodel_ut";
const LAB = "https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app";

const FULL_SECTIONS = {
  overview: "Village portal with public complaint API and internal documents.",
  trust_boundaries: "Anonymous web user → public API; staff session → internal documents.",
  attack_surface: "/api/cek-nik, /api/dokumen, /api/pengaduan, /login.",
  severity_calibration: "Public unauthenticated data exposure is critical; stored XSS medium given admin review flow.",
};

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

describe("missingSections (pure)", () => {
  it("FIRE: missing and placeholder sections are named", () => {
    expect(missingSections({})).toEqual(["overview", "trust_boundaries", "attack_surface", "severity_calibration"]);
    expect(missingSections({ overview: "too short" })).toContain("overview");
    expect(missingSections({ overview: "x".repeat(MIN_SECTION_CHARS) })).not.toContain("overview");
  });

  it("SILENT: a complete model reports no missing sections", () => {
    expect(missingSections(FULL_SECTIONS)).toEqual([]);
  });
});

describe("saveThreatModel / getThreatModel (store)", () => {
  it("FIRE: saving an incomplete model throws and persists nothing", () => {
    expect(() => saveThreatModel(U, LAB, { overview: "just the overview" })).toThrow(/threat model belum lengkap/);
    expect(getThreatModel(U, LAB)).toBeNull();
  });

  it("FIRE: a target without a host is rejected", () => {
    expect(() => saveThreatModel(U, "", FULL_SECTIONS)).toThrow(/target wajib/);
  });

  it("SILENT: complete model round-trips; section updates MERGE, not replace", () => {
    const m1 = saveThreatModel(U, LAB, FULL_SECTIONS);
    expect(m1.id).toMatch(/^TM-/);
    expect(getThreatModel(U, LAB)?.host).toBe("6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app");
    const m2 = saveThreatModel(U, `${LAB}/api/x`, { attack_surface: "updated: adds /api/admin-data found during recon." });
    expect(m2.id).toBe(m1.id);
    expect(m2.sections.overview).toBe(FULL_SECTIONS.overview);
    expect(m2.sections.attack_surface).toContain("/api/admin-data");
  });

  it("SILENT: amendments require substance and are appended", () => {
    expect(() => amendThreatModel(U, LAB, "ok")).toThrow(/amendment terlalu pendek/);
    const m = amendThreatModel(U, LAB, "Found /api/admin-data during sweep — added to attack surface, no trust change.");
    expect(m.amendments).toHaveLength(1);
    expect(m.amendments[0].text).toContain("/api/admin-data");
  });
});

describe("rendering (pure)", () => {
  it("SILENT: renderThreatModel carries all four labeled sections + amendments", () => {
    const m = getThreatModel(U, LAB) as NonNullable<ReturnType<typeof getThreatModel>>;
    const md = renderThreatModel(m);
    for (const s of Object.keys(SECTION_LABEL)) expect(md).toContain(SECTION_LABEL[s as keyof typeof SECTION_LABEL]);
    expect(md).toContain("Amendments");
    expect(md).toContain("Village portal");
  });

  it("SILENT: report section is a compact one-block summary", () => {
    const m = getThreatModel(U, LAB) as NonNullable<ReturnType<typeof getThreatModel>>;
    const sec = threatModelReportSection(m);
    expect(sec).toContain("## Threat model");
    expect(sec).toContain("**Overview**:");
    expect(sec).toContain("Severity calibration");
  });
});
