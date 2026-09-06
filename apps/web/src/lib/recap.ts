// Evening recap ("refleksi malam") — fun/persona feature (B3).
//
// Every evening at RECAP_HOUR Mia composes a short, warm recap of the user's
// day from local data: today's daily memory (memory/YYYY-MM-DD.md, written every
// turn) and today's mood entries (moods.json). Deterministic template text —
// no LLM call, works offline/mock. The runner mirrors `heartbeat.ts`: one
// in-process interval, silent when no data for the day (no spam).

import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { userDataRoot } from "./users";
import { readDailyMemory } from "./dailyMemory";
import { readMoods } from "./mood";
import { pushToOwner } from "../channels/pushTarget";

let timer: NodeJS.Timeout | null = null;
let started = false;
let lastRecapDay = "";

/** 0 = off. Default 21 (= 21:00 WIB local server time). */
export function recapHour(): number {
  const raw = process.env.RECAP_HOUR;
  if (raw !== undefined) {
    const n = Number(raw);
    if (!Number.isNaN(n) && n >= 0 && n <= 23) return n;
  }
  return 21;
}

function localDay(date: Date): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function todayMoods(rawUser?: unknown): { mood: string; note?: string }[] {
  const today = localDay(new Date());
  return readMoods(rawUser)
    .filter((m) => {
      try {
        return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(m.at)) === today;
      } catch {
        return false;
      }
    })
    .map((m) => ({ mood: m.mood, note: m.note }));
}

function pickFrom<T>(arr: T[], seedStr: string): T {
  let h = 0;
  for (let i = 0; i < seedStr.length; i++) h = (h * 31 + seedStr.charCodeAt(i)) >>> 0;
  return arr[h % arr.length];
}

/** Build the recap text for one user's day. Returns "" when nothing happened. */
export function buildEveningRecap(rawUser?: unknown, now = new Date()): string {
  const mem = readDailyMemory(rawUser, "today");
  const hasMemory = !/^(No memory|\(empty memory)/.test(mem);
  const moods = todayMoods(rawUser);

  if (!hasMemory && !moods.length) return "";

  const positive = moods.filter((m) => ["great", "good", "okay"].includes(m.mood)).length;
  const negative = moods.filter((m) => ["stressed", "anxious", "sad", "angry", "tired"].includes(m.mood)).length;

  const moodLine =
    moods.length === 0
      ? "Kamu nggak sempat nulis perasaan hari ini — nggak apa-apa."
      : negative > positive
        ? `Catatan moodmu hari ini terasa agak berat (${positive}x positif, ${negative}x berat). Semoga besok lebih ringan — aku di sini kalau mau cerita.`
        : `Mood hari ini: ${positive}x positif${negative ? ` dan ${negative}x agak berat` : ""}. Lumayan seimbang ya.`;

  const snippets = hasMemory ? mem.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 4) : [];
  const recapTitle = "🌙 *Refleksi Harian*";

  // Copy seeded from user+date so repeated asks are identical that day.
  const seed = `${String(rawUser ?? "shared")}|${localDay(now)}`;
  const closer = pickFrom(
    [
      "Besok tinggal lanjutin pelan-pelan aja. Aku selalu standby. 🌸",
      "Jangan lupa tidur cukup — besok kamu masih punya misi bentuk baru. 😄",
      "Sip, hari ini selesai. Besok kita bikin hari lebih baik lagi. 🌸",
      "Apa pun yang tadi kerasa berat, kamu udah lewatin. Bangga dikit sama diri sendiri.",
    ],
    seed,
  );

  const lines = [recapTitle];
  if (snippets.length) {
    lines.push("Tadi kamu sempat ngobrol soal:");
    snippets.forEach((s) => {
      const inline = s.slice(0, 120);
      lines.push(`  • ${inline}`.substring(0, 200));
    });
  }
  lines.push(moodLine);
  lines.push(closer);
  return lines.join("\n");
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

async function tick(): Promise<void> {
  const now = new Date();
  const day = localDay(now);
  const hour = Number(now.toLocaleString("en-US", { hour12: false, timeZone: "Asia/Jakarta" }).split(":")[0]);
  const target = recapHour();
  if (!target || hour !== target || lastRecapDay === day) return;
  lastRecapDay = day;
  for (const user of allUserKeys()) {
    try {
      const msg = buildEveningRecap(user, now);
      if (!msg) continue; // nothing happened today → stay silent
      const delivered = await pushToOwner(msg);
      if (delivered) console.log(`[recap] pushed for ${user}`);
      else console.log(`[recap] no channel for ${user}, skipped`);
    } catch (e) {
      console.warn(`[recap] failed for ${user}:`, e instanceof Error ? e.message : String(e));
    }
  }
}

/** Start the recap runner. Idempotent. */
export function startRecapRunner(): void {
  if (started) return;
  started = true;
  if (!recapHour()) {
    console.log("[recap] disabled (RECAP_HOUR=0)");
    return;
  }
  console.log(`[recap] starting — daily at ${String(recapHour()).padStart(2, "0")}:00`);
  setTimeout(() => void tick(), 30 * 1000);
  timer = setInterval(() => void tick(), 60 * 1000);
  if (timer && typeof timer.unref === "function") timer.unref();
}

/** For tests: run one tick immediately. */
export async function runRecapTick(): Promise<void> {
  await tick();
}

export function stopRecapRunner(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}