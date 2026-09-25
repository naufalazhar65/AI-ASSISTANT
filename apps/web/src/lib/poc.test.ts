// poc.test.ts — the PoC verdict must not sell determinism as proof.
//
// Live bug 2026-09-25: the model tested ?id=1;-- - on the owner's lab. The clean
// ?id=1 returned the SAME 292 bytes, the real SQLi payload (?id=1' OR '1'='1) was
// 404, yet poc_verify printed "✅ PoC STABIL & terkonfirmasi — layak dilaporkan"
// and a HIGH CWE-89 finding was recorded. Two defects, both covered here:
//   1. the baseline comparison looked at STATUS only, and being identical it
//      printed "SAMA (tidak ada sinyal)" as a mere info line that never gated the
//      verdict — so it could not tell "payload changed nothing" from "confirmed";
//   2. it could not see a real same-status BOLA either, because the BODY was
//      never compared (false negative in the other direction).
import { describe, expect, it } from "vitest";
import { baselineComparison, cookieMissingFlags, pocVerdict } from "./poc";

const run = (status: number, len: number, digest: string) => ({ status, len, digest });

describe("baselineComparison", () => {
  it("flags the live drill case: same status AND same body → no differential", () => {
    const c = baselineComparison(run(200, 292, "aaaa"), run(200, 292, "aaaa"));
    expect(c.ran).toBe(true);
    expect(c.statusDiffers).toBe(false);
    expect(c.bodyDiffers).toBe(false);
    expect(c.differs).toBe(false);
  });

  it("catches a real same-status BOLA (body differs, status identical)", () => {
    const c = baselineComparison(run(200, 292, "aaaa"), run(200, 292, "bbbb"));
    expect(c.differs).toBe(true);
    expect(c.statusDiffers).toBe(false);
    expect(c.bodyDiffers).toBe(true);
  });

  it("catches an authorization delta (status differs)", () => {
    const c = baselineComparison(run(200, 292, "aaaa"), run(403, 9, "cccc"));
    expect(c.differs).toBe(true);
    expect(c.statusDiffers).toBe(true);
  });

  it("treats a failed run as no control at all (never as 'identical')", () => {
    expect(baselineComparison(run(200, 292, "aaaa"), run(0, 0, "")).ran).toBe(false);
    expect(baselineComparison(undefined, run(200, 292, "aaaa")).ran).toBe(false);
    expect(
      baselineComparison(run(200, 292, "aaaa"), { status: 0, len: 0, digest: "", error: "timeout" }).ran
    ).toBe(false);
  });
});

describe("pocVerdict — a ✅ must be earned", () => {
  const base = { stable: true, assertsOk: true, assertionsGiven: true, dynamicBytes: false };

  it("refuses to confirm when the control is byte-identical (the drill case)", () => {
    const v = pocVerdict({
      ...base,
      runs: [run(200, 292, "aaaa")],
      baseline: { given: true, ran: true, differs: false, status: 200, len: 292 },
    });
    expect(v).toMatch(/TIDAK ADA SINYAL/);
    expect(v).toMatch(/bukan bukti/i);
    // compose relies on this: an unchanged payload must never read as proven.
    expect(v).not.toContain("PoC STABIL");
  });

  it("confirms only when the control actually differs", () => {
    const v = pocVerdict({
      ...base,
      runs: [run(200, 292, "aaaa")],
      baseline: { given: true, ran: true, differs: true, status: 403, len: 9 },
    });
    expect(v).toContain("PoC STABIL");
    expect(v).toMatch(/differential/);
  });

  it("stays honest when the control itself failed to run", () => {
    const v = pocVerdict({
      ...base,
      runs: [run(200, 292, "aaaa")],
      baseline: { given: true, ran: false, differs: false, status: 0, len: 0 },
    });
    expect(v).toMatch(/baseline gagal dijalankan/);
    expect(v).not.toContain("PoC STABIL");
  });

  it("without a control, an explicit assertion is the minimum bar", () => {
    expect(pocVerdict({ ...base, runs: [run(200, 10, "d")], baseline: null })).toContain("PoC STABIL");
  });

  it("repetition alone is never proof (no assertion, no baseline)", () => {
    const v = pocVerdict({ ...base, assertionsGiven: false, runs: [run(200, 10, "d")], baseline: null });
    expect(v).toMatch(/pengulangan BUKAN bukti/i);
    expect(v).not.toContain("PoC STABIL");
  });

  it("reports instability before anything else", () => {
    const v = pocVerdict({
      ...base,
      stable: false,
      reproducibleOnly: true,
      runs: [run(200, 10, "d")],
      baseline: { given: true, ran: true, differs: true, status: 403, len: 9 },
    });
    expect(v).toMatch(/TIDAK stabil/);
  });

  it("reports a failed assertion as such", () => {
    const v = pocVerdict({ ...base, assertsOk: false, runs: [run(403, 9, "d")], baseline: null });
    expect(v).toMatch(/assertion belum terpenuhi/);
  });

  it("reproducible_only claims reproduction, NOT a vulnerability", () => {
    const v = pocVerdict({ ...base, reproducibleOnly: true, runs: [run(200, 292, "a")], baseline: null });
    expect(v).toContain("PoC ULANG STABIL");
    expect(v).toMatch(/BUKAN bukti kerentanan/i);
    expect(v).not.toMatch(/layak dilaporkan/);
    // ...and compose's reader still accepts it as a reproducible hop.
    expect(/PoC (?:ULANG )?STABIL/.test(v)).toBe(true);
  });
});

describe("cookieMissingFlags", () => {
  it("detects a flag missing on the named cookie", () => {
    expect(cookieMissingFlags(["session=abc; Path=/; Secure"], "session", ["httponly"])).toBe(true);
  });

  it("is not masked by a sibling cookie that does have the flag", () => {
    const jars = ["other=1; Path=/; HttpOnly", "session=abc; Path=/"];
    expect(cookieMissingFlags(jars, "session", ["httponly"])).toBe(true);
  });

  it("stays silent when the named cookie carries the flag", () => {
    expect(cookieMissingFlags(["session=abc; Path=/; HttpOnly"], "session", ["httponly"])).toBe(false);
  });

  it("never fires when the cookie is absent", () => {
    expect(cookieMissingFlags(["other=1"], "session", ["httponly"])).toBe(false);
  });
});
