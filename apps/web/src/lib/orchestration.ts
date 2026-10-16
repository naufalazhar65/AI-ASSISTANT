/**
 * Orchestration engine — pure task-graph logic (no I/O, no LLM).
 *
 * Deliberately separate from the runtime (orchestrator.ts) so the rules can be
 * tested without a model: lifecycle legality, dependency gating, budget
 * accounting, agent assignment by REAL capability, and reconciliation.
 *
 * Nothing here marks a task successful on its own: a task only reaches
 * SUCCEEDED through an explicit transition carrying a result reference, which
 * is what keeps "an agent answered" from becoming "the work was done".
 */

import { AGENT_REGISTRY, agentProfile, agentsForCategory, isAvailableAgent, unavailableReason } from "./agentRegistry";
import type { AgentLabel } from "./agentRouting";
import type { TaskCategory } from "./agentRegistry";

export type OrchestrationTaskType = TaskCategory;

export type TaskState =
  | "PLANNED"
  | "READY"
  | "AWAITING_APPROVAL"
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "PARTIALLY_COMPLETED"
  | "FAILED"
  | "BLOCKED"
  | "CANCELLED";

/** States in which a task produced (or failed to produce) a terminal result. */
export const TERMINAL_STATES: readonly TaskState[] = ["SUCCEEDED", "PARTIALLY_COMPLETED", "FAILED", "CANCELLED"];

/** Explicit transition table — an illegal transition is refused, never coerced. */
export const ALLOWED_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  PLANNED: ["READY", "BLOCKED", "CANCELLED"],
  READY: ["QUEUED", "AWAITING_APPROVAL", "BLOCKED", "CANCELLED"],
  QUEUED: ["RUNNING", "CANCELLED"],
  AWAITING_APPROVAL: ["QUEUED", "BLOCKED", "CANCELLED"],
  RUNNING: ["SUCCEEDED", "PARTIALLY_COMPLETED", "FAILED", "BLOCKED", "CANCELLED"],
  SUCCEEDED: [],
  PARTIALLY_COMPLETED: [],
  FAILED: [],
  BLOCKED: [],
  CANCELLED: [],
};

export interface OrchestrationTask {
  task_id: string;
  parent_task_id: string | null;
  /** null = capability gap: nobody registered can do this. Never invent one. */
  agent_id: AgentLabel | null;
  objective: string;
  task_type: OrchestrationTaskType;
  input_context: string;
  expected_output: string;
  acceptance_criteria: string[];
  dependencies: string[];
  priority: number;
  required: boolean;
  status: TaskState;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  result_reference: string | null;
  evidence_references: string[];
  error_summary: string | null;
  attempts: number;
  /** Safe to repeat without duplicating an external effect. */
  idempotent: boolean;
}

export interface OrchestrationBudget {
  maxDepth: number;
  maxTasks: number;
  maxConcurrent: number;
  maxRetries: number;
  taskTimeoutMs: number;
  maxDurationMs: number;
}

export const DEFAULT_BUDGET: OrchestrationBudget = {
  maxDepth: 2,
  maxTasks: 6,
  maxConcurrent: 2,
  maxRetries: 1,
  taskTimeoutMs: 120_000,
  maxDurationMs: 600_000,
};

