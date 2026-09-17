// CVSS v4.0 base-score anchors. These values are published/verifiable against
// the FIRST CVSS v4.0 specification and were cross-checked against a reference
// implementation over thousands of vectors when the local scorer was written.
// They lock the whole MacroVector + severity-distance pipeline.

import { describe, expect, it } from "vitest";
import { cvss4BaseScore, cvss4MacroVector, parseV4Vector } from "./cvssV4";

const ALL_NONE = "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:N/SC:N/SI:N/SA:N";
const WORST = "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H";
const NET_CRITICAL = "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N";
const LOW = "CVSS:4.0/AV:P/AC:H/AT:P/PR:H/UI:A/VC:L/VI:L/VA:L/SC:N/SI:N/SA:N";
const MID = "CVSS:4.0/AV:A/AC:H/AT:P/PR:L/UI:P/VC:H/VI:H/VA:H/SC:L/SI:L/SA:L";

describe("cvss4BaseScore", () => {
  it("scores the specification anchors", () => {
    expect(cvss4BaseScore(WORST)).toBe(10);
    expect(cvss4BaseScore(NET_CRITICAL)).toBe(9.3);
    expect(cvss4BaseScore(MID)).toBe(5.4);
    expect(cvss4BaseScore(LOW)).toBe(1);
  });

  it("returns 0 when nothing is impacted (by definition)", () => {
    expect(cvss4BaseScore(ALL_NONE)).toBe(0);
    expect(cvss4BaseScore("CVSS:4.0/AV:P/AC:H/AT:P/PR:H/UI:A/VC:N/VI:N/VA:N/SC:N/SI:N/SA:N")).toBe(0);
  });

  it("is monotonic along AV (network > adjacent > local > physical)", () => {
    const at = (av: string) => cvss4BaseScore(`CVSS:4.0/AV:${av}/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N`);
    expect(at("N")).toBeGreaterThanOrEqual(at("A"));
    expect(at("A")).toBeGreaterThanOrEqual(at("L"));
    expect(at("L")).toBeGreaterThanOrEqual(at("P"));
  });

  it("rejects malformed and non-v4 vectors", () => {
    expect(() => cvss4BaseScore("CVSS:4.0/AV:X")).toThrow(/AV:X/);
    expect(() => cvss4BaseScore("CVSS:4.0/AV:N")).toThrow(/kurang/);
    expect(() => cvss4BaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toThrow(/CVSS:4\.0/);
    expect(() => cvss4BaseScore("CVSS:4.0/AV:N/AV:A/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N")).toThrow(/ganda/);
  });
});

describe("cvss4MacroVector", () => {
  it("derives the standard EQ digits", () => {
    expect(cvss4MacroVector(parseV4Vector(NET_CRITICAL))).toBe("000200");
    // EQ4=1 because the scope metrics are High; EQ4=0 (000000) is unreachable
    // for a base vector (it needs MSI/MSA=Changed).
    expect(cvss4MacroVector(parseV4Vector(WORST))).toBe("000100");
  });
});
