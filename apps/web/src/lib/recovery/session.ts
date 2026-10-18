// Persistent loop session: attempts, criteria, budget, approvals, stop reason.
// House convention: hand-rolled atomic write (tmp + rename), like every other
// store in this repo. One JSON file per user, capped.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { userDataRoot } from "../users";
import { canonicalUserKey } from "../identity";
import type { AcceptanceCriterion, PsAttempt, PsPhase, PsSession, RecoveryBudget } from "./types";

const MAX_SESSIONS = 40;
/** A session with no activity for this long is reconciled to `unknown`, not resumed. */
const STALE_MS = 30 * 60 * 1000;

/**
 * Sessions currently executing IN THIS PROCESS. `reconcileSessions` must not
 * touch them: two plans for one user can overlap (web turn + webhook), and
 * flipping a live session to `unknown` mid-flight would be a fabricated crash.
 * globalThis, not a module Set: Next compiles this module into several bundles
 * and a per-bundle Set would be empty in the bundle that reconciles.
 */
const INFLIGHT = (globalThis as { __miaInflightSessions?: Set<string> }).__miaInflightSessions ??=
  new Set<string>();

const inflightKey = (rawUser: string | undefined, id: string): string => `${key(rawUser)}|${id}`;

export function markSessionActive(rawUser: string | undefined, id: string): void {
  INFLIGHT.add(inflightKey(rawUser, id));
}

export function releaseSession(rawUser: string | undefined, id: string): void {
  INFLIGHT.delete(inflightKey(rawUser, id));
}

/** Shared fallback key; canonicalUserKey can refuse a hostile raw user. */
function key(rawUser?: string): string {
  return canonicalUserKey(rawUser) ?? "shared";
}

function file(rawUser?: string): string {
  return join(userDataRoot(), key(rawUser), "recovery-sessions.json");
}

interface Store {
  sessions: PsSession[];
}

function read(rawUser?: string): Store {
  try {
    const f = file(rawUser);
    if (!existsSync(f)) return { sessions: [] };
    const parsed = JSON.parse(readFileSync(f, "utf8")) as Store;
    return { sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [] };
  } catch {
    return { sessions: [] };
  }
}

function write(rawUser: string | undefined, store: Store): void {
  const f = file(rawUser);
  mkdirSync(join(userDataRoot(), key(rawUser)), { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify({ sessions: store.sessions.slice(-MAX_SESSIONS) }, null, 2));
  renameSync(tmp, f);
}

export function readSessions(rawUser?: string): PsSession[] {
  return read(rawUser).sessions;
}

export function getSession(rawUser: string | undefined, id: string): PsSession | null {
  return read(rawUser).sessions.find((s) => s.id === id) ?? null;
}

export function saveSession(rawUser: string | undefined, session: PsSession): void {
  const store = read(rawUser);
  const next = store.sessions.filter((s) => s.id !== session.id);
  next.push({ ...session, updated_at: session.updated_at || Date.now() });
  write(rawUser, { sessions: next });
}

export function newSession(input: {
  plan_id: string;
  user: string;
  task_id: string;
  agent_id: string | null;
  objective: string;
  criteria: AcceptanceCriterion[];
  budget: RecoveryBudget;
  now?: number;
}): PsSession {
  const now = input.now ?? Date.now();
  return {
    id: `ps_${input.task_id}_${now.toString(36)}`,
    plan_id: input.plan_id,
    user: input.user,
    task_id: input.task_id,
    agent_id: input.agent_id,
    objective: input.objective,
    criteria: input.criteria,
    budget: input.budget,
    attempts: [],
    phase: "PLAN",
    status: "active",
    recovery_subtasks: 0,
    tool_calls: 0,
    delegation_depth: 0,
    started_at: now,
    updated_at: now,
  };
}

export function recordAttempt(
  rawUser: string | undefined,
  sessionId: string,
  attempt: PsAttempt,
): PsSession | null {
  const session = getSession(rawUser, sessionId);
  if (!session) return null;
  session.attempts.push(attempt);
  session.phase = attempt.phase;
  if (attempt.recovery === "delegate") session.delegation_depth += 1;
  if (attempt.recovery === "replan") session.recovery_subtasks += 1;
  // The tool-call budget reads this number, so it may only ever be REAL calls.
  session.tool_calls += Math.max(0, attempt.tool_calls ?? 0);
  session.updated_at = attempt.at;
  saveSession(rawUser, session);
  return session;
}

export interface ReconciliationRow {
  id: string;
  task_id: string;
  previous_status: PsSession["status"];
  attempts: number;
  last_phase: PsPhase;
  age_ms: number;
  reason: string;
}

/**
 * Restart reconciliation. Sessions left `active` by a crash get an explicit
 * outcome instead of a silent resume: an external op may already have run, so
 * the loop must not repeat it blindly.
 */
export function reconcileSessions(
  rawUser: string | undefined,
  opts: { now?: number; staleMs?: number } = {},
): ReconciliationRow[] {
  const now = opts.now ?? Date.now();
  const stale = opts.staleMs ?? STALE_MS;
  const store = read(rawUser);
  const rows: ReconciliationRow[] = [];
  const changed: PsSession[] = [];
  for (const s of store.sessions) {
    if (s.status !== "active") {
      changed.push(s);
      continue;
    }
    // Still running in this process: not a crash, so not reconciled.
    if (INFLIGHT.has(inflightKey(rawUser, s.id))) {
      changed.push(s);
      continue;
    }
    const age = now - (s.updated_at || s.started_at);
    const last = s.attempts[s.attempts.length - 1];
    const reason =
      age >= stale
        ? `tidak ada pembaruan ${Math.round(age / 60000)} menit; hasil akhir tidak diketahui`
        : last && last.phase === "EXECUTE"
          ? "berhenti saat eksekusi; hasil eksternal tidak diketahui"
          : "berhenti di antara fase; hasil akhir tidak diketahui";
    s.status = "unknown";
    s.stop_reason = reason;
    s.updated_at = now;
    rows.push({
      id: s.id,
      task_id: s.task_id,
      previous_status: "active",
      attempts: s.attempts.length,
      last_phase: last?.phase ?? s.phase,
      age_ms: age,
      reason,
    });
    changed.push(s);
  }
  if (rows.length) write(rawUser, { sessions: changed });
  return rows;
}