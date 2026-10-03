/**
 * Fired-receipt tests (2026-09-30): a delivered one-shot must leave a trace.
 *
 * Incident: the 20:10 dinner reminder fired, was pruned, and Mia confessed a
 * miss she never made — because after pruning, `reminders_list` showed an
 * empty list. Every test uses a run-unique throwaway user and removes its
 * directory afterwards, so no test data can leak into another run.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  addReminder,
  readFiredReceipts,
  subscribeReminders,
  takeDueReminders,
} from "./reminders";
import { userDataRoot } from "./users";
import { executeTool } from "./tools";

const freshUser = (tag: string): string => `verify_fired_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
let activeUsers: string[] = [];
const track = (u: string): string => {
  activeUsers.push(u);
  return u;
};

afterEach(() => {
  for (const u of activeUsers) {
    try {
      rmSync(join(userDataRoot(), u), { recursive: true, force: true });
    } catch {
      // Cleanup is best-effort; a missing dir is already clean.
    }
  }
  activeUsers = [];
});

describe("fired-receipts — a delivered one-shot leaves a trace", () => {
  it("acked one-shot delivery writes a receipt with text + timestamps", () => {
    const u = track(freshUser("acked"));
    const unsub = subscribeReminders(() => true); // ack: a real target got it
    try {
      addReminder("makan malam", Date.now() - 1000, u);
      const due = takeDueReminders(u);
      expect(due.length).toBe(1);
      const receipts = readFiredReceipts(u);
      expect(receipts.length).toBe(1);
      expect(receipts[0].text).toBe("makan malam");
      expect(typeof receipts[0].at).toBe("number");
      expect(typeof receipts[0].deliveredAt).toBe("number");
      expect(Math.abs(receipts[0].deliveredAt - Date.now())).toBeLessThan(60_000);
    } finally {
      unsub();
    }
  });

  it("unacked (missed) one-shot writes NO receipt — it stays due instead", () => {
    const u = track(freshUser("missed"));
    addReminder("bangun", Date.now() - 1000, u); // zero subscribers
    const due = takeDueReminders(u);
    expect(due.length).toBe(1); // still surfaces, never burned
    expect(readFiredReceipts(u)).toEqual([]);
  });

  it("receipts are newest-first and capped", () => {
    const u = track(freshUser("cap"));
    const unsub = subscribeReminders(() => true);
    try {
      // Explicit per-call clock: Date.now() granularity makes 22 back-to-back
      // deliveries share a millisecond, and ties would make the order a
      // timer artifact instead of newest-first (same class as the old
      // writeup id-prefix flake — never assert order on wall-clock ties).
      const base = Date.now();
      for (let i = 0; i < 22; i += 1) {
        addReminder(`item-${i}`, base - 60_000 - i, u);
        takeDueReminders(u, base + i * 1000);
      }
      const receipts = readFiredReceipts(u);
      expect(receipts.length).toBe(20);
      expect(receipts[0].text).toBe("item-21");
    } finally {
      unsub();
    }
  });

  it("reminders_list surfaces the fired receipt instead of an empty list", async () => {
    const u = track(freshUser("surfaced"));
    const unsub = subscribeReminders(() => true);
    try {
      addReminder("makan malam", Date.now() - 1000, u);
      takeDueReminders(u); // acked → dropped from store, receipt kept
      const out = await executeTool({ id: "t1", name: "reminders_list", arguments: "{}" }, u);
      expect(out).toContain("udah bunyi");
      expect(out).toContain("makan malam");
      expect(out).not.toContain("Belum ada reminder beb");
    } finally {
      unsub();
    }
  });

  it("reminders_list for a clean user is byte-identical to the old empty text", async () => {
    const u = track(freshUser("clean"));
    const out = await executeTool({ id: "t2", name: "reminders_list", arguments: "{}" }, u);
    expect(out).toBe("Belum ada reminder beb — mau aku ingetin apa? 🌸");
  });

  it("fan-out reaches every listener, but only the slot owner's ack consumes", () => {
    const a = track(freshUser("scopeA"));
    const b = track(freshUser("scopeB"));
    const seenA: Array<{ id: string; owner: string }> = [];
    const seenB: Array<{ id: string; owner: string }> = [];
    // Production shape (discord/telegram/stream): decline foreign slots.
    const unsubA = subscribeReminders((r, owner) => {
      seenA.push({ id: r.id, owner });
      if (owner !== a) return false;
      return true;
    });
    const unsubB = subscribeReminders((r, owner) => {
      seenB.push({ id: r.id, owner });
      if (owner !== b) return false;
      return true;
    });
    try {
      addReminder("untuk A", Date.now() - 1000, a);
      takeDueReminders(a);
      // Both listeners were called with A's key (fan-out is shared)...
      expect(seenA.length).toBe(1);
      expect(seenA[0].owner).toBe(a);
      expect(seenB.length).toBe(1);
      expect(seenB[0].owner).toBe(a);
      // ...but only A's ack consumed the slot: receipt written, store clean.
      expect(readFiredReceipts(a).length).toBe(1);
      // B's own store is untouched (nothing delivered there, nothing missed).
      expect(takeDueReminders(b)).toEqual([]);
    } finally {
      unsubA();
      unsubB();
    }
  });
});
