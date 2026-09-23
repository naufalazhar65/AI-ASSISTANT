// Unit tests for teamcityCheck pure helpers (no network).
import { describe, expect, it } from "vitest";
import {
  assessTeamCityVersion,
  cmpTeamCityVersion,
  isTeamCityPage,
  parseTeamCityVersion,
} from "./teamcityCheck";

describe("parseTeamCityVersion", () => {
  it("reads TeamCity login variants + build", () => {
    expect(parseTeamCityVersion("<title>TeamCity 2026.1.2 (build 166000) Login</title>")).toMatchObject({
      year: 2026, minor: 1, patch: 2, build: "166000",
    });
    expect(parseTeamCityVersion("TeamCity Professional 2025.11.6")).toMatchObject({
      year: 2025, minor: 11, patch: 6,
    });
    expect(parseTeamCityVersion("Version: 2026.1.3")).toMatchObject({ year: 2026, minor: 1, patch: 3 });
    expect(parseTeamCityVersion("<p>hello world</p>")).toBeNull();
  });
});

describe("cmpTeamCityVersion", () => {
  it("orders triples numerically", () => {
    expect(cmpTeamCityVersion({ year: 2026, minor: 1, patch: 2 }, { year: 2026, minor: 1, patch: 3 })).toBeLessThan(0);
    expect(cmpTeamCityVersion({ year: 2026, minor: 1, patch: 3 }, { year: 2026, minor: 1, patch: 3 })).toBe(0);
    expect(cmpTeamCityVersion({ year: 2026, minor: 2, patch: 0 }, { year: 2026, minor: 1, patch: 9 })).toBeGreaterThan(0);
  });
});

describe("assessTeamCityVersion", () => {
  const v = (year: number, minor: number, patch: number) => ({ year, minor, patch, raw: "x" });
  it("flags below-line versions VULNERABLE, at/above PATCHED", () => {
    expect(assessTeamCityVersion(v(2026, 1, 2)).verdict).toBe("VULNERABLE");
    expect(assessTeamCityVersion(v(2026, 1, 3)).verdict).toBe("PATCHED");
    expect(assessTeamCityVersion(v(2025, 11, 6)).verdict).toBe("VULNERABLE");
    expect(assessTeamCityVersion(v(2025, 11, 7)).verdict).toBe("PATCHED");
  });
  it("older lines have no patch: VULNERABLE with honest reason", () => {
    const r = assessTeamCityVersion(v(2024, 12, 5));
    expect(r.verdict).toBe("VULNERABLE");
    expect(r.reason).toMatch(/tidak ada patch/);
  });
  it("newer lines assumed patched", () => {
    expect(assessTeamCityVersion(v(2026, 2, 0)).verdict).toBe("PATCHED");
  });
});

describe("isTeamCityPage", () => {
  it("needs TeamCity + a second marker", () => {
    expect(isTeamCityPage("<title>TeamCity Login</title>/app/agents/v1")).toBe(true);
    expect(isTeamCityPage("TeamCity 2026.1.2")).toBe(true);
    expect(isTeamCityPage("my teamcity fan blog")).toBe(false);
    expect(isTeamCityPage("<h1>nginx welcome</h1>")).toBe(false);
  });
});
