/**
 * Workflow execution — a scheduled occurrence enters the SAME agent turn the
 * chat adapters use (`runAssistantTurn`). This module owns policy, evidence,
 * approval pause and notification; it never implements its own agent loop.
 *
 * Honesty invariants carried over from the rest of the repo:
 * - risky tools are NEVER auto-approved by a schedule (approval_policy);
 * - a run that reached an approval boundary is AWAITING_APPROVAL, not success;
 * - "notified" is true only when the messaging layer confirmed the send;
 * - executed tools come from real tool results, never from prose.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { runAssistantTurn } from "../agent";
import { auditLog } from "../auditLog";
import { wibDay } from "../time";
import { isAvailableAgent, unavailableReason } from "../agentRegistry";
import { turnOutcomeFromMessages } from "../messageReactions";
import { pushToOwner } from "../../channels/pushTarget";
import { sanitizeUser, userDataRoot } from "../users";
import { readExecution, readWorkflow, saveExecution, updateWorkflowProgress } from "./store";
import type { WorkflowDefinition, WorkflowExecution } from "./types";

/** Lazy requires: `tools.ts` is a heavy module and only needed for the check
 *  above. require() is unavailable under vitest ESM, so we import statically. */
import { agentDomains as agentRoleDomains, toolDomain } from "../roleGate";
import { getTOOLS } from "../tools";
const require_roleGate = () => ({ toolDomain });
const require_tools = () => ({ getTOOLS });

export interface RunWorkflowOptions {
  /** Retry attempt number (1-based). Recorded, never guessed: a hardcoded 0 was
   *  a fabricated field (audit 2026-10-16). */
  attempt?: number;
  /** Injected clock (tests). */
  now?: () => number;
  /** Injected agent turn (tests / drills) — defaults to the production turn. */
  runTurn?: typeof runAssistantTurn;
  /** Injected notifier — defaults to `pushToOwner`. */
  notify?: (text: string) => Promise<boolean>;
  /** Reason string recorded when the run was skipped. */
  skipReason?: string;
}

/** Reasons a workflow can be refused BEFORE any turn runs. */
export function preflight(wf: WorkflowDefinition): string | null {
  if (!wf.enabled) return "workflow NONAKTIF";
  if (wf.paused) return "workflow dijeda";
  const profile = isAvailableAgent(wf.agent_id) ? null : unavailableReason(wf.agent_id) ?? "agent tidak terdaftar";
  if (profile) return `agent tidak bisa dipakai: ${profile}`;
  const domains = new Set<string>(agentRoleDomains(wf.agent_id) ?? []);
  const required = wf.permission_policy.required_tools ?? [];
  if (!required.length) return null;
  // Compare TOOL DOMAINS, never domain names against tool names: the previous
  // `domains.has(toolName)` check blocked every legal tool and accepted unknown
  // names (audit 2026-10-16, HIGH-3).
  const { toolDomain } = require_roleGate();
  const { getTOOLS } = require_tools();
  const known = new Set(getTOOLS().map((t: { function?: { name?: string }; name?: string }) => t.function?.name ?? t.name ?? ""));
  const unknown = required.filter((t) => !known.has(t));
  if (unknown.length) return `tool tidak dikenal: ${unknown.join(", ")}`;
  if (domains.size === 0) return null; // ungated agent (coordinator) may use anything
  const outside = required.filter((t) => {
    const d = toolDomain(t);
    return d !== undefined && !domains.has(d);
  });
  if (outside.length) return `tool di luar domain agent: ${outside.join(", ")}`;
  return null;
}

function withTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} melewati batas ${ms}ms`)), ms);
    fn().then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

const ARTIFACT_RE = /((?:[\w.-]+\/)?[\w.-]+\.(?:md|pdf|json|html|csv|txt))/g;

/** Artifacts claimed in the text, kept only when the file really exists. */
export function verifiedArtifacts(userKey: string, text: string): string[] {
  const found = new Set<string>();
  const key = sanitizeUser(userKey) ?? "shared";
  const base = join(userDataRoot(), key, "reports");
  for (const m of String(text || "").matchAll(ARTIFACT_RE)) {
    const name = m[1];
    if (name.includes("..") || name.startsWith("/") || name.startsWith("~")) continue;
    if (existsSync(join(base, name)) || existsSync(join(userDataRoot(), key, name))) found.add(name);
  }
  return [...found];
}

function evidenceRef(userKey: string, exec: WorkflowExecution, optsNow?: number): string {
  const key = sanitizeUser(userKey) ?? "shared";
  // auditLog keys its files by WIB day; using UTC here named yesterday's file
  // for 7 hours a day (audit 2026-10-16, MEDIUM-18).
  const at = wibDay(optsNow ?? Date.now());
  return `audit/AUDIT-${at}.log (user=${key}, execution=${exec.execution_id})`;
}

export function newExecution(wf: WorkflowDefinition, slotKey: string, now: number, attempt = 1): WorkflowExecution {
  return {
    execution_id: `ex-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    workflow_id: wf.workflow_id,
    slot_key: slotKey,
    agent_id: wf.agent_id,
    status: "QUEUED",
    trigger: wf.trigger_type,
    scheduled_for: new Date(now).toISOString(),
    started_at: null,
    finished_at: null,
    attempts: Math.max(1, attempt),
    executed_tools: [],
    tool_error: false,
    artifacts: [],
    evidence_reference: "",
    result_text: "",
    error_summary: "",
    notified: false,
    provider_used: null,
    model: null,
    duration_ms: 0,
  };
}

/**
 * Live turn promises, keyed by slot. A timeout is recorded as FAILED but the
 * turn itself keeps running (`runAssistantTurn` takes no AbortSignal), so the
 * scheduler needs a way to hold the slot until the orphan actually settles
 * instead of guessing from the rejection (audit 2026-10-16 lifecycle drill).
 */
const liveTurns = new Map<string, Promise<unknown>>();

export function liveTurnFor(slot: string): Promise<unknown> | undefined {
  return liveTurns.get(slot);
}

async function notifyWorkflow(
  wf: WorkflowDefinition,
  exec: WorkflowExecution,
  opts: RunWorkflowOptions,
  /** Post-run consecutive failure count (reading wf here was off by one). */
  failures = wf.consecutive_failures
): Promise<boolean> {
  const notify = opts.notify ?? pushToOwner;
  const p = wf.notification_policy;
  let want = false;
  if (exec.status === "SUCCEEDED") want = p.on_success;
  else if (exec.status === "PARTIALLY_COMPLETED") want = p.on_partial;
  else if (exec.status === "FAILED") want = p.on_failure || (p.repeated_failure_after > 0 && failures >= p.repeated_failure_after);
  else if (exec.status === "AWAITING_APPROVAL") want = p.on_approval_required;
  else if (exec.status === "BLOCKED" || exec.status === "CANCELLED") want = p.on_blocked;
  if (!want) return false;
  const detail =
    exec.status === "AWAITING_APPROVAL"
      ? `\nOperasi menunggu persetujuan: ${(exec.pending_calls ?? []).map((c) => c.name).join(", ") || "(tidak ada)"}`
      : exec.error_summary
        ? `\nAlasan: ${exec.error_summary}`
        : exec.artifacts.length
          ? `\nArtefak: ${exec.artifacts.join(", ")}`
          : "";
  const approve =
    exec.status === "AWAITING_APPROVAL"
      ? `\nSetujui/tolak dengan: workflow_approve execution_id=${exec.execution_id} allow=true|false`
      : "";
  const text = `${statusIcon(exec.status)} ${wf.name} — ${exec.status}\nexecution_id: ${exec.execution_id}\n${exec.result_text.slice(0, 800)}${detail}${approve}`;
  return await notify(text);
}

function statusIcon(status: WorkflowExecution["status"]): string {
  if (status === "SUCCEEDED") return "✅";
  if (status === "PARTIALLY_COMPLETED") return "🟡";
  if (status === "AWAITING_APPROVAL") return "⏸️";
  if (status === "BLOCKED") return "⚠️";
  if (status === "CANCELLED") return "🚫";
  return "❌";
}

/**
 * Execute one scheduled occurrence. Manual runs use the same path, so a
 * manual trigger can never bypass authorization.
 */
