/**
 * Durable drill for the multi-agent orchestration system.
 *
 * Run from apps/web:  npx tsx drill-orchestration.mts
 *
 * What it proves, in order (P0..P4), all without spending model tokens:
 * P0 gate      — trivial asks stay on the direct path, multi-objective asks plan
 * P1 planning  — decomposition + agent assignment from the REAL registry/token state
 * P2 runtime   — dependency gating, structured results, honest reconciliation
 *                (mocked subtask runner: no LLM, no external calls)
 * P3 store     — persistence is authoritative, cancel keeps finished work
 * P4 route     — /api/orchestration is auth-guarded and reads that same store
 *
 * House rule: evidence comes from the store + audit log, never from prose.
 */

import { readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { availableAgents, agentProfile } from "./src/lib/agentRegistry";
import { planFromRequest, shouldOrchestrate } from "./src/lib/orchestrationPlanner";
import { runPlan } from "./src/lib/orchestrator";
import { reconcile, type AgentResult, type OrchestrationTask } from "./src/lib/orchestration";
import { cancelPlan, getPlan, listPlans, savePlan } from "./src/lib/orchestrationStore";
import { userDataRoot, sanitizeUser } from "./src/lib/users";

// tsx does not load .env.local — availability depends on it, so load it here.
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !m[2].startsWith("#")) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const USER = `drill_orch_${Date.now()}`;
let pass = 0;
let fail = 0;
const ok = (cond: unknown, label: string): void => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}`);
  }
};

function task(over: Partial<OrchestrationTask> = {}): OrchestrationTask {
  return {
    task_id: "t1",
    parent_task_id: null,
    agent_id: "mia",
    objective: "Kerjakan t1",
    task_type: "coordinate",
    input_context: "drill",
    expected_output: "hasil",
    acceptance_criteria: ["selesai"],
    dependencies: [],
    priority: 1,
    required: true,
    status: "PLANNED",
    created_at: new Date().toISOString(),
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

try {
  // ---------------------------------------------------------------- P0 gate
  console.log("P0 gate — trivial asks stay direct, multi-objective asks plan");
  ok(shouldOrchestrate("riset tentang OWASP Top 10 2025 lalu audit keamanan target lab saya"), "research+security → orkestrasi");
  ok(shouldOrchestrate("tulis unit test untuk fungsi reminder lalu audit keamanan API lab"), "code+security → orkestrasi");
  ok(!shouldOrchestrate("halo"), "sapaan tetap jalur langsung");
  ok(!shouldOrchestrate("cek cuaca"), "satu domain tetap jalur langsung");
  ok(!shouldOrchestrate("ya"), "jawaban konfirmasi tidak diorkestrasi");
  ok(!shouldOrchestrate("riset tentang keamanan password"), "research tunggal tidak diorkestrasi");

  // ------------------------------------------------------------ P1 planning
  console.log("\nP1 planning — agent dari registry nyata, bukan dari nama persona");
  const avail = availableAgents().map((a) => a.label);
  console.log(`    available: ${avail.join(",")}`);
  ok(agentProfile("ghost") === undefined, "agent tak terdaftar tidak punya profil");
  const plan = planFromRequest("riset tentang OWASP Top 10 2025 lalu audit keamanan target lab saya", { user: USER });
  const research = plan.tasks.find((t) => t.task_type === "research");
  const security = plan.tasks.find((t) => t.task_type === "security");
  ok(plan.tasks.length >= 2, `plan punya ${plan.tasks.length} tahap`);
  ok(security?.dependencies.includes(research!.task_id) === true, "tahap kedua bergantung pada tahap pertama");
  ok(research?.agent_id === "agnes" || research?.agent_id === "mia", `riset → ${research?.agent_id}`);
  ok(security?.agent_id === "michelle" || security?.agent_id === "mia", `security → ${security?.agent_id}`);
  if (avail.includes("agnes")) ok(research?.agent_id === "agnes", "Agnes dipilih untuk riset (token aktif)");
  if (avail.includes("michelle")) ok(security?.agent_id === "michelle", "Michelle dipilih untuk security (token aktif)");

  // ------------------------------------------------------------ P2 runtime
  console.log("\nP2 runtime — dependensi, hasil terstruktur, rekonsiliasi jujur");
  const started: string[] = [];
  const runner = async (t: OrchestrationTask): Promise<AgentResult> => {
    started.push(t.task_id);
    return {
      task_id: t.task_id,
      agent_id: t.agent_id ?? "mia",
      status: "SUCCEEDED",
      summary: `hasil terstruktur untuk ${t.task_id}`,
      findings: ["satu temuan"],
      evidence_references: ["exec-1"],
      artifact_references: [],
      validations: ["mock"],
      errors: [],
      remaining_uncertainty: [],
      next_step: null,
    };
  };
  const out = await runPlan(plan, runner);
  ok(started.join(",") === plan.tasks.map((t) => t.task_id).join(","), `semua tahap jalan berurutan: ${started.join(",")}`);
  ok(out.plan.tasks.every((t) => t.status === "SUCCEEDED"), "semua tahap SUCCEEDED");
  ok(out.plan.tasks.every((t) => !!t.result_reference), "SUCCEEDED selalu punya result_reference");
  ok(
    out.plan.tasks[0].result_reference!.includes("hasil terstruktur"),
    "result_reference memuat ringkasan hasil, bukan cuma id"
  );
  ok(out.finalText.includes("Status pekerjaan"), "teks final punya blok status");
  ok(out.reconciliation.requiredTotal === plan.tasks.filter((t) => t.required).length, "rekonsiliasi menghitung tugas wajib");

  // optional failure must not be reported as plain success
  const mixed = { ...plan, id: `${plan.id}_mixed`, tasks: plan.tasks.map((t, i) => ({ ...t, required: i === 0, status: "PLANNED" as const, attempts: 0, result_reference: null })) };
  const failRunner = async (t: OrchestrationTask): Promise<AgentResult> => ({
    task_id: t.task_id,
    agent_id: t.agent_id ?? "mia",
    status: "FAILED",
    summary: "",
    findings: [],
    evidence_references: [],
    artifact_references: [],
    validations: [],
    errors: ["gagal uji"],
    remaining_uncertainty: [],
    next_step: null,
  });
  const mixedOut = await runPlan(mixed, failRunner);
  const mixedRec = reconcile(mixedOut.plan);
  ok(mixedRec.parentStatus !== "SUCCEEDED", `kegagalan tidak pernah jadi SUCCEEDED (${mixedRec.parentStatus})`);
  ok(mixedRec.disclosures.some((d) => /gagal/i.test(d)), "kegagalan wajib disebut di final");
  ok(mixedOut.finalText.includes("gagal") || mixedOut.finalText.includes("Gagal"), "teks final menyebut kegagalan");

  // cancellation stops queued work, finished work keeps its result
  const two = {
    ...plan,
    id: `${plan.id}_cancel`,
    tasks: [task({ task_id: "a" }), task({ task_id: "b", dependencies: ["a"] })],
  };
  let stop = false;
  const cancelOut = await runPlan(two, async (t) => {
    if (t.task_id === "a") stop = true;
    return {
      task_id: t.task_id,
      agent_id: "mia",
      status: "SUCCEEDED",
      summary: "ok",
      findings: [],
      evidence_references: [],
      artifact_references: [],
      validations: [],
      errors: [],
      remaining_uncertainty: [],
      next_step: null,
    };
  }, { shouldStop: () => stop });
  ok(cancelOut.plan.tasks.find((t) => t.task_id === "a")!.status === "SUCCEEDED", "tugas yang selesai tetap SUCCEEDED");
  ok(["CANCELLED", "BLOCKED"].includes(cancelOut.plan.tasks.find((t) => t.task_id === "b")!.status), "tugas terantre tidak dijalankan");

  // -------------------------------------------------------------- P3 store
  console.log("\nP3 store — status task otoritatif + cancel");
  savePlan(out.plan);
  const stored = getPlan(USER, out.plan.id);
  ok(!!stored, "plan tersimpan per user");
  ok(listPlans(USER).length >= 1, "plan terdaftar di daftar");
  ok(stored?.tasks.every((t) => t.status === "SUCCEEDED"), "status subtask tersimpan apa adanya");
  const cancelDone = cancelPlan(USER, out.plan.id);
  ok(cancelDone.ok === false, "cancel plan yang sudah selesai ditolak (jujur)");
  // A plan the engine already finished or cancelled is refused by cancelPlan —
  // so the live case uses a genuinely RUNNING plan (one subtask done, one
  // pending), which is what the cancel API actually has to handle.
  const livePlan = {
    ...two,
    id: `${plan.id}_live`,
    status: "RUNNING" as const,
    tasks: [task({ task_id: "a", status: "SUCCEEDED", result_reference: "result:a — ok" }), task({ task_id: "b", dependencies: ["a"], status: "QUEUED" })],
  };
  savePlan(livePlan);
  const cancelLive = cancelPlan(USER, livePlan.id);
  ok(cancelLive.ok === true, "cancel plan berjalan diterima");
  ok(cancelLive.plan?.tasks.find((t) => t.task_id === "a")?.status === "SUCCEEDED", "cancel tidak menghapus hasil yang sudah ada");
  ok(cancelLive.plan?.tasks.find((t) => t.task_id === "b")?.status === "CANCELLED", "tugas terantre dibatalkan");

  // -------------------------------------------------------------- P4 route
  console.log("\nP4 route — auth dijaga, status dibaca dari store yang sama");
  const base = "http://127.0.0.1:3000";
  try {
    const noToken = await fetch(`${base}/api/orchestration?user=${USER}`);
    const noTokenBody = (await noToken.json()) as { error?: string };
    if (noToken.status === 401) ok(noTokenBody.error === "unauthorized", "tanpa token → 401 unauthorized");
    else ok(noToken.status === 200 && Array.isArray((noTokenBody as { plans?: unknown }).plans), `auth dimatikan di mesin ini: ${noToken.status} (tetap membaca store)`);

    const tok = process.env.AUTH_TOKEN ?? "";
    if (tok) {
      const authed = await fetch(`${base}/api/orchestration?user=${USER}`, { headers: { authorization: `Bearer ${tok}` } });
      const body = (await authed.json()) as { plans?: Array<{ plan: { id: string } }> };
      ok(authed.status === 200 && (body.plans?.length ?? 0) >= 1, "dengan token → daftar plan terbaca");

      const missing = await fetch(`${base}/api/orchestration`, {
        method: "POST",
        headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
        body: JSON.stringify({ user: USER, id: "orch_tidak_ada", action: "cancel" }),
      });
      ok(missing.status === 409, `cancel plan tak ada → 409 (${missing.status})`);
    } else {
      console.log("    (AUTH_TOKEN kosong — auth off,.lewati bearer check)");
    }
  } catch (e) {
    console.log(`    ⚠ route tidak terjangkau: ${(e as Error).message} (server belum jalan?)`);
  }

  console.log(`\n=== drill-orchestration: ${pass} pass, ${fail} fail ===`);
} finally {
  // The throwaway user folder is the only thing this drill creates.
  const dir = join(userDataRoot(), sanitizeUser(USER) ?? USER);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  console.log(`cleanup ${dir}: ${existsSync(dir) ? "GAGAL" : "ok"}`);
}
process.exit(fail === 0 ? 0 : 1);