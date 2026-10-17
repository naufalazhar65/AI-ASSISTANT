/**
 * Persistent workflow registry (definitions) + execution history, kept in two
 * files so editing a schedule never erases past runs. Same per-user JSON +
 * atomic tmp+rename convention as `automations.ts` / `reminders.ts`.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { sanitizeUser, userDataRoot } from "../users";
import { defaultTimezone, nextOccurrence, validateSchedule } from "./schedule";
import { isAgentLabel } from "../agentRole";
import type { ExecutionStatus, WorkflowDefinition, WorkflowExecution } from "./types";

const MAX_WORKFLOWS = 40;
const MAX_EXECUTIONS = 100;

function wfPath(userKey: string): string {
  return join(userDataRoot(), userKey, "workflows.json");
}
function execPath(userKey: string): string {
  return join(userDataRoot(), userKey, "workflow-executions.json");
}

function readJsonArray<T>(file: string): T[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    // Corrupt file: QUARANTINE it instead of returning []. Returning [] plus the
    // next write silently destroys every definition/execution (audit 2026-10-16).
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      /* best effort */
    }
    return [];
  }
}

function writeJsonArray(file: string, rows: unknown[]): void {
  mkdirSync(dirname(file), { recursive: true });
  // Unique tmp per write: a shared `${file}.tmp` lets two overlapping writers
  // (worker tick + manual run_now) clobber each other's rename (audit 2026-10-16).
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(rows, null, 2));
  renameSync(tmp, file);
}

function isWorkflow(x: unknown): x is WorkflowDefinition {
  const w = x as Partial<WorkflowDefinition> | null;
  return !!w && typeof w.workflow_id === "string" && typeof w.name === "string" && !!w.schedule && typeof w.agent_id === "string";
}

function isExecution(x: unknown): x is WorkflowExecution {
  const e = x as Partial<WorkflowExecution> | null;
  return !!e && typeof e.execution_id === "string" && typeof e.slot_key === "string" && typeof e.workflow_id === "string";
}

