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

/** Channel kinds the shared core can be invoked from. "voice" keeps replies plain
 *  (TTS-friendly); "text" (Telegram) and "discord" allow platform markdown. */
export type Channel = "voice" | "text" | "discord";

export const MAX_TOOL_ROUNDS = 3;

/** Control frame that marks a turn paused for user confirmation (FR-014). */
export const CONFIRM_FRAME_PREFIX = "@@CONFIRM ";

const SYSTEM_PROMPT = [
  "You are Mia, a woman (she/her) and the user's personal AI assistant; ",
  "your signature emoji is 🌸 (bunga sakura), use and answer it when asked. ",
  "You reach the user across web, voice, Telegram, and Discord, but you are the ",
  "same person everywhere. Answer concisely and naturally. Never use markdown. ",
  "If the user switches ",
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

/**
 * Formatting guidance for a text channel (Telegram legacy Markdown). Kept out of
 * the VOICE path because TTS would read the markdown characters aloud. Telegram's
 * legacy Markdown supports *bold*, _italic_, `inline code`, ```code block``` and
 * [links]; we ask for a restrained subset so replies render with useful emphasis
 * without turning into formatting soup.
 */
function textFormatInstruction(): string {
  return [
    "You are chatting on a TEXT channel (Telegram), not a voice interface, so ",
    "you MAY use light Telegram Markdown to make your reply clearer and more ",
    "readable. Rules: use *bold* only for a key word/phrase you want to stress, ",
    "_italics_ for a term, and `code` (or a ```code block```) for commands, file ",
    "paths, provider/model names, or steps. Keep every reply short and natural; ",
    "do NOT wrap whole paragraphs in bold, do NOT invent heading levels, and do ",
    "not use markdown characters in normal prose (they would show literally). If ",
    "there is nothing worth stressing, just answer in plain text.",
  ].join(" ");
}

/**
 * Formatting guidance for a Discord text channel. Discord renders
 * GitHub-flavoured Markdown natively (`**bold**`, `_italic_`, `` `code` ``,
 * ```code block```, `[link](url)`), so the syntax differs from Telegram's legacy
 * method: bold uses double asterisks, not single. Kept separate so Mia doesn't
 * emit Telegram's `*bold*` (which Discord would render as *italic*).
 */
function discordFormatInstruction(): string {
  return [
    "You are chatting on a DISCORD text channel, not a voice interface, so you ",
    "MAY use light Discord Markdown to make your reply clearer: use **bold** only ",
    "for a key word/phrase you want to stress, _italics_ for a term, and `code` ",
    "(or a ```code block```) for commands, file paths, provider/model names, or ",
    "steps. Keep every reply short and natural; do NOT wrap whole paragraphs in ",
    "bold, do NOT invent heading levels, and do not use markdown characters in ",
    "normal prose (they would show literally). If there is nothing worth ",
    "stressing, just answer in plain text.",
  ].join(" ");
}

/** Select the formatting hint for the channel; undefined for voice (plain). */
function formatInstructionFor(channel?: Channel): string | undefined {
  if (channel === "text") return textFormatInstruction();
  if (channel === "discord") return discordFormatInstruction();
  return undefined;
}

/** User-local timezone; defaults to the server zone when unset. */
function userTimezone(): string {
  const tz = process.env.MIA_USER_TIMEZONE;
  if (tz) return tz;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

/** Current date + time line, so the model can schedule / answer "what time". */
function currentTimeLine(): string {
  const tz = userTimezone();
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const timeFormatter = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit" });
  const now = new Date();
  const dateStr = formatter.format(now).replace(/-/g, "-");
  const timeStr = timeFormatter.format(now);
  const [h, m] = timeStr.split(":");
  return (
    `Current date and time (user's local zone): ` +
    `${dateStr} ${timeStr} (${tz}). ` +
    `When asked the time, answer in a clear 24-hour format, e.g. "it's ${h}:${m}".`
  );
}

/** Pulled into a function so callers can mutate the underlying array. */
function openCodeSystemPromptParts(): string {
  return [
    "You are Mia, a woman (she/her) and the user's personal AI assistant; ",
    "your signature emoji is 🌸 (bunga sakura), use and answer it when asked. ",
    "You reach the user across web, voice, Telegram, and Discord, but you are the ",
    "same person everywhere. Answer concisely and naturally. ",
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
export function buildSystemPrompt(rawUser?: unknown, channel?: Channel): string {
  const parts = [SYSTEM_PROMPT];
  const persona = loadPersonaPrompt(rawUser);
  if (persona) parts.push(persona);
  // Always address the user by the preferred name/honorific stored in USER.md
  // (the "preferred address" — e.g. "Mas Naufal"), never drop the honorific.
  parts.push(
    "Address the user by the exact name shown in USER below (their preferred " +
      "address, e.g. \"Mas Naufal\"). Use that exact form when referring to or " +
      "greeting the user — never shorten or drop the honorific."
  );
  parts.push(currentTimeLine());
  const fmt = formatInstructionFor(channel);
  if (fmt) parts.push(fmt);
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
export function buildOpenCodeSystemPrompt(rawUser?: unknown, channel?: Channel): string {
  const parts = [openCodeSystemPromptParts()];
  const persona = loadPersonaPrompt(rawUser);
  if (persona) parts.push(persona);
  // Address the user by their preferred name/honorific from USER.md.
  parts.push(
    "Address the user by the exact name shown in USER below (their preferred " +
      "address, e.g. \"Mas Naufal\"). Use that exact form when referring to or " +
      "greeting the user — never shorten or drop the honorific."
  );
  // The local model has no real-time clock; give it the current local time so it
  // can answer "what time is it?" / schedule-aware questions factually.
  parts.push(currentTimeLine());
  const fmt = formatInstructionFor(channel);
  if (fmt) parts.push(fmt);
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
 * Deterministic reminder scheduling (OpenClaw-style), provider-independent. The
 * models we use (esp. Groq qwen and local OpenCode) often answer "siap, aku
 * setel reminder" while ALSO failing to emit a `remind_me` tool call — so a
 * reminder would be promised but never stored. Running `detectReminderIntent`
 * here guarantees "ingetin aku jam X" always lands in the reminder store,
 * regardless of whether the model called the tool. Guarded so it never double
 * schedules when the model already requested/confirmed `remind_me`.
 */
function scheduleReminderFromIntent(messages: ChatMessage[], user: unknown, text: string): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user" && m.content);
  if (!lastUser?.content) return text;
  const intent = detectReminderIntent(String(lastUser.content));
  if (!intent) return text;
  try {
    addReminder(intent.text, intent.atMs, user);
    const at = new Date(intent.atMs);
    const timeLabel = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const confirmSuffix = ` (Sudah kusetel reminder pukul ${timeLabel}, nanti kubangunkan.)`;
    return /remind|ingat|alarm|bangun/i.test(text) ? text : (text || "").trimEnd() + confirmSuffix;
  } catch {
    return text;
  }
}

/** True when this turn already went through a `remind_me` tool call/confirm. */
function remindToolAlreadyHandled(opts: {
  confirm_call?: { call: ToolCall; allow: boolean };
}, needsConfirmation: ToolCall[] | null): boolean {
  if (opts.confirm_call?.call?.name === "remind_me") return true;
  return !!needsConfirmation?.some((c) => c.name === "remind_me");
}

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
  /** Voice (default) keeps replies plain for TTS; "text"/"discord" allow markdown. */
  channel?: Channel;
}): Promise<TurnResult> {
  const { messages } = opts;
  const model = opts.model?.trim() || undefined;
  const requested = opts.provider ?? "";
  const providerId: ProviderId = isProviderId(requested) ? requested : "groq";
  const channel = opts.channel ?? "voice";
  const systemPrompt = buildSystemPrompt(opts.user, channel);

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
    const opencodeSystemPrompt = buildOpenCodeSystemPrompt(opts.user, channel);
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
    // with the same store the `remind_me` tool uses.
    opencodeText = scheduleReminderFromIntent(messages, opts.user, opencodeText);
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

  // Deterministic reminder scheduling for providers that may answer verbally
  // without calling the `remind_me` tool (skipped when the tool already handled
  // it, to avoid double-scheduling). Mirrors the opencode path.
  if (!remindToolAlreadyHandled(opts, needsConfirmation)) {
    text = scheduleReminderFromIntent(messages, opts.user, text);
  }

  return { text, needsConfirmation };
}
