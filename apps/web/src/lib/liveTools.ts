/**
 * Tool declarations for the Gemini Live voice path (Phase B).
 *
 * The Live session speaks to Google directly, so it cannot see Mia's tool
 * registry. This module is the single owner of WHICH tools a Live session may
 * call: a small, voice-safe subset (Spotify playback control), built straight
 * from the registry definitions so the schema can never drift from what
 * `executeTool` actually runs. The custom `risk` marker is deliberately NOT
 * sent — strict gateways reject non-standard fields, and the Live API never
 * asked for it.
 *
 * Execution happens server-side in
 * `apps/web/src/app/api/gemini-live/tool/route.ts`, which re-checks every
 * call name against `LIVE_TOOL_NAMES` before dispatching. A declaration here
 * without a matching allowlist entry there executes nothing.
 */

import { getTool } from "./tools";
import { stripLiveFlower } from "./geminiLive";
import { listDailyMemories, readDailyMemory } from "./dailyMemory";
import { LIVE_WRITE_TOOLS } from "./liveConfirm";

/** Re-exported so the tool route can enforce the same set it declares. */
export { LIVE_WRITE_TOOLS };

/**
 * The only tools a Live session may invoke. Two families, both synchronous-
 * safe (measured 2026-09-30: the model is completely silent while waiting, so
 * only fast tools are safe — a minutes-long prover would be minutes of dead
 * air):
 *   - Spotify playback (each call is ~1s of API round-trip);
 *   - memory reads (`search_memory`/`memory_get`: local-disk millisecond
 *     reads, so the 31-day conversation store is searchable mid-session);
 *   - the daily cluster (owner-approved 2026-09-30, option 1): read-only
 *     personal tools — notes, tasks, reminders, calendar, mood, habits,
 *     health, weather, web search, calculator, briefing/recap/insight;
 *     plus Gmail reads (`gmail_list`/`gmail_read`/`gmail_search`), added
 *     2026-09-30 after Live honestly refused "cek emailku dong" — the owner's
 *     Gmail is linked (refresh token on file), so the refusal was an
 *     allowlist gap, not a missing credential.
 *     WRITE tools go through a SPOKEN confirmation loop instead of
 *     executing on first sight (owner-approved 2026-09-30, gap #2):
 *     `remind_me` and `save_note` are held by `liveConfirm.ts`, the model
 *     asks aloud, and only a re-call with `confirmed: true` after the user
 *     spoke executes. The tool route independently refuses them unconfirmed.
 * Extend by appending a registry name here AND the tool route's allowlist;
 * one without the other is either undeclared or unexecutable.
 */
export const LIVE_TOOL_NAMES = [
  "spotify_status",
  "spotify_search",
  "spotify_play",
  "spotify_pause",
  "spotify_next",
  "spotify_previous",
  "spotify_volume",
  "spotify_devices",
  "search_memory",
  "memory_get",
  "list_notes",
  "list_tasks",
  "reminders_list",
  "calendar_list",
  "mood_recent",
  "habit_stats",
  "health",
  "weather",
  "web_search",
  "calculate",
  "briefing",
  "recap",
  "weekly_insight",
  "gmail_list",
  "gmail_read",
  "gmail_search",
  "remind_me",
  "save_note",
] as const;

export type LiveToolName = (typeof LIVE_TOOL_NAMES)[number];

/** A Gemini `functionDeclarations` entry: name + description + JSON schema. */
export interface LiveFunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description?: string; enum?: string[] }>;
    required: string[];
  };
}

