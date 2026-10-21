// testUserCleanup.ts — what may be deleted from the per-user store.
//
// The store (apps/web/.data/users/<key>/) accumulated ~540 throwaway user
// folders from drills, probes and eval runs. They are cheap in disk terms but
// they are NOT free: every leftover user is a candidate for the periodic
// runners (reminders, heartbeat, weekly insight), so one of them can push a
// notification to the owner for a task that only ever existed in a test.
//
// Two rules make the cleanup safe:
//   1. a folder is disposable only when its key LOOKS like a test artifact —
//      never because it is unknown;
//   2. the owner's own keys (and every alias of them) are never disposable,
//      whatever else matches.
//
// Expiry is age-based: a disposable folder is removed only when it has not
// been touched for the TTL. A folder that is still in use stays.

// Keys that must survive every cleanup, whatever else they look like.
// The owner plus every alias of him, plus the shared bucket, plus the agent
// suffix variants (.agnes / .michelle) of all of them.
export const PROTECTED_USER_KEYS: ReadonlySet<string> = new Set([
  "naufalazhar652952",
  "naufalazhar65",
  "naufal",
  "Zigen",
  "shared",
  "U0C7RQL8KU4",
  "naufalazhar652952.agnes",
  "naufalazhar652952.michelle",
  "naufal.agnes",
  "naufal.michelle",
  "U0C7RQL8KU4.agnes",
  "U0C7RQL8KU4.michelle",
]);

/** Prefixes that mark a synthetic user (drills, probes, eval, workflow tests). */
export const TEST_USER_PREFIXES: readonly string[] = [
  "verify_",
  "verify",
  "probe_",
  "probe",
  "eval_",
  "eval",
  "drill_",
  "drill",
  "wf_test_",
  "wf_life_",
  "wf_dbg",
  "wfprobe_",
  "probe_wfrun2_",
  "monitorprobe",
  "naufalprobe",
  "recapprobe",
  "remprobe",
  "http_probe_",
  "defuse_probe",
  "cont_repro",
  "empty_turn",
  "confirm_dedup",
  "toolrounds_",
  "greet_probe",
  "mock_roll_probe",
  "owner_roll_probe",
];

/**
 * Exact names that are test artifacts even though they carry no prefix. They
 * are listed one by one on purpose: a prefix like `audit` would also match a
 * real person called "auditor", and the runners would then skip that
 * person's reminders. A wrong guess here is a silent notification loss, so the
 * list is explicit rather than clever.
 */
export const TEST_USER_NAMES: ReadonlySet<string> = new Set([
  "test",
  "bob",
  "tztest",
  "wtheme",
  "owner_smoke",
  "dbg",
  "t",
  "u",
  "v",
  "t_summary",
  "u_dbg7",
  "office_ui",
  "audit23",
  "audit_brain_values",
  "audit_pi_sess",
  "busproof3",
]);

/**
 * True when the folder may be removed by the cleanup script.
 *
 * The order matters: protection first, so no future prefix can ever widen
 * the blast radius past the owner's own data.
 */
export function isDisposableTestUser(key: string): boolean {
  if (PROTECTED_USER_KEYS.has(key)) return false;
  if (key === "shared") return false;
  if (TEST_USER_NAMES.has(key)) return true;
  const lower = key.toLowerCase();
  return TEST_USER_PREFIXES.some((prefix) => lower.startsWith(prefix.toLowerCase()));
}

export interface UserDirInfo {
  key: string;
  /** Last modification time in epoch ms. */
  mtimeMs: number;
}

export interface ExpiryPlan {
  /** Disposable AND untouched for longer than the TTL. */
  expired: string[];
  /** Disposable but still inside the TTL. */
  fresh: string[];
  /** Not disposable — kept, always. */
  kept: string[];
}

/**
 * Decide what expires. `now` and `ttlMs` are injected so the plan is testable
 * without touching the clock.
 */
export function planExpiry(
  dirs: UserDirInfo[],
  opts: { now: number; ttlMs: number },
): ExpiryPlan {
  const expired: string[] = [];
  const fresh: string[] = [];
  const kept: string[] = [];
  for (const dir of dirs) {
    if (!isDisposableTestUser(dir.key)) {
      kept.push(dir.key);
      continue;
    }
    if (opts.now - dir.mtimeMs >= opts.ttlMs) expired.push(dir.key);
    else fresh.push(dir.key);
  }
  return { expired, fresh, kept };
}

/** Default TTL: a week of untouched test data is dead weight. */
export const DEFAULT_TEST_USER_TTL_DAYS = 7;
