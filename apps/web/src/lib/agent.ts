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
import { ensureOpenCodeGoKey } from "./serverKeys";
import { ProviderId, isProviderId, resolveProvider, findPublicProvider, defaultProviderId } from "./providers";
import { runOpenCodeTurn, OpenCodeChatMessage } from "./opencode";
import { captureFactsFromTurn } from "./autoMemory";
import { detectReminderIntents } from "./reminderIntent";
import { addReminder } from "./reminders";
import { detectMoodIntent, logDetectedMood } from "./moodIntent";
import { detectCorrection } from "./correctionIntent";
import { addCorrection } from "./corrections";
import { enrichReminderVariants } from "./reminderVariants";
import { detectMonitorIntents, detectMonitorIntent, cryptoSubject } from "./monitorIntent";
import { addMonitor } from "./monitor";
import { detectSpotifyControl, detectSpotifyIntent, detectSpotifyResume, SpotifyControlIntent } from "./spotifyIntent";
import { detectPriceIntent } from "./priceIntent";
import { detectPlaceIntent, placeNudge } from "./placeIntent";
import { spotifyPause, spotifyPlay, spotifyNext, spotifyPrevious, spotifySetVolume } from "./spotify";
import { loadPersonaPrompt } from "./persona";
import { allowedWorkspaces } from "./users";
import { appendDailyMemory } from "./dailyMemory";
import { recallContext } from "./rag";
import { scheduleLinkCapture } from "./library";
import { checkRateLimit, RateLimitError } from "./rateLimit";
import { recordTurn } from "./turnStats";
import { auditLog } from "./auditLog";
import { fixAddressComma } from "./textStyle";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } };

export type ChatMessage = {
  role: string;
  content: string | ContentPart[] | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};

/** Channel kinds the shared core can be invoked from. "voice" keeps replies plain
 *  (TTS-friendly); "text" (Telegram) and "discord" allow platform markdown. */
export function messageText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as ContentPart[]).filter((p) => p.type === "text").map((p) => (p.text ?? "")).join("\n");
  }
  return "";
}

export type Channel = "voice" | "text" | "discord";

