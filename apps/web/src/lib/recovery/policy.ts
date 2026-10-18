// Recovery policy: one decision function decides what happens after a failure.
// Rules, in order: budget stops -> non-retryable classes -> loop detection ->
// class-specific action. A retry always carries a documented reason; an
// identical repeat without one stops the loop instead of burning budget.

import { isNonRetryable } from "./classify";
import type {
  FailureClass,
  PsAttempt,
  RecoveryAction,
  RecoveryBudget,
  RecoveryDecision,
} from "./types";

/** Stable stringify so approval binding compares op+params, not key order. */
export function stableArgs(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return `[${value.map(stableArgs).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${stableArgs(v)}`);
  return `{${entries.join(",")}}`;
}

/** Approval is bound to the exact op + params it was granted for. */
export function approvalFingerprint(tool: string, args: unknown): string {
  return `${tool}#${stableArgs(args)}`;
}

export function detectLoop(attempts: PsAttempt[], maxIdentical: number): PsAttempt | null {
  if (attempts.length === 0) return null;
  const last = attempts[attempts.length - 1]!;
  const same = attempts.filter((a) => a.fingerprint === last.fingerprint);
  return same.length >= maxIdentical ? last : null;
}

export interface RecoveryContext {
  failure: FailureClass;
  /** Attempts already recorded for this task, oldest first. */
  attempts: PsAttempt[];
  budget: RecoveryBudget;
  recoverySubtasks?: number;
  delegationDepth?: number;
  toolCalls?: number;
  elapsedMs?: number;
  /** Agents that could take this work (registered AND available). */
  delegateCandidates?: string[];
  /** Fingerprint of the attempt being decided. */
  fingerprint: string;
  /** Caller-supplied recovery plan. Without it an identical repeat is refused. */
  recoveryReason?: string;
  /** Criteria state: met/total. Any unmet criterion keeps recovery legal. */
  criteriaMet?: number;
  criteriaTotal?: number;
  confidence?: "confirmed" | "hypothesis";
}

const stop = (
  failure: FailureClass,
  reason: string,
  extra: Partial<RecoveryDecision> = {},
): RecoveryDecision => ({
  action: "stop",
  failure,
  reason,
  loop: false,
  waitMs: 0,
  changedApproach: false,
  ...extra,
});

export function decideRecovery(ctx: RecoveryContext): RecoveryDecision {
  const b = ctx.budget;
  const attempts = ctx.attempts ?? [];
  const loopHit = detectLoop(attempts, b.maxIdenticalRepeat);
  const identical = !!loopHit && loopHit.fingerprint === ctx.fingerprint;
  const changed = !identical || !!ctx.recoveryReason;
  const retry = (
    action: RecoveryAction,
    reason: string,
    waitMs = b.backoffMs,
  ): RecoveryDecision => ({
    action,
    failure: ctx.failure,
    reason,
    loop: false,
    waitMs,
    changedApproach: changed,
  });

  // 1. Budget stops — always evaluated first so no class can outrun a budget.
  if ((ctx.toolCalls ?? 0) >= b.maxToolCalls) return stop(ctx.failure, `tool-call budget spent (${b.maxToolCalls})`);
  if ((ctx.recoverySubtasks ?? 0) >= b.maxRecoverySubtasks)
    return stop(ctx.failure, `recovery-subtask budget spent (${b.maxRecoverySubtasks})`);
  if ((ctx.elapsedMs ?? 0) >= b.maxWallClockMs)
    return stop(ctx.failure, `wall-clock budget spent (${Math.round(b.maxWallClockMs / 1000)}s)`);
  if (attempts.length >= b.maxAttempts)
    return stop(ctx.failure, `attempt budget spent (${b.maxAttempts})`, { loop: identical });

  // 2. Classes that repeating cannot fix.
  if (isNonRetryable(ctx.failure)) {
    const action: RecoveryAction = ctx.failure === "INPUT_ERROR" ? "stop" : "escalate";
    return {
      action,
      failure: ctx.failure,
      reason:
        ctx.failure === "APPROVAL_REQUIRED"
          ? "menunggu persetujuan owner; tidak diulang otomatis"
          : ctx.failure === "AUTHORIZATION_BLOCKED"
            ? "di luar scope/role; escalate ke owner"
            : ctx.failure === "MISSING_INFORMATION"
              ? "butuh info dari owner sebelum lanjut"
              : "input ditolak; ulangi dengan input berbeda akan menghasilkan error yang sama",
      loop: false,
      waitMs: 0,
      changedApproach: false,
    };
  }

  // 3. Loop detection: 3 identical attempts with no documented reason = stop.
  if (identical && !ctx.recoveryReason) {
    return stop(ctx.failure, `loop terdeteksi: ${b.maxIdenticalRepeat}x aksi identik tanpa alasan recovery`, {
      loop: true,
    });
  }

  // 4. Same-class saturation. A documented recovery reason buys one more pass:
  //    the reason IS the required justification for repeating the class.
  const sameClass = attempts.filter((a) => a.failure === ctx.failure).length;
  if (sameClass >= b.maxSameClassAttempts && !ctx.recoveryReason) {
    return stop(ctx.failure, `kelas kegagalan ${ctx.failure} sudah ${sameClass}x`, { loop: identical });
  }

  switch (ctx.failure) {
    case "VERIFICATION_FAILURE":
      // Criteria unmet + clear cause => a relevant fix may continue.
      return retry("retry", `kriteria belum terpenuhi (${ctx.criteriaMet ?? 0}/${ctx.criteriaTotal ?? 0}); perbaiki penyebab yang jelas`);
    case "TRANSIENT":
      return retry("retry", "kesalahan sementara; ulangi operasi yang sama dengan backoff", b.backoffMs);
    case "EXTERNAL_FAILURE":
      return retry("retry", `layanan luar gagal (${ctx.failure.toLowerCase()}); ulangi terbatas`, b.backoffMs);
    case "ENVIRONMENT_ERROR":
      return retry("replan", "lingkungan menolak operasi; ganti pendekatan (mis. jalur lain) sebelum mengulang");
    case "DEPENDENCY_ERROR": {
      const canDelegate = (ctx.delegateCandidates?.length ?? 0) > 0;
      if (canDelegate && (ctx.delegationDepth ?? 0) < b.maxDelegationDepth)
        return retry("delegate", `ketergantungan hilang; delegasikan ke ${ctx.delegateCandidates!.join(", ")}`);
      return retry("replan", "ketergantungan hilang; siapkan dependensi dulu lalu ulangi");
    }
    case "IMPLEMENTATION_ERROR":
      return retry("replan", "defek implementasi; ubah kode, jangan ulang aksi yang sama");
    default:
      return retry("replan", "klasifikasi tidak pasti; ulangi langkah dengan pendekatan berbeda");
  }
}