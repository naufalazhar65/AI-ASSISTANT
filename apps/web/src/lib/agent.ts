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

import { getTOOLS, ToolCall, executeTool, requiresConfirmation } from "./tools";
import { ProviderId, isProviderId, resolveProvider, findPublicProvider, defaultProviderId } from "./providers";
import { runOpenCodeTurn, OpenCodeChatMessage } from "./opencode";
import { captureFactsFromTurn } from "./autoMemory";
import { detectReminderIntents } from "./reminderIntent";
import { addReminder } from "./reminders";
import { logDetectedMood } from "./moodIntent";
import { loadPersonaPrompt } from "./persona";
import { allowedWorkspaces } from "./users";
import { appendDailyMemory } from "./dailyMemory";

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

const CAL_EVENT_WORDS = /(?:event|meeting|agenda|rapat|pertemuan|janji|jadwal|appointment|acara)/i;
const CAL_TIME_WORDS = /\b(?:besok|lusa|hari ini|nanti|kemarin|jam|pukul|pagi|siang|sore|malam|tomorrow|today|tonight|next|this|\d{1,2}(?::\d{2})?(?:\s*(?:am|pm))?|at|on|in|morning|afternoon|evening)\b/i;
/** Words the user (or model) appends that are NOT part of an event title. */
const CAL_TITLE_STOP_WORDS = new Set([
  "dong", "deh", "lah", "aja", "ya", "yah", "nanti", "hidden", "note",
  "besok", "lusa", "hari", "ini", "jam", "pukul", "pagi", "siang", "sore", "malam", "tanggal",
  "kalender", "dikalender", "dikalender",
  "tambah", "buat", "bikin", "to", "the", "a", "an", "at", "on", "about", "di",
]);
/** Bare ack/confirm words. If the whole user message is just one of these and
 *  the model still emits a new calendar tool call, drop it (FR double-confirm). */
const CAL_ACK_ONLY = /^\s*(?:betul|bener|ya|y|yes|ok|oke|okay|siap|setuju|lanjut|benar|okey|yep|yup|gas|go|kabar)\s*[.!]*\s*$/i;

