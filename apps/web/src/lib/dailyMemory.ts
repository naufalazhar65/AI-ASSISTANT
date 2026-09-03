// Daily memory log (OpenClaw-style `memory/YYYY-MM-DD.md`).
//
// Mia keeps a per-user, per-day log file that records the *new* facts learned
// on each day. Persona files (USER/SOUL) hold durable facts; the daily log is a
// short-lived, time-bucketed complement so recent context ("kami tadi ngomong
// tentang X", "bikin catatan Y hari ini") is available on turn one of a fresh
// session without bloating the stable persona. Reading today + the previous day
// mirrors OpenClaw's "read today and yesterday on start" advice.
//
// Server-side only (node:fs). Best effort: missing/corrupt files are ignored.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";

function memoryDir(rawUser?: unknown): string | null {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return null;
  const dir = join(userDataRoot(), userKey, "memory");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Read a specific day's log; empty string when missing/unreadable. */
function readDay(dir: string | null, key: string): string {
  if (!dir) return "";
  try {
    const path = join(dir, `${key}.md`);
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Append or update facts into today's memory log. Each entry (`user.k=v`,
 * `soul.k=v`, or a plain `- note`) is stored as a bullet line. Re-keyed entries
 * (same key) replace in place so a fact corrected later in the day isn't
 * duplicated. Persists only when the user key is valid.
 */
export function appendDailyMemory(entries: { target: string; key: string; value: string }[], rawUser?: unknown): void {
  const dir = memoryDir(rawUser);
  if (!dir || !entries.length) return;
  const key = dateKey(new Date());
  const lines: string[] = readDay(dir, key)
    ? readDay(dir, key).split("\n")
    : [`# ${key}`];
  const existingKeys = new Set(lines.map((l) => (l.match(/^- (?:user|soul)\.(.+?):/) || [])[1]).filter(Boolean));
  for (const e of entries) {
    if (e.target !== "USER" && e.target !== "SOUL") continue;
    const bullet = `- ${e.target.toLowerCase()}.${e.key}: ${e.value}`;
    const existingIdx = lines.findIndex((l) => (l.match(/^- (?:user|soul)\.(.+?):/) || [])[1] === e.key);
    if (existingIdx !== -1) {
      lines[existingIdx] = bullet; // update in place, never duplicate
    } else {
      lines.push(bullet);
    }
    existingKeys.add(e.key);
  }
  const path = join(dir, `${key}.md`);
  try {
    writeFileSync(path, lines.join("\n").replace(/\s+$/, "\n"), "utf8");
  } catch {
    /* best effort */
  }
}

/**
 * Read the recent memory log (today by default, plus up to `days` back) folded
 * into a single "Recent memory" block for the system prompt. Returns "" when
 * there is nothing to add (no user, or no entries).
 */
export function loadDailyMemoryPrompt(rawUser?: unknown, days = 2): string {
  const dir = memoryDir(rawUser);
  if (!dir) return "";
  const now = new Date();
  const blocks: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const body = readDay(dir, dateKey(d));
    if (body) blocks.push(body);
  }
  if (!blocks.length) return "";
  return `Recent memory:\n${blocks.join("\n\n")}`;
}