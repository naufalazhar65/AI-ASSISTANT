// Unit tests for otpProbe pure helpers (no network).
import { describe, expect, it } from "vitest";
import { rateLimitVerdict, oracleSignatures, otpEntropy } from "./otpProbe";

describe("rateLimitVerdict", () => {
  it("all normal denies = absent (the lead)", () => {
    const r = rateLimitVerdict([401, 401, 401, 401, 401, 401], Array(6).fill('{"error":"invalid code"}'));
    expect(r.kind).toBe("absent");
    expect(r.detail).toContain("NO-RATE-LIMIT");
  });

  it("explicit 429 or lockout copy = seen (control exists)", () => {
    expect(rateLimitVerdict([401, 429], ["no", "too many attempts"]).kind).toBe("seen");
    expect(rateLimitVerdict([401, 401], ["no", "account locked"]).kind).toBe("seen");
    expect(rateLimitVerdict([401, 423], ["no", "locked"]).kind).toBe("seen");
  });

  it("network failures = mixed (inconclusive)", () => {
    expect(rateLimitVerdict([0, 0], ["", ""]).kind).toBe("mixed");
    expect(rateLimitVerdict([401, 0], ["no", ""]).kind).toBe("mixed");
  });

  it("Indonesian throttle copy is recognized", () => {
    expect(rateLimitVerdict([401, 401], ["no", "terlalu banyak percobaan, coba lagi nanti"]).kind).toBe("seen");
  });
});

describe("oracleSignatures", () => {
  const BASE = { status: 401, body: '{"error":"invalid code"}', headers: {}, ms: 5 };

  it("no differences = no oracle", () => {
    const r = oracleSignatures(BASE, [BASE, BASE, BASE]);
    expect(r.diffIdx).toEqual([]);
    expect(r.successLike).toEqual([]);
  });

  it("a 2xx different response is success-like", () => {
    const r = oracleSignatures(BASE, [BASE, { status: 200, body: '{"ok":true}', headers: {}, ms: 5 }, BASE]);
    expect(r.diffIdx).toEqual([1]);
    expect(r.successLike).toEqual([1]);
  });

  it("a different DENY copy is an oracle but NOT success-like (expired vs invalid)", () => {
    const r = oracleSignatures(BASE, [{ status: 401, body: '{"error":"code expired"}', headers: {}, ms: 5 }]);
    expect(r.diffIdx).toEqual([0]);
    expect(r.successLike).toEqual([]);
  });

  it("number normalization: a changed counter is not a difference", () => {
    const r = oracleSignatures(BASE, [{ status: 401, body: '{"error":"invalid code","attempt":2}', headers: {}, ms: 5 }]);
    // attempt number normalizes to N but the KEY still differs -> diff. Use a body with only the number changing:
    const r2 = oracleSignatures({ status: 401, body: '{"error":"invalid code","attempt":1}', headers: {}, ms: 5 }, [{ status: 401, body: '{"error":"invalid code","attempt":9}', headers: {}, ms: 5 }]);
    expect(r.diffIdx.length).toBe(1); // new key
    expect(r2.diffIdx).toEqual([]); // same shape, only digits differ
  });

  it("throttle copy that happens to be 2xx is not success-like", () => {
    const r = oracleSignatures(BASE, [{ status: 200, body: "too many attempts, wait", headers: {}, ms: 5 }]);
    expect(r.diffIdx).toEqual([0]);
    expect(r.successLike).toEqual([]);
  });
});

describe("otpEntropy", () => {
  it("4-digit numeric = LEMAH", () => {
    const r = otpEntropy(["1234", "5678", "9012", "3456"]);
    expect(r.bits).toBeCloseTo(13.3, 0);
    expect(r.verdict).toContain("LEMAH");
  });

  it("6-digit numeric = feasible without rate limit", () => {
    const r = otpEntropy(["123456", "234567", "345678"]);
    expect(r.bits).toBeCloseTo(19.9, 0);
    expect(r.verdict).toContain("feasible");
  });

  it("repeats in a small sample flag weak rotation", () => {
    const r = otpEntropy(["111111", "111111", "111111", "111111"]);
    expect(r.verdict).toContain("duplikat");
  });

  it("inconsistent lengths are reported honestly", () => {
    expect(otpEntropy(["1234", "12345"]).verdict).toContain("tidak konsisten");
  });

  it("non-numeric codes are reported honestly", () => {
    expect(otpEntropy(["AB12", "CD34"]).verdict).toContain("non-numerik");
  });

  it("no samples = ask for them", () => {
    expect(otpEntropy([]).verdict).toContain("sample");
  });
});
