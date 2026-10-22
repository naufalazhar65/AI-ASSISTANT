/**
 * Natural-style contract (owner style spec: "Mia jangan dibuat lebih dingin,
 * tapi kurangi overacting-nya").
 *
 * These tests lock the behaviour that replaced the overacting machinery:
 *  - the persona style block is anchored at a LINE-START heading, so a file
 *    that merely mentions "## Style" in passing no longer injects the whole
 *    document into the prompt;
 *  - a small reply stays small (a thanks keeps the model's own short line);
 *  - nothing bolts a signature suffix onto the end of a reply;
 *  - both the full and the slim prompt carry the anti-overacting rules.
 */
import { describe, it, expect } from "vitest";
import { findHeaderLine } from "./persona";
import { OFFICE_STYLE_CONTRACT, stripClosingMenuQuestion, stripMidSentenceMenuOffer } from "./agentRole";
import {
  buildSystemPrompt,
  buildSlimSystemPrompt,
  buildOpenCodeSystemPrompt,
  ensureMoodReplyQuality,
  trimShortSignatureEmoji, trimShortTrailingHonorific } from "./agent";

describe("persona style block is anchored at a line-start heading", () => {
  it("ignores an inline mention and finds the real heading", () => {
    const body = [
      "# SOUL.md",
      "- Format & Lists: lihat aturan per kanal di `## Style` (satu-satunya blok SOUL).",
      "- Brevity: keep answers short.",
      "",
      "## Style",
      "- Hangat itu keluar dari relevansi.",
    ].join("\n");
    const idx = findHeaderLine(body, "## Style");
    expect(idx).toBeGreaterThan(0);
    expect(body.slice(idx)).toMatch(/^## Style$/m);
    // The injected block must NOT contain the inline mention above.
    expect(body.slice(idx)).not.toContain("satu-satunya blok SOUL");
  });

  it("returns -1 when the heading is absent (nothing gets injected)", () => {
    expect(findHeaderLine("- only bullets here\n- no heading", "## Style")).toBe(-1);
    expect(findHeaderLine("inline `## Style` mention only", "## Style")).toBe(-1);
  });

  it("tolerates trailing whitespace on the heading line", () => {
    const body = "intro\n## Style  \n- bullet";
    expect(findHeaderLine(body, "## Style")).toBeGreaterThan(0);
  });
});

describe("small replies stay small", () => {
  const thanks = [{ role: "user" as const, content: "makasih ya" }];

  it("keeps the model's own short thank-you", () => {
    expect(ensureMoodReplyQuality(thanks, "Sama-sama.")).toBe("Sama-sama.");
    expect(ensureMoodReplyQuality(thanks, "Sama-sama 😄")).toBe("Sama-sama 😄");
  });

  it("never bolts a signature suffix onto a reply", () => {
    const out = ensureMoodReplyQuality(
      [{ role: "user" as const, content: "ringkas ya" }],
      "Bentar ya.\nAku cek dulu.\nSudah kelar."
    );
    expect(out).not.toMatch(/ya beb 🌸/);
    expect(out).not.toMatch(/ya beb$/);
  });

  it("rewrites a telegraphic mood reply into one short line without a forced question", () => {
    const out = ensureMoodReplyQuality(
      [{ role: "user" as const, content: "capek banget hari ini duhh" }],
      "Beb lelah. Hari berat. Istirahat dulu."
    );
    expect(out).not.toBe("Beb lelah. Hari berat. Istirahat dulu.");
    expect(out).not.toMatch(/\?\s*$/);
    expect(out.trim().split(/\s+/).length).toBeLessThanOrEqual(14);
    expect(out).not.toMatch(/seneng bisa bantu|ada yang bisa kubantu/i);
  });

  it("leaves a natural warm reply untouched", () => {
    const warm = "Duh beb, capek banget ya 🌸 Istirahat dulu bentar ya.";
    expect(
      ensureMoodReplyQuality([{ role: "user" as const, content: "capek banget hari ini duhh" }], warm)
    ).toBe(warm);
  });
});

describe("prompts carry the anti-overacting rules", () => {
  const full = buildSystemPrompt("naufalazhar652952", "discord");
  const slim = buildSlimSystemPrompt("naufalazhar652952", "discord");
  const opencode = buildOpenCodeSystemPrompt("naufalazhar652952", "discord");

  it("full prompt states the natural-not-sweet contract", () => {
    expect(full).toContain("NATURAL, NOT SWEET");
    expect(full).toContain("NO CLOSING OFFER");
    expect(full).toContain("LENGTH FOLLOWS THE MESSAGE");
    expect(full).toContain("MEMORY WITHOUT THE SHOWING OFF");
  });

  it("slim prompt states it too (capped providers get the same rule)", () => {
    expect(slim).toContain("NATURAL, NOT SWEET");
    expect(slim).toContain("No closing offer");
  });

  it("the shared office style contract forbids performative affection for all three agents", () => {
    expect(OFFICE_STYLE_CONTRACT).toContain("NO PERFORMATIVE AFFECTION");
  });

  it("no prompt quotes the old forced-question mood example anymore", () => {
    for (const p of [full, slim, opencode]) {
      expect(p).not.toMatch(/teme.nin ngobrol/);
    }
  });

  it("the slim prompt stays within its size budget", () => {
    expect(slim.length).toBeLessThan(full.length * 0.45);
  });
});

describe("round-3 fixes measured on the live probe", () => {
  it("a thanks turn answered with a fragment gets the thanks line, not a greeting", () => {
    // Live 2026-10-22: "makasih ya" came back as "Hai! Kamu lagi ngapain?"
    // because the telegraphic-repair branch handed a greeting line to a
    // thanks turn.
    const out = ensureMoodReplyQuality(
      [{ role: "user" as const, content: "makasih ya" }],
      "Sama-sama ya. Senang.",
    );
    expect(out).toMatch(/sama-sama/i);
    expect(out).not.toMatch(/ngapain|gimana harimu|ada yang baru/);
  });

  it("a short reply carries no signature emoji, a longer one keeps it", () => {
    expect(trimShortSignatureEmoji("Lagi nemenin kamu aja nih. 🌸")).toBe(
      "Lagi nemenin kamu aja nih.",
    );
    expect(trimShortSignatureEmoji("Capek banget 🌸 ya")).toBe("Capek banget ya");
    const long =
      "Ini cerita panjang sekali supaya emoji di bagian akhir ini tetap aman karena pesan yang panjang memang boleh memakai emoji sebagai bumbu kecil di akhir kalimat yang sedang kita tulis sekarang.";
    expect(trimShortSignatureEmoji(long)).toBe(long);
  });

  it("the fragment rewriter no longer glues fragments with 'sementara itu'", () => {
    const out = ensureMoodReplyQuality(
      [{ role: "user" as const, content: "berapa 17 x 23?" }],
      "391. Selesai.",
    );
    expect(out).not.toContain("sementara itu");
    expect(out).toContain("—");
  });
});

describe("a menu offer in the second clause is stripped too", () => {
  it("cuts 'ada yang mau …?' that follows a comma", () => {
    const out = stripClosingMenuQuestion(
      "Lagi nungguin kamu ngobrol aja, ada yang mau diobrolin atau dicariin?",
    );
    expect(out).not.toMatch(/ada yang mau/i);
    expect(out).toContain("Lagi nungguin kamu ngobrol aja");
  });

  it("keeps a real question that starts with 'ada yang'", () => {
    const q = "Tadi kamu bilang ada yang apa?";
    expect(stripClosingMenuQuestion(q)).toBe(q);
  });
});

describe("a menu offer placed mid-sentence is stripped too", () => {
  // Probe round 5 (2026-10-22) measured this shape: the model put the offer
  // inside the FIRST sentence while the last sentence was a real question, so
  // the trailing-only stripper never saw it.
  const PROBE_CASE =
    "Lagi nemenin kamu aja sambil nungguin kalau ada yang mau dibahas atau dicari. Kamu sendiri gimana keadaannya?";

  it("cuts the offer out of an earlier sentence and keeps the rest", () => {
    const out = stripMidSentenceMenuOffer(PROBE_CASE);
    expect(out).not.toMatch(/ada yang mau/i);
    expect(out).toContain("nemenin kamu aja");
    expect(out).toContain("Kamu sendiri gimana keadaannya?");
  });

  it("leaves a real question alone", () => {
    expect(stripMidSentenceMenuOffer("Tadi kamu bilang ada yang apa?")).toBe(
      "Tadi kamu bilang ada yang apa?",
    );
    expect(stripMidSentenceMenuOffer("Kalau ada yang mau, bilang aja.")).toBe(
      "Kalau ada yang mau, bilang aja.",
    );
  });

  it("leaves the last sentence to the trailing-offer logic", () => {
    const last = "Aku di sini, ada yang perlu dibantu?";
    expect(stripMidSentenceMenuOffer(last)).toBe(last);
    expect(stripClosingMenuQuestion(last)).toBe(last);
  });

  it("stripClosingMenuQuestion applies the mid-sentence strip", () => {
    const out = stripClosingMenuQuestion(PROBE_CASE);
    expect(out).not.toMatch(/ada yang mau/i);
    expect(out).toContain("Kamu sendiri gimana keadaannya?");
  });
});

describe("a menu offer after a short greeting is stripped", () => {
  it("keeps the greeting and drops the offer", () => {
    const out = stripClosingMenuQuestion("Halo, ada yang bisa aku bantu hari ini?");
    expect(out).not.toMatch(/bisa aku bantu/i);
    expect(out).toMatch(/Halo/);
  });
  it("drops a 'mau aku bantu?' offer after a greeting", () => {
    const out = stripClosingMenuQuestion("Oke, mau aku bantu?");
    expect(out).not.toMatch(/mau aku bantu/i);
    expect(out).toMatch(/Oke/);
  });
  it("leaves a non-greeting fragment head alone", () => {
    expect(stripClosingMenuQuestion("Aku, mau aku bantu?")).toMatch(/mau aku bantu/i);
  });
  it("keeps the substance before an offer in a longer reply", () => {
    expect(
      stripClosingMenuQuestion(
        "Hai Mas Naufal! Aku sama Agnes dan Michelle di sini siap nemenin, mau ngobrol santai atau ada yang perlu kita bantu beresin hari ini?",
      ),
    ).toBe("Hai Mas Naufal! Aku sama Agnes dan Michelle di sini siap nemenin.");
  });
});

describe("a short reply keeps no call-centre honorific", () => {
  it("drops the trailing honorific from a short reply", () => {
    expect(trimShortTrailingHonorific("Sama-sama Mas Naufal.")).toBe("Sama-sama.");
    expect(trimShortTrailingHonorific("Halo juga Mas Naufal")).toBe("Halo juga");
    expect(trimShortTrailingHonorific("Hasilnya 391 Mas Naufal.")).toBe("Hasilnya 391.");
  });
  it("keeps the nickname, a long reply and a reply that is only the name", () => {
    expect(trimShortTrailingHonorific("Sama-sama beb.")).toBe("Sama-sama beb.");
    expect(
      trimShortTrailingHonorific("Ini jawaban panjang sekali Mas Naufal yang menjelaskan banyak hal."),
    ).toContain("Mas Naufal");
    expect(trimShortTrailingHonorific("Mas Naufal.")).toBe("Mas Naufal.");
  });
});

describe("a menu offer at the very end of an unpunctuated reply is stripped", () => {
  it("cuts the offer clause and keeps the substance in front", () => {
    const out = stripClosingMenuQuestion(
      "Lagi nungguin kamu ngobrol aja, 🌸 sambil siap-siap kalau ada yang mau dibantu atau dicari",
    );
    expect(out).not.toMatch(/ada yang mau/i);
    expect(out).toContain("sambil siap-siap");
  });

  it("cuts a trailing offer clause without terminal punctuation", () => {
    const out = stripClosingMenuQuestion("Ini daftar tugas, ada yang mau kamu kerjakan dulu");
    expect(out).not.toMatch(/ada yang mau/i);
    expect(out).toContain("Ini daftar tugas");
  });

  it("leaves a reply without an offer untouched", () => {
    expect(stripClosingMenuQuestion("Halo juga Mas Naufal")).toBe("Halo juga Mas Naufal");
    expect(stripClosingMenuQuestion("Tadi kamu bilang ada yang apa?")).toBe(
      "Tadi kamu bilang ada yang apa?",
    );
  });
});