export function orchestrationBudgetFromEnv(env: NodeJS.ProcessEnv = process.env): OrchestrationBudget {
  const num = (v: string | undefined, dflt: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  return {
    maxDepth: num(env.ORCHESTRATION_MAX_DEPTH, DEFAULT_BUDGET.maxDepth),
    maxTasks: num(env.ORCHESTRATION_MAX_TASKS, DEFAULT_BUDGET.maxTasks),
    maxConcurrent: num(env.ORCHESTRATION_MAX_CONCURRENT, DEFAULT_BUDGET.maxConcurrent),
    maxRetries: num(env.ORCHESTRATION_MAX_RETRIES, DEFAULT_BUDGET.maxRetries),
    taskTimeoutMs: num(env.ORCHESTRATION_TASK_TIMEOUT_MS, DEFAULT_BUDGET.taskTimeoutMs),
    maxDurationMs: num(env.ORCHESTRATION_MAX_DURATION_MS, DEFAULT_BUDGET.maxDurationMs),
  };
}

export type PlanStatus = "PLANNED" | "RUNNING" | "DONE" | "FAILED" | "CANCELLED";

export interface OrchestrationPlan {
  id: string;
  user: string;
  request: string;
  created_at: string;
  status: PlanStatus;
  tasks: OrchestrationTask[];
  budget: OrchestrationBudget;
  /** Honest notes for the user (gaps, skipped work, budget stops). */
  notes: string[];
}

export interface AgentResult {
  task_id: string;
  agent_id: AgentLabel;
  status: "SUCCEEDED" | "FAILED" | "PARTIALLY_COMPLETED";
  summary: string;
  findings: string[];
  evidence_references: string[];
  artifact_references: string[];
  validations: string[];
  errors: string[];
  remaining_uncertainty: string[];
  next_step: string | null;
}

export type TransitionVerdict = { ok: true; task: OrchestrationTask } | { ok: false; reason: string };

/** Legal transition guard. Terminal states are final. */
export function canTransition(from: TaskState, to: TaskState): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Apply a state change. A task may only become SUCCEEDED with a result
 * reference — that is the rule that stops "the agent replied" from reading as
 * "the work is done".
 */
export function transition(task: OrchestrationTask, to: TaskState, patch: Partial<OrchestrationTask> = {}): TransitionVerdict {
  if (!canTransition(task.status, to)) {
    return { ok: false, reason: `transisi ${task.status} -> ${to} tidak diizinkan` };
  }
  if (to === "SUCCEEDED" && !(patch.result_reference || task.result_reference)) {
    return { ok: false, reason: "SUCCEEDED tanpa result_reference: klaim tanpa bukti ditolak" };
  }
  const next: OrchestrationTask = { ...task, ...patch, status: to };
  if (to === "RUNNING") next.started_at = patch.started_at ?? task.started_at ?? new Date().toISOString();
  if (TERMINAL_STATES.includes(to)) next.completed_at = patch.completed_at ?? new Date().toISOString();
  return { ok: true, task: next };
}

export interface PlanIssue {
  code:
    | "cycle"
    | "unknown-dependency"
    | "unregistered-agent"
    | "unavailable-agent"
    | "duplicate-objective"
    | "budget-exceeded"
    | "category-capability-gap";
  detail: string;
  task_id?: string;
}

/**
 * Static validation of a plan: DAG integrity, agent registration/availability,
 * duplicate objectives and budget. Called before anything is dispatched.
 */
export function validatePlan(plan: OrchestrationPlan): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const byId = new Map(plan.tasks.map((t) => [t.task_id, t]));

  for (const t of plan.tasks) {
    for (const dep of t.dependencies) {
      if (!byId.has(dep)) issues.push({ code: "unknown-dependency", detail: `${t.task_id} bergantung pada ${dep} yang tidak ada`, task_id: t.task_id });
    }
  }
  if (hasCycle(plan.tasks)) issues.push({ code: "cycle", detail: "graf tugas membentuk siklus" });
  if (plan.tasks.length > plan.budget.maxTasks) {
    issues.push({ code: "budget-exceeded", detail: `${plan.tasks.length} tugas melebihi maxTasks=${plan.budget.maxTasks}` });
  }
  const seen = new Map<string, string>();
  for (const t of plan.tasks) {
    const key = t.objective.trim().toLowerCase();
    const prior = seen.get(key);
    if (prior) issues.push({ code: "duplicate-objective", detail: `objektif sama dengan ${prior}: "${t.objective}"`, task_id: t.task_id });
    else seen.set(key, t.task_id);

    if (t.agent_id === null) {
      const capable = agentsForCategory(t.task_type).filter((p) => isAvailableAgent(p.label));
      if (capable.length === 0) {
        issues.push({ code: "category-capability-gap", detail: `tidak ada agent terdaftar+tersedia untuk kategori ${t.task_type}`, task_id: t.task_id });
      }
      continue;
    }
    if (!agentProfile(t.agent_id)) issues.push({ code: "unregistered-agent", detail: `${t.task_id} ditugaskan ke "${t.agent_id}" yang tidak terdaftar`, task_id: t.task_id });
    else if (!isAvailableAgent(t.agent_id)) issues.push({ code: "unavailable-agent", detail: `${t.task_id}: ${unavailableReason(t.agent_id)}`, task_id: t.task_id });
  }
  return issues;
}

/** Depth-first cycle check over dependencies. */
export function hasCycle(tasks: OrchestrationTask[]): boolean {
  const adj = new Map<string, string[]>();
  for (const t of tasks) adj.set(t.task_id, t.dependencies);
  const state = new Map<string, number>();
  const visit = (id: string): boolean => {
    const s = state.get(id) ?? 0;
    if (s === 1) return true;
    if (s === 2) return false;
    state.set(id, 1);
    for (const dep of adj.get(id) ?? []) {
      if (adj.has(dep) && visit(dep)) return true;
    }
    state.set(id, 2);
    return false;
  };
  return tasks.some((t) => visit(t.task_id));
}

