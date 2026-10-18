import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { userDataRoot } from "../users";
import {
  approvalFingerprint,
  attemptFingerprint,
  canPsTransition,
  classifyFailure,
  computeLoopMetrics,
  decideRecovery,
  detectLoop,
  errorLine,
  evaluateCriteria,
  fileProber,
  isNonRetryable,
  markSessionActive,
  newSession,
  readSessions,
  reconcileSessions,
  recordAttempt,
  releaseSession,
  renderMetricsLine,
  renderPsReport,
  saveSession,
} from "./index";
import { DEFAULT_RECOVERY_BUDGET, type PsAttempt, type RecoveryBudget } from "./types";

const USER = "verify_recovery";
const userDir = join(userDataRoot(), USER);
const fixture = join(userDir, "acceptance.txt");
const BUDGET: RecoveryBudget = { ...DEFAULT_RECOVERY_BUDGET, backoffMs: 50 };

function attempt(n: number, over: Partial<PsAttempt> = {}): PsAttempt {
  return {
    n,
    task_id: "task_1",
    phase: "EXECUTE",
    action: "run npm test",
    fingerprint: "npm-test",
    at: 1000 + n,
    duration_ms: 10,
    ...over,
  };
}

function sessionFixture(over: Partial<ReturnType<typeof newSession>> = {}) {
  return {
    ...newSession({
      plan_id: "plan_1",
      user: USER,
      task_id: "task_1",
      agent_id: "michelle",
      objective: "bikin test hijau",
      criteria: [{ id: "tests-green", description: "npm test hijau" }],
      budget: BUDGET,
      now: 1000,
    }),
    ...over,
  };
}

afterAll(() => rmSync(userDir, { recursive: true, force: true }));

describe("recovery phases", () => {
  it("allows the documented forward edges only", () => {
    expect(canPsTransition("PLAN", "EXECUTE")).toBe(true);
    expect(canPsTransition("PLAN", "VERIFY")).toBe(false);
    expect(canPsTransition("EXECUTE", "OBSERVE")).toBe(true);
    expect(canPsTransition("VERIFY", "DIAGNOSE")).toBe(true);
    expect(canPsTransition("DIAGNOSE", "RECOVER")).toBe(true);
    expect(canPsTransition("RECOVER", "EXECUTE")).toBe(true);
  });

  it("treats STOP as terminal", () => {
    expect(canPsTransition("STOP", "EXECUTE")).toBe(false);
    expect(canPsTransition("STOP", "RECOVER")).toBe(false);
  });
});

describe("failure classification", () => {
  it("confirms approval pause from a caller signal, not wording", () => {
    expect(classifyFailure({ approvalState: "required" })).toMatchObject({
      failure: "APPROVAL_REQUIRED",
      confidence: "confirmed",
    });
  });

  it("confirms scope/role refusal from a caller signal", () => {
    expect(classifyFailure({ blockedBy: "role" }).failure).toBe("AUTHORIZATION_BLOCKED");
  });

  it("confirms verification failure from a verification signal", () => {
    expect(classifyFailure({ verificationFailed: true }).confidence).toBe("confirmed");
  });

  it("confirms missing information from a caller signal", () => {
    expect(classifyFailure({ missingInformation: true }).failure).toBe("MISSING_INFORMATION");
  });

  it("detects a missing dependency from the module error", () => {
    expect(classifyFailure({ error: "Cannot find module 'left-pad'" }).failure).toBe("DEPENDENCY_ERROR");
  });

  it("detects an environment failure from errno", () => {
    expect(classifyFailure({ error: "EACCES: permission denied, open '/etc/x'" }).failure).toBe(
      "ENVIRONMENT_ERROR",
    );
  });

  it("detects transport timeouts and rate limits as transient", () => {
    expect(classifyFailure({ error: "socket ETIMEDOUT" }).failure).toBe("TRANSIENT");
    expect(classifyFailure({ error: "429 rate limit reached" }).failure).toBe("TRANSIENT");
  });

  it("detects input rejection as an input error", () => {
    expect(classifyFailure({ error: "400 prompt_required" }).failure).toBe("INPUT_ERROR");
  });

  it("treats a code defect as a hypothesis, not a confirmed cause", () => {
    const c = classifyFailure({ error: "TypeError: cannot read properties of undefined" });
    expect(c.failure).toBe("IMPLEMENTATION_ERROR");
    expect(c.confidence).toBe("hypothesis");
  });

  it("keeps unclassifiable text as UNKNOWN rather than guessing", () => {
    expect(classifyFailure({ error: "something odd happened" })).toMatchObject({
      failure: "UNKNOWN",
      confidence: "hypothesis",
    });
  });

  it("reports an absent error as a confirmed UNKNOWN", () => {
    expect(classifyFailure({})).toMatchObject({ failure: "UNKNOWN", confidence: "confirmed" });
  });

  it("marks classes repeating cannot fix", () => {
    for (const c of ["APPROVAL_REQUIRED", "AUTHORIZATION_BLOCKED", "MISSING_INFORMATION", "INPUT_ERROR"] as const)
      expect(isNonRetryable(c)).toBe(true);
    expect(isNonRetryable("TRANSIENT")).toBe(false);
  });

  it("quotes only the first line of an error", () => {
    expect(errorLine(new Error("boom\nstack line\nmore"))).toBe("boom");
    expect(errorLine("x".repeat(500))).toHaveLength(200);
  });
});

