import { describe, it, expect } from "vitest";
import { ConversationStateMachine, STATES } from "./index";

describe("ConversationStateMachine", () => {
  it("starts in IDLE", () => {
    expect(new ConversationStateMachine().current).toBe("IDLE");
  });

  it("walks the canonical voice loop IDLE -> LISTENING -> PROCESSING -> SPEAKING -> LISTENING", () => {
    const sm = new ConversationStateMachine();
    expect(sm.transition("START")).toBe("LISTENING");
    expect(sm.transition("SPEECH_ENDED")).toBe("PROCESSING");
    expect(sm.transition("RESPONSE_READY")).toBe("SPEAKING");
    expect(sm.transition("TURN_END")).toBe("LISTENING");
  });

  it("keeps listening while speech is detected", () => {
    const sm = new ConversationStateMachine();
    sm.transition("START");
    expect(sm.transition("SPEECH_STARTED")).toBe("LISTENING");
    expect(sm.transition("SPEECH_STARTED")).toBe("LISTENING");
  });

  it("supports barge-in: SPEAKING -> INTERRUPTED -> LISTENING", () => {
    const sm = new ConversationStateMachine();
    sm.transition("START");
    sm.transition("SPEECH_ENDED");
    sm.transition("RESPONSE_READY");
    expect(sm.transition("INTERRUPT")).toBe("INTERRUPTED");
    expect(sm.transition("RESUME")).toBe("LISTENING");
  });

  it("supports RECONNECT -> CONNECTED", () => {
    const sm = new ConversationStateMachine();
    sm.transition("START");
    expect(sm.transition("RECONNECT")).toBe("RECONNECTING");
    expect(sm.transition("CONNECTED")).toBe("IDLE");
  });

  it("returns null for invalid transitions (invariant: impossible)", () => {
    const sm = new ConversationStateMachine();
    // Cannot speak from IDLE.
    expect(sm.transition("RESPONSE_READY")).toBeNull();
    // Cannot process without being LISTENING.
    expect(sm.transition("SPEECH_ENDED")).toBeNull();
    expect(sm.current).toBe("IDLE");
  });

  it("stays in the same state after an invalid transition", () => {
    const sm = new ConversationStateMachine();
    sm.transition("START");
    sm.transition("SPEECH_ENDED"); // PROCESSING
    const before = sm.current;
    expect(sm.transition("TURN_END")).toBeNull(); // TURN_END needs SPEAKING
    expect(sm.current).toBe(before);
  });

  it("routes ERROR and RESET from any state", () => {
    const sm = new ConversationStateMachine();
    sm.transition("START");
    sm.transition("SPEECH_ENDED");
    expect(sm.transition("ERROR")).toBe("ERROR");
    expect(sm.transition("RESET")).toBe("IDLE");
  });

  it("`can` mirrors `transition` legality", () => {
    const sm = new ConversationStateMachine();
    expect(sm.can("START")).toBe(true);
    expect(sm.can("SPEECH_ENDED")).toBe(false);
    // Every declared state is a valid State.
    for (const s of STATES) {
      expect(typeof s).toBe("string");
    }
  });
});