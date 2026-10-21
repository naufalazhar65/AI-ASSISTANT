import { describe, it, expect } from "vitest";
import {
  DEFAULT_TEST_USER_TTL_DAYS,
  PROTECTED_USER_KEYS,
  isDisposableTestUser,
  planExpiry,
} from "./testUserCleanup";

describe("isDisposableTestUser", () => {
  it("never disposes the owner, his aliases, the shared bucket or their agent variants", () => {
    for (const key of PROTECTED_USER_KEYS) {
      expect(isDisposableTestUser(key)).toBe(false);
    }
    expect(isDisposableTestUser("shared")).toBe(false);
    // Even a protected key that LOOKS like a test artifact stays protected.
    expect(isDisposableTestUser("verify_naufalazhar652952")).toBe(true);
    expect(isDisposableTestUser("naufalazhar652952.agnes")).toBe(false);
  });

  it("disposes the known test artifact families", () => {
    for (const key of [
      "verify_wf_123",
      "verify_wf_guard_9",
      "wf_test_10270",
      "wf_life_abc",
      "probe_role_gate_1",
      "eval_probe",
      "drill_mia",
      "office_ui",
      "audit23",
      "busproof3",
      "t",
      "u",
      "v",
      "dbg",
    ]) {
      expect(isDisposableTestUser(key)).toBe(true);
    }
  });

  it("keeps every unknown key — an unknown folder is never a guess", () => {
    for (const key of ["customer-42", "Zigen", "naufal", "somebody"]) {
      expect(isDisposableTestUser(key)).toBe(false);
    }
  });
});

describe("planExpiry", () => {
  const now = 1_000_000_000_000;
  const day = 24 * 60 * 60 * 1000;

  it("expires a disposable folder only after the TTL", () => {
    const plan = planExpiry(
      [
        { key: "wf_test_1", mtimeMs: now - (DEFAULT_TEST_USER_TTL_DAYS + 1) * day },
        { key: "wf_test_2", mtimeMs: now - day },
      ],
      { now, ttlMs: DEFAULT_TEST_USER_TTL_DAYS * day },
    );
    expect(plan.expired).toEqual(["wf_test_1"]);
    expect(plan.fresh).toEqual(["wf_test_2"]);
  });

  it("keeps protected keys even when they are old", () => {
    const plan = planExpiry(
      [
        { key: "naufalazhar652952", mtimeMs: 0 },
        { key: "shared", mtimeMs: 0 },
      ],
      { now, ttlMs: day },
    );
    expect(plan.expired).toEqual([]);
    expect(plan.kept).toEqual(["naufalazhar652952", "shared"]);
  });
});
