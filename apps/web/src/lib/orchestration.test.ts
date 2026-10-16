import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { AGENT_REGISTRY, agentProfile, agentsForCategory, availableAgents, isAvailableAgent, unavailableReason } from "./agentRegistry";
import {
  ALLOWED_TRANSITIONS,
  DEFAULT_BUDGET,
  TERMINAL_STATES,
  canRetry,
  canTransition,
  findContradictions,
  hasCycle,
  progressLine,
  readyTasks,
  reconcile,
  transition,
  validatePlan,
  type AgentResult,
  type OrchestrationPlan,
  type OrchestrationTask,
} from "./orchestration";
import { planFromRequest, pickAgent, shouldOrchestrate } from "./orchestrationPlanner";
import { cancelPlan, getPlan, listPlans, savePlan } from "./orchestrationStore";
import { orchestrateRequest, runPlan, type SubtaskRunner } from "./orchestrator";

const TEST_USER = "orch_test_user";
const USER_DIR = join(process.cwd(), "apps", "web", ".data", "users", TEST_USER);

function task(over: Partial<OrchestrationTask> = {}): OrchestrationTask {
  const base: OrchestrationTask = {
    task_id: "t1",
    parent_task_id: null,
    agent_id: "mia",
    objective: "Kerjakan sesuatu",
    task_type: "coordinate",
    input_context: "req",
    expected_output: "hasil",
    acceptance_criteria: ["selesai"],
    dependencies: [],
    priority: 1,
    required: true,
    status: "PLANNED",
    created_at: "2026-01-01T00:00:00.000Z",
    started_at: null,
    completed_at: null,
    result_reference: null,
    evidence_references: [],
    error_summary: null,
    attempts: 0,
    idempotent: true,
  };
  const merged = { ...base, ...over };
  // Objectives must be distinct per task — validatePlan refuses duplicate
  // objectives on purpose, so a shared fixture default would block the plan.
  if (!("objective" in over)) merged.objective = `Kerjakan ${merged.task_id}`;
  return merged;
}

function plan(tasks: OrchestrationTask[], over: Partial<OrchestrationPlan> = {}): OrchestrationPlan {
  return {
    id: "plan_1",
    user: TEST_USER,
    request: "req",
    created_at: "2026-01-01T00:00:00.000Z",
    status: "PLANNED",
    tasks,
    budget: { ...DEFAULT_BUDGET },
    notes: [],
    ...over,
  };
}

function result(over: Partial<AgentResult> = {}): AgentResult {
  return {
    task_id: "t1",
    agent_id: "mia",
    status: "SUCCEEDED",
    summary: "beres",
    findings: ["satu"],
    evidence_references: [],
    artifact_references: [],
    validations: [],
    errors: [],
    remaining_uncertainty: [],
    next_step: null,
    ...over,
  };
}

