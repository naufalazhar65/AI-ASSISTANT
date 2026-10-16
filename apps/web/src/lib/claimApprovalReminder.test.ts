import { describe, expect, it } from "vitest";
import { approvalClaimNote, reminderDeliveryClaimNote } from "./agent";

describe("approvalClaimNote (audit 2026-10-15: invented consent had no guard)", () => {
  it("flags invented consent when the turn approved nothing", () => {
    const n = approvalClaimNote("Sudah kamu setujui, jadi aku jalankan sekarang.", { approvedThisTurn: false });
    expect(n).toContain("tidak punya persetujuanmu");
  });
  it("silent when a call really was approved this turn", () => {
    expect(approvalClaimNote("Sudah kamu setujui, jadi aku jalankan sekarang.", { approvedThisTurn: true })).toBe("");
  });
  it("silent on questions, futures and negations", () => {
    for (const t of [
      "Sudah kamu setujui tadi?",
      "Kalau kamu sudah setuju, aku lanjut ya.",
      "Kamu belum menyetujuinya, kan?",
      "Boleh aku kirim pengingat dulu?"
    ]) {
      expect(approvalClaimNote(t, { approvedThisTurn: false })).toBe("");
    }
  });
  it("per-clause: a truthful sentence does not silence a false claim", () => {
    const n = approvalClaimNote(
      "Aku belum menjalankan apa pun. Sudah kamu setujui semua ya.",
      { approvedThisTurn: false }
    );
    expect(n).toContain("tidak punya persetujuanmu");
  });
});

describe("reminderDeliveryClaimNote (audit 2026-10-15: delivery claims had no guard)", () => {
  it("flags 'sudah terkirim' with no acked delivery on record", () => {
    const n = reminderDeliveryClaimNote("Reminder jam 7 tadi sudah terkirim ke Telegram.", { freshDelivery: false });
    expect(n).toContain("tidak ada reminder yang benar-benar terkirim");
  });
  it("silent when a fresh receipt proves delivery", () => {
    expect(
      reminderDeliveryClaimNote("Reminder jam 7 tadi sudah terkirim ke Telegram.", { freshDelivery: true })
    ).toBe("");
  });
  it("ignores non-reminder delivery claims and questions", () => {
    expect(reminderDeliveryClaimNote("Emailnya sudah terkirim ke admin.", { freshDelivery: false })).toBe("");
    expect(reminderDeliveryClaimNote("Sudah reminder-nya terkirim?", { freshDelivery: false })).toBe("");
    expect(reminderDeliveryClaimNote("Reminder-nya belum terkirim karena HP mati.", { freshDelivery: false })).toBe("");
  });
});
