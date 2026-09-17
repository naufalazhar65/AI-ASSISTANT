// Regression tests for provider-failure detection on the LLM stream + the
// freeride fallback chain. The bug they lock: OpenRouter reports a dead /
// throttled free model as HTTP 200 with an in-band `error`, which used to look
// like a successful empty reply — so the chain never failed over and the user
// got nothing.

import { afterEach, describe, expect, it, vi } from "vitest";
import { chainMayFailover, parseStreamError, runOneCompletion } from "./agent";
import { isProviderRetryable } from "./assistantError";
import { isProbeAliveResponse, shouldProbeNow } from "./freeride";

function sseResponse(frames: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

const okFrames = [
  'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
  "data: [DONE]\n\n",
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseStreamError", () => {
  it("reads an in-band provider error with its code (upstream overloaded)", () => {
    expect(
      parseStreamError({ id: "gen-1", error: { code: 503, message: "Upstream error from Nvidia: Service temporarily overloaded" } })
    ).toBe("Provider error (503): Upstream error from Nvidia: Service temporarily overloaded");
  });

  it("reads a rate-limit error frame", () => {
    const msg = parseStreamError({ error: { message: "Rate limit exceeded: free-models-per-min.", code: 429 } });
    expect(msg).toContain("429");
    expect(isProviderRetryable(new Error(msg ?? ""))).toBe(true);
  });

  it("reads an invalid/retired model id", () => {
    const msg = parseStreamError({ error: { message: "nvidia/x:free is not a valid model ID", code: 400 } });
    expect(msg).toContain("not a valid model ID");
    expect(isProviderRetryable(new Error(msg ?? ""))).toBe(true);
  });

  it("handles a string error and skips null/absent errors", () => {
    expect(parseStreamError({ error: "boom" })).toBe("Provider error: boom");
    expect(parseStreamError({ error: null })).toBeNull();
    expect(parseStreamError({ choices: [{ delta: { content: "hi" } }] })).toBeNull();
    expect(parseStreamError(null)).toBeNull();
    expect(parseStreamError("[DONE]")).toBeNull();
  });
});

describe("isProviderRetryable", () => {
  it("accepts failures another chain member can fix", () => {
    for (const m of [
      "LLM failed (429): rate limit",
      "Provider error (503): Upstream error from Nvidia",
      "Rate limit exceeded. Please try again in 0.01s",
      "nvidia/x:free is not a valid model ID",
      "No allowed providers are available for the selected model",
      "fetch failed",
      "ECONNRESET",
    ]) {
      expect(isProviderRetryable(new Error(m)), m).toBe(true);
    }
  });

  it("rejects errors that another model cannot fix", () => {
    for (const m of ["invalid tool arguments: missing field", "Terjadi kendala.", "Cannot read properties of undefined"]) {
      expect(isProviderRetryable(new Error(m)), m).toBe(false);
    }
  });
});

describe("chainMayFailover", () => {
  it("allows another model only when the failed attempt had no effect", () => {
    expect(chainMayFailover(3, 3)).toBe(true);
  });
  it("blocks failover after a tool ran (the attempt appended to messages)", () => {
    expect(chainMayFailover(3, 5)).toBe(false);
  });
});

describe("shouldProbeNow", () => {
  const now = Date.parse("2026-09-17T06:00:00.000Z");
  it("probes when never probed", () => {
    expect(shouldProbeNow(undefined, now)).toBe(true);
  });
  it("skips within the interval (the 60s watcher must not burn free quota)", () => {
    expect(shouldProbeNow("2026-09-17T05:59:00.000Z", now)).toBe(false);
    expect(shouldProbeNow("2026-09-17T05:00:00.000Z", now)).toBe(true);
  });
  it("probes again after the interval", () => {
    expect(shouldProbeNow("2026-09-17T04:59:59.000Z", now)).toBe(true);
  });
});

describe("isProbeAliveResponse", () => {
  it("treats HTTP 200 WITH an error body as dead", () => {
    expect(isProbeAliveResponse(200, { id: "gen-1", error: { code: 503, message: "Upstream error" } })).toBe(false);
  });
  it("treats a non-2xx as dead", () => {
    expect(isProbeAliveResponse(429, { choices: [{}] })).toBe(false);
    expect(isProbeAliveResponse(400, { error: { message: "is not a valid model ID" } })).toBe(false);
  });
  it("needs a completion shape with choices", () => {
    expect(isProbeAliveResponse(200, { choices: [{}] })).toBe(true);
    expect(isProbeAliveResponse(200, { object: "chat.completion" })).toBe(false);
    expect(isProbeAliveResponse(200, null)).toBe(false);
  });
});

describe("runOneCompletion stream errors", () => {
  it("throws on an in-band SSE error frame instead of returning an empty reply", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse(['data: {"error":{"code":502,"message":"Upstream error from Nvidia: ResourceExhausted"}}\n\n']))
    );
    await expect(runOneCompletion([{ role: "user", content: "hi" }], "https://openrouter.ai/api/v1/chat/completions", "k", "sys", "m", false)).rejects.toThrow(
      /Provider error \(502\): Upstream error from Nvidia/
    );
  });

  it("throws on a raw JSON error body from a gateway that ignores stream:true", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(['{"error":{"code":400,"message":"nvidia/x:free is not a valid model ID"}}\n'])));
    await expect(runOneCompletion([{ role: "user", content: "hi" }], "https://openrouter.ai/api/v1/chat/completions", "k", "sys", "m", false)).rejects.toThrow(
      /not a valid model ID/
    );
  });

  it("throws when the error frame is the LAST frame without a trailing newline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse(['data: {"error":{"code":503,"message":"Upstream error from Nvidia: ResourceExhausted"}}']))
    );
    await expect(runOneCompletion([{ role: "user", content: "hi" }], "https://openrouter.ai/api/v1/chat/completions", "k", "sys", "m", false)).rejects.toThrow(
      /Provider error \(503\)/
    );
  });

  it("still returns normal text when no error is present", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(okFrames)));
    const out = await runOneCompletion([{ role: "user", content: "hi" }], "https://openrouter.ai/api/v1/chat/completions", "k", "sys", "m", false);
    expect(out.text).toBe("ok");
  });

  it("retries once on an in-band 429, then returns the streamed text", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse(['data: {"error":{"code":429,"message":"Rate limit exceeded. Please try again in 0.01s"}}\n\n'])
      )
      .mockResolvedValueOnce(sseResponse(okFrames));
    vi.stubGlobal("fetch", fetchMock);
    const out = await runOneCompletion([{ role: "user", content: "hi" }], "https://openrouter.ai/api/v1/chat/completions", "k", "sys", "m", false);
    expect(out.text).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
