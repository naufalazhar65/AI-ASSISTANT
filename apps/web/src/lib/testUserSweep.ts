// Removes expired throwaway per-user folders from the per-user store.
//
// The store (apps/web/.data/users/<key>/) fills up with folders from drills,
// probes and eval runs. A leftover folder is not harmless: every periodic
// runner (reminders, heartbeat, weekly insight) walks the store, so a stale
// test user can still push its own notification to the owner.
//
// This module is the ONE owner of that sweep. It answers two questions for
// every folder: may it go (only when the key looks like a test artifact —
// see ./testUserCleanup) and has it expired (untouched for longer than the
// TTL). The CLI wrapper (scripts/cleanup-test-users.mts) and the daily
// heartbeat pass both call it, so the script and the server can never disagree
// about what gets deleted.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appRoot, userDataRoot } from "./users";
import { DEFAULT_TEST_USER_TTL_DAYS, planExpiry } from "./testUserCleanup";
import { wibDay } from "./time";
import { logError, logInfo } from "./appLogger";

export interface SweepResult {
  /** Disposable AND untouched for longer than the TTL. */
  expired: string[];
  /** Disposable but still inside the TTL. */
  fresh: string[];
  /** Not disposable — kept, always. */
  kept: string[];
  /** Folders actually deleted (empty in a dry run). */
  removed: string[];
}

export interface SweepOptions {
  /** Root of the per-user store. Defaults to the real one. */
  root?: string;
  /** Epoch ms used as "now". Injected so the sweep is testable. */
  now?: number;
  /** Age after which a disposable folder expires. */
  ttlMs?: number;
  /** Dry run by default: nothing is deleted unless this is true. */
  apply?: boolean;
}

/**
 * Plan (and optionally perform) the expiry of throwaway user folders.
 *
 * Safe by construction: a folder is removed only when its key is disposable
 * AND it has not been touched for the TTL. The owner's own keys never match
 * the disposable list, so they can never be swept.
 */
export function sweepExpiredTestUsers(opts: SweepOptions = {}): SweepResult {
  const root = opts.root ?? userDataRoot();
  const ttlMs = opts.ttlMs ?? DEFAULT_TEST_USER_TTL_DAYS * 24 * 60 * 60 * 1000;
  const now = opts.now ?? Date.now();
  const apply = opts.apply === true;

  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    // No store on this machine — nothing to sweep.
    return { expired: [], fresh: [], kept: [], removed: [] };
  }

  const dirs: { key: string; mtimeMs: number }[] = [];
  for (const key of names) {
    try {
      const st = statSync(join(root, key));
      if (st.isDirectory()) dirs.push({ key, mtimeMs: st.mtimeMs });
    } catch {
      /* folder vanished mid-scan */
    }
  }

  const plan = planExpiry(dirs, { now, ttlMs });
  const removed: string[] = [];
  if (apply) {
    for (const key of plan.expired) {
      try {
        rmSync(join(root, key), { recursive: true, force: true });
        removed.push(key);
      } catch (e) {
        logError("test-user-sweep", `failed to remove ${key}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return { expired: plan.expired, fresh: plan.fresh, kept: plan.kept, removed };
}

function markerPath(): string {
  return join(appRoot(), ".data", "test-user-sweep.json");
}

/**
 * Sweep once per day, from the heartbeat tick.
 *
 * The marker file is the guard: the heartbeat runs every few minutes, and a
 * store sweep does not need to happen more than once a day. A failed sweep
 * writes no marker, so the next tick tries again.
 */
export function runDailyTestUserSweep(opts: { now?: number; ttlMs?: number } = {}): { skipped: boolean; removed: string[] } {
  const now = opts.now ?? Date.now();
  const today = wibDay(new Date(now));
  let lastRun = "";
  try {
    const raw = readFileSync(markerPath(), "utf8");
    lastRun = String((JSON.parse(raw) as { lastRunDate?: string }).lastRunDate || "");
  } catch {
    /* no marker yet — first run */
  }
  if (lastRun === today) return { skipped: true, removed: [] };

  const result = sweepExpiredTestUsers({ ...opts, now, apply: true });
  try {
    mkdirSync(join(appRoot(), ".data"), { recursive: true });
    const tmp = `${markerPath()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ lastRunDate: today, removed: result.removed.length }));
    renameSync(tmp, markerPath());
  } catch (e) {
    logError("test-user-sweep", `failed to write marker: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (result.removed.length) logInfo("test-user-sweep", `removed ${result.removed.length} expired test user folder(s)`);
  return { skipped: false, removed: result.removed };
}