const DONE_FOR_DEPS: readonly TaskState[] = ["SUCCEEDED", "PARTIALLY_COMPLETED"];

/**
 * Tasks whose dependencies are satisfied and that may start now. A dependency
 * in a FAILED/BLOCKED state never unblocks its dependents — they go BLOCKED.
 */
export function readyTasks(tasks: OrchestrationTask[]): OrchestrationTask[] {
  const byId = new Map(tasks.map((t) => [t.task_id, t]));
  const out: OrchestrationTask[] = [];
  for (const t of tasks) {
    if (t.status !== "PLANNED" && t.status !== "READY") continue;
    const deps = t.dependencies.map((d) => byId.get(d)).filter((d): d is OrchestrationTask => !!d);
    const satisfied = deps.every((d) => DONE_FOR_DEPS.includes(d.status));
    const dead = deps.some((d) => d.status === "FAILED" || d.status === "CANCELLED" || d.status === "BLOCKED");
    if (dead) out.push({ ...t, status: "BLOCKED", error_summary: `dependensi gagal: ${deps.filter((d) => d.status !== "SUCCEEDED" && !DONE_FOR_DEPS.includes(d.status)).map((d) => d.task_id).join(", ")}` });
    else if (satisfied) out.push({ ...t, status: "READY" });
  }
  return out;
}

export interface BudgetUsage {
  tasks: number;
  running: number;
  retriesUsed: number;
  elapsedMs: number;
}

/** Everything that stops further planning/execution, in honest wording. */
export function budgetStops(plan: OrchestrationPlan, usage: BudgetUsage): string[] {
  const stops: string[] = [];
  if (usage.tasks > plan.budget.maxTasks) stops.push(`batas jumlah tugas (${plan.budget.maxTasks}) tercapai`);
  if (usage.running > plan.budget.maxConcurrent) stops.push(`batas konkurensi (${plan.budget.maxConcurrent}) terlampaui`);
  if (usage.retriesUsed > plan.budget.maxRetries * plan.tasks.length) stops.push(`batas retry (${plan.budget.maxRetries}/tugas) tercapai`);
  if (usage.elapsedMs > plan.budget.maxDurationMs) stops.push(`batas durasi (${Math.round(plan.budget.maxDurationMs / 1000)}s) tercapai`);
  return stops;
}

/** Tasks that may retry: idempotent only, and within the retry budget. */
export function canRetry(task: OrchestrationTask, budget: OrchestrationBudget): boolean {
  if (!task.idempotent) return false;
  return task.attempts <= budget.maxRetries;
}

export interface Reconciliation {
  parentStatus: "SUCCEEDED" | "PARTIALLY_COMPLETED" | "FAILED" | "CANCELLED" | "RUNNING";
  requiredTotal: number;
  requiredSucceeded: number;
  requiredFailed: number;
  requiredBlocked: number;
  requiredCancelled: number;
  optionalFailed: string[];
  unfinished: string[];
  /** Lines the final response must disclose. */
  disclosures: string[];
  contradictions: string[];
}

/**
 * Reconcile a plan into an honest parent status. A failed REQUIRED task can
 * never produce SUCCEEDED; a failed OPTIONAL task yields PARTIALLY_COMPLETED.
 * Contradictory results (two agents claiming the same fact differently) stay
 * visible instead of being silently resolved.
 */
