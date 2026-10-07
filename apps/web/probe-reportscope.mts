// Live 2026-10-07 18:57 (Michelle, cozy-kangaroo lab): the reply quoted a
// report that genuinely existed on disk, but the filename was stripped from the
// answer. Root cause: the file-existence check used the RAW agent-suffixed user
// key while every report WRITER resolves owner-scoped, so for `.michelle` /
// `.agnes` the check pointed at a folder that is never created.
//
// The check must therefore agree with the writers. Proves that invariant against
// the REAL reports folder on disk rather than a hand-made fixture, and it picks
// whatever report is currently newest instead of pinning one incident's filename
// (which would rot away as reports rotate).
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { userDataRoot } from "./src/lib/users";
import { resolveOwnerScopedKey } from "./src/lib/identity";

// Every agent suffix that can append itself to the owner key.
const KEYS = ["naufalazhar652952.michelle", "naufalazhar652952.agnes"];

let failures = 0;
const fail = (msg: string) => {
  console.log(`✗ ${msg}`);
  failures++;
};

const scoped = resolveOwnerScopedKey(KEYS[0]);
if (!scoped) {
  console.log("UNEXPECTED: agent-suffixed key did not resolve to an owner key");
  process.exit(2);
}

const ownerReports = join(userDataRoot(), scoped, "reports");
const reports = existsSync(ownerReports)
  ? readdirSync(ownerReports).filter((f) => f.startsWith("report-") && f.endsWith(".md")).sort()
  : [];
if (!reports.length) {
  console.log("FIXTURE MISSING: no report .md in the owner reports folder — cannot prove the fix");
  process.exit(2);
}
const file = reports[reports.length - 1];
console.log(`probing with newest real report: ${file}`);

for (const raw of KEYS) {
  const rawPath = join(userDataRoot(), raw, "reports", file);
  const scopedPath = join(userDataRoot(), resolveOwnerScopedKey(raw) ?? scoped, "reports", file);
  const rawHit = existsSync(rawPath);
  const scopedHit = existsSync(scopedPath);
  console.log(`${raw}\n  raw    -> ${rawHit}\n  scoped -> ${scopedHit}`);

  // The premise of the whole bug: the raw key must be DEAD, otherwise this
  // probe is proving nothing.
  if (rawHit) fail(`${raw}: raw key resolves — bug premise no longer holds, revisit the probe`);
  // The fix: the existence check must see the file the writer produced.
  if (!scopedHit) fail(`${raw}: owner-scoped path cannot see the file — the bug is NOT fixed`);
}

if (failures) {
  console.log(`\nRESULT: FAIL — ${failures} check(s)`);
  process.exit(1);
}
console.log("\nRESULT: PASS — report existence checks agree with the owner-scoped writers");
