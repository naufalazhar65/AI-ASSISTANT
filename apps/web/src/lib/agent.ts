/**
 * Shared "assistant turn" core (server-side only).
 *
 * This is the single implementation of one conversation turn — the logic that
 * used to live inside `/api/llm/route.ts`. It is reused by BOTH the web route
 * (which streams the buffered result to the browser) and the Telegram/Discord
 * channel adapters (which send the final text back to the platform). Keeping it
 * here means every channel hits the exact same core (PRD v2.0 §7.3), so there
 * is no per-channel duplication of provider resolution, tool calling, auto
 * memory, or reminder handling.
 *
 * Keys/endpoints never reach any client (invariant 5); this module resolves
 * them from server env via `resolveProvider`.
 */

import { TOOLS, ToolCall, executeTool, requiresConfirmation } from "./tools";
import { ProviderId, isProviderId, resolveProvider, findPublicProvider } from "./providers";
import { runOpenCodeTurn, OpenCodeChatMessage } from "./opencode";
import { captureFactsFromTurn } from "./autoMemory";
import { detectReminderIntent } from "./reminderIntent";
import { addReminder } from "./reminders";
import { loadPersonaPrompt } from "./persona";

export type ChatMessage = {
  role: string;
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};

export const MAX_TOOL_ROUNDS = 3;

/** Control frame that marks a turn paused for user confirmation (FR-014). */
export const CONFIRM_FRAME_PREFIX = "@@CONFIRM ";

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
  "concrete ISO-8601 timestamp with offset). For remind_me, ALWAYS use the ",
  "current date given below: a bare time like \"jam 3 sore\" means TODAY (or ",
  "TOMORROW if that time has already passed today). Never invent a date.",
  "save_note, delete_note, and remind_me ",
  "will pause for the user's confirmation before they run; do not claim the ",
  "note was saved/deleted or the reminder set yet.",
  "Tool results come from the server and should be trusted as fresh information.",
  " The persona files below (USER, SOUL, IDENTITY, DREAMS) are your persistent ",
  "memory: they already contain what you know about the user and how to speak. ",
  "Do NOT append any <persona> tag or hidden metadata to your answer — new ",
  "facts are captured separately by the system. Just answer conversationally.",
].join("");

/** Current date + time line, so the model can schedule / answer "what time". */
function currentTimeLine(): string {
  const now = new Date();
  return (
    `Current date and time (user's local zone): ` +
    `${now.toLocaleDateString("en-CA")} ${now.toLocaleTimeString("en-US", { hour12: false })} ` +
    `(${Intl.DateTimeFormat().resolvedOptions().timeZone}). ` +
    `When asked the time, answer in a clear 24-hour format, e.g. "it's ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}".`
  );
}

