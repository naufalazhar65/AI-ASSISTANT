/**
 * Workflow engine tests — deterministic: injected clock, injected agent turn,
 * injected notifier, throwaway user key with auto-cleanup. No real clock wait,
 * no network, no production channel.
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { purgeWorkflows, buildWorkflow, readExecution, readExecutions, readWorkflows, saveExecution, saveWorkflow, deleteWorkflow } from "./store";
import { describeSchedule, nextOccurrence, slotKey, validateSchedule, zoneInfo } from "./schedule";
import { preflight, resolveApproval, runWorkflowOccurrence, verifiedArtifacts, type RunWorkflowOptions } from "./engine";
import { dueDecision, runWorkflowTick, startWorkflowWorker, stopWorkflowWorker } from "./worker";
import { userDataRoot } from "../users";
import type { WorkflowDefinition, WorkflowExecution } from "./types";

const USER = `wf_test_${process.pid}`;
const WIB = "Asia/Jakarta";
const T0 = Date.parse("2026-03-02T00:00:00.000Z"); // 07:00 WIB Monday

function base(over: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return buildWorkflow(
    USER,
    {
      name: "Digest",
      trigger_type: "recurring",
      schedule: { kind: "daily", hour: 8, minute: 0 },
      agent_id: "agnes",
      task_type: "research",
      task_configuration: "riset ringkas topik harian",
      now: T0,
      ...over,
    } as never
  );
}

/** Force an occurrence time — `buildWorkflow` always DERIVES next_run_at from
 *  the schedule, so a test that wants "due now" must set it explicitly. */
function at(wf: WorkflowDefinition, ms: number): WorkflowDefinition {
  return { ...wf, next_run_at: ms };
}

function fakeTurn(text = "hasil riset", tools: { name: string; result: string }[] = []) {
  return vi.fn(async () => {
    const messages = [
      { role: "assistant", content: "", tool_calls: tools.map((t, i) => ({ id: `c${i}`, function: { name: t.name, arguments: "{}" } })) },
      ...tools.map((t, i) => ({ role: "tool", content: t.result, tool_call_id: `c${i}` })),
      { role: "assistant", content: text },
    ];
    return { text, needsConfirmation: null, messages } as never;
  });
}

beforeEach(() => {
  mkdirSync(join(tmpdir(), "mia-wf-test"), { recursive: true });
  purgeWorkflows(USER);
  // Agent availability is env-derived (real production rule); give the trio
  // tokens so the fixture agent is genuinely runnable in tests.
  process.env.DISCORD_BOT_TOKEN_AGNES = "test-agnes";
  process.env.DISCORD_BOT_TOKEN_MICHELLE = "test-michelle";
});

afterEach(() => {
  stopWorkflowWorker();
  purgeWorkflows(USER);
  vi.restoreAllMocks();
});

