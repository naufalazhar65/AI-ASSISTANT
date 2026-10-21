import { describe, it, expect } from "vitest";
import {
  classifyAssistantError,
  functionShapeResetAfterMs,
  isTransientFunctionShapeError,
  isProviderRetryable,
} from "./assistantError";

describe("isTransientFunctionShapeError", () => {
  // The live text from 9router → gemini-3.5-flash-lite (2026-10-20/21). The
  // gateway TRUNCATES the message and appends "(reset after 29s)", so a pattern
  // that expects the full sentence misses the very text it was written for.
  const live = 'LLM failed (400): {"error":{"message":"[gemini/gemini-3.5-flash-lite] [400]: {\\n  \\"error\\": {\\n    \\"code\\": 400,\\n    \\"message\\": \\"Please ensure that function call turn comes i (reset after 29s)\\"}';

  it("matches the TRUNCATED live message", () => {
    expect(isTransientFunctionShapeError(new Error(live))).toBe(true);
  });

  it("matches the full upstream sentence too", () => {
    const full =
      "LLM failed (400): Please ensure that function call turn comes immediately after a user turn or after a function response turn.";
    expect(isTransientFunctionShapeError(new Error(full))).toBe(true);
  });

  it("does not match an unrelated 400", () => {
    expect(isTransientFunctionShapeError(new Error("LLM failed (400): invalid tool arguments"))).toBe(false);
    expect(isTransientFunctionShapeError(new Error("LLM failed (400): context length exceeded"))).toBe(false);
  });

  it("does not match a non-400 with the same phrase", () => {
    expect(isTransientFunctionShapeError(new Error("Please ensure that function call turn comes immediately after"))).toBe(false);
  });
});

describe("isProviderRetryable", () => {
  it("does not spend the chain on our own code errors", () => {
    expect(isProviderRetryable(new Error("invalid tool arguments: missing field page"))).toBe(false);
  });

  it("spends the chain on a provider failure", () => {
    expect(isProviderRetryable(new Error("provider error: upstream 503"))).toBe(true);
  });
});

describe("functionShapeResetAfterMs", () => {
  // The gateway states its own cooldown in the message. A fixed 1.2s wait
  // guarantees a second rejection, so the wait has to follow the message.
  it("reads the cooldown the gateway states", () => {
    const live = 'LLM failed (400): {"error":{"message":"... function call turn comes i (reset after 29s)"}}';
    expect(functionShapeResetAfterMs(new Error(live))).toBe(29000);
  });

  it("caps the wait so a turn cannot outlive its cooldown", () => {
    expect(functionShapeResetAfterMs(new Error("function call turn comes (reset after 900s)"))).toBe(30000);
  });

  it("returns 0 when the message carries no cooldown", () => {
    expect(functionShapeResetAfterMs(new Error("function call turn comes immediately after"))).toBe(0);
    expect(functionShapeResetAfterMs(new Error("boom"))).toBe(0);
    expect(functionShapeResetAfterMs(null)).toBe(0);
  });
});

describe("an expired key on one provider", () => {
  // Live 2026-10-21: the chain reached opencodego, whose key had expired.
  // The error was not retryable, so the chain aborted and the turn died even
  // though the next candidate could have served it.
  const expired = 'LLM failed (401): {"error":{"type":"authentication_error","code":"api_key_expired","message":"This API key has expired."}}';

  it("moves the chain to the next provider", () => {
    expect(isProviderRetryable(new Error(expired))).toBe(true);
  });

  it("is still reported to the owner as a quota problem", () => {
    expect(classifyAssistantError(new Error(expired)).kind).toBe("quota");
  });
});
