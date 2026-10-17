/**
 * Proactive Agents & Scheduled Workflow Engine — data contracts.
 *
 * Terpisah dari `automations.ts` (yang khusus prompt-harian dan tidak punya
 * histori/approval) karena kontrak/spec-nya berbeda: agent, policy, retry,
 * approval, evidence, notifikasi. Task engine, orchestrator, evidence
 * registry, approval, dan formatter yang sudah ada tetap dipakai utuh —
 * engine ini tidak menjalankan agent sendiri.
 */

import type { AgentLabel } from "../agentRouting";
import type { ToolCall } from "../tools";

export type TriggerType = "once" | "recurring" | "event";

/** Source event for `trigger_type: "event"`. Only sources we can really observe. */
export type EventSource =
  | "repo_change"
  | "ci_failure"
  | "task_done"
  | "report_generated"
  | "source_updated"
  | "task_state";

export type ScheduleKind = "runonce" | "interval" | "daily" | "weekly" | "monthly";

export interface WorkflowSchedule {
  kind: ScheduleKind;
  /** runonce: ISO instant the workflow should fire. */
  at?: string;
  /** interval: minutes between runs (>= 1). */
  every_minutes?: number;
  /** daily/weekly/monthly: local wall-clock hour 0-23 and minute 0-59. */
  hour?: number;
  minute?: number;
  /** weekly: 0 (Sunday) .. 6 (Saturday) in the workflow timezone. */
  day_of_week?: number;
  /** monthly: 1-28 (ke-29+ ditolak agar semua bulan punya slot). */
  day?: number;
}

export type CatchUpPolicy = "SKIP" | "RUN_ONCE" | "CATCH_UP";
export type ConcurrencyPolicy = "SKIP_IF_RUNNING" | "QUEUE_NEXT" | "ALLOW_PARALLEL";

export interface RetryPolicy {
  max_attempts: number;
  backoff_ms: number;
}

export interface NotificationPolicy {
  on_success: boolean;
  on_failure: boolean;
  on_partial: boolean;
  on_approval_required: boolean;
  on_blocked: boolean;
  /** repeated-failure notice after N consecutive failures (0 = never). */
  repeated_failure_after: number;
}

export interface PermissionPolicy {
  /** Scheduled runs must never auto-approve risky tools (FR-014 stays enforced). */
  allow_risky_tools: false;
  /** Refuse to run when the agent lacks the tools this workflow names. */
  required_tools: string[];
}

export interface AcceptanceCriterion {
  id: string;
  description: string;
}

export interface WorkflowDefinition {
  workflow_id: string;
  name: string;
  description: string;
  enabled: boolean;
  /** Auto-paused by the circuit breaker (distinct from `enabled`). */
  paused: boolean;
  trigger_type: TriggerType;
  event_source?: EventSource;
  schedule: WorkflowSchedule;
  timezone: string;
  agent_id: AgentLabel;
  task_type: string;
  /** The prompt/task body handed to the agent turn. */
  task_configuration: string;
  input_context?: string;
  acceptance_criteria: AcceptanceCriterion[];
  permission_policy: PermissionPolicy;
  approval_policy: {
    /** Minutes an approval grant stays valid (never unlimited). */
    ttl_minutes: number;
  };
  notification_policy: NotificationPolicy;
  retry_policy: RetryPolicy;
  timeout_policy: { timeout_ms: number };
  concurrency_policy: ConcurrencyPolicy;
  catch_up_policy: CatchUpPolicy;
  created_at: string;
  updated_at: string;
  created_by: string;
  next_run_at: number | null;
  last_run_at: string | null;
  last_run_status: ExecutionStatus | null;
  consecutive_failures: number;
}

export type ExecutionStatus =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "PARTIALLY_COMPLETED"
  | "FAILED"
  | "BLOCKED"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "CANCELLED"
  | "SKIPPED";

export const TERMINAL_EXECUTION_STATUSES: readonly ExecutionStatus[] = [
  "SUCCEEDED",
  "PARTIALLY_COMPLETED",
  "FAILED",
  "BLOCKED",
  "CANCELLED",
  "SKIPPED",
];

export interface WorkflowExecution {
  execution_id: string;
  workflow_id: string;
  /** Stable occurrence key = idempotency + history anchor. */
  slot_key: string;
  agent_id: AgentLabel;
  status: ExecutionStatus;
  trigger: TriggerType;
  scheduled_for: string;
  started_at: string | null;
  finished_at: string | null;
  attempts: number;
  /** Real executions of this occurrence (Evidence & Execution Integrity). */
  executed_tools: string[];
  tool_error: boolean;
  artifacts: string[];
  evidence_reference: string;
  result_text: string;
  /** Set only when the run paused at an approval boundary. */
  pending_calls?: ToolCall[];
  pending_messages?: unknown;
  approval_expires_at?: string;
  error_summary: string;
  /** True only when the messaging layer actually confirmed the send. */
  notified: boolean;
  provider_used: string | null;
  model: string | null;
  duration_ms: number;
}

/** Budget guard so one workflow cannot starve the others. */
export const WORKFLOW_BUDGET = {
  /** Cap on occurrences dispatched per tick. The tick loop awaits each run, so
   *  in-process concurrency is 1; this is a per-tick budget, not a parallel
   *  limit (renamed 2026-10-16 after the audit found `max_concurrent` was
   *  silently acting as a per-tick cap anyway). */
  max_dispatches_per_tick: 6,
} as const;