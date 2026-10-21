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
  "naufalazhar65.agnes",
  "naufalazhar65.michelle",
  "naufal.agnes",
  "naufal.michelle",
  "Zigen.agnes",
  "Zigen.michelle",
  "U0C7RQL8KU4.agnes",
  "U0C7RQL8KU4.michelle",
]);

/**
 * Prefixes that mark a synthetic user (drills, probes, eval, workflow tests).
 *
 * DELETION is the irreversible half of this list, so it names whole ARTIFACT
 * FAMILIES rather than generic stems: "eval_" also matches a real account
 * called "eval_team", and a cleanup that deletes a person is worse than one
 * that leaves an artifact behind. The families below are the ones this repo
 * actually creates.
 *
 * The other half — skipping a test user's reminders — stays deliberately
 * broad in users.ts (isTestUserKey), where a false positive only means one
 * notification too many, never a lost folder.
 */
export const TEST_USER_PREFIXES: readonly string[] = [
  "verify_wf_",
  "verify_eval_recovery_",
  "verify_psattest_",
  "probe_role_gate_",
  "probe_wfrun2_",
  "wf_test_",
  "wf_life_",
  "wf_dbg",
  "wfprobe_",
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
 * Generic stems: "verify", "probe", "eval", "drill". A folder whose name
 * starts with one of them is an artifact only when the rest of the name
 * looks machine-made: it carries a digit ("verify_wf_guard_9",
 * "verify_retry_a5_1792218984837") or is a one/two-letter suffix ("verify_y").
 * A plain word after the stem ("eval_team", "verification_user") reads like a
 * person, so it is kept unless it is listed by name.
 */
export const TEST_USER_STEMS: readonly string[] = ["verify", "probe", "eval", "drill"];

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
  // The bare stems of the prefixes above, as EXACT names only. A folder
  // called "eval" is an artifact; a folder called "eval_team" is a person.
  "verify",
  "probe",
  "eval",
  "drill",
  // One-off artifact folders this repo created over time. Each is named
  // explicitly — a cleanup that guesses is a cleanup that can delete a person.
  "eval_evidence",
  "eval_probe",
  "eval_user",
  "probe_otheruser",
  "probe_repro403",
  "verify_agentrole",
  "verify_delegation",
  "verify_places",
  "verify_register",
  "verify_role",
  "verify_team_line",
  "drill_agnes.agnes",
  "drill_mia",
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
  if (TEST_USER_PREFIXES.some((prefix) => lower.startsWith(prefix.toLowerCase()))) return true;
  // A generic stem only counts when the remainder looks machine-made.
  for (const stem of TEST_USER_STEMS) {
    if (!lower.startsWith(`${stem}_`)) continue;
    const rest = lower.slice(stem.length + 1);
    if (!rest) continue;
    if (/[0-9_]/.test(rest)) return true;
    if (rest.length <= 2) return true; // "verify_y", "probe_x"
  }
  return false;
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
