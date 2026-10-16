/**
 * Agent Evaluation & Regression Testing — shared result schema.
 *
 * One shape for every layer so a dashboard, a CI gate and a Markdown report
 * never disagree about what happened. Rule that shapes this file: a metric we
 * did not measure is reported as UNAVAILABLE, never as zero, and a blocked case
 * is never counted as a pass.
 */

export const DATASET_VERSION = "2026-10-16.1";
export const RUBRIC_VERSION = "2026-10-16.1";
export const HARNESS_VERSION = "2026-10-16.1";

/** The twelve evaluation areas from the spec, plus a shared one. */
export type EvalArea =
  | "routing"
  | "orchestration"
  | "tool_execution"
  | "evidence"
  | "research"
  | "coding"
  | "output_format"
  | "channel"
  | "file_generation"
  | "error_handling"
  | "approval"
  | "prompt_injection";

export const EVAL_AREAS: readonly EvalArea[] = [
  "routing",
  "orchestration",
  "tool_execution",
  "evidence",
  "research",
  "coding",
  "output_format",
  "channel",
  "file_generation",
  "error_handling",
  "approval",
  "prompt_injection",
];

/**
 * deterministic = production code decides the verdict (no model).
 * model_rubric  = a model grades readability/relevance only; it can never turn
 *                 a deterministic failure into a pass.
 * blocked       = the capability a case needs does not exist yet (honest gap).
 */
export type EvalMethod = "deterministic" | "model_rubric" | "blocked";

export interface EvalCase {
  case_id: string;
  name: string;
  category: EvalArea;
  description: string;
  target_agent: string;
  input_message: string;
  /** Extra inputs the checker needs (mocked messages, tool results, env). */
  context_fixture?: Record<string, unknown>;
  mock_tool_results?: Record<string, string>;
  expected_routing?: string;
  expected_behavior: string;
  required_output_fields?: string[];
  forbidden_claims?: string[];
  acceptance_criteria: string[];
  expected_task_state?: Record<string, unknown>;
  expected_evidence_requirements?: string[];
  sensitivity: "none" | "synthetic" | "sensitive_redacted";
  evaluation_method: EvalMethod;
  /** Registry key of the deterministic checker (required for "deterministic"). */
  checker?: string;
  evaluation_version: string;
  /** Which report metric this case feeds. */
  metric: MetricKey;
  /** Safety/authorization cases must never be hidden by an aggregate score. */
  critical?: boolean;
  /** Why a case is blocked (required when evaluation_method is "blocked"). */
  blocked_reason?: string;
}

export type CaseStatus = "pass" | "fail" | "blocked" | "not_applicable";

export interface CriterionResult {
  id: string;
  ok: boolean;
  detail?: string;
}

export interface CaseResult {
  case_id: string;
  name: string;
  category: EvalArea;
  target_agent: string;
  metric: MetricKey;
  method: EvalMethod;
  status: CaseStatus;
  /** Copied from the case: safety/authorization failures stay visible. */
  critical?: boolean;
  criteria: CriterionResult[];
  failure_reason?: string;
  latency_ms?: number;
  /** Model id used for model-graded criteria, when one ran. */
  model?: string;
  /** Where the answer can be audited (audit log line, artifact path). */
  evidence_reference?: string;
  /** Per-criterion rubric scores, model layer only. */
  rubric_scores?: Record<string, number>;
}

export const METRIC_KEYS = [
  "task_correctness",
  "routing_accuracy",
  "execution_integrity",
  "evidence_integrity",
  "orchestration_reliability",
  "output_quality",
  "safety_authorization",
  "operational_efficiency",
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export interface MetricSummary {
  key: MetricKey;
  numerator: number;
  denominator: number;
  /** null = not measurable from this run (no cases, or all blocked). */
  percent: number | null;
  blocked: number;
  not_applicable: number;
}

export interface GateResult {
  gate: string;
  ok: boolean;
  detail: string;
}

export interface EvalRunReport {
  run_id: string;
  dataset_version: string;
  rubric_version: string;
  harness_version: string;
  /** Git revision if it can be read, else "unknown" — never guessed. */
  revision: string;
  baseline_revision?: string;
  started_at: string;
  finished_at: string;
  totals: { selected: number; pass: number; fail: number; blocked: number; not_applicable: number };
  metrics: MetricSummary[];
  /** Weighted headline for dashboards only; never hides critical failures. */
  aggregate: { score: number | null; weights: Partial<Record<MetricKey, number>> };
  critical_failures: string[];
  gates: GateResult[];
  cases: CaseResult[];
  model_calls: number;
  notes: string[];
}