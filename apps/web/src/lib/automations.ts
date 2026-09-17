// Scheduled automations (Fase 3). Server-side only.
//
// An automation is a recurring, assistant-generated action: a prompt that the
// system runs for the user on a schedule without them prompting it. This is the
// scheduling layer of "Automation": the store + interval live here, mirroring
// reminders.ts, and a single runner (automationRunner.ts) subscribes, executes
// one runAssistantTurn per due automation, and pushes the answer to the owner's
// active channel.
//
// Two schedule shapes for MVP:
//   - daily at HH:MM  ("setiap pagi jam 8" / "setiap hari 08:30")
//   - hourly every N hours ("setiap 2 jam")
// A single-instance in-process interval scans every user's store for due
// automations, emits {automation, user}, then rolls nextAt forward.
//
// Single-instance note: same as reminders — the interval lives in the one Next
// process; multi-instance deploys would need an external queue (out of MVP).

import { wibDailyNext } from "./time";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";
import { parseClockTime } from "./reminderIntent";

export type AutomationSchedule =
  | { type: "daily"; hour: number; minute: number }
  | { type: "hourly"; everyHours: number };

export interface Automation {
  id: string;
  /** What the assistant is asked to do each run, in the user's words. */
  prompt: string;
  schedule: AutomationSchedule;
  /** Epoch milliseconds of the next (or first) scheduled run. */
  nextAt: number;
  enabled: boolean;
}

const MAX_AUTOMATIONS = 20;
const SCAN_MS = 4000;

export type AutomationListener = (payload: { automation: Automation; user: string }) => void;

const listeners = new Set<AutomationListener>();
let timer: ReturnType<typeof setInterval> | null = null;

/* istanbul ignore next */
function ensureTimer(): void {
  if (timer) return;
  timer = setInterval(() => {
    broadcastDue();
    if (listeners.size === 0) {
      if (timer) clearInterval(timer);
      timer = null;
    }
  }, SCAN_MS);
  timer.unref?.();
}

let broadcasting = false;
function broadcastDue(): void {
  if (listeners.size === 0 || broadcasting) return;
  broadcasting = true;
  try {
    for (const user of listUsersWithAutomations()) {
      const fired = takeDueAutomations(user);
      for (const automation of fired) {
        for (const fn of [...listeners]) {
          try {
            fn({ automation, user });
          } catch {
            /* a dead listener must not stop the broadcast */
          }
        }
      }
    }
  } finally {
    broadcasting = false;
  }
}

/** Subscribe to due-automation events. Returns an unsubscribe function. */
export function subscribeAutomations(listener: AutomationListener): () => void {
  listeners.add(listener);
  ensureTimer();
  return () => listeners.delete(listener);
}

function automationsPath(userKey: string): string {
  return join(userDataRoot(), userKey, "automations.json");
}

/** Users with an automations store on disk. */
export function listUsersWithAutomations(): string[] {
  try {
    return readdirSync(userDataRoot(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Read a user's automations; empty for missing/corrupt files. */
export function readAutomations(rawUser?: unknown): Automation[] {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return [];
  try {
    const raw = readFileSync(automationsPath(userKey), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (a): a is Automation =>
        !!a &&
        typeof (a as Automation).prompt === "string" &&
        !!((a as Automation).schedule as { type?: string })?.type &&
        typeof (a as Automation).nextAt === "number"
    );
  } catch {
    return [];
  }
}

function writeAutomations(automations: Automation[], userKey: string): void {
  const file = automationsPath(userKey);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(automations, null, 2));
  renameSync(tmp, file);
}

/** Roll nextAt forward past `now` to the automation's next occurrence. */
export function nextRunAt(schedule: AutomationSchedule, after: number): number {
  if (schedule.type === "hourly") {
    const step = Math.max(1, Math.floor(schedule.everyHours)) * 3600_000;
    return after + step;
  }
  // daily — pinned to Asia/Jakarta (a server in another zone must not run the
  // user's "setiap hari jam 7" at 07:00 local time).
  return wibDailyNext(schedule.hour, schedule.minute, after);
}

/**
 * Atomic add of an automation from a raw user string. Parses a human schedule
 * spec like "setiap pagi jam 8" / "setiap hari 08:30" (daily) or
 * "setiap N jam" (hourly). Returns the created automation.
 */
/** True when two prompts describe the same recurring action (token overlap). Pure. */
export function promptsSimilar(a: string, b: string): boolean {
  const norm = (s: string) =>
    new Set(
      (s || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 2)
    );
  const A = norm(a);
  const B = norm(b);
  if (!A.size || !B.size) return a.trim().toLowerCase() === b.trim().toLowerCase();
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter) >= 0.5;
}

/** Same schedule AND near-identical prompt → the same automation, not a new one. Pure. */
export function automationsSimilar(existing: Automation, prompt: string, schedule: AutomationSchedule): boolean {
  if (JSON.stringify(existing.schedule) !== JSON.stringify(schedule)) return false;
  return promptsSimilar(existing.prompt, prompt);
}

/**
 * Add an automation, or MERGE into an existing near-identical one (same schedule
 * + similar prompt). Without this, a model that re-proposes the same action right
 * after it was confirmed created a duplicate that pushed the same message twice.
 */
export function addOrMergeAutomation(
  prompt: string,
  whenSpec: string,
  rawUser?: unknown,
  now = Date.now()
): { automation: Automation; merged: boolean } {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) throw new Error("invalid user");
  const trimmed = prompt.trim().slice(0, 400);
  if (!trimmed) throw new Error("empty automation prompt");

  const schedule = parseSchedule(whenSpec);
  const automations = readAutomations(rawUser);
  const existing = automations.find((a) => automationsSimilar(a, trimmed, schedule));
  if (existing) {
    // Adopt the newer wording and re-arm the schedule, but keep it ONE automation.
    existing.prompt = trimmed;
    existing.nextAt = nextRunAt(schedule, now);
    existing.enabled = true;
    writeAutomations(automations, userKey);
    return { automation: existing, merged: true };
  }
  const automation: Automation = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    prompt: trimmed,
    schedule,
    nextAt: nextRunAt(schedule, now),
    enabled: true,
  };
  automations.push(automation);
  while (automations.length > MAX_AUTOMATIONS) automations.shift();
  writeAutomations(automations, userKey);
  return { automation, merged: false };
}

