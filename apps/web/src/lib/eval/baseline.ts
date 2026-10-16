import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { appRoot } from "../users";
import type { CaseResult, CaseStatus, EvalRunReport } from "./types";

/**
 * Baselines and regression comparison.
 *
 * A baseline is a record of per-case status plus the revisions it was taken
 * under. Comparison answers four questions and nothing more: what newly fails,
 * what got fixed, what changed status, and which versions moved. It never
 * declares a version "better" from a noisy score delta — the caller decides.
 */

export interface BaselineMeta {
  revision: string;
  dataset_version: string;
  rubric_version: string;
  harness_version: string;
  created_at: string;
  /** Agent -> model id actually used, or "unknown". Never guessed. */
  model_ids: Record<string, string>;
}

export interface Baseline {
  meta: BaselineMeta;
  case_status: Record<string, CaseStatus>;
  /** Latency per case, when measured. */
  case_latency_ms: Record<string, number>;
}

export function evalRoot(): string {
  return join(appRoot(), ".data", "eval");
}

export function baselinePath(): string {
  return join(evalRoot(), "baseline.json");
}

export function runDir(runId: string): string {
  return join(evalRoot(), "runs", runId);
}

/** Best-effort revision. "unknown" is a valid, honest answer. */
export function currentRevision(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: appRoot(), encoding: "utf8" }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

export function buildBaseline(report: EvalRunReport, modelIds: Record<string, string> = {}): Baseline {
  const case_status: Record<string, CaseStatus> = {};
  const case_latency_ms: Record<string, number> = {};
  for (const c of report.cases) {
    case_status[c.case_id] = c.status;
    if (typeof c.latency_ms === "number") case_latency_ms[c.case_id] = c.latency_ms;
  }
  return {
    meta: {
      revision: report.revision,
      dataset_version: report.dataset_version,
      rubric_version: report.rubric_version,
      harness_version: report.harness_version,
      created_at: report.finished_at,
      model_ids: modelIds,
    },
    case_status,
    case_latency_ms,
  };
}

export function saveBaseline(baseline: Baseline, path = baselinePath()): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(baseline, null, 2));
  return path;
}

export function loadBaseline(path = baselinePath()): Baseline | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Baseline>;
    // Shape check: a structurally wrong file ({} from a bad run) used to reach
    // compareToBaseline and throw a raw TypeError with no explanation (audit 2026-10-16).
    if (typeof parsed?.meta?.revision !== "string" || !parsed.case_status || typeof parsed.case_status !== "object") {
      return undefined;
    }
    return parsed as Baseline;
  } catch {
    return undefined;
  }
}

export interface BaselineComparison {
  baseline_revision: string;
  new_failures: string[];
  fixed: string[];
  changed: Array<{ case_id: string; from: CaseStatus; to: CaseStatus }>;
  new_cases: string[];
  removed_cases: string[];
  dataset_version_changed: boolean;
  rubric_version_changed: boolean;
  harness_version_changed: boolean;
  latency: { case_id: string; baseline_ms: number; candidate_ms: number; delta_ms: number }[];
}

export function compareToBaseline(report: EvalRunReport, baseline: Baseline): BaselineComparison {
  const now: Record<string, CaseStatus> = {};
  for (const c of report.cases) now[c.case_id] = c.status;

  const new_failures: string[] = [];
  const fixed: string[] = [];
  const changed: BaselineComparison["changed"] = [];
  for (const [id, before] of Object.entries(baseline.case_status)) {
    const after = now[id];
    if (after === undefined) continue;
    if (before === "pass" && after === "fail") new_failures.push(id);
    if (before === "fail" && after === "pass") fixed.push(id);
    if (before !== after) changed.push({ case_id: id, from: before, to: after });
  }
  const latency: BaselineComparison["latency"] = [];
  for (const c of report.cases) {
    const before = baseline.case_latency_ms[c.case_id];
    if (typeof before === "number" && typeof c.latency_ms === "number") {
      latency.push({ case_id: c.case_id, baseline_ms: before, candidate_ms: c.latency_ms, delta_ms: c.latency_ms - before });
    }
  }
  return {
    baseline_revision: baseline.meta.revision,
    new_failures,
    fixed,
    changed,
    new_cases: Object.keys(now).filter((id) => !(id in baseline.case_status)),
    removed_cases: Object.keys(baseline.case_status).filter((id) => !(id in now)),
    dataset_version_changed: baseline.meta.dataset_version !== report.dataset_version,
    rubric_version_changed: baseline.meta.rubric_version !== report.rubric_version,
    harness_version_changed: baseline.meta.harness_version !== report.harness_version,
    latency: latency.sort((a, b) => Math.abs(b.delta_ms) - Math.abs(a.delta_ms)).slice(0, 10),
  };
}