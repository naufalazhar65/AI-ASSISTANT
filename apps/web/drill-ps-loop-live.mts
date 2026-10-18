// LIVE drill (production path, real provider via DEFAULT_AI_PROVIDER) — the
// recovery loop running against the REAL agent instead of a fake runner.
//
// Owner gap being closed (2026-10-18): every recovery proof so far used a fake
// SubtaskRunner. The real chain runAssistantTurn -> brief -> KRITERIA attest ->
// classifyFailure -> decideRecovery had never executed end-to-end.
//
// Design:
//   P0  pure: shouldOrchestrate + plan shape + session id per plan.
//   P1  HYBRID real: attempt 1 of the research task throws ETIMEDOUT (injected,
//       no LLM), attempt 2 goes to the REAL runSubtaskViaAgent. Proves the retry
//       decision fires on a real task and that a real model can attest criteria.
//   P2  no LLM: runner always throws -> hard stop, stop_reason recorded.
//   P3  ALL REAL: runPlan with the real runner, research + code objectives.
//       Code objective is idempotent:false, so any failure there must escalate
//       to BLOCKED instead of retrying (and autoDenyRisky denies its writes).
//
// tsx does NOT load .env.local — parse manually (repo gotcha).
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const envRaw = readFileSync(join(process.cwd(), "apps/web/.env.local"), "utf8");
for (const line of envRaw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const { shouldOrchestrate, planFromRequest } = await import("./src/lib/orchestrationPlanner");
const { runPlan } = await import("./src/lib/orchestrator");
const { runSubtaskViaAgent, buildTaskBrief } = await import("./src/lib/orchestratorAgents");
const { readSessions, computeLoopMetrics } = await import("./src/lib/recovery");
import type { OrchestrationTask } from "./src/lib/orchestration";

const USER = `verify_pslive_${Date.now().toString(36)}`; // run-unique: stores are append-only
const ASK =
  "riset best practice pagination REST API di internet, lalu perbaiki fungsi helper pagination yang masih salah di test terkait";

let fail = 0;
const ok = (cond: boolean, label: string, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fail++;
};
const head = (s: string, n = 220) => s.replace(/\s+/g, " ").slice(0, n);
const cleanup = () => {
  const dir = join(process.cwd(), "apps/web/.data/users", USER);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
};

const budget = {
  maxDepth: 2,
  maxTasks: 6,
  maxConcurrent: 1,
  maxRetries: 1,
  taskTimeoutMs: 180_000,
  maxDurationMs: 900_000,
};

try {
  // ── P0: pure plan shape ──
  console.log("── P0: plan shape ──");
  ok(shouldOrchestrate(ASK), "ask is orchestrable", ASK.slice(0, 60));
  const planA = planFromRequest(ASK, { user: USER, budget });
  const planB = planFromRequest(ASK, { user: USER, budget });
  ok(planA.tasks.length >= 2, "plan has >=2 tasks", `${planA.tasks.length} tasks`);
  ok(planA.id !== planB.id, "two plans of the same ask get different plan ids");
  for (const t of planA.tasks) {
    console.log(
      `   task ${t.task_id} agent=${t.agent_id} type=${t.task_type} required=${t.required} idempotent=${t.idempotent} criteria=${JSON.stringify(t.acceptance_criteria)}`,
    );
  }
  ok(
    planA.tasks.some((t: { idempotent: boolean }) => !t.idempotent),
    "plan contains a non-idempotent task (never retried by design)",
  );
  const researchTask = planA.tasks.find((t: { task_type: string }) => t.task_type === "research") ?? planA.tasks[0];
  console.log("   BRIEF (research):\n" + buildTaskBrief(researchTask).split("\n").map((l: string) => "     " + l).join("\n"));

  // ── P1: injected transient on attempt 1, REAL agent after ──
  console.log("── P1: hybrid real (fail once → real recovery) ──");
  const p1Plan = planFromRequest(ASK, { user: USER, budget });
  const realT0 = Date.now();
  let p1Calls = 0;
  let realTurns = 0;
  const p1 = await runPlan(p1Plan, async (task, plan) => {
    p1Calls++;
    if (p1Calls === 1) throw new Error("socket ETIMEDOUT (drill injected)");
    realTurns++;
    return runSubtaskViaAgent(task, plan);
  });
  const p1First = p1.plan.tasks[0];
  ok(p1Calls > p1.plan.tasks.length, "a failure forced an extra attempt", `calls=${p1Calls} tasks=${p1.plan.tasks.length}`);
  ok(realTurns >= 1, "the real agent really ran", `realTurns=${realTurns}`);
  const s1 = readSessions(USER).find((s: { id: string }) => s.id.endsWith(`${p1Plan.id}_${p1First.task_id}`));
  ok(!!s1, "recovery session persisted", s1?.id);
  ok(s1?.attempts?.[0]?.failure === "TRANSIENT", "attempt 1 classified TRANSIENT", String(s1?.attempts?.[0]?.failure));
  ok(!!s1?.attempts?.[0]?.recovery, "attempt 1 has a recorded recovery action", `${s1?.attempts?.[0]?.recovery} / ${head(String(s1?.attempts?.[0]?.recovery_reason ?? ""), 90)}`);
  console.log(`   session attempts: ${JSON.stringify((s1?.attempts ?? []).map((a: { n: number; failure?: string; recovery?: string; recovery_reason?: string }) => ({ n: a.n, failure: a.failure ?? null, recovery: a.recovery ?? null, why: head(String(a.recovery_reason ?? ""), 80) })))}`);

  // ── Real attestation reality check (the possible fatal gap) ──
  const attested = p1.plan.tasks.some((t: { criteria_outcome?: string }) => t.criteria_outcome === "COMPLETE");
  const outcomes = p1.plan.tasks.map((t: OrchestrationTask) => `${t.task_id}=${t.status}/${t.criteria_outcome ?? "none"}${t.error_summary ? ` (${head(t.error_summary, 60)})` : ""}`);
  console.log(`   task outcomes: ${outcomes.join(" | ")}`);
  console.log(`   REAL ATTESTATION CHECK: ${attested ? "criteria COMPLETE (model emitted KRITERIA lines)" : "no task reached COMPLETE — criteria never attested by the real model"}`);

  // ── P2: always-fail, no LLM (hard stop) ──
  console.log("── P2: always-fail hard stop (no LLM) ──");
  const p2Plan = planFromRequest(ASK, { user: USER, budget });
  let p2Calls = 0;
  const p2 = await runPlan(p2Plan, async () => {
    p2Calls++;
    throw new Error("socket ETIMEDOUT (drill injected, always)");
  });
  const s2 = readSessions(USER).find((s: { id: string }) => s.id.endsWith(`${p2Plan.id}_${p2Plan.tasks[0].task_id}`));
  ok(p2Calls === 2, "exactly 2 calls then stop (non-idempotent task is not retried)", `calls=${p2Calls}`);
  ok(s2?.status === "stopped", "session stopped with a reason", `${s2?.status} / ${head(String(s2?.stop_reason ?? ""), 90)}`);

  // ── P3: all real ──
  console.log("── P3: all-real run (no injection) ──");
  const p3Plan = planFromRequest(ASK, { user: USER, budget });
  const p3 = await runPlan(p3Plan, runSubtaskViaAgent);
  const p3Outcomes = p3.plan.tasks.map((t: OrchestrationTask) => `${t.task_id}=${t.status}/${t.criteria_outcome ?? "none"}${t.ps_recovery ? `/${t.ps_recovery}` : ""}${t.error_summary ? ` (${head(t.error_summary, 70)})` : ""}`);
  console.log(`   task outcomes: ${p3Outcomes.join(" | ")}`);
  console.log(`   plan status: ${p3.plan.status}`);
  console.log(`   final text: ${head(p3.finalText, 400)}`);

  // ── metrics ──
  const m = computeLoopMetrics(readSessions(USER));
  console.log(
    `   metrics: sessions=${m.sessions} attempts/task=${m.attemptsPerTask} recoveryRate=${String(m.recoverySuccessRate)} repeatedFailureRate=${String(m.repeatedFailureRate)} falseSuccess=${m.falseSuccessSessions} correctStopRate=${String(m.correctStopRate)}`,
  );
  ok(m.falseSuccessSessions === 0, "no false success", `${m.falseSuccessSessions}`);

  ok(p1.plan.status !== "DONE" || attested, "no plan claims DONE without attested criteria", p1.plan.status);
  console.log(`DRILL WALL CLOCK: ${Math.round((Date.now() - realT0) / 1000)}s`);
} catch (e) {
  console.log(`✗ drill crashed: ${(e as Error).message}`);
  fail++;
} finally {
  cleanup();
}

console.log(fail === 0 ? "\nDRILL PS-LOOP LIVE: ALL GREEN" : `\nDRILL PS-LOOP LIVE: ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
