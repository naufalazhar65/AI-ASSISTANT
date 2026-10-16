/**
 * Orchestration runtime — executes a validated plan and returns ONE reconciled
 * result. Provider- and platform-agnostic on purpose: the only dependency is
 * the injected `runSubtask`, so tests drive it with fakes and the real runtime
 * binds it to `runAssistantTurn`.
 *
 * Invariants (each one closes a way for the workflow to lie):
 * - a task is dispatched only when validatePlan found no blocking issue and
 *   its dependencies are actually satisfied;
 * - SUCCEEDED requires a real AgentResult (a thrown error or a refusal result
 *   is FAILED/BLOCKED, never "done because it replied");
 * - retries happen only for idempotent tasks within the budget, so an external
 *   effect is never duplicated;
 * - cancellation stops queued work and propagates to pending children;
 * - the parent status and every disclosure come from `reconcile`, not prose.
 */

import {
  canRetry,
  progressLine,
  reconcile,
  readyTasks,
  TERMINAL_STATES,
  transition,
  validatePlan,
  type AgentResult,
  type OrchestrationPlan,
  type OrchestrationTask,
} from "./orchestration";
import { planFromRequest, shouldOrchestrate } from "./orchestrationPlanner";
import { savePlan } from "./orchestrationStore";
import { emitBusEvent } from "./bus";
import { auditLog } from "./auditLog";
import { agentProfile } from "./agentRegistry";

export type SubtaskRunner = (task: OrchestrationTask, plan: OrchestrationPlan) => Promise<AgentResult>;

export interface RunPlanOptions {
  /** Called on every state change so callers can persist/report progress. */
  onPlanChange?: (plan: OrchestrationPlan) => void;
  /** Polled between waves; return true to stop (cancellation). */
  shouldStop?: () => boolean;
  now?: () => number;
  /** Emitted to Discord/Telegram; defaults to the deterministic progress block. */
  progress?: (line: string) => void;
}

/** Plans are per-user state: every mutation is persisted and audited. */
function persist(plan: OrchestrationPlan, opts: RunPlanOptions): void {
  savePlan(plan);
  opts.onPlanChange?.(plan);
}

export interface OrchestrationOutcome {
  plan: OrchestrationPlan;
  reconciliation: ReturnType<typeof reconcile>;
  finalText: string;
  /** True when the workflow ran instead of falling back to the direct path. */
  orchestrated: boolean;
}

