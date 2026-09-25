// Per-user ledger of `poc_verify` runs — the ONLY evidence a finding can cite
// that a payload actually changed something.
//
// Why it exists (live 2026-09-25): a turn probed the owner's lab with `?id=1;-- -`,
// which returned the SAME 292 bytes as the clean `?id=1`, and a HIGH CWE-89
// finding was still filed. `poc_verify` alone could not prevent that, because the
// model is free to ignore its verdict — the verdict only ever reached the model's
// context. This store turns that verdict into a fact the WRITE PATH can check:
// finding_add refuses an injection-class HIGH/CRITICAL finding whose endpoint has
// no differentiating PoC behind it (or whose latest PoC said "payload changed
// nothing").
//
// Store: .data/users/<user>/poc-runs.json (cap 120, atomic write).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";
import { sanitizeHttpUrl } from "./httpHistory";

/**
 * The ledger vocabulary. `no-signal` is the load-bearing one: the control ran and
 * the payload was byte-identical to it, so the claim is REFUTED, not merely unproven.
 */
export type PocLedgerVerdict = "confirmed" | "no-signal" | "reproducible" | "inconclusive";

export type PocRun = {
  url: string;
  method: string;
  baselineUrl?: string;
  verdict: PocLedgerVerdict;
  /** The control really differed (status or body) — i.e. a genuine differential. */
  differs: boolean;
  status: number;
  len: number;
  at: string;
};

const CAP = 120;

function file(userKey: string): string {
  return join(userDataRoot(), userKey, "poc-runs.json");
}

export function readPocRuns(rawUser: unknown): PocRun[] {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return [];
  try {
    const j = JSON.parse(readFileSync(file(userKey), "utf8"));
    return Array.isArray(j) ? (j as PocRun[]).filter((r) => r && typeof r.url === "string") : [];
  } catch {
    return [];
  }
}

export function recordPocRun(rawUser: unknown, run: PocRun): void {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return;
  try {
    const rows = readPocRuns(rawUser);
    rows.push({
      ...run,
      url: sanitizeHttpUrl(run.url),
      baselineUrl: run.baselineUrl ? sanitizeHttpUrl(run.baselineUrl) : undefined,
    });
    while (rows.length > CAP) rows.shift();
    const f = file(userKey);
    mkdirSync(dirname(f), { recursive: true });
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, JSON.stringify(rows, null, 2));
    renameSync(tmp, f);
  } catch {
    /* best-effort: the ledger must never break a turn */
  }
}

/** Render the last runs for the model (used by the refusal message + diagnostics). */
export function pocRunsText(runs: PocRun[], limit = 5): string {
  if (!runs.length) return "(belum ada run poc_verify tercatat)";
  return runs
    .slice()
    .reverse()
    .slice(0, limit)
    .map((r) => `• [${r.verdict}${r.differs ? " · differential" : ""}] ${r.method} ${r.url}${r.baselineUrl ? ` (baseline: ${r.baselineUrl})` : ""} — ${r.at.slice(11, 19)}`)
    .join("\n");
}

// ── Turn-execution side ledger (the confirmation-boundary bridge) ────────────
//
// Live 2026-09-25 15:25: turn-1 ran the compulsory sweep (GET /cek-nik → 200,
// visible ONLY in http-history + recordExecuted's in-memory collector) and
// paused on `report_pdf`. The confirmation continuation (turn-2) starts a fresh
// collector and `pending.messages` never carried the sweep — so every honesty
// guard read ZERO contact and falsely accused "tidak menyentuh /cek-nik sama
// sekali" of a turn whose sweep had hit the endpoint seconds earlier. The
// in-memory collector dies with its turn; the guards need the truth to CROSS
// the confirmation boundary. A tiny per-user side ledger (cap 60, atomic) gives
// the next turn one read-back call. Only REAL executions are recorded — the
// same contract as recordExecuted (refusals never enter).

export type ExecRecord = { name: string; args: string; executed: boolean; at: string };

const EXEC_CAP = 60;

function execFile(userKey: string): string {
  return join(userDataRoot(), userKey, "turn-exec.json");
}

/** Record one real tool execution so the NEXT turn (confirm continuation) can see it. */
export function recordTurnExec(rawUser: unknown, name: string, args: string): void {
  const userKey = sanitizeUser(rawUser);
  if (!userKey || !name) return;
  try {
    const rows = readLedgerForTurn(rawUser);
    rows.push({ name, args: String(args ?? "").slice(0, 800), executed: true, at: new Date().toISOString() });
    while (rows.length > EXEC_CAP) rows.shift();
    const f = execFile(userKey);
    mkdirSync(dirname(f), { recursive: true });
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, JSON.stringify(rows, null, 2));
    renameSync(tmp, f);
  } catch {
    /* best-effort */
  }
}

/** Read the recent execution records (newest last). Never throws. */
export function readLedgerForTurn(rawUser: unknown): ExecRecord[] {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return [];
  try {
    const j = JSON.parse(readFileSync(execFile(userKey), "utf8"));
    if (!Array.isArray(j)) return [];
    return (j as ExecRecord[]).filter((r) => r && typeof r.name === "string");
  } catch {
    return [];
  }
}
