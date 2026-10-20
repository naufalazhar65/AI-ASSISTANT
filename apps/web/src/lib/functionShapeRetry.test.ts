/**
 * The upstream gateway's Gemini-compat layer intermittently rejects a request
 * whose function-call turn it mis-places (400 "Please ensure that function
 * call turn comes immediately after a user turn or after a function response
 * turn"). Observed live 2026-10-20 on 9router → gemini-3.5-flash-lite.
 *
 * The same request passed 3/3 on an immediate retry, so the shape we send is
 * canonical and the fault is upstream. These tests lock the DETECTOR and the
 * RETRY that acts on it.
 */
import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { isProviderRetryable, isTransientFunctionShapeError } from "./assistantError";
import { runOneCompletion } from "./agent";
import type { ChatMessage } from "./agent";

const SHAPE_400 = {
  error: {
    message:
      '[gemini/gemini-3.5-flash-lite] [400]: {"error": {"code": 400, "message": "Please ensure that function call turn comes immediately after a user turn or after a function response turn."}} (reset after 30s)',
  },
};

describe("isTransientFunctionShapeError", () => {
  it("recognises the upstream function-call-shape 400", () => {
    const err = new Error(`LLM failed (400): ${JSON.stringify(SHAPE_400)}`);
    expect(isTransientFunctionShapeError(err)).toBe(true);
  });

  it("does not fire on a real contract error", () => {
    expect(
      isTransientFunctionShapeError(new Error('LLM failed (400): {"error":{"message":"invalid tool arguments: missing field page"}}')),
    ).toBe(false);
    expect(isTransientFunctionShapeError(new Error("boom"))).toBe(false);
    expect(isTransientFunctionShapeError(null)).toBe(false);
    expect(isTransientFunctionShapeError(undefined)).toBe(false);
  });

  it("is NOT a provider-failover trigger — another model would not help", () => {
    const err = new Error(`LLM failed (400): ${JSON.stringify(SHAPE_400)}`);
    expect(isProviderRetryable(err)).toBe(false);
  });
});

describe("runOneCompletion — transient function-shape 400", () => {
  it("retries once and succeeds when the gateway only glitches the first time", async () => {
    let calls = 0;
    const server: Server = createServer((req, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify(SHAPE_400));
        return;
      }
      // The agent asks for stream:true — answer with SSE frames.
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        'data: {"choices":[{"delta":{"content":"sudah berhasil"}}]}\n\ndata: [DONE]\n\n',
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const messages: ChatMessage[] = [{ role: "user", content: "halo" }];
      const out = await runOneCompletion(
        messages,
        `http://127.0.0.1:${port}/v1/chat/completions`,
        "test-key",
        "you are a test",
        "test-model",
        false,
      );
      expect(out.text).toBe("sudah berhasil");
      expect(calls).toBe(2);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("gives up after the single retry instead of looping", async () => {
    let calls = 0;
    const server: Server = createServer((_req, res) => {
      calls += 1;
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify(SHAPE_400));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const messages: ChatMessage[] = [{ role: "user", content: "halo" }];
      await expect(
        runOneCompletion(
          messages,
          `http://127.0.0.1:${port}/v1/chat/completions`,
          "test-key",
          "you are a test",
          "test-model",
          false,
        ),
      ).rejects.toThrow(/400/);
      expect(calls).toBe(2);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
