/**
 * Task types recognised by the output formatter.
 *
 * The list is intentionally CLOSED: the classifier maps a user ask onto exactly
 * one of these, and the registry in `registry.ts` holds one formatter per entry.
 * Adding a task type means adding an entry here AND a formatter definition —
 * no prompt rewrite anywhere else (the whole point of the registry).
 */

export const TASK_TYPES = [
  "general_chat",
  "question_answer",
  "research_report",
  "news_and_trends",
  "document_summary",
  "document_analysis",
  "coding_result",
  "debugging_report",
  "code_review",
  "security_audit",
  "pentest_report",
  "test_report",
  "comparison",
  "step_by_step_guide",
  "task_execution_report",
  "discord_message",
  "status_update",
  "progress_update",
  "system_status",
  "error_report",
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export function isTaskType(value: unknown): value is TaskType {
  return typeof value === "string" && (TASK_TYPES as readonly string[]).includes(value);
}

/**
 * How the task type was decided. Recorded on the outcome so a suspicious format
 * can be traced back to its trigger instead of looking arbitrary:
 * - `explicit`  — the user literally asked for this shape ("write a report")
 * - `workflow`  — the task's own shape decides it (a research ask is a report)
 * - `outcome`   — the real execution result decides it (tools ran / a tool failed)
 * - `fallback`  — nothing matched; kept as general chat on purpose
 */
export type ClassificationBasis = "explicit" | "workflow" | "outcome" | "fallback";

export type FormatChannel = "chat" | "discord" | "slack" | "plain";

export interface Classification {
  taskType: TaskType;
  basis: ClassificationBasis;
  /** Short human-readable trigger, e.g. "research-signal" — for observability. */
  signal: string;
  /**
   * The user asked for a specific output shape (JSON, a table, a checklist…).
   * Honoured by skipping structural validation and, for JSON, by passing the
   * body through untouched — a formatter that pretty-prints JSON breaks it.
   */
  explicitFormat?: "json" | "table" | "checklist" | "markdown";
}