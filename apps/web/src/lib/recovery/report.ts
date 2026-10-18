// Progress + final reporting for the problem-solving loop.
// Every number is counted from stored session records; nothing is inferred
// from prose. A session that ended "succeeded" without COMPLETE criteria is
// reported as a false success, not smoothed over.

import type { PsAttempt, PsSession } from "./types";

export interface LoopMetrics {
  sessions: number;
  succeeded: number;
  stopped: number;
  unknown: number;
  /** Sessions that recorded at least one recovery attempt. */
  recovered: number;
  /** Of those, how many ended succeeded. */
  recoverySuccessRate: number | null;
  attemptsTotal: number;
  /** attempts / task, mean. */
  attemptsPerTask: number | null;
  /** Sessions with >=2 identical attempt fingerprints. */
  repeatedFailureSessions: number;
  repeatedFailureRate: number | null;
  /** Sessions where an identical fingerprint reached the loop threshold. */
  loopDetectedSessions: number;
  loopDetectionRate: number | null;
  /** Succeeded sessions whose criteria verdict was not COMPLETE. */
  falseSuccessSessions: number;
  falseSuccessRate: number | null;
  /** Stopped sessions that carry a documented stop reason within budget. */
  correctStopSessions: number;
  correctStopRate: number | null;
}

const rate = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

function repeats(attempts: PsAttempt[], threshold: number): { repeated: boolean; looped: boolean } {
  const counts = new Map<string, number>();
  for (const a of attempts) counts.set(a.fingerprint, (counts.get(a.fingerprint) ?? 0) + 1);
  const max = Math.max(0, ...counts.values());
  return { repeated: max >= 2, looped: max >= threshold };
}

export function computeLoopMetrics(sessions: PsSession[]): LoopMetrics {
  const attempted = sessions.filter((s) => s.attempts.length > 0);
  const succeeded = sessions.filter((s) => s.status === "succeeded");
  const stopped = sessions.filter((s) => s.status === "stopped");
  const unknown = sessions.filter((s) => s.status === "unknown");
  const recoveredSessions = sessions.filter((s) => s.attempts.some((a) => !!a.recovery));
  const recoveredSucceeded = recoveredSessions.filter((s) => s.status === "succeeded").length;
  const attemptsTotal = sessions.reduce((n, s) => n + s.attempts.length, 0);
  let repeated = 0;
  let looped = 0;
  for (const s of attempted) {
    const r = repeats(s.attempts, s.budget.maxIdenticalRepeat);
    if (r.repeated) repeated += 1;
    if (r.looped) looped += 1;
  }
  const falseSuccess = succeeded.filter((s) => s.criteria_outcome !== "COMPLETE").length;
  const correctStop = stopped.filter(
    (s) => !!s.stop_reason?.trim() && s.attempts.length <= s.budget.maxAttempts,
  ).length;
  return {
    sessions: sessions.length,
    succeeded: succeeded.length,
    stopped: stopped.length,
    unknown: unknown.length,
    recovered: recoveredSessions.length,
    recoverySuccessRate: rate(recoveredSucceeded, recoveredSessions.length),
    attemptsTotal,
    attemptsPerTask: attempted.length ? Math.round((attemptsTotal / attempted.length) * 10) / 10 : null,
    repeatedFailureSessions: repeated,
    repeatedFailureRate: rate(repeated, attempted.length),
    loopDetectedSessions: looped,
    loopDetectionRate: rate(looped, attempted.length),
    falseSuccessSessions: falseSuccess,
    falseSuccessRate: rate(falseSuccess, succeeded.length),
    correctStopSessions: correctStop,
    correctStopRate: rate(correctStop, stopped.length),
  };
}

const FAILURE_CLASS_LABEL: Record<string, string> = {
  TRANSIENT: "sementara",
  INPUT_ERROR: "input",
  IMPLEMENTATION_ERROR: "implementasi",
  DEPENDENCY_ERROR: "dependensi",
  ENVIRONMENT_ERROR: "lingkungan",
  VERIFICATION_FAILURE: "verifikasi",
  AUTHORIZATION_BLOCKED: "otorisasi",
  APPROVAL_REQUIRED: "persetujuan",
  MISSING_INFORMATION: "info kurang",
  EXTERNAL_FAILURE: "layanan luar",
  UNKNOWN: "tak terklasifikasi",
};

const clip = (s: string, n = 70) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function renderPsReport(session: PsSession): string {
  const lines: string[] = [];
  lines.push(`**Problem-solving loop — ${session.task_id}**`);
  lines.push(`Tujuan: ${session.objective}`);
  lines.push(
    `Fase akhir: ${session.phase} · status: ${session.status} · percobaan: ${session.attempts.length}/${session.budget.maxAttempts}`,
  );
  if (session.criteria.length) {
    lines.push("");
    lines.push("**Kriteria penerimaan**");
    for (const c of session.criteria) {
      lines.push(`- ${c.id} — ${c.description}`);
    }
    if (session.criteria_outcome) lines.push(`Vonis kriteria: ${session.criteria_outcome}`);
  }
  if (session.attempts.length) {
    lines.push("");
    lines.push("**Percobaan**");
    lines.push("| # | fase | aksi | gagal sebagai | pemulihan | alasan |");
    lines.push("|---|---|---|---|---|---|");
    for (const a of session.attempts) {
      lines.push(
        `| ${a.n} | ${a.phase} | ${clip(a.action)} | ${a.failure ? FAILURE_CLASS_LABEL[a.failure] ?? a.failure : "-"} | ${a.recovery ?? "-"} | ${clip(a.recovery_reason ?? a.error ?? "-", 60)} |`,
      );
    }
  }
  if (session.stop_reason) {
    lines.push("");
    lines.push(`**Berhenti karena:** ${session.stop_reason}`);
  }
  return lines.join("\n");
}

export function renderMetricsLine(m: LoopMetrics): string {
  const pct = (v: number | null) => (v === null ? "tidak diukur" : `${v}%`);
  return [
    `sesi ${m.sessions}`,
    `sukses ${m.succeeded}`,
    `stop ${m.stopped}`,
    `unknown ${m.unknown}`,
    `recovery sukses ${pct(m.recoverySuccessRate)}`,
    `percobaan/tugas ${m.attemptsPerTask ?? "-"}`,
    `gagal berulang ${pct(m.repeatedFailureRate)}`,
    `loop terdeteksi ${pct(m.loopDetectionRate)}`,
    `sukses palsu ${pct(m.falseSuccessRate)}`,
    `berhenti tepat ${pct(m.correctStopRate)}`,
  ].join(" · ");
}