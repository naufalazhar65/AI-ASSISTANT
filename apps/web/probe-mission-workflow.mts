/**
 * Probe: exercise the workflow + orchestration paths with REAL data and show
 * what the Mission Control board makes of them.
 *
 *   npx tsx apps/web/probe-mission-workflow.mts
 *
 * Why: the workflow and orchestration stores were empty for months, so the
 * board's rules for those rows were never exercised (a finished attempt shown
 * as "running", a duration that spans attempts, a cancel button for a plan
 * that is already done). This probe creates one real workflow, runs it once,
 * writes one plan through the same store the agent writes, and prints what the
 * board reports. It prints; it does not assert.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { savePlan } from "./src/lib/orchestrationStore";
import { sanitizeUser, userDataRoot } from "./src/lib/users";
import type { OrchestrationPlan } from "./src/lib/orchestration";

const ROOT = join(import.meta.dirname, "..", "..");
const MIA = process.env.MIA_WEB_BASE || "http://127.0.0.1:3000";
const DASH = process.env.OFFICE_DASH_URL || "http://127.0.0.1:3001";
const OWNER = process.env.PROBE_USER || "naufalazhar652952";
const PROBE_MARK = "[mission-probe]";

function storeDir(): string {
  return join(userDataRoot(), sanitizeUser(OWNER) ?? "shared");
}

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmp, file);
}

/**
 * Remove everything this probe wrote. The board reads the owner's real stores,
 * so a probe that leaves rows behind puts fake tasks in front of the owner.
 * `--cleanup` runs this alone (to clear an older run).
 */
function cleanup(): string[] {
  const dir = storeDir();
  const removed: string[] = [];

  const wfFile = join(dir, "workflows.json");
  const defs = readJson<Array<Record<string, unknown>>>(wfFile, []);
  const probeIds = new Set(
    defs.filter((w) => String(w.name || "").startsWith(PROBE_MARK)).map((w) => String(w.workflow_id || "")),
  );
  const keptDefs = defs.filter((w) => !String(w.name || "").startsWith(PROBE_MARK));
  if (keptDefs.length !== defs.length) {
    writeJson(wfFile, keptDefs);
    removed.push(`workflows:${defs.length - keptDefs.length}`);
  }

  const exFile = join(dir, "workflow-executions.json");
  const execs = readJson<Array<Record<string, unknown>>>(exFile, []);
  const keptExecs = execs.filter((e) => !probeIds.has(String(e.workflow_id || "")));
  if (keptExecs.length !== execs.length) {
    writeJson(exFile, keptExecs);
    removed.push(`executions:${execs.length - keptExecs.length}`);
  }

  const planFile = join(dir, "orchestration.json");
  const store = readJson<{ plans?: Array<Record<string, unknown>> }>(planFile, { plans: [] });
  const plans = Array.isArray(store.plans) ? store.plans : [];
  const keptPlans = plans.filter(
    (p) => !String(p.request || "").startsWith(PROBE_MARK) && !String(p.id || "").startsWith("plan-probe-"),
  );
  if (keptPlans.length !== plans.length) {
    writeJson(planFile, { ...store, plans: keptPlans });
    removed.push(`plans:${plans.length - keptPlans.length}`);
  }
  return removed;
}

function token(): string {
  for (const line of readFileSync(join(ROOT, "apps/web/.env.local"), "utf8").split("\n")) {
    const m = /^AUTH_TOKEN=(.*)$/.exec(line.trim());
    if (m) return m[1].replace(/^"|"$/g, "");
  }
  throw new Error("AUTH_TOKEN missing from apps/web/.env.local");
}

