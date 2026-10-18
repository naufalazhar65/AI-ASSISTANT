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
import { isTestUserKey } from "./users";
import { agentProfile, agentsForCategory, isAvailableAgent } from "./agentRegistry";
import {
  attemptFingerprint,
  classifyFailure,
  criterionId,
  decideRecovery,
  errorLine,
  evaluateCriteria,
  fileProber,
  getSession,
  markSessionActive,
  newSession,
  recordAttempt,
  reconcileSessions,
  recoveryBudgetFromEnv,
  releaseSession,
  saveSession,
  type AcceptanceCriterion,
  type CriteriaOutcome,
  type CriterionProber,
  type PsSession,
} from "./recovery";

export type SubtaskRunner = (task: OrchestrationTask, plan: OrchestrationPlan) => Promise<AgentResult>;

export interface RunPlanOptions {
  /** Called on every state change so callers can persist/report progress. */
  onPlanChange?: (plan: OrchestrationPlan) => void;
  /** Polled between waves; return true to stop (cancellation). */
  shouldStop?: () => boolean;
  now?: () => number;
  /** Emitted to Discord/Telegram; defaults to the deterministic progress block. */
  progress?: (line: string) => void;
  /** VERIFY prober. Defaults to the file-shaped prober; tool probes need this. */
  probe?: CriterionProber;
  /** Set when verification itself is impossible (disclosed, never a silent pass). */
  verificationBlocked?: string;
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

/* ------------------------------------------------------------------ *
 * Problem-solving loop: PLAN -> EXECUTE -> OBSERVE -> VERIFY ->
 * DIAGNOSE -> RECOVER|STOP. One persisted session per task; every
 * attempt, classification and decision is a record, never prose.
 * ------------------------------------------------------------------ */

/**
 * Session id per PLAN+TASK. `task_id` alone is `t1`, `t2`, … — the planner
 * restarts numbering for every request, so a plan-scoped id alone would make
 * the second identical request inherit the first one's attempts and be stopped
 * as a "loop" on its very first try. The plan id carries a timestamp, so the id
 * stays stable across a restart of the SAME plan (that is what reconciliation
 * needs) and never collides across plans.
 */
function sessionIdFor(plan: OrchestrationPlan, task: OrchestrationTask): string {
  return `ps_${plan.id}_${task.task_id}`;
}

// A criterion may carry a machine probe written as `file:<path>` (relative to
// the repo root). That form is what makes the VERIFY veto reachable: without a
// probe an unmet claim can only stay UNKNOWN, never proven false.
function criteriaFor(task: OrchestrationTask): AcceptanceCriterion[] {
  return task.acceptance_criteria.map((raw) => {
    const probeMatch = /^file:(.+)$/.exec(raw.trim());
    const description = probeMatch ? probeMatch[1]!.trim() : raw;
    return {
      id: criterionId(description),
      description,
      ...(probeMatch ? { probe: { kind: "file_exists" as const, path: probeMatch[1]!.trim() } } : {}),
    };
  });
}

function ensureSession(plan: OrchestrationPlan, task: OrchestrationTask, nowMs: number): PsSession {
  const id = sessionIdFor(plan, task);
  const criteria = criteriaFor(task);
  const existing = getSession(plan.user, id);
  if (existing) {
    // The stored criteria must follow the task, not the other way round: a
    // stale session would grade a fresh task against criteria nobody is
    // attesting any more, and every criterion would stay UNKNOWN forever.
    const drifted =
      existing.criteria.length !== criteria.length ||
      existing.criteria.some((c, i) => c.id !== criteria[i]?.id || c.description !== criteria[i]?.description);
    if (drifted) {
      existing.criteria = criteria;
      existing.updated_at = nowMs;
      saveSession(plan.user, existing);
    }
    // Reconciliation marked this session `unknown` (a crash left its outcome
    // undetermined). Re-running the same plan is allowed, but it must be
    // disclosed and must NOT inherit the old attempt budget: the new run gets
    // its own attempts while the record keeps the history.
    if (existing.status === "unknown") {
      existing.status = "active";
      existing.stop_reason = undefined;
      existing.attempts = [];
      existing.recovery_subtasks = 0;
      existing.tool_calls = 0;
      existing.delegation_depth = 0;
      existing.updated_at = nowMs;
      saveSession(plan.user, existing);
      plan.notes.push(
        `sesi ${id} dilanjutkan setelah hasil sebelumnya tidak diketahui; percobaan lama tidak dihitung sebagai bagian dari budget run ini`,
      );
    }
    return existing;
  }
  const session = newSession({
    plan_id: plan.id,
    user: plan.user,
    task_id: task.task_id,
    agent_id: task.agent_id,
    objective: task.objective,
    criteria,
    budget: recoveryBudgetFromEnv(),
    now: nowMs,
  });
  session.id = id;
  saveSession(plan.user, session);
  return session;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Attestations come from the agent's explicit `KRITERIA <id>: <evidence>`
 * lines. The marker is REQUIRED: a summary that merely mentions the criterion
 * id ("npm test hijau: 42 passed") is prose, not evidence, and counting it would
 * let a claim certify itself. A criterion without a marked line stays UNKNOWN.
 */
function attestationsFromResult(criteria: AcceptanceCriterion[], result: AgentResult): Record<string, string> {
  const body = [...(result.validations ?? []), result.summary ?? ""].join("\n");
  const out: Record<string, string> = {};
  for (const c of criteria) {
    const re = new RegExp(`^\\s*KRITERIA\\s+${escapeRe(c.id)}\\s*[:\\-—]\\s*(\\S.*)$`, "i");
    for (const line of body.split("\n")) {
      const m = line.match(re);
      if (m?.[1]) {
        out[c.id] = m[1].trim().slice(0, 200);
        break;
      }
    }
  }
  return out;
}

async function verifyTask(
  plan: OrchestrationPlan,
  task: OrchestrationTask,
  result: AgentResult,
  opts: RunPlanOptions,
): Promise<CriteriaOutcome> {
  const session = ensureSession(plan, task, (opts.now ?? Date.now)());
  const outcome = await evaluateCriteria(session.criteria, {
    prober: opts.probe ?? fileProber,
    attestations: attestationsFromResult(session.criteria, result),
    blocked: opts.verificationBlocked,
  });
  session.criteria_outcome = outcome.verdict;
  session.updated_at = (opts.now ?? Date.now)();
  saveSession(plan.user, session);
  task.criteria_outcome = outcome.verdict;
  return outcome;
}

function delegateFor(task: OrchestrationTask): string | null {
  return (
    agentsForCategory(task.task_type)
      .map((p) => p.label)
      .find((label) => label !== task.agent_id && isAvailableAgent(label)) ?? null
  );
}

/**
 * DIAGNOSE + recovery decision for one failure. Returns the status the task
 * should take next; a non-idempotent task is never re-run automatically.
 */
/**
 * Failure facts that cannot be read out of the error text: they come from the
 * VERIFY probe, the agent result, or the owner-decision state.
 */
export interface FailureSignals {
  verificationFailed?: boolean;
  clearCause?: boolean;
  approvalState?: "required" | "declined";
  blockedBy?: "scope" | "role" | "policy" | "unknown";
  missingInformation?: boolean;
  /** Real tool calls this attempt executed (budget + report, never estimated). */
  toolCalls?: number;
  /** Criteria state at failure time, so a retry cites real numbers. */
  criteria?: { met: number; total: number };
}

/** Terminal task => the session is a stop, with the reason a reader can audit. */
function markSessionStopped(user: string, sessionId: string, reason: string): void {
  const s = getSession(user, sessionId);
  if (!s) return;
  s.status = "stopped";
  s.stop_reason = reason;
  saveSession(user, s);
}

function recoverTask(
  plan: OrchestrationPlan,
  task: OrchestrationTask,
  errorText: string,
  opts: RunPlanOptions,
  startedAt: number,
  signals: FailureSignals = {},
): { status: OrchestrationTask["status"]; summary: string } {
  const nowMs = (opts.now ?? Date.now)();
  const session = ensureSession(plan, task, nowMs);
  const line = errorLine(errorText) || "gagal tanpa pesan";
  const classification = classifyFailure({ error: line, phase: "EXECUTE", ...signals });
  // Fingerprint the ACTION, never the error text: a message that changes
  // slightly between attempts (a different port, a new id) is the same action,
  // and loop detection has to see that. The error stays in `action`/`error`.
  const fingerprint = attemptFingerprint([task.task_type, task.objective.slice(0, 80)]);
  const attempts = session.attempts.length + 1;
  // The DECISION must read the session as persisted: a pre-write snapshot would
  // under-count attempts and let the loop retry past its own budget.
  const liveSession =
    recordAttempt(plan.user, session.id, {
      n: attempts,
      task_id: task.task_id,
      phase: "DIAGNOSE",
      action: `${task.objective.slice(0, 60)} — ${line.slice(0, 60)}`,
      fingerprint,
      failure: classification.failure,
      error: line,
      at: nowMs,
      duration_ms: Math.max(0, nowMs - startedAt),
      tool_calls: signals.toolCalls ?? 0,
    }) ?? session;
  const decision = decideRecovery({
    failure: classification.failure,
    attempts: liveSession.attempts,
    // The plan budget stays authoritative for retry count (initial + maxRetries);
    // the loop budget governs class policy, loop detection and the other caps.
    budget: { ...session.budget, maxAttempts: Math.min(session.budget.maxAttempts, plan.budget.maxRetries + 1) },
    recoverySubtasks: liveSession.recovery_subtasks,
    delegationDepth: liveSession.delegation_depth,
    toolCalls: liveSession.tool_calls,
    elapsedMs: nowMs - startedAt,
    delegateCandidates: delegateFor(task) ? [delegateFor(task)!] : [],
    // No recoveryReason here on purpose: the loop's own previous reason must not
    // justify the next repeat. Only a caller with a real, documented change
    // (different attempt fingerprint) earns a repeated attempt.
    fingerprint,
    criteriaMet: signals.criteria?.met,
    criteriaTotal: signals.criteria?.total,
    confidence: classification.confidence,
  });
  task.ps_phase = "DIAGNOSE";
  task.ps_failure = classification.failure;

  // Persist the decision on the attempt itself, for EVERY branch: a recovery
  // that is not recorded is indistinguishable from a silent repeat.
  const live = getSession(plan.user, session.id);
  if (live && live.attempts.length) {
    const last = live.attempts[live.attempts.length - 1];
    if (last) {
      last.recovery = decision.action;
      last.recovery_reason = decision.reason;
    }
    saveSession(plan.user, live);
    if (decision.action === "stop" || decision.action === "escalate") {
      markSessionStopped(plan.user, session.id, `${decision.action}: ${decision.reason}`);
    }
  }

  const finish = (status: OrchestrationTask["status"], extra = ""): { status: OrchestrationTask["status"]; summary: string } => {
    const summary = `${classification.failure}: ${line}${extra ? ` — ${extra}` : ""}`;
    task.ps_recovery = decision.action;
    task.ps_recovery_reason = decision.reason;
    task.error_summary = summary;
    // A task that ends here must not leave the session marked "active": an
    // active session is neither a stop nor a reconciliation candidate, so its
    // attempts silently vanish from the loop metrics.
    if (status !== "READY") {
      // A retry/replan decision that the task cannot take (non-idempotent) IS a
      // stop; labelling it "retry" in the reason would misreport what happened.
      const effective = decision.action === "retry" || decision.action === "replan" ? "stop" : decision.action;
      markSessionStopped(plan.user, session.id, `${effective}: ${summary}`);
    }
    return { status, summary };
  };

  switch (decision.action) {
    case "retry":
    case "replan": {
      if (!task.idempotent) {
        return finish("FAILED", "tidak idempoten, tidak diulang otomatis");
      }
      task.ps_phase = "RECOVER";
      task.ps_recovery = decision.action;
      task.ps_recovery_reason = decision.reason;
      task.status = "READY";
      task.error_summary = `${line} — pemulihan: ${decision.reason}`;
      return { status: "READY", summary: task.error_summary };
    }
    case "delegate": {
      const target = delegateFor(task);
      if (!target) return finish("FAILED", "tidak ada agent tersedia untuk Recover");
      task.agent_id = target as OrchestrationTask["agent_id"];
      task.ps_phase = "RECOVER";
      task.ps_recovery = "delegate";
      task.ps_recovery_reason = decision.reason;
      task.status = "READY";
      task.error_summary = `${line} — didelegasikan ke ${target}: ${decision.reason}`;
      return { status: "READY", summary: task.error_summary };
    }
    case "escalate":
      task.ps_phase = "STOP";
      return finish("BLOCKED", decision.reason);
    default:
      task.ps_phase = "STOP";
      return finish("FAILED", decision.loop ? "loop: pemulihan tidak maju" : decision.reason);
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
  // Restart reconciliation: a session left active by a crash has an UNKNOWN
  // outcome. It is disclosed, never silently resumed, so an external effect
  // that already happened is not duplicated.
  const orphans = reconcileSessions(plan.user, { now: startedAt });
  for (const row of orphans) {
    plan.notes.push(`sesi ${row.task_id} berstatus unknown setelah restart: ${row.reason}`);
  }
  emitBusEvent({ user: plan.user, type: "task_started", summary: `orkestrasi mulai: ${plan.tasks.length} tahap`, data: { plan: plan.id } });
  // Evaluation runs execute real plans under a throwaway key. They must not
  // append to the audit log the repo uses as forensics ground truth (one run
  // added 262 lines; audit 2026-10-16).
  if (!isTestUserKey(plan.user)) {
    auditLog(plan.user, "orchestration_start", `plan=${plan.id} tasks=${plan.tasks.length}`);
  }

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
      const taskStartedAt = now();
      // Live marker: reconcileSessions must not declare this session "unknown"
      // while it is still running in this process (a second plan for the same
      // user would otherwise fabricate a crash).
      markSessionActive(plan.user, sessionIdFor(plan, task));
      try {
        const result = await withTimeout(() => runSubtask(task, plan), plan.budget.taskTimeoutMs);
        if (result.status === "SUCCEEDED") {
          // VERIFY before success: a probe or attestation decides, not the
          // agent's own claim. A FAILED verdict vetoes the success.
          const outcome = await verifyTask(plan, task, result, opts);
          const ref = `result:${task.task_id} — ${firstLine(result.summary) || task.objective}`;
          if (outcome.verdict === "FAILED") {
            // A proven-wrong criterion is a real failure with a clear cause, so
            // it goes through DIAGNOSE like any other: the loop may continue
            // while criteria are unmet and the budget lasts. Killing the task
            // here (the first version) made VERIFICATION_FAILURE unreachable.
            const unmet = outcome.rows.filter((r) => r.status === "unmet").map((r) => r.id);
            const rec = recoverTask(
              plan,
              task,
              `verifikasi gagal: ${unmet.join(", ")}`,
              opts,
              taskStartedAt,
              {
                verificationFailed: true,
                // Unmet criterion ids name a concrete cause; UNKNOWN rows do not.
                clearCause: unmet.length > 0,
                toolCalls: result.tool_calls,
                criteria: { met: outcome.met, total: outcome.met + outcome.unmet + outcome.unknown },
              },
            );
            task.status = rec.status;
          } else if (outcome.verdict === "BLOCKED" || outcome.verdict === "PARTIALLY_COMPLETED") {
            const v = transition(task, "PARTIALLY_COMPLETED", {
              result_reference: ref,
              evidence_references: dedupe([...(task.evidence_references ?? []), ...(result.evidence_references ?? [])]),
            });
            if (v.ok) Object.assign(task, v.task);
            else task.status = "FAILED";
          } else {
            const v = transition(task, "SUCCEEDED", {
              result_reference: ref,
              evidence_references: dedupe([...(task.evidence_references ?? []), ...(result.evidence_references ?? [])]),
              error_summary: result.errors?.length ? result.errors.join("; ") : null,
            });
            if (!v.ok) task.error_summary = v.reason;
            else Object.assign(task, v.task);
          }
          const session = getSession(plan.user, sessionIdFor(plan, task));
          if (session) {
            session.status = task.status === "SUCCEEDED" ? "succeeded" : "stopped";
            if (task.status !== "SUCCEEDED") session.stop_reason = `criteria ${outcome.verdict}`;
            saveSession(plan.user, session);
          }
        } else if (result.status === "PARTIALLY_COMPLETED") {
          const v = transition(task, "PARTIALLY_COMPLETED", {
            result_reference: `result:${task.task_id} — ${firstLine(result.summary) || task.objective}`,
          });
          if (v.ok) Object.assign(task, v.task);
        } else {
          // Agent reported FAILED: classify it like a throw so the loop sees one
          // code path for every failure.
          const rec = recoverTask(plan, task, result.summary || "gagal tanpa ringkasan", opts, taskStartedAt, {
            toolCalls: result.tool_calls,
          });
          task.status = rec.status;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const rec = recoverTask(plan, task, msg, opts, taskStartedAt);
        task.status = rec.status;
      } finally {
        releaseSession(plan.user, sessionIdFor(plan, task));
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
    // PARTIALLY_COMPLETED is kept as its own plan status. Flattening it into
    // DONE is the "task appears complete" failure this whole stack guards
    // against: the eval case `orc-partial-failure-not-completed` caught a plan
    // whose required task had FAILED being reported as DONE.
    plan.status =
      reconciliation.parentStatus === "SUCCEEDED"
        ? "DONE"
        : reconciliation.parentStatus === "CANCELLED"
          ? "CANCELLED"
          : reconciliation.parentStatus === "PARTIALLY_COMPLETED"
            ? "PARTIALLY_COMPLETED"
            : "FAILED";
  }
  persist(plan, opts);
  if (!isTestUserKey(plan.user)) {
    auditLog(plan.user, "orchestration_end", `plan=${plan.id} status=${plan.status} ${JSON.stringify(reconciliation).slice(0, 400)}`);
  }
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
  // Criteria that were not verifiable stay visible: "unknown" is not "met".
  const unverified = plan.tasks
    .filter((t) => t.criteria_outcome && t.criteria_outcome !== "COMPLETE")
    .map((t) => `- ${t.task_id}: kriteria ${t.criteria_outcome}`);
  const unverif = unverified.length ? `\n\n**Kriteria belum terverifikasi:**\n${unverified.join("\n")}` : "";
  const recovered = plan.tasks
    .filter((t) => t.ps_recovery && t.ps_recovery !== "stop")
    .map((t) => `- ${t.task_id}: ${t.ps_failure} → ${t.ps_recovery} (${t.ps_recovery_reason})`);
  const rec = recovered.length ? `\n\n**Pemulihan:**\n${recovered.join("\n")}` : "";
  return [head, "", body, gap, unverif, rec].join("\n").trim();
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