export function reconcile(plan: OrchestrationPlan): Reconciliation {
  const required = plan.tasks.filter((t) => t.required);
  const optional = plan.tasks.filter((t) => !t.required);
  const done = required.filter((t) => DONE_FOR_DEPS.includes(t.status));
  const failed = required.filter((t) => t.status === "FAILED");
  const blocked = required.filter((t) => t.status === "BLOCKED");
  const cancelled = required.filter((t) => t.status === "CANCELLED");
  const unfinished = required.filter((t) => !TERMINAL_STATES.includes(t.status)).map((t) => t.task_id);
  const optionalFailed = optional.filter((t) => t.status === "FAILED").map((t) => t.task_id);

  let parentStatus: Reconciliation["parentStatus"];
  if (required.length === 0) {
    // A plan whose subtasks are all OPTIONAL still has to reach a terminal
    // state. Returning RUNNING here pinned such plans forever and the runtime
    // reported them as FAILED even when every subtask had succeeded.
    const open = plan.tasks.filter((t) => !TERMINAL_STATES.includes(t.status));
    const cancelledAll = plan.tasks.length > 0 && plan.tasks.every((t) => t.status === "CANCELLED");
    parentStatus = open.length > 0 ? "RUNNING" : cancelledAll ? "CANCELLED" : optionalFailed.length > 0 ? "PARTIALLY_COMPLETED" : "SUCCEEDED";
  } else if (cancelled.length === required.length) parentStatus = "CANCELLED";
  else if (failed.length + blocked.length + cancelled.length === 0 && unfinished.length === 0) {
    parentStatus = optionalFailed.length > 0 ? "PARTIALLY_COMPLETED" : "SUCCEEDED";
  } else if (done.length > 0) parentStatus = "PARTIALLY_COMPLETED";
  else parentStatus = failed.length + cancelled.length > 0 ? "FAILED" : "RUNNING";

  const disclosures: string[] = [];
  if (failed.length) disclosures.push(`${failed.length} tugas wajib gagal: ${failed.map((t) => t.task_id).join(", ")}`);
  if (blocked.length) disclosures.push(`${blocked.length} tugas terblokir: ${blocked.map((t) => t.task_id).join(", ")}`);
  if (cancelled.length) disclosures.push(`${cancelled.length} tugas dibatalkan: ${cancelled.map((t) => t.task_id).join(", ")}`);
  if (unfinished.length) disclosures.push(`${unfinished.length} tugas belum selesai: ${unfinished.join(", ")}`);
  if (optionalFailed.length) disclosures.push(`${optionalFailed.length} tugas opsional gagal (tujuan utama tetap tercapai): ${optionalFailed.join(", ")}`);
  const gaps = plan.tasks.filter((t) => t.agent_id === null && t.status !== "CANCELLED").map((t) => t.task_id);
  if (gaps.length) disclosures.push(`${gaps.length} tugas dilewati karena tidak ada agent terdaftar yang mampu: ${gaps.join(", ")}`);
  if (plan.notes.length) disclosures.push(...plan.notes);

  const contradictions = findContradictions(plan);
  if (contradictions.length) disclosures.push(`${contradictions.length} hasil bertentangan perlu ditinjau`);

  return {
    parentStatus,
    requiredTotal: required.length,
    requiredSucceeded: done.length,
    requiredFailed: failed.length,
    requiredBlocked: blocked.length,
    requiredCancelled: cancelled.length,
    optionalFailed,
    unfinished,
    disclosures,
    contradictions,
  };
}

/**
 * Cross-agent contradictions: two results for the same fact with different
 * verdicts. Deliberately conservative — needs an explicit verdict word plus a
 * different value, so ordinary summaries never trip it.
 */
/**
 * Shared subject for two results to be comparable: the first three words of the
 * objective. "Cek status API" and "Cek status API lain" are the same claim about
 * the same thing; a 40-char prefix slice did NOT match them, so genuine
 * contradictions went unreported.
 */
export function contradictionKey(objective: string): string {
  return objective
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .join(" ");
}

export function findContradictions(plan: OrchestrationPlan): string[] {
  const verdicts = new Map<string, { task: string; value: string }>();
  const out: string[] = [];
  const CLAIM_RE = /\b(status|hasil|result|verdict|statusnya|hasilnya)\s*[:=]\s*([a-z0-9_.-]+)/gi;
  for (const t of plan.tasks) {
    const source = `${t.objective} ${t.error_summary ?? ""} ${t.result_reference ?? ""}`;
    CLAIM_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CLAIM_RE.exec(source)) !== null) {
      const key = contradictionKey(t.objective);
      const value = m[2].toLowerCase();
      const prior = verdicts.get(key);
      if (prior && prior.value !== value) out.push(`${prior.task} (${prior.value}) vs ${t.task_id} (${value})`);
      else verdicts.set(key, { task: t.task_id, value });
    }
  }
  return [...new Set(out)];
}

/** Progress block for channels — counts come from task records, never invented. */
export function progressLine(plan: OrchestrationPlan): string {
  const r = reconcile(plan);
  const done = plan.tasks.filter((t) => DONE_FOR_DEPS.includes(t.status)).length;
  const running = plan.tasks.find((t) => t.status === "RUNNING" || t.status === "READY" || t.status === "QUEUED");
  const awaiting = plan.tasks.filter((t) => t.status === "AWAITING_APPROVAL").length;
  const lines = [
    `**Task:** ${plan.request.slice(0, 80)}`,
    `**Status:** ${r.parentStatus}`,
    `**Completed:** ${done} dari ${plan.tasks.length} tahap`,
    `**Current:** ${running ? `${running.task_id} · ${AGENT_REGISTRY[running.agent_id ?? "mia"].displayName}` : "tidak ada tahap berjalan"}`,
    `**Blocked:** ${r.requiredBlocked ? r.requiredBlocked : awaiting ? `${awaiting} menunggu persetujuan` : "None"}`,
  ];
  return lines.join("\n");
}