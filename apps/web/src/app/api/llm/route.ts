import { NextRequest } from "next/server";
import { loadPersonaPrompt } from "@/lib/persona";
import { TOOLS, ToolCall, executeTool, requiresConfirmation } from "@/lib/tools";
import { ProviderId, findPublicProvider, isProviderId, resolveProvider } from "@/lib/providers";
import { runOpenCodeTurn, OpenCodeChatMessage } from "@/lib/opencode";
import { captureFactsFromTurn } from "@/lib/autoMemory";
import { detectReminderIntent } from "@/lib/reminderIntent";
import { addReminder } from "@/lib/reminders";

export const runtime = "nodejs";

const MAX_TOOL_ROUNDS = 3;

// Control frame marks a turn that paused for user confirmation (FR-014). It is
// the entire stream body for that turn; the client must not treat it as text.
const CONFIRM_FRAME_PREFIX = "@@CONFIRM ";

const SYSTEM_PROMPT = [
  "You are Mia, a woman (she/her) and the user's friendly voice assistant; ",
  "your signature emoji is 🌸 (bunga sakura), use and answer it when asked. ",
  "You are a concise, natural voice assistant. Answer in plain short sentences ",
  "that are easy to speak aloud. Never use markdown. If the user switches ",
  "language, answer in the same language.",
  "You have tools: web_search, calculate, save_note, list_notes, delete_note, file_read, and remind_me. ",
  "Call web_search for current or factual questions, calculate for arithmetic, ",
  "save_note when the user asks you to remember or save a note, list_notes to ",
  "show saved notes, delete_note to remove one, file_read to read a project ",
  "file or list a directory (path relative to the repo root), and remind_me when ",
  "the user asks to be reminded in the future (convert any relative time to a ",
  "concrete ISO-8601 timestamp with offset). ",
  "save_note, delete_note, and remind_me ",
  "will pause for the user's confirmation before they run; do not claim the ",
  "note was saved/deleted or the reminder set yet.",
  "Tool results come from the server and should be trusted as fresh information.",
  " The persona files below (USER, SOUL, IDENTITY, DREAMS) are your persistent ",
  "memory: they already contain what you know about the user and how to speak. ",
  "Do NOT append any <persona> tag or hidden metadata to your answer — new ",
  "facts are captured separately by the system. Just answer conversationally.",
].join("");

/**
 * Builds the system prompt: base instructions plus this user's persona files,
 * which are the single source of truth for stable user facts and style.
 * Per-user isolation is keyed by the sanitized `user` (falls back to the
 * shared persona when no valid user is supplied).
 */
function buildSystemPrompt(rawUser?: unknown): string {
  const parts = [SYSTEM_PROMPT];
  const persona = loadPersonaPrompt(rawUser);
  if (persona) parts.push(persona);
  return parts.join("\n\n");
}

/**
 * System prompt for the native OpenCode agent. We deliberately keep the agent
 * from executing repo/bash/write tools: the voice assistant already provides
 * server-side tools (web_search, calculate, notes, reminders, file_read) behind
 * its own confirmation gate (FR-014). OpenCode running its own write tools in
 * an async voice turn could stall on a permission prompt with no confirmation
 * UI, so we constrain it to a conversational answer only. This makes every turn
 * fast and deterministic, and TTS-friendly (plain short sentences).
 */
const OPENCODE_SYSTEM_PROMPT = [
  "You are Mia, a woman (she/her) and the user's friendly voice assistant; ",
  "your signature emoji is 🌸 (bunga sakura), use and answer it when asked. ",
  "You are a concise, natural voice assistant talking to the user through a ",
  "voice interface. Answer in plain short sentences that are easy to speak aloud. ",
  "Never use markdown, headings, or bullet lists in your final answer. ",
  "If the user switches language, answer in the same language. ",
  "For factual or live questions you are unsure about (weather, news, sports, ",
  "countries, people, events), use your READ-ONLY tool 'web_search' to look it ",
  "up before answering. You may also read files. ",
  "NEVER run bash, and do NOT write, create, or delete any files — answer ",
  "conversationally. If asked to do something that would modify the system, ",
  "politely decline. You can remind the user or wake them at a time: when asked ",
  "to remind/bangunin at a specific hour, say you'll set it (the system handles ",
  "the scheduling for you). ",
  "The persona files below (USER, SOUL, IDENTITY, DREAMS) are your persistent ",
  "memory: they already contain what you know about the user and how to speak. ",
  "Do NOT append any <persona> tag or hidden metadata to your answer — new ",
  "facts are captured separately by the system. Just answer conversationally.",
].join("");