export async function runWorkflowOccurrence(
  rawUser: unknown,
  wf: WorkflowDefinition,
  slotKey: string,
  scheduledForMs: number,
  opts: RunWorkflowOptions = {}
): Promise<WorkflowExecution> {
  const now = opts.now ?? Date.now;
  const runTurn = opts.runTurn ?? runAssistantTurn;
  const start = now();
  const blocked = preflight(wf);
  const exec = newExecution(wf, slotKey, start, opts.attempt ?? 1);
  if (blocked) {
    exec.status = "BLOCKED";
    exec.error_summary = blocked;
    exec.started_at = new Date(start).toISOString();
    exec.finished_at = new Date(start).toISOString();
        exec.evidence_reference = evidenceRef(String(rawUser), exec, start);
    // `notified` is persisted AFTER the send result: the previous order
    // recorded a real push as undelivered (audit MEDIUM-8).
    // A blocked occurrence is a real outcome: it used to skip the accounting
    // below, so `last_run_status` stayed null ("belum pernah jalan") and the
    // circuit breaker never engaged — a permanently blocked agent pushed a
    // warning on EVERY occurrence, forever (audit 2026-10-16).
    const blockedFailures = wf.consecutive_failures + 1;
    const blockedBreaker = blockedFailures >= Math.max(2, wf.notification_policy.repeated_failure_after);
    updateWorkflowProgress(rawUser, wf.workflow_id, {
      last_run_at: exec.finished_at,
      last_run_status: exec.status,
      consecutive_failures: blockedFailures,
      // Only the breaker may set `paused`. Writing `wf.paused` back from the
      // snapshot taken before the turn started reverted an owner's mid-run pause
      // (audit 2026-10-16 lifecycle drill).
      ...(blockedBreaker ? { paused: true } : {}),
    });
    const sent = /NONAKTIF|dijeda/.test(blocked)
      ? false
      : await notifyWorkflow(wf, exec, opts, blockedFailures);
    exec.notified = sent;
    saveExecution(rawUser, exec);
    return exec;
  }

  exec.status = "RUNNING";
  exec.started_at = new Date(start).toISOString();
  saveExecution(rawUser, exec);

  const brief = [
    `[Scheduled workflow ${wf.name}]`,
    `Tugas: ${wf.task_configuration}`,
    wf.input_context ? `Konteks: ${wf.input_context}` : "",
    wf.acceptance_criteria.length ? `Kriteria selesai: ${wf.acceptance_criteria.map((c) => c.description).join("; ")}` : "",
    "Ini pekerjaan terjadwal: kerjakan langsung, jangan mengarang hasil, dan akui jujur bila ada yang gagal. Kalau sebuah operasi butuh izin owner, biarkan sistem menjeda eksekusinya dan tunggu persetujuan (jangan minta konfirmasi di dalam jawaban).",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const turnPromise = runTurn({
      messages: [{ role: "user", content: brief }],
      user: rawUser,
      channel: "discord", systemDelivers: "workflow notification",
      agent: wf.agent_id,
      provider: process.env.WORKFLOW_PROVIDER || undefined,
    });
    liveTurns.set(slotKey, turnPromise);
    void turnPromise.finally(() => liveTurns.delete(slotKey)).catch(() => undefined);
    const result = await withTimeout(
      () => turnPromise,
      wf.timeout_policy.timeout_ms,
      "workflow"
    );
    exec.result_text = String(result.text || "");
    exec.provider_used = result.providerUsed ?? null;
    const outcome = turnOutcomeFromMessages(result.messages ?? []);
    exec.executed_tools = [...outcome.executedTools];
    exec.tool_error = outcome.toolError;
    exec.artifacts = verifiedArtifacts(String(rawUser), exec.result_text);

    if (Array.isArray(result.needsConfirmation) && result.needsConfirmation.length > 0) {
      // Approval boundary: a schedule must never grant its own permission.
      exec.status = "AWAITING_APPROVAL";
      exec.pending_calls = result.needsConfirmation;
      exec.pending_messages = result.messages;
      exec.approval_expires_at = new Date(now() + wf.approval_policy.ttl_minutes * 60_000).toISOString();
      exec.error_summary = `menunggu persetujuan owner untuk ${result.needsConfirmation.map((c) => c.name).join(", ")}`;
    } else if (!exec.result_text.trim()) {
      exec.status = "FAILED";
      exec.error_summary = "agent tidak mengembalikan hasil";
    } else if (exec.tool_error) {
      exec.status = "PARTIALLY_COMPLETED";
      exec.error_summary = "sebagian tool gagal di giliran ini";
    } else {
      exec.status = "SUCCEEDED";
    }
  } catch (e) {
    exec.status = "FAILED";
    exec.error_summary =
      e instanceof Error && /melewati batas/.test(e.message)
        ? `${e.message} — turn tidak bisa dibatalkan dari sini, ia mungkin masih berjalan di latar`
        : e instanceof Error
          ? e.message
          : String(e);
  }

  if (exec.status !== "AWAITING_APPROVAL") exec.finished_at = new Date(now()).toISOString();
  exec.duration_ms = Math.max(0, now() - start);
  exec.evidence_reference = evidenceRef(String(rawUser), exec);
  // An operator cancel writes CANCELLED to the row while the turn is still in
  // flight; saving our own local copy would resurrect a success the owner
  // already stopped (audit 2026-10-16: route said CANCELLED, row then said
  // SUCCEEDED). The operator's decision wins.
  const storedNow = readExecution(rawUser, exec.slot_key);
  if (storedNow?.status === "CANCELLED") {
    exec.status = "CANCELLED";
    exec.error_summary = exec.error_summary || "dibatalkan manual";
    return storedNow;
  }
  saveExecution(rawUser, exec);

  const failures = exec.status === "FAILED" ? wf.consecutive_failures + 1 : 0;
  const breaker = failures >= Math.max(2, wf.notification_policy.repeated_failure_after);
  if (exec.status !== "AWAITING_APPROVAL") {
    // Re-read the stored definition: a whole-object save resurrects a workflow
    // the owner deleted mid-run and silently reverts their pause (audit
    // 2026-10-16). `updateWorkflowProgress` returns undefined when the row is
    // gone, which is the honest outcome — the run happened, the job no longer
    // exists.
    updateWorkflowProgress(rawUser, wf.workflow_id, {
      last_run_at: exec.finished_at,
      last_run_status: exec.status,
      consecutive_failures: failures,
      // Same rule as the BLOCKED path: an owner pause made mid-run must survive
      // this write; only the breaker may set `paused`.
      ...(breaker ? { paused: true } : {}),
    });
  }
  exec.notified = await notifyWorkflow(wf, exec, opts, failures);
  if (exec.notified) saveExecution(rawUser, exec);
  auditLog(rawUser, "workflow_run", `${wf.name} ${exec.status} tools=${exec.executed_tools.join(",") || "-"}`);
  return exec;
}