export function addAutomation(prompt: string, whenSpec: string, rawUser?: unknown, now = Date.now()): Automation {
  return addOrMergeAutomation(prompt, whenSpec, rawUser, now).automation;
}

/**
 * Parse a human schedule spec into a schedule. Throws on unparseable input.
 * Supports "setiap N jam" (hourly) and daily clock times
 * ("setiap pagi jam 8", "setiap hari 08:30", "jam 9 pagi").
 */
export function parseSchedule(spec: string): AutomationSchedule {
  const s = spec.trim().toLowerCase();
  // Hourly: "setiap 2 jam", "tiap 3 jam", "each hour"
  const hourly = s.match(/(?:setiap|tiap|each|every)\s+(\d{1,2})\s+jam/);
  if (hourly) {
    const every = Math.max(1, Math.min(24, parseInt(hourly[1], 10)));
    return { type: "hourly", everyHours: every };
  }
  // Daily: strip "setiap hari/pagi/siang/sore/malam/senin..." prefixes then parse clock.
  const clockPart = s.replace(/(setiap|tiap|each|every|hari|pagi|siang|sore|malam|senin|selasa|rabu|kamis|jumat|sabtu|minggu)\b/gi, " ").trim();
  const time = parseClockTime(clockPart);
  if (time) {
    return { type: "daily", hour: time.hour, minute: time.minute };
  }
  throw new Error(`Cannot parse schedule "${spec}". Use e.g. "setiap pagi jam 8" or "setiap 2 jam".`);
}

/**
 * Due-and-enabled automations for one user, rolled forward after being taken so
 * each is delivered exactly once per occurrence.
 */
export function takeDueAutomations(rawUser?: unknown, now = Date.now()): Automation[] {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return [];
  const automations = readAutomations(rawUser);
  if (!automations.length) return [];
  const due = automations.filter((a) => a.enabled && a.nextAt <= now);
  if (!due.length) return [];

  const dueIds = new Set(due.map((a) => a.id));
  const updated = automations.map((a) => {
    if (!dueIds.has(a.id)) return a;
    return { ...a, nextAt: nextRunAt(a.schedule, now) };
  });
  writeAutomations(updated, userKey);
  return due;
}

/** Nicely describe a schedule for a confirmation/reply, e.g. "setiap hari jam 8". */
export function describeSchedule(schedule: AutomationSchedule): string {
  if (schedule.type === "hourly") {
    return `setiap ${schedule.everyHours} jam`;
  }
  const hh = String(schedule.hour).padStart(2, "0");
  const mm = String(schedule.minute).padStart(2, "0");
  return `setiap hari pukul ${hh}:${mm}`;
}

export function listAutomationsText(rawUser?: unknown): string {
  const autos = readAutomations(rawUser);
  if (!autos.length) return "Belum ada cronjob (automation) beb — mau bikin yang baru? 🌸";
  const lines = [`Daftar cronjob kamu beb — ${autos.length} automation 🌸`];
  for (const a of autos) {
    const when = describeSchedule(a.schedule);
    const next = new Date(a.nextAt).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" });
    lines.push(`• ${a.id.slice(0,6)} — "${a.prompt.slice(0,60)}" — ${when} (next ${next}) [${a.enabled ? "aktif" : "mati"}]`);
  }
  return lines.join("\n").slice(0, 4000);
}