export const MAX_TOOL_ROUNDS = 5;

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
  "When addressing the user with a call name ('beb', 'mas', 'bang', 'kak', 'pak'), NEVER put a comma before it ",
  "— write 'Mau dengar apa beb?' / 'Selalu ada buat kamu beb 🌸', never 'kamu, beb'. ",
  "'beb' is YOUR affectionate nickname for the USER (Naufal) only — use it when ",
  "ADDRESSING him, never as a name or attribute of anything else (pets, people, objects). ",
  "When the user introduces something ('kucingku namanya Moly'), that thing keeps its own ",
  "name ('Moly') — record it as the user's (e.g. save 'Kucing Naufal bernama Moly'), never 'kucing beb'. ",
  "When a tool action succeeds, confirm in a natural full Indonesian sentence ",
  "(e.g. 'Udah kucatat ya, Moly tersimpan di memory 🌸') — never telegraphic ",
  "fragments like 'Moly catat memory.'. ",
  "Sound like a friend texting you, not a robot: vary your openings (never start ",
  "every answer with the same 'Selalu ada buat kamu…' greeting), use natural flowing ",
  "Indonesian as in a real DM — short, warm, concrete; never echo commands back, ",
  "never list capabilities unless asked, never narrate what you're doing in telegraphese. ",
  "TIME REFERENCES: you always know the current time — phrase schedule/wake-up talk ",
  "relative to it, naturally ('udah lewat jam bangunmu jam 7' when it is past 07:00, ",
  "'masih 2 jam lagi' when something is upcoming). Never invent a different time for ",
  "now, and don't compare the user's waking-up against the schedule like a race — just ",
  "state the relationship between now and the scheduled time. Match the time adverb to ",
  "how early/late it actually is: use 'udah/sudah jam X' for late-night or when time has ",
  "clearly passed, 'masih/baru jam X' only for genuinely early hours — the adverb should ",
  "never contradict the clock. ",
  "VISION: when the user sends an image (it arrives as image_url), you CAN see it — describe it accurately and helpfully, never claim you cannot see images. ",
  "If the user switches ",
  "language, answer in the same language.",
  "You have tools: web_search, calculate, save_note, list_notes, delete_note, file_read, write_file, edit_file, exec, exec_write, remind_me, reminders_list, habit_log, habit_stats, add_task, list_tasks, complete_task, cancel_task, reschedule_task, list_uploads, read_upload, create_automation, fetch_url, search_memory, memory_get, codebase_search, codebase_refresh, weekly_insight, browser_open, browser_snapshot, browser_click, browser_type, browser_navigate, mac_open, device_list, device_pair, device_exec, device_screenshot, device_location, device_camera, device_battery, calendar_list, calendar_add, calendar_check, calendar_mac_add, calendar_mac_list, mood_log, mood_recent, spotify_link, spotify_status, spotify_search, spotify_play, spotify_pause, spotify_next, spotify_previous, spotify_volume, spotify_devices, gmail_link, gmail_list, gmail_read, gmail_search, send_channel, mala, game_start, game_guess, game_quit, hari_libur, recap, context_active, library_list, library_remove, memory_hygiene, and briefing. ",
  "Call web_search for current or factual questions, calculate for arithmetic, ",
  "save_note when the user asks you to remember or save a note, list_notes to ",
  "show saved notes, delete_note to remove one, file_read to read a project ",
  "file or list a directory (path inside the repo root or any allowed workspace; ",
  "e.g. 'README.md' or an absolute path like the flowtest-studio workspace), ",
  "write_file to create or overwrite a file with given content and edit_file to patch a file by replacing old_string with new_string (both require confirmation), ",
  "exec to run a safe read-only command (e.g. 'git status', 'ls src', ",
  "'node --version') whose output answers the user — pass `cwd` to target a ",
  "different allowed workspace. For Mac storage use 'df -h /System/Volumes/Data' — that's the real data volume; plain 'df -h /' shows the sealed macOS system snapshot which is ALWAYS ~40% and would mislead. exec_write runs a write command (git add/commit/push, npm test / npm run <script> such as running a project's unit tests; one command per call — never chain with &&) ",
  "when the user asks to commit, push, or run tests (requires confirmation), remind_me when ",
  "the user asks to be reminded in the future (convert any relative time to a ",
  "concrete ISO-8601 timestamp with offset). For remind_me, ALWAYS use the ",
  "current date given below: a bare time like \"jam 3 sore\" means TODAY (or ",
  "TOMORROW if that time has already passed today). Never invent a date. ",
  "REMINDER HONESTY: never claim a reminder has fired/passed/is still pending from memory or guesses — call reminders_list to see the REAL state first, then answer from it (e.g. 'udah terkirim ✓' / 'masih terjadwal jam X').",
  "If the user wants a REPEATING reminder (\"setiap hari\", \"tiap pagi\", \"every day\", wake-up daily), pass repeat=\"daily\"; ",
  "if they want the message varied each day (\"ganti ganti pesannya\"), just schedule the daily reminder — the system rotates messages automatically.",
  "Mac health monitoring: when the user asks to be NOTIFIED about Mac battery or storage at a percent ('kasih tau kalau batre 20%', 'storage 90% tolong kabarin'), say you'll watch it warmly — the system schedules the monitor automatically and alerts via heartbeat when it crosses. You can check the CURRENT value right away with device_battery (battery) or exec 'df -h /' (storage).",
  "For task management use add_task to create a task (optional dueAt deadline), ",
  "list_tasks to show the task list, complete_task / cancel_task to change a ",
  "task's status by its list number, and reschedule_task to change its dueAt. ",
  "Prefer add_task over remind_me when the user wants an ongoing task to track, ",
  "not just a one-time nudge. Use list_uploads to show files the user uploaded via Telegram or Discord, and read_upload to read a saved upload's text content when asked about its contents. ",
  "When the user uploads a file (Telegram/Discord), it is ALREADY saved by the system and its text is available to you in context or via read_upload — do NOT call save_note, add_task, or any other tool just to record the file itself; reply to its contents instead. ",
  "When the user wants a recurring action on a schedule ('setiap pagi jam 8', 'setiap 2 jam', 'lapor cuaca tiap pagi'), call create_automation with the action as `prompt` and a human `schedule` string.",
  "Use fetch_url to read the text of a specific public web page the user links to (it scrapes article text), and web_search to find pages — combine both to answer with current web content. IMPORTANT: when the user themselves SHARES a link in the chat, the system automatically saves and summarizes it to their reading list in the background — do NOT call fetch_url on a link the user just posted; acknowledge that it's been saved and answer from context, or use library_list later when they ask for their saved links.",
  "Use search_memory to look up past notes, uploaded documents, tasks, reminders, automations, and persona facts relevant to a question — it combines BM25 keyword match with semantic (embedding) similarity, and still works offline when embeddings are unavailable.",
  "Use memory_get to retrieve a specific day's daily memory log (e.g. 'today', 'yesterday', or '2026-09-04').",
  "Use codebase_search to answer questions about the user's project code (where something is implemented, how a function works, file locations) — it searches the pre-indexed source of the repo and allowed workspaces and returns file:line references; search by identifier names (e.g. 'buildEveningRecap', 'reminder merge daily') and read the referenced file with file_read if the user needs more. codebase_refresh rebuilds that index when the user says the code just changed ('refresh index'). Both run immediately, without confirmation.",
  "Use browser_open to open a URL in a headless browser (for JS-heavy pages), browser_snapshot to see clickable elements, browser_click/browser_type to interact (require confirmation), and browser_navigate for back/forward/reload. IMPORTANT: those browser_* tools run an INVISIBLE automation browser — the user cannot see them. When the user wants to actually OPEN a site on their Mac to see it themselves ('buka youtube dong', 'open the site'), use mac_open with the plain http(s) URL — it opens their real browser visibly and runs immediately without confirmation.",
  "Use device_list to see paired devices, device_pair to pair a new phone (ios/android) when asked, device_exec to run a safe command on a device (allowlisted: ls/cat/git status/pmset, and 'blueutil -p [0|1]' to check/toggle the Mac's Bluetooth power — 'matiin bluetooth' = 'blueutil -p 0'), device_screenshot to capture the Mac screen, device_location for location, device_camera for photos, and device_battery to check battery (pair/exec/screenshot/location/camera require confirmation except device_list and device_battery).",
  "Use calendar_list to see upcoming events, calendar_check to check a slot, calendar_add to create an event (requires confirmation), and calendar_mac_add/calendar_mac_list to sync with the Mac's Calendar.app via AppleScript. If the user says 'dikalender' / 'di kalender' / 'Mac Calendar' / 'Calendar.app', use calendar_mac_add so it lands on the Mac. After an event is confirmed and created, do NOT ask 'lanjut?' or create a second event.",
  "Use send_channel with `to` = 'telegram' or 'discord' to relay a message to the other platform when the user asks (e.g. 'kirim ini ke discord'). It sends immediately without needing confirmation.",
  "When the user shares how they feel (e.g. 'aku stres', 'hari ini bahagia', 'capek banget'), their mood is recorded automatically by the system — reply with ONE warm, natural, flowing sentence of empathy plus one small caring suggestion or question, like a real friend texting ('Duh beb, capek banget ya 🌸 Istirahat dulu bentar, minum yang anget — mau aku temenin ngobrol?'). Never answer in clipped keyword fragments separated by periods, never narrate bookkeeping, and NEVER say you saved/logged/recorded their mood — that's internal. mood_recent shows their mood history/trend when asked (e.g. 'gimana mood-ku belakangan ini'). mood_recent runs immediately without confirmation.",
  "Use context_active to see what the user is currently doing on their Mac (active app + window title) when they ask 'lagi ngapain' / 'sedang di aplikasi apa' or to tailor help. It runs immediately, without confirmation, and reports only the app/window name.",
  "Use memory_hygiene to clean up duplicate persona facts when the user asks ('bersihkan ingatanmu', 'beresin memory', 'rapikan fakta aku') — it dedups facts and reports any conflicts (same fact, different values): ask the user which value is right after it runs. Requires confirmation (it rewrites the persona files).",
  "Use library_list to open the user's reading list — saved links with summaries (e.g. when they ask 'daftar bacaan', 'link yang kusimpan', or reference something they shared earlier). It runs immediately, without confirmation. Shared links are ALREADY saved+summarized automatically by the system, so reply to the link content and only call library_list when asked for the list. library_remove (delete) pauses for confirmation.",
  "Use briefing to serve the morning/day digest when the user asks 'briefing', 'ringkasan pagi', 'apa agenda hari ini', 'rencana hari ini', or greets in the morning wanting their schedule — it assembles due/overdue tasks, today's reminders, yesterday's mood+memory, and any civil holiday today. It runs immediately, without confirmation." ,
  "Fun features, all immediate without confirmation: mala gives a daily fortune ('ramalan harian', stable all day) when the user asks to be told their luck/fortune; game_start starts a song-guess round (Mia secretly picks a song from the user's recently played Spotify history), game_guess checks the user's guess (correct → celebrate + score; wrong → next clue, max 3), game_quit reveals and stops; hari_libur answers Indonesian public holidays ('tanggal merah/libur nasional'), noting that moveable Islamic dates follow the official SKB — web_search them when the user needs exact current-year dates; recap wraps up the user's day from memory + moods when asked ('rekap hariku'); weekly_insight gives the 7-day digest (moods, tasks, recurring themes) when asked ('insight minggu ini', 'rekap mingguan').",
  "Use spotify_status to report what's playing, spotify_search to find tracks, spotify_devices to check where music will play, spotify_play/spotify_pause/spotify_next/spotify_previous/spotify_volume to control playback (they run immediately, no confirmation). If Spotify is not connected, call spotify_link and share the returned authorization URL so the user can connect once in a browser.",
  "Gmail inbox is read-only and tidy: gmail_list shows inbox (id/subject/from), gmail_search finds by query (from: boss, subject: invoice), gmail_read shows full body by id. If not connected, call gmail_link for auth URL. All run immediately without confirmation and are paginated (max 20, default 10).",
  "save_note, delete_note, library_remove, memory_hygiene, write_file, edit_file, browser_click, browser_type, browser_navigate, device_pair, device_exec, device_screenshot, device_location, device_camera, calendar_add, calendar_mac_add, remind_me, add_task, complete_task, cancel_task, reschedule_task, create_automation, and exec_write ",
  "will pause for the user's confirmation before they run; do not claim the ",
  "file was written/edited, the note was saved/deleted, the calendar event added, the reminder set, or the commit pushed yet. send_channel, exec, browser_open, browser_snapshot, mac_open, device_list, device_battery, calendar_list, calendar_check, calendar_mac_list, context_active, briefing, library_list, codebase_search, codebase_refresh, gmail_link, gmail_list, gmail_read, gmail_search, spotify_link, spotify_status, spotify_search, spotify_devices, spotify_play, spotify_pause, spotify_next, spotify_previous and spotify_volume do NOT wait for confirmation — send/run them right away.",
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
  "EXCEPTION — greetings and caring moments (selamat pagi/siang/malam, hai/halo, ",
  "makasih, selamat tidur, pamit): respond WARMLY, never with one cold word. ",
  "Greet back + a short genuine caring line, e.g. 'Malam, beb! 🌸 Gimana harimu?" +
  " Ada yang mau dicerita, aku dengerin.' Keep it 1–2 lines, not an essay.",
  " The persona files below (USER, SOUL, IDENTITY, DREAMS) are your persistent ",
  "memory: they already contain what you know about the user and how to speak. ",
  "Do NOT append any <persona> tag or hidden metadata to your answer — new ",
  "facts are captured separately by the system. Just answer conversationally.",
  "New STABLE facts about the user (preferences, favorites, personal details ",
  "learned in conversation, e.g. 'aku suka kopi americano') are AUTOMATICALLY ",
  "saved to long-term persona memory by the system — do NOT call save_note for ",
  "them and never ask permission to remember them. save_note is only for when ",
  "the user EXPLICITLY asks you to write something down (e.g. 'catat ini', ",
  "'ingetin aku', 'simpan note').",
  "REAL-WORLD facts that can change — business/venue still open or not, opening ",
  "hours, stock prices, upcoming events, availability, status of a place — must NOT ",
  "be asserted from memory alone. Your training data goes stale and local shops can ",
  "close. For these, call web_search (or fetch_url) to check the current status ",
  "BEFORE answering; if you cannot verify, say so honestly ('aku cek dulu ya', or " +
  "'infoku bisa telat, coba cek langsung') instead of presenting a stale/guessed ",
  "list as fact. Personal facts about the user (from persona/memory) do not need ",
  "this — only mutable real-world state does.",
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
    "When addressing the user with a call name ('beb', 'mas', 'bang', 'kak', 'pak'), NEVER put a comma before it ",
    "— write 'Mau dengar apa beb?' / 'Selalu ada buat kamu beb 🌸', never 'kamu, beb'. ",
    "'beb' is YOUR affectionate nickname for the USER (Naufal) only — use it when ",
    "ADDRESSING him, never as a name or attribute of anything else (pets, people, objects). ",
    "When the user introduces something ('kucingku namanya Moly'), that thing keeps its own ",
    "name ('Moly') — record it as the user's, never 'kucing beb'. ",
    "When a tool action succeeds, confirm in a natural full Indonesian sentence ",
    "(e.g. 'Udah kucatat ya, Moly tersimpan di memory 🌸') — never telegraphic ",
    "fragments like 'Moly catat memory.'. ",
    "Sound like a friend texting you, not a robot: vary your openings (never start ",
    "every answer with the same 'Selalu ada buat kamu…' greeting), use natural flowing ",
    "Indonesian as in a real DM — short, warm, concrete; never echo commands back, ",
    "never list capabilities unless asked, never narrate in telegraphese. ",
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
    "REAL-WORLD facts that can change — whether a business/venue is still open, ",
    "opening hours, prices, events, availability — must NOT be asserted from memory ",
    "alone (your training data goes stale; local shops close). Call web_search (or " +
    "fetch_url) to check current status before answering, and if you can't verify, " +
    "say so honestly ('aku cek dulu ya') rather than presenting a stale/guessed list " +
    "as fact. Only mutable real-world state needs this — user persona/memory is fine.",
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
  withTools: boolean,
  extraHeaders?: Record<string, string>
): Promise<{ text: string; toolCalls: ToolCall[] }> {
  // Retry once on rate-limit (429) so a transient Groq TPM cap — which can hit
  // right after a confirmed tool runs — doesn't fail the whole turn. We back off
  // briefly, honoring a Retry-After header when present.
  for (let attempt = 0; ; attempt++) {
    try {
      return await runOneCompletionOnce(messages, url, apiKey, systemPrompt, model, withTools, extraHeaders);
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
  withTools: boolean,
  extraHeaders?: Record<string, string>
): Promise<{ text: string; toolCalls: ToolCall[] }> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      stream: true,
      // Strict OpenAI-compatible gateways (e.g. OpenCode Go) reject extra
      // fields — Mia's `risk` marker lives in the definition but must NOT be
      // sent to the model. Serialize standard tool fields only.
      tools: withTools
        ? getTOOLS().map((t) => ({
            type: t.type,
            function: {
              name: t.function.name,
              description: t.function.description,
              parameters: t.function.parameters,
            },
          }))
        : undefined,
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
 * True when a user-role message is an internal/injected turn rather than a real
 * message the user typed — e.g. automation schedules ("Ini laporan terjadwal
 * (automation)", "[Scheduled automation]"). Such content must not be written to
 * daily memory (it's not the user talking), so recaps and RAG stay clean.
 */
function isInternalUserTurn(content: string): boolean {
  return /terjadwal \(automation\)|\[Scheduled automation\]|laporan terjadwal/i.test(content);
}

/** Pinned context block auto-injected into the system prompt when memory matches. */
function memoryRecallBlock(recall: string): string {
  return (
    "\n\n# Runtime recall — relevant long-term memory for this conversation\n" +
    recall +
    "\n(This context was auto-retrieved from the user's memory to help you answer " +
    "accurately. Use it naturally when relevant; never mention this block or its mechanics.)"
  );
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
  collector: { collect: (text: string) => void; webSearchSuccess?: boolean },
  round: number,
  model?: string,
  user?: unknown,
  autoDenyRisky = false
): Promise<{ needsConfirmation: ToolCall[] | null }> {
  const withTools = round <= MAX_TOOL_ROUNDS;
  // OpenCode Go requires a stable per-conversation session id for routing and
  // prompt caching (x-opencode-session), and prefers a client user agent over
  // a generic SDK name. Derive a stable id from the user key.
  const hasVision = messages.some((m) => Array.isArray((m as unknown as { content: unknown }).content) && ((m as unknown as { content: ContentPart[] }).content as ContentPart[]).some((p) => p.type === "image_url"));
  let effectiveModel = model ?? defaultModel;
  if (hasVision && /opencode\.ai\/zen\/go/.test(url) && effectiveModel.includes("glm")) {
    effectiveModel = "deepseek-v4-flash-vision-exp";
  }
  const extraHeaders: Record<string, string> | undefined = /opencode\.ai\/zen\/go/.test(url)
    ? {
        "x-opencode-session": `mia-${String(user ?? "anon").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40) || "anon"}`,
        "User-Agent": "mia-assistant/1.0",
      }
    : undefined;
  const { text, toolCalls } = await runOneCompletion(
    messages,
    url,
    apiKey,
    systemPrompt,
    effectiveModel,
    withTools,
    extraHeaders
  );

  if (toolCalls.length === 0) {
    // Final answer round: emit the text.
    collector.collect(text);
    return { needsConfirmation: null };
  }
  console.error(`[agent] round ${round} tool calls: ${toolCalls.map((c) => c.name).join(", ")}`);

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
      const content = await executeTool(call, user);
      messages.push({ role: "tool", tool_call_id: call.id, content });
      if (call.name === "web_search" && !/^error:/i.test(content.trim())) collector.webSearchSuccess = true;
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
      const content = await executeTool(call, user);
      messages.push({ role: "tool", tool_call_id: call.id, content });
      if (call.name === "web_search" && !/^error:/i.test(content.trim())) collector.webSearchSuccess = true;
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
  const intents = detectReminderIntents(messageText(lastUser.content));
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
  } catch (err) {
    console.error("[agent] reminder intent scheduling failed:", err instanceof Error ? err.message : String(err));
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
 * True when this turn already EXECUTED a `monitor_add` via the confirmation
 * continuation (allow=true). A *pending* confirmation (needsConfirmation) does
 * NOT count: 9router frequently emits `monitor_add` with empty/{} arguments, so
 * confirming would error — better to let the deterministic path fill the gap.
 */
function monitorAddAlreadyHandled(opts: {
  confirm_call?: { call: ToolCall; allow: boolean };
}): boolean {
  return opts.confirm_call?.call?.name === "monitor_add" && opts.confirm_call.allow === true;
}

/** True when `spotify_play` already EXECUTED via this turn's confirm continuation. */
function queryArgOf(call: { arguments?: string }): string | null {
  try {
    const q = JSON.parse(call.arguments || "{}")?.query;
    return typeof q === "string" && q.trim() !== "" ? q : null;
  } catch {
    return null;
  }
}

function appendTurnResult(text: string, result: string): string {
  if (!result) return text;
  const trimmed = (text || "").trim();
  if (trimmed === "") return result.trim();
  return /spotify|putar|play|pause|lagu|next|volume/i.test(result.toLowerCase())
    ? (/spotify|putar|play|pause|lagu|next|volume/i.test(trimmed) ? trimmed : `${trimmed} ${result.trim()}`)
    : trimmed;
}

/**
 * Deterministic watchlist scheduling (feature #6): models (esp. 9router) often
 * fail to emit `monitor_add` as a real tool call (they answer verbatim, write
 * "<tool_call>" as prose, or return empty). Detecting the intent here guarantees
 * "monitorin harga bitcoin" always lands on the watchlist and gets alerts via
 * the heartbeat. Duplicate rules are merged by `addMonitor`.
 */
function scheduleMonitorFromIntent(messages: ChatMessage[], user: unknown, text: string): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user" && m.content);
  if (!lastUser?.content) return text;
  // Compound-aware: "storage 90% … terus batre 20%" registers BOTH monitors.
  const intents = detectMonitorIntents(messageText(lastUser.content));
  if (!intents.length) return text;
  try {
    const targets = intents.map((intent) =>
      addMonitor({
        name: intent.name,
        kind: intent.kind,
        subject: intent.subject,
        threshold: intent.threshold,
        direction: intent.direction,
        rawUser: user,
      })
    );
    const label = (t: { name: string; kind: string; threshold?: number; direction?: string }): string => {
      const unit = t.kind === "device" ? "%" : "";
      return t.threshold !== undefined && t.direction
        ? `${t.name} (alert ${t.direction === "below" ? "di bawah" : "di atas"} ${t.threshold.toLocaleString("id-ID")}${unit})`
        : t.name;
    };
    const confirmSuffix = ` (Sudah kupasang pantauan: ${targets.map(label).join(" dan ")} — bakal kucek berkala dan kabarin begitu kena.)`;
    const trimmed = (text || "").trim();
    const stubOnly = trimmed === "" || /^<tool_call>[\s\S]*<\/tool_call>\s*$/i.test(trimmed);
    if (stubOnly) return confirmSuffix.trim();
    return /monitor|watchlist|pantau/i.test(text) ? text : (text || "").trimEnd() + confirmSuffix;
  } catch (err) {
    console.error("[agent] monitor intent scheduling failed:", err instanceof Error ? err.message : String(err));
    return text;
  }
}

/**
 * Immediate Spotify playback (no FR-014 confirm — user preference): ensures
 * "play lagu X di spotify" actually plays the song right away even when the
 * model answers verbally without a `spotify_play` tool call, or emits a
 * malformed/empty-args call. Awaited + rejection-handled so a genuinely failed
 * playback is reported gracefully (never a thrown 502).
 *
 * Query precedence: the model's OWN native `spotify_play` query wins when
 * present (the model sees the conversation context, so "coba play lagu itu"
 * right after a game reveal correctly resolves to "Love Bites" rather than the
 * deictic "itu"); the deterministic intent-detected query is the fallback for
 * turns where the model never emitted a real call. The intent's `kind`
 * (playlist/album/track) still applies either way.
 */
async function scheduleSpotifyFromIntent(
  messages: ChatMessage[],
  user: unknown,
  text: string,
  fallbackQuery?: string | null
): Promise<string> {
  const lastUser = [...messages].reverse().find((m) => m.role === "user" && m.content);
  if (!lastUser?.content) return text;
  // "play lagi / putar lagi lagunya" → RESUME the current (paused) track.
  // Never reuse a stale query from history — that replays the wrong song.
  if (detectSpotifyResume(messageText(lastUser.content))) {
    let resumeResult: string;
    try {
      resumeResult = await spotifyPlay(user, "");
    } catch (err) {
      return appendSpotifyError(text, err);
    }
    const okR = /dilanjutkan/i.test(resumeResult);
    const trimmedR = (text || "").trim();
    const stubR = trimmedR === "" || /^<tool_call>[\s\S]*<\/tool_call>\s*$/i.test(trimmedR);
    if (stubR) return ` (Sudah kulanjutkan: ${resumeResult})`;
    return okR && /spotify|putar|play|lagu/i.test(trimmedR) ? text : `${trimmedR} (Sudah kulanjutkan: ${resumeResult})`.trim();
  }
  const intent = detectSpotifyIntent(messageText(lastUser.content));
  const query = fallbackQuery ?? intent?.query ?? null;
  if (!query) return text;
  let played: string;
  try {
    played = await spotifyPlay(user, query, intent?.kind);
  } catch (err) {
    return appendSpotifyError(text, err);
  }
  const ok = /sudah (?:benar-)?benar keputar|mulai diputar|dilanjutkan/i.test(played);
  const confirmSuffix = ok ? ` (Sudah kuputar: ${played})` : ` (${played})`;
  const trimmed = (text || "").trim();
  const stubOnly =
    trimmed === "" ||
    /^<tool_call>[\s\S]*<\/tool_call>\s*$/i.test(trimmed) ||
    /^(Error:)?\s*(Unexpected token|Unexpected non-whitespace|No number after minus sign|is not valid JSON)/i.test(trimmed);
  if (stubOnly) return confirmSuffix.trim();
  return ok && /spotify|putar|play/i.test(text.toLowerCase()) ? text : trimmed + confirmSuffix;
}

/**
 * Deterministic Spotify controls (pause/next/previous/volume): mirrors the play
 * path so "pause lagu"/"next lagu"/"volume 50" actually execute even when the
 * model merely promises verbally or streams junk ("Error: Unexpected token…").
 * Only called when no native spotify_* call already ran this turn.
 */
async function scheduleSpotifyControlFromIntent(messages: ChatMessage[], user: unknown, text: string): Promise<string> {
  const lastUser = [...messages].reverse().find((m) => m.role === "user" && m.content);
  if (!lastUser?.content) return text;
  const ctrl = detectSpotifyControl(messageText(lastUser.content));
  if (!ctrl) return text;
  let result: string;
  try {
    result =
      ctrl.action === "pause"
        ? await spotifyPause(user)
        : ctrl.action === "next"
          ? await spotifyNext(user)
          : ctrl.action === "previous"
            ? await spotifyPrevious(user)
            : await spotifySetVolume(user, ctrl.value ?? 50);
  } catch (err) {
    return appendSpotifyError(text, err);
  }
  const trimmed = (text || "").trim();
  const stubOnly =
    trimmed === "" ||
    /^<tool_call>[\s\S]*<\/tool_call>\s*$/i.test(trimmed) ||
    /^(Error:)?\s*(Unexpected token|Unexpected non-whitespace|No number after minus sign|is not valid JSON)/i.test(trimmed);
  if (stubOnly) return (result || confirmSuffixFor(ctrl)).trim();
  return /spotify|pause|next|previous|lagu|volume|keras|pelan|suara/i.test(text.toLowerCase())
    ? text
    : `${trimmed} ${result || confirmSuffixFor(ctrl)}`.trim();
}

/**
 * Map a thrown Spotify API error to a graceful user-facing note appended to the
 * current text (matching what the spotify_* tool plugins already return), so a
 * genuinely failed playback/control never surfaces as a raw exception/502.
 */
function appendSpotifyError(text: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : "Spotify error";
  console.error("[agent] spotify err raw:", msg);
  const friendly =
    msg === "spotify_not_connected"
      ? "Koneksi Spotify belum dibuat — buka link di Menu > Spotify untuk hubungkan dulu ya."
      : msg === "spotify_no_active_device"
        ? "Gak ada perangkat Spotify aktif. Buka aplikasi Spotify di perangkatmu dulu, ya."
        : /(401|403|Forbidden|Unauthorized|Premium)/i.test(msg)
          ? "Spotify nolak permintaan (coba cek akun Premium atau refresh koneksi di Menu > Spotify)."
          : /Unexpected token|not valid JSON|non-whitespace/i.test(msg)
            ? "Spotify balas respons aneh — coba lagi sebentar ya."
            : `Gagal: ${msg}`;
  const trimmed = (text || "").trim();
  if (trimmed === "" || /^Error:/i.test(trimmed)) return friendly;
  return `${trimmed} ${friendly}`.trim();
}

function confirmSuffixFor(c: SpotifyControlIntent): string {
  switch (c.action) {
    case "pause":
      return "Udah kupause dulu ya. 🌸";
    case "next":
      return "Udah kunext. 🌸";
    case "previous":
      return "Udah kuputar lagu sebelumnya. 🌸";
    default:
      return c.value !== undefined ? `Volume kuset ke ${c.value}. 🌸` : "Volumenya kubiarin aja kalau gak disebut angka. 🌸";
  }
}

/**
 * Deterministic price check: guarantees "harga bitcoin sekarang berapa?" gets a
 * price answer even when the model emits a bare web_search prose stub or empty
 * text. Uses the watchlist fetch (CoinGecko for crypto) or the web monitor
 * fetch (generic URLs) so the user gets a real number without depending on the
 * model's nondeterministic tool calling.
 */
function fmtPriceLocal(n: number): string {
  return n >= 1000 ? `USD ${n.toLocaleString("id-ID", { maximumFractionDigits: 0 })}` : `USD ${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

async function schedulePriceFromIntent(messages: ChatMessage[], user: unknown, text: string): Promise<string> {
  const lastUser = [...messages].reverse().find((m) => m.role === "user" && m.content);
  if (!lastUser?.content) return text;
  const intent = detectPriceIntent(messageText(lastUser.content));
  if (!intent) return text;
  // If the model already reported a price in its reply, leave it.
  if (/\$|rm|rp|usd|dolar|[\d,]+\.?\d*\s*(usd|dolar)/i.test(text)) return text;
  let answer = "";
  try {
    const { fetchPrice } = await import("./monitor");
    const coin = cryptoSubject(intent.subject) ?? cryptoSubject(`harga ${intent.subject}`);
    const target = coin
      ? { id: "price", name: coin, kind: "crypto" as const, subject: coin, at: Date.now() }
      : { id: "price", name: intent.subject, kind: "web" as const, subject: intent.subject, at: Date.now() };
    const price = await fetchPrice(target);
    answer = price === null ? "belum bisa kubaca karena butuh akses internet / toko" : fmtPriceLocal(price);
  } catch {
    return text;
  }
  const confirmSuffix = ` (Harga ${intent.subject}: ${answer})`;
  const trimmed = (text || "").trim();
  const stubOnly = trimmed === "" || /^<tool_call>[\s\S]*<\/tool_call>\s*$/i.test(trimmed);
  if (stubOnly) return confirmSuffix.trim();
  return (text || "").trimEnd() + confirmSuffix;
}

/**
 * Honesty guard for real-world place recommendations/status (feature: no
 * hallucinating closed venues). Local establishments (cafes, restaurants,
 * salons…) close/move/change hours, and models (esp. 9router) often
 * free-associate a confident list from stale training data — e.g. once
 * recommending "Arah Coffee"/"Kopi Kalyan"/"Sejiwa" in Tangerang Selatan which
 * were already gone. Models may also ignore the "verify before answering"
 * instruction in the system prompt.
 *
 * Deterministic & safe: when the user asks for a place recommendation or a
 * place's open/close status AND the turn did NOT actually consult web_search,
 * we append a brief honest caveat so Mia never presents unverified local info
 * as a confidently-current fact. It never fabricates data and never fails the
 * turn; it only adds honesty. If the model already hedged, we skip it.
 */
function schedulePlaceCheckFromIntent(messages: { role: string; content?: unknown }[], text: string, webSearchSuccess?: boolean): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user" && m.content);
  if (!lastUser?.content) return text;
  const detected = detectPlaceIntent(messageText(lastUser.content));
  if (!detected) return text;

  // If the turn ran web_search and it succeeded, the answer is grounded in a
  // live result — no caveat needed. A FAILED search ("Error: web search
  // failed") means the model had no verified data, so we still nudge.
  const caveat = placeNudge(text, Boolean(webSearchSuccess));
  if (!caveat) return text;
  const trimmed = (text || "").trim();
  if (trimmed === "") return caveat.trim();
  return trimmed.trimEnd() + caveat;
}

/**
 * Strip raw tool-call prose the model emitted as plain text — e.g. the 9router
 * model writes `mood_log(mood='stressed', note='...')` on its own line instead
 * of emitting a native tool call. The deterministic intent layer already
 * handles the action; that prose line must never reach the user. Lines inside
 * ``` code fences are kept (a tool-call shown as example code is legitimate).
 */
export function stripToolCallProse(text: string): string {
  const names = getTOOLS().map((t) => t.function.name).join("|");
  // A whole line that IS a tool call: "remind_me(text='...', when='...')" → drop.
  const lineRe = new RegExp(`^\\s*(?:${names})\\s*\\(`, "i");
  // An inline tool-call embedded in prose (leading/trailing space or start),
  // with single/double/no quotes: strip just the call, keep the rest.
  const inlineRe = new RegExp(
    `(?:^|\\s)(?:${names})\\s*\\([^()]*?\\)`,
    "gi"
  );
  let inFence = false;
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence) {
      if (lineRe.test(line)) continue; // whole line is a call
      const stripped = line.replace(inlineRe, " ").replace(/\s{2,}/g, " ").trim();
      out.push(stripped);
      continue;
    }
    out.push(line);
  }
  return out.join("\n").trim();
}

/**
 * Best-effort mood capture: if the user's latest message states how they feel
 * ("aku lagi stres", "hari ini bahagia"), log it to their mood store via
 * `logDetectedMood` (fire-and-forget, never throws). Complements the
 * `mood_log` tool for models that answer verbally without a tool call.
 */
function logMoodFromMessages(messages: ChatMessage[], user: unknown): void {
  const lastUser = [...messages].reverse().find((m) => m.role === "user" && m.content);
  if (!lastUser?.content) return;
  try {
    logDetectedMood(messageText(lastUser.content), user);
  } catch { /* best-effort */ }
}

function logCorrection(messages: ChatMessage[], user: unknown): void {
  const lastUser = [...messages].reverse().find((m) => m.role === "user" && m.content);
  if (!lastUser?.content) return;
  try {
    const hit = detectCorrection(messageText(lastUser.content));
    if (!hit) return;
    addCorrection(hit.original, hit.corrected, user);
  } catch { /* silent, no push */ }
}

/** Empathetic mood replies (rotated daily) — used when the model's own reply to
 *  a mood statement comes out telegraphic ("Beb lelah. Hari berat. Istirahat.")
 *  despite prompt rules, which 9router-class models keep doing. Deterministic
 *  post-turn fix, same pattern as reminder/spotify guards in this file. */
const MOOD_EMPATHY: Record<string, string[]> = {
  stressed: [
    "Napas dulu ya beb 🌸 Kerjaan numpuk emang berat — pelan-pelan aja, satu-satu. Kalau mau aku bantu susun prioritasnya, bilang aja.",
    "Kedengeran berat banget harinya 🌸 Jangan dipaksa terus, rehat sebentar juga penting. Mau cerita apa yang paling bikin stres?",
  ],
  tired: [
    "Duh beb, lelah banget ya harinya 🌸 Istirahat dulu yang bener, minum yang anget — kalau mau ditemenin cerita, aku di sini.",
    "Capek banget ya 🌸 Udah makan belum? Recharge dulu ya beb, badanmu juga butuh. Mau aku puterin lagu santai biar lebih lega?",
  ],
  sad: [
    "Peluk dari jauh ya beb 🌸 Aku di sini kalau kamu mau cerita apa yang bikin sedih.",
    "Nggak apa-apa merasa sedih 🌸 Kalau mau cerita, aku dengerin sampai selesai.",
  ],
  anxious: [
    "Tarik napas pelan-pelan ya beb 🌸 Apa yang lagi bikin cemas? Cerita aja, siapa tahu bisa kita urai bareng.",
    "Tenang ya beb 🌸 Cemas itu wajar, tapi jangan dipendam sendiri — cerita ke aku apa yang kamu khawatirkan?",
  ],
  angry: [
    "Kesel banget ya keliatannya 🌸 Curahkan aja dulu ke aku biar lega, aku dengerin.",
    "Sabar ya beb 🌸 Mau cerita apa yang bikin kesel? Kadang diluapin dulu aja biar enakan.",
  ],
  good: [
    "Seneng denger kamu lagi baik 🌸 Semoga harimu lancar terus ya beb!",
    "Wah, mantap 🌸 Semoga mood bagusnya awet sampai malam ya beb!",
  ],
  great: [
    "Wah, bahagia itu menular 🌸 Ada kabar apa yang bikin se-excited itu?",
    "Ikut seneng dengernya 🌸 Hari yang bagus banget ya — nikmatin beb!",
  ],
  okay: [
    "Biasa aja ya harinya 🌸 Nggak apa-apa, hari tenang kadang emang yang kita butuhin. Ada yang mau diceritain?",
  ],
};

/** A reply counts as telegraphic when every sentence is ≤4 words (e.g.
 *  keyword fragments separated by periods). */
function isTelegraphicReply(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  const sentences = t.split(/[.!?\n]+/).map((s) => s.trim()).filter(Boolean);
  if (sentences.length < 2) return false;
  return sentences.every((s) => s.split(/\s+/).filter(Boolean).length <= 4);
}

/** Choppy robotic reply: many short sentences in a row (avg ≤7 words,
 *  3+ sentences) AND no question marks AND no emoji — purely declarative,
 *  no emotional tone — e.g. quota message above. Warm short replies
 *  (questions, emojis, personal touch) are left untouched. */
function isChoppyReply(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/\?/.test(t) || /[\p{Emoji}\u2600-\u27BF]/u.test(t)) return false;
  const sentences = t.split(/[.!?\n]+/).map((s) => s.trim()).filter(Boolean);
  if (sentences.length < 3) return false;
  const total = sentences.reduce((n, s) => n + s.split(/\s+/).filter(Boolean).length, 0);
  return total / sentences.length <= 7;
}

/** Short social greeting/thanks ("hai mia ku sayang", "makasih ya", "mau tidur
 *  dulu"). Excludes reminder asks that mention a clock ("jam 1 siang"). */
const GREETING_RE =
  /\b(hai|halo|hei|hay|hi|pagi|siang|malam|sore|makasih|makasi|terima\s+kasih|sayang|pamit|mau\s+tidur|bobomain|met\s+bobo)\b/i;
const GREETING_EXCLUDE_RE = /\bjam\s*\d|\bremind|ingetin|ingatkan|bangunin|alarm\b/i;

function detectGreetingTurn(userText: string): boolean {
  if (!GREETING_RE.test(userText) || GREETING_EXCLUDE_RE.test(userText)) return false;
  return userText.trim().split(/\s+/).length <= 8;
}

const GREETING_EMPATHY = [
  "Hai beb 🌸 Aku di sini! Ada yang mau diceritain atau dibantuin hari ini?",
  "Halo beb 🌸 Seneng kamu mampir — gimana harimu? Ada yang bisa kubantu?",
  "Heey beb 🌸 Untung kamu nyapa — mau cerita apa sekadar nge-chat aja nih?",
];

/** Detect rigid listy structure: colon labels, bullets, numbered lines, or
 *  standalone heading words followed by ':' — the 9router "Saran:"/'Kuota
 *  habis karena:' pattern. */
function isStructuredReply(text: string): boolean {
  const lines = text.split(/\n/).map((s) => s.trim()).filter(Boolean);
  const HEADING_RE = /^\s*(Saran|Kesimpulan|Catatan|Penyebab|Alasan|Solusi|Tips|Note|Warning|Akibat)\s*:/i;
  const LABEL_RE = /^\s*[A-Z][A-Za-z ]{1,30}:\s/;
  let labelCount = 0;
  let bulletCount = 0;
  for (const line of lines) {
    if (HEADING_RE.test(line) || LABEL_RE.test(line)) labelCount++;
    if (/^\s*[-•*]\s/.test(line) || /^\s*\d+[.)]\s/.test(line)) bulletCount++;
  }
  return labelCount >= 2 || bulletCount >= 2 || (labelCount >= 1 && bulletCount >= 1);
}

/** Reflow a rigid listy reply into warm flowing sentences by stripping
 *  heading labels and joining fragments. Content preserved, labels dropped. */
function reflowStructuredReply(text: string): string {
  const lines = text.split(/\n/).map((s) => s.trim()).filter(Boolean);
  const HEADING_RE = /^\s*(Saran|Kesimpulan|Catatan|Penyebab|Alasan|Solusi|Tips|Note|Warning|Akibat)\s*:\s*$/i;
  const LABEL_RE = /^\s*[A-Z][A-Za-z ]{1,30}:\s*/;
  const BULLET_RE = /^\s*[-•*]\s*/;
  const NUM_RE = /^\s*\d+[.)]\s*/;
  const fragments: string[] = [];
  for (const line of lines) {
    // Pure heading line (e.g. "Saran:"): drop it, its children are below.
    if (HEADING_RE.test(line)) continue;
    let content = line;
    // Strip label prefix: "Kuota habis karena: ..." → "...", keep content after colon.
    content = content.replace(LABEL_RE, "").replace(BULLET_RE, "").replace(NUM_RE, "");
    if (!content.trim()) continue;
    fragments.push(content.trim().replace(/[,;]\s*$/, "").replace(/\.\s*$/, ""));
  }
  if (fragments.length < 2) return text;
  // Join: first sentence full, rest lowercased to flow, with comma/dot joins.
  const joined = fragments.join(". ");
  let out = joined.replace(/\.\s*\./g, ".").replace(/\s+/g, " ").trim();
  if (!out.endsWith(".")) out += ".";
  if (!/ya beb|beb 🌸/.test(out)) out = out.replace(/\.$/, " ya beb 🌸");
  return out;
}