describe("acceptance criteria", () => {
  it("marks a satisfied file probe as met and completes", async () => {
    mkdirSync(userDir, { recursive: true });
    writeFileSync(fixture, "npm test: PASS\n");
    const out = await evaluateCriteria(
      [{ id: "green", description: "npm test hijau", probe: { kind: "file_contains", path: fixture, needle: "PASS" } }],
      { prober: fileProber },
    );
    expect(out.verdict).toBe("COMPLETE");
    expect(out.met).toBe(1);
  });

  it("fails a criterion whose probe misses", async () => {
    const out = await evaluateCriteria(
      [{ id: "green", description: "ada", probe: { kind: "file_exists", path: join(userDir, "nope.txt") } }],
      { prober: fileProber },
    );
    expect(out.verdict).toBe("FAILED");
    expect(out.unmet).toBe(1);
  });

  it("never completes on an unprobed criterion", async () => {
    const out = await evaluateCriteria([{ id: "manual", description: "dibaca manusia" }]);
    expect(out.verdict).toBe("PARTIALLY_COMPLETED");
    expect(out.unknown).toBe(1);
  });

  it("accepts an attestation as evidence for a judgement criterion", async () => {
    const out = await evaluateCriteria([{ id: "manual", description: "dibaca manusia" }], {
      attestations: { manual: "npm test output: 42 passed" },
    });
    expect(out.verdict).toBe("COMPLETE");
  });

  it("reports BLOCKED when verification itself was impossible", async () => {
    const out = await evaluateCriteria([{ id: "a", description: "x" }], { blocked: "docker down" });
    expect(out.verdict).toBe("BLOCKED");
  });

  it("fingerprints an attempt stably and drops undefined parts", () => {
    expect(attemptFingerprint(["a  b", undefined, 3])).toBe("a b|3");
  });
});

