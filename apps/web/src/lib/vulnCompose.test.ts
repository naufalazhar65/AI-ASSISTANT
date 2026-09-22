// Unit tests for vulnCompose pure helpers (no network).
import { describe, expect, it } from "vitest";
import { composeHop, composeHops, composeVerdict, extractSignals, findingHost, isPocStable, type ComposeHop } from "./vulnCompose";
import type { Finding } from "./security";

function mkFinding(over: Partial<Finding> & { id: string }): Finding {
  return {
    title: "t", severity: "high", cvss: 8.1, owasp: "", cwe: "", target: "",
    evidence: "", steps: "", impact: "", rootCause: "", remediation: "",
    references: "", status: "open", createdAt: new Date().toISOString(), ...over,
  };
}

describe("findingHost", () => {
  it("reads host from target first", () => {
    expect(findingHost(mkFinding({ id: "a", target: "https://lab.tld/api/x" }))).toBe("lab.tld");
  });
  it("falls back to evidence", () => {
    expect(findingHost(mkFinding({ id: "a", evidence: "GET https://lab.tld/a → 200" }))).toBe("lab.tld");
  });
  it("empty when no url", () => {
    expect(findingHost(mkFinding({ id: "a", evidence: "no urls here" }))).toBe("");
  });
});

describe("extractSignals", () => {
  it("extracts paths, params, ids", () => {
    const s = extractSignals(mkFinding({ id: "a", evidence: "GET https://lab.tld/api/dokumen?id=3 → 200 [auto from http_history] GET https://lab.tld/api/dokumen?id=3 → 200" }));
    expect(s.paths).toContain("/api/dokumen");
    expect(s.params).toContain("id");
    expect(s.ids.some((i) => i.includes("3"))).toBe(true);
  });
});

describe("composeHop", () => {
  it("links findings sharing host + param", () => {
    const a = mkFinding({ id: "F-a", target: "https://lab.tld/api/dokumen?id=1", evidence: "[auto from http_history] GET https://lab.tld/api/dokumen?id=1 → 200" });
    const b = mkFinding({ id: "F-b", target: "https://lab.tld/api/dokumen?id=2", steps: "ubah id=2 lalu baca" });
    const hop = composeHop(a, b);
    expect(hop).not.toBeNull();
    expect(hop!.kind).toBe("param");
    expect(hop!.shared).toContain("id");
  });
  it("refuses different hosts", () => {
    const a = mkFinding({ id: "F-a", target: "https://a.tld/x?id=1" });
    const b = mkFinding({ id: "F-b", target: "https://b.tld/x?id=1" });
    expect(composeHop(a, b)).toBeNull();
  });
  it("refuses host-only overlap (no concrete artifact)", () => {
    const a = mkFinding({ id: "F-a", target: "https://lab.tld/satu" });
    const b = mkFinding({ id: "F-b", target: "https://lab.tld/dua" });
    expect(composeHop(a, b)).toBeNull();
  });
});

describe("composeHops + composeVerdict", () => {
  it("chains consecutive pairs, verdict gates on proven", () => {
    const fs = [
      mkFinding({ id: "F-1", target: "https://lab.tld/a?x=1", createdAt: "2026-01-01T00:00:00Z" }),
      mkFinding({ id: "F-2", target: "https://lab.tld/b?x=2", createdAt: "2026-01-02T00:00:00Z" }),
      mkFinding({ id: "F-3", target: "https://other.tld/c?x=3", createdAt: "2026-01-03T00:00:00Z" }),
    ];
    const hops = composeHops(fs);
    expect(hops).toHaveLength(1);
    expect(composeVerdict([]).verdict).toBe("TAK TERSAMBUNG");
    const unproven: ComposeHop[] = [{ ...hops[0], proven: false }];
    expect(composeVerdict(unproven)).toMatchObject({ verdict: "PUTUS", brokenAt: 0 });
    const proven: ComposeHop[] = [{ ...hops[0], proven: true }];
    expect(composeVerdict(proven)).toMatchObject({ verdict: "TERBUKTI PENUH", brokenAt: -1 });
  });
});

describe("isPocStable", () => {
  it("matches the pocVerify success verdict only", () => {
    expect(isPocStable("✅ PoC STABIL & terkonfirmasi (3/3 assertion PASS)")).toBe(true);
    expect(isPocStable("❌ PoC TIDAK stabil")).toBe(false);
    expect(isPocStable("⚠️ PoC deterministik tapi assertion belum terpenuhi")).toBe(false);
  });
});
