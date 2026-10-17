/**
 * Lifecycle & interrupt tests — the seams a single-path suite never touches.
 *
 * Every case here is an owner or a clock acting WHILE a run is in flight:
 * pause mid-run, delete mid-run, timeout then the next tick, an approval that
 * expires while nobody is watching, and two triggers racing the same slot.
 *
 * Deterministic: injected clock, injected agent turn (deferred promises, no
 * wall-clock sleep), throwaway user key with cleanup. No LLM, no network.
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildWorkflow,
  deleteWorkflow,
  purgeWorkflows,
  readExecution,
  readExecutions,
  readWorkflow,
  readWorkflows,
  saveExecution,
  saveWorkflow,
} from "./store";
import { resolveApproval, runWorkflowOccurrence } from "./engine";
import { dispatchWorkflowRun, runWorkflowTick, runningSlots, stopWorkflowWorker } from "./worker";
import { slotKey } from "./schedule";
import type { WorkflowDefinition, WorkflowExecution } from "./types";

const USER = `wf_life_${process.pid}`;
const T0 = Date.parse("2026-03-02T00:00:00.000Z"); // 07:00 WIB

function base(over: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return buildWorkflow(
    USER,
    {
      name: "Lifecycle",
      trigger_type: "recurring",
      schedule: { kind: "daily", hour: 8, minute: 0 },
      agent_id: "agnes",
      task_type: "research",
      task_configuration: "riset ringkas",
      now: T0,
      ...over,
    } as never
  );
}

/** Force an occurrence time — `buildWorkflow` derives `next_run_at` itself. */
function at(wf: WorkflowDefinition, ms: number): WorkflowDefinition {
  return { ...wf, next_run_at: ms };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A turn that parks until the test releases it, then answers normally. */
function parkingTurn(text = "selesai") {
  const gate = deferred<never>();
  const turn = vi.fn(async () => {
    await gate.promise;
    return { text, needsConfirmation: null, messages: [{ role: "assistant", content: text }] };
  });
  return { turn, release: () => gate.resolve(undefined as never) };
}

const NOOP = { now: () => T0, notify: async () => true };

beforeEach(() => {
  mkdirSync(join(tmpdir(), "mia-wf-life"), { recursive: true });
  purgeWorkflows(USER);
  process.env.DISCORD_BOT_TOKEN_AGNES = "test-agnes";
  process.env.DISCORD_BOT_TOKEN_MICHELLE = "test-michelle";
});

afterEach(() => {
  stopWorkflowWorker();
  purgeWorkflows(USER);
  vi.restoreAllMocks();
});

describe("lifecycle: owner acts while a run is in flight", () => {
  it("pausing mid-run does not get silently reverted by the finishing run", async () => {
    const wf = at(base(), T0 - 1000);
    saveWorkflow(USER, wf);
    const { turn, release } = parkingTurn();
    const running = runWorkflowOccurrence(USER, wf, slotKey(wf.workflow_id, T0), T0, {
      ...NOOP,
      runTurn: turn as never,
    });
    // The owner clicks "pause" while the turn is still open.
    await Promise.resolve();
    saveWorkflow(USER, { ...readWorkflow(USER, wf.workflow_id)!, paused: true });
    release();
    await running;

    // A whole-object save inside the engine used to write back the stale copy
    // (audit 2026-10-16, HIGH: pause and delete were undone by the run that
    // started before them).
    expect(readWorkflow(USER, wf.workflow_id)?.paused).toBe(true);
    expect(readWorkflow(USER, wf.workflow_id)?.last_run_status).toBe("SUCCEEDED");
  });

  it("deleting mid-run does not resurrect the workflow", async () => {
    const wf = at(base(), T0 - 1000);
    saveWorkflow(USER, wf);
    const { turn, release } = parkingTurn();
    const running = runWorkflowOccurrence(USER, wf, slotKey(wf.workflow_id, T0), T0, {
      ...NOOP,
      runTurn: turn as never,
    });
    await Promise.resolve();
    expect(deleteWorkflow(USER, wf.workflow_id)).toBe(true);
    release();
    await running;

    expect(readWorkflows(USER)).toHaveLength(0);
    // The run itself is still real history — losing the job must not erase proof
    // that work happened.
    expect(readExecutions(USER)).toHaveLength(1);
  });

  it("a timed-out turn keeps its slot until the real turn settles", async () => {
    const wf = at(
      { ...base(), timeout_policy: { timeout_ms: 40 } },
      T0 - 1000
    );
    saveWorkflow(USER, wf);
    const { turn, release } = parkingTurn();
    const sk = slotKey(wf.workflow_id, wf.next_run_at as number);

    // The dispatch RECORDS a timeout as FAILED (the engine swallows its own
    // timeout error) while the turn is still running.
    const exec = await dispatchWorkflowRun(USER, readWorkflow(USER, wf.workflow_id)!, sk, T0, {
      ...NOOP,
      runTurn: turn as never,
    });
    expect(exec.status).toBe("FAILED");
    expect(exec.error_summary).toMatch(/melewati batas/);

    // Releasing the slot on that settle let the next tick start a SECOND
    // overlapping turn (audit 2026-10-16, HIGH-4). It stays held while the
    // orphan turn lives.
    expect(runningSlots()).toContain(sk);

    release();
    await vi.waitFor(() => expect(runningSlots()).not.toContain(sk));
  });

  it("an approval nobody answers is terminalised, not left waiting forever", async () => {
    const wf = base({ agent_id: "michelle", task_configuration: "deploy" });
    saveWorkflow(USER, wf);
    const turn = vi.fn(async () => ({
      text: "",
      needsConfirmation: [{ id: "c1", name: "git_commit", arguments: "{}" }],
      messages: [{ role: "user", content: "deploy" }],
    })) as never;
    const exec = await runWorkflowOccurrence(USER, wf, slotKey(wf.workflow_id, T0), T0, {
      ...NOOP,
      runTurn: turn,
    });
    expect(exec.status).toBe("AWAITING_APPROVAL");

    // Time passes past the TTL without a decision.
    const later = T0 + 60 * 60_000;
    await expect(
      resolveApproval(USER, exec.slot_key, true, "owner", { now: () => later })
    ).rejects.toThrow(/kedaluwarsa/);

    // Refusing is fine; leaving the row AWAITING_APPROVAL was the dead end.
    const stored = readExecution(USER, exec.slot_key);
    expect(stored?.status).toBe("FAILED");
    expect(stored?.error_summary).toMatch(/kedaluwarsa/);
    expect(readWorkflow(USER, wf.workflow_id)?.last_run_status).toBe("FAILED");
  });

  it("two triggers racing the same occurrence run it exactly once", async () => {
    const wf = at(base(), T0 - 1000);
    saveWorkflow(USER, wf);
    const { turn, release } = parkingTurn();
    const runOpts = { ...NOOP, runTurn: turn as never };

    // Both triggers fire before the first finishes (the shape of a tick racing a
    // manual run_now, or two ticks from a duplicated interval).
    const first = runWorkflowTick(T0, runOpts);
    const second = runWorkflowTick(T0, runOpts);
    release();
    await Promise.all([first, second]);

    expect(turn).toHaveBeenCalledTimes(1);
    expect(readExecutions(USER)).toHaveLength(1);
    expect(readExecution(USER, slotKey(wf.workflow_id, T0 - 1000))?.status).toBe("SUCCEEDED");
  });

  it("a stale RUNNING record is reaped so later occurrences can still run", async () => {
    const wf = at(base(), T0 - 1000);
    saveWorkflow(USER, wf);
    // Older than the default 300s timeout: a younger RUNNING row is a genuine
    // in-flight run and MUST keep blocking (that is the concurrency policy).
    const orphanAge = 60 * 60_000;
    const orphan: WorkflowExecution = {
      execution_id: "ex-orphan",
      workflow_id: wf.workflow_id,
      slot_key: slotKey(wf.workflow_id, T0 - orphanAge),
      agent_id: "agnes",
      status: "RUNNING",
      trigger: "recurring",
      scheduled_for: new Date(T0 - orphanAge).toISOString(),
      started_at: new Date(T0 - orphanAge).toISOString(),
      finished_at: null,
      attempts: 1,
      executed_tools: [],
      tool_error: false,
      artifacts: [],
      evidence_reference: "",
      result_text: "",
      error_summary: "",
      notified: false,
      provider_used: null,
      model: null,
      duration_ms: 0,
    };
    saveExecution(USER, orphan);

    const turn = vi.fn(async () => ({
      text: "hasil",
      needsConfirmation: null,
      messages: [{ role: "assistant", content: "hasil" }],
    })) as never;
    const r = await runWorkflowTick(T0, { ...NOOP, runTurn: turn });
    expect(r.dispatched).toBe(1);
    expect(readExecution(USER, orphan.slot_key)?.status).toBe("FAILED");
    expect(readExecution(USER, orphan.slot_key)?.error_summary).toMatch(/orphan/);
  });

  it("a RUNNING row younger than the timeout still blocks (concurrency policy)", async () => {
    const wf = at(base(), T0 - 1000);
    saveWorkflow(USER, wf);
    const live: WorkflowExecution = {
      execution_id: "ex-live",
      workflow_id: wf.workflow_id,
      slot_key: slotKey(wf.workflow_id, T0 - 60_000),
      agent_id: "agnes",
      status: "RUNNING",
      trigger: "recurring",
      scheduled_for: new Date(T0 - 60_000).toISOString(),
      started_at: new Date(T0 - 60_000).toISOString(),
      finished_at: null,
      attempts: 1,
      executed_tools: [],
      tool_error: false,
      artifacts: [],
      evidence_reference: "",
      result_text: "",
      error_summary: "",
      notified: false,
      provider_used: null,
      model: null,
      duration_ms: 0,
    };
    saveExecution(USER, live);
    const turn = vi.fn() as never;
    const r = await runWorkflowTick(T0, { ...NOOP, runTurn: turn });
    expect(r.dispatched).toBe(0);
    expect(readExecution(USER, live.slot_key)?.status).toBe("RUNNING");
  });
});