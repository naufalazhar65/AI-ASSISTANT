// The internal-turn predicate is the single gate that keeps synthetic messages
// (rolling-summary carrier, self-correct/superseded logs, scheduled-automation
// prompts) out of the recap, the fact-capture pass and the daily-memory writer.

import { describe, expect, it } from "vitest";
import { isInternalTurn } from "./memoryNoise";

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
