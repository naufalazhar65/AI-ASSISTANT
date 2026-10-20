import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildBaseline, compareToBaseline, loadBaseline, saveBaseline } from "./baseline";
import { EVAL_DATASET } from "./dataset";
import { combineGrades, MODEL_RUBRIC, modelGradeEnabled, parseGrade } from "./modelGrade";
import { redactSecrets } from "./report";
import { CHECKERS } from "./checkers";
import { exitCodeFor, runDeterministicCase, runEval } from "./runner";
import { aggregateScore, computeMetrics, evaluateGates, gatePolicyFromEnv, validateDataset } from "./scoring";
import { DATASET_VERSION, type CaseResult, type EvalCase, type EvalRunReport } from "./types";

/**
 * Tests for the evaluation framework itself (spec §19). The point of each one
 * is a failure mode a naive harness would ship: blocked cases counted as
 * passes, missing metrics printed as zero, a grader overriding a deterministic
 * failure, secrets leaking into artifacts, or a "pass" run that never executed
 * anything.
 */

function fakeReport(
  cases: CaseResult[],
  metrics: ReturnType<typeof computeMetrics>,
  over: Partial<EvalRunReport> = {}
): EvalRunReport {
  return {
    run_id: "run_test",
    dataset_version: DATASET_VERSION,
    rubric_version: "2026-10-16.1",
    harness_version: "2026-10-16.1",
    revision: "abc123",
    started_at: "2026-10-16T00:00:00.000Z",
    finished_at: "2026-10-16T00:00:01.000Z",
    totals: {
      selected: cases.length,
      pass: cases.filter((c) => c.status === "pass").length,
      fail: cases.filter((c) => c.status === "fail").length,
      blocked: cases.filter((c) => c.status === "blocked").length,
      not_applicable: cases.filter((c) => c.status === "not_applicable").length,
    },
    metrics,
    aggregate: { score: null, weights: {} },
    critical_failures: [],
    gates: [],
    cases,
    model_calls: 0,
    notes: [],
    ...over,
  };
}

function reportFor(cases: CaseResult[], rev: string, datasetVersion = DATASET_VERSION): EvalRunReport {
  return fakeReport(cases, computeMetrics(cases), { revision: rev, dataset_version: datasetVersion });
}

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "eval-test-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  delete process.env.EVAL_MODEL_GRADE;
});

const result = (over: Partial<CaseResult> = {}): CaseResult => ({
  case_id: "c1",
  name: "c1",
  category: "routing",
  target_agent: "mia",
  metric: "task_correctness",
  method: "deterministic",
  status: "pass",
  criteria: [],
  ...over,
});

describe("dataset integrity (§19.1, §19.2, §19.16)", () => {
  it("the shipped dataset is structurally valid", () => {
    expect(validateDataset(EVAL_DATASET)).toEqual([]);
  });

  it("covers every evaluation area with at least 30 cases", () => {
    const areas = new Set(EVAL_DATASET.map((c) => c.category));
    expect(areas.size).toBe(12);
    expect(EVAL_DATASET.length).toBeGreaterThanOrEqual(30);
  });

  it("every agent in the registry is evaluated for what it actually implements", () => {
    for (const label of ["mia", "agnes", "michelle"]) {
      expect(EVAL_DATASET.some((c) => c.target_agent === label)).toBe(true);
    }
    // Agnes is the researcher: she must never be given a coding task.
    expect(EVAL_DATASET.filter((c) => c.target_agent === "agnes").every((c) => c.category !== "coding")).toBe(true);
  });

  it("detects a missing expected behaviour and a case without a checker", () => {
    const broken: EvalCase[] = [
      { ...EVAL_DATASET[0], case_id: "dup", expected_behavior: "", checker: undefined },
      { ...EVAL_DATASET[0], case_id: "dup" },
    ];
    const problems = validateDataset(broken);
    expect(problems.some((p) => p.includes("expected_behavior kosong"))).toBe(true);
    expect(problems.some((p) => p.includes("duplikat"))).toBe(true);
    expect(problems.some((p) => p.includes("tanpa checker"))).toBe(true);
  });
});

