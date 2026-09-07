// Weekly Insight (Mia feature 2026-09-07): a once-a-week digest of the user's
// moods, tasks, and conversation themes, pushed to the owner like the nightly
// recap. Deterministic templates (a scheduled push must never depend on an LLM
// being available) with varied openers/closers so it never reads copy-pasted.
//
// Design (mirrors recap.ts, including its hard-won lessons):
//  - Once per target weekday: the fired date persists to
//    .data/weekly-insight-state.json (atomic write) so a server restart can
//    never double-push — recap's in-memory-only dedup bug, fixed from day one.
//  - Data sources are the existing stores: moods (last 7 days), tasks, and the
//    daily memory files (User lines only — [persona]/automation junk filtered).
//  - Silent when a user has nothing meaningful ("" → no push), same as recap.
//  - Env: WEEKLY_INSIGHT_HOUR (default 20, 0=off), WEEKLY_INSIGHT_DAY
//    (0=Sunday..6=Saturday, default 0). Times are Asia/Jakarta like recap.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appRoot, userDataRoot } from "./users";
import { readMoods, MoodEntry } from "./mood";
import { readTasks } from "./tasks";
import { readDailyMemory } from "./dailyMemory";
import { tokenize } from "./rag";
import { pushToOwner } from "../channels/pushTarget";
import { logInfo, logError } from "./appLogger";

const MOOD_LABEL_ID: Record<string, string> = {
  great: "luar biasa",
  good: "senang",
  okay: "oke-oke aja",
  meh: "biasa aja",
  stressed: "stres",
  anxious: "cemas",
  sad: "sedih",
  tired: "capek",
  angry: "kesal",
};

const NEGATIVE_MOODS = new Set(["stressed", "anxious", "sad", "angry", "tired"]);

// Generic words that never say anything about the week's themes. Keeps the
// highlight list honest (identifiers like "flowtest" or "badminton" survive).
const STOPWORDS = new Set([
  "yang", "dengan", "untuk", "dan", "atau", "tapi", "kalau", "kalo", "biar",
  "sudah", "udah", "belum", "banget", "lagi", "mau", "bisa", "jadi", "juga",
  "sama", "dari", "ini", "itu", "apa", "gimana", "dong", "nggak", "gak",
  "cuma", "saja", "aja", "masih", "harus", "nanti", "sekarang", "hari",
  "tolong", "coba", "kasih", "mungkin", "memang", "aja", "sih", "deh", "ya",
  "the", "and", "for", "you", "with", "this", "that", "what", "when", "how",
  "play", "playing", "berapa", "makasi", "halo", "hai", "hei", "oke", "ok",
  "iya", "hehe", "haha", "wkwk", "sip", "siap", "dah", "udh", "tuh", "nih",
  "yuk", "ayo", "btw", "wah", "hmm",
  "aku", "kamu", "gue", "saya", "dia", "kita", "mereka", "beb", "mas", "kak",
  "mia", "naufal", "terima", "kasih", "makasih", "thanks", "please", "ada",
  "deh", "kok", "emang", "udh", "dah", "nya", "tuh", "gitu", "gini", "pengen",
  "pingin", "cari", "buat", "pakai", "pake", "ke", "di", "ke",
]);

const JUNK_RE = /terjadwal \(automation\)|\[Scheduled automation\]|laporan terjadwal|\[persona\]/i;

/** Local (Asia/Jakarta) date string for a moment, e.g. "2026-09-07". */
function jakartaDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function jakartaHour(now: Date): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", { hour12: false, hour: "2-digit", timeZone: "Asia/Jakarta" });
    return Number(fmt.format(now));
  } catch {
    return NaN;
  }
}

/** Day-of-week (0=Sunday) for a Jakarta date string. */
function jakartaWeekday(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1)).getUTCDay();
}

/** Last N local dates ending at `now` (inclusive), oldest first. */
function lastNDays(now: Date, n: number): string[] {
  const today = jakartaDay(now);
  const [y, m, d] = today.split("-").map(Number);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const dt = new Date(Date.UTC(y, (m || 1) - 1, (d || 1) - i));
    out.push(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(dt));
  }
  return out;
}

function weeklyInsightHour(): number {
  const v = Number(process.env.WEEKLY_INSIGHT_HOUR);
  return Number.isFinite(v) ? Math.max(0, Math.min(23, Math.round(v))) : 20;
}