describe("recovery policy", () => {
  const base = {
    budget: BUDGET,
    fingerprint: "npm-test",
    recoverySubtasks: 0,
    delegationDepth: 0,
    toolCalls: 0,
    elapsedMs: 0,
  };

  it("escalates instead of retrying when approval is missing", () => {
    const d = decideRecovery({ ...base, failure: "APPROVAL_REQUIRED", attempts: [] });
    expect(d.action).toBe("escalate");
    expect(d.reason).toMatch(/persetujuan owner/);
  });

  it("escalates a scope block", () => {
    expect(decideRecovery({ ...base, failure: "AUTHORIZATION_BLOCKED", attempts: [] }).action).toBe("escalate");
  });

  it("stops on an input error because a repeat fails identically", () => {
    expect(decideRecovery({ ...base, failure: "INPUT_ERROR", attempts: [] }).action).toBe("stop");
  });

  it("retries a transient failure with backoff", () => {
    const d = decideRecovery({ ...base, failure: "TRANSIENT", attempts: [attempt(1)] });
    expect(d).toMatchObject({ action: "retry", waitMs: 50, changedApproach: true });
  });

  it("stops once the tool-call budget is spent, whatever the class", () => {
    const d = decideRecovery({ ...base, failure: "TRANSIENT", attempts: [], toolCalls: BUDGET.maxToolCalls });
    expect(d.action).toBe("stop");
    expect(d.reason).toMatch(/tool-call budget/);
  });

  it("stops once the attempt budget is spent", () => {
    const d = decideRecovery({
      ...base,
      failure: "TRANSIENT",
      attempts: [attempt(1), attempt(2), attempt(3)],
    });
    expect(d.action).toBe("stop");
    expect(d.reason).toMatch(/attempt budget/);
  });

  it("declares a loop once an identical fingerprint reaches the threshold", () => {
    const budget = { ...BUDGET, maxIdenticalRepeat: 2 };
    const attempts = [attempt(1, { failure: "IMPLEMENTATION_ERROR" }), attempt(2, { failure: "IMPLEMENTATION_ERROR" })];
    const d = decideRecovery({ ...base, budget, failure: "IMPLEMENTATION_ERROR", attempts });
    expect(d).toMatchObject({ action: "stop", loop: true });
    expect(d.reason).toMatch(/loop terdeteksi/);
  });

  it("allows the repeat when the caller documents a reason", () => {
    const budget = { ...BUDGET, maxIdenticalRepeat: 2 };
    const attempts = [attempt(1, { failure: "IMPLEMENTATION_ERROR" }), attempt(2, { failure: "IMPLEMENTATION_ERROR" })];
    const d = decideRecovery({
      ...base,
      budget,
      failure: "IMPLEMENTATION_ERROR",
      attempts,
      recoveryReason: "ganti assertion strict",
    });
    expect(d.action).toBe("replan");
    expect(d.changedApproach).toBe(true);
  });

  it("continues past a verification failure because criteria are unmet", () => {
    const d = decideRecovery({
      ...base,
      failure: "VERIFICATION_FAILURE",
      attempts: [attempt(1, { failure: "VERIFICATION_FAILURE" })],
      criteriaMet: 1,
      criteriaTotal: 3,
    });
    expect(d).toMatchObject({ action: "retry" });
    expect(d.reason).toMatch(/1\/3/);
  });

  it("delegates a missing dependency to an available agent within depth", () => {
    const d = decideRecovery({
      ...base,
      failure: "DEPENDENCY_ERROR",
      attempts: [attempt(1, { failure: "DEPENDENCY_ERROR" })],
      delegateCandidates: ["michelle"],
      delegationDepth: 1,
    });
    expect(d.action).toBe("delegate");
  });

  it("replans instead of delegating past the depth budget", () => {
    const d = decideRecovery({
      ...base,
      failure: "DEPENDENCY_ERROR",
      attempts: [attempt(1, { failure: "DEPENDENCY_ERROR" })],
      delegateCandidates: ["michelle"],
      delegationDepth: BUDGET.maxDelegationDepth,
    });
    expect(d.action).toBe("replan");
  });

  it("stops when one failure class saturates its own budget", () => {
    const attempts = [
      attempt(1, { failure: "TRANSIENT" }),
      attempt(2, { failure: "TRANSIENT", fingerprint: "other" }),
    ];
    const d = decideRecovery({ ...base, failure: "TRANSIENT", attempts, fingerprint: "third" });
    expect(d.action).toBe("stop");
    expect(d.reason).toMatch(/TRANSIENT/);
  });

  it("detects no loop below the threshold", () => {
    expect(detectLoop([attempt(1), attempt(2)], 3)).toBeNull();
    expect(detectLoop([attempt(1), attempt(2), attempt(3)], 3)).not.toBeNull();
  });
});

describe("approval binding", () => {
  it("ignores argument key order", () => {
    expect(approvalFingerprint("git_commit", { a: 1, b: 2 })).toBe(approvalFingerprint("git_commit", { b: 2, a: 1 }));
  });

  it("binds the fingerprint to op+params, so changed params never match", () => {
    const fp = approvalFingerprint("git_commit", { msg: "a" });
    expect(fp).toBe(approvalFingerprint("git_commit", { msg: "a" }));
    expect(fp).not.toBe(approvalFingerprint("git_commit", { msg: "b" }));
    expect(fp).not.toBe(approvalFingerprint("file_delete", { msg: "a" }));
  });
});