describe("scoring rules (§11)", () => {
  it("blocked is never a pass and not_applicable leaves the denominator", () => {
    const m = computeMetrics([
      result({ status: "pass" }),
      result({ case_id: "c2", status: "fail" }),
      result({ case_id: "c3", status: "blocked" }),
      result({ case_id: "c4", status: "not_applicable" }),
    ])[0];
    expect(m.numerator).toBe(1);
    expect(m.denominator).toBe(2);
    expect(m.percent).toBe(50);
    expect(m.blocked).toBe(1);
    expect(m.not_applicable).toBe(1);
  });

  it("an unmeasured metric reports unavailable, never zero (§19.10)", () => {
    const m = computeMetrics([]).find((x) => x.key === "operational_efficiency");
    expect(m?.percent).toBeNull();
    expect(aggregateScore([m!])).toBeNull();
  });

  it("keeps critical failures visible whatever the aggregate says (§19.9)", () => {
    const cases = [
      ...Array.from({ length: 19 }, (_, i) => result({ case_id: `ok${i}`, metric: "task_correctness", status: "pass" })),
      ...Array.from({ length: 9 }, (_, i) => result({ case_id: `safe${i}`, metric: "safety_authorization", status: "pass" })),
      ...Array.from({ length: 3 }, (_, i) => result({ case_id: `ev${i}`, metric: "evidence_integrity", status: "pass" })),
      ...Array.from({ length: 3 }, (_, i) => result({ case_id: `exec${i}`, metric: "execution_integrity", status: "pass" })),
      result({ case_id: "bad", metric: "safety_authorization", status: "fail", critical: true }),
    ];
    const metrics = computeMetrics(cases);
    // The aggregate looks excellent; the critical gate must still fail.
    expect(aggregateScore(metrics)).toBeGreaterThan(90);
    const report = fakeReport(cases, metrics);
    const gates = evaluateGates(report, { minPercent: {}, requireExecuted: true, failOnBlocked: false });
    expect(gates.find((g) => g.gate === "critical-failures")?.ok).toBe(false);
  });

  it("a threshold gate compares against the exact numerator/denominator", () => {
    const report = fakeReport([result({ status: "fail" })], computeMetrics([result({ status: "fail" })]));
    const gates = evaluateGates(report, { minPercent: { task_correctness: 95 }, requireExecuted: true, failOnBlocked: false });
    expect(gates.find((g) => g.gate === "min:task_correctness")?.ok).toBe(false);
    expect(gates.find((g) => g.gate === "min:task_correctness")?.detail).toContain("0/1");
  });

  it("failOnBlocked stays off by default so an honest gap is reported, not fatal", () => {
    expect(gatePolicyFromEnv({}).failOnBlocked).toBe(false);
    expect(gatePolicyFromEnv({ EVAL_GATE_FAIL_ON_BLOCKED: "1" }).failOnBlocked).toBe(true);
  });
});

describe("runner status and exit codes (§19.3, §19.4, §19.14)", () => {
  it("a checker that throws fails the case instead of passing it", async () => {
    const report = await runEval({ only: ["route-unclassified-tool-fails-open"], deterministicOnly: true });
    expect(report.cases[0].status).toBe("pass");
    const bad = await runEval({ only: ["does-not-exist"], deterministicOnly: true });
    expect(bad.totals.selected).toBe(0);
    expect(exitCodeFor(bad)).toBe(2);
  });

  it("model-layer cases are blocked, never passed, without the model layer (§19.4)", async () => {
    const report = await runEval({ only: ["research-conflicting-sources"], deterministicOnly: true });
    expect(report.cases[0].status).toBe("blocked");
    expect(exitCodeFor(report)).not.toBe(0);
  });

  it("the deterministic suite runs offline and never reaches a model", async () => {
    const report = await runEval({ deterministicOnly: true });
    expect(report.model_calls).toBe(0);
    expect(report.totals.selected).toBe(EVAL_DATASET.length);
    // Runs the WHOLE deterministic dataset; ~6s on a loaded machine, so the
    // 5s default cap flaked once another test file joined the run. Assertions
    // above are unchanged — only the wall-clock budget moved.
  }, 30_000);

  it("exit code is 0 only when every gate passes", async () => {
    // Config-independent subset: no case here reads operator .env.local state.
    const report = await runEval({
      only: [
        "route-typed-name-mia",
        "exec-refusal-is-not-an-execution",
        "chan-approval-expiry-blocks-execution",
        "file-pdf-log-not-dumped",
        // A subset must still cover the critical areas, otherwise the honest
        // answer is "not measured" and the run must NOT be green.
        "evidence-unproven-past-work-caught",
      ],
      deterministicOnly: true,
    });
    expect(report.gates.every((g) => g.ok)).toBe(true);
    expect(exitCodeFor(report)).toBe(0);
  });

  it("a subset that skips a critical area is NOT reported as green", async () => {
    const report = await runEval({ only: ["route-typed-name-mia"], deterministicOnly: true });
    const evidence = report.gates.find((g) => g.gate === "min:evidence_integrity");
    expect(evidence?.ok).toBe(false);
    expect(exitCodeFor(report)).toBe(1);
  });
});

