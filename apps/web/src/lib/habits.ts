import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";

export interface HabitLog { date: string; at: number; }
export interface Habit { id: string; name: string; createdAt: number; logs: HabitLog[]; }

const MAX_HABITS = 20;

function habitsPath(userKey: string): string {
  return join(userDataRoot(), userKey, "habits.json");
}

export function readHabits(rawUser?: unknown): Habit[] {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return [];
  try {
    const raw = readFileSync(habitsPath(userKey), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is Habit => !!e && typeof (e as Habit).id === "string" && typeof (e as Habit).name === "string" && Array.isArray((e as Habit).logs));
  } catch { return []; }
}

function writeHabits(habits: Habit[], userKey: string): void {
  const file = habitsPath(userKey);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(habits, null, 2));
  renameSync(tmp, file);
}

function todayStr(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export function logHabit(name: string, rawUser?: unknown): string {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) throw new Error("invalid user");
  const n = name.trim().toLowerCase().slice(0, 40);
  if (!n) throw new Error("nama habit kosong");
  const habits = readHabits(rawUser);
  let h = habits.find((x) => x.name.toLowerCase() === n);
  if (!h) {
    if (habits.length >= MAX_HABITS) throw new Error(`habit penuh (max ${MAX_HABITS})`);
    h = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name: n, createdAt: Date.now(), logs: [] };
    habits.push(h);
  }
  const today = todayStr();
  if (h.logs.some((l) => l.date === today)) return `Sudah tercatat hari ini: ${h.name} ✓`;
  h.logs.push({ date: today, at: Date.now() });
  writeHabits(habits, userKey);
  return `Tercatat: ${h.name} hari ini ✓`;
}

export function habitStats(rawUser?: unknown): string {
  const habits = readHabits(rawUser);
  if (!habits.length) return "Belum ada habit. Coba: habit_log minum air / olahraga";
  const today = todayStr();
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  return habits.map((h) => {
    const weekLogs = h.logs.filter((l) => l.at >= weekAgo).length;
    const doneToday = h.logs.some((l) => l.date === today) ? "✓ hari ini" : "○ belum hari ini";
    return `- ${h.name}: ${weekLogs}/7 hari ini minggu, ${doneToday}`;
  }).join("\n");
}
