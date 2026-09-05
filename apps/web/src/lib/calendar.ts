// Simple per-user calendar (Fase 4, Calendar integration MVP).
// Local JSON store at .data/users/<user>/calendar.json, not Google Calendar OAuth (future).
// Each event: {id, title, start, end, description?}. Tools are read/write with FR-014.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";

export interface CalEvent {
  id: string;
  title: string;
  start: number; // epoch ms
  end: number; // epoch ms
  description?: string;
}

const MAX_EVENTS = 100;

function calPath(userKey: string): string {
  return join(userDataRoot(), userKey, "calendar.json");
}

export function readCalendar(rawUser?: unknown): CalEvent[] {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return [];
  const path = calPath(userKey);
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is CalEvent =>
        !!e && typeof (e as CalEvent).title === "string" && typeof (e as CalEvent).start === "number" && typeof (e as CalEvent).end === "number"
    );
  } catch {
    return [];
  }
}

function writeCalendar(events: CalEvent[], userKey: string): void {
  const path = calPath(userKey);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(events, null, 2));
  renameSync(tmp, path);
}

export function addCalEvent(title: string, start: number, end: number, rawUser?: unknown, description?: string): CalEvent {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) throw new Error("invalid user");
  const t = title.trim().slice(0, 200);
  if (!t) throw new Error("title required");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error("invalid start/end");
  if (end - start > 24 * 3600 * 1000) throw new Error("event too long (max 24h)");
  const events = readCalendar(rawUser);
  const ev: CalEvent = {
    id: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    title: t,
    start,
    end,
    ...(description?.trim() ? { description: description.trim().slice(0, 500) } : {}),
  };
  events.push(ev);
  while (events.length > MAX_EVENTS) events.shift();
  writeCalendar(events, userKey);
  return ev;
}

export function listCalEvents(rawUser?: unknown, from?: number, to?: number): CalEvent[] {
  const events = readCalendar(rawUser);
  let filtered = events;
  if (from !== undefined) filtered = filtered.filter((e) => e.end >= from);
  if (to !== undefined) filtered = filtered.filter((e) => e.start <= to);
  return filtered.sort((a, b) => a.start - b.start);
}

export function listCalText(rawUser?: unknown, days = 7): string {
  const now = Date.now();
  const to = now + days * 24 * 3600 * 1000;
  const events = listCalEvents(rawUser, now, to);
  if (!events.length) return `No events in next ${days} day(s).`;
  return events
    .map((e) => {
      const s = new Date(e.start).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" });
      const en = new Date(e.end).toLocaleString("id-ID", { timeStyle: "short" });
      return `- ${e.title} — ${s} → ${en}${e.description ? ` (${e.description})` : ""}`;
    })
    .join("\n")
    .slice(0, 4000);
}

export function checkCalAvailability(rawUser: unknown, start: number, end: number): { free: boolean; conflicts: CalEvent[] } {
  const events = readCalendar(rawUser);
  const conflicts = events.filter((e) => !(e.end <= start || e.start >= end));
  return { free: conflicts.length === 0, conflicts };
}

export function deleteCalEvent(id: string, rawUser?: unknown): boolean {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) throw new Error("invalid user");
  const events = readCalendar(rawUser);
  const idx = events.findIndex((e) => e.id === id);
  if (idx === -1) return false;
  events.splice(idx, 1);
  writeCalendar(events, userKey);
  return true;
}

// --- macOS Calendar sync (AppleScript via osascript) ---
// Best-effort: requires Calendar.app permission. Falls back gracefully if not available.

import { execFile } from "node:child_process";

export async function addToMacCalendar(title: string, start: Date, end: Date): Promise<string> {
  // Build dates outside the Calendar tell block (Standard Additions scope) to avoid
  // term shadowing (Calendar defines its own `months`) and locale date-parsing bugs (9/5 vs 5/9).
  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const toAppleDate = (name: string, d: Date) => `set ${name} to current date
  set year of ${name} to ${d.getFullYear()}
  set month of ${name} to ${MONTHS[d.getMonth()]}
  set day of ${name} to ${d.getDate()}
  set hours of ${name} to ${d.getHours()}
  set minutes of ${name} to ${d.getMinutes()}
  set seconds of ${name} to ${d.getSeconds()}`;
  const script = `
    ${toAppleDate("startDate", start)}
    ${toAppleDate("endDate", end)}
    tell application "Calendar"
      activate
      tell calendar 1
        make new event at end with properties {summary:"${title.replace(/"/g, '\\"')}", start date:startDate, end date:endDate}
      end tell
    end tell
  `;
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.trim() || err.message || "Calendar AppleScript failed — check Calendar permission"));
      resolve(stdout.trim() || "Added to Mac Calendar");
    });
  });
}

export async function listMacCalendar(days = 7): Promise<string> {
  const { exec } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    exec(`osascript -e 'tell application "Calendar" to get summary of every event of calendar "Rumah"'`, { timeout: 8000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.trim() || err.message));
      const out = stdout.trim();
      if (!out) return resolve("No events in Mac Calendar (Rumah)");
      const events = out.split(", ").filter(Boolean).slice(0, 20);
      resolve(events.join("\n").slice(0, 4000) || "No events");
    });
  });
}