/** True when a Live tool call may be executed server-side. */
export function isLiveToolName(name: unknown): name is LiveToolName {
  return typeof name === "string" && (LIVE_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Build the Gemini function declarations from the live registry. A name with
 * no registered plugin is skipped (never emitted as a hollow declaration),
 * so removing a tool from the registry automatically removes it from Live.
 */
export function liveToolDeclarations(): LiveFunctionDeclaration[] {
  const out: LiveFunctionDeclaration[] = [];
  for (const name of LIVE_TOOL_NAMES) {
    const plugin = getTool(name);
    if (!plugin) continue;
    const fn = plugin.definition.function;
    // Voice write actions (gap #2): the registry schemas know nothing of
    // confirmation, so the Live-only `confirmed` flag is added here, at the
    // one place that serves the Live session. Server plugins ignore unknown
    // args; the client holds the first call and the tool route refuses the
    // flag when absent — three independent halves of one loop.
    if ((LIVE_WRITE_TOOLS as readonly string[]).includes(name)) {
      out.push({
        name: fn.name,
        description: fn.description,
        parameters: {
          ...fn.parameters,
          properties: {
            ...fn.parameters.properties,
            confirmed: {
              type: "boolean",
              description:
                "Set true ONLY after you asked the user aloud and they answered ya/iya/boleh/oke. Omit it on the first call.",
            },
          },
        },
      });
      continue;
    }
    out.push({ name: fn.name, description: fn.description, parameters: fn.parameters });
  }
  return out;
}

/** Days of recent memory packed into a new Live session. */
export const MEMORY_RECAP_DAYS = 3;
/**
 * Hard cap on the recap: the persona (owner facts) must never be pushed out
 * of the system instruction, so the recap is what gets cut, not the facts.
 */
export const MEMORY_RECAP_MAX_CHARS = 2_500;

/**
 * Load the most recent non-empty day files, oldest-first. Server-only (reads
 * the per-user memory store); failures yield no days, never an exception.
 */
export function loadRecentMemory(
  rawUser: unknown,
  dayCount: number = MEMORY_RECAP_DAYS
): Array<{ date: string; content: string }> {
  let days: string[] = [];
  try {
    days = listDailyMemories(rawUser);
  } catch {
    return [];
  }
  const out: Array<{ date: string; content: string }> = [];
  for (const date of days.slice(-Math.max(1, dayCount))) {
    let content = "";
    try {
      content = readDailyMemory(rawUser, date);
    } catch {
      continue;
    }
    const trimmed = content.trim();
    if (!trimmed || /^No memory for|^\(empty/i.test(trimmed)) continue;
    out.push({ date, content: trimmed });
  }
  return out;
}

/**
 * Pack recent days into a short recap: the TAIL of each day (what was just
 * talked about matters more than the morning), oldest day first so the story
 * reads forward, hard-capped so the persona always fits first. Pure — tested.
 */
export function buildMemoryRecap(
  days: Array<{ date: string; content: string }>,
  maxChars: number = MEMORY_RECAP_MAX_CHARS
): string {
  if (!days.length || maxChars <= 0) return "";
  const perDay = Math.max(200, Math.floor(maxChars / days.length));
  const parts: string[] = [];
  for (const d of days) {
    const tail = d.content.length > perDay ? d.content.slice(-perDay) : d.content;
    parts.push(`## ${d.date}\n${tail.trim()}`);
  }
  let recap = parts.join("\n\n");
  if (recap.length > maxChars) recap = recap.slice(-maxChars);
  if (!recap.trim()) return "";
  return `Recent conversation memory (newest last; shared context, not a script):\n${recap}`;
}

/**
 * Per-side cap for one written-back Live turn. Mirrors the chat path
 * (agent.ts truncates each side to 800 chars before `appendDailyMemory`), so
 * a long spoken monologue cannot flood a day file and both paths stay
 * byte-comparable for recall.
 */
export const LIVE_MEMORY_SIDE_CHARS = 800;

/**
 * Format one completed Live turn exactly like a chat turn (`User:` / `Mia:`
 * lines — `appendDailyMemory` adds the timestamp header itself), so the
 * existing recall (BM25 + recap + RAG over daily files) reads Live memory
 * with zero special-casing. Returns `""` when there is nothing worth saving.
 * Pure — tested.
 */
export function formatLiveMemoryEntry(heard: unknown, said: unknown): string {
  const lines: string[] = [];
  if (typeof heard === "string" && heard.trim()) {
    // Transcripts are already flower-free, but strip again here: a stored 🌸
    // would be recalled into a future Live session's recap and spoken aloud.
    lines.push(`User: ${stripLiveFlower(heard).trim().slice(0, LIVE_MEMORY_SIDE_CHARS)}`);
  }
  if (typeof said === "string" && said.trim()) {
    lines.push(`Mia: ${stripLiveFlower(said).trim().slice(0, LIVE_MEMORY_SIDE_CHARS)}`);
  }
  return lines.join("\n");
}
