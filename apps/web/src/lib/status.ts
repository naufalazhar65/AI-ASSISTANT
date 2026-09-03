// `/status` command output for the chat channels (Fase 3). Server-side only.
//
// Generates a concise, truthful status report — modelled on OpenClaw's
// `/status` but only including data Mia actually tracks. We deliberately do NOT
// fabricate token/cost/cache/context figures: the provider abstraction (Groq /
// OpenCode / 9router) does not expose them, so showing made-up numbers would be
// misleading. Instead we report time, uptime, provider/model, and per-user
// store counts, which are real and useful.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { userDataRoot } from "./users";
import { readTasks } from "./tasks";
import { readReminders } from "./reminders";
import { readAutomations } from "./automations";
import { listUploads } from "./uploads";

const bootTime = Date.now();
const TIMEZONE = process.env.MIA_USER_TIMEZONE || "Asia/Jakarta";

/** Best-effort count of a user's saved notes (notes store lives in tools.ts). */
function noteCount(rawUser?: unknown): number {
  try {
    const file = join(userDataRoot(), String(rawUser ?? ""), "notes.json");
    if (!existsSync(file)) return 0;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function fmtClock(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(ms));
}

function fmtUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const d = Math.floor(h / 24);
  return d > 0 ? `${d}d ${h % 24}h ${m}m` : `${h}h ${m}m`;
}

export interface StatusInput {
  /** The conversation state's provider id. */
  provider: string;
  /** The conversation state's model (may be undefined = Auto). */
  model?: string;
  /** History length for this chat. */
  historyLen?: number;
  /** The raw user key this chat belongs to. */
  user?: unknown;
}

/**
 * Build the `/status` report. `version` lets us identify the running build.
 */
export function buildStatusReport(input: StatusInput, version = "Mia"): string {
  const user = input.user;
  const now = Date.now();
  const lines: string[] = [];

  lines.push(`🌸 ${version}`);
  lines.push("");
  lines.push(`Current time: ${fmtClock(now)} (${TIMEZONE})`);
  lines.push(`Reference UTC: ${new Date(now).toISOString().slice(0, 16).replace("T", " ")} UTC`);
  lines.push(`Uptime: server ${fmtUptime(now - bootTime)}`);
  lines.push("");
  lines.push(`Model: ${input.provider}${input.model ? `/${input.model}` : " (Auto)"}`);
  lines.push(`Channel history: ${input.historyLen ?? 0} messages`);
  lines.push("");
  lines.push("Data (per-user):");
  lines.push(`  tasks ${countTasks(user)} · reminders ${readReminders(user).length} · automations ${readAutomations(user).length} · notes ${noteCount(user)}`);
  lines.push(`  uploads:`);
  lines.push(padUploadSummary(listUploads(user)));

  return lines.join("\n");
}

function countTasks(rawUser?: unknown): number {
  try {
    return readTasks(rawUser).length;
  } catch {
    return 0;
  }
}

function padUploadSummary(uploads: string): string {
  if (!uploads || uploads === "No files uploaded yet.") return "  none";
  return uploads.split("\n").map((l) => `  ${l}`).join("\n");
}
