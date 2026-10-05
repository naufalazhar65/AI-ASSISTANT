// The internal-turn predicate is the single gate that keeps synthetic messages
// (rolling-summary carrier, self-correct/superseded logs, scheduled-automation
// prompts) out of the recap, the fact-capture pass and the daily-memory writer.

import { describe, expect, it } from "vitest";
import { contentWordCount, isFillerLine, isInternalTurn } from "./memoryNoise";
import { pickTopicSnippet } from "./briefing";

describe("isInternalTurn", () => {
  it("flags synthetic carriers", () => {
    expect(isInternalTurn("[Percakapan sebelumnya — singkatan yang harus kamu pahami, JANGAN balas ini]")).toBe(true);
    expect(isInternalTurn("[self-correct] remind_me failed: bad args")).toBe(true);
    expect(isInternalTurn("[superseded] name: beb → Naufal")).toBe(true);
    expect(isInternalTurn("Ini laporan terjadwal (automation). Tugasmu: jawab langsung.")).toBe(true);
    expect(isInternalTurn("[Scheduled automation] cuaca tiap 6 jam")).toBe(true);
  });

  it("leaves real user text alone", () => {
    for (const t of ["halo mia", "ingetin aku jam 7 pagi", "rencanaku plan jalan pagi", "aku pakai plan free di app lain", ""]) {
      expect(isInternalTurn(t), t).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Briefing topic selection (2026-10-05) — regression lock.
//
// Live defect: the morning briefing announced the day's topic as "Hello, miya."
// because (a) `isFillerLine` counted the assistant's own name "miya" (4 chars,
// not in FILLER_WORDS) as a content word, and (b) the topic was chosen by
// POSITION (first surviving line) instead of by how much the line actually says.
// ---------------------------------------------------------------------------
describe("contentWordCount / isFillerLine with assistant names", () => {
  it("treats a bare greeting addressed to the assistant as filler", () => {
    expect(isFillerLine("Hello, miya.")).toBe(true);
    expect(isFillerLine("hai Mia")).toBe(true);
    expect(isFillerLine("good morning")).toBe(true);
    expect(isFillerLine("hi there")).toBe(true);
  });

  it("keeps a real line: one content word is enough", () => {
    expect(isFillerLine("agnes mau research apa")).toBe(false);
    expect(isFillerLine("kita ngobrol soal wifi router")).toBe(false);
  });

  it("counts only non-filler words of 4+ characters", () => {
    expect(contentWordCount("Hello, miya.")).toBe(0);
    expect(contentWordCount("agnes mau research apa")).toBe(1); // "research" only — agnes is now filler
  });
});

describe("pickTopicSnippet (most substantive line, not the first line)", () => {
  it("skips a leading greeting and picks the substantive line", () => {
    const lines = ["Hello, miya.", "Halo Mas Naufal!", "kita ngobrol soal setup wifi router"];
    expect(pickTopicSnippet(lines)).toBe("kita ngobrol soal setup wifi router");
  });

  it("keeps the earlier line when scores tie (deterministic)", () => {
    expect(pickTopicSnippet(["sama sama panjang", "tapi sama panjang"])).toBe("sama sama panjang");
  });

  it("returns empty when there is nothing substantive", () => {
    expect(pickTopicSnippet([])).toBe("");
    expect(pickTopicSnippet(["Hello, miya.", "good morning"])).toBe("");
  });

  it("does not let a short-but-meaningful line lose to a long greeting blob", () => {
    // "Hello, good morning, nice to see you" is all filler glue; "wifi drop" wins.
    expect(pickTopicSnippet(["Hello, good morning, nice to see you", "wifi drop"])).toBe("wifi drop");
  });
});
