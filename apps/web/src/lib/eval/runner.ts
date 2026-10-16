import { EVAL_DATASET } from "./dataset";
import { CHECKERS } from "./checkers";
import {
  buildGradePrompt,
  combineGrades,
  modelGradeEnabled,
  MODEL_RUBRIC,
  parseGrade,
  type Grader,
  type ModelGrade,
} from "./modelGrade";
import { aggregateScore, computeMetrics, criticalFailures, DEFAULT_WEIGHTS, evaluateGates, validateDataset } from "./scoring";
import {
  DATASET_VERSION,
  HARNESS_VERSION,
  RUBRIC_VERSION,
  type CaseResult,
  type EvalCase,
  type EvalRunReport,
  type MetricKey,
} from "./types";

/**
 * The runner. Deterministic by default; the model layer is opt-in and can only
 * add rubric scores to cases that already passed their deterministic criteria.
 *
 * Isolation rules (spec §17): no real network calls, no production Discord or
 * Telegram sends, no writes outside `.data/eval` plus the throwaway user keys
 * the store APIs require.
 */

export interface RunOptions {
  /** Restrict to these case ids (or prefixes, e.g. "orc-"). */
  only?: string[];
  categories?: string[];
  /** Skip the model layer even when it is enabled. */
  deterministicOnly?: boolean;
  /** Injected grader (tests use a double; production uses the agent). */
  grader?: Grader;
  graderModel?: string;
  /** Second grader for the disagreement check. */
  grader2?: Grader;
  /** Produces the answer a rubric case grades. Runs the real agent (costs tokens),
   *  so it is injected rather than hidden — the model layer stays opt-in. */
  answerFor?: (c: EvalCase) => Promise<string>;
  runId?: string;
  revision?: string;
  now?: () => number;
}

function selectCases(opts: RunOptions): EvalCase[] {
  const only = opts.only?.length ? opts.only : null;
  return EVAL_DATASET.filter((c) => {
    if (only && !only.some((p) => c.case_id === p || c.case_id.startsWith(p))) return false;
    if (opts.categories?.length && !opts.categories.includes(c.category)) return false;
    return true;
  });
}

/** Exported for the framework's own tests: the single-case execution path
 *  the runner uses, so a test asserts the same code the suite runs. */
export async function runDeterministicCase(c: EvalCase, now: () => number = Date.now): Promise<CaseResult> {
  const started = now();
  const base: CaseResult = {
    case_id: c.case_id,
    name: c.name,
    category: c.category,
    target_agent: c.target_agent,
    metric: c.metric,
    method: c.evaluation_method,
    status: "fail",
    critical: c.critical,
    criteria: [],
  };
  const done = (extra: Partial<CaseResult>): CaseResult => ({ ...base, ...extra, latency_ms: now() - started });
  if (c.evaluation_method === "blocked") {
    return done({ status: "blocked", failure_reason: c.blocked_reason ?? "kasus diblokir" });
  }
  if (c.evaluation_method === "model_rubric") {
    return done({ status: "blocked", failure_reason: "menunggu model layer (EVAL_MODEL_GRADE=1)" });
  }
  const checker = c.checker ? CHECKERS[c.checker] : undefined;
  if (!checker) {
    return done({ status: "blocked", failure_reason: `checker tidak terdaftar: ${c.checker ?? "(kosong)"}` });
  }
  try {
    const criteria = await checker(c);
    // A checker that asserts nothing must never be scored as a pass.
    if (!criteria.length) {
      return done({ status: "blocked", failure_reason: "checker tidak mengembalikan kriteria" });
    }
    const failed = criteria.filter((x) => !x.ok);
    return done({
      criteria,
      status: failed.length ? "fail" : "pass",
      failure_reason: failed.length ? failed.map((f) => `${f.id}: ${f.detail ?? "gagal"}`).join("; ") : undefined,
    });
  } catch (e) {
    return done({ status: "fail", failure_reason: `checker melempar: ${e instanceof Error ? e.message : String(e)}` });
  }
}

/**
 * The model layer grades an ANSWER that somebody produced. It never produces
 * the answer itself unless the caller supplies `answerFor` (which runs the real
 * agent and therefore costs tokens). With no `answerFor`, model cases stay
 * BLOCKED — an ungraded rubric is not a pass.
 */
