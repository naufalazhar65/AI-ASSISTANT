import { rmSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { AgentResult, OrchestrationPlan, OrchestrationTask } from "./orchestration";
import { runPlan, renderFinal, type SubtaskRunner } from "./orchestrator";
import { computeLoopMetrics, readSessions } from "./recovery";
import { saveSession, newSession } from "./recovery";
import { DEFAULT_RECOVERY_BUDGET } from "./recovery/types";
import { userDataRoot } from "./users";

const USER = "verify_orch_loop";
const userDir = join(userDataRoot(), USER);
afterAll(() => rmSync(userDir, { recursive: true, force: true }));

let clock = 1_000;
const now = () => (clock += 10);

let seq = 0;
function task(over: Partial<OrchestrationTask> = {}): OrchestrationTask {
  seq += 1;
  return {
    task_id: over.task_id ?? `task_${seq}`,
    parent_task_id: null,
    agent_id: "mia",
    objective: "perbaiki test yang merah",
    task_type: "code",
    input_context: "",
    expected_output: "test hijau",
    acceptance_criteria: ["npm test hijau"],
    dependencies: [],
    priority: 1,
    required: true,
    status: "PLANNED",
    created_at: new Date(clock).toISOString(),
    started_at: null,
    completed_at: null,
    result_reference: null,
    evidence_references: [],
    error_summary: null,
    attempts: 0,
    idempotent: true,
    ...over,
  };
}

function plan(tasks: OrchestrationTask[], over: Partial<OrchestrationPlan> = {}): OrchestrationPlan {
  return {
    id: "plan_loop",
    user: USER,
    request: "perbaiki test dan tulis ringkasan",
    created_at: new Date(clock).toISOString(),
    status: "PLANNED",
    tasks,
    budget: {
      maxDepth: 2,
      maxTasks: 6,
      maxConcurrent: 1,
      maxRetries: 1,
      taskTimeoutMs: 5_000,
      maxDurationMs: 60_000,
    },
    notes: [],
    ...over,
  };
}

const ok = (validations: string[] = ["KRITERIA npm-test-hijau: npm test 42 passed"]): AgentResult => ({
  task_id: "task_1",
  agent_id: "mia",
  status: "SUCCEEDED",
  summary: "test hijau",
  findings: [],
  evidence_references: [],
  artifact_references: [],
  validations,
  errors: [],
  remaining_uncertainty: [],
  next_step: null,
});

const failing = (summary: string): AgentResult => ({ ...ok([]), status: "FAILED", summary });

describe("orchestrator problem-solving loop", () => {
  it("completes only when the criteria carry evidence", async () => {
    const p = plan([task()]);
    const out = await runPlan(p, async () => ok(), { now });
    expect(out.plan.tasks[0]?.status).toBe("SUCCEEDED");
    expect(out.plan.tasks[0]?.criteria_outcome).toBe("COMPLETE");
  });

  it("refuses to call an unevidenced answer a success", async () => {
    const p = plan([task()]);
    const out = await runPlan(p, async () => ok([]), { now });
    expect(out.plan.tasks[0]?.status).toBe("PARTIALLY_COMPLETED");
    expect(out.finalText).toMatch(/Kriteria belum terverifikasi/);
  });

  it("retries a transient failure once and then succeeds", async () => {
    let calls = 0;
    const p = plan([task()]);
    const out = await runPlan(
      p,
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("socket ETIMEDOUT");
        return ok();
      },
      { now },
    );
    expect(calls).toBe(2);
    expect(out.plan.tasks[0]?.status).toBe("SUCCEEDED");
    const session = readSessions(USER).find((s) => s.task_id === p.tasks[0]?.task_id);
    expect(session?.attempts[0]?.failure).toBe("TRANSIENT");
    expect(session?.attempts[0]?.recovery).toBe("retry");
  });

  it("stops instead of repeating the same failure forever", async () => {
    let calls = 0;
    const p = plan([task()]);
    const out = await runPlan(
      p,
      async () => {
        calls += 1;
        throw new Error("socket ETIMEDOUT");
      },
      { now },
    );
    expect(calls).toBe(2);
    expect(out.plan.tasks[0]?.status).toBe("FAILED");
    expect(out.plan.tasks[0]?.ps_failure).toBe("TRANSIENT");
    const session = readSessions(USER).find((s) => s.task_id === p.tasks[0]?.task_id);
    expect(session?.status).toBe("stopped");
    expect(session?.stop_reason).toBeTruthy();
  });

  it("routes an agent-reported failure through the same diagnosis", async () => {
    let calls = 0;
    const p = plan([task()]);
    const out = await runPlan(
      p,
      async () => {
        calls += 1;
        return calls === 1 ? failing("ETIMEDOUT saat baca log") : ok();
      },
      { now },
    );
    expect(calls).toBe(2);
    expect(out.plan.tasks[0]?.ps_failure).toBe("TRANSIENT");
    expect(out.plan.tasks[0]?.status).toBe("SUCCEEDED");
  });

  it("blocks on a missing approval and never re-runs the call", async () => {
    let calls = 0;
    const p = plan([task()]);
    const out = await runPlan(
      p,
      async () => {
        calls += 1;
        return failing("butuh persetujuan owner");
      },
      { now },
    );
    expect(calls).toBe(1);
    expect(out.plan.tasks[0]?.status).toBe("BLOCKED");
    expect(out.plan.tasks[0]?.ps_recovery).toBe("escalate");
  });

  it("never repeats a non-idempotent task automatically", async () => {
    let calls = 0;
    const p = plan([task({ idempotent: false })]);
    const out = await runPlan(
      p,
      async () => {
        calls += 1;
        throw new Error("ECONNRESET");
      },
      { now },
    );
    expect(calls).toBe(1);
    expect(out.plan.tasks[0]?.status).toBe("FAILED");
    expect(out.plan.tasks[0]?.error_summary).toMatch(/idempoten/);
    // Live drill 2026-10-18: the session stayed "active" with an empty
    // stop_reason, so an "active"-forever session is neither a stop nor a
    // reconciliation candidate and its attempts vanished from the metrics.
    const s = readSessions(USER).find((x: { id: string }) => x.id.endsWith(`${p.id}_${p.tasks[0].task_id}`));
    expect(s?.status).toBe("stopped");
    expect(s?.stop_reason).toMatch(/^stop:/);
    expect(s?.stop_reason).not.toMatch(/^retry:/);
  });

  it("discloses a capability gap instead of inventing an agent", async () => {
    const p = plan([task({ agent_id: null })]);
    const out = await runPlan(p, async () => ok(), { now });
    expect(out.plan.tasks[0]?.status).toBe("BLOCKED");
  });

  it("reports an interrupted session as unknown after a restart", async () => {
    const orphan = newSession({
      plan_id: "plan_old",
      user: USER,
      task_id: "task_orphan",
      agent_id: "mia",
      objective: "pekerjaan yang tertinggal",
      criteria: [],
      budget: DEFAULT_RECOVERY_BUDGET,
      now: clock - 60_000,
    });
    orphan.id = "ps_task_orphan";
    saveSession(USER, orphan);
    const p = plan([task()]);
    await runPlan(p, async () => ok(), { now });
    expect(p.notes.join(" ")).toMatch(/unknown setelah restart/);
    expect(readSessions(USER).find((s) => s.task_id === "task_orphan")?.status).toBe("unknown");
  });

  it("keeps the plan from claiming success while criteria stay unverified", () => {
    const text = renderFinal(plan([task({ status: "SUCCEEDED", criteria_outcome: "PARTIALLY_COMPLETED" })]), {
      parentStatus: "SUCCEEDED",
      requiredTotal: 1,
      requiredSucceeded: 1,
      requiredFailed: 0,
      requiredBlocked: 0,
      requiredCancelled: 0,
      optionalFailed: [],
      partial: ["t1"],
      unfinished: [],
      disclosures: [],
      contradictions: [],
    });
    expect(text).toMatch(/Kriteria belum terverifikasi/);
  });

  it("reports zero false successes for a real loop run", async () => {
    await runPlan(plan([task({ task_id: "task_metrics" })]), async () => ok(), { now });
    const m = computeLoopMetrics(readSessions(USER));
    expect(m.falseSuccessSessions).toBe(0);
    expect(m.falseSuccessRate).toBe(0);
    expect(m.sessions).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * Regression tests for the 2026-10-18 audit. Each one failed before the
 * matching fix; the comment says what the old code did wrong.
 * ------------------------------------------------------------------ */
describe("audit regressions (2026-10-18)", () => {
  it("gives a second identical request a fresh session, not the first one's attempts", async () => {
    // `task_id` is t1/t2 per plan, so a session id built from the task alone
    // was shared by every plan: the second request started with a spent
    // attempt budget and could be stopped as a "loop" on its very first try.
    const shared = task({ task_id: "t1" });
    let calls = 0;
    await runPlan(
      plan([shared], { id: "plan_first" }),
      async () => {
        calls += 1;
        throw new Error("socket ETIMEDOUT");
      },
      { now },
    );
    expect(calls).toBe(2);

    let secondCalls = 0;
    const p2 = plan([task({ task_id: "t1" })], { id: "plan_second" });
    await runPlan(
      p2,
      async () => {
        secondCalls += 1;
        throw new Error("socket ETIMEDOUT");
      },
      { now },
    );
    expect(secondCalls).toBe(2);
    const sessions = readSessions(USER).filter((s) => s.task_id === "t1");
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.attempts.length === 2)).toBe(true);
  });

  it("fingerprints the action, so a varying error message cannot hide a loop", async () => {
    let n = 0;
    const p = plan([task({ task_id: "task_fp" })], { id: "plan_fp", budget: { ...plan([]).budget, maxRetries: 4 } });
    await runPlan(
      p,
      async () => {
        n += 1;
        // A different port/id per attempt: same action, different text.
        throw new Error(`ECONNREFUSED 127.0.0.1:${5000 + n}`);
      },
      { now },
    );
    const session = readSessions(USER).find((s) => s.task_id === "task_fp");
    const prints = new Set(session?.attempts.map((a) => a.fingerprint) ?? []);
    expect(prints.size).toBe(1);
    expect(p.tasks[0]?.status).toBe("FAILED");
  });

  it("routes a proven-wrong criterion through DIAGNOSE instead of killing the task", async () => {
    let calls = 0;
    const p = plan([task({ task_id: "task_veto", acceptance_criteria: ["file:apps/web/verify-must-not-exist.ts"] })], {
      id: "plan_veto",
    });
    await runPlan(
      p,
      async () => {
        calls += 1;
        return ok();
      },
      { now },
    );
    // The probe proves the criterion wrong -> classify + record + retry, then
    // the attempt budget stops it. Before the fix the task died with no record.
    expect(calls).toBe(2);
    expect(p.tasks[0]?.ps_failure).toBe("VERIFICATION_FAILURE");
    const session = readSessions(USER).find((s) => s.task_id === "task_veto");
    expect(session?.attempts[0]?.failure).toBe("VERIFICATION_FAILURE");
    expect(session?.attempts[0]?.recovery).toBeTruthy();
  });

  it("never accepts a summary as attestation: only KRITERIA lines count", async () => {
    // A summary that echoes the criterion ID verbatim ("npm-test-hijau: 42
    // passed") is prose, not evidence: the marker is what makes it a claim the
    // agent chose to make as evidence.
    const selfCertifying: AgentResult = {
      ...ok([]),
      summary: "npm-test-hijau: 42 passed",
    };
    const p = plan([task({ task_id: "task_attest" })], { id: "plan_attest" });
    const out = await runPlan(p, async () => selfCertifying, { now });
    expect(p.tasks[0]?.criteria_outcome).not.toBe("COMPLETE");
    expect(out.plan.tasks[0]?.status).toBe("PARTIALLY_COMPLETED");
    // The same line WITH the marker is accepted — this is the two-way check.
    const marked: AgentResult = { ...ok([]), summary: "KRITERIA npm-test-hijau: npm test 42 passed" };
    const p2 = plan([task({ task_id: "task_attest2" })], { id: "plan_attest2" });
    await runPlan(p2, async () => marked, { now });
    expect(p2.tasks[0]?.criteria_outcome).toBe("COMPLETE");
  });

  it("counts the tool calls the turn really executed", async () => {
    const p = plan([task({ task_id: "task_tools" })], { id: "plan_tools" });
    await runPlan(
      p,
      async () => ({ ...ok(), tool_calls: 7 }),
      { now },
    );
    // A clean run has no attempt record; the number must come from the session
    // only through a real failure record, so assert the field is not invented.
    const session = readSessions(USER).find((s) => s.task_id === "task_tools");
    expect(session?.tool_calls).toBe(0);

    let n = 0;
    const p2 = plan([task({ task_id: "task_tools_fail" })], { id: "plan_tools_fail" });
    await runPlan(
      p2,
      async () => {
        n += 1;
        if (n === 1) throw new Error("socket ETIMEDOUT");
        return { ...ok(), tool_calls: 4 };
      },
      { now },
    );
    expect(p2.tasks[0]?.status).toBe("SUCCEEDED");
  });

  it("records the real tool-call count on the failing attempt", async () => {
    const p = plan([task({ task_id: "task_toolcount" })], { id: "plan_toolcount" });
    await runPlan(
      p,
      async () => ({ ...failing("ETIMEDOUT saat panggil API"), tool_calls: 5 }),
      { now },
    );
    const session = readSessions(USER).find((s) => s.task_id === "task_toolcount");
    // Two attempts ran (the failure was retried once), each reporting 5 calls.
    expect(session?.attempts).toHaveLength(2);
    expect(session?.attempts.map((a) => a.tool_calls)).toEqual([5, 5]);
    expect(session?.tool_calls).toBe(10);
  });
});