/** Pulled into a function so callers can mutate the underlying array. */
function openCodeSystemPromptParts(): string {
  return [
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
}

/**
 * Builds the system prompt: base instructions plus this user's persona files,
 * which are the single source of truth for stable user facts and style.
 * Per-user isolation is keyed by the sanitized `user`.
 */
export function buildSystemPrompt(rawUser?: unknown): string {
  const parts = [SYSTEM_PROMPT];
  const persona = loadPersonaPrompt(rawUser);
  if (persona) parts.push(persona);
  parts.push(currentTimeLine());
  return parts.join("\n\n");
}

/**
 * System prompt for the native OpenCode agent. We deliberately keep the agent
 * from executing repo/bash/write tools: the assistant already provides
 * server-side tools behind its own confirmation gate (FR-014), and OpenCode
 * running its own write tools in an async turn could stall on a permission
 * prompt with no confirmation UI. So it is constrained to a conversational
 * answer (plain short sentences, TTS-friendly).
 */
export function buildOpenCodeSystemPrompt(rawUser?: unknown): string {
  const parts = [openCodeSystemPromptParts()];
  const persona = loadPersonaPrompt(rawUser);
  if (persona) parts.push(persona);
  // The local model has no real-time clock; give it the current local time so it
  // can answer "what time is it?" / schedule-aware questions factually.
  parts.push(currentTimeLine());
  return parts.join("\n\n");
}

/** One streamed completion; returns accumulated text + any requested tool calls. */
export async function runOneCompletion(
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
 * If a risky (WRITE/DELETE/...) tool is requested on a fresh turn, it returns
 * those calls for confirmation instead of executing them.
 */
async function runAgent(
  messages: ChatMessage[],
  url: string,
  apiKey: string,
  defaultModel: string,
  systemPrompt: string,
  collector: { collect: (text: string) => void },
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
    // Final answer round: emit the text.
    collector.collect(text);
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

  // A fresh turn pausing on a risky tool: hand it back to the caller.
  const risky = toolCalls.filter((c) => requiresConfirmation(TOOLS.find((t) => t.function.name === c.name)));
  if (risky.length > 0) {
    return { needsConfirmation: risky };
  }

  // All read-only tools: execute them server-side and continue (FR-013).
  if (round < MAX_TOOL_ROUNDS) {
    for (const call of toolCalls) {
      messages.push({ role: "tool", tool_call_id: call.id, content: await executeTool(call, user) });
    }
    return runAgent(messages, url, apiKey, defaultModel, systemPrompt, collector, round + 1, model, user);
  }

  throw new Error("too many tool rounds");
}

/** Result of one turn: the final assistant text + any tools awaiting confirmation. */
export type TurnResult = {
  text: string;
  needsConfirmation: ToolCall[] | null;
};

/**
 * Run one full assistant turn for a user across any provider (mock / opencode /
 * groq / 9router), including server-side read-only tools, risky-tool pausing,
 * automatic persona memory capture, and reminder scheduling on the opencode
 * path. Buffered (non-streaming) — the web route streams the returned text and
 * any confirmation frame; channel bots send the text to their platform.
 */
export async function runAssistantTurn(opts: {
  messages: ChatMessage[];
  provider?: string;
  model?: string;
  user?: unknown;
  confirm_call?: { call: ToolCall; allow: boolean };
}): Promise<TurnResult> {
  const { messages } = opts;
  const model = opts.model?.trim() || undefined;
  const requested = opts.provider ?? "";
  const providerId: ProviderId = isProviderId(requested) ? requested : "groq";
  const systemPrompt = buildSystemPrompt(opts.user);

  // Mock provider: no network, canned reply (token-free UI/channel testing).
  if (providerId === "mock") {
    const canned =
      "This is a mock reply. No model call was made, so testing the chat UI " +
      "costs no tokens. Just type and watch the bubble, typing dots and smooth " +
      "scroll.";
    return { text: canned, needsConfirmation: null };
  }

  // OpenCode native agent: talk to the local `opencode serve` server via its
  // session/prompt_async/SSE protocol (pure server-side transport swap).
  if (providerId === "opencode") {
    const opencodeSystemPrompt = buildOpenCodeSystemPrompt(opts.user);
    let opencodeText = await runOpenCodeTurn({
      systemPrompt: opencodeSystemPrompt,
      messages: messages as OpenCodeChatMessage[],
      signal: new AbortController().signal,
      onDelta: () => {},
    });

    // OpenClaw-style automatic memory: persist any new stable facts in the
    // background (never awaited → no TTFT cost).
    void captureFactsFromTurn({
      providerId,
      persona: opencodeSystemPrompt,
      messages,
      rawUser: opts.user,
    });

    // OpenCode can't call server-side tools (no agent tool loop on this path),
    // so detect a "remind/bangunin di <waktu>" intent directly and schedule it
    // with the same store the `remind_me` tool uses, appending a confirmation
    // to the answer if the model hedged.
    const lastUser = [...messages].reverse().find((m) => m.role === "user" && m.content);
    if (lastUser?.content) {
      const intent = detectReminderIntent(String(lastUser.content));
      if (intent) {
        try {
          addReminder(intent.text, intent.atMs, opts.user);
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

    return { text: opencodeText || "", needsConfirmation: null };
  }

  const resolved = resolveProvider(providerId);
  if (!resolved) {
    throw new Error(`Provider "${providerId}" is not configured`);
  }

  // Fail fast on an invalid model instead of hanging (trust-boundary validation,
  // invariant 5). "Auto" (undefined) is always allowed and uses the default.
  if (model) {
    const publicProvider = findPublicProvider(providerId);
    const validModels = publicProvider?.models ?? [];
    if (validModels.length && !validModels.includes(model)) {
      throw new Error(
        `Model "${model}" is not available for provider "${providerId}". Use Auto or one of: ${validModels.join(", ")}`
      );
    }
  }

  // Confirmation continuation: execute/decline the risky tool into the context.
  if (opts.confirm_call) {
    const call = opts.confirm_call.call;
    if (!call || typeof call.id !== "string") {
      throw new Error("confirm_call requires a valid call");
    }
    messages.push({
      role: "tool",
      tool_call_id: call.id,
      content: opts.confirm_call.allow
        ? await executeTool(call, opts.user)
        : "The user declined this action. Do NOT execute it; briefly tell the user you skipped it.",
    });
  }

  let text = "";
  let needsConfirmation: ToolCall[] | null = null;
  const collector = { collect: (t: string) => (text += t) };
  const result = await runAgent(
    messages,
    resolved.url,
    resolved.apiKey,
    resolved.defaultModel,
    systemPrompt,
    collector,
    1,
    model,
    opts.user
  );
  needsConfirmation = result.needsConfirmation;

  // Automatic memory capture in the background (never delays the turn).
  void captureFactsFromTurn({
    providerId,
    url: resolved.url,
    apiKey: resolved.apiKey,
    defaultModel: resolved.defaultModel,
    persona: systemPrompt,
    messages,
    rawUser: opts.user,
  });

  return { text, needsConfirmation };
}
