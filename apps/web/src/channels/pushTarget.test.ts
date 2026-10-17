import { beforeEach, describe, expect, it } from "vitest";
import { listChannels, pushToOwner, registerPushTarget, sendToChannel } from "./pushTarget";

// Live 2026-10-17: `pushToOwner` trusted boot order, so the last-registered label
// won even when it had no reachable target ("no slack owner channel seen") and the
// automation result was dropped entirely.
const GKEY = "__pushTargetState__";

function reset() {
  delete (globalThis as Record<string, unknown>)[GKEY];
}

beforeEach(reset);

describe("pushToOwner falls back across registered channels", () => {
  it("delivers to the newest label when it works", async () => {
    const sent: string[] = [];
    registerPushTarget("discord", async () => void sent.push("discord"));
    registerPushTarget("slack", async () => void sent.push("slack"));
    expect(await pushToOwner("x")).toBe(true);
    expect(sent).toEqual(["slack"]); // newest only, no double delivery
  });

  it("falls through a failing newest label and delivers once", async () => {
    const sent: string[] = [];
    registerPushTarget("discord", async () => void sent.push("discord"));
    registerPushTarget("slack-michelle", async () => {
      throw new Error("no slack owner channel seen");
    });
    expect(await pushToOwner("x")).toBe(true);
    expect(sent).toEqual(["discord"]);
  });

  it("tries each label at most once", async () => {
    const calls: string[] = [];
    registerPushTarget("a", async () => void calls.push("a"));
    registerPushTarget("b", async () => void calls.push("b"));
    registerPushTarget("c", async () => void calls.push("c"));
    expect(await pushToOwner("x")).toBe(true);
    expect(calls).toEqual(["c"]);
  });

  it("returns false when every label fails or none is registered", async () => {
    registerPushTarget("a", async () => {
      throw new Error("down");
    });
    expect(await pushToOwner("x")).toBe(false);
    reset();
    expect(await pushToOwner("x")).toBe(false);
  });
});

describe("sendToChannel still targets an exact label", () => {
  it("does not fall back — a named channel must be the one that sends", async () => {
    const sent: string[] = [];
    registerPushTarget("a", async () => void sent.push("a"));
    registerPushTarget("b", async () => void sent.push("b"));
    expect(await sendToChannel("a", "x")).toBe("Sent to a.");
    expect(sent).toEqual(["a"]);
  });

  it("rejects an unknown label", async () => {
    registerPushTarget("a", async () => undefined);
    await expect(sendToChannel("nope", "x")).rejects.toThrow(/not available/);
    expect(listChannels()).toEqual(["a"]);
  });
});