function weeklyInsightDay(): number {
  const v = Number(process.env.WEEKLY_INSIGHT_DAY);
  return Number.isFinite(v) ? Math.max(0, Math.min(6, Math.round(v))) : 0;
}

function stateFile(): string {
  return join(appRoot(), ".data", "weekly-insight-state.json");
}

function readLastFiredDate(): string {
  try {
    const f = stateFile();
    if (!existsSync(f)) return "";
    const parsed = JSON.parse(readFileSync(f, "utf8")) as { lastFiredDate?: unknown };
    return typeof parsed.lastFiredDate === "string" ? parsed.lastFiredDate : "";
  } catch {
    return "";
  }
}

function saveLastFiredDate(day: string): void {
  try {
    const f = stateFile();
    mkdirSync(join(f, ".."), { recursive: true });
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, JSON.stringify({ lastFiredDate: day }, null, 2));
    renameSync(tmp, f);
  } catch {
    /* best-effort persistence */
  }
}

/** User-authored lines from a day's memory (junk + Mia lines filtered). */
function userLinesFromMemory(rawUser: unknown, date: string): string[] {
  try {
    const content = readDailyMemory(rawUser, date);
    const out: string[] = [];
    for (const raw of content.split("\n")) {
      const line = raw.trim();
      if (!line.startsWith("User:")) continue;
      const text = line.slice(5).trim();
      if (!text || JUNK_RE.test(text)) continue;
      if (/^<tool_call>[\s\S]*<\/tool_call>\s*$/i.test(text)) continue;
      out.push(text);
    }
    return out;
  } catch {
    return [];
  }
}

function moodLine(moods: MoodEntry[]): string {
  const counts = new Map<string, number>();
  for (const m of moods) counts.set(m.mood, (counts.get(m.mood) ?? 0) + 1);
  const neg = moods.filter((m) => NEGATIVE_MOODS.has(m.mood)).length;
  const pos = moods.length - neg;
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const named = top.map(([m, n]) => `${MOOD_LABEL_ID[m] ?? m} ${n}x`).join(", ");
  if (neg > pos) {
    return `Mood-mu minggu ini agak berat ya — ${named}. Semoga minggu depan lebih lega; cerita aja kalau berat.`;
  }
  if (pos >= neg) {
    return `Mood-mu minggu ini lumayan terjaga — ${named}. Pertahankan ya beb.`;
  }
  return "Kamu nggak banyak cerita soal perasaan minggu ini — gapapa, kalau mau cerita, aku standby.";
}

/** Top conversation themes across the week's User lines, counted by DISTINCT
 *  DAYS a word appears (not raw frequency) so a one-evening burst (e.g. a long
 *  game session) can't dominate — a real theme spans several days. Returns []
 *  when no topic appears on ≥2 days ("sering kepikiran" needs ≥2 days). */
function weeklyThemes(days: string[][]): Array<{ word: string; dayCount: number }> {
  const daySets = new Map<string, Set<number>>();
  for (let d = 0; d < days.length; d++) {
    const seen = new Set<string>();
    for (const text of days[d]) {
      for (const t of tokenize(text)) {
        if (t.length < 4 || STOPWORDS.has(t) || /^\d+$/.test(t)) continue;
        seen.add(t);
      }
    }
    for (const t of seen) {
      const set = daySets.get(t) ?? new Set<number>();
      set.add(d);
      daySets.set(t, set);
    }
  }
  return [...daySets.entries()]
    .map(([word, set]) => ({ word, dayCount: set.size }))
    .filter((t) => t.dayCount >= 2)
    .sort((a, b) => b.dayCount - a.dayCount || a.word.localeCompare(b.word))
    .slice(0, 3);
}

function pickFrom<T>(arr: T[], seed: string): T {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return arr[h % arr.length];
}

const OPENERS = ["Rekap mingguanmu siap 🌸", "Satu minggu berlalu — ini catatanku 🌸", "Minggu ini, dalam angka dan cerita 🌸"];
const CLOSERS = [
  "Semoga minggu depan lebih ringan — istirahat yang cukup ya beb 🌸",
  "Terima kasih udah seminggu ini bareng aku. Pelan-pelan aja minggu depan 🌸",
  "Minggu depan kita bikin lebih baik lagi ya. Aku standby 🌸",
  "Kamu udah kerja keras minggu ini. Jangan lupa sayang diri sendiri 🌸",
];

