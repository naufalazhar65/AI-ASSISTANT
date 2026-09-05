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
  /** Recurring cadence. "daily" reschedules itself 24h after firing. */
  repeat?: "daily";
  /** Optional pool of alternate texts; each delivery rotates to the next. */
  variants?: string[];
  /** Index of the variant to deliver next (rotates through `variants`). */
  variantIdx?: number;
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
 *
 * Options:
 *  - `repeat: "daily"` → after firing, the reminder reschedules itself 24h
 *    ahead (still unfired), so a single record fires every day. This is what
 *    "setiap hari jam 7" should produce — not a fresh one-shot each turn.
 *  - `variants` → when the user wants the message varied ("ganti ganti
 *    pesannya"), the reminder rotates through these texts (variantIdx), one
 *    per delivery, instead of delivering the same `text` every day.
 *
 * Dedup: a new reminder merges into an existing UNFIRED reminder for the same
 * user at the same clock time when the new one is recurring (either is daily),
 * so repeated "setiap hari jam 7" asks never stack duplicate records.
 */
export function addReminder(
  text: string,
  atMs: number,
  rawUser?: unknown,
  opts: { repeat?: "daily"; variants?: string[] } = {}
): Reminder {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) throw new Error("invalid user");
  const trimmed = text.trim().slice(0, 300);
  if (!trimmed) throw new Error("empty reminder text");
  const reminders = readReminders(rawUser);
  const { repeat, variants } = opts;

  const atClock = new Date(atMs);
  // Merge only when the NEW reminder is recurring: a one-shot is an explicit
  // single event (two distinct one-shots at the same clock must both fire), so
  // it never merges. A daily ask adopts an existing UNFIRED slot at the same
  // clock time (overwriting its text/options and converting it to daily) — this
  // is what collapses repeated "setiap hari jam 7" asks into ONE record and kills
  // the "notif banyak" stacking flood.
  const existingIdx = reminders.findIndex((r) => {
    if (repeat !== "daily" || r.fired) return false;
    const rAt = new Date(r.at);
    return rAt.getHours() === atClock.getHours() && rAt.getMinutes() === atClock.getMinutes();
  });

  let reminder: Reminder;
  if (existingIdx >= 0) {
    const existing = { ...reminders[existingIdx], text: trimmed };
    if (repeat === "daily") existing.repeat = "daily";
    if (variants?.length) existing.variants = variants;
    if (variants?.length) existing.variantIdx = existing.variantIdx ?? 0;
    reminder = existing;
    reminders[existingIdx] = reminder;
  } else {
    reminder = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      text: trimmed,
      at: atMs,
      fired: false,
      ...(repeat ? { repeat } : {}),
      ...(variants?.length ? { variants, variantIdx: 0 } : {}),
    };
    reminders.push(reminder);
  }
  while (reminders.length > MAX_REMINDERS) reminders.shift();
  writeReminders(reminders, userKey);
  return reminder;
}

/**
 * Due-and-unfired reminders for one user. Every returned reminder is marked
 * handled before returning so it's broadcast only once: daily reminders are
 * rescheduled 24h ahead (still unfired) with their variant index advanced;
 * one-shot reminders are marked fired. Invalid users yield none.
 */
export function takeDueReminders(rawUser?: unknown, now = Date.now()): Reminder[] {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return [];
  const reminders = readReminders(rawUser);
  if (!reminders.length) return [];
  const due = reminders.filter((r) => !r.fired && r.at <= now);
  if (!due.length) return [];
  const dueIds = new Set(due.map((r) => r.id));
  writeReminders(
    reminders.map((r) => {
      if (!dueIds.has(r.id)) return r;
      if (r.repeat === "daily") {
        // Reschedule to the next 24h slot, rotating the variant pool so each
        // delivery gets a different message when the user asked for variety.
        const variantIdx = r.variants?.length ? (r.variantIdx ?? 0) + 1 : undefined;
        return { ...r, at: r.at + 24 * 60 * 60 * 1000, fired: false, variantIdx };
      }
      return { ...r, fired: true };
    }),
    userKey
  );
  // Deliver the current text (or the next variant) so listeners see one variation.
  return due.map((r) => {
    const variantIdx = r.variantIdx ?? 0;
    const text = r.variants?.length ? r.variants[variantIdx % r.variants.length] : r.text;
    return { ...r, text };
  });
}