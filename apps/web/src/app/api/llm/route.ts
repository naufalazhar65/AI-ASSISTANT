import { NextRequest } from "next/server";
import { loadPersonaPrompt } from "@/lib/persona";
import { TOOLS, ToolCall, executeTool, requiresConfirmation } from "@/lib/tools";
import { ProviderId, isProviderId, resolveProvider } from "@/lib/providers";

export const runtime = "nodejs";

const MAX_TOOL_ROUNDS = 3;

// Control frame marks a turn that paused for user confirmation (FR-014). It is
// the entire stream body for that turn; the client must not treat it as text.
const CONFIRM_FRAME_PREFIX = "@@CONFIRM ";

const SYSTEM_PROMPT = [
  "You are a concise, natural voice assistant. Answer in plain short sentences ",
  "that are easy to speak aloud. Never use markdown. If the user switches ",
  "language, answer in the same language.",
  "You have tools: web_search, calculate, save_note, list_notes, and delete_note. ",
  "Call web_search for current or factual questions, calculate for arithmetic, ",
  "save_note when the user asks you to remember or save a note, list_notes to ",
  "show saved notes, and delete_note to remove one. save_note and delete_note ",
  "will pause for the user's confirmation before they run; do not claim the ",
  "note was saved or deleted yet.",
  "Tool results come from the server and should be trusted as fresh information.",
  " The persona files below (USER, SOUL, IDENTITY, DREAMS) are your persistent ",
  "memory: they already contain what you know, and you may update them. ",
  "When the user states a stable fact about themselves or asks you to change ",
  "how you speak, append a short hidden tag to the very end of your reply ",
  "formatted exactly as <persona>user.name=Naufal;soul.tone=formal</persona>. ",
  "Use user.* for facts about the user, soul.* for style preferences, and ",
  "only include something if it is not already in your persona memory.",
].join("");

/**
 * Builds the system prompt: base instructions plus the persona files, which
 * are the single source of truth for stable user facts and assistant style.
 */
function buildSystemPrompt(): string {
  const parts = [SYSTEM_PROMPT];
  const persona = loadPersonaPrompt();
  if (persona) parts.push(persona);
  return parts.join("\n\n");
}

type ChatMessage = {
  role: string;
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};