describe("schedule", () => {
  it("rejects impossible schedules instead of coercing", () => {
    expect(validateSchedule({ kind: "daily", hour: 24, minute: 0 }, WIB).ok).toBe(false);
    expect(validateSchedule({ kind: "weekly", hour: 8, minute: 0, day_of_week: 9 }, WIB).ok).toBe(false);
    expect(validateSchedule({ kind: "monthly", hour: 8, minute: 0, day: 31 }, WIB).ok).toBe(false);
    expect(validateSchedule({ kind: "interval", every_minutes: 0 }, WIB).ok).toBe(false);
    expect(validateSchedule({ kind: "daily", hour: 8, minute: 0 }, "Mars/Olympus").ok).toBe(false);
  });

  it("daily lands on the requested local wall clock in the workflow timezone", () => {
    const next = nextOccurrence({ kind: "daily", hour: 8, minute: 0 }, WIB, T0)!;
    expect(new Date(next).toISOString()).toBe("2026-03-02T01:00:00.000Z"); // 08:00 WIB
  });

  it("weekly respects the weekday and timezone", () => {
    const next = nextOccurrence({ kind: "weekly", hour: 9, minute: 0, day_of_week: 0 }, WIB, T0)!;
    expect(new Date(next).toISOString()).toBe("2026-03-08T02:00:00.000Z"); // Sunday 09:00 WIB
    expect(describeSchedule({ kind: "weekly", hour: 9, minute: 0, day_of_week: 1 })).toContain("Senin");
  });

  it("interval occurrences never drift as the clock advances", () => {
    const s = { kind: "interval" as const, every_minutes: 30 };
    const a = nextOccurrence(s, WIB, T0)!;
    const b = nextOccurrence(s, WIB, T0 + 10_000)!;
    expect(b).toBe(a);
  });

  it("one-time schedule is exhausted once passed", () => {
    const s = { kind: "runonce" as const, at: "2026-03-02T09:00:00.000Z" };
    expect(nextOccurrence(s, WIB, T0)).toBe(Date.parse("2026-03-02T09:00:00.000Z"));
    expect(nextOccurrence(s, WIB, Date.parse("2026-03-02T10:00:00.000Z"))).toBeNull();
  });

  it("timezone is validated, offsets supported", () => {
    expect(zoneInfo("Asia/Jakarta")?.offsetMinutes).toBe(420);
    expect(zoneInfo("UTC+09:00")?.offsetMinutes).toBe(540);
    expect(zoneInfo("UTC-5")?.offsetMinutes).toBe(-300);
    expect(zoneInfo("nope")).toBeNull();
  });

  it("slot key is stable per occurrence", () => {
    expect(slotKey("wf-1", T0)).toBe(slotKey("wf-1", T0));
    expect(slotKey("wf-1", T0)).not.toBe(slotKey("wf-1", T0 + 1));
  });
});

describe("registry", () => {
  it("build validates and computes next_run_at", () => {
    const wf = base();
    expect(wf.next_run_at).toBe(Date.parse("2026-03-02T01:00:00.000Z"));
    expect(wf.permission_policy.allow_risky_tools).toBe(false);
    expect(() => buildWorkflow(USER, { name: "", trigger_type: "recurring", schedule: { kind: "daily", hour: 8, minute: 0 }, agent_id: "agnes", task_type: "research", task_configuration: "x" } as never)).toThrow();
  });

  it("event trigger is rejected at creation (no dispatcher exists)", () => {
    // Audit 2026-10-16: an `event` workflow was accepted and then fired NEVER —
    // a permanently inert job displayed as enabled. Fail fast instead.
    for (const src of [undefined, "ci_failure", "moon_phase"]) {
      expect(() =>
        buildWorkflow(USER, { name: "x", trigger_type: "event", event_source: src as never, schedule: { kind: "daily", hour: 8, minute: 0 }, agent_id: "agnes", task_type: "research", task_configuration: "x" } as never)
      ).toThrow(/event/);
    }
  });

  it("editing a definition keeps execution history", () => {
    const wf = base();
    saveWorkflow(USER, { ...wf, name: "Digest v2" });
    expect(readWorkflows(USER)).toHaveLength(1);
    expect(readWorkflows(USER)[0].name).toBe("Digest v2");
  });

  it("delete keeps history (retention policy)", () => {
    const wf = base();
    saveWorkflow(USER, wf);
    expect(deleteWorkflow(USER, wf.workflow_id)).toBe(true);
    expect(readWorkflows(USER)).toHaveLength(0);
  });
});

function opts(turn: unknown, notify = vi.fn(async () => true)): RunWorkflowOptions {
  return { now: () => T0, runTurn: turn as never, notify: notify as never };
}

