// Morning briefing ("pagi briefing") — personal assistant feature (2026-09-06).
//
// Every morning at BRIEFING_HOUR Mia pushes a short, warm digest of the day
// ahead, assembled purely from local data: tasks due today + overdue open
// tasks, unfired reminders for today, yesterday's moods + memory snippets, and
// any civil holiday falling today. Deterministic template — no LLM call, works
// offline/mock, silent when there is nothing worth reporting (no spam). The
// runner mirrors recap.ts: exact-hour match, module-level once-per-day guard.

import { readTasks } from "./tasks";
import { readReminders } from "./reminders";
import { readMoods } from "./mood";
import { readDailyMemory } from "./dailyMemory";
import { holidayInfo } from "./holiday";
import { pushToOwner } from "../channels/pushTarget";
import { briefingEnabled, briefingHour } from "./config";
import { logInfo, logError } from "./appLogger";
import { existsSync, readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { userDataRoot, isTestUserKey, appRoot, canonicalUserKey } from "./users";

let timer: NodeJS.Timeout | null = null;
let started = false;
let lastBriefingDay = (() => {
  // Persisted dedup: a restart during the briefing hour must not double-push
  // (same lesson as recap.ts / weeklyInsight.ts).
  try {
    const f = join(appRoot(), ".data", "briefing-state.json");
    if (existsSync(f)) {
      const parsed = JSON.parse(readFileSync(f, "utf8")) as { lastFiredDate?: unknown };
      return typeof parsed.lastFiredDate === "string" ? parsed.lastFiredDate : "";
    }
  } catch { /* best-effort */ }
  return "";
})();

function saveBriefingDay(day: string): void {
  try {
    const f = join(appRoot(), ".data", "briefing-state.json");
    mkdirSync(dirname(f), { recursive: true });
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, JSON.stringify({ lastFiredDate: day }, null, 2));
    renameSync(tmp, f);
  } catch { /* best-effort */ }
}

export function localDayJkt(date: Date): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function localHourJkt(date: Date): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", { hour12: false, hour: "2-digit", timeZone: "Asia/Jakarta" });
    const h = Number(fmt.format(date));
    if (!Number.isNaN(h)) return h;
  } catch { /* fall through */ }
  return Number(date.toLocaleString("en-US", { hour12: false }).split(":")[0]);
}

function startOfJktDay(dayStr: string): number {
  return Date.parse(`${dayStr}T00:00:00+07:00`);
}

function timeOfAt(at: number): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Jakarta" }).format(new Date(at));
  } catch {
    return new Date(at).toTimeString().slice(0, 5);
  }
}

function pickFrom<T>(arr: T[], seedStr: string): T {
  let h = 0;
  for (let i = 0; i < seedStr.length; i++) h = (h * 31 + seedStr.charCodeAt(i)) >>> 0;
  return arr[h % arr.length];
}

export function greetingFor(now: Date): string {
  const hour = localHourJkt(now);
  if (hour < 11) return "Pagi";
  if (hour < 15) return "Siang";
  if (hour < 19) return "Sore";
  return "Malam";
}