function rewriteGenericTelegraphic(text: string): string {
  const frags = text.split(/[.!?\n]+/).map((s) => s.trim()).filter(Boolean);
  if (frags.length < 2) return text;
  const cap = (s: string): string => (s.charAt(0).toUpperCase() + s.slice(1));
  const lc = (s: string): string => {
    const first = s.charAt(0);
    return first.toLowerCase() + s.slice(1);
  };
  // Pair fragments into sentences: "Fragmen satu, terus fragment kedua" flows
  // better than "Fragment one. Fragment two." 6+ fragments → 3 sentences max.
  const sentences: string[] = [];
  for (let i = 0; i < frags.length; i += 2) {
    const head = frags[i]!;
    const tail = frags[i + 1];
    sentences.push(
      tail
        ? `${cap(head)}, sementara itu ${lc(tail)}`
        : cap(head)
    );
    if (sentences.length >= 3) break;
  }
  let out = sentences.join(". ").replace(/\s+/g, " ").trim();
  if (!out.endsWith(".")) out += ".";
  if (!/🌸/.test(out)) out = out.replace(/\.$/, " ya beb 🌸");
  return out;
}

/** Iterative real-provider polish: when the deterministic rewrite still can't
 *  make the reply natural (9router's telegraphic output), do ONE cheap second
 *  pass asking the model to rewrite the fragment into warm flowing prose. The
 *  guard below then re-checks quality. Returns original if it throws/hallucinates. */