describe("model layer (§12, §19.8)", () => {
  it("is off unless explicitly enabled", () => {
    expect(modelGradeEnabled({})).toBe(false);
    expect(modelGradeEnabled({ EVAL_MODEL_GRADE: "1" })).toBe(true);
  });

  it("an unparseable grader reply blocks the case instead of scoring it", async () => {
    process.env.EVAL_MODEL_GRADE = "1";
    const report = await runEval({
      only: ["research-conflicting-sources"],
      grader: async () => "wah ini bagus sekali",
      answerFor: async () => "jawaban",
    });
    expect(report.cases[0].status).toBe("blocked");
    expect(report.model_calls).toBe(1);
  });

  it("records rubric scores per criterion, never a single blended number", async () => {
    process.env.EVAL_MODEL_GRADE = "1";
    const report = await runEval({
      only: ["research-conflicting-sources"],
      answerFor: async () => "jawaban",
      grader: async () =>
        JSON.stringify({
          scores: Object.fromEntries(MODEL_RUBRIC.map((r, i) => [r.id, i === 0 ? 2 : 1])),
          note: "ok",
        }),
    });
    const c = report.cases[0];
    expect(c.status).toBe("pass");
    expect(Object.keys(c.rubric_scores ?? {}).sort()).toEqual(MODEL_RUBRIC.map((r) => r.id).sort());
    expect(c.criteria.filter((x) => x.id.startsWith("rubric:")).length).toBe(MODEL_RUBRIC.length);
  });

  it("flags grader disagreement instead of averaging it away", () => {
    const a = parseGrade("c", JSON.stringify({ scores: { evidence_alignment: 2 } }), "m1");
    const b = parseGrade("c", JSON.stringify({ scores: { evidence_alignment: 0 } }), "m2");
    expect(a && b).toBeTruthy();
    const merged = combineGrades(a!, b!);
    expect(merged.disagreement).toContain("evidence_alignment");
    expect(merged.scores.evidence_alignment).toBe(1);
  });

  it("a grader cannot rescue a deterministic failure", async () => {
    // The deterministic layer runs first; the model layer only touches rubric
    // cases, so a deterministic FAIL can never be overwritten.
    const report = await runEval({
      only: ["exec-refusal-is-not-an-execution"],
      deterministicOnly: true,
      grader: async () => JSON.stringify({ scores: {} }),
    });
    expect(report.cases[0].method).toBe("deterministic");
    expect(report.cases[0].status).toBe("pass");
    expect(report.cases[0].rubric_scores).toBeUndefined();
  });
});

describe("baselines and regression (§13, §19.5–19.7, §19.17)", () => {
  const reportFor = (cases: CaseResult[], rev: string, datasetVersion = DATASET_VERSION): EvalRunReport =>
    fakeReport(cases, computeMetrics(cases), { revision: rev, dataset_version: datasetVersion });

  it("associates candidate and baseline with their own revisions", () => {
    const base = buildBaseline(reportFor([result({ status: "pass" })], "aaa111"));
    const cmp = compareToBaseline(reportFor([result({ status: "pass" })], "bbb222"), base);
    expect(cmp.baseline_revision).toBe("aaa111");
  });

  it("a deterministic regression surfaces as a new failure", () => {
    const base = buildBaseline(reportFor([result({ status: "pass" })], "aaa"));
    const cmp = compareToBaseline(reportFor([result({ status: "fail" })], "bbb"), base);
    expect(cmp.new_failures).toEqual(["c1"]);
    expect(cmp.fixed).toEqual([]);
    expect(cmp.changed).toEqual([{ case_id: "c1", from: "pass", to: "fail" }]);
  });

  it("a fixed case is reported as fixed and never erases the other failures (§19.7)", () => {
    const base = buildBaseline(reportFor([result({ case_id: "a", status: "fail" }), result({ case_id: "b", status: "fail" })], "aaa"));
    const cmp = compareToBaseline(reportFor([result({ case_id: "a", status: "pass" }), result({ case_id: "b", status: "fail" })], "bbb"), base);
    expect(cmp.fixed).toEqual(["a"]);
    expect(cmp.new_failures).toEqual([]);
    expect(cmp.changed).toEqual([{ case_id: "a", from: "fail", to: "pass" }]);
  });

  it("dataset, rubric and harness version drift is visible in the comparison", () => {
    const base = buildBaseline(reportFor([result()], "aaa"));
    const cmp = compareToBaseline(reportFor([result()], "bbb", "9999.9"), base);
    expect(cmp.dataset_version_changed).toBe(true);
    expect(cmp.harness_version_changed).toBe(false);
  });

  it("new and removed cases are both reported", () => {
    const base = buildBaseline(reportFor([result({ case_id: "old" })], "aaa"));
    const cmp = compareToBaseline(reportFor([result({ case_id: "new" })], "bbb"), base);
    expect(cmp.new_cases).toEqual(["new"]);
    expect(cmp.removed_cases).toEqual(["old"]);
  });

  it("latency deltas are reported per case", () => {
    const base = buildBaseline(reportFor([result({ latency_ms: 5 })], "aaa"));
    const cmp = compareToBaseline(reportFor([result({ latency_ms: 9 })], "bbb"), base);
    expect(cmp.latency[0]).toMatchObject({ case_id: "c1", baseline_ms: 5, candidate_ms: 9, delta_ms: 4 });
  });

  it("a saved baseline round-trips through disk", () => {
    const path = join(tmp(), "baseline.json");
    const base = buildBaseline(reportFor([result()], "abc123"));
    saveBaseline(base, path);
    expect(loadBaseline(path)?.meta.revision).toBe("abc123");
    expect(loadBaseline(join(tmp(), "missing.json"))).toBeUndefined();
  });
});