/** Resume a paused-at-approval occurrence with a real owner decision. */
export async function resolveApproval(
  rawUser: unknown,
  slotKeyOrId: string,
  allow: boolean,
  decidedBy: string,
  opts: RunWorkflowOptions = {}
): Promise<WorkflowExecution> {
  const now = opts.now ?? Date.now;
  const exec = (await import("./store")).readExecution(rawUser, slotKeyOrId);
  const wf = exec ? readWorkflow(rawUser, exec.workflow_id) : undefined;
  if (!exec || !wf) throw new Error("eksekusi tidak ditemukan");
  if (exec.status !== "AWAITING_APPROVAL") throw new Error(`eksekusi tidak menunggu persetujuan (status ${exec.status})`);
  if (exec.approval_expires_at && Date.parse(exec.approval_expires_at) <= now()) {
    // Terminalise before refusing: leaving the row AWAITING_APPROVAL made every
    // later attempt fail the same way with nothing able to move it — a permanent
    // stall that also kept the workflow's occurrence stuck (audit 2026-10-16).
    exec.status = "FAILED";
    exec.error_summary = "persetujuan kedaluwarsa tanpa keputusan owner";
    exec.finished_at = new Date(now()).toISOString();
    exec.pending_calls = undefined;
    exec.pending_messages = undefined;
    saveExecution(rawUser, exec);
    updateWorkflowProgress(rawUser, wf.workflow_id, {
      last_run_at: exec.finished_at,
      last_run_status: exec.status,
      consecutive_failures: wf.consecutive_failures + 1,
    });
    auditLog(rawUser, "workflow_approval_expired", `${wf.name}: persetujuan kedaluwarsa`);
    throw new Error("persetujuan kedaluwarsa — eksekusi ditandai gagal, jalankan ulang bila masih perlu");
  }
  const calls = (exec.pending_calls ?? []).map((c) => ({ call: c, allow }));
  if (!allow) {
    exec.status = "CANCELLED";
    exec.error_summary = `owner menolak (${decidedBy})`;
    exec.finished_at = new Date(now()).toISOString();
    exec.pending_calls = undefined;
    // The decline is a NEW outcome, so the earlier "waiting for approval" push no
    // longer describes this row — leaving notified=true made the store claim a
    // delivery that never happened for this status (audit 2026-10-16).
    exec.notified = false;
    saveExecution(rawUser, exec);
    auditLog(rawUser, "workflow_approval", `${wf.name} ditolak oleh ${decidedBy}`);
    await notifyWorkflow(wf, exec, opts, wf.consecutive_failures);
    return exec;
  }
  // Re-check the guard: a workflow paused/disabled while it waited must NOT be
  // executed by the approval click (audit 2026-10-16).
  const block = preflight(wf);
  if (block) {
    exec.status = "BLOCKED";
    exec.error_summary = `setelah menunggu persetujuan: ${block}`;
    exec.finished_at = new Date(now()).toISOString();
    exec.pending_calls = undefined;
    exec.pending_messages = undefined;
    saveExecution(rawUser, exec);
    auditLog(rawUser, "workflow_blocked", `${wf.name} diblokir saat approval: ${block}`);
    return exec;
  }
  const runTurn = opts.runTurn ?? runAssistantTurn;
  const messages = (exec.pending_messages ?? []) as Parameters<typeof runAssistantTurn>[0]["messages"];
  try {
    const result = (await withTimeout(
      () => runTurn({ messages, user: rawUser, channel: "discord", systemDelivers: "workflow notification", agent: wf.agent_id, confirm_calls: calls }),
      wf.timeout_policy.timeout_ms,
      `turn melebihi batas ${wf.timeout_policy.timeout_ms}ms`
    )) as Awaited<ReturnType<typeof runAssistantTurn>>;
    exec.result_text = `${exec.result_text}\n${result.text}`.trim();
    const outcome = turnOutcomeFromMessages(result.messages ?? []);
    exec.executed_tools = [...new Set([...exec.executed_tools, ...outcome.executedTools])];
    exec.tool_error = exec.tool_error || outcome.toolError;
    exec.artifacts = [...new Set([...exec.artifacts, ...verifiedArtifacts(String(rawUser), exec.result_text)])];
    // Same mapping as the FIRST run: a resumed turn that needed approval again
    // keeps its pending calls (dropping them made a second approval click run a
    // full turn with an empty confirm_calls → silent stall), and a failed tool
    // must never be recorded as SUCCEEDED (audit 2026-10-16).
    if (Array.isArray(result.needsConfirmation) && result.needsConfirmation.length) {
      exec.status = "AWAITING_APPROVAL";
      exec.pending_calls = result.needsConfirmation;
      exec.pending_messages = result.messages;
      exec.approval_expires_at = new Date(now() + wf.approval_policy.ttl_minutes * 60_000).toISOString();
      exec.error_summary = `menunggu persetujuan owner untuk ${result.needsConfirmation.map((c) => c.name).join(", ")}`;
    } else if (!result.text.trim()) {
      exec.status = "FAILED";
      exec.error_summary = "agent tidak mengembalikan hasil setelah disetujui";
      exec.finished_at = new Date(now()).toISOString();
    } else if (outcome.toolError) {
      exec.status = "PARTIALLY_COMPLETED";
      exec.error_summary = "sebagian tool gagal setelah persetujuan";
      exec.finished_at = new Date(now()).toISOString();
    } else {
      exec.status = "SUCCEEDED";
      exec.finished_at = new Date(now()).toISOString();
    }
  } catch (e) {
    exec.status = "FAILED";
    exec.error_summary = e instanceof Error ? e.message : String(e);
    exec.finished_at = new Date(now()).toISOString();
  }
  if (exec.status !== "AWAITING_APPROVAL") {
    exec.pending_calls = undefined;
    exec.pending_messages = undefined;
    exec.evidence_reference = evidenceRef(String(rawUser), exec, now());
    // Same reason as the run path: a whole-object save resurrects a deleted
    // workflow and reverts the owner's pause (audit 2026-10-16).
    updateWorkflowProgress(rawUser, wf.workflow_id, {
      last_run_at: exec.finished_at,
      last_run_status: exec.status,
      consecutive_failures: exec.status === "FAILED" ? wf.consecutive_failures + 1 : 0,
    });
  }
  saveExecution(rawUser, exec);
  auditLog(rawUser, "workflow_approval", `${wf.name} disetujui oleh ${decidedBy}`);
  exec.notified = await notifyWorkflow(wf, exec, opts);
  if (exec.notified) saveExecution(rawUser, exec);
  return exec;
}