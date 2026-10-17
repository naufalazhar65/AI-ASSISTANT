/**
 * Scheduler worker — finds due occurrences, guards them, and dispatches to the
 * engine (which uses the normal agent turn). Deliberately thin: it decides
 * WHAT runs and WHEN, never how a task executes.
 *
 * Guarantees implemented here:
 * - one execution per (workflow, occurrence) via `slot_key` + persisted
 *   history, so polling, restarts and duplicate ticks cannot double-run;
 * - a stale slot always advances `next_run_at` (audit 2026-10-16: skipping
 *   without rolling forward wedged a workflow forever after one missed run);
 * - a RUNNING record older than the workflow timeout is reaped, so a crash
 *   mid-turn cannot block every later occurrence;
 * - catch-up policy explicit (SKIP default) — no blanket replay of missed work;
 * - bounded retries with backoff recorded as a deadline, and a circuit breaker
 *   that pauses a repeatedly failing workflow instead of burning resources;
 * - one shared dispatch path, so `run_now` obeys the same in-flight guard.
 */

import { auditLog } from "../auditLog";
import { emitBusEvent } from "../bus";
import { alreadyStarted } from "../once";
import { liveTurnFor, runWorkflowOccurrence, type RunWorkflowOptions } from "./engine";
import { nextOccurrence, slotKey } from "./schedule";
import { listUsersWithWorkflows, readExecution, readExecutions, readWorkflow, readWorkflows, saveExecution, saveWorkflow, updateWorkflowProgress } from "./store";
import { WORKFLOW_BUDGET, type WorkflowDefinition, type WorkflowExecution } from "./types";
import { sanitizeUser } from "../users";

export interface TickResult {
  dispatched: number;
  skipped: number;
  failures: number;
  executions: WorkflowExecution[];
}

/** In-process guard: an occurrence being executed right now. */
const running = new Set<string>();

/** Occurrences currently dispatched from this process (dashboard/debug aid). */
export function runningSlots(): string[] {
  return [...running];
}

/** Re-entrancy guard: one tick at a time (a tick can run for minutes). */
let ticking = false;

/**
 * Should this occurrence fire? Returns a reason when not. Pure decision so
 * the policy is testable without a clock or a store.
 */
export function dueDecision(
  wf: WorkflowDefinition,
  now: number,
  lastExecution: WorkflowExecution | undefined
): { due: boolean; reason: string } {
  if (!wf.enabled) return { due: false, reason: "workflow NONAKTIF" };
  if (wf.paused) return { due: false, reason: "workflow dijeda" };
  if (wf.trigger_type === "event") return { due: false, reason: "menunggu event" };
  const next = wf.next_run_at;
  if (next === null || next === undefined) return { due: false, reason: "jadwal habis (satu kali sudah lewat)" };
  if (next > now) return { due: false, reason: "belum due" };
  // Catch-up policy decides what to do with a slot the worker slept through.
  // "Stale" is measured against the schedule's own rhythm, not a fixed clock:
  // a daily digest missed by 90s (restart) must still run, a daily digest
  // missed by a day is stale and only RUN_ONCE may replay it.
  const intervalMs = wf.schedule.kind === "interval" ? Math.max(1, wf.schedule.every_minutes ?? 1) * 60_000 : 60 * 60_000;
  const stale = now - next > Math.max(5 * 60_000, intervalMs);
  if (stale && wf.catch_up_policy === "SKIP") return { due: false, reason: "terlewat, kebijakan SKIP" };
  if (running.has(slotKey(wf.workflow_id, next))) return { due: false, reason: "sedang berjalan" };
  if (lastExecution && lastExecution.status === "RUNNING" && wf.concurrency_policy !== "ALLOW_PARALLEL")
    return { due: false, reason: "eksekusi sebelumnya masih jalan" };
  return { due: true, reason: "due" };
}

/** Compute and persist the next occurrence (also marks runonce as exhausted).
 *  Re-reads the stored definition first: the engine has just written run
 *  status/breaker state, and saving the tick's stale copy would erase it.
 *  `ownerKey` is explicit — never derived from the record's `created_by`. */
export function rollForward(wf: WorkflowDefinition, now: number, ownerKey: string): WorkflowDefinition {
  const fresh = readWorkflow(ownerKey, wf.workflow_id) ?? wf;
  const next = fresh.trigger_type === "event" ? null : nextOccurrence(fresh.schedule, fresh.timezone, now);
  return saveWorkflow(ownerKey, { ...fresh, next_run_at: next });
}

