// Autonomous problem-solving loop: shared types.
// Phase machine + failure classes + acceptance criteria + recovery decisions + session records.
// Pure: no fs, no network, no agent import (session.ts/probe adapters live elsewhere).

export type PsPhase = "PLAN" | "EXECUTE" | "OBSERVE" | "VERIFY" | "DIAGNOSE" | "RECOVER" | "STOP";

export const PS_PHASES: readonly PsPhase[] = [
  "PLAN",
  "EXECUTE",
  "OBSERVE",
  "VERIFY",
  "DIAGNOSE",
  "RECOVER",
  "STOP",
];

// Forward-only loop with one back-edge: a recovery re-enters EXECUTE.
export const PS_NEXT: Record<PsPhase, readonly PsPhase[]> = {
  PLAN: ["EXECUTE", "STOP"],
  EXECUTE: ["OBSERVE", "DIAGNOSE", "STOP"],
  OBSERVE: ["VERIFY", "DIAGNOSE", "STOP"],
  VERIFY: ["STOP", "DIAGNOSE"],
  DIAGNOSE: ["RECOVER", "STOP"],
  RECOVER: ["EXECUTE", "STOP"],
  STOP: [],
};

export function canPsTransition(from: PsPhase, to: PsPhase): boolean {
  return PS_NEXT[from].includes(to);
}

export type FailureClass =
  | "TRANSIENT"
  | "INPUT_ERROR"
  | "IMPLEMENTATION_ERROR"
  | "DEPENDENCY_ERROR"
  | "ENVIRONMENT_ERROR"
  | "VERIFICATION_FAILURE"
  | "AUTHORIZATION_BLOCKED"
  | "APPROVAL_REQUIRED"
  | "MISSING_INFORMATION"
  | "EXTERNAL_FAILURE"
  | "UNKNOWN";

export const FAILURE_CLASSES: readonly FailureClass[] = [
  "TRANSIENT",
  "INPUT_ERROR",
  "IMPLEMENTATION_ERROR",
  "DEPENDENCY_ERROR",
  "ENVIRONMENT_ERROR",
  "VERIFICATION_FAILURE",
  "AUTHORIZATION_BLOCKED",
  "APPROVAL_REQUIRED",
  "MISSING_INFORMATION",
  "EXTERNAL_FAILURE",
  "UNKNOWN",
];

export type CriterionProbe =
  | { kind: "file_exists"; path: string }
  | { kind: "file_contains"; path: string; needle: string }
  | { kind: "tool"; name: string; args: Record<string, unknown> };

export interface AcceptanceCriterion {
  id: string;
  description: string;
  probe?: CriterionProbe;
}

export type CriterionStatus = "met" | "unmet" | "unknown";
export type CriteriaVerdict =
  | "COMPLETE"
  | "PARTIALLY_COMPLETED"
  | "FAILED"
  | "BLOCKED"
  | "UNKNOWN";

export interface CriterionResultRow {
  id: string;
  status: CriterionStatus;
  detail?: string;
}

export interface CriteriaOutcome {
  verdict: CriteriaVerdict;
  rows: CriterionResultRow[];
  met: number;
  unmet: number;
  unknown: number;
}

export type RecoveryAction = "retry" | "replan" | "delegate" | "escalate" | "stop";

export interface RecoveryDecision {
  action: RecoveryAction;
  /** Class that produced the decision. */
  failure: FailureClass;
  /** Plain reason, always populated: a retry must carry a documented reason. */
  reason: string;
  /** True when the same action fingerprint already repeated past the loop threshold. */
  loop: boolean;
  /** Backoff before the next attempt (ms). 0 = immediate. */
  waitMs: number;
  /** True when this retry does not repeat the identical attempt (a changed approach). */
  changedApproach: boolean;
  budgetStop?: string;
}

export interface RecoveryBudget {
  maxAttempts: number;
  /** Attempts allowed for one failure class before it must stop. */
  maxSameClassAttempts: number;
  /** Identical action fingerprints tolerated before the loop is declared. */
  maxIdenticalRepeat: number;
  maxRecoverySubtasks: number;
  maxDelegationDepth: number;
  maxToolCalls: number;
  maxWallClockMs: number;
  backoffMs: number;
}

export const DEFAULT_RECOVERY_BUDGET: RecoveryBudget = {
  maxAttempts: 3,
  maxSameClassAttempts: 2,
  maxIdenticalRepeat: 3,
  maxRecoverySubtasks: 2,
  maxDelegationDepth: 2,
  maxToolCalls: 24,
  maxWallClockMs: 600_000,
  backoffMs: 0,
};

export function recoveryBudgetFromEnv(env: NodeJS.ProcessEnv = process.env): RecoveryBudget {
  const num = (v: string | undefined, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  };
  return {
    maxAttempts: num(env.RECOVERY_MAX_ATTEMPTS, DEFAULT_RECOVERY_BUDGET.maxAttempts),
    maxSameClassAttempts: num(
      env.RECOVERY_MAX_SAME_CLASS,
      DEFAULT_RECOVERY_BUDGET.maxSameClassAttempts,
    ),
    maxIdenticalRepeat: num(
      env.RECOVERY_MAX_IDENTICAL,
      DEFAULT_RECOVERY_BUDGET.maxIdenticalRepeat,
    ),
    maxRecoverySubtasks: num(
      env.RECOVERY_MAX_SUBTASKS,
      DEFAULT_RECOVERY_BUDGET.maxRecoverySubtasks,
    ),
    maxDelegationDepth: num(
      env.RECOVERY_MAX_DELEGATION_DEPTH,
      DEFAULT_RECOVERY_BUDGET.maxDelegationDepth,
    ),
    maxToolCalls: num(env.RECOVERY_MAX_TOOL_CALLS, DEFAULT_RECOVERY_BUDGET.maxToolCalls),
    maxWallClockMs: num(
      env.RECOVERY_MAX_WALL_CLOCK_MS,
      DEFAULT_RECOVERY_BUDGET.maxWallClockMs,
    ),
    backoffMs: num(env.RECOVERY_BACKOFF_MS, DEFAULT_RECOVERY_BUDGET.backoffMs),
  };
}

export interface PsAttempt {
  /** 1-based attempt number for this task. */
  n: number;
  task_id: string;
  phase: PsPhase;
  /** What was actually attempted (short, no chain of thought). */
  action: string;
  /** Stable fingerprint of the attempt; identical fingerprints mean an identical repeat. */
  fingerprint: string;
  failure?: FailureClass;
  /** Short, quotable error line. Never a fabricated success. */
  error?: string;
  at: number;
  duration_ms: number;
  /** Tool calls this attempt really executed (from the turn, never estimated). */
  tool_calls?: number;
  recovery?: RecoveryAction;
  recovery_reason?: string;
}

export interface PsSession {
  id: string;
  plan_id: string;
  user: string;
  task_id: string;
  agent_id: string | null;
  objective: string;
  criteria: AcceptanceCriterion[];
  budget: RecoveryBudget;
  attempts: PsAttempt[];
  phase: PsPhase;
  status: "active" | "succeeded" | "stopped" | "unknown";
  criteria_outcome?: CriteriaVerdict;
  stop_reason?: string;
  recovery_subtasks: number;
  /** Sum of real tool calls across attempts; the budget reads this, not a guess. */
  tool_calls: number;
  delegation_depth: number;
  started_at: number;
  updated_at: number;
}