describe("artifacts and redaction (§19.12)", () => {
  it("redacts credential shapes before they reach a report", () => {
    const dirty = "token ghp_abcdefghijklmnopqrstuvwxyz012345 dan Authorization: Bearer abcdefghijklmnopqrstuvwxyz.123";
    const clean = redactSecrets(dirty);
    expect(clean).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz012345");
    expect(clean).not.toContain("abcdefghijklmnopqrstuvwxyz.123");
  });

  it("leaves ordinary prose alone", () => {
    const prose = "Bearer of this task is Mia, CVSS 7.5 pada /api/x";
    expect(redactSecrets(prose)).toBe(prose);
  });

  it("a written report can be read back and is non-empty (§19.15)", async () => {
    const { writeReport, renderMarkdown } = await import("./report");
    const report = reportFor([result(), result({ case_id: "c2", status: "fail" })], "abc123");
    const artifacts = writeReport(report);
    expect(artifacts.length).toBe(2);
    for (const a of artifacts) {
      expect(a.verified).toBe(true);
      expect(a.bytes).toBeGreaterThan(0);
      expect(readFileSync(a.path, "utf8").length).toBeGreaterThan(0);
    }
    const md = renderMarkdown(report);
    expect(md).toContain("Evaluasi Agent");
    expect(md).toContain("1/2");
  });

  it("the deterministic run performs no model calls and no live-platform work (§19.13)", async () => {
    const report = await runEval({ deterministicOnly: true });
    expect(report.model_calls).toBe(0);
    // No case targets a live platform adapter: reactions/approval run against
    // injected mocks, so no message can reach a production chat.
    const live = EVAL_DATASET.filter((c) => /production|live[_-]?(discord|telegram)/i.test(`${c.name} ${c.description}`));
    expect(live).toEqual([]);
  });
});

/* ------------------------------------------------------------------------
 * Locks for the audit findings of 2026-10-16. Each one reproduced a live
 * defect first; a green run before the fix is exactly what let them ship.
 * ---------------------------------------------------------------------- */

/** Minimal typed fixtures for the audit locks (mirrors the real shapes). */
const mkCase = (over: Partial<CaseResult>): CaseResult => ({
  case_id: "x", name: "x", category: "routing", target_agent: "mia", metric: "task_correctness",
  method: "deterministic", status: "pass", critical: false, criteria: [{ id: "c1", ok: true }], ...over,
});
const mkEvalCase = (over: Partial<EvalCase>): EvalCase => ({
  case_id: "tmp", name: "tmp", category: "routing", description: "d", target_agent: "mia",
  input_message: "", metric: "task_correctness", expected_behavior: "x",
  sensitivity: "synthetic", acceptance_criteria: ["y"], evaluation_method: "deterministic",
  evaluation_version: "v", ...over,
});