/** A still-open RUNNING occurrence of the same workflow (concurrency policy).
 *  Records older than the workflow timeout are orphans (crash/restart) and are
 *  reaped to FAILED — otherwise one crashed run blocks every later occurrence. */
function runningFor(userKey: string, wf: WorkflowDefinition, now: number): WorkflowExecution | undefined {
  const open = readExecutions(userKey).find((e) => e.workflow_id === wf.workflow_id && e.status === "RUNNING");
  if (!open) return undefined;
  const startedAt = open.started_at ? Date.parse(open.started_at) : 0;
  const deadline = startedAt + Math.max(60_000, wf.timeout_policy.timeout_ms);
  if (now > deadline) {
    auditLog(userKey, "workflow_orphan_reaped", `${wf.name}: eksekusi ${open.execution_id} yatim > ${Math.round((now - startedAt) / 1000)}s`);
    saveExecution(userKey, { ...open, status: "FAILED", finished_at: new Date(now).toISOString(), error_summary: `orphaned — process restart/timeout ${Math.round((now - startedAt) / 1000)}s` });
    return undefined;
  }
  return open;
}

/**
 * Single dispatch path for BOTH the worker and manual `run_now`, so a manual
 * trigger obeys the same in-flight guard and concurrency policy.
 */
export async function dispatchWorkflowRun(
  userKey: string,
  wf: WorkflowDefinition,
  sk: string,
  scheduledFor: number,
  opts: RunWorkflowOptions = {}
): Promise<WorkflowExecution> {
  running.add(sk);
  emitBusEvent({
    user: userKey,
    type: "task_started",
    actor: wf.agent_id,
    agent: wf.agent_id,
    summary: `Workflow ${wf.name} mulai berjalan`,
    data: { workflow_id: wf.workflow_id, slot_key: sk },
  });
  // `runWorkflowOccurrence` records a timeout as FAILED but does NOT abort the
  // turn, so the slot must stay held until the real promise settles — releasing
  // it on the wrapper's settle let the next tick (or `run_now`) start a second
  // overlapping turn (audit 2026-10-16).
  const turn = runWorkflowOccurrence(userKey, wf, sk, scheduledFor, opts);
  let timedOut = false;
  try {
    const done = await turn;
    // The engine swallows its own timeout error, so detect the orphan by the
    // live turn rather than by a rejection that never arrives.
    timedOut = done.status === "FAILED" && /melewati batas/.test(done.error_summary);
    return done;
  } catch (e) {
    timedOut = true;
    throw e;
  } finally {
    const live = liveTurnFor(sk);
    if ((timedOut || live) && live) void live.then(() => running.delete(sk), () => running.delete(sk));
    else running.delete(sk);
    emitBusEvent({
      user: userKey,
      type: "task_done",
      actor: wf.agent_id,
      agent: wf.agent_id,
      summary: `Workflow ${wf.name} selesai`,
      data: { workflow_id: wf.workflow_id, slot_key: sk },
    });
  }
}

