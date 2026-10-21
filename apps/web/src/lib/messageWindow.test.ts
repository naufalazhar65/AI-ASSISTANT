// messageWindow.test.ts — the head of a message window must be sendable.
//
// Live 2026-10-21 (measured by probing the gateway directly, one shape per
// process so a poisoned key could not skew the result):
//
//   user-head                → 200 OK
//   assistant-text-head      → 200 OK
//   tool-result-head         → 200 OK
//   assistant-with-toolcalls → 400  ← the only rejected shape
//
// And the 400 POISONS THE KEY: the next plain request failed with the same
// 400 for ~30 seconds, which killed every following turn of the drill.
import { describe, it, expect } from "vitest";
import { isSafeWindowHead, trimToSafeWindowHead } from "./messageWindow";

const user = { role: "user", content: "halo" };
const assistant = { role: "assistant", content: "hai" };
const call = { role: "assistant", content: null, tool_calls: [{ id: "c1" }] };
const result = { role: "tool", tool_call_id: "c1", content: "done" };

describe("isSafeWindowHead", () => {
  it("accepts a user turn and a plain assistant turn", () => {
    expect(isSafeWindowHead(user)).toBe(true);
    expect(isSafeWindowHead(assistant)).toBe(true);
  });

  it("rejects a function-call turn and a tool result", () => {
    expect(isSafeWindowHead(call)).toBe(false);
    expect(isSafeWindowHead(result)).toBe(false);
    expect(isSafeWindowHead(undefined)).toBe(false);
  });
});

describe("trimToSafeWindowHead", () => {
  it("keeps a window that already starts well", () => {
    const messages = [user, assistant, user];
    expect(trimToSafeWindowHead(messages)).toEqual(messages);
  });

  it("drops a leading function-call turn together with its tool result", () => {
    // The gateway rejects this shape with 400 and poisons the key.
    const messages = [call, result, assistant, user];
    const trimmed = trimToSafeWindowHead(messages);
    expect(trimmed.map((m) => m.role)).toEqual(["assistant", "user"]);
    // No orphan tool result may survive — strict gateways reject that too.
    expect(trimmed.some((m) => m.role === "tool")).toBe(false);
  });

  it("drops a leading orphan tool result", () => {
    const messages = [result, assistant, user];
    const trimmed = trimToSafeWindowHead(messages);
    expect(trimmed.map((m) => m.role)).toEqual(["assistant", "user"]);
  });

  it("drops several leading tool rounds at once", () => {
    const call2 = { role: "assistant", content: null, tool_calls: [{ id: "c2" }] };
    const result2 = { role: "tool", tool_call_id: "c2", content: "done" };
    const messages = [call, result, call2, result2, user];
    const trimmed = trimToSafeWindowHead(messages);
    expect(trimmed.map((m) => m.role)).toEqual(["user"]);
  });

  it("falls back to the first plain assistant turn when there is no user turn", () => {
    const messages = [call, result, assistant];
    const trimmed = trimToSafeWindowHead(messages);
    expect(trimmed.map((m) => m.role)).toEqual(["assistant"]);
  });

  it("never returns a window that still starts with a function-call turn", () => {
    for (const messages of [
      [call, result, user],
      [call, user],
      [call],
      [result, call, result, user],
    ]) {
      const trimmed = trimToSafeWindowHead(messages);
      expect(trimmed.length === 0 || isSafeWindowHead(trimmed[0])).toBe(true);
    }
  });
});