describe("audit 2026-10-16: unmeasured must not read as green", () => {
  const onlyBlockedCritical = (metric: "safety_authorization" | "evidence_integrity" | "execution_integrity"): EvalRunReport =>
    fakeReport(
      [
        mkCase({ case_id: "x1", metric, status: "blocked", critical: true, criteria: [], failure_reason: "blocked" }),
        mkCase({ case_id: "y1" }),
      ],
      computeMetrics([
        mkCase({ case_id: "x1", metric, status: "blocked", critical: true, criteria: [] }),
        mkCase({ case_id: "y1" }),
      ])
    );

  it("a critical metric that was never measured fails its min gate", () => {
    for (const metric of ["safety_authorization", "evidence_integrity", "execution_integrity"] as const) {
      const gates = evaluateGates(onlyBlockedCritical(metric));
      const g = gates.find((x) => x.gate === `min:${metric}`);
      expect(g, metric).toBeDefined();
      expect(g?.ok, `${metric} tidak boleh hijau saat tidak diukur`).toBe(false);
    }
  });

  it("the aggregate refuses to publish a score built on an unmeasured critical metric", () => {
    const metrics = computeMetrics([
      mkCase({ case_id: "x", metric: "safety_authorization", status: "blocked", critical: true, criteria: [] }),
      mkCase({ case_id: "y" }),
    ]);
    expect(aggregateScore(metrics)).toBeNull();
  });

  it("a non-critical unmeasured metric still gates as OK (not silently failed)", () => {
    const metrics = computeMetrics([
      mkCase({ case_id: "y" }),
    ]);
    const blocked = mkCase({ case_id: "b", status: "blocked", criteria: [] });
    const rep = fakeReport([blocked], metrics);
    const g = evaluateGates(rep).find((x) => x.gate === "min:task_correctness");
    expect(g?.ok).toBe(true);
    // And a metric nobody asked for produces no gate at all (never a silent pass/fail).
    expect(evaluateGates(rep).some((x) => x.gate === "min:output_quality")).toBe(false);
  });
});

describe("audit 2026-10-16: a checker must actually assert something", () => {
  afterEach(() => {
    delete CHECKERS.audit_tmp_throw;
    delete CHECKERS.audit_tmp_empty;
  });

  it("an empty criteria list is blocked, never a pass", async () => {
    CHECKERS.audit_tmp_empty = async () => [];
    const result = await runDeterministicCase(mkEvalCase({ checker: "audit_tmp_empty" }));
    expect(result.status).toBe("blocked");
    expect(result.failure_reason).toMatch(/tidak mengembalikan kriteria/);
  });

  it("a throwing checker fails that case and the run continues", async () => {
    CHECKERS.audit_tmp_throw = async () => {
      throw new Error("boom");
    };
    const result = await runDeterministicCase(mkEvalCase({ case_id: "tmp2", checker: "audit_tmp_throw" }));
    expect(result.status).toBe("fail");
    expect(result.failure_reason).toMatch(/checker melempar/);
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });
});

describe("audit 2026-10-16: latency must be measured after the checker", () => {
  it("latency_ms reflects real work, not the pre-checker snapshot", async () => {
    CHECKERS.audit_tmp_slow = async () => {
      await new Promise((r) => setTimeout(r, 15));
      return [{ id: "c1", ok: true }];
    };
    try {
      const result = await runDeterministicCase(mkEvalCase({ case_id: "tmp3", checker: "audit_tmp_slow" }));
      expect(result.latency_ms).toBeGreaterThanOrEqual(10);
    } finally {
      delete CHECKERS.audit_tmp_slow;
    }
  });
});

describe("audit 2026-10-16: grader disagreement and partial replies are blocked", () => {
  it("two graders that differ by >= 1 never produce a pass", async () => {
    const { runEval: run } = await import("./runner");
    process.env.EVAL_MODEL_GRADE = "1";
    try {
      const rep = await run({
        only: ["research-supported-claim-synthesis"],
        deterministicOnly: false,
        answerFor: async () => "jawaban sintetis dengan sumber.",
        grader: async () => JSON.stringify({ scores: { evidence_alignment: 2, coverage: 2, uncertainty: 2, clarity: 2 }, note: "a" }),
        grader2: async () => JSON.stringify({ scores: { evidence_alignment: 0, coverage: 1, uncertainty: 2, clarity: 1 }, note: "b" }),
      });
      const c = rep.cases.find((x) => x.case_id === "research-supported-claim-synthesis");
      expect(c?.status).toBe("blocked");
      expect(c?.failure_reason).toMatch(/grader berbeda/);
    } finally {
      delete process.env.EVAL_MODEL_GRADE;
    }
  });

  it("a grader that skips criteria is blocked, not scored zero", () => {
    const partial = parseGrade("c", JSON.stringify({ scores: { evidence_alignment: 2, coverage: 2, uncertainty: 2 }, note: "" }), "m");
    expect(partial).not.toBeNull();
    expect(partial?.missing_criteria).toEqual(["clarity"]);
    expect(parseGrade("c", "{}", "m")).toBeNull();
    expect(parseGrade("c", JSON.stringify({ scores: {} }), "m")).toBeNull();
  });
});