describe("session persistence and restart reconciliation", () => {
  it("never reconciles a session that is still running in this process", () => {
    const s = sessionFixture();
    saveSession(USER, s);
    markSessionActive(USER, s.id);
    expect(reconcileSessions(USER).map((r) => r.id)).not.toContain(s.id);
    expect(readSessions(USER).find((x) => x.id === s.id)?.status).toBe("active");
    // After the loop releases it, a later reconciliation sees it as a crash.
    releaseSession(USER, s.id);
    expect(reconcileSessions(USER).map((r) => r.id)).toContain(s.id);
  });

  it("sums only the tool calls an attempt really reported", () => {
    const s = sessionFixture();
    saveSession(USER, s);
    recordAttempt(USER, s.id, attempt(1, { tool_calls: 3 }));
    recordAttempt(USER, s.id, attempt(2, { tool_calls: 4 }));
    recordAttempt(USER, s.id, attempt(3, {}));
    expect(readSessions(USER).find((x) => x.id === s.id)?.tool_calls).toBe(7);
  });
  it("round-trips a session with its attempts", () => {
    const s = sessionFixture();
    saveSession(USER, s);    recordAttempt(USER, s.id, attempt(1, { failure: "TRANSIENT", recovery: "retry", recovery_reason: "sementara" }));
    const stored = readSessions(USER).find((x) => x.id === s.id);
    expect(stored?.attempts).toHaveLength(1);
    expect(stored?.phase).toBe("EXECUTE");
  });

  it("resolves an interrupted session to unknown instead of resuming it", () => {
    const s = sessionFixture({ id: "ps_stale" });
    saveSession(USER, s);    recordAttempt(USER, s.id, attempt(1));
    const rows = reconcileSessions(USER, { now: 1020, staleMs: 60_000 });
    const row = rows.find((r) => r.id === "ps_stale");
    expect(row?.previous_status).toBe("active");
    expect(row?.reason).toMatch(/tidak diketahui/);
    expect(readSessions(USER).find((x) => x.id === "ps_stale")?.status).toBe("unknown");
  });

  it("is idempotent: a second reconciliation reports nothing new", () => {
    reconcileSessions(USER, { now: 1030, staleMs: 60_000 });
    expect(reconcileSessions(USER, { now: 1040, staleMs: 60_000 })).toHaveLength(0);
  });

  it("marks an unknown outcome for a session interrupted mid-execution", () => {
    const s = sessionFixture({ id: "ps_mid_exec" });
    saveSession(USER, s);    recordAttempt(USER, s.id, attempt(1, { phase: "EXECUTE" }));
    const rows = reconcileSessions(USER, { now: 1060, staleMs: 60_000 });
    expect(rows.find((r) => r.id === "ps_mid_exec")?.reason).toMatch(/saat eksekusi/);
  });
});

describe("metrics and reporting", () => {
  it("counts a success without COMPLETE criteria as a false success", () => {
    const m = computeLoopMetrics([
      sessionFixture({ id: "a", status: "succeeded", criteria_outcome: "PARTIALLY_COMPLETED" }),
      sessionFixture({ id: "b", status: "succeeded", criteria_outcome: "COMPLETE" }),
    ]);
    expect(m.falseSuccessSessions).toBe(1);
    expect(m.falseSuccessRate).toBe(50);
  });

  it("leaves rates unmeasured when the denominator is zero", () => {
    const m = computeLoopMetrics([sessionFixture({ id: "c" })]);
    expect(m.recoverySuccessRate).toBeNull();
    expect(m.repeatedFailureRate).toBeNull();
    expect(m.attemptsPerTask).toBeNull();
  });

  it("measures recovery success only over sessions that actually recovered", () => {
    const recovered = sessionFixture({
      id: "d",
      status: "succeeded",
      criteria_outcome: "COMPLETE",
      attempts: [attempt(1, { recovery: "retry" })],
    });
    const m = computeLoopMetrics([recovered]);
    expect(m.recovered).toBe(1);
    expect(m.recoverySuccessRate).toBe(100);
  });

  it("renders criteria, attempts, and the stop reason from records only", () => {
    const s = sessionFixture({
      status: "stopped",
      stop_reason: "loop terdeteksi: 3x aksi identik",
      attempts: [attempt(1, { failure: "IMPLEMENTATION_ERROR", recovery: "stop", recovery_reason: "loop" })],
    });
    const md = renderPsReport(s);
    expect(md).toContain("npm test hijau");
    expect(md).toContain("implementasi");
    expect(md).toContain("loop terdeteksi");
  });

  it("says unmeasured rather than inventing a rate", () => {
    expect(renderMetricsLine(computeLoopMetrics([]))).toContain("tidak diukur");
  });
});