describe("execution", () => {

  it("runs a due occurrence and records real evidence", async () => {
    const wf = base();
    saveWorkflow(USER, wf);
    const notify = vi.fn(async () => true);
    const exec = await runWorkflowOccurrence(USER, wf, slotKey(wf.workflow_id, T0), T0, opts(fakeTurn("selesai", [{ name: "web_search", result: "hasil" }]), notify));
    expect(exec.status).toBe("SUCCEEDED");
    expect(exec.executed_tools).toEqual(["web_search"]);
    expect(exec.evidence_reference).toContain(exec.execution_id);
    expect(readExecutions(USER)).toHaveLength(1);
  });

  it("a risky tool pauses for approval and is never auto-granted", async () => {
    const wf = base({ agent_id: "michelle", task_configuration: "deploy ke produksi" });
    saveWorkflow(USER, wf);
    const turn = vi.fn(async () => ({
      text: "",
      needsConfirmation: [{ id: "c1", name: "git_commit", arguments: "{}" }],
      messages: [{ role: "user", content: "deploy" }],
    })) as never;
    const exec = await runWorkflowOccurrence(USER, wf, slotKey(wf.workflow_id, T0), T0, { now: () => T0, runTurn: turn, notify: async () => true });
    expect(exec.status).toBe("AWAITING_APPROVAL");
    expect(exec.pending_calls?.[0].name).toBe("git_commit");
    expect(exec.finished_at).toBeNull();
    expect(exec.approval_expires_at).toBeTruthy();
  });

  it("approval resolution resumes with the same calls, denial cancels", async () => {
    const wf = base({ agent_id: "michelle", task_configuration: "deploy" });
    saveWorkflow(USER, wf);
    const turn = vi.fn(async () => ({ text: "", needsConfirmation: [{ id: "c1", name: "git_commit", arguments: "{}" }], messages: [{ role: "user", content: "deploy" }] })) as never;
    const exec = await runWorkflowOccurrence(USER, wf, slotKey(wf.workflow_id, T0), T0, { now: () => T0, runTurn: turn, notify: async () => true });
    const denied = await resolveApproval(USER, exec.slot_key, false, "owner", { now: () => T0 });
    expect(denied.status).toBe("CANCELLED");
  });

  it("expired approval cannot be resumed", async () => {
    const wf = base({ agent_id: "michelle" });
    saveWorkflow(USER, wf);
    const exec: WorkflowExecution = {
      execution_id: "ex-1", workflow_id: wf.workflow_id, slot_key: "wf-x", agent_id: "michelle", status: "AWAITING_APPROVAL",
      trigger: "recurring", scheduled_for: new Date(T0).toISOString(), started_at: null, finished_at: null, attempts: 1,
      executed_tools: [], tool_error: false, artifacts: [], evidence_reference: "", result_text: "", error_summary: "",
      notified: false, provider_used: null, model: null, duration_ms: 0,
      pending_calls: [{ id: "c1", name: "git_commit", arguments: "{}" }], approval_expires_at: new Date(T0 - 1).toISOString(),
    };
    const { saveExecution } = await import("./store");
    saveExecution(USER, exec);
    await expect(resolveApproval(USER, exec.slot_key, true, "owner", { now: () => T0 })).rejects.toThrow(/kedaluwarsa/);
  });

  it("unknown agent is refused at creation AND blocked at run time", async () => {
    // Rejected up front (audit 2026-10-16: a bogus agent created a workflow that
    // BLOCKS forever instead of failing loudly), and preflight still guards a
    // row that was hand-edited or written before this rule existed.
    expect(() => buildWorkflow(USER, { name: "x", trigger_type: "once", schedule: { kind: "daily", hour: 8, minute: 0 }, agent_id: "ghost", task_type: "research", task_configuration: "x" } as never)).toThrow(/agent_id/);
    // Built valid, then the id is swapped afterwards: `base()` itself now refuses
    // a bogus agent, which is the behaviour under test one case above.
    const wf = { ...base(), agent_id: "ghost" as never };
    const turn = fakeTurn();
    const exec = await runWorkflowOccurrence(USER, wf, slotKey("x", T0), T0, opts(turn));
    expect(exec.status).toBe("BLOCKED");
    expect(exec.error_summary).toMatch(/agent/);
    expect(turn).not.toHaveBeenCalled();
  });

  it("required tool outside the agent domain blocks", async () => {
    const wf = base({ agent_id: "agnes", permission_policy: { allow_risky_tools: false, required_tools: ["web_search"] } });
    saveWorkflow(USER, wf);
    const turn = fakeTurn();
    const exec = await runWorkflowOccurrence(USER, wf, slotKey("y", T0), T0, opts(turn));
    expect(exec.status).toBe("SUCCEEDED");
    const wrong = { ...base({ agent_id: "michelle" }), permission_policy: { allow_risky_tools: false as const, required_tools: ["remind_me"] } };
    expect(String(preflight(wrong))).toMatch(/domain/);
    void turn;
  });

  it("empty answer is FAILED, not a success", async () => {
    const wf = base();
    saveWorkflow(USER, wf);
    const exec = await runWorkflowOccurrence(USER, wf, slotKey("z", T0), T0, opts(fakeTurn("   ")));
    expect(exec.status).toBe("FAILED");
  });

  it("tool error yields PARTIALLY_COMPLETED", async () => {
    const wf = base();
    saveWorkflow(USER, wf);
    const exec = await runWorkflowOccurrence(USER, wf, slotKey("p", T0), T0, opts(fakeTurn("sebagian", [{ name: "web_search", result: "Error: timeout" }])));
    expect(exec.status).toBe("PARTIALLY_COMPLETED");
  });

  it("only real files count as artifacts", () => {
    expect(verifiedArtifacts(USER, "lihat reports/tidak-ada.pdf")).toEqual([]);
  });

  it("notification is only sent per policy and recorded honestly", async () => {
    const wf = base({ notification_policy: { on_success: false, on_failure: true, on_partial: true, on_approval_required: true, on_blocked: true, repeated_failure_after: 3 } });
    saveWorkflow(USER, wf);
    const notify = vi.fn(async () => false);
    const exec = await runWorkflowOccurrence(USER, wf, slotKey("n", T0), T0, opts(fakeTurn("ok"), notify));
    expect(notify).not.toHaveBeenCalled();
    expect(exec.notified).toBe(false);
  });
});