/** Fire every due workflow once. Returns what actually happened. */
export async function runWorkflowTick(now = Date.now(), opts: RunWorkflowOptions = {}): Promise<TickResult> {
  const out: TickResult = { dispatched: 0, skipped: 0, failures: 0, executions: [] };
  if (ticking) return out;
  ticking = true;
  try {
    let budget = WORKFLOW_BUDGET.max_dispatches_per_tick;

    for (const rawUser of listUsersWithWorkflows()) {
      const userKey = sanitizeUser(rawUser) ?? rawUser;
      const workflows = readWorkflows(userKey).filter((w) => w.enabled);
      for (let wf of workflows) {
        const dueAt = wf.next_run_at;
        if (dueAt === null || dueAt === undefined) continue;
        const sk = slotKey(wf.workflow_id, dueAt);
        const processed = readExecution(userKey, sk);
        if (processed) {
          // Occurrence already processed → only roll forward, never re-run.
          const anchor = processed.finished_at ? Date.parse(processed.finished_at) : now;
          const rolled = nextOccurrence(wf.schedule, wf.timezone, anchor);
          if (rolled !== wf.next_run_at) updateWorkflowProgress(userKey, wf.workflow_id, { next_run_at: rolled });
          out.skipped += 1;
          continue;
        }
        const decision = dueDecision(wf, now, runningFor(userKey, wf, now));
        if (!decision.due) {
          // A slot the worker slept through MUST still advance, otherwise the
          // same stale instant stays due forever and the workflow is wedged
          // (audit 2026-10-16: SKIP without roll-forward killed daily digests).
          if (dueAt <= now && /terlewat/.test(decision.reason)) {
            const rolled = nextOccurrence(wf.schedule, wf.timezone, now);
            if (rolled !== wf.next_run_at) {
              updateWorkflowProgress(userKey, wf.workflow_id, { next_run_at: rolled });
              auditLog(userKey, "workflow_slot_skipped", `${wf.name}: slot ${sk} terlewat, lanjut ke ${new Date(rolled ?? 0).toISOString()}`);
            }
          }
          out.skipped += 1;
          continue;
        }
        if (budget <= 0) {
          out.skipped += 1;
          continue;
        }

        try {
          const attemptsAllowed = Math.max(1, wf.retry_policy.max_attempts);
          let attempt = 0;
          let exec: WorkflowExecution | null = null;
          let backoffUntil = 0;
          while (attempt < attemptsAllowed) {
            attempt += 1;
            // One attempt burns one budget slot. Counting the OCCURRENCE instead
            // let a max_attempts:10 workflow spend 10 turns of this tick's
            // budget and starve every other user (audit 2026-10-16).
            budget -= 1;
            exec = await dispatchWorkflowRun(userKey, wf, sk, dueAt, { ...opts, now: opts.now ?? (() => now), attempt });
            if (exec.status === "SUCCEEDED" || exec.status === "PARTIALLY_COMPLETED" || exec.status === "AWAITING_APPROVAL" || exec.status === "BLOCKED") break;
            if (attempt < attemptsAllowed && wf.retry_policy.backoff_ms > 0) {
              // Backoff is respected by the *next tick*: recording the deadline
              // instead of sleeping keeps the worker non-blocking and testable.
              // Re-read the stored row — the engine has just written the real
              // consecutive_failures/breaker state (audit 2026-10-16: writing
              // the tick's stale copy pinned the breaker counter forever).
              const fresh = readWorkflow(userKey, wf.workflow_id) ?? wf;
              const until = now + wf.retry_policy.backoff_ms * attempt;
              backoffUntil = Math.max(until, fresh.next_run_at ?? until);
              wf = updateWorkflowProgress(userKey, wf.workflow_id, { next_run_at: backoffUntil }) ?? fresh;
              // Stop here: the loop used to continue immediately AND the
              // rollForward below overwrote the deadline in the same tick, so the
              // declared backoff never delayed anything (audit 2026-10-16:
              // backoff 1h produced a next run 2s later).
              break;
            }
          }
          if (exec) {
            out.executions.push(exec);
            out.dispatched += 1;
            if (exec.status === "FAILED") out.failures += 1;
          }
          // A recorded backoff deadline is the next run; rolling forward here
          // would replace it with the natural occurrence and cancel the backoff.
          if (!backoffUntil) rollForward(wf, now, userKey);
        } catch (e) {
          out.failures += 1;
          auditLog(userKey, "workflow_error", `${wf.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    return out;
  } finally {
    ticking = false;
  }
}

/* --------------------------------------------------------------- the worker */

let timer: ReturnType<typeof setInterval> | null = null;

export function startWorkflowWorker(intervalMs = 60_000): void {
  if (timer) return;
  // `alreadyStarted` lives on globalThis (lib/once.ts): a module-level `timer`
  // is reset by HMR, which could otherwise start a SECOND interval and
  // dispatch every occurrence twice.
  if (!alreadyStarted("workflow_worker")) return;
  const tick = () => {
    void runWorkflowTick(Date.now()).catch(() => undefined);
  };
  timer = setInterval(tick, Math.max(15_000, intervalMs));
  timer.unref?.();
  // Do NOT execute anything merely because schedules were loaded.
  auditLog("system", "workflow_worker_started", `interval=${intervalMs}`);
}

/** Test-only: stop the interval so tests never leak a live timer. */
export function stopWorkflowWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
  running.clear();
  ticking = false;
}