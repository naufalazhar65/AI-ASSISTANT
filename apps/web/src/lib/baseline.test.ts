// baseline.ts meta-test — the single owner of response comparison.
//
// Three jobs (precision program, 2026-09-28):
// 1. Canonical semantics (copied verbatim from the original owners) still hold.
// 2. Prover equivalence: importing the historical names from the prover modules
//    yields the SAME semantics as before the migration (the nosqlHunt name
//    `classifyOutcome` keeps its Mongo fingerprint arm; the canonical in
//    ./baseline is fingerprint-free).
// 3. Verdict taxonomy: every classification lands in the canonical vocabulary.
import { describe, expect, it } from "vitest";
import {
  normalizeBody,
  bodiesDiffer,
  successish,
  classifyOutcome,
  timingVerdict,
  MIN_DELAY_MS,
  oracleDigest,
} from "./baseline";
import { classifyOutcome as classifyOutcomeViaNosqlHunt, mongoFingerprint } from "./nosqlHunt";

// Shared fixture: the differential matrix every taxonomy/equivalence test runs over.
const MATRIX = [
  { status: 401, location: "", body: "invalid credentials" },
  { status: 200, location: "", body: "welcome" },
  { status: 302, location: "/home", body: "" },
  { status: 500, location: "", body: "boom" },
  { status: 400, location: "", body: "Unexpected token $ in query" },
  { status: 400, location: "", body: "plain validation error" },
  { status: 401, location: "", body: "invalid" },
];

describe("baseline.normalizeBody", () => {
  it("flattens UUIDs and 10-13-digit timestamps", () => {
    expect(normalizeBody("id: 550e8400-e29b-41d4-a716-446655440000")).toBe("id: UUID");
    expect(normalizeBody("ts=1700000000000 ok")).toBe("ts=TS ok");
  });
  it("leaves shorter and longer digit runs alone", () => {
    expect(normalizeBody("n=999999999")).toBe("n=999999999"); // 9 digits
    expect(normalizeBody("n=17000000000000")).toBe("n=17000000000000"); // 14 digits
  });
  it("collapses whitespace", () => {
    expect(normalizeBody("a\n\n  b\t c")).toBe("a b c");
  });
});

describe("baseline.bodiesDiffer (pair-jitter-aware)", () => {
  it("flags a candidate beyond delta vs BOTH baselines when the pair is quiet", () => {
    const quiet = { body: "x".repeat(100) };
    expect(bodiesDiffer(quiet, { body: "x".repeat(100) }, { body: "y".repeat(200) })).toBe(true);
  });
  it("does NOT flag when the baseline pair itself jitters that much", () => {
    const a = { body: "x".repeat(100) };
    const b = { body: "x".repeat(300) };
    expect(bodiesDiffer(a, b, { body: "x".repeat(200) })).toBe(false); // min delta 100 < 2×200
  });
  it("ignores differences that normalize away (UUID/session token)", () => {
    const a = { body: "sid=550e8400-e29b-41d4-a716-446655440000 status ok" };
    const c = { body: "sid=550e8400-e29b-41d4-a716-446655440001 status ok" };
    expect(bodiesDiffer(a, a, c)).toBe(false);
  });
});

describe("baseline.successish", () => {
  it("2xx yes; 3xx only with a Location; 4xx/5xx no", () => {
    expect(successish(200, "")).toBe(true);
    expect(successish(302, "/home")).toBe(true);
    expect(successish(302, "")).toBe(false);
    expect(successish(401, "")).toBe(false);
    expect(successish(500, "")).toBe(false);
  });
});

describe("baseline.classifyOutcome (canonical, fingerprint-free)", () => {
  const deny = { status: 401, location: "" };
  it("lead only on success-ish where the baseline denied", () => {
    expect(classifyOutcome(deny, { status: 200, location: "", body: "welcome" })).toBe("lead");
    expect(classifyOutcome(deny, { status: 302, location: "/home", body: "" })).toBe("lead");
  });
  it("info on 5xx regardless of fingerprint", () => {
    expect(classifyOutcome(deny, { status: 500, location: "", body: "boom" })).toBe("info");
  });
  it("no error-text info arm without a fingerprint function", () => {
    expect(classifyOutcome(deny, { status: 400, location: "", body: "Unexpected token $" })).toBe("none");
  });
  it("info on a new status carrying a fingerprint when one is supplied", () => {
    const fp = (body: string) => (/Unexpected token/.test(body) ? "SyntaxError" : null);
    expect(classifyOutcome(deny, { status: 400, location: "", body: "Unexpected token $" }, fp)).toBe("info");
  });
  it("none on same-as-baseline and on any zero status", () => {
    expect(classifyOutcome(deny, { status: 401, location: "", body: "invalid" })).toBe("none");
    expect(classifyOutcome({ status: 0, location: "" }, { status: 200, location: "", body: "" })).toBe("none");
  });
});

describe("prover equivalence — historical names keep historical semantics", () => {
  const base = { status: 401, location: "" };
  it("nosqlHunt's classifyOutcome == canonical + mongoFingerprint arm", () => {
    for (const hit of MATRIX) {
      expect(classifyOutcomeViaNosqlHunt(base, hit)).toBe(
        classifyOutcome(base, hit, mongoFingerprint)
      );
    }
  });
  it("the fingerprint arm fires exactly where Mongo error text exists", () => {
    expect(classifyOutcomeViaNosqlHunt(base, MATRIX[4])).toBe("info");
    expect(classifyOutcomeViaNosqlHunt(base, MATRIX[5])).toBe("none");
  });
});

describe("verdict taxonomy — classifications land in the canonical vocabulary", () => {
  it("every matrix verdict is one of lead|info|none", () => {
    const base = { status: 401, location: "" };
    const vocab = ["lead", "info", "none"] as const;
    for (const hit of MATRIX) {
      expect(vocab).toContain(classifyOutcomeViaNosqlHunt(base, hit));
    }
  });
});

describe("baseline.timingVerdict (jitter-aware, copied from blindCmdi)", () => {
  it("leads only past min-delay, 3× average AND 3× jitter", () => {
    // avg 1100, jitter 200 → need delta ≥ 5000, > 3300, delta > 600
    expect(timingVerdict(1000, 1200, 6200).lead).toBe(true);
  });
  it("rejects sub-threshold and jitter-explained deltas", () => {
    expect(timingVerdict(1000, 1200, 4000).lead).toBe(false); // delta 2900 < 5000
    expect(timingVerdict(1000, 1200, 5600).lead).toBe(false); // delta 4500 < 5000
  });
  it("exports the documented minimum", () => {
    expect(MIN_DELAY_MS).toBe(5000);
  });
});

describe("baseline.oracleDigest (otpProbe rule)", () => {
  it("digits become N so volatile numbers compare equal", () => {
    expect(oracleDigest("code 123456 tried at 10:01")).toBe(oracleDigest("code 654321 tried at 23:59"));
  });
  it("caps at 200 chars", () => {
    expect(oracleDigest("a".repeat(500)).length).toBe(200);
  });
});
