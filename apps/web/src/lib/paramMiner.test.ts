// paramMiner.test.ts — pure helpers of the param_miner prover.
import { describe, it, expect } from "vitest";
import { normalizeBody, diffVerdict, withParam, CANDIDATE_PARAMS, CANDIDATE_HEADERS } from "./paramMiner";

const R = (status: number, body: string, headers: Record<string, string> = {}) => ({ status, body, headers });

describe("normalizeBody", () => {
  it("flattens volatile values (uuid, timestamps, whitespace)", () => {
    const a = "req=550e8400-e29b-41d4-a716-446655440000 at 1727123456789  ok";
    const b = "req=ffffffff-ffff-ffff-ffff-ffffffffffff at 1727123999999\nok";
    expect(normalizeBody(a)).toBe(normalizeBody(b));
  });
});

describe("diffVerdict", () => {
  const base = () => R(200, "<html>page body exactly the same</html>");

  it("leads on a status change neither baseline showed", () => {
    const v = diffVerdict(base(), base(), R(500, "internal error"));
    expect(v.lead).toBe(true);
    expect(v.reason).toContain("status");
  });

  it("leads on a large stable body change", () => {
    const big = "<html>" + "x".repeat(300) + "</html>";
    const v = diffVerdict(base(), base(), R(200, big));
    expect(v.lead).toBe(true);
  });

  it("stays silent on pair jitter (baselines disagree already)", () => {
    const a = R(200, "<html>" + "a".repeat(200) + "</html>");
    const b = R(200, "<html>" + "b".repeat(300) + "</html>");
    const v = diffVerdict(a, b, R(200, "<html>" + "c".repeat(340) + "</html>"));
    // candidate differs by ~40-140 bytes; baselines differ by 100 — must NOT lead
    expect(v.lead).toBe(false);
  });

  it("leads on a brand-new notable header", () => {
    const v = diffVerdict(base(), base(), R(200, "<html>page body exactly the same</html>", { "x-debug": "1" }));
    expect(v.lead).toBe(true);
    expect(v.reason).toContain("x-debug");
  });

  it("stays silent when identical to baseline", () => {
    expect(diffVerdict(base(), base(), base()).lead).toBe(false);
  });
});

describe("withParam", () => {
  it("appends the candidate param", () => {
    const u = withParam(new URL("http://x.test/a?b=1"), "debug", "1");
    expect(u).toContain("b=1");
    expect(u).toContain("debug=1");
  });
});

describe("candidate lists", () => {
  it("are behavior-shaped and deduped", () => {
    expect(new Set(CANDIDATE_PARAMS).size).toBe(CANDIDATE_PARAMS.length);
    expect(new Set(CANDIDATE_HEADERS).size).toBe(CANDIDATE_HEADERS.length);
    expect(CANDIDATE_PARAMS).toContain("debug");
    expect(CANDIDATE_HEADERS).toContain("x-original-url");
  });
});
