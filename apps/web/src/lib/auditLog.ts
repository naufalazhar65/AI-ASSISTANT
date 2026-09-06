// Durable per-action audit trail (Fase 5, lightweight). Every tool call and
// selected lifecycle event is appended as one JSON line to a per-day file at
// `.data/audit/AUDIT-YYYY-MM-DD.log` (keep last `AUDIT_KEEP_DAYS`, default 7).
//
// Deliberately best-effort and non-blocking: audit() never throws, never waits,
// and can never break the turn (wrapped in try/catch + guarded file appends).
// This is an append-only trail for the owner's personal review — NOT a
// queryable service. Env: AUDIT_ENABLED=1|0 (default 1), AUDIT_KEEP_DAYS (7).

import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { appRoot, sanitizeUser } from "./users";

const AUDIT_DIR = () => join(appRoot(), ".data", "audit");

let lastPruneDay = "";

export function auditEnabled(): boolean {
  return process.env.AUDIT_ENABLED !== "0";
}

function day(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Idempotent daily prune: remove audit files older than `keepDays`. */
function prune(now: Date, keepDays: number): void {
  const d = day(now);
  if (lastPruneDay === d) return;
  lastPruneDay = d;
  const dir = AUDIT_DIR();
  if (!existsSync(dir)) return;
  const cutoff = now.getTime() - keepDays * 24 * 60 * 60 * 1000;
  try {
    for (const f of readdirSync(dir)) {
      if (!/^AUDIT-\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue;
      const m = f.match(/^AUDIT-(\d{4}-\d{2}-\d{2})\.log$/);
      if (m && Date.parse(m[1]) < cutoff) {
        try { unlinkSync(join(dir, f)); } catch { /* in use, retry next day */ }
      }
    }
  } catch { /* best-effort */ }
}

/** Append one audit line (who, when, action, detail). Never throws. */
export function auditLog(user: unknown, action: string, detail?: string): void {
  try {
    if (!auditEnabled()) return;
    const now = new Date();
    const keepDays = Number(process.env.AUDIT_KEEP_DAYS ?? "7") || 7;
    prune(now, keepDays);
    const file = join(AUDIT_DIR(), `AUDIT-${day(now)}.log`);
    mkdirSync(AUDIT_DIR(), { recursive: true });
    const line =
      JSON.stringify({
        ts: now.toISOString(),
        user: sanitizeUser(user) ?? String(user ?? "anonymous").slice(0, 40),
        action,
        detail: detail === undefined ? undefined : String(detail).slice(0, 500),
      }) + "\n";
    appendFileSync(file, line, "utf8");
  } catch { /* never break the turn over auditing */ }
}