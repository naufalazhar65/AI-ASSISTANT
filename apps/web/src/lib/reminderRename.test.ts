/**
 * `detectReminderRename` (live drill 2026-10-06).
 *
 * The owner's ask: "sudah hapus reminder jalan, tapi belum tau edit reminder
 * bekerja atau belum, mis. ubah jam atau ubah judul". Time edits had a
 * deterministic path; a TITLE edit did not, so it became an `edit_reminder`
 * argument the model had to assemble — and across two live runs it sent only
 * `when` (once inventing a date) and then told the user it had renamed the
 * reminder. So the rename is parsed from the user's own words.
 *
 * Every case is two-way: the negatives are the phrases that must NOT become a
 * rename, because misreading them is how a repoint gets turned into a rename (or
 * a create into a rename).
 */

import { describe, expect, it } from "vitest";

import { detectReminderRename } from "./reminderIntent";

describe("detectReminderRename — user's words reach the store", () => {
  it("reads the topic and the new title out of the ask", () => {
    expect(detectReminderRename("ubah judul reminder cek email jadi cek email penting")).toEqual({
      anchor: "cek email",
      title: "cek email penting",
    });
    expect(detectReminderRename("tolong ganti nama reminder makan siang menjadi makan siang cepat")).toEqual({
      anchor: "makan siang",
      title: "makan siang cepat",
    });
  });

  it("keeps 'judulnya' as one token (no boundary between judul and nya)", () => {
    // "ganti judulnya jadi cek email rutin" has no topic of its own, so it is
    // refused rather than guessed at — but the trigger itself must match.
    expect(detectReminderRename("ganti judul reminder cek email jadi cek email rutin")).toEqual({
      anchor: "cek email",
      title: "cek email rutin",
    });
  });

  it("reads the English shape too", () => {
    expect(detectReminderRename("rename the reminder cek email to cek email harian")).toEqual({
      anchor: "cek email",
      title: "cek email harian",
    });
  });

  it("accepts a rename without a title noun when the new title is not a clock", () => {
    expect(detectReminderRename("ganti reminder cek email jadi cek email wajib")).toEqual({
      anchor: "cek email",
      title: "cek email wajib",
    });
  });

  it("never turns a repoint into a rename", () => {
    // A clock in the new wording means "move it", which the move path owns.
    expect(detectReminderRename("ganti reminder cek email jadi jam 9 pagi")).toBeNull();
    expect(detectReminderRename("ubah jam reminder cek email jadi jam 9 pagi")).toBeNull();
    expect(detectReminderRename("pindah reminder cek email ke jam 7 malam")).toBeNull();
  });

  it("never treats a new reminder as a rename", () => {
    expect(detectReminderRename("ingetin aku jam 7 pagi")).toBeNull();
    expect(detectReminderRename("ingetin aku cek email besok pagi")).toBeNull();
  });

  it("never treats a deletion as a rename", () => {
    expect(detectReminderRename("hapus reminder cek email")).toBeNull();
    expect(detectReminderRename("batalin reminder cek email")).toBeNull();
  });

  it("refuses when there is no new title or no copula", () => {
    expect(detectReminderRename("ubah judul reminder cek email")).toBeNull();
    expect(detectReminderRename("ganti judul cek email")).toBeNull();
  });

  it("refuses when there is no topic to anchor a row against", () => {
    // Guessing a row is exactly what this layer must never do — the edit tool
    // refuses a zero-score match for the same reason.
    expect(detectReminderRename("ganti judulnya jadi cek email rutin")).toBeNull();
    expect(detectReminderRename("ubah judul jadi apa")).toBeNull();
  });

  it("stays silent on a URL ask (the URL-phishing gate of 2026-09-26)", () => {
    expect(detectReminderRename("https://contoh.com/ubah judul jadi cek email")).toBeNull();
  });

  it("stays silent on a bare question about a title", () => {
    expect(detectReminderRename("coba cek judulnya apa")).toBeNull();
    expect(detectReminderRename("reminder cek email judulnya apa")).toBeNull();
  });

  it("caps a very long new title instead of writing it whole", () => {
    const long = "x".repeat(400);
    const hit = detectReminderRename(`ubah judul reminder cek email jadi ${long}`);
    expect(hit?.title.length).toBe(120);
  });
});