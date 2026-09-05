import { NextRequest } from "next/server";
import { ToolCall } from "@/lib/tools";
import { classifyAssistantError } from "@/lib/assistantError";
import {
  runAssistantTurn,
  CONFIRM_FRAME_PREFIX,
  ChatMessage,
} from "@/lib/agent";
import { defaultProviderId } from "@/lib/providers";

export const runtime = "nodejs";

/**
 * POST /api/llm — Streaming LLM response.
 *
 * The heavy lifting now lives in `@/lib/agent` (`runAssistantTurn`, the shared
 * core used by the web route AND the Telegram/Discord channel adapters). This
 * route is a thin HTTP wrapper: it parses the request, runs one turn against
 * the shared core, maps errors to HTTP statuses, and streams the buffered
 * result back to the browser.
 *
 * Body: `{ messages, provider?, model?, user?, confirm_call?: { call, allow } }`.
 * Keys stay server-side (invariant 5).
 */
export async function POST(request: NextRequest) {
  let body: {
    messages?: { role: string; content: string; tool_calls?: unknown; tool_call_id?: unknown }[];
    confirm_call?: { call: ToolCall; allow: boolean };
    model?: string;
    provider?: string;
    user?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return new Response("invalid JSON body", { status: 400 });
  }
  if (!body.messages?.length) {
    return new Response("missing messages", { status: 400 });
  }
  console.log("[llm] turn provider=", body.provider ?? defaultProviderId(), "model=", body.model || "(auto)", "n=", body.messages.length, "last=", body.messages[body.messages.length - 1].role, ":", String(body.messages[body.messages.length - 1].content).slice(0, 40));

  const messages = body.messages as ChatMessage[];

  let result: Awaited<ReturnType<typeof runAssistantTurn>>;
  try {
    result = await runAssistantTurn({
      messages,
      provider: body.provider,
      model: body.model,
      user: body.user,
      confirm_call: body.confirm_call,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Assistant failed";
    const cls = classifyAssistantError(err);
    // Return the user-facing message so the web UI can surface a clear
    // "token/quota exhausted" alert instead of a generic failure.
    const status =
      cls.kind === "rate_limit" ? 429
      : cls.kind === "quota" ? 402
      : message.includes("is not available for provider") ? 400
      : message.includes("is not configured") ? 500
      : 502;
    return new Response(`LLM error: ${cls.userMessage}`, {
      status,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const emitter = new TextEncoder();
  const frames: Uint8Array[] = [];
  if (result.text) frames.push(emitter.encode(result.text));
  if (result.needsConfirmation?.length) {
    frames.push(emitter.encode(`${CONFIRM_FRAME_PREFIX}${JSON.stringify(result.needsConfirmation)}\n`));
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of frames) controller.enqueue(c);
      controller.close();
    },
    cancel() {},
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" },
  });
}
