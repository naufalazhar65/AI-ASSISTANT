/**
 * Evaluation runner CLI.
 *
 *   npx tsx eval.ts deterministic   # full deterministic suite (no network, no model calls)
 *   npx tsx eval.ts regression     # same run, compared against the recorded baseline
 *   npx tsx eval.ts baseline       # record the current run as the new baseline
 *   npx tsx eval.ts list           # list case ids with area/agent/method
 *   npx tsx eval.ts agents         # model layer (needs EVAL_MODEL_GRADE=1, costs tokens)
 *
 * Flags: --only=<prefix,prefix>  --categories=<a,b>  --json
 *
 * Exit codes: 0 gates green · 1 a gate or the regression policy failed ·
 * 2 nothing was executed (never reported as success).
 *
 * Run from inside apps/web — tsx does not load .env.local by itself.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { buildBaseline, compareToBaseline, currentRevision, loadBaseline, saveBaseline } from "./src/lib/eval/baseline";
import { EVAL_DATASET } from "./src/lib/eval/dataset";
import { redactReport, redactSecrets, renderMarkdown, writeReport } from "./src/lib/eval/report";
import { exitCodeFor, runEval } from "./src/lib/eval/runner";

/** tsx does not read .env.local, and several cases assert on real operator
 *  configuration (WRITE_ANYWHERE). Load it before anything reads process.env. */
function loadLocalEnv(): void {
  const file = join(import.meta.dirname, ".env.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    if (process.env[key] !== undefined) continue;
    process.env[key] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadLocalEnv();

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith("--")) ?? "deterministic";
const flag = (name: string): string | undefined => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const has = (name: string): boolean => args.includes(`--${name}`);
const list = (v: string | undefined): string[] | undefined => v?.split(",").map((s) => s.trim()).filter(Boolean);

function selections() {
  return { only: list(flag("only")), categories: list(flag("categories")) };
}

/** Model layer: the real agent produces the answer, the same agent grades it. */
async function modelRun() {
  const { runAssistantTurn } = await import("./src/lib/agent");
  const ask = async (user: string, agent: "mia" | "agnes" | "michelle" | undefined, content: string) =>
    (await runAssistantTurn({ messages: [{ role: "user", content }], user, agent, channel: "text" })).text ?? "";
  const answerFor = (c: { target_agent: string; input_message: string }) =>
    ask("eval_model_user", c.target_agent as "mia" | "agnes" | "michelle", c.input_message);
  const grader = (prompt: string) => ask("eval_grader_user", undefined, prompt);
  return runEval({
    ...selections(),
    answerFor,
    grader,
    graderModel: process.env.EVAL_GRADER_MODEL ?? "configured-default",
  });
}

async function main(): Promise<number> {
  if (cmd === "list") {
    for (const c of EVAL_DATASET) {
      console.log(
        `${c.case_id.padEnd(46)} ${c.category.padEnd(18)} ${c.target_agent.padEnd(9)} ${c.evaluation_method}` +
          `${c.checker ? ` (${c.checker})` : ""}`
      );
    }
    console.log(`\n${EVAL_DATASET.length} kasus · ${EVAL_DATASET.filter((c) => c.evaluation_method === "deterministic").length} deterministik · ${EVAL_DATASET.filter((c) => c.evaluation_method === "model_rubric").length} model-layer`);
    return 0;
  }

  const report = cmd === "agents" ? await modelRun() : await runEval({ ...selections(), revision: currentRevision() });
  const baseline = loadBaseline();
  const comparison = cmd === "agents" ? undefined : baseline ? compareToBaseline(report, baseline) : undefined;
  const redacted = redactReport(report);
  const artifacts = writeReport(redacted, comparison);

  if (has("json")) console.log(JSON.stringify({ ...redacted, comparison }, null, 2));
  else console.log(redactSecrets(renderMarkdown(report, comparison)));
  for (const a of artifacts) {
    console.log(`${a.verified ? "OK" : "GAGAL"} artifact ${a.path} (${a.bytes} B)${a.problem ? ` — ${a.problem}` : ""}`);
  }

  const exit = exitCodeFor(report);

  // A run whose artifacts are missing or unreadable is not a green run: it
  // produced no record anyone can inspect (audit 2026-10-16).
  if (artifacts.some((a) => !a.verified)) {
    console.error("Artifact gagal ditulis — hasil run tidak dapat diaudit.");
    return 1;
  }

  if (cmd === "baseline") {
    // Recording a failing or empty run as the reference silently launders a
    // regression into "known good" (it happened live with --categories=bogus).
    if (exit !== 0) {
      console.error("Baseline TIDAK direkam: run ini belum hijau (exit " + exit + "). Perbaiki dulu, lalu ulangi.");
      return 1;
    }
    console.log(`Baseline terekam: ${saveBaseline(buildBaseline(report))}`);
    return 0;
  }

  // "No regression" is only meaningful against a real baseline. CI has none
  // (.data is gitignored), so a missing baseline must be visible, not a no-op.
  if (cmd === "regression" && !baseline) {
    const allow = /^(1|true|yes|on)$/i.test(process.env.EVAL_REGRESSION_ALLOW_MISSING_BASELINE ?? "");
    if (!allow) {
      console.error("Baseline tidak ada — regresi TIDAK bisa dinilai. Jalankan `npm run eval:baseline` lebih dulu.");
      return 1;
    }
    console.log("Baseline tidak ada (diizinkan lewat EVAL_REGRESSION_ALLOW_MISSING_BASELINE=1) — regresi tidak dinilai.");
  }
  const failOnRegression = /^(1|true|yes|on)$/i.test(process.env.EVAL_GATE_FAIL_ON_REGRESSION ?? "1");
  if (exit === 0 && comparison && failOnRegression && comparison.new_failures.length) {
    console.log(`\nREGRESI: ${comparison.new_failures.length} kasus hijau→gagal:\n- ${comparison.new_failures.join("\n- ")}`);
    return 1;
  }
  return exit;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`eval gagal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exit(1);
  }
);