export function listWorkflowUsers(): string[] {
  try {
    return readdirSync(userDataRoot(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export function readWorkflows(rawUser?: unknown): WorkflowDefinition[] {
  const key = sanitizeUser(rawUser);
  if (!key) return [];
  return readJsonArray<WorkflowDefinition>(wfPath(key)).filter(isWorkflow);
}

export function readWorkflow(rawUser: unknown, workflowId: string): WorkflowDefinition | undefined {
  return readWorkflows(rawUser).find((w) => w.workflow_id === workflowId);
}

/** Users holding at least one enabled workflow. */
export function listUsersWithWorkflows(): string[] {
  return listWorkflowUsers().filter((u) => readWorkflows(u).some((w) => w.enabled));
}

export function saveWorkflow(rawUser: unknown, wf: WorkflowDefinition): WorkflowDefinition {
  const key = sanitizeUser(rawUser);
  if (!key) throw new Error("user tidak valid");
  const existing = readWorkflows(key);
  const all = existing.filter((w) => w.workflow_id !== wf.workflow_id);
  // Refuse at the cap: silently dropping the OLDEST definition on the 41st add
  // loses a scheduled job with no error (audit 2026-10-16).
  if (all.length >= MAX_WORKFLOWS && !existing.some((w) => w.workflow_id === wf.workflow_id))
    throw new Error(`batas workflow tercapai (${MAX_WORKFLOWS}) — hapus workflow lama dulu`);
  all.push({ ...wf, updated_at: new Date().toISOString() });
  all.sort((a, b) => (a.created_at === b.created_at ? 0 : a.created_at < b.created_at ? -1 : 1));
  writeJsonArray(wfPath(key), all.slice(-MAX_WORKFLOWS));
  return wf;
}

/** Delete the definition but keep execution history (retention policy). */
export function deleteWorkflow(rawUser: unknown, workflowId: string): boolean {
  const key = sanitizeUser(rawUser);
  if (!key) return false;
  const all = readWorkflows(key);
  const next = all.filter((w) => w.workflow_id !== workflowId);
  if (next.length === all.length) return false;
  writeJsonArray(wfPath(key), next);
  return true;
}

export function readExecutions(rawUser?: unknown, limit = MAX_EXECUTIONS): WorkflowExecution[] {
  const key = sanitizeUser(rawUser);
  if (!key) return [];
  return readJsonArray<WorkflowExecution>(execPath(key))
    .filter(isExecution)
    .slice(-limit)
    .reverse();
}

export function readExecution(rawUser: unknown, slotKeyOrId: string): WorkflowExecution | undefined {
  return readExecutions(rawUser, MAX_EXECUTIONS).find((e) => e.slot_key === slotKeyOrId || e.execution_id === slotKeyOrId);
}

export function saveExecution(rawUser: unknown, exec: WorkflowExecution): WorkflowExecution {
  const key = sanitizeUser(rawUser);
  if (!key) throw new Error("user tidak valid");
  const file = execPath(key);
  const all = readJsonArray<WorkflowExecution>(file);
  const i = all.findIndex((e) => e.slot_key === exec.slot_key);
  if (i >= 0) all[i] = exec;
  else all.push(exec);
  writeJsonArray(file, all.slice(-MAX_EXECUTIONS));
  return exec;
}

export function updateWorkflowProgress(
  rawUser: unknown,
  workflowId: string,
  patch: Partial<Pick<WorkflowDefinition, "last_run_at" | "last_run_status" | "consecutive_failures" | "enabled" | "paused" | "next_run_at">>
): WorkflowDefinition | undefined {
  const wf = readWorkflow(rawUser, workflowId);
  if (!wf) return undefined;
  return saveWorkflow(rawUser, { ...wf, ...patch });
}

/** Test/eval hygiene: remove a throwaway user's workflow store. */
export function purgeWorkflows(rawUser: unknown): void {
  const key = sanitizeUser(rawUser);
  if (!key) return;
  for (const f of [wfPath(key), execPath(key)]) {
    try {
      if (existsSync(f)) unlinkSync(f);
    } catch {
      /* best effort */
    }
  }
  try {
    const dir = join(userDataRoot(), key);
    for (const name of readdirSync(dir)) {
      if (name.startsWith("workflows.json.tmp") || name.startsWith("workflow-executions.json.tmp") || name.includes(".corrupt-")) {
        try {
          unlinkSync(join(dir, name));
        } catch {
          /* best effort */
        }
      }
    }
  } catch {
    /* dir may not exist */
  }
}

/* ------------------------------------------------------------- definitions */

export interface NewWorkflowInput {
  name: string;
  description?: string;
  trigger_type: WorkflowDefinition["trigger_type"];
  event_source?: WorkflowDefinition["event_source"];
  schedule: WorkflowDefinition["schedule"];
  timezone?: string;
  agent_id: WorkflowDefinition["agent_id"];
  task_type: string;
  task_configuration: string;
  input_context?: string;
  acceptance_criteria?: { id?: string; description: string }[];
  required_tools?: string[];
  notification_policy?: Partial<WorkflowDefinition["notification_policy"]>;
  retry_policy?: Partial<WorkflowDefinition["retry_policy"]>;
  timeout_ms?: number;
  concurrency_policy?: WorkflowDefinition["concurrency_policy"];
  catch_up_policy?: WorkflowDefinition["catch_up_policy"];
  enabled?: boolean;
  /** Injected clock so tests and catch-up are deterministic. */
  now?: number;
}

export const VALID_EVENT_SOURCES: readonly WorkflowDefinition["event_source"][] = [
  "repo_change",
  "ci_failure",
  "task_done",
  "report_generated",
  "source_updated",
  "task_state",
];

export function newWorkflowId(now = Date.now()): string {
  return `wf-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Build + validate a definition. Throws with every reason so nothing is silently coerced. */
export function buildWorkflow(rawUser: unknown, input: NewWorkflowInput): WorkflowDefinition {
  const key = sanitizeUser(rawUser);
  if (!key) throw new Error("user tidak valid");
  const timezone = input.timezone?.trim() || defaultTimezone();
  const errors: string[] = [];
  if (!String(input.name || "").trim()) errors.push("name wajib diisi");
  // A non-string task used to be stored as the literal "[object Object]", so the run
  // reached the model as meaningless text and the workflow failed silently
  // (audit 2026-10-16). Reject the shape instead of coercing it.
  if (typeof input.task_configuration !== "string") errors.push("task_configuration harus berupa teks (string)");
  else if (!input.task_configuration.trim()) errors.push("task_configuration wajib diisi");
  const sched = validateSchedule(input.schedule, timezone);
  errors.push(...sched.errors);
  if (!input.trigger_type) errors.push("trigger_type wajib diisi");
  // `event` has NO dispatcher anywhere in the codebase (audit 2026-10-16), so
  // accepting it would create a permanently inert job shown as enabled. Refuse
  // until a real event source exists instead of pretending to monitor one.
  if (input.trigger_type === "event") errors.push("trigger_type event belum didukung (belum ada sumber event) — pakai once atau recurring");
  if (input.trigger_type !== "event" && input.event_source) errors.push("event_source hanya untuk trigger event");
  if (!isAgentLabel(input.agent_id)) errors.push(`agent_id tidak terdaftar: ${input.agent_id}`);
  if (input.catch_up_policy && !["SKIP", "RUN_ONCE"].includes(input.catch_up_policy))
    errors.push(`catch_up_policy tidak didukung: ${input.catch_up_policy}`);
  if (input.concurrency_policy && !["SKIP_IF_RUNNING", "QUEUE_NEXT", "ALLOW_PARALLEL"].includes(input.concurrency_policy))
    errors.push(`concurrency_policy tidak didukung: ${input.concurrency_policy}`);
  if (errors.length) throw new Error(`workflow tidak valid: ${errors.join("; ")}`);

  const now = input.now ?? Date.now();
  const next = input.trigger_type === "event" ? null : nextOccurrence(input.schedule, timezone, now);
  return {
    workflow_id: newWorkflowId(now),
    name: String(input.name).trim(),
    description: String(input.description ?? ""),
    enabled: input.enabled ?? true,
    paused: false,
    trigger_type: input.trigger_type,
    event_source: input.event_source,
    schedule: input.schedule,
    timezone,
    agent_id: input.agent_id,
    task_type: String(input.task_type || "assistant"),
    task_configuration: String(input.task_configuration).trim(),
    input_context: input.input_context,
    acceptance_criteria: (input.acceptance_criteria ?? []).map((c, i) => ({
      id: c.id ?? `ac${i + 1}`,
      description: String(c.description),
    })),
    permission_policy: { allow_risky_tools: false, required_tools: input.required_tools ?? [] },
    approval_policy: { ttl_minutes: 30 },
    notification_policy: {
      on_success: true,
      on_failure: true,
      on_partial: true,
      on_approval_required: true,
      on_blocked: true,
      repeated_failure_after: 3,
      ...(input.notification_policy ?? {}),
    },
    retry_policy: { max_attempts: 1, backoff_ms: 60_000, ...(input.retry_policy ?? {}) },
    timeout_policy: { timeout_ms: Math.max(5_000, input.timeout_ms ?? 300_000) },
    concurrency_policy: input.concurrency_policy ?? "SKIP_IF_RUNNING",
    catch_up_policy: input.catch_up_policy ?? "SKIP",
    created_at: new Date(now).toISOString(),
    updated_at: new Date(now).toISOString(),
    // NOT caller-controlled: the owner key comes from the sanitized user (audit
    // 2026-10-16 — a forged created_by made rollForward copy the definition
    // into another user's store and re-run the task there).
    created_by: key,
    next_run_at: next,
    last_run_at: null,
    last_run_status: null,
    consecutive_failures: 0,
  };
}

export function workflowSummary(w: WorkflowDefinition): string {
  const state = !w.enabled ? "NONAKTIF" : w.paused ? "DIJEDA" : "AKTIF";
  return `${w.name} — ${state} · ${w.agent_id} · ${w.last_run_status ?? "belum pernah jalan"}`;
}

export function executionStatusRank(status: ExecutionStatus): number {
  return status === "SUCCEEDED" ? 0 : status === "PARTIALLY_COMPLETED" ? 1 : status === "AWAITING_APPROVAL" ? 2 : 3;
}