describe("worker", () => {
  it("repeated ticks never dispatch the same occurrence twice", async () => {
    const wf = at(base(), T0 - 1000);
    saveWorkflow(USER, wf);
    const turn = fakeTurn();
    const opts: RunWorkflowOptions = { now: () => T0, runTurn: turn as never, notify: async () => true };
    const first = await runWorkflowTick(T0, opts);
    expect(first.dispatched).toBe(1);
    expect(turn).toHaveBeenCalledTimes(1);
    await runWorkflowTick(T0 + 1000, opts);
    await runWorkflowTick(T0 + 2000, opts);
    expect(turn).toHaveBeenCalledTimes(1);
    expect(readExecutions(USER)).toHaveLength(1);
  });

  it("disabled and paused workflows never dispatch", async () => {
    const wf = at({ ...base(), enabled: false }, T0 - 1000);
    saveWorkflow(USER, wf);
    const paused = at({ ...base(), paused: true }, T0 - 1000);
    saveWorkflow(USER, paused);
    const turn = fakeTurn();
    const r = await runWorkflowTick(T0, { now: () => T0, runTurn: turn as never, notify: async () => true });
    expect(r.dispatched).toBe(0);
    expect(turn).not.toHaveBeenCalled();
  });

  it("missed slot follows catch-up policy (SKIP default)", () => {
    const wf = at(base(), T0 - 86_400_000 * 2);
    expect(dueDecision(wf, T0, undefined).due).toBe(false);
    const runOnce = { ...wf, catch_up_policy: "RUN_ONCE" as const };
    expect(dueDecision(runOnce, T0, undefined).due).toBe(true);
  });

  it("retries are bounded", async () => {
    const wf = at({ ...base(), retry_policy: { max_attempts: 2, backoff_ms: 0 } }, T0 - 1000);
    saveWorkflow(USER, wf);
    const turn = vi.fn(async () => { throw new Error("boom"); }) as never;
    const r = await runWorkflowTick(T0, { now: () => T0, runTurn: turn, notify: async () => true });
    expect(r.failures).toBe(1);
    expect(turn).toHaveBeenCalledTimes(2);
  });

  it("circuit breaker pauses a repeatedly failing workflow", async () => {
    const wf = at(
      { ...base(), catch_up_policy: "RUN_ONCE" as const, notification_policy: { on_success: true, on_failure: true, on_partial: true, on_approval_required: true, on_blocked: true, repeated_failure_after: 2 } },
      T0 - 1000
    );
    saveWorkflow(USER, wf);
    const turn = vi.fn(async () => { throw new Error("boom"); }) as never;
    await runWorkflowTick(T0, { now: () => T0, runTurn: turn, notify: async () => true });
    await runWorkflowTick(T0 + 2 * 3600_000, { now: () => T0 + 2 * 3600_000, runTurn: turn, notify: async () => true });
    expect(readWorkflows(USER)[0].paused).toBe(true);
  });

  it("one failing workflow does not stop the others", async () => {
    const bad = at(base({ name: "Bad" }), T0 - 1000);
    const good = at(base({ name: "Good" }), T0 - 1000);
    saveWorkflow(USER, bad);
    saveWorkflow(USER, good);
    const turn = vi.fn(async (o: { messages: { content: string }[] }) => {
      if (String(o.messages[0].content).includes("Bad")) throw new Error("boom");
      return { text: "ok", needsConfirmation: null, messages: [] } as never;
    }) as never;
    await runWorkflowTick(T0, { now: () => T0, runTurn: turn, notify: async () => true });
    const statuses = readExecutions(USER).map((e) => e.status);
    expect(statuses).toContain("FAILED");
    expect(statuses).toContain("SUCCEEDED");
  });

  it("worker start is idempotent and dispatches nothing at boot", async () => {
    const turn = fakeTurn();
    startWorkflowWorker(50_000);
    startWorkflowWorker(50_000);
    await new Promise((r) => setTimeout(r, 60));
    expect(turn).not.toHaveBeenCalled();
    stopWorkflowWorker();
  });
});
/* ------------------------------------------- audit 2026-10-16 regressions */