/** One streamed completion; returns accumulated text + any requested tool calls. */
async function runOneCompletion(
  messages: ChatMessage[],
  url: string,
  apiKey: string,
  systemPrompt: string,
  model: string,
  withTools: boolean
): Promise<{ text: string; toolCalls: ToolCall[] }> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      stream: true,
      tools: withTools ? TOOLS : undefined,
      tool_choice: withTools ? "auto" : undefined,
    }),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`LLM failed (${res.status}): ${detail}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  const toolCalls: (ToolCall | undefined)[] = [];

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let lineEnd;
      while ((lineEnd = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, lineEnd).trim();
        buffer = buffer.slice(lineEnd + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        let json: {
          choices?: {
            delta?: {
              content?: string | null;
              tool_calls?: {
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }[];
            };
          }[];
        };
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }
        const delta = json.choices?.[0]?.delta;
        if (delta?.content) text += delta.content;
        if (delta?.tool_calls) {
          for (const call of delta.tool_calls) {
            const index = call.index ?? 0;
            if (!toolCalls[index]) toolCalls[index] = { id: "", name: "", arguments: "" };
            if (call.id) toolCalls[index]!.id = call.id;
            if (call.function?.name) toolCalls[index]!.name += call.function.name;
            if (call.function?.arguments) toolCalls[index]!.arguments += call.function.arguments;
          }
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  return { text, toolCalls: toolCalls.filter((c): c is ToolCall => !!c) };
}

/**
 * Runs the agent loop over one user turn. Streams only the final spoken answer
 * (buffers intermediate tool-call rounds); earlier rounds produce no content.
 * If a risky (WRITE/DELETE/TRANSACTION/...) tool is requested on a fresh turn,
 * it returns those calls for confirmation instead of executing them.
 */
async function runAgent(
  messages: ChatMessage[],
  url: string,
  apiKey: string,
  defaultModel: string,
  systemPrompt: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  emitter: TextEncoder,
  round: number,
  model?: string
): Promise<{ needsConfirmation: ToolCall[] | null }> {
  const withTools = round <= MAX_TOOL_ROUNDS;
  const { text, toolCalls } = await runOneCompletion(
    messages,
    url,
    apiKey,
    systemPrompt,
    model ?? defaultModel,
    withTools
  );

  if (toolCalls.length === 0) {
    // Final answer round: stream the text.
    controller.enqueue(emitter.encode(text));
    return { needsConfirmation: null };
  }

  messages.push({
    role: "assistant",
    content: text || null,
    tool_calls: toolCalls.map((c) => ({
      id: c.id,
      type: "function" as const,
      function: { name: c.name, arguments: c.arguments },
    })),
  });

  // A fresh turn pausing on a risky tool: hand it back to the client and stop.
  const risky = toolCalls.filter((c) => requiresConfirmation(TOOLS.find((t) => t.function.name === c.name)));
  if (risky.length > 0) {
    return { needsConfirmation: risky };
  }

  // All read-only tools: execute them server-side and continue (FR-013).
  if (round < MAX_TOOL_ROUNDS) {
    for (const call of toolCalls) {
      messages.push({ role: "tool", tool_call_id: call.id, content: await executeTool(call) });
    }
    return runAgent(messages, url, apiKey, defaultModel, systemPrompt, controller, emitter, round + 1, model);
  }

  throw new Error("too many tool rounds");
}

/**
 * POST /api/llm — Streaming LLM response (PRD FR-004, FR-005, FR-013, FR-014).
 *
 * Body: `{ messages, confirm_call?: { call, allow } }`.
 *  - Normal turn: streams the final text; read-only tools auto-run; a risky
 *    tool returns a single "@@CONFIRM <json>" frame (the client must confirm).
 *  - Confirmation continuation: `confirm_call` decides execution of the risky
 *    tool whose assistant tool_calls are already in `messages`.
 * Keys stay server-side (invariant 5).
 */
export async function POST(request: NextRequest) {
  let body: {
    messages?: { role: string; content: string; tool_calls?: unknown; tool_call_id?: unknown }[];
    confirm_call?: { call: ToolCall; allow: boolean };
    model?: string;
    provider?: string;
  };
  try {
    body = await request.json();
  } catch {
    return new Response("invalid JSON body", { status: 400 });
  }
  if (!body.messages?.length) {
    return new Response("missing messages", { status: 400 });
  }

  const systemPrompt = buildSystemPrompt();
  const messages: ChatMessage[] = body.messages as ChatMessage[];
  const model = body.model?.trim() || undefined;
  const emitter = new TextEncoder();

  // Provider resolution. Defaults to Groq unless a body `provider` is given.
  // Never exposes keys to the client (invariant 5).
  const requested = body.provider ?? "";
  const providerId: ProviderId = isProviderId(requested) ? requested : "groq";

  // Mock provider: no network, canned streaming reply for token-free UI testing.
  if (providerId === "mock") {
    const canned =
      "This is a mock reply. No model call was made, so testing the chat UI " +
      "costs no tokens. Just type and watch the bubble, typing dots and smooth " +
      "scroll.";
    const stream2 = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(emitter.encode(canned));
        controller.close();
      },
    });
    return new Response(stream2, {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" },
    });
  }

  const resolved = resolveProvider(providerId);
  if (!resolved) {
    return new Response(`Provider "${providerId}" is not configured`, { status: 500 });
  }
  let started = false;

  // Confirmation continuation: execute/decline the risky tool into the context,
  // then stream the model's follow-up answer.
  if (body.confirm_call) {
    const call = body.confirm_call.call;
    const allow = body.confirm_call.allow;
    messages.push({
      role: "tool",
      tool_call_id: call.id,
      content: allow
        ? await executeTool(call)
        : "The user declined this action. Do NOT execute it; briefly tell the user you skipped it.",
    });
  }

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (started) {
        controller.close();
        return;
      }
      started = true;
      try {
        const { needsConfirmation } = await runAgent(
          messages,
          resolved.url,
          resolved.apiKey,
          resolved.defaultModel,
          systemPrompt,
          controller,
          emitter,
          1,
          model
        );
        if (needsConfirmation && needsConfirmation.length) {
          controller.enqueue(
            emitter.encode(
              `${CONFIRM_FRAME_PREFIX}${JSON.stringify(needsConfirmation)}\n`
            )
          );
        }
        controller.close();
      } catch (err) {
        controller.error(err instanceof Error ? err : new Error("Assistant failed"));
      }
    },
    cancel() {},
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" },
  });
}