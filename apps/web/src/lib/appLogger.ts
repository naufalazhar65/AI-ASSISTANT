// Durable operational log (Fase 5 — "logging & error handling"). Mirrors the
// console AND appends one JSON line per event to a per-day file at
// `.data/logs/APP-YYYY-MM-DD.log` (`APP_LOG_KEEP_DAYS`, default 14). This is the
// lifecycle/operations log (server start/stop, bots, heartbeat, recap,
// webhook); the per-action audit trail lives in auditLog.ts.
//
// Best-effort: never throws, never blocks. In dev these lines still reach
// stdout so /tmp/mia-dev.log keeps working.

import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { appRoot } from "./users";
import { appLogEnabled, appLogKeepDays } from "./config";

const LOG_DIR = () => join(appRoot(), ".data", "logs");

let lastPruneDay = "";

function day(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function prune(now: Date, keepDays: number): void {
  const d = day(now);
  if (lastPruneDay === d) return;
  lastPruneDay = d;
  const dir = LOG_DIR();
  if (!existsSync(dir)) return;
  const cutoff = now.getTime() - keepDays * 24 * 60 * 60 * 1000;
  try {
    for (const f of readdirSync(dir)) {
      if (!/^APP-\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue;
      const m = f.match(/^APP-(\d{4}-\d{2}-\d{2})\.log$/);
      if (m && Date.parse(m[1]) < cutoff) {
        try { unlinkSync(join(dir, f)); } catch { /* in use, retry next day */ }
      }
    }
  } catch { /* best-effort */ }
}

function write(level: "info" | "error", kind: string, message: string): void {
  try {
    if (!appLogEnabled()) return;
    const now = new Date();
    prune(now, appLogKeepDays());
    const file = join(LOG_DIR(), `APP-${day(now)}.log`);
    mkdirSync(LOG_DIR(), { recursive: true });
    const line =
      JSON.stringify({ ts: now.toISOString(), level, kind, message: String(message).slice(0, 2000) }) + "\n";
    appendFileSync(file, line, "utf8");
    console[level](`[${kind}] ${message}`);
  } catch { /* never break runtime over logging */ }
}

/** Info-level operational event (system start, bot started, recap pushed…). */
export function logInfo(kind: string, message: string): void {
  write("info", kind, message);
}

/** Error-level operational event (service failed to start, tick crashed…). */
export function logError(kind: string, message: string): void {
  write("error", kind, message);
}