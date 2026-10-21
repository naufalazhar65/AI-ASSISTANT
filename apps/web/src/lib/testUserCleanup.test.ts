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

  it("keeps a real user whose name merely STARTS with a test stem", () => {
    // A cleanup that deletes a person is worse than one that leaves an
    // artifact behind: "eval_team", "prober" and "drillmaster" read like
    // people, so the stem alone never disposes a folder.
    for (const key of ["eval_team", "evalteam", "prober", "drillmaster", "verification_user"]) {
      expect(isDisposableTestUser(key)).toBe(false);
    }
    // The bare stems are artifacts only as EXACT names.
    for (const key of ["eval", "probe", "drill", "verify"]) {
      expect(isDisposableTestUser(key)).toBe(true);
    }
    // A stem plus a machine-made remainder IS an artifact.
    for (const key of ["verify_wf_9", "verify_retry_a5_1792", "probe_role_gate_1", "eval_probe2"]) {
      expect(isDisposableTestUser(key)).toBe(true);
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
