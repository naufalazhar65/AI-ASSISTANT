// Scheduler & reminders (OpenClaw fitur). Server-side only.
//
// A reminder is a per-user {id, text, at, fired} record persisted under
// apps/web/.data/users/<user>/reminders.json. A lightweight module-scoped
// scheduler scans every user's store for due-but-unfired reminders and hands
// them to whatever SSE connections are open (subscribe/listeners). Each
// reminder is delivered exactly once (takeDueReminders marks it fired before
// broadcasting). Because the browser may be closed at due time, the stream
// endpoint replays any due-but-unfired reminder on connect so nothing is lost.
//
// Single-instance local dev note: the interval lives in the route module that
// runs inside the one Next server process, so all open streams share it. In a
// multi-instance deployment this would need an external queue; out of MVP scope.

import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";

export interface Reminder {
  id: string;
  /** What to be reminded about, in plain words. */
  text: string;
  /** Epoch milliseconds at which the reminder is due. */
  at: number;
  /** True once the reminder has been delivered to an SSE stream. */
  fired: boolean;
}

const MAX_REMINDERS = 40;
const SCAN_MS = 4000;

export type ReminderListener = (reminder: Reminder) => void;

const listeners = new Set<ReminderListener>();
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
    for (const user of listUsersWithReminders()) {
      const due = takeDueReminders(user);
      for (const r of due) {
        for (const fn of [...listeners]) {
          try {
            fn(r);
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

/** Subscribe to live reminder events. Returns an unsubscribe function. */
export function subscribeReminders(listener: ReminderListener): () => void {
  listeners.add(listener);
  ensureTimer();
  return () => listeners.delete(listener);
}

function remindersPath(userKey: string): string {
  return join(userDataRoot(), userKey, "reminders.json");
}

/** Users with a reminders store on disk (directories under user data root). */
export function listUsersWithReminders(): string[] {
  try {
    return readdirSync(userDataRoot(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Read a user's reminders; empty for missing/per-user-invalid/corrupt files. */
export function readReminders(rawUser?: unknown): Reminder[] {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return [];
  try {
    const raw = readFileSync(remindersPath(userKey), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is Reminder =>
        !!r && typeof (r as Reminder).text === "string" && typeof (r as Reminder).at === "number"
    );
  } catch {
    return [];
  }
}

function writeReminders(reminders: Reminder[], userKey: string): void {
  const file = remindersPath(userKey);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(reminders, null, 2));
  renameSync(tmp, file);
}

/**
 * Atomic add of a reminder for a raw (unsanitized) user string. Throws on
 * empty text. `atMs` is an epoch millisecond deadline; any past time fires on
 * the next scheduler pass.
 */
export function addReminder(text: string, atMs: number, rawUser?: unknown): Reminder {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) throw new Error("invalid user");
  const trimmed = text.trim().slice(0, 300);
  if (!trimmed) throw new Error("empty reminder text");
  const reminders = readReminders(rawUser);
  const reminder: Reminder = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, text: trimmed, at: atMs, fired: false };
  reminders.push(reminder);
  while (reminders.length > MAX_REMINDERS) reminders.shift();
  writeReminders(reminders, userKey);
  return reminder;
}

/**
 * Due-and-unfired reminders for one user, marked fired before returning so
 * each reminder is broadcast only once. Invalid users yield none.
 */
export function takeDueReminders(rawUser?: unknown, now = Date.now()): Reminder[] {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return [];
  const reminders = readReminders(rawUser);
  if (!reminders.length) return [];
  const due = reminders.filter((r) => !r.fired && r.at <= now);
  if (!due.length) return [];
  const firedIds = new Set(due.map((r) => r.id));
  writeReminders(
    reminders.map((r) => (firedIds.has(r.id) ? { ...r, fired: true } : r)),
    userKey
  );
  return due;
}