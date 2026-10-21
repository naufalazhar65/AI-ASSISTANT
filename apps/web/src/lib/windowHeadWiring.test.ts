/**
 * WIRING proof for the window-head trim.
 *
 * The helper in ./messageWindow was written, unit-tested and then never
 * called — the agent sent the raw window, so the 400 the helper exists to
 * prevent was still live. A unit test on the helper cannot catch that class
 * of defect ("the helper is right, the wire is loose"), so this test asserts
 * what actually goes over the wire: it stands up a local server, sends a
 * window whose head is an assistant function-call turn, and reads the request
 * body back.
 *
 * Measured 2026-10-21 on the live gateway: the head shape
 * assistant-with-tool_calls is the ONLY rejected one — user head, assistant
 * text head and tool-result head all pass — and the rejection poisons the key
 * for ~30s, so every later request fails too.
 */
import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { runOneCompletion } from "./agent";
import type { ChatMessage } from "./agent";

/** Stand up a server that records the request body and answers with SSE. */
async function captureBody(
  messages: ChatMessage[],
): Promise<{ body: { messages: Array<{ role?: string; tool_calls?: unknown[] }> }; calls: number }> {
  let calls = 0;
  let body = { messages: [] as Array<{ role?: string; tool_calls?: unknown[] }> };
  const server: Server = createServer((req, res) => {
    calls += 1;
    let raw = "";
    req.on("data", (c) => {
      raw += String(c);
    });
    req.on("end", () => {
      try {
        body = JSON.parse(raw);
      } catch {
        body = { messages: [] };
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    await runOneCompletion(
      messages,
      `http://127.0.0.1:${port}/v1/chat/completions`,
      "test-key",
      "you are a test",
      "test-model",
      false,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
  return { body, calls };
}

describe("the window head that actually goes over the wire", () => {
  it("never starts with an assistant function-call turn", async () => {
    // The rejected shape: a window that begins mid tool-round.
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "calc", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "42" },
      { role: "user", content: "terus?" },
    ];
    const { body } = await captureBody(messages);
    const sent = body.messages.filter((m) => m.role !== "system");
    expect(sent.length).toBeGreaterThan(0);
    const head = sent[0];
    expect(head.role).not.toBe("assistant");
    expect(head.tool_calls?.length ?? 0).toBe(0);
    // The tool result that answered the dropped turn must not stay behind as
    // an orphan — strict gateways reject it with "role 'tool' must be a
    // response to a preceding message with 'tool_calls'".
    expect(sent.some((m) => m.role === "tool")).toBe(false);
  });

  it("leaves a healthy window untouched", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "halo" },
      { role: "assistant", content: "hai" },
      { role: "user", content: "lagi" },
    ];
    const { body } = await captureBody(messages);
    const sent = body.messages.filter((m) => m.role !== "system");
    expect(sent.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });
});