/**
 * Build the weekly insight message for a user. Returns "" when there is
 * nothing meaningful (no moods, tasks, or conversation) — silent, like recap.
 */
export function buildWeeklyInsight(rawUser: unknown, now = new Date()): string {
  const dates = lastNDays(now, 7);
  const windowStart = now.getTime() - 7 * 24 * 60 * 60 * 1000;

  const moods = readMoods(rawUser).filter((m) => m.at >= windowStart);
  const tasks = readTasks(rawUser);
  const active = tasks.filter((t) => t.status === "active");
  const overdue = active.filter((t) => typeof t.dueAt === "number" && t.dueAt < now.getTime());

  const userTextsByDay: string[][] = dates.map((d) => userLinesFromMemory(rawUser, d));
  const themes = weeklyThemes(userTextsByDay);

  if (!moods.length && !tasks.length && !userTextsByDay.some((d) => d.length)) return "";

  const rangeLabel = `${dates[0].slice(8)}/${dates[0].slice(5, 7)}–${dates[6].slice(8)}/${dates[6].slice(5, 7)}`;
  const lines: string[] = [`📊 *Insight Mingguanmu* (${rangeLabel})`];
  lines.push(pickFrom(OPENERS, dates[0]));

  if (moods.length) lines.push(moodLine(moods));

  if (tasks.length) {
    const parts: string[] = [];
    if (active.length) {
      parts.push(`${active.length} task masih jalan${overdue.length ? `, ${overdue.length} lewat deadline` : ""}`);
    }
    const doneCount = tasks.filter((t) => t.status === "done").length;
    if (doneCount) parts.push(`${doneCount} task sudah kelar`);
    if (parts.length) lines.push(`Soal task: ${parts.join(", ")}.`);
  }

  if (themes.length) {
    const listed = themes.map((t) => `${t.word} (${t.dayCount} hari)`).join(", ");
    lines.push(`Yang paling sering kepikiran minggu ini: ${listed}.`);
  }

  if (lines.length <= 2) return ""; // only title+opener → nothing to say
  lines.push(pickFrom(CLOSERS, dates[0] + dates[0]));
  return lines.filter((l) => l.trim().length > 0).join("\n\n");
}

function allUserKeys(): string[] {
  const root = userDataRoot();
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((n) => /^[A-Za-z0-9._-]+$/.test(n));
  } catch {
    return [];
  }
}

let lastFiredDate = readLastFiredDate();
let timer: ReturnType<typeof setInterval> | null = null;
let started = false;

async function tick(): Promise<void> {
  const now = new Date();
  const day = jakartaDay(now);
  const hour = jakartaHour(now);
  const targetHour = weeklyInsightHour();
  const targetDay = weeklyInsightDay();
  if (Number.isNaN(hour) || !targetHour || hour !== targetHour) return;
  if (jakartaWeekday(day) !== targetDay || lastFiredDate === day) return;
  lastFiredDate = day;
  saveLastFiredDate(day);
  for (const user of allUserKeys()) {
    try {
      const msg = buildWeeklyInsight(user, now);
      if (!msg) continue;
      const delivered = await pushToOwner(msg);
      if (delivered) logInfo("weekly", `insight pushed for ${user}`);
      else logInfo("weekly", `no channel for ${user}, skipped`);
    } catch (e) {
      logError("weekly", `failed for ${user}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** Start the weekly insight runner. Idempotent. */
export function startWeeklyInsightRunner(): void {
  if (started) return;
  started = true;
  if (!weeklyInsightHour()) {
    logInfo("weekly", "disabled (WEEKLY_INSIGHT_HOUR=0)");
    return;
  }
  logInfo("weekly", `starting — every ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weeklyInsightDay()]} at ${String(weeklyInsightHour()).padStart(2, "0")}:00`);
  setTimeout(() => void tick(), 45 * 1000);
  timer = setInterval(() => void tick(), 60 * 1000);
  if (timer && typeof timer.unref === "function") timer.unref();
}

/** For tests: run one tick immediately. */
export async function runWeeklyInsightTick(): Promise<void> {
  await tick();
}

export function stopWeeklyInsightRunner(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

// Re-exported for tests.
export { readLastFiredDate, saveLastFiredDate, lastNDays, jakartaWeekday };