const savedEnv = { ...process.env };
beforeEach(() => {
  process.env.DISCORD_BOT_TOKEN_AGNES = "x";
  process.env.DISCORD_BOT_TOKEN_MICHELLE = "x";
});
afterEach(() => {
  process.env = { ...savedEnv };
});
afterEach(() => {
  try {
    rmSync(USER_DIR, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

describe("agent registry — capability facts, not persona vibes", () => {
  it("every registered agent has a machine-readable profile", () => {
    for (const label of ["mia", "agnes", "michelle"] as const) {
      const p = agentProfile(label);
      expect(p).toBeTruthy();
      expect(p!.categories.length).toBeGreaterThan(0);
      expect(p!.restrictions.length).toBeGreaterThan(0);
    }
    // Specialists are gated by roleGate, so they must list real domains. Mia is
    // the coordinator and is deliberately NOT gated (roleGate.agentDomains
    // returns undefined for her) — an empty list is the honest fact, not a gap.
    expect(AGENT_REGISTRY.agnes.domains.length).toBeGreaterThan(0);
    expect(AGENT_REGISTRY.michelle.domains.length).toBeGreaterThan(0);
    expect(AGENT_REGISTRY.mia.domains).toHaveLength(0);
  });

  it("§17: an unregistered agent is never operational", () => {
    expect(agentProfile("bob")).toBeUndefined();
    expect(isAvailableAgent("bob")).toBe(false);
    expect(unavailableReason("bob")).toContain("tidak terdaftar");
  });

  it("§17: a registered-but-tokenless agent is NOT available", () => {
    delete process.env.DISCORD_BOT_TOKEN_AGNES;
    delete process.env.SLACK_BOT_TOKEN_AGNES;
    expect(isAvailableAgent("agnes")).toBe(false);
    expect(unavailableReason("agnes")).toContain("token kanal");
    expect(availableAgents().map((a) => a.label)).not.toContain("agnes");
  });

  it("capability domains match the real roleGate gate", () => {
    expect(AGENT_REGISTRY.agnes.domains).toEqual(expect.arrayContaining(["research"]));
    expect(AGENT_REGISTRY.michelle.domains).toEqual(expect.arrayContaining(["code"]));
    expect(agentsForCategory("research").map((a) => a.label)).toContain("agnes");
  });
});

describe("task lifecycle — transitions are explicit and terminal is final", () => {
  it("§7: illegal transitions are refused", () => {
    expect(canTransition("PLANNED", "RUNNING")).toBe(false);
    expect(canTransition("RUNNING", "SUCCEEDED")).toBe(true);
    for (const s of TERMINAL_STATES) expect(ALLOWED_TRANSITIONS[s]).toHaveLength(0);
  });

  it("§7/§18: a task cannot become SUCCEEDED without a result reference", () => {
    const t = task({ status: "RUNNING" });
    const bad = transition(t, "SUCCEEDED");
    expect(bad.ok).toBe(false);
    const good = transition(t, "SUCCEEDED", { result_reference: "res_1" });
    expect(good.ok).toBe(true);
    expect(good.ok && good.task.completed_at).not.toBeNull();
  });

  it("§7: awaiting approval cannot jump straight to done", () => {
    expect(canTransition("AWAITING_APPROVAL", "SUCCEEDED")).toBe(false);
    expect(canTransition("AWAITING_APPROVAL", "QUEUED")).toBe(true);
  });

  it("a completed task keeps its result + evidence", () => {
    const t = task({ status: "RUNNING" });
    const r = transition(t, "SUCCEEDED", { result_reference: "res_9", evidence_references: ["audit:1"] });
    expect(r.ok && r.task.result_reference).toBe("res_9");
    expect(r.ok && r.task.evidence_references).toEqual(["audit:1"]);
  });
});

describe("dependency graph", () => {
  it("§16.5/6: independent tasks run concurrently, dependents wait", () => {
    const tasks = [task({ task_id: "a" }), task({ task_id: "b" }), task({ task_id: "c", dependencies: ["a", "b"] })];
    const first = readyTasks(tasks).map((t) => t.task_id);
    expect(first.sort()).toEqual(["a", "b"]);
    const after = readyTasks([{ ...tasks[0], status: "SUCCEEDED" }, { ...tasks[1], status: "SUCCEEDED" }, tasks[2]]);
    expect(after.map((t) => t.task_id)).toEqual(["c"]);
    expect(after[0].status).toBe("READY");
  });

  it("§14: cancellation propagates to waiting dependents (BLOCKED, never run)", () => {
    const tasks = [task({ task_id: "a", status: "CANCELLED" }), task({ task_id: "b", dependencies: ["a"] })];
    const r = readyTasks(tasks);
    expect(r.find((t) => t.task_id === "a")).toBeUndefined();
    expect(r.find((t) => t.task_id === "b")?.status).toBe("BLOCKED");
  });

  it("a failed dependency blocks rather than unblocks", () => {
    const r = readyTasks([task({ task_id: "a", status: "FAILED" }), task({ task_id: "b", dependencies: ["a"] })]);
    expect(r.find((t) => t.task_id === "b")?.status).toBe("BLOCKED");
  });

  it("§15: circular delegation is detected", () => {
    expect(hasCycle([task({ task_id: "a", dependencies: ["b"] }), task({ task_id: "b", dependencies: ["a"] })])).toBe(true);
    expect(hasCycle([task({ task_id: "a" }), task({ task_id: "b", dependencies: ["a"] })])).toBe(false);
  });

  it("validatePlan rejects cycles, unknown deps, unregistered and unavailable agents", () => {
    const issues = validatePlan(
      plan([
        task({ task_id: "a", dependencies: ["zzz"], agent_id: "ghost" as never }),
        task({ task_id: "b", dependencies: ["a"] }),
      ])
    );
    const codes = issues.map((i) => i.code);
    expect(codes).toContain("unknown-dependency");
    expect(codes).toContain("unregistered-agent");
    const cyc = validatePlan(plan([task({ task_id: "a", dependencies: ["b"] }), task({ task_id: "b", dependencies: ["a"] })]));
    expect(cyc.map((i) => i.code)).toContain("cycle");
    delete process.env.DISCORD_BOT_TOKEN_MICHELLE;
    expect(validatePlan(plan([task({ agent_id: "michelle" })])).map((i) => i.code)).toContain("unavailable-agent");
  });

  it("rejects duplicate objectives and budget overflow", () => {
    const dup = validatePlan(
      plan([task({ task_id: "a", objective: "Sama persis" }), task({ task_id: "b", objective: "Sama persis" })])
    );
    expect(dup.map((i) => i.code)).toContain("duplicate-objective");
    const many = validatePlan(plan(Array.from({ length: 9 }, (_, i) => task({ task_id: `t${i}`, objective: `o${i}` }))));
    expect(many.map((i) => i.code)).toContain("budget-exceeded");
  });
});

describe("retry policy", () => {
  it("§10/§16.13: non-idempotent work is never blindly retried", () => {
    expect(canRetry(task({ attempts: 0, idempotent: false }), DEFAULT_BUDGET)).toBe(false);
    expect(canRetry(task({ attempts: 0, idempotent: true }), DEFAULT_BUDGET)).toBe(true);
    expect(canRetry(task({ attempts: 5, idempotent: true }), DEFAULT_BUDGET)).toBe(false);
  });
});

describe("planner — deterministic, no extra LLM call", () => {
  it("§2: a simple conversation never becomes a workflow", () => {
    expect(shouldOrchestrate("halo")).toBe(false);
    expect(shouldOrchestrate("apa kabar?")).toBe(false);
    expect(shouldOrchestrate("ya")).toBe(false);
    expect(shouldOrchestrate("cek")).toBe(false);
    const single = "tolong riset mendalam tentang pasar kopi di indonesia";
    expect(shouldOrchestrate(single)).toBe(false);
  });

  it("§3: a multi-objective ask decomposes into chained subtasks", () => {
    const ask = "riset mendalam tentang OWASP lalu perbaiki kode validasi di file auth.ts dan buatkan unit test untuknya";
    expect(shouldOrchestrate(ask)).toBe(true);
    const p = planFromRequest(ask, { user: TEST_USER });
    expect(p.tasks.length).toBeGreaterThanOrEqual(2);
    expect(p.tasks[1].dependencies).toEqual([p.tasks[0].task_id]);
    expect(p.tasks[0].agent_id).toBe("agnes");
    expect(p.tasks[1].agent_id).toBe("michelle");
    expect(validatePlan(p).map((i) => i.code)).not.toContain("cycle");
  });

  it("§4: an agent is never assigned for a capability gap", () => {
    delete process.env.DISCORD_BOT_TOKEN_MICHELLE;
    delete process.env.SLACK_BOT_TOKEN_MICHELLE;
    expect(pickAgent("code")).toBe("mia");
    expect(pickAgent("assistant")).toBe("mia");
    expect(AGENT_REGISTRY.michelle.categories).toContain("code");
  });
});

describe("runtime — runPlan", () => {
  it("§16.1/§18: a direct ask executes zero subtasks", async () => {
    let calls = 0;
    const runner: SubtaskRunner = async () => {
      calls += 1;
      return result();
    };
    const out = await orchestrateRequest("halo, apa kabar?", TEST_USER, runner);
    expect(out.orchestrated).toBe(false);
    expect(out.finalText).toBe("");
    expect(calls).toBe(0);
  });

  it("§16.2: independent tasks run concurrently, dependents after", async () => {
    const order: string[] = [];
    const runner: SubtaskRunner = async (t) => {
      order.push(`start:${t.task_id}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end:${t.task_id}`);
      return result({ task_id: t.task_id, agent_id: t.agent_id ?? "mia" });
    };
    const p = plan([
      task({ task_id: "a" }),
      task({ task_id: "b" }),
      task({ task_id: "c", dependencies: ["a", "b"], required: false }),
    ]);
    const out = await runPlan(p, runner);
    expect(out.orchestrated).toBe(true);
    expect(order.indexOf("start:c")).toBeGreaterThan(order.indexOf("end:a"));
    expect(out.plan.status).toBe("DONE");
    expect(out.plan.tasks.every((t) => t.status === "SUCCEEDED")).toBe(true);
  });

  it("§16.7: parent is not SUCCEEDED when a required subtask fails", async () => {
    const runner: SubtaskRunner = async (t) =>
      t.task_id === "a" ? result({ task_id: "a", status: "FAILED", summary: "gagal" }) : result({ task_id: t.task_id });
    const out = await runPlan(plan([task({ task_id: "a" }), task({ task_id: "b", dependencies: ["a"] })]), runner);
    expect(out.plan.status).toBe("FAILED");
    expect(out.reconciliation.requiredFailed).toBe(1);
    expect(out.finalText).toContain("gagal");
  });

  it("§16.8: an optional failure yields PARTIALLY_COMPLETED, not success", async () => {
    const runner: SubtaskRunner = async (t) =>
      t.task_id === "a" ? result({ task_id: "a", status: "FAILED", summary: "opsional gagal" }) : result({ task_id: t.task_id });
    const out = await runPlan(plan([task({ task_id: "a", required: false }), task({ task_id: "b" })]), runner);
    // `plan.status` was "DONE" here until the eval case
    // `orc-partial-failure-not-completed` caught a plan with a failed task
    // reporting DONE. A partial run is its own status now — the headline the
    // owner and the dashboard read must not round it up.
    expect(out.plan.status).toBe("PARTIALLY_COMPLETED");
    expect(out.reconciliation.parentStatus).toBe("PARTIALLY_COMPLETED");
    expect(out.finalText).toContain("opsional");
  });

  it("§16.9/§10: task identity + provenance survive the handoff", async () => {
    const seen: string[] = [];
    const runner: SubtaskRunner = async (t) => {
      seen.push(t.task_id);
      return result({ task_id: t.task_id, summary: `hasil ${t.task_id}`, evidence_references: [`audit:${t.task_id}`] });
    };
    const out = await runPlan(plan([task({ task_id: "t9" })]), runner);
    expect(seen).toEqual(["t9"]);
    expect(out.plan.tasks[0].result_reference).toContain("hasil");
  });

  it("§16.10: one agent cannot report another agent's work as done", async () => {
    // A subtask that returns nothing usable must not become SUCCEEDED.
    const runner: SubtaskRunner = async (t) => result({ task_id: t.task_id, status: "FAILED", summary: "tidak ada hasil" });
    const out = await runPlan(plan([task({ task_id: "a" })]), runner);
    expect(out.plan.tasks[0].status).toBe("FAILED");
    expect(out.reconciliation.parentStatus).toBe("FAILED");
  });

  it("§16.14: cancellation stops queued work", async () => {
    const started: string[] = [];
    let stop = false;
    const runner: SubtaskRunner = async (t) => {
      started.push(t.task_id);
      if (t.task_id === "a") stop = true;
      return result({ task_id: t.task_id });
    };
    // maxConcurrent 1 so "b" is genuinely QUEUED (with 2 it would be dispatched
    // in the same wave, and cancelling must not kill already-dispatched work).
    const out = await runPlan(plan([task({ task_id: "a" }), task({ task_id: "b" })], { budget: { ...DEFAULT_BUDGET, maxConcurrent: 1 } }), runner, {
      shouldStop: () => stop,
    });
    expect(started).toEqual(["a"]);
    expect(out.plan.tasks.find((t) => t.task_id === "b")?.status).toBe("CANCELLED");
  });

  it("§15: a cycle is refused before anything executes", async () => {
    let calls = 0;
    const runner: SubtaskRunner = async (t) => {
      calls += 1;
      return result({ task_id: t.task_id });
    };
    const out = await runPlan(plan([task({ task_id: "a", dependencies: ["b"] }), task({ task_id: "b", dependencies: ["a"] })]), runner);
    expect(calls).toBe(0);
    expect(out.plan.status).toBe("FAILED");
    expect(out.plan.notes.join(" ")).toContain("siklus");
  });

  it("§15: budget exhaustion stops extra work and says so", async () => {
    const runner: SubtaskRunner = async (t) => result({ task_id: t.task_id });
    const p = plan([task({ task_id: "a" }), task({ task_id: "b" }), task({ task_id: "c" })], {
      budget: { ...DEFAULT_BUDGET, maxTasks: 2 },
    });
    const out = await runPlan(p, runner);
    expect(out.plan.tasks.filter((t) => TERMINAL_STATES.includes(t.status)).length).toBeLessThanOrEqual(3);
    expect(out.reconciliation.disclosures.join(" ")).toMatch(/batas|tugas/);
  });

  it("§16.17: contradictory agent results stay visible for reconciliation", () => {
    const p = plan([
      task({ task_id: "a", objective: "Cek status API", status: "SUCCEEDED", result_reference: "status:ok" }),
      task({ task_id: "b", objective: "Cek status API lain", status: "SUCCEEDED", result_reference: "status:gagal" }),
    ]);
    expect(findContradictions(p).length).toBeGreaterThan(0);
  });

  it("§12/§16.18/19: progress + final text counts come from records", async () => {
    const runner: SubtaskRunner = async (t) => result({ task_id: t.task_id });
    const lines: string[] = [];
    const out = await runPlan(plan([task({ task_id: "a" }), task({ task_id: "b" })]), runner, { progress: (l) => lines.push(l) });
    expect(lines.length).toBeGreaterThan(0);
    expect(out.finalText).toContain("2/2");
    const pl = progressLine(out.plan);
    expect(pl).toContain("**Completed:** 2 dari 2 tahap");
    expect(pl).toContain("**Blocked:** None");
  });

  it("plan state is persisted, and cancel keeps finished subtasks", async () => {
    const runner: SubtaskRunner = async (t) => result({ task_id: t.task_id });
    const out = await runPlan(plan([task({ task_id: "a" }), task({ task_id: "b", dependencies: ["a"] })]), runner);
    savePlan(out.plan);
    expect(getPlan(TEST_USER, out.plan.id)).toBeTruthy();
    expect(listPlans(TEST_USER).length).toBe(1);
    // Cancelling a finished plan is refused — there is nothing left to stop.
    expect(cancelPlan(TEST_USER, out.plan.id).ok).toBe(false);

    // An unfinished plan cancels, and a subtask that already produced a result
    // keeps it instead of being rewritten to CANCELLED.
    const live = plan([task({ task_id: "p", status: "SUCCEEDED", result_reference: "r:p" }), task({ task_id: "q" })], {
      id: "plan_live",
      status: "RUNNING",
    });
    savePlan(live);
    const cancelled = cancelPlan(TEST_USER, "plan_live");
    expect(cancelled.ok).toBe(true);
    expect(cancelled.plan!.tasks.find((t) => t.task_id === "p")?.status).toBe("SUCCEEDED");
    expect(cancelled.plan!.tasks.find((t) => t.task_id === "q")?.status).toBe("CANCELLED");
  });
});

describe("reconciliation", () => {
  it("§13: parent SUCCEEDED only when every required task succeeded", () => {
    const ok = reconcile(plan([task({ task_id: "a", status: "SUCCEEDED", result_reference: "r" })]));
    expect(ok.parentStatus).toBe("SUCCEEDED");
    expect(ok.requiredSucceeded).toBe(1);
    const partial = reconcile(
      plan([task({ task_id: "a", status: "SUCCEEDED", result_reference: "r" }), task({ task_id: "b", status: "RUNNING" })])
    );
    expect(partial.parentStatus).not.toBe("SUCCEEDED");
  });
});

describe("wiring: the orchestrator is reachable from the real turn pipeline", () => {
  const agentSrc = readFileSync(join(process.cwd(), "apps", "web", "src", "lib", "agent.ts"), "utf8");

  it("agent.ts only orchestrates Mia's own path (no recursive subtask delegation)", () => {
    expect(agentSrc).toMatch(/if\s*\(\s*!opts\.agent\s*&&\s*!skipDelegate\s*&&\s*askText\s*\)/);
  });

  it("orchestration failure falls back to Mia's own answer", () => {
    expect(agentSrc).toContain("orchestration_error");
  });
});
describe("plans whose subtasks are all optional (live drill 2026-10-16)", () => {
  it("all-optional plans still reach a terminal status", () => {
    const p = plan([task({ task_id: "t1", required: false, status: "SUCCEEDED", result_reference: "r1" }), task({ task_id: "t2", required: false, status: "SUCCEEDED", result_reference: "r2", dependencies: ["t1"] })]);
    expect(reconcile(p).parentStatus).toBe("SUCCEEDED");
  });
  it("an all-optional plan with a failed subtask is PARTIALLY_COMPLETED", () => {
    const p = plan([task({ task_id: "t1", required: false, status: "FAILED", error_summary: "x" })]);
    expect(reconcile(p).parentStatus).toBe("PARTIALLY_COMPLETED");
  });
  it("an all-optional plan still unfinished stays RUNNING", () => {
    expect(reconcile(plan([task({ task_id: "t1", required: false, status: "RUNNING" })])).parentStatus).toBe("RUNNING");
  });
});