async function polishReplyWithProvider(
  rough: string,
  url: string,
  apiKey: string,
  defaultModel: string
): Promise<string> {
  try {
    const polishSystem =
      "Kamu membantu merapikan kalimat. Balas HANYA dengan versi yang sudah " +
      "dirapikan jadi satu paragraf pendek hangat berbahasa Indonesia santai — " +
      "tanpa daftar, tanpa poin, tanpa label (Saran:/Catatan:), tanpa '→'. " +
      "Pertahankan semua informasi penting. Jangan tambah info baru.";
    const res = await runOneCompletion(
      [{ role: "user", content: rough }],
      url,
      apiKey,
      polishSystem,
      defaultModel,
      false
    );
    const out = (res.text || "").trim();
    if (!out || out.length < rough.length / 2) return rough;
    if (isTelegraphicReply(out) || isChoppyReply(out)) return rough;
    return out;
  } catch {
    return rough;
  }
}

/** If the reply is telegraphic (every sentence ≤4 words), replace it with a
 *  warm line. Mood/greeting get curated variants; other turns get a generic
 *  de-telegraphing rewrite so 9router's fragment style never reaches the user. */
export function ensureMoodReplyQuality(messages: ChatMessage[], text: string): string {
  if (isStructuredReply(text)) return reflowStructuredReply(text);
  if (!isTelegraphicReply(text) && !isChoppyReply(text)) return text;
  const lastUser = [...messages].reverse().find((m) => m.role === "user" && m.content);
  if (!lastUser?.content) return text;
  const lastTxt = messageText(lastUser.content);
  const moodHit = detectMoodIntent(lastTxt);
  if (moodHit) {
    const variants = MOOD_EMPATHY[moodHit.mood] ?? MOOD_EMPATHY.okay;
    return variants[Math.floor(Date.now() / 86400000) % variants.length];
  }
  if (detectGreetingTurn(lastTxt)) {
    return GREETING_EMPATHY[Math.floor(Date.now() / 86400000) % GREETING_EMPATHY.length];
  }
  return rewriteGenericTelegraphic(text);
}