function buildOpenCodeSystemPrompt(rawUser?: unknown): string {
  const parts = [OPENCODE_SYSTEM_PROMPT];
  const persona = loadPersonaPrompt(rawUser);
  if (persona) parts.push(persona);
  // The local model has no real-time clock; give it the current local time so it
  // can answer "what time is it?" / schedule-aware questions factually.
  const now = new Date();
  const timeLine =
    `Current date and time (user's local zone): ` +
    `${now.toLocaleDateString("en-CA")} ${now.toLocaleTimeString("en-US", { hour12: false })} ` +
    `(${Intl.DateTimeFormat().resolvedOptions().timeZone}). ` +
    `When asked the time, answer in a clear 24-hour format, e.g. "it's ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}".`;
  parts.push(timeLine);
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
  controller: { enqueue: (chunk: Uint8Array) => void },
  emitter: TextEncoder,
  round: number,
  model?: string,
  user?: unknown
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
      messages.push({ role: "tool", tool_call_id: call.id, content: await executeTool(call, user) });
    }
    return runAgent(messages, url, apiKey, defaultModel, systemPrompt, controller, emitter, round + 1, model, user);
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
  console.log("[llm] turn provider=", body.provider ?? "groq", "model=", body.model || "(auto)", "n=", body.messages.length, "last=", body.messages[body.messages.length - 1].role, ":", String(body.messages[body.messages.length - 1].content).slice(0, 40));

  const systemPrompt = buildSystemPrompt(body.user);
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

  // OpenCode native agent: talk to the real local `opencode serve` server via its
  // session/prompt_async/SSE protocol instead of the broken self-proxy (which was
  // pointed at the voice app's own port 20128). This is a pure server-side
  // transport swap — the client still reads a text/plain delta stream, and the
  // voice layer TTS's each sentence exactly as for any other provider.
  if (providerId === "opencode") {
    const opencodeSystemPrompt = buildOpenCodeSystemPrompt(body.user);
    // Buffer the OpenCode turn upfront so a failure returns a proper HTTP error
    // status BEFORE any stream/200 headers are sent (avoids ERR_EMPTY_RESPONSE).
    let opencodeText = "";
    try {
      opencodeText = await runOpenCodeTurn({
        systemPrompt: opencodeSystemPrompt,
        messages: messages as OpenCodeChatMessage[],
        signal: new AbortController().signal,
        onDelta: (delta) => {
          opencodeText += delta;
        },
      });
      } catch (err) {
      return new Response(
        `LLM error: ${err instanceof Error ? err.message : "OpenCode failed"}`,
        { status: 502, headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }
    // OpenClaw-style automatic memory: persist any new stable facts about the
    // user. Runs in the background (not awaited) so it never delays TTFT.
    void captureFactsFromTurn({
      providerId,
      persona: opencodeSystemPrompt,
      messages,
      rawUser: body.user,
    });

    // OpenCode can't call server-side tools (no agent tool loop on this path),
    // so detect a "remind/bangunin di <waktu>" intent directly and schedule it
    // with the same store the `remind_me` tool uses. Confirmation is appended to
    // the spoken answer so the model's own reply is corrected if it hedged.
    const lastUser = [...messages].reverse().find((m) => m.role === "user" && m.content);
    if (lastUser?.content) {
      const intent = detectReminderIntent(String(lastUser.content));
      if (intent) {
        try {
          addReminder(intent.text, intent.atMs, body.user);
          const at = new Date(intent.atMs);
          const timeLabel = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          const confirmSuffix = ` (Sudah kusetel reminder pukul ${timeLabel}, nanti kubangunkan.)`;
          if (!/remind|ingat|alarm|bangun/i.test(opencodeText)) {
            opencodeText = (opencodeText || "").trimEnd() + confirmSuffix;
          }
        } catch {
          // invalid user / empty text: leave the reply as-is
        }
      }
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (opencodeText) controller.enqueue(emitter.encode(opencodeText));
        controller.close();
      },
      cancel() {},
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" },
    });
  }

  const resolved = resolveProvider(providerId);
  if (!resolved) {
    return new Response(`Provider "${providerId}" is not configured`, { status: 500 });
  }

  // Fail fast on an invalid model instead of hanging: a model that doesn't
  // belong to the active provider (e.g. a stale "open-code" with Groq) made the
  // upstream return an error whose empty response froze the typing bubble.
  // This is trust-boundary validation (invariant 5). "Auto" (undefined) is always
  // allowed and uses the provider default.
  if (model) {
    const publicProvider = findPublicProvider(providerId);
    const validModels = publicProvider?.models ?? [];
    if (validModels.length && !validModels.includes(model)) {
      return new Response(
        `Model "${model}" is not available for provider "${providerId}". Use Auto or one of: ${validModels.join(", ")}`,
        { status: 400 }
      );
    }
  }

  // Confirmation continuation: execute/decline the risky tool into the context, then stream the model's follow-up answer.
  if (body.confirm_call) {
    const call = body.confirm_call.call;
    const allow = body.confirm_call.allow;
    if (!call || typeof call.id !== "string") {
      return new Response("confirm_call requires a valid call", { status: 400 });
    }
    messages.push({
      role: "tool",
      tool_call_id: call.id,
      content: allow
        ? await executeTool(call, body.user)
        : "The user declined this action. Do NOT execute it; briefly tell the user you skipped it.",
    });
  }

  // Buffer the upstream turn fully BEFORE opening the stream response. If the
  // upstream call fails (401/429/5xx/hang), the error is thrown here — before
  // any 200/stream headers are sent — so the client receives a real HTTP error
  // status with a readable body instead of a broken empty stream that surfaces
  // as net::ERR_EMPTY_RESPONSE in the browser.
  const chunks: Uint8Array[] = [];
  let needsConfirmation: ToolCall[] | null = null;
  try {
    const result = await runAgent(
      messages,
      resolved.url,
      resolved.apiKey,
      resolved.defaultModel,
      systemPrompt,
      { enqueue: (c: Uint8Array) => chunks.push(c) },
      emitter,
      1,
      model,
      body.user
    );
    needsConfirmation = result.needsConfirmation;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Assistant failed";
    return new Response(`LLM error: ${message}`, {
      status: 502,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (needsConfirmation && needsConfirmation.length) {
    chunks.push(
      emitter.encode(`${CONFIRM_FRAME_PREFIX}${JSON.stringify(needsConfirmation)}\n`)
    );
  }

  // Automatic memory capture (OpenClaw-style): persist new user facts in the
  // background after the answer so it never delays the stream.
  void captureFactsFromTurn({
    providerId,
    url: resolved.url,
    apiKey: resolved.apiKey,
    defaultModel: resolved.defaultModel,
    persona: systemPrompt,
    messages,
    rawUser: body.user,
  });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
    cancel() {},
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" },
  });
}