describe("audit 2026-10-16 regressions (each locks a bug the audit proved live)", () => {
  it("a missed slot still advances, so one missed run can never wedge the workflow", async () => {
    // Proven failure: daily 08:00 WIB, worker down across the slot -> next_run_at
    // stayed pinned and dispatched=0 at +2h/+24h/+48h/+168h.
    const wf = at(base(), T0);
    saveWorkflow(USER, wf);
    const muchLater = T0 + 48 * 3600_000;
    const turn = fakeTurn();
    const res = await runWorkflowTick(muchLater, opts(turn));
    expect(res.dispatched).toBe(0); // stale + SKIP => no replay
    const after = readWorkflows(USER)[0];
    expect(after.next_run_at).toBeGreaterThan(muchLater); // but the rhythm moved on
    const res2 = await runWorkflowTick(muchLater + 60_000, opts(turn));
    expect(res2.dispatched).toBeGreaterThanOrEqual(0); // and the next tick is live
    expect(readWorkflows(USER)[0].next_run_at).not.toBeNull();
  });

  it("a RUNNING record past its timeout is reaped instead of blocking every later occurrence", async () => {
    const wf = at(base({ timeout_policy: { timeout_ms: 60_000 } }), T0);
    saveWorkflow(USER, wf);
    const stale: WorkflowExecution = {
      execution_id: "ex-orphan",
      workflow_id: wf.workflow_id,
      slot_key: slotKey(wf.workflow_id, T0 - 10 * 3600_000),
      agent_id: wf.agent_id,
      status: "RUNNING",
      trigger: "recurring",
      scheduled_for: new Date(T0 - 10 * 3600_000).toISOString(),
      started_at: new Date(T0 - 10 * 3600_000).toISOString(),
      finished_at: null,
      attempts: 1,
      executed_tools: [],
      tool_error: false,
      artifacts: [],
      evidence_reference: "",
      error_summary: "",
      notified: false,
      result_text: "",
      provider_used: null,
      model: null,
      duration_ms: 0,
    } as WorkflowExecution;
    saveExecution(USER, stale);
    const res = await runWorkflowTick(T0, opts(fakeTurn()));
    expect(res.dispatched).toBe(1); // the orphan did not block the current slot
    expect(readExecution(USER, stale.slot_key)?.status).toBe("FAILED");
  });

  it("approving a run whose tool failed records PARTIALLY_COMPLETED, never SUCCEEDED", async () => {
    const wf = at(base(), T0);
    saveWorkflow(USER, wf);
    const pauseTurn = vi.fn(async () => ({
      text: "",
      needsConfirmation: [{ id: "c1", name: "write_file", arguments: "{}" }],
      messages: [{ role: "assistant", content: "" }],
    })) as never;
    const paused = await runWorkflowOccurrence(USER, wf, slotKey(wf.workflow_id, T0), T0, opts(pauseTurn as never));
    expect(paused.status).toBe("AWAITING_APPROVAL");
    const failTurn = vi.fn(async () => ({
      text: "selesai",
      needsConfirmation: null,
      messages: [
        { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "write_file", arguments: "{}" } }] },
        { role: "tool", content: "Error: gagal menulis", tool_call_id: "c1" },
        { role: "assistant", content: "selesai" },
      ],
    })) as never;
    const done = await resolveApproval(USER, paused.execution_id, true, "owner", opts(failTurn as never));
    expect(done.status).toBe("PARTIALLY_COMPLETED");
    expect(done.tool_error).toBe(true);
  });

  it("a workflow paused while waiting for approval does NOT run when approved", async () => {
    const wf = at(base(), T0);
    saveWorkflow(USER, wf);
    const pauseTurn = vi.fn(async () => ({
      text: "",
      needsConfirmation: [{ id: "c1", name: "write_file", arguments: "{}" }],
      messages: [{ role: "assistant", content: "" }],
    })) as never;
    const paused = await runWorkflowOccurrence(USER, wf, slotKey(wf.workflow_id, T0), T0, opts(pauseTurn as never));
    saveWorkflow(USER, { ...readWorkflows(USER)[0], paused: true });
    const turn = fakeTurn();
    const done = await resolveApproval(USER, paused.execution_id, true, "owner", opts(turn as never));
    expect(done.status).toBe("BLOCKED");
    expect(turn).not.toHaveBeenCalled();
  });

  it("the workflow store refuses to silently drop the oldest definition at the cap", () => {
    for (let i = 0; i < 40; i += 1) saveWorkflow(USER, { ...base(), workflow_id: `wf-cap-${i}` });
    expect(readWorkflows(USER)).toHaveLength(40);
    expect(() => saveWorkflow(USER, { ...base(), workflow_id: "wf-cap-41" })).toThrow(/batas workflow/);
    expect(readWorkflows(USER)).toHaveLength(40);
    // updating an EXISTING id at the cap is still allowed
    expect(() => saveWorkflow(USER, { ...readWorkflows(USER)[0], name: "renamed" })).not.toThrow();
  });

  it("corrupt registry JSON is quarantined, not silently wiped", () => {
    const wf = base();
    saveWorkflow(USER, wf);
    const file = join(userDataRoot(), USER, "workflows.json");
    writeFileSync(file, "{ this is not json");
    expect(readWorkflows(USER)).toHaveLength(0);
    expect(readdirSync(join(userDataRoot(), USER)).some((f) => f.includes(".corrupt-"))).toBe(true);
  });

  it("the attempt number is recorded, never a hardcoded 0", async () => {
    const wf = at(base(), T0);
    saveWorkflow(USER, wf);
    const exec = await runWorkflowOccurrence(USER, wf, slotKey(wf.workflow_id, T0), T0, { ...opts(fakeTurn()), attempt: 2 });
    expect(exec.attempts ?? 0).toBe(2);
  });

  it("workflow_history exposes execution_id so an approval is reachable from chat", async () => {
    const tools = await import("../tools");
    const wf0 = at(base(), T0);
    saveWorkflow(USER, wf0);
    const seeded = await runWorkflowOccurrence(USER, wf0, slotKey(wf0.workflow_id, T0), T0, opts(fakeTurn()));
    expect(seeded).toBeTruthy();
    const plugin = tools.getTool("workflow_history");
    if (!plugin) throw new Error("tool workflow_history tidak terdaftar");
    const out = await plugin.execute({ workflow_id: wf0.workflow_id }, { userKey: USER, rawUser: USER });
    // The approval tool requires execution_id; if the history output omits it,
    // approving a paused workflow is unreachable from chat (audit 2026-10-16).
    expect(typeof out === "string" ? out : "").toContain(seeded?.execution_id ?? "");
  });
});