async function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  if (!(ms > 0)) return fn();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout setelah ${Math.round(ms / 1000)}s`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Execute one plan to completion. Tasks are dispatched in waves of at most
 * `budget.maxConcurrent`, dependencies strictly before dependents.
 */
export async function runPlan(plan: OrchestrationPlan, runSubtask: SubtaskRunner, opts: RunPlanOptions = {}): Promise<OrchestrationOutcome> {
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();
  const issues = validatePlan(plan);

  // Static validation: unusable tasks are BLOCKED, never dispatched. Unavailable
  // or unregistered agents are BLOCKED with the reason, so the final report
  // discloses the gap instead of silently dropping the work.
  for (const issue of issues) {
    if (issue.code === "cycle") continue;
    if (issue.code === "budget-exceeded") {
      // Tasks past the budget are refused explicitly, not silently executed.
      // Keep the highest-priority (lowest priority number) tasks.
      const order = [...plan.tasks].sort((a, b) => a.priority - b.priority);
      for (const t of order.slice(plan.budget.maxTasks)) {
        if (TERMINAL_STATES.includes(t.status)) continue;
        t.status = "BLOCKED";
        t.error_summary = issue.detail;
      }
      plan.notes.push(issue.detail);
      continue;
    }
    const task = plan.tasks.find((t) => t.task_id === issue.task_id);
    if (!task || TERMINAL_STATES.includes(task.status)) continue;
    if (task.status === "PLANNED" || task.status === "READY") {
      task.status = "BLOCKED";
      task.error_summary = issue.detail;
    }
  }
  if (issues.some((i) => i.code === "cycle")) {
    plan.status = "FAILED";
    plan.notes.push("graf tugas membentuk siklus — tidak ada yang dieksekusi");
    persist(plan, opts);
    return finish(plan, opts);
  }

  plan.status = "RUNNING";
  persist(plan, opts);
  emitBusEvent({ user: plan.user, type: "task_started", summary: `orkestrasi mulai: ${plan.tasks.length} tahap`, data: { plan: plan.id } });
  auditLog(plan.user, "orchestration_start", `plan=${plan.id} tasks=${plan.tasks.length}`);

  let running = 0;
  while (true) {
    if (opts.shouldStop?.()) break;
    if (now() - startedAt > plan.budget.maxDurationMs) {
      plan.notes.push(`dihentikan oleh batas durasi ${Math.round(plan.budget.maxDurationMs / 1000)}s`);
      break;
    }
    const open = plan.tasks.filter((t) => !TERMINAL_STATES.includes(t.status));
    if (open.length === 0) break;

    // readyTasks() returns COPIES (it may also mark blocked ones), so map the
    // verdicts back onto the real task objects. Mutating the copies used to
    // leave plan.tasks untouched and the wave loop could never terminate.
    const openById = new Map(open.map((t) => [t.task_id, t]));
    const wave: OrchestrationTask[] = [];
    // readyTasks() sees the WHOLE plan, not just the open subset: filtering
    // first made a failed dependency invisible (it was already terminal, so
    // not in `open`) and its dependents ran anyway.
    for (const candidate of readyTasks(plan.tasks)) {
      const real = openById.get(candidate.task_id);
      if (!real) continue;
      if (candidate.status === "BLOCKED") {
        real.status = "BLOCKED";
        real.error_summary = candidate.error_summary;
        continue;
      }
      if (real.agent_id === null) continue; // capability gap: disclose, never invent
      wave.push(real);
      if (wave.length >= Math.max(0, plan.budget.maxConcurrent - running)) break;
    }
    if (wave.length === 0) {
      // Nothing can start now: either a dependency is still running or the
      // rest is blocked. Block the remainder so the report can disclose it.
      const stalled = open.filter((t) => !TERMINAL_STATES.includes(t.status) && t.status === "PLANNED");
      for (const t of stalled) {
        t.status = "BLOCKED";
        t.error_summary = t.error_summary ?? "tidak bisa dijalankan: dependensi belum terpenuhi";
      }
      if (running === 0) break;
      await settle();
      continue;
    }

    const inflight = wave.map(async (task) => {
      running += 1;
      const step = (patch: Partial<OrchestrationTask>, to: OrchestrationTask["status"]): void => {
        const v = transition({ ...task, ...patch }, to);
        if (v.ok) Object.assign(task, v.task);
      };
      task.attempts += 1;
      // Walk the lifecycle explicitly — the transition table refuses
      // PLANNED -> QUEUED, so READY has to be entered first.
      step({}, "READY");
      step({}, "QUEUED");
      step({}, "RUNNING");
      emitBusEvent({ user: plan.user, type: "task_assigned", agent: task.agent_id ?? undefined, summary: `${task.task_id}: ${task.objective}` });
      try {
        const result = await withTimeout(() => runSubtask(task, plan), plan.budget.taskTimeoutMs);
        if (result.status === "SUCCEEDED") {
          // The reference carries the summary, not just an id: a downstream
          // reader must be able to see WHAT was produced without re-running.
          const ref = `result:${task.task_id} — ${firstLine(result.summary) || task.objective}`;
          const v = transition(task, "SUCCEEDED", {
            result_reference: ref,
            evidence_references: dedupe([...(task.evidence_references ?? []), ...(result.evidence_references ?? [])]),
            error_summary: result.errors?.length ? result.errors.join("; ") : null,
          });
          if (!v.ok) task.error_summary = v.reason;
          else Object.assign(task, v.task);
        } else if (result.status === "PARTIALLY_COMPLETED") {
          const v = transition(task, "PARTIALLY_COMPLETED", {
            result_reference: `result:${task.task_id} — ${firstLine(result.summary) || task.objective}`,
          });
          if (v.ok) Object.assign(task, v.task);
        } else {
          task.status = "FAILED";
          task.error_summary = result.summary || "gagal tanpa ringkasan";
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (canRetry(task, plan.budget) && task.status === "RUNNING") {
          // Idempotent task failed: it may be re-attempted in a later wave.
          // `attempts` is NOT decremented — rolling it back made the retry
          // budget infinite and pinned the plan in a never-ending wave loop.
          task.status = "READY";
          task.error_summary = `${msg} (retry tersedia)`;
        } else {
          task.status = "FAILED";
          task.error_summary = msg;
        }
      } finally {
        running -= 1;
        emitBusEvent({
          user: plan.user,
          type: task.status === "SUCCEEDED" ? "task_done" : "task_failed",
          agent: task.agent_id ?? undefined,
          summary: `${task.task_id}: ${task.status}`,
          data: { plan: plan.id, task: task.task_id },
        });
      }
    });
    await Promise.all(inflight);
    persist(plan, opts);
    opts.progress?.(progressLine(plan));
  }

  if (opts.shouldStop?.()) {
    for (const t of plan.tasks) {
      if (!TERMINAL_STATES.includes(t.status)) {
        t.status = "CANCELLED";
        t.error_summary = t.error_summary ?? "dibatalkan";
      }
    }
    plan.status = "CANCELLED";
  }

  return finish(plan, opts);
}

/** Let queued microtasks (bus emit/audit) drain before re-evaluating. */
function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function firstLine(s: string | undefined | null): string {
  return String(s ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)[0] ?? "";
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs.filter(Boolean))];
}

function finish(plan: OrchestrationPlan, opts: RunPlanOptions): OrchestrationOutcome {
  const reconciliation = reconcile(plan);
  if (plan.status !== "CANCELLED" && plan.status !== "FAILED") {
    plan.status =
      reconciliation.parentStatus === "SUCCEEDED" || reconciliation.parentStatus === "PARTIALLY_COMPLETED"
        ? "DONE"
        : reconciliation.parentStatus === "CANCELLED"
          ? "CANCELLED"
          : "FAILED";
  }
  persist(plan, opts);
  auditLog(plan.user, "orchestration_end", `plan=${plan.id} status=${plan.status} ${JSON.stringify(reconciliation).slice(0, 400)}`);
  emitBusEvent({ user: plan.user, type: plan.status === "DONE" ? "task_done" : "task_failed", summary: `orkestrasi ${plan.status}`, data: { plan: plan.id } });
  return { plan, reconciliation, finalText: renderFinal(plan, reconciliation), orchestrated: true };
}

/** One coherent final response: status, what ran, what did not, evidence. */
export function renderFinal(plan: OrchestrationPlan, r: ReturnType<typeof reconcile>): string {
  const head = `**Status pekerjaan:** ${r.parentStatus} (${r.requiredSucceeded}/${r.requiredTotal} tahap wajib selesai)`;
  const done = plan.tasks.filter((t) => t.status === "SUCCEEDED" || t.status === "PARTIALLY_COMPLETED");
  const body = done.length
    ? done
        .map((t) => `${t.task_id} · ${agentProfile(t.agent_id)?.displayName ?? "tanpa agent"} — ${t.objective} → ${t.result_reference ?? "selesai"}`)
        .join("\n")
    : "Tidak ada tahap yang selesai.";
  const gap = r.disclosures.length ? `\n\n**Yang tidak selesai / perlu disclosing:**\n${r.disclosures.map((d) => `- ${d}`).join("\n")}` : "";
  return [head, "", body, gap].join("\n").trim();
}

/**
 * Entry point used by the turn wrapper: orchestrate only when the ask really
 * needs more than one capability. Everything else returns `orchestrated:false`
 * and lets the existing direct path answer.
 */
export async function orchestrateRequest(
  ask: string,
  user: string,
  runSubtask: SubtaskRunner,
  opts: RunPlanOptions = {}
): Promise<OrchestrationOutcome> {
  if (!shouldOrchestrate(ask)) {
    const plan = planFromRequest(ask, { user });
    return { plan, reconciliation: reconcile(plan), finalText: "", orchestrated: false };
  }
  const plan = planFromRequest(ask, { user });
  return runPlan(plan, runSubtask, opts);
}