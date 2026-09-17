// Process-wide "exactly once" primitives — they exist because a redelivered
// message ran two full turns (two `remind_me` confirmation prompts) and because
// module-level guards reset on HMR, starting a second bot/timer.

import { beforeEach, describe, expect, it } from "vitest";
import { alreadyProcessed, alreadyStarted, resetStarted, __resetOnceForTests } from "./once";

describe("alreadyProcessed (inbound message dedupe)", () => {
  beforeEach(() => __resetOnceForTests());

  it("flags the same id once and ignores other kinds/ids", () => {
    expect(alreadyProcessed("discord", "123")).toBe(false);
    expect(alreadyProcessed("discord", "123")).toBe(true); // redelivery
    expect(alreadyProcessed("discord", "124")).toBe(false);
    expect(alreadyProcessed("telegram", "123")).toBe(false); // separate namespace
    expect(alreadyProcessed("discord", 123)).toBe(true); // string/number agree
  });

  it("stays bounded (old ids are forgotten, memory cannot grow)", () => {
    for (let i = 0; i < 600; i++) alreadyProcessed("discord", i);
    expect(alreadyProcessed("discord", 599)).toBe(true);
    expect(alreadyProcessed("discord", 0)).toBe(false); // evicted, may be re-handled
  });
});

describe("alreadyStarted (process-wide start guard)", () => {
  beforeEach(() => __resetOnceForTests());

  it("lets a key start once and resetStarted re-arms it", () => {
    expect(alreadyStarted("briefing")).toBe(false);
    expect(alreadyStarted("briefing")).toBe(true);
    expect(alreadyStarted("heartbeat")).toBe(false);
    resetStarted("briefing");
    expect(alreadyStarted("briefing")).toBe(false);
  });
});