async function applyModelLayer(
  results: CaseResult[],
  cases: EvalCase[],
  opts: RunOptions,
  now: () => number
): Promise<{ results: CaseResult[]; calls: number }> {
  if (opts.deterministicOnly || !opts.grader || !opts.answerFor || !modelGradeEnabled()) {
    return { results, calls: 0 };
  }
  const model = opts.graderModel ?? "unknown";
  let calls = 0;
  for (const c of cases) {
    if (c.evaluation_method !== "model_rubric") continue;
    const idx = results.findIndex((r) => r.case_id === c.case_id);
    if (idx < 0) continue;
    const started = now();
    try {
      const answer = await opts.answerFor(c);
      const raw = await opts.grader(buildGradePrompt(c, answer));
      calls += 1;
      let grade = parseGrade(c.case_id, raw, model);
      if (!grade) {
        results[idx] = { ...results[idx], status: "blocked", failure_reason: "jawaban grader tidak bisa diparse" };
        continue;
      }
      if (opts.grader2) {
        calls += 1;
        const second = parseGrade(c.case_id, await opts.grader2(buildGradePrompt(c, answer)), model);
        if (second) grade = combineGrades(grade, second);
      }
      const criteria = MODEL_RUBRIC.map((r) => ({
        id: `rubric:${r.id}`,
        ok: (grade.scores[r.id] ?? 0) >= 1,
        detail: grade.note,
      }));
      // Disagreement between graders is NOT a pass: averaging 0 and 2 to 1 and
      // calling it green hid a case two graders could not agree on.
      const disputed = grade.disagreement.length > 0;
      const missing = grade.missing_criteria ?? [];
      results[idx] = {
        ...results[idx],
        status: disputed || missing.length ? "blocked" : criteria.every((x) => x.ok) ? "pass" : "fail",
        criteria: [...results[idx].criteria, ...criteria],
        model,
        rubric_scores: grade.scores,
        latency_ms: (results[idx].latency_ms ?? 0) + (now() - started),
        failure_reason: disputed
          ? `kriteria perlu ditinjau manual (grader berbeda): ${grade.disagreement.join(",")}`
          : missing.length
            ? `grader tidak menjawab: ${missing.join(",")}`
            : criteria.some((x) => !x.ok)
            ? criteria.filter((x) => !x.ok).map((x) => x.id).join(",")
            : undefined,
      };
    } catch (e) {
      results[idx] = { ...results[idx], status: "blocked", failure_reason: `grader gagal: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return { results, calls };
}

export async function runEval(opts: RunOptions = {}): Promise<EvalRunReport> {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const problems = validateDataset(EVAL_DATASET);
  const cases = selectCases(opts);
  const notes: string[] = [];
  if (problems.length) notes.push(`dataset bermasalah: ${problems.slice(0, 5).join(" | ")}`);

  const raw: CaseResult[] = [];
  for (const c of cases) raw.push(await runDeterministicCase(c, now));
  const { results, calls } = await applyModelLayer(raw, cases, opts, now);

  const totals = {
    selected: results.length,
    pass: results.filter((r) => r.status === "pass").length,
    fail: results.filter((r) => r.status === "fail").length,
    blocked: results.filter((r) => r.status === "blocked").length,
    not_applicable: results.filter((r) => r.status === "not_applicable").length,
  };
  const metrics = computeMetrics(results);
  const weights: Partial<Record<MetricKey, number>> = DEFAULT_WEIGHTS;
  const report: EvalRunReport = {
    run_id: opts.runId ?? `run_${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}`,
    dataset_version: DATASET_VERSION,
    rubric_version: RUBRIC_VERSION,
    harness_version: HARNESS_VERSION,
    revision: opts.revision ?? "unknown",
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date(now()).toISOString(),
    totals,
    metrics,
    aggregate: { score: aggregateScore(metrics, weights), weights },
    critical_failures: criticalFailures(results),
    gates: [],
    cases: results,
    model_calls: calls,
    notes,
  };
  report.gates = evaluateGates(report);
  return report;
}

/** Exit code contract: 0 = gates green, 1 = gate failed, 2 = nothing executed. */
export function exitCodeFor(report: EvalRunReport): number {
  if (report.totals.pass + report.totals.fail === 0) return 2;
  return report.gates.every((g) => g.ok) ? 0 : 1;
}

export type { ModelGrade };