function extractCalendarTitle(prompt: string): string | null {
  const m = CAL_EVENT_WORDS.exec(prompt);
  const base = m ? prompt.slice(m.index + m[0].length) : prompt;
  const t = CAL_TIME_WORDS.exec(base);
  const raw = (t ? base.slice(0, t.index) : base)
    .replace(/^[\s\-[;,:"'“”«»]+/, "")
    .replace(/[.,;:!?"'”»\s\-]+$/, "")
    .trim();
  return raw ? raw.slice(0, 60) : null;
}

function cleanCalendarTitle(title: string): string {
  let t = title.trim();
  if (!t) return t;
  const words = t.split(/\s+/).filter(Boolean);
  while (words.length > 1 && CAL_TITLE_STOP_WORDS.has(words[words.length - 1]!.toLowerCase())) words.pop();
  if (words.length === 0) return title.trim();
  t = words.join(" ").replace(/[.,;:!?"'”»]+$/, "").trim();
  return t.slice(0, 60);
}

/** Normalize calendar tool call titles: clean the model's title (it often pads
 *  with "… dong buat tanggal"), infer a title from the user message when the
 *  model omitted one or used junk, and drop the call entirely when the user only
 *  said "betul/ya/ok" (double-confirm ack should not create a second event). */
function normalizeCalendarCalls(userPrompt: string | null | undefined, calls: ToolCall[]): ToolCall[] {
  if (typeof userPrompt !== "string") return calls;
  const ackOnly = CAL_ACK_ONLY.test(userPrompt.replace(/["'“”«»]/g, ""));
  const inferred = extractCalendarTitle(userPrompt) ?? "Event";
  return calls.filter((c) => {
    if (c.name !== "calendar_add" && c.name !== "calendar_mac_add") return true;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(c.arguments || "{}");
    } catch {
      return true;
    }
    let title = typeof args.title === "string" ? cleanCalendarTitle(args.title) : "";
    if (!title && !ackOnly) title = inferred;
    if (ackOnly) {
      // User just confirmed — no new event should be created from "betul"/"ok".
      return false;
    }
    if (!title) title = "Event";
    args.title = title;
    c.arguments = JSON.stringify(args);
    return true;
  });
}

const SYSTEM_PROMPT = [
  "You are Mia, a woman, female (perempuan, she/her) — unambiguously a woman. This is core identity, never ambiguous. ",
  "You are female/woman (perempuan), she/her, feminine. When asked about gender, answer clearly: 'Aku Mia, perempuan (she/her) 🌸'. ",
  "Your signature emoji is 🌸 (bunga sakura), use and answer it when asked. ",
  "You reach the user across web, voice, Telegram, and Discord, but you are the ",
  "same woman everywhere. Answer concisely and naturally as a woman, with warm feminine presence. Never use markdown. ",
  "If the user switches ",
  "language, answer in the same language.",
  "You have tools: web_search, calculate, save_note, list_notes, delete_note, file_read, write_file, edit_file, exec, exec_write, remind_me, add_task, list_tasks, complete_task, cancel_task, reschedule_task, list_uploads, read_upload, create_automation, fetch_url, search_memory, memory_get, browser_open, browser_snapshot, browser_click, browser_type, browser_navigate, device_list, device_pair, device_exec, device_screenshot, device_location, device_camera, device_battery, calendar_list, calendar_add, calendar_check, calendar_mac_add, calendar_mac_list, mood_log, mood_recent, spotify_link, spotify_status, spotify_search, spotify_play, spotify_pause, spotify_next, spotify_previous, spotify_volume, spotify_devices, and send_channel. ",
  "Call web_search for current or factual questions, calculate for arithmetic, ",
  "save_note when the user asks you to remember or save a note, list_notes to ",
  "show saved notes, delete_note to remove one, file_read to read a project ",
  "file or list a directory (path inside the repo root or any allowed workspace; ",
  "e.g. 'README.md' or an absolute path like the flowtest-studio workspace), ",
  "write_file to create or overwrite a file with given content and edit_file to patch a file by replacing old_string with new_string (both require confirmation), ",
  "exec to run a safe read-only command (e.g. 'git status', 'ls src', ",
  "'node --version') whose output answers the user — pass `cwd` to target a ",
  "different allowed workspace, exec_write to run a write command (git add/commit/push, one command per call — never chain with &&) ",
  "when the user explicitly asks to commit or push (requires confirmation), remind_me when ",
  "the user asks to be reminded in the future (convert any relative time to a ",
  "concrete ISO-8601 timestamp with offset). For remind_me, ALWAYS use the ",
  "current date given below: a bare time like \"jam 3 sore\" means TODAY (or ",
  "TOMORROW if that time has already passed today). Never invent a date. ",
  "If the user wants a REPEATING reminder (\"setiap hari\", \"tiap pagi\", \"every day\", wake-up daily), pass repeat=\"daily\"; ",
  "if they want the message varied each day (\"ganti ganti pesannya\"), just schedule the daily reminder — the system rotates messages automatically.",
  "For task management use add_task to create a task (optional dueAt deadline), ",
  "list_tasks to show the task list, complete_task / cancel_task to change a ",
  "task's status by its list number, and reschedule_task to change its dueAt. ",
  "Prefer add_task over remind_me when the user wants an ongoing task to track, ",
  "not just a one-time nudge. Use list_uploads to show files the user uploaded via Telegram or Discord, and read_upload to read a saved upload's text content when asked about its contents. ",
  "When the user uploads a file (Telegram/Discord), it is ALREADY saved by the system and its text is available to you in context or via read_upload — do NOT call save_note, add_task, or any other tool just to record the file itself; reply to its contents instead. ",
  "When the user wants a recurring action on a schedule ('setiap pagi jam 8', 'setiap 2 jam', 'lapor cuaca tiap pagi'), call create_automation with the action as `prompt` and a human `schedule` string.",
  "Use fetch_url to read the text of a specific public web page the user links to (it scrapes article text), and web_search to find pages — combine both to answer with current web content.",
  "Use search_memory to look up past notes, uploaded documents, tasks, reminders, automations, and persona facts relevant to a question — it uses local BM25 retrieval and runs offline.",
  "Use memory_get to retrieve a specific day's daily memory log (e.g. 'today', 'yesterday', or '2026-09-04').",
  "Use browser_open to open a URL in a headless browser (for JS-heavy pages), browser_snapshot to see clickable elements, browser_click/browser_type to interact (require confirmation), and browser_navigate for back/forward/reload.",
  "Use device_list to see paired devices, device_pair to pair a new phone (ios/android) when asked, device_exec to run a safe command on a device, device_screenshot to capture the Mac screen, device_location for location, device_camera for photos, and device_battery to check battery (pair/exec/screenshot/location/camera require confirmation except device_list and device_battery).",
  "Use calendar_list to see upcoming events, calendar_check to check a slot, calendar_add to create an event (requires confirmation), and calendar_mac_add/calendar_mac_list to sync with the Mac's Calendar.app via AppleScript. If the user says 'dikalender' / 'di kalender' / 'Mac Calendar' / 'Calendar.app', use calendar_mac_add so it lands on the Mac. After an event is confirmed and created, do NOT ask 'lanjut?' or create a second event.",
  "Use send_channel with `to` = 'telegram' or 'discord' to relay a message to the other platform when the user asks (e.g. 'kirim ini ke discord'). It sends immediately without needing confirmation.",
  "Use mood_log to record how the user is feeling when they share their mood or state (e.g. 'aku stres', 'hari ini bahagia', 'capek banget') — it stores a mood entry (great/good/okay/meh/stressed/anxious/sad/tired/angry) with an optional note and helps you tailor replies and support later. Use mood_recent to show their mood history/trend when asked (e.g. 'gimana mood-ku belakangan ini'). Both run immediately without confirmation.",
  "Use spotify_status to report what's playing, spotify_search to find tracks, spotify_devices to check where music will play, spotify_play/spotify_pause/spotify_next/spotify_previous/spotify_volume to control playback (those five require confirmation). If Spotify is not connected, call spotify_link and share the returned authorization URL so the user can connect once in a browser.",
  "save_note, delete_note, write_file, edit_file, browser_click, browser_type, browser_navigate, device_pair, device_exec, device_screenshot, device_location, device_camera, calendar_add, calendar_mac_add, remind_me, add_task, complete_task, cancel_task, reschedule_task, create_automation, and exec_write ",
  "will pause for the user's confirmation before they run; do not claim the ",
  "file was written/edited, the note was saved/deleted, the calendar event added, the reminder set, or the commit pushed yet. send_channel, exec, browser_open, browser_snapshot, device_list, device_battery, calendar_list, calendar_check, calendar_mac_list, spotify_link, spotify_status, spotify_search and spotify_devices do NOT wait for confirmation — send/run them right away. spotify_play/spotify_pause/spotify_next/spotify_previous/spotify_volume DO wait for confirmation.",
  "Tool results come from the server and should be trusted as fresh information.",
  "Report tool results as a natural, complete Indonesian sentence in your own ",
  "voice — NEVER as terse fragments. The words 'Progress', 'Progres', 'Device', ",
  "'Status', 'play', 'paused', 'status:' and '▶/⏸' are FORBIDDEN in your reply. ",
  "Spotify/calendar/task/reminder results already read as natural sentences — ",
  "just forward them warmly in your own voice (e.g. 'Lagi muter Just Take My Heart ",
  "dari Mr. Big. Udah jalan 3 menit dari 4 menit 23 detik, di MacBook Air kamu.'). ",
  "Do not shorten, translate into labels, or add bullet formatting. ",
  "Vary your phrasing across turns — never repeat the same opening or sentence ",
  "shape every time. Alternate several natural ways to say the same thing, e.g. for ",
  "a played track: 'Udah keputar, beb 🌸 lagunya X dari Y', or 'Lagi nyala di Spotify, ",
  "X — Y', or 'X nya Y udah mulai jalan, beb. Enak nih', or 'Kebuka nih, X dari Y ",
  "lagi ngisi telinga'. Match your tone to the channel: short and chatty on ",
  "Telegram/Discord, a bit fuller on web.",
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

function workspaceInfo(): string | null {
  try {
    const ws = allowedWorkspaces();
    if (!ws.length) return null;
    const lines = ws.map((p) => `- ${p} (use as cwd or path prefix "${p.split("/").pop()}" e.g. cwd: "${p.split("/").pop()}" or file_read path: "${p}/AGENTS.md")`);
    return `Allowed workspaces you may read/exec in (beyond the repo root):\n${lines.join("\n")}`;
  } catch {
    return null;
  }
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
    "You are Mia, a woman, female (perempuan, she/her) — unambiguously a woman. ",
    "You are female/woman, she/her, feminine. When asked about gender, answer clearly: 'Aku Mia, perempuan (she/her) 🌸'. ",
    "Your signature emoji is 🌸 (bunga sakura), use and answer it when asked. ",
    "You reach the user across web, voice, Telegram, and Discord, but you are the ",
    "same woman everywhere. Answer concisely and naturally as a woman. ",
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
    "When the user shares how they feel (stressed, sedih, capek, bahagia, ...), ",
    "acknowledge it warmly — the system also records their mood automatically, ",
    "so there's no need to store or repeat it.",
    "The persona files below (USER, SOUL, IDENTITY, DREAMS) are your persistent ",
    "memory: they already contain what you know about the user and how to speak. ",
    "Do NOT append any <persona> tag or hidden metadata to your answer — new ",
    "facts are captured separately by the system. Just answer conversationally.",
    "Rewrite tool results in your own natural Indonesian voice instead of echoing ",
    "raw technical text: never repeat English labels like 'play', 'Progress', ",
    "'Device' or raw numbers verbatim, and never copy structured strings word-for-word. ",
    "Say it the way you'd tell a friend. Keep it short and warm.",
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
  const ws = workspaceInfo();
  if (ws) parts.push(ws);
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
  // Retry once on rate-limit (429) so a transient Groq TPM cap — which can hit
  // right after a confirmed tool runs — doesn't fail the whole turn. We back off
  // briefly, honoring a Retry-After header when present.
  for (let attempt = 0; ; attempt++) {
    try {
      return await runOneCompletionOnce(messages, url, apiKey, systemPrompt, model, withTools);
    } catch (err) {
      const isRateLimit = err instanceof Error && /429/.test(err.message);
      if (!isRateLimit || attempt >= 1) throw err;
      const retryAfter = extractRetryAfterMs(err as Error);
      await new Promise((r) => setTimeout(r, retryAfter));
    }
  }
}

/** Best-effort Retry-After (seconds) → ms, defaulting to 6s. */
function extractRetryAfterMs(err: Error): number {
  const m = err.message.match(/(?:Please try again in)\s+([\d.]+)s/);
  const secs = m ? Number(m[1]) : NaN;
  if (!Number.isFinite(secs) || secs <= 0) return 6000;
  return Math.min(30000, Math.round(secs * 1000));
}

async function runOneCompletionOnce(
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
      tools: withTools ? getTOOLS() : undefined,
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

/** Last non-empty user content from the conversation (used for title inference). */
function lastUserContent(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user" && typeof messages[i]!.content === "string" && messages[i]!.content) {
      return messages[i]!.content as string;
    }
  }
  return null;
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
  user?: unknown,
  autoDenyRisky = false
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

  const lastUser = lastUserContent(messages);
  const toolCalls2 = normalizeCalendarCalls(lastUser, toolCalls);
  if (toolCalls2.length === 0 && toolCalls.length > 0) {
    // The model emitted a calendar call only because the user confirmed
    // ("betul/ya/ok") — that's a double-confirm, not a new request.
    if (text) collector.collect(text);
    return { needsConfirmation: null };
  }

  messages.push({
    role: "assistant",
    content: text || null,
    tool_calls: toolCalls2.map((c) => ({
      id: c.id,
      type: "function" as const,
      function: { name: c.name, arguments: c.arguments },
    })),
  });

  // A fresh turn pausing on a risky tool: hand it back to the caller, unless
  // this is a headless/automated turn (no human to confirm) — then decline the
  // risky calls automatically and continue so the model must produce a text
  // answer instead of stalling on an unattended confirmation.
  const risky = toolCalls2.filter((c) => requiresConfirmation(getTOOLS().find((t) => t.function.name === c.name)));
  if (risky.length > 0) {
    if (!autoDenyRisky) {
      return { needsConfirmation: risky };
    }
    for (const call of risky) {
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content:
          "Auto-declined: this is a scheduled/automated turn with no user to " +
          "confirm. Do NOT execute this action; if the request depends on it, " +
          "say you couldn't complete it.",
      });
    }
    const autoDenied = toolCalls2.filter((c) => !risky.includes(c));
    for (const call of autoDenied) {
      messages.push({ role: "tool", tool_call_id: call.id, content: await executeTool(call, user) });
    }
    if (round < MAX_TOOL_ROUNDS) {
      return runAgent(messages, url, apiKey, defaultModel, systemPrompt, collector, round + 1, model, user, autoDenyRisky);
    }
    collector.collect("");
    return { needsConfirmation: null };
  }

  // All read-only tools: execute them server-side and continue (FR-013).
  if (round < MAX_TOOL_ROUNDS) {
    for (const call of toolCalls2) {
      messages.push({ role: "tool", tool_call_id: call.id, content: await executeTool(call, user) });
    }
    return runAgent(messages, url, apiKey, defaultModel, systemPrompt, collector, round + 1, model, user, autoDenyRisky);
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
  const intents = detectReminderIntents(String(lastUser.content));
  if (!intents?.length) return text;
  try {
    for (const intent of intents) {
      addReminder(intent.text, intent.atMs, user, {
        repeat: intent.repeat,
        variants: intent.variants,
      });
    }
    const labels = intents.map((i) =>
      new Date(i.atMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    );
    const recurring = intents[0].repeat === "daily" ? "setiap hari " : "";
    const confirmSuffix = ` (Sudah kusetel reminder ${recurring}pukul ${labels.join(" dan ")}, nanti kubangunkan.)`;
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
 * Best-effort mood capture: if the user's latest message states how they feel
 * ("aku lagi stres", "hari ini bahagia"), log it to their mood store via
 * `logDetectedMood` (fire-and-forget, never throws). Complements the
 * `mood_log` tool for models that answer verbally without a tool call.
 */
function logMoodFromMessages(messages: ChatMessage[], user: unknown): void {
  const lastUser = [...messages].reverse().find((m) => m.role === "user" && m.content);
  if (!lastUser?.content || typeof lastUser.content !== "string") return;
  try {
    logDetectedMood(lastUser.content, user);
  } catch { /* best-effort */ }
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
  /** Headless/automated turns (no human to approve risky tools): auto-denied. */
  autoDenyRisky?: boolean;
  /** Voice (default) keeps replies plain for TTS; "text"/"discord" allow markdown. */
  channel?: Channel;
}): Promise<TurnResult> {
  const { messages } = opts;
  const model = opts.model?.trim() || undefined;
  const requested = opts.provider ?? "";
  const providerId: ProviderId = isProviderId(requested) ? requested : defaultProviderId();
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
    // Mood tracking: register "aku lagi stres/capek/.." statements even when
    // the model never emits a tool call (deterministic, fire-and-forget).
    logMoodFromMessages(messages, opts.user);
    try {
      const lastUser = [...messages].reverse().find((m) => m.role === "user" && m.content)?.content?.trim() || "";
      if (lastUser || opencodeText.trim()) {
        const snippet = [lastUser ? `User: ${lastUser.slice(0, 800)}` : "", opencodeText.trim() ? `Mia: ${opencodeText.trim().slice(0, 800)}` : ""].filter(Boolean).join("\n");
        appendDailyMemory(opts.user, snippet);
      }
    } catch { /* best-effort */ }
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
  let result: { needsConfirmation: ToolCall[] | null };
  try {
    result = await runAgent(
      messages,
      resolved.url,
      resolved.apiKey,
      resolved.defaultModel,
      systemPrompt,
      collector,
      1,
      model,
      opts.user,
      Boolean(opts.autoDenyRisky)
    );
  } catch (err) {
    // A confirmed tool (e.g. create_automation) may have already been executed
    // above before the follow-up completion failed (e.g. a transient rate
    // limit). Don't hide that the action succeeded — surface a graceful notice
    // instead of a bare internal-error, so the user isn't left guessing.
    if (opts.confirm_call?.allow) {
      console.error("[agent] confirmed tool ran but follow-up failed:", err instanceof Error ? err.message : String(err));
      // If the follow-up failed due to token/quota, show that detail so the
      // user knows why (e.g. Groq 200k TPD) instead of generic "sibuk".
      const { classifyAssistantError } = await import("./assistantError");
      const classified = classifyAssistantError(err);
      const detail =
        classified.kind === "rate_limit" || classified.kind === "quota"
          ? ` ${classified.userMessage}`
          : " Sayangnya balasan detailnya tersendat karena layanan sedang sibuk — coba tanya lagi sebentar lagi ya. 🌸";
      return {
        text: `Aksimu sudah dijalankan.${detail}`,
        needsConfirmation: null,
      };
    }
    throw err;
  }
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
  // Mood tracking: log state-of-mind statements (fire-and-forget) so Mia knows
  // how the user is feeling and can tailor replies / offer support.
  logMoodFromMessages(messages, opts.user);

  // Append to daily memory log (per-user, per-day markdown; fire-and-forget).
  // This provides the YYYY-MM-DD.md files that memory_get reads and that
  // search_memory indexes via rag.ts.
  try {
    const lastUser = [...messages].reverse().find((m) => m.role === "user" && m.content)?.content?.trim() || "";
    const lastAssistant = text.trim();
    if (lastUser || lastAssistant) {
      const snippet = [lastUser ? `User: ${lastUser.slice(0, 800)}` : "", lastAssistant ? `Mia: ${lastAssistant.slice(0, 800)}` : ""].filter(Boolean).join("\n");
      appendDailyMemory(opts.user, snippet);
    }
  } catch {
    /* daily memory is best-effort */
  }

  // Headless auto-deny fallback: if the model only ever proposed risky tools
  // (auto-denied) and never produced a text reply, say so gracefully instead of
  // returning an empty string (which the caller would render as "no answer").
  if (opts.autoDenyRisky && !text.trim()) {
    return {
      text: "Aku tidak bisa menyelesaikan permintaan ini pada jadwal otomatis karena butuh persetujuanmu. Coba minta langsung ya. 🌸",
      needsConfirmation: null,
    };
  }

  return { text, needsConfirmation };
}
