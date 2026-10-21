// testUserSweep.test.ts — the sweep that removes expired throwaway folders.
//
// The rules are the risky part (a wrong delete is silent data loss), so the
// tests cover both directions: what MUST be swept, and what MUST survive.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepExpiredTestUsers } from "./testUserSweep";

const DAY = 24 * 60 * 60 * 1000;

function makeStore(keys: string[], ageDays: number): string {
  const root = mkdtempSync(join(tmpdir(), "mia-sweep-"));
  const old = Date.now() / 1000 - ageDays * 24 * 3600;
  for (const key of keys) {
    const dir = join(root, key);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "notes.json"), "[]");
    utimesSync(dir, old, old);
  }
  return root;
}

describe("sweepExpiredTestUsers", () => {
  it("removes an expired test folder and keeps the owner", () => {
    const root = makeStore(["verify_x", "naufalazhar652952"], 30);
    const result = sweepExpiredTestUsers({ root, now: Date.now(), ttlMs: 7 * DAY, apply: true });
    expect(result.removed).toEqual(["verify_x"]);
    expect(result.kept).toContain("naufalazhar652952");
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps a test folder that is still inside the TTL", () => {
    const root = makeStore(["verify_y"], 1);
    const result = sweepExpiredTestUsers({ root, now: Date.now(), ttlMs: 7 * DAY, apply: true });
    expect(result.removed).toEqual([]);
    expect(result.fresh).toContain("verify_y");
    rmSync(root, { recursive: true, force: true });
  });

  it("dry run never deletes anything", () => {
    const root = makeStore(["verify_z"], 30);
    const result = sweepExpiredTestUsers({ root, now: Date.now(), ttlMs: 7 * DAY });
    expect(result.expired).toContain("verify_z");
    expect(result.removed).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("never touches the owner's keys, the shared bucket or agent variants", () => {
    const root = makeStore(
      ["naufalazhar652952", "naufalazhar65", "Zigen", "shared", "naufalazhar652952.agnes", "naufalazhar652952.michelle"],
      400,
    );
    const result = sweepExpiredTestUsers({ root, now: Date.now(), ttlMs: 7 * DAY, apply: true });
    expect(result.removed).toEqual([]);
    expect(result.kept).toHaveLength(6);
    rmSync(root, { recursive: true, force: true });
  });
});
