/**
 * Banner-seeding + reminder-chime tests (2026-09-30): a tab opened AFTER a
 * fire must still show what it missed, and a reminder arriving mid-Live-call
 * must sound the owner's chime file (no TTS voice).
 *
 * Incident: the 20:10 dinner reminder fired while the web tab was closed;
 * reopening showed nothing (fired rows are pruned), and Live Mia stayed
 * silent (a Live session cannot be server-interrupted). Every test uses a
 * run-unique throwaway user and removes its directory afterwards.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import {
  appendFiredReceipt,
  formatFiredBanner,
  recentFiredReceipts,
} from "./reminders";
import { userDataRoot } from "./users";
import { GET as streamGET } from "../app/api/reminders/stream/route";
import { playReminderChime } from "./reminderClient";

const freshUser = (tag: string): string =>
  `verify_banner_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

describe("formatFiredBanner — a fired receipt as a truthful banner line", () => {
  it("marks history as history and renders the WIB clock", () => {
    // 2026-09-30T13:10:00Z == 20:10 Asia/Jakarta.
    const line = formatFiredBanner({
      text: "makan malam",
      at: Date.UTC(2026, 8, 30, 13, 10),
      deliveredAt: Date.UTC(2026, 8, 30, 13, 10),
    });
    expect(line.startsWith("Udah bunyi:")).toBe(true);
    expect(line).toContain("makan malam");
    expect(line).toContain("20:10");
  });
});

describe("recentFiredReceipts — seeding window for a fresh tab", () => {
  it("returns oldest-first within the window and drops older ones", () => {
    const u = track(freshUser("window"));
    const now = Date.now();
    appendFiredReceipt(u, { text: "lama", at: now - 48 * 3600_000, deliveredAt: now - 48 * 3600_000 });
    appendFiredReceipt(u, { text: "pagi", at: now - 3 * 3600_000, deliveredAt: now - 3 * 3600_000 });
    appendFiredReceipt(u, { text: "siang", at: now - 3600_000, deliveredAt: now - 3600_000 });
    const rows = recentFiredReceipts(u, 24 * 3600_000, 3);
    expect(rows.map((r) => r.text)).toEqual(["pagi", "siang"]);
  });

  it("caps the count so a fresh tab is not flooded", () => {
    const u = track(freshUser("cap"));
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) {
      appendFiredReceipt(u, { text: `r${i}`, at: now - (i + 1) * 3600_000, deliveredAt: now - (i + 1) * 3600_000 });
    }
    expect(recentFiredReceipts(u, 24 * 3600_000, 3)).toHaveLength(3);
  });

  it("reads nothing for an unknown user instead of throwing", () => {
    expect(recentFiredReceipts(`verify_banner_nobody_${Date.now()}`)).toEqual([]);
  });
});

describe("stream connect replay — a late tab sees what it missed", () => {
  it("emits a recent fired receipt as a banner frame", async () => {
    const u = track(freshUser("replay"));
    const anHourAgo = Date.now() - 3600_000;
    appendFiredReceipt(u, { text: "makan malam", at: anHourAgo, deliveredAt: anHourAgo });
    const res = await streamGET(
      new NextRequest(`http://localhost/api/reminders/stream?user=${u}`)
    );
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    try {
      const first = await reader.read();
      const text = new TextDecoder().decode(first.value);
      expect(text).toContain("Udah bunyi:");
      expect(text).toContain("makan malam");
    } finally {
      await reader.cancel();
    }
  });

  it("does not replay a receipt that just fired live (no double alarm)", async () => {
    const u = track(freshUser("fresh"));
    const thirtySecondsAgo = Date.now() - 30_000;
    appendFiredReceipt(u, { text: "baru saja", at: thirtySecondsAgo, deliveredAt: thirtySecondsAgo });
    const res = await streamGET(
      new NextRequest(`http://localhost/api/reminders/stream?user=${u}`)
    );
    const reader = res.body!.getReader();
    try {
      const timeout = new Promise<string>((resolve) => setTimeout(() => resolve("TIMEOUT"), 1500));
      const first = await Promise.race([
        reader.read().then((r) => new TextDecoder().decode(r.value)),
        timeout,
      ]);
      expect(first).not.toContain("Udah bunyi:");
    } finally {
      await reader.cancel();
    }
  });
});

describe("playReminderChime — the owner's chime file instead of a TTS voice", () => {
  const stubAudio = (seen: { src: string | null; throws: boolean }) =>
    class {
      static lastSrc: string | null = null;
      constructor(src: string) {
        seen.src = src;
      }
      play(): void {
        if (seen.throws) throw new Error("blocked");
      }
    };

  it("requests exactly the chime file", () => {
    const seen = { src: null as string | null, throws: false };
    expect(playReminderChime("/finish.wav", stubAudio(seen))).toBe(true);
    expect(seen.src).toBe("/finish.wav");
  });

  it("returns false with no Audio implementation and when play throws", () => {
    expect(playReminderChime("/finish.wav", undefined)).toBe(false);
    const seen = { src: null as string | null, throws: true };
    expect(playReminderChime("/finish.wav", stubAudio(seen))).toBe(false);
    expect(seen.src).toBe("/finish.wav"); // attempted before the throw
  });
});
