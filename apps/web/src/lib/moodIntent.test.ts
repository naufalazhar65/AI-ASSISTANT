// moodIntent.test.ts — deterministic mood capture must never log a mood the
// user did not express. LIVE 2026-09-26 (found by a "mengada-ada?" audit of
// the morning pushes): the keyword alternations had no word boundaries, so
// "markdown" (contains "down") logged mood=sad for 7 consecutive pentest asks;
// and "belum ngantuk nich" (a negation) logged tired. These tests lock both
// fixes two ways: false positives stay silent, real expressions still land.
import { describe, expect, it } from "vitest";
import { detectMoodIntent } from "./moodIntent";

describe("detectMoodIntent — no mood is invented from non-mood text", () => {
  it("does not read 'down' inside 'markdown' as sad (live: 7 fake sad entries)", () => {
    expect(
      detectMoodIntent(
        "mia coba lakukan full pentest secara menyeluruh di https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app/cek-nik dan buatkan report markdown nya"
      )
    ).toBeNull();
  });

  it("stays silent on pentest asks without any mood keyword", () => {
    expect(
      detectMoodIntent(
        "mia coba lakukan full pentest secara menyeluruh di https://x.netlify.app/cek-nik dan buatkan report pdfnya"
      )
    ).toBeNull();
  });

  it("does not match substring fragments of other words (download, countdown)", () => {
    expect(detectMoodIntent("download file itu dong")).toBeNull();
    expect(detectMoodIntent("countdown eventnya kapan?")).toBeNull();
  });

  it("negation before the keyword cancels it ('belum ngantuk' is NOT tired)", () => {
    expect(detectMoodIntent("belum ngantuk nich")).toBeNull();
    expect(detectMoodIntent("aku nggak sedih kok")).toBeNull();
    expect(detectMoodIntent("aku tidak capek")).toBeNull();
  });
});

describe("detectMoodIntent — real expressions still register (anti-overcorrection)", () => {
  it("tired", () => {
    expect(detectMoodIntent("aku capek banget")?.mood).toBe("tired");
  });

  it("tired with clitic ('capeknya')", () => {
    expect(detectMoodIntent("capeknya setelah kerja")?.mood).toBe("tired");
  });

  it("stressed", () => {
    expect(detectMoodIntent("aku lagi stres banget kerjaan numpuk")?.mood).toBe("stressed");
  });

  it("sad (plain keyword)", () => {
    expect(detectMoodIntent("aku lagi sedih banget")?.mood).toBe("sad");
  });

  it("anxious", () => {
    expect(detectMoodIntent("aku sedang cemas")?.mood).toBe("anxious");
  });

  it("angry", () => {
    expect(detectMoodIntent("lagi kesel sih")?.mood).toBe("angry");
  });

  it("negation on one keyword does not block another real keyword later in the text", () => {
    const hit = detectMoodIntent("belum ngantuk tapi aku kesel sama hasilnya");
    expect(hit?.mood).toBe("angry");
  });
});
