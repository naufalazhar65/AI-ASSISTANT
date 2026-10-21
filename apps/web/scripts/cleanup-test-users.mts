/**
 * Cleanup of throwaway per-user folders in apps/web/.data/users.
 *
 *   npx tsx apps/web/scripts/cleanup-test-users.mts            # dry run (default)
 *   npx tsx apps/web/scripts/cleanup-test-users.mts --apply    # actually delete
 *   npx tsx apps/web/scripts/cleanup-test-users.mts --apply --ttl-days 3
 *
 * Safety: only folders whose key looks like a test artifact are touched, and
 * the owner's own keys are protected explicitly (see lib/testUserCleanup.ts).
 * A dry run is the default, so the script is safe to run anywhere.
 *
 * The rules live in src/lib/testUserSweep.ts — the same module the daily
 * server-side sweep uses — so the script and the server can never disagree
 * about what gets deleted.
 */
import { join } from "node:path";
import { sweepExpiredTestUsers } from "../src/lib/testUserSweep";
import { DEFAULT_TEST_USER_TTL_DAYS } from "../src/lib/testUserCleanup";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const USERS_DIR = join(ROOT, "apps", "web", ".data", "users");

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const apply = process.argv.includes("--apply");
  const ttlDays = Number(argValue("--ttl-days") ?? DEFAULT_TEST_USER_TTL_DAYS);
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) {
    console.error(`--ttl-days harus angka positif (default ${DEFAULT_TEST_USER_TTL_DAYS})`);
    process.exit(2);
  }

  const result = sweepExpiredTestUsers({
    root: USERS_DIR,
    ttlMs: ttlDays * 24 * 60 * 60 * 1000,
    apply,
  });

  for (const key of result.removed) console.log(`dihapus  ${key}`);
  for (const key of result.expired) {
    if (!result.removed.includes(key)) console.log(`akan dihapus  ${key}`);
  }

  console.log(
    `\n${result.expired.length} kedaluwarsa, ${result.fresh.length} masih dalam masa simpan, ` +
      `${result.kept.length} dipertahankan.${apply ? "" : " (dry run — pakai --apply untuk menghapus)"}`,
  );
}

main();