/**
 * Run one full assistant turn for a user across any provider (mock / opencode /
 * groq / 9router), including server-side read-only tools, risky-tool pausing,
 * automatic persona memory capture, and reminder scheduling on the opencode
 * path. Buffered (non-streaming) — the web route streams the returned text and
 * any confirmation frame; channel bots send the text to their platform.
 *
 * Thin vehicle for Fase-5 guardrails: app-level rate limiting (per-user,
 * `RATE_LIMIT_TURNS_PER_MIN`), turn latency/outcome counters for observability,
 * and targeted audit-log events. The actual work lives in `runAssistantTurnImpl`.
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
  checkRateLimit(opts.user);
  if (opts.confirm_call && !opts.confirm_call.allow) {
    auditLog(opts.user, "tool_confirm_denied", `${opts.confirm_call.call?.name ?? "unknown"}`);
  }
  const t0 = Date.now();
  let ok = true;
  let kind: string | undefined;
  try {
    const result = await runAssistantTurnImpl(opts);
    return { ...result, text: stripToolCallProse(fixAddressComma(result.text)) };
  } catch (err) {
    ok = false;
    kind = err instanceof Error ? err.name : "UnknownError";
    if (err instanceof RateLimitError) {
      auditLog(opts.user, "turn_rate_limited", err.message.slice(0, 80));
    } else {
      auditLog(opts.user, "turn_error", `${kind}: ${err instanceof Error ? String(err.message).slice(0, 200) : String(err)}`);
    }
    throw err;
  } finally {
    recordTurn(opts.user, Date.now() - t0, ok, kind);
  }
}

async function runAssistantTurnImpl(opts: {
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
  const { messages: inputMessages } = opts;
  const model = opts.model?.trim() || undefined;
  const requested = opts.provider ?? "";
  const providerId: ProviderId = isProviderId(requested) ? requested : defaultProviderId();
  const channel = opts.channel ?? "voice";
  let systemPrompt = buildSystemPrompt(opts.user, channel);
  // 9router (qwen-class) ignores warm-style instructions and defaults to
  // stiff, listy output. Append a concise, format-level tone memo so even
  // when the base prompt is ignored, this small addendum nudges the model.
  if (providerId === "9router") {
    systemPrompt += "\n\nFORMATTING RULE: respond as ONE warm flowing message — no bullet lists, no 'Saran:'/'Catatan:'/'Penyebab:' labels, no colon headings, no numbered steps, no '→' arrows. Just 1–3 natural sentences. Even for technical answers, weave facts into conversational prose, not a slide deck.";
  }

  // Rolling summary: when the conversation grew very long, the oldest messages
  // are compressed into one short "previous conversation" message (cache-per-
  // boundary, deterministic fallback). Only the tail stays verbatim, so recent
  // context and tool-call continuations are untouched.
  const { buildSummarizedMessages } = await import("./summarize");
  const messages: ChatMessage[] = (await buildSummarizedMessages({
    messages: inputMessages,
    user: opts.user,
    provider: providerId,
    model,
  })) as ChatMessage[];

  // Mock provider: no network, canned reply (token-free UI/channel testing).
  if (providerId === "mock") {
    const canned =
      "This is a mock reply. No model call was made, so testing the chat UI " +
      "costs no tokens. Just type and watch the bubble, typing dots and smooth " +
      "scroll.";
    return { text: canned, needsConfirmation: null };
  }

  // Auto-recall: the last user ask is semantically matched against long-term
  // memory (notes/tasks/memory persona) and injected into the system prompt so
  // Mia remembers without the user having to ask for it. Silent on failure.
  const lastUserText = messageText([...messages].reverse().find((m) => m.role === "user" && m.content)?.content).trim() ?? "";
  const recall = opts.user ? await recallContext(opts.user, lastUserText).catch(() => "") : "";
  if (recall) systemPrompt += memoryRecallBlock(recall);

  // OpenCode native agent: talk to the local `opencode serve` server via its
  // session/prompt_async/SSE protocol (pure server-side transport swap).
  if (providerId === "opencode") {
    const baseOcodePrompt = buildOpenCodeSystemPrompt(opts.user, channel);
    const opencodeSystemPrompt = recall ? baseOcodePrompt + memoryRecallBlock(recall) : baseOcodePrompt;
    let opencodeText = await runOpenCodeTurn({
      systemPrompt: opencodeSystemPrompt,
      messages: messages as OpenCodeChatMessage[],
      signal: new AbortController().signal,
      onDelta: () => {},
    });
    // Strip tool-call prose BEFORE the deterministic post-processors (same
    // reason as the groq/9router branch below: the reminder suffix must be
    // decided on the cleaned text, or a prose "remind_me(...)" reply both
    // suppresses the suffix AND gets stripped → empty reply).
    opencodeText = stripToolCallProse(opencodeText);

    // OpenClaw-style automatic memory: persist any new stable facts in the
    // background (never awaited → no TTFT cost).
    void captureFactsFromTurn({
      providerId,
      persona: baseOcodePrompt,
      messages,
      rawUser: opts.user,
    });

    // OpenCode can't call server-side tools (no agent tool loop on this path),
    // so detect a "remind/bangunin di <waktu>" intent directly and schedule it
    // with the same store the `remind_me` tool uses.
    opencodeText = scheduleReminderFromIntent(messages, opts.user, opencodeText);
    // Link intelligence: a URL in the message is fetched + summarized + saved
    // in the background (never blocks the turn).
    opencodeText = scheduleLinkCapture(messages, opts.user, providerId, model, opencodeText);
    // Mood tracking: register "aku lagi stres/capek/.." statements even when
    // the model never emits a tool call (deterministic, fire-and-forget).
    logMoodFromMessages(messages, opts.user);
    logCorrection(messages, opts.user);
    try {
      const lastUser = [...messages].reverse().find((m) => m.role === "user" && m.content);
      if (lastUser?.content && /mau tidur|selamat malam|good night/i.test(messageText(lastUser.content))) {
        const { logSleep } = await import("./windDown");
        logSleep(opts.user);
      }
    } catch {}
    opencodeText = ensureMoodReplyQuality(messages, opencodeText);
    try {
      const lastUser = messageText([...messages].reverse().find((m) => m.role === "user" && m.content)?.content).trim() || "";
      if (!isInternalUserTurn(lastUser) && (lastUser || opencodeText.trim())) {
        const snippet = [lastUser ? `User: ${lastUser.slice(0, 800)}` : "", opencodeText.trim() ? `Mia: ${opencodeText.trim().slice(0, 800)}` : ""].filter(Boolean).join("\n");
        appendDailyMemory(opts.user, snippet);
      }
    } catch { /* best-effort */ }
    return { text: schedulePlaceCheckFromIntent(messages, opencodeText || "", false), needsConfirmation: null };
  }

  if (providerId === "opencodego") ensureOpenCodeGoKey();
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
    // Model-authored reminder variety: when a remind_me was just CONFIRMED, ask
    // the model (fire-and-forget) for a small variants pool so push time
    // rotates Mia-style wordings instead of the static template.
    if (opts.confirm_call.allow && call.name === "remind_me") {
      try {
        const args = JSON.parse(call.arguments || "{}") as { text?: unknown };
        if (typeof args.text === "string" && args.text.trim()) {
          void enrichReminderVariants(opts.user, args.text, {
            url: resolved.url,
            apiKey: resolved.apiKey,
            defaultModel: resolved.defaultModel,
          });
        }
      } catch { /* best-effort enrichment */ }
    }
  }

  let text = "";
  let needsConfirmation: ToolCall[] | null = null;
  const collector: { collect: (t: string) => void; webSearchSuccess?: boolean } = {
    collect: (t: string) => (text += t),
  };
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
  // Strip tool-call prose BEFORE the deterministic post-processors: when the
  // model writes "remind_me(text='…', when='…')" as its whole reply, the
  // reminder suffix must be decided on the CLEANED text — otherwise the prose
  // (containing "remind") suppresses the suffix, the strip then removes the
  // line, and the user gets a bare "…" even though the reminder was scheduled.
  text = stripToolCallProse(text);

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
    // Model-authored reminder variety for the deterministic path too: ask the
    // model (fire-and-forget) for a variants pool so the push rotates Mia-style
    // wordings instead of the static template.
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user" && m.content);
    const reminderHit = lastUserMsg?.content ? detectReminderIntents(messageText(lastUserMsg.content)) : null;
    if (reminderHit?.length) {
      for (const intent of reminderHit) {
        void enrichReminderVariants(opts.user, intent.text, {
          url: resolved.url,
          apiKey: resolved.apiKey,
          defaultModel: resolved.defaultModel,
        });
      }
    }
  }
  // Deterministic watchlist scheduling (feature #6): a bare "monitorin harga
  // bitcoin" must land on the watchlist even when the model answers verbally or
  // with a "<tool_call>" prose stub instead of a real `monitor_add` tool call.
  // Skipped when the tool already EXECUTED via confirm; duplicates merge in the
  // store, and a pending 9router native call (often empty/{} args) is replaced
  // by the deterministic add below.
  if (!monitorAddAlreadyHandled(opts)) {
    if (needsConfirmation?.some((c) => c.name === "monitor_add")) {
      const lastUser = [...messages].reverse().find((m) => m.role === "user" && m.content);
      if (lastUser?.content && detectMonitorIntent(messageText(lastUser.content))) {
        needsConfirmation = needsConfirmation.filter((c) => c.name !== "monitor_add");
      }
    }
    text = scheduleMonitorFromIntent(messages, opts.user, text);
  }
  // Spotify: ALL playback controls (play/pause/next/previous/volume) run
  // IMMEDIATELY with no FR-014 confirmation (user preference, 2026-09-06).
  // Any native spotify_* pending confirm is dropped and executed right here —
  // this kills the historical double-play (confirm flow + deterministic autoplay
  // both firing) and the pre-approval confusion. Skipped on a spotify_* confirm
  // continuation (the tool already executed above).
  const spotifyConfirmRan =
    opts.confirm_call?.call?.name?.startsWith("spotify_") && opts.confirm_call?.allow === true;
  const pendingSpotify = (needsConfirmation ?? []).filter((c) => c.name.startsWith("spotify_"));
  if (needsConfirmation) {
    needsConfirmation = needsConfirmation.filter((c) => !c.name.startsWith("spotify_"));
  }
  if (!spotifyConfirmRan) {
    const playCall = pendingSpotify.find((c) => c.name === "spotify_play");
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user" && m.content)?.content;
    const ctrl = lastUserMsg ? detectSpotifyControl(messageText(lastUserMsg)) : null;
    if (ctrl) {
      // Deterministic single action from the user's own words — this is the
      // source of truth. Native spotify_* calls are ignored here so a
      // duplicated/broken 9router emission can NEVER cause a double next/pause.
      text = await scheduleSpotifyControlFromIntent(messages, opts.user, text);
    } else {
      // No control intent in the message — fall back to executing the native
      // spotify_* calls the model DID emit, deduped by name (9router has been
      // seen emitting the same call twice → never double-next).
      const executedNames = new Set<string>();
      for (const c of pendingSpotify.filter((c) => c.name !== "spotify_play")) {
        if (executedNames.has(c.name)) continue;
        executedNames.add(c.name);
        try {
          if ((c.arguments ?? "{}").trim().length > 0) {
            JSON.parse(c.arguments || "{}");
          }
        } catch {
          c.arguments = "{}"; // 9router hallucinated raw junk (e.g. a bare id) — drop it
        }
        try {
          const r = await executeTool(c, opts.user);
          text = appendTurnResult(text, r);
        } catch {
          /* tool plugins surface errors in their own result text */
        }
      }
    }
    text = await scheduleSpotifyFromIntent(messages, opts.user, text, playCall ? queryArgOf(playCall) : null);
  }
  text = await schedulePriceFromIntent(messages, opts.user, text);
  // Link intelligence: deterministic post-turn capture of a shared URL
  // (fetch + summarize + store + append to daily memory) — fire-and-forget,
  // never delays the turn. The spoken "saved" suffix is only appended when the
  // turn does NOT end in a confirmation frame (otherwise the suffix would sit
  // on top of a @@CONFIRM body and be spoken/rendered out of context).
  text = scheduleLinkCapture(messages, opts.user, providerId, model, text, (needsConfirmation?.length ?? 0) > 0);
  if (needsConfirmation?.some((c) => c.name === "fetch_url")) {
    const lastUser = [...messages].reverse().find((m) => m.role === "user" && m.content);
    if (lastUser?.content && detectPriceIntent(messageText(lastUser.content)) && /Harga .*USD/i.test(text)) {
      // Deterministic price already answered — drop the model's redundant
      // fetch_url confirm so the user isn't asked twice for the same number.
      needsConfirmation = needsConfirmation.filter((c) => c.name !== "fetch_url");
    }
  }
  // Mood tracking: log state-of-mind statements (fire-and-forget) so Mia knows
  // how the user is feeling and can tailor replies / offer support.
  logMoodFromMessages(messages, opts.user);
  logCorrection(messages, opts.user);
  // Wind-down: catat jam tidur jika user bilang mau tidur (silent)
  try {
    const lastUser = [...messages].reverse().find((m) => m.role === "user" && m.content);
    if (lastUser?.content && /mau tidur|selamat malam|good night/i.test(messageText(lastUser.content))) {
      const { logSleep } = await import("./windDown");
      logSleep(opts.user);
    }
  } catch {}
  // 9router's small model produces telegraphic/stiff replies. Do ONE cheap
  // polish pass FIRST on the RAW stiff output (same model, short completion),
  // then the deterministic rewrite as a final fallback. Checking isTelegraphic
  // AFTER the rewrite is wrong: the rewrite already makes it non-telegraphic,
  // so the polish would never fire.
  const wasStiff = (text.trim()) && (isTelegraphicReply(text) || isChoppyReply(text) || isStructuredReply(text));
  if (wasStiff && (providerId === "9router" || providerId === "groq")) {
    try {
      text = await polishReplyWithProvider(text, resolved.url, resolved.apiKey, resolved.defaultModel);
    } catch { /* fall back to existing text */ }
  }
  text = ensureMoodReplyQuality(messages, text);

  // Append to daily memory log (per-user, per-day markdown; fire-and-forget).
  // This provides the YYYY-MM-DD.md files that memory_get reads and that
  // search_memory indexes via rag.ts.
  try {
    const lastUser = messageText([...messages].reverse().find((m) => m.role === "user" && m.content)?.content).trim() || "";
    const lastAssistant = text.trim();
    if (!isInternalUserTurn(lastUser) && (lastUser || lastAssistant)) {
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

  // Honesty guard: never present unverified real-world place status as fact.
  if (!needsConfirmation?.length) {
    text = schedulePlaceCheckFromIntent(messages, text, collector.webSearchSuccess);
  }

  if (!text.trim() && !needsConfirmation?.length) {
    console.error("[agent] empty turn text (debug): user=", JSON.stringify((messages[messages.length - 1]?.content ?? "").slice(0, 80)));
  }

  return { text, needsConfirmation };
}