async function main(): Promise<void> {
  const auth = token();
  const post = async (url: string, body: unknown) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${auth}` },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json().catch(() => null)) as Record<string, unknown> | null };
  };

  // 1. A REAL workflow, through the same API the owner uses.
  const add = await post(`${MIA}/api/workflows`, {
    action: "add",
    user: OWNER,
    workflow: {
      name: "[mission-probe] cek fokus hari ini",
      description: "Dibuat oleh probe-mission-workflow untuk menguji jalur workflow di Mission Control.",
      task_configuration: "Jawab dalam satu kalimat: apa satu hal yang paling perlu diperiksa hari ini?",
      trigger_type: "once",
      schedule: { kind: "runonce", at: new Date(Date.now() + 3600_000).toISOString() },
      agent_id: "mia",
      acceptance_criteria: [{ description: "jawaban satu kalimat" }],
      concurrency_policy: "SKIP_IF_RUNNING",
      enabled: true,
      timezone: "Asia/Jakarta",
    },
  });
  console.log("workflow add:", add.status, JSON.stringify(add.json).slice(0, 240));
  const wfId = String((add.json?.workflow as { workflow_id?: string } | undefined)?.workflow_id || "");
  if (wfId) {
    const run = await post(`${MIA}/api/workflows`, { action: "run_now", user: OWNER, id: wfId });
    console.log("workflow run_now:", run.status, JSON.stringify(run.json).slice(0, 400));
  }

  // 2. A plan through the same store the agent writes (no public create route
  //    exists — the agent's orchestrate tool is the only writer).
  const now = Date.now();
  const day = 86_400_000;
  const plan: OrchestrationPlan = {
    id: `plan-probe-${now}`,
    user: OWNER,
    request: "[mission-probe] rencana uji jalur orkestrasi",
    created_at: new Date(now - 9 * day).toISOString(),
    status: "RUNNING",
    tasks: [
      {
        task_id: "t1",
        parent_task_id: null,
        agent_id: "mia",
        objective: "Riset satu sumber resmi",
        task_type: "research",
        input_context: "probe",
        expected_output: "catatan singkat",
        acceptance_criteria: ["ada catatan"],
        dependencies: [],
        priority: 1,
        required: true,
        status: "SUCCEEDED",
        created_at: new Date(now - 9 * day).toISOString(),
        started_at: new Date(now - 9 * day).toISOString(),
        completed_at: new Date(now - 8 * day).toISOString(),
        result_reference: null,
        evidence_references: [],
        error_summary: null,
        attempts: 2,
        idempotent: true,
      },
      {
        task_id: "t2",
        parent_task_id: null,
        agent_id: "agnes",
        objective: "Susun ringkasan",
        task_type: "code",
        input_context: "probe",
        expected_output: "ringkasan",
        acceptance_criteria: ["ada ringkasan"],
        dependencies: ["t1"],
        priority: 2,
        required: false,
        status: "RUNNING",
        created_at: new Date(now - 2 * 3600_000).toISOString(),
        started_at: new Date(now - 3600_000).toISOString(),
        completed_at: null,
        result_reference: null,
        evidence_references: [],
        error_summary: null,
        attempts: 1,
        idempotent: true,
      },
    ],
    budget: { maxDepth: 2, maxTasks: 4, maxConcurrent: 2, maxRetries: 1, taskTimeoutMs: 60_000, maxDurationMs: 600_000 },
    notes: ["probe"],
  };
  savePlan(plan);
  console.log("plan saved:", plan.id);

  // 3. What the BOARD makes of it.
  const r = await fetch(`${DASH}/api/mission?period=all&sort=smart&token=${encodeURIComponent(auth)}`, {
    headers: { accept: "application/json" },
  });
  const d = (await r.json()) as {
    tasks?: Array<Record<string, unknown>>;
    counters?: Record<string, number>;
    truncated?: boolean;
  };
  console.log("mission status:", r.status, "counters:", JSON.stringify(d.counters), "truncated:", d.truncated);
  const rows = (d.tasks || []).filter((t) => String(t.source || "").includes("workflow") || String(t.source || "").includes("orch"));
  console.log("workflow/orchestration rows:", rows.length);
  for (const row of rows) {
    console.log(
      JSON.stringify({
        id: row.task_id,
        source: row.source,
        status: row.status,
        label: row.status_label,
        duration: row.duration_ms,
        attempts: (row.executions as unknown[] | undefined)?.length,
        execs: row.executions,
        actions: row.actions,
      }),
    );
  }
}

if (process.argv.includes("--cleanup")) {
  console.log("cleanup:", cleanup().join(", ") || "nothing to clean");
  process.exit(0);
}

main()
  .catch((e) => {
    console.error("probe failed:", e);
    process.exitCode = 2;
  })
  .finally(() => {
    console.log("cleanup:", cleanup().join(", ") || "nothing to clean");
  });
