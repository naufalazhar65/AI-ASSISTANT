// chainDedupGate unit tests (precision #4, 2026-09-28).
//
// The gate turns hunt_log/target_brain memory into code (not prompt advice):
// `dead` SKIPS the chain (zero requests — the honest ⛔ contract), while
// lead/finding/brain-proof only annotate the run. The asymmetry matters: a
// false skip = a missed bug, so only `dead` gates.
import { describe, expect, it, afterAll } from "vitest";
import { chainDedupGate, recordChainOutcome } from "./exploitChains";
import { readHunt, huntSet, normalizeTarget } from "./huntLog";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { userDataRoot } from "./users";

describe("chainDedupGate — only `dead` gates", () => {
  it("dead → honest skip naming the status and the no-re-tread reason", () => {
    const g = chainDedupGate("dead", "");
    expect(g.skip).toBe(true);
    expect(g.note).toContain("DEAD");
    expect(g.note).toContain("dilewati");
  });
  it("lead → runs, with a verify-the-lead-first note", () => {
    const g = chainDedupGate("lead", "");
    expect(g.skip).toBe(false);
    expect(g.note).toContain("LEAD");
    expect(g.note).toContain("poc_verify");
  });
  it("finding → runs, pointing at the recorded finding", () => {
    const g = chainDedupGate("finding", "");
    expect(g.skip).toBe(false);
    expect(g.note).toContain("FINDING");
  });
  it("testing/todo/unknown statuses never gate", () => {
    for (const st of ["testing", "todo", "", undefined, "weird"]) {
      expect(chainDedupGate(st as string | undefined, "").skip).toBe(false);
    }
  });
  it("brain proof alone → context note, never a skip", () => {
    const g = chainDedupGate(undefined, "BOLA /api/x (via bola_diff, high)");
    expect(g.skip).toBe(false);
    expect(g.note).toContain("terbukti sebelumnya");
    expect(g.note).toContain("BOLA /api/x");
  });
  it("clean state (no hunt entry, no proof) is silent", () => {
    expect(chainDedupGate(undefined, "")).toEqual({ skip: false, note: "" });
  });
  it("lead + proof combine into one note line", () => {
    const g = chainDedupGate("lead", "XSS /q (via param_fuzz, medium)");
    expect(g.skip).toBe(false);
    expect(g.note).toContain("LEAD");
    expect(g.note).toContain("terbukti sebelumnya");
  });
});

describe("recordChainOutcome (exported for tests) — asymmetric recording", () => {
  const U = `verify_recorder_${Date.now()}`;
  const T = "recorder.test.tld/api/x";
  afterAll(() => {
    // Independence: this describe owns its run-unique user store — remove it whole.
    try { rmSync(join(userDataRoot(), U), { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("LEAD markers (🎯, LEAD, TERKONFIRMASI, STRONG) record hunt_log lead with the first marker line as note", () => {
    recordChainOutcome(U, "bypass403", T, "✅ BYPASS LEAD: 200, 18b — body berbeda dari halaman deny");
    const e = readHunt(U).find((x) => x.target === normalizeTarget(T));
    expect(e?.status).toBe("lead");
    expect(e?.note).toContain("bypass403: LEAD");
  });
  it("explicit no-signal verdicts record dead — generic 'tidak ada' phrasing NEVER does", () => {
    recordChainOutcome(U, "otp", T, "TIDAK ADA SINYAL — payload identik dengan baseline");
    expect(readHunt(U).find((x) => x.target === normalizeTarget(T))?.status).toBe("dead");
    recordChainOutcome(U, "otp", T, "Tidak ada indikasi apa pun di respons (halaman statis).");
    expect(readHunt(U).find((x) => x.target === normalizeTarget(T))?.status).toBe("dead"); // unchanged dead from the explicit verdict above
  });
  it("mixed/garbage output records NOTHING (fail-open, never a false dead)", () => {
    const before = readHunt(U).length;
    recordChainOutcome(U, "otp", T, "Baseline gagal jaringan — tidak bisa dinilai.");
    recordChainOutcome(U, "otp", T, "");
    expect(readHunt(U).length).toBe(before);
  });
  it("LEAD outranks a co-occurring dead-phrase (the worse error is a false dead)", () => {
    recordChainOutcome(U, "bypass403", T, "🎯 SSRF LEADS: param url — tapi tidak ada auth-bypass lead di lengan lain");
    expect(readHunt(U).find((x) => x.target === normalizeTarget(T))?.status).toBe("lead");
  });
  it("records are per-user (the drill's USER store, not shared)", () => {
    expect(readHunt("shared").some((x) => x.target === normalizeTarget(T))).toBe(false);
  });
});
