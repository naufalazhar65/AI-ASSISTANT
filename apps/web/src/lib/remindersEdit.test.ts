/**
 * `edit_reminder` (owner 2026-10-06: "sudah hapus reminder jalan, tapi belum
 * tau edit reminder bekerja atau belum, mis. ubah jam atau ubah judul").
 *
 * The live probe behind this: moving the clock worked, but "ubah judul … jadi
 * X" was a silent NO-OP, because `reminders.ts` deliberately keeps the old
 * title on a repoint (`if (!repoint) existing.text = trimmed`) so a sloppy
 * phrase cannot destroy a good title. That is right for a move and wrong for an
 * explicit edit, so an edit gets its own entry point and its own tests.
 *
 * Every test uses a run-unique throwaway user and removes its directory in
 * afterEach, so no fixture data can leak into another run.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { addReminder, editReminder, moveReminder, readReminders } from "./reminders";
import { clockLabel, wibDailyNext } from "./time";
import { userDataRoot } from "./users";

const freshUser = (tag: string): string => `verify_edit_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

describe("editReminder — change time and/or title in place", () => {
  it("replaces the title (the case that used to be a silent no-op)", () => {
    const u = track(freshUser("title"));
    addReminder("Cek Email", wibDailyNext(8, 0), u);
    const res = editReminder(u, "cek email", { text: "Cek Email Penting" });
    expect(res?.after.text).toBe("Cek Email Penting");
    expect(res?.before.text).toBe("Cek Email");
    expect(readReminders(u)[0]?.text).toBe("Cek Email Penting");
  });

  it("moves the clock and keeps the title", () => {
    const u = track(freshUser("time"));
    addReminder("Cek Email", wibDailyNext(8, 0), u);
    const res = editReminder(u, "cek email", { atMs: wibDailyNext(9, 0) });
    expect(res?.after.text).toBe("Cek Email");
    expect(clockLabel(new Date(res!.after.at))).toBe(clockLabel(new Date(wibDailyNext(9, 0))));
  });

  it("changes time AND title in one call", () => {
    const u = track(freshUser("both"));
    addReminder("Cek Email", wibDailyNext(8, 0), u);
    const res = editReminder(u, "cek email", { atMs: wibDailyNext(9, 0), text: "Cek Email Penting" });
    expect(res?.after.text).toBe("Cek Email Penting");
    expect(clockLabel(new Date(res!.after.at))).toBe(clockLabel(new Date(wibDailyNext(9, 0))));
    expect(readReminders(u)).toHaveLength(1); // edited, not re-added
  });

  it("refuses an unknown topic instead of guessing a row", () => {
    const u = track(freshUser("nomatch"));
    addReminder("Cek Email", wibDailyNext(8, 0), u);
    expect(editReminder(u, "liga champions", { text: "x" })).toBeNull();
    expect(readReminders(u)[0]?.text).toBe("Cek Email");
  });

  it("never edits a reminder that already fired", () => {
    // A fired row is unreachable through the public API today (a delivered
    // one-shot is pruned, a daily one is rescheduled with fired:false), so the
    // file is seeded directly to exercise the guard the picker really carries.
    const u = track(freshUser("fired"));
    addReminder("Cek Email", wibDailyNext(8, 0), u);
    const path = join(userDataRoot(), u, "reminders.json");
    const rows = JSON.parse(readFileSync(path, "utf8")) as Array<{ fired: boolean }>;
    rows[0]!.fired = true;
    writeFileSync(path, JSON.stringify(rows, null, 2));
    expect(editReminder(u, "cek email", { text: "x" })).toBeNull();
    // readReminders prunes fired rows on read, so the store legitimately shows
    // nothing here; what matters is that the edit was REFUSED, not applied.
  });

  it("an empty patch reports the unchanged reminder rather than pretending", () => {
    const u = track(freshUser("noopatch"));
    addReminder("Cek Email", wibDailyNext(8, 0), u);
    const res = editReminder(u, "cek email", {});
    expect(res).not.toBeNull();
    expect(res?.after).toEqual(res?.before);
  });

  it("caps the new title at 300 characters", () => {
    const u = track(freshUser("cap"));
    addReminder("Cek Email", wibDailyNext(8, 0), u);
    const res = editReminder(u, "cek email", { text: "x".repeat(400) });
    expect(res?.after.text).toHaveLength(300);
  });

  it("a blank title keeps the current one (never wipes it)", () => {
    const u = track(freshUser("blank"));
    addReminder("Cek Email", wibDailyNext(8, 0), u);
    const res = editReminder(u, "cek email", { text: "   " });
    expect(res?.after.text).toBe("Cek Email");
  });

  it("moveReminder still keeps its old title (the two paths must not drift)", () => {
    const u = track(freshUser("movekeep"));
    addReminder("Cek Email", wibDailyNext(8, 0), u);
    const moved = moveReminder(u, "cek email", wibDailyNext(9, 0));
    expect(moved?.text).toBe("Cek Email");
  });
});