function holidayToday(rawUser: unknown, today: string): string {
  try {
    const info = holidayInfo(rawUser, Number(today.slice(5, 7)), new Date());
    const line = info.split("\n").find((l) => l.startsWith(`- ${today}:`));
    if (!line) return "";
    return line.replace(`- ${today}:`, "").trim().replace(/\*\*/g, "").replace(/ \(peringatan.*$/, "");
  } catch {
    return "";
  }
}

/**
 * Build the morning briefing for one user. Returns "" when there is nothing
 * worth reporting (no agenda, no yesterday traces, no holiday) — stay silent.
 */
export function buildMorningBriefing(rawUser?: unknown, now = new Date()): string {
  const today = localDayJkt(now);
  const todayStart = startOfJktDay(today);
  const tomorrowStart = todayStart + 86400000;
  const yesterdayDay = localDayJkt(new Date(todayStart - 1));

  const tasks = readTasks(rawUser).filter((t) => t.status === "active");
  const dueToday = tasks.filter((t) => typeof t.dueAt === "number" && t.dueAt >= todayStart && t.dueAt < tomorrowStart);
  const overdue = tasks.filter((t) => typeof t.dueAt === "number" && t.dueAt < todayStart);

  const reminders = readReminders(rawUser)
    .filter((r) => !r.fired && r.at >= todayStart && r.at < tomorrowStart)
    .map((r) => ({ time: timeOfAt(r.at), text: r.text }));

  const yesterday = readDailyMemory(rawUser, "yesterday");
  const hasMemory = !/^(No memory|\(empty memory)/.test(yesterday);

  const yMoods = readMoods(rawUser)
    .filter((m) => {
      try {
        return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(m.at)) === yesterdayDay;
      } catch {
        return false;
      }
    })
    .map((m) => m.mood);
  const neg = yMoods.filter((m) => ["stressed", "anxious", "sad", "angry", "tired"].includes(m)).length;
  const pos = yMoods.filter((m) => ["great", "good", "okay"].includes(m)).length;

  const holiday = holidayToday(rawUser, today);

  const hasAgenda = dueToday.length > 0 || reminders.length > 0;
  const hasAny = hasAgenda || overdue.length > 0 || hasMemory || yMoods.length > 0 || !!holiday;
  if (!hasAny) return "";

  const dayLabel = new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", weekday: "long", day: "numeric", month: "long" }).format(now);
  const greeting = greetingFor(now);

  const lines: string[] = [];
  lines.push(`${greeting === "Pagi" ? "☀️" : "🌤️"} *Briefing ${greeting}* — ${dayLabel}`);

  if (hasAgenda) {
    lines.push("", "*Di barisan kamu hari ini:*");
    dueToday.forEach((t) => {
      lines.push(`  • ${t.text.slice(0, 160)} (deadline ${timeOfAt(t.dueAt as number)})`);
    });
    reminders.forEach((r) => {
      lines.push(`  • ${r.time} — ${r.text.slice(0, 160)}`);
    });
    if (overdue.length) {
      lines.push(`  • ⚠ ${overdue.length} task kemarin minta dituntaskan belum nyerah: ${overdue[0].text.slice(0, 80)}${overdue.length > 1 ? ` +${overdue.length - 1} lagi` : ""}`);
    }
  } else if (overdue.length) {
    lines.push("", "*Masih ada yang minta dituntaskan:*");
    overdue.forEach((t) => lines.push(`  • ⚠ ${t.text.slice(0, 160)}`));
  } else {
    lines.push("", "Hari ini tanpa plan — full free day, santai aja kalau bisa. 😌");
  }

  if (holiday) lines.push("", `Hari ini juga tanggal merah: **${holiday}** 🎉`);

  if (hasMemory || yMoods.length) {
    lines.push("");
    if (neg > pos) lines.push("Kemarin catatan moodmu agak berat. Semoga hari ini lebih lega — kalau ada yang masih nyangkut, cerita aja.");
    else if (yMoods.length) lines.push("Kemarin moodmu oke. Semoga stabil hari ini juga.");
    if (hasMemory) {
      const snippets = yesterday.split("\n").map((l) => l.trim()).filter(Boolean)
        .filter((l) => !/^#/.test(l) && !/\(automation\)/.test(l) && !/laporan terjadwal/i.test(l))
        .filter((l) => !/^\[persona\]/i.test(l) && !/^Mia:/i.test(l))
        .map((l) => l.replace(/^(User|Assistant):\s*/, "")).slice(0, 2);
      if (snippets.length) lines.push(`Pelan-pelan sambung dari kemarin: ${snippets[0].slice(0, 140)}`);
    }
  }

  const seed = `${String(rawUser ?? "shared")}|${today}`;
  lines.push("", pickFrom(
    [
      `Oke, muka baru day-nya. Kebut pelan-pelan, aku standby. 🌸`,
      `Gitu doang? Beres. Mulai hari, aku temenin. 🌸`,
      `Semangat buat hari ini — apa pun yang belum kelar, kita babat bareng. 💪`,
      `Siap day-nya. Kalo butuh diingetin atau mau bagi rencana, tinggal panggil. 🌸`,
    ],
    seed,
  ));

  return lines.join("\n");
}

function allUserKeys(): string[] {
  const root = userDataRoot();
  if (!existsSync(root)) return [];
  try {
    const raw = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((n) => /^[A-Za-z0-9._-]+$/.test(n) && !isTestUserKey(n));
    // alias Zigen/naufalazhar65 -> same owner, dedupe via canonical key
    const seen = new Set<string>();
    const out: string[] = [];
    for (const k of raw) {
      const c = canonicalUserKey(k) || k;
      if (!seen.has(c)) { seen.add(c); out.push(c); }
    }
    return out;
  } catch {
    return [];
  }
}

async function tick(): Promise<void> {
  const now = new Date();
  const day = localDayJkt(now);
  const hour = localHourJkt(now);
  const target = briefingHour();
  if (!briefingEnabled() || Number.isNaN(hour) || !target || hour !== target || lastBriefingDay === day) return;
  lastBriefingDay = day;
  saveBriefingDay(day);
  for (const user of allUserKeys()) {
    try {
      const msg = buildMorningBriefing(user, now);
      if (!msg) continue; // nothing worth reporting → stay silent
      const delivered = await pushToOwner(msg);
      if (delivered) logInfo("briefing", `pushed for ${user}`);
      else logInfo("briefing", `no channel for ${user}, skipped`);
    } catch (e) {
      logError("briefing", `failed for ${user}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** Start the briefing runner. Idempotent. */
export function startBriefingRunner(): void {
  if (started) return;
  started = true;
  if (!briefingHour() || !briefingEnabled()) {
    logInfo("briefing", "disabled (BRIEFING_HOUR=0 or BRIEFING_ENABLED=0)");
    return;
  }
  logInfo("briefing", `starting — daily at ${String(briefingHour()).padStart(2, "0")}:00`);
  setTimeout(() => void tick(), 30 * 1000);
  timer = setInterval(() => void tick(), 60 * 1000);
  if (timer && typeof timer.unref === "function") timer.unref();
}

/** For tests: run one tick immediately. */
export async function runBriefingTick(): Promise<void> {
  await tick();
}

export function stopBriefingRunner(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}