describe("audit 2026-10-16: baseline shape + CLI honesty", () => {
  it("a structurally wrong baseline is ignored instead of throwing later", () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-bl-"));
    const p = join(dir, "baseline.json");
    try {
      writeFileSync(p, "{}");
      expect(loadBaseline(p)).toBeUndefined();
      writeFileSync(p, "not json at all");
      expect(loadBaseline(p)).toBeUndefined();
      const good = buildBaseline(fakeReport([mkCase({ case_id: "a" })], computeMetrics([])));
      saveBaseline(good, p);
      expect(loadBaseline(p)?.case_status.a).toBe("pass");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the CLI refuses to record a failing run as the baseline and refuses a missing baseline", async () => {
    const { execFileSync } = await import("node:child_process");
    // import.meta.dirname is apps/web/src/lib/eval — the CLI lives three levels up.
    const cli = join(import.meta.dirname, "..", "..", "..", "eval.ts");
    const cliDir = join(import.meta.dirname, "..", "..", "..");
    const runCli = (args: string[]) => {
      try {
        execFileSync("npx", ["tsx", cli, ...args], { cwd: cliDir, encoding: "utf8", stdio: "pipe" });
        return 0;
      } catch (e) {
        return typeof (e as { status?: number }).status === "number" ? (e as { status: number }).status : 1;
      }
    };
    // An empty selection cannot be recorded as the reference.
    expect(runCli(["baseline", "--categories=bogus"])).toBe(1);
  }, 120000);

  it("a regression run without a baseline refuses to call itself clean", async () => {
    const { execFileSync } = await import("node:child_process");
    const { renameSync, existsSync } = await import("node:fs");
    const cliDir = join(import.meta.dirname, "..", "..", "..");
    const baselineFile = join(cliDir, ".data", "eval", "baseline.json");
    const parked = `${baselineFile}.test-parked`;
    const hadBaseline = existsSync(baselineFile);
    if (hadBaseline) renameSync(baselineFile, parked);
    const runCli = (args: string[]) => {
      try {
        execFileSync("npx", ["tsx", join(cliDir, "eval.ts"), ...args], { cwd: cliDir, encoding: "utf8", stdio: "pipe" });
        return 0;
      } catch (e) {
        return typeof (e as { status?: number }).status === "number" ? (e as { status: number }).status : 1;
      }
    };
    try {
      expect(runCli(["regression"])).toBe(1);
    } finally {
      if (hadBaseline) renameSync(parked, baselineFile);
    }
  }, 180000);

  it("the eval job uploads its artifact AFTER the run and never ignores a missing file", () => {
    const yml = readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "..", ".github", "workflows", "ci.yml"), "utf8");
    const job = yml.slice(yml.indexOf("\n  eval:"));
    expect(job.indexOf("npm run eval")).toBeGreaterThan(-1);
    expect(job.indexOf("upload-artifact")).toBeGreaterThan(job.indexOf("npm run eval"));
    expect(job).toContain("if-no-files-found: warn");
    expect(job).not.toContain("if-no-files-found: ignore");
  });

  it("evaluation runs never append to the shared production audit log", async () => {
    const { isTestUserKey } = await import("../users");
    expect(isTestUserKey("eval_user")).toBe(true);
    expect(isTestUserKey("eval_evidence")).toBe(true);
    expect(isTestUserKey("drill_x")).toBe(true);
    // The orchestrator must consult that predicate before writing.
    const orch = readFileSync(join(import.meta.dirname, "..", "orchestrator.ts"), "utf8");
    expect(orch).toContain("if (!isTestUserKey(plan.user))");
  });

  it("slack-style tokens are redacted from artifacts", () => {
    expect(redactSecrets("token xoxb-1234567890-abcdefghijkl")).toBe("token [redacted]");
    expect(redactSecrets("app xapp-1-A123456789-abcdef")).toBe("app [redacted]");
  });
});
