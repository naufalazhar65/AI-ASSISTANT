// Persistent per-user task list (Fase 3 — task management).
//
// A task is {id, text, status, dueAt?}. Unlike a one-shot reminder (which only
// warns "when it fires"), a task stays in the user's active list until they
// mark it done or cancel it — so they can list, complete, cancel, and
// reschedule tasks via chat. A task that has a `dueAt` deadline also schedules
// a reminder (via `addReminder` in reminders.ts), reusing the existing push
// mechanism instead of building a second scheduler.
//
// Store: apps/web/.data/users/<user>/tasks.json. Same atomic-write + sanitized
// user-key pattern as notes/reminders.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";
import { addReminder } from "./reminders";

export type TaskStatus = "active" | "done" | "cancelled";

export interface Task {
  id: string;
  text: string;
  status: TaskStatus;
  /** Optional deadline epoch ms; also schedules a reminder. */
  dueAt?: number;
}

const MAX_TASKS = 60;

function tasksPath(userKey: string): string {
  return join(userDataRoot(), userKey, "tasks.json");
}

export function readTasks(rawUser?: unknown): Task[] {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return [];
  try {
    const raw = readFileSync(tasksPath(userKey), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is Task =>
        !!t && typeof (t as Task).text === "string" && (t as Task).status &&
        ["active", "done", "cancelled"].includes((t as Task).status)
    );
  } catch {
    return [];
  }
}

function writeTasks(tasks: Task[], userKey: string): void {
  const file = tasksPath(userKey);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(tasks, null, 2));
  renameSync(tmp, file);
}

/** Create a task (optionally with a due deadline that schedules a reminder). */
export function addTask(text: string, rawUser?: unknown, dueAt?: number): Task {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) throw new Error("invalid user");
  const trimmed = text.trim().slice(0, 300);
  if (!trimmed) throw new Error("empty task text");
  const tasks = readTasks(rawUser);
  const task: Task = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    text: trimmed,
    status: "active",
    ...(typeof dueAt === "number" && !Number.isNaN(dueAt) ? { dueAt } : {}),
  };
  tasks.push(task);
  while (tasks.length > MAX_TASKS) tasks.shift();
  writeTasks(tasks, userKey);
  if (task.dueAt) addReminder(`[task] ${trimmed}`, task.dueAt, rawUser);
  return task;
}

/** Human-readable summary of the user's tasks, in insertion order (newest last). */
export function listTasks(rawUser?: unknown): string {
  const tasks = readTasks(rawUser);
  if (!tasks.length) return "You have no tasks yet.";
  const fmt = (t: Task): string => {
    const due = t.dueAt ? ` (due ${new Date(t.dueAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })})` : "";
    return `- ${t.text}${due} [${t.status}]`;
  };
  return tasks.map(fmt).join("\n").slice(0, 3000);
}

/** Index of a task by its 1-based number (same insertion order as listTasks). */
function indexOfNumber(tasks: Task[], number: number): number {
  return number >= 1 && number <= tasks.length ? number - 1 : -1;
}

export function setTaskStatus(number: number, status: TaskStatus, rawUser?: unknown): string {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) throw new Error("invalid user");
  const tasks = readTasks(rawUser);
  const idx = indexOfNumber(tasks, number);
  if (idx < 0) throw new Error(`no task #${number}`);
  tasks[idx] = { ...tasks[idx], status };
  writeTasks(tasks, userKey);
  return `Task #${number} "${tasks[idx].text}" marked ${status}.`;
}

/** Change a task's due deadline (also re-schedules its reminder). */
export function rescheduleTask(number: number, dueAt: number, rawUser?: unknown): string {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) throw new Error("invalid user");
  const tasks = readTasks(rawUser);
  const idx = indexOfNumber(tasks, number);
  if (idx < 0) throw new Error(`no task #${number}`);
  tasks[idx] = { ...tasks[idx], dueAt };
  writeTasks(tasks, userKey);
  addReminder(`[task] ${tasks[idx].text}`, dueAt, rawUser);
  return `Task #${number} rescheduled to ${new Date(dueAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}.`;
}