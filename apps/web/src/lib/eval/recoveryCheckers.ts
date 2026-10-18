// Recovery-loop checkers: each one drives the production module, never a copy.
import type { CriterionResult, EvalCase } from "./types";
import type { PsAttempt } from "../recovery";

type Checker = (c: EvalCase) => Promise<CriterionResult[]> | CriterionResult[];

const ok = (id: string, pass: boolean, detail?: string): CriterionResult => ({ id, ok: pass, detail });
const eq = (id: string, actual: unknown, expected: unknown): CriterionResult => ({
  id,
  ok: Object.is(actual, expected),
  detail: `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
});

const attempt = (n: number, over: Partial<PsAttempt> = {}): PsAttempt => ({
  n,
  task_id: "task_1",
  phase: "DIAGNOSE" as const,
  action: "jalankan npm test",
  fingerprint: "npm-test",
  at: 1000 + n,
  duration_ms: 5,
  ...over,
});

/** A transient failure gets one retry; the identical repeat stops the loop. */
const recoveryTransientThenStop: Checker = async () => {
  const { classifyFailure, decideRecovery } = await import("../recovery");
  const c = classifyFailure({ error: "socket ETIMEDOUT" });
  const budget = { maxAttempts: 3, maxSameClassAttempts: 2, maxIdenticalRepeat: 3, maxRecoverySubtasks: 2, maxDelegationDepth: 2, maxToolCalls: 24, maxWallClockMs: 600_000, backoffMs: 0 };
  const first = decideRecovery({ failure: c.failure, attempts: [attempt(1, { failure: c.failure })], budget, fingerprint: "npm-test" });
  const repeated = decideRecovery({
    failure: c.failure,
    attempts: [attempt(1, { failure: c.failure }), attempt(2, { failure: c.failure }), attempt(3, { failure: c.failure })],
    budget,
    fingerprint: "npm-test",
  });
  return [
    eq("classified-transient", c.failure, "TRANSIENT"),
    eq("first-transient-retries", first.action, "retry"),
    ok("identical-repeat-stops", repeated.action === "stop", `actual=${repeated.action}`),
  ];
};

/** Approval and scope are escalated to the owner, never retried. */
const recoveryEscalatesApproval: Checker = async () => {
  const { classifyFailure, decideRecovery } = await import("../recovery");
  const budget = { maxAttempts: 3, maxSameClassAttempts: 2, maxIdenticalRepeat: 3, maxRecoverySubtasks: 2, maxDelegationDepth: 2, maxToolCalls: 24, maxWallClockMs: 600_000, backoffMs: 0 };
  const approval = classifyFailure({ approvalState: "required" });
  const scope = classifyFailure({ blockedBy: "scope" });
  return [
    eq("approval-class", approval.failure, "APPROVAL_REQUIRED"),
    eq("approval-escalates", decideRecovery({ failure: approval.failure, attempts: [], budget, fingerprint: "x" }).action, "escalate"),
    eq("scope-class", scope.failure, "AUTHORIZATION_BLOCKED"),
    eq("scope-escalates", decideRecovery({ failure: scope.failure, attempts: [], budget, fingerprint: "x" }).action, "escalate"),
  ];
};

/** Budget caps stop the loop before the class policy can ask for a retry. */
const recoveryBudgetStops: Checker = async () => {
  const { decideRecovery } = await import("../recovery");
  const budget = { maxAttempts: 3, maxSameClassAttempts: 2, maxIdenticalRepeat: 3, maxRecoverySubtasks: 2, maxDelegationDepth: 2, maxToolCalls: 4, maxWallClockMs: 1_000, backoffMs: 0 };
  const tools = decideRecovery({ failure: "TRANSIENT", attempts: [], budget, fingerprint: "x", toolCalls: 4 });
  const clock = decideRecovery({ failure: "TRANSIENT", attempts: [], budget, fingerprint: "x", elapsedMs: 2_000 });
  return [
    ok("tool-budget-stops", tools.action === "stop" && /tool-call budget/.test(tools.reason), tools.reason),
    ok("wall-clock-stops", clock.action === "stop" && /wall-clock budget/.test(clock.reason), clock.reason),
  ];
};

/** An unevidenced answer cannot complete the criteria. */
const recoveryCriteriaNeedEvidence: Checker = async () => {
  const { evaluateCriteria } = await import("../recovery");
  const criteria = [{ id: "npm-test-hijau", description: "npm test hijau" }];
  const none = await evaluateCriteria(criteria);
  const attested = await evaluateCriteria(criteria, { attestations: { "npm-test-hijau": "npm test 42 passed" } });
  return [
    ok("no-evidence-is-not-complete", none.verdict !== "COMPLETE", `verdict=${none.verdict}`),
    eq("unknown-is-preserved", none.unknown, 1),
    eq("attested-completes", attested.verdict, "COMPLETE"),
  ];
};

/** Delegation needs an available agent; otherwise it replans instead of looping. */
const recoveryDelegationNeedsAgent: Checker = async () => {
  const { decideRecovery } = await import("../recovery");
  const budget = { maxAttempts: 3, maxSameClassAttempts: 2, maxIdenticalRepeat: 3, maxRecoverySubtasks: 2, maxDelegationDepth: 2, maxToolCalls: 24, maxWallClockMs: 600_000, backoffMs: 0 };
  const none = decideRecovery({ failure: "DEPENDENCY_ERROR", attempts: [attempt(1, { failure: "DEPENDENCY_ERROR" })], budget, fingerprint: "dep" });
  const tooDeep = decideRecovery({
    failure: "DEPENDENCY_ERROR",
    attempts: [attempt(1, { failure: "DEPENDENCY_ERROR" })],
    budget,
    fingerprint: "dep",
    delegateCandidates: ["michelle"],
    delegationDepth: 2,
  });
  return [
    eq("no-agent-replans", none.action, "replan"),
    eq("depth-budget-blocks-delegation", tooDeep.action, "replan"),
  ];
};

/** A session left active by a restart resolves to unknown, never a silent resume. */
const recoveryRestartUnknown: Checker = async () => {
  const { newSession, reconcileSessions, saveSession, readSessions } = await import("../recovery");
  // Run-unique key: a deterministic checker must not inherit a previous run's
  // attempt history and silently fail its own budget.
  const user = `verify_eval_recovery_${Date.now().toString(36)}`;
  const session = newSession({
    plan_id: "plan_eval",
    user,
    task_id: "task_eval_orphan",
    agent_id: "mia",
    objective: "pekerjaan tertinggal",
    criteria: [],
    budget: { maxAttempts: 3, maxSameClassAttempts: 2, maxIdenticalRepeat: 3, maxRecoverySubtasks: 2, maxDelegationDepth: 2, maxToolCalls: 24, maxWallClockMs: 600_000, backoffMs: 0 },
    now: Date.now() - 3_600_000,
  });
  session.id = "ps_task_eval_orphan";
  saveSession(user, session);
  const rows = reconcileSessions(user);
  const after = readSessions(user).find((s) => s.id === "ps_task_eval_orphan");
  const again = reconcileSessions(user);
  return [
    ok("reconcile-reports", rows.length > 0, `rows=${rows.length}`),
    eq("status-becomes-unknown", after?.status, "unknown"),
    eq("idempotent-second-pass", again.length, 0),
  ];
};

/** Metrics must never hide a false success. */
const recoveryMetricsHonest: Checker = async () => {
  const { computeLoopMetrics } = await import("../recovery");
  const base = {
    plan_id: "p",
    user: "u",
    agent_id: "mia",
    objective: "o",
    criteria: [],
    budget: { maxAttempts: 3, maxSameClassAttempts: 2, maxIdenticalRepeat: 3, maxRecoverySubtasks: 2, maxDelegationDepth: 2, maxToolCalls: 24, maxWallClockMs: 600_000, backoffMs: 0 },
    attempts: [],
    phase: "STOP",
    recovery_subtasks: 0,
    tool_calls: 0,
    delegation_depth: 0,
    approvals: [],
    started_at: 0,
    updated_at: 0,
  } as never;
  const honest = computeLoopMetrics([{ ...(base as object), id: "a", task_id: "t1", status: "succeeded", criteria_outcome: "COMPLETE" } as never]);
  const liar = computeLoopMetrics([{ ...(base as object), id: "b", task_id: "t2", status: "succeeded", criteria_outcome: "PARTIALLY_COMPLETED" } as never]);
  return [
    eq("honest-success-no-false", honest.falseSuccessSessions, 0),
    eq("partial-success-counted", liar.falseSuccessSessions, 1),
    ok("unmeasured-is-null", liar.recoverySuccessRate === null, `rate=${liar.recoverySuccessRate}`),
  ];
};

/** End-to-end through the runtime: a thrown transient recovers, a repeat stops. */
const recoveryRuntimeRetryThenStop: Checker = async () => {
  const { runPlan } = await import("../orchestrator");
  const user = `verify_eval_recovery_${Date.now().toString(36)}`;
  const mkPlan = (taskId: string) => ({
    id: `plan_${taskId}`,
    user,
    request: "perbaiki test",
    created_at: new Date().toISOString(),
    status: "PLANNED" as const,
    tasks: [
      {
        task_id: taskId,
        parent_task_id: null,
        agent_id: "mia" as const,
        objective: "perbaiki test yang merah",
        task_type: "code" as const,
        input_context: "",
        expected_output: "test hijau",
        acceptance_criteria: ["npm test hijau"],
        dependencies: [],
        priority: 1,
        required: true,
        status: "PLANNED" as const,
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
        result_reference: null,
        evidence_references: [],
        error_summary: null,
        attempts: 0,
        idempotent: true,
      },
    ],
    budget: { maxDepth: 2, maxTasks: 6, maxConcurrent: 1, maxRetries: 1, taskTimeoutMs: 5_000, maxDurationMs: 60_000 },
    notes: [],
  });
  const okResult = (taskId: string) => ({
    task_id: taskId,
    agent_id: "mia" as const,
    status: "SUCCEEDED" as const,
    summary: "test hijau",
    findings: [],
    evidence_references: [],
    artifact_references: [],
    validations: ["KRITERIA npm-test-hijau: npm test 42 passed"],
    errors: [],
    remaining_uncertainty: [],
    next_step: null,
  });
  let calls = 0;
  const recovered = await runPlan(mkPlan("task_retry"), async (t) => {
    calls += 1;
    if (calls === 1) throw new Error("socket ETIMEDOUT");
    return okResult(t.task_id);
  });
  let always = 0;
  const stopped = await runPlan(mkPlan("task_stop"), async () => {
    always += 1;
    throw new Error("socket ETIMEDOUT");
  });
  return [
    eq("transient-retried-once", calls, 2),
    eq("recovered-task-succeeded", recovered.plan.tasks[0]?.status, "SUCCEEDED"),
    ok("identical-failure-stops", always <= 2, `calls=${always}`),
    eq("stopped-task-failed", stopped.plan.tasks[0]?.status, "FAILED"),
    ok("stop-reason-recorded", !!stopped.plan.tasks[0]?.ps_recovery_reason, String(stopped.plan.tasks[0]?.ps_recovery_reason)),
  ];
};

export const RECOVERY_CHECKERS: Record<string, Checker> = {
  "recovery.transientThenStop": recoveryTransientThenStop,
  "recovery.escalatesApproval": recoveryEscalatesApproval,
  "recovery.budgetStops": recoveryBudgetStops,
  "recovery.criteriaNeedEvidence": recoveryCriteriaNeedEvidence,
  "recovery.delegationNeedsAgent": recoveryDelegationNeedsAgent,
  "recovery.restartUnknown": recoveryRestartUnknown,
  "recovery.metricsHonest": recoveryMetricsHonest,
  "recovery.runtimeRetryThenStop": recoveryRuntimeRetryThenStop,
};
