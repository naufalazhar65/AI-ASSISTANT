// Evening recap ("refleksi malam") — fun/persona feature (B3).
//
// Every evening at RECAP_HOUR Mia composes a short, warm recap of the user's
// day from local data: today's daily memory (memory/YYYY-MM-DD.md, written every
// turn) and today's mood entries (moods.json). Deterministic template text —
// no LLM call, works offline/mock. The runner mirrors `heartbeat.ts`: one
// in-process interval, silent when no data for the day (no spam).

import { wibDay } from "./time";
import { readdirSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { userDataRoot, appRoot, isTestUserKey, canonicalUserKey } from "./users";
import { readDailyMemory } from "./dailyMemory";
import { readMoods, moodTone, NEGATIVE_MOODS, POSITIVE_MOODS } from "./mood";
import { pushToOwner } from "../channels/pushTarget";
import { recapHour } from "./config";
import { logInfo, logError } from "./appLogger";
import { isFillerLine, isNoiseLine, redactSecrets } from "./memoryNoise";
import { alreadyStarted, resetStarted } from "./once";

let timer: NodeJS.Timeout | null = null;
let lastRecapDay = readLastRecapDay();

// Persist the last recap day to disk (`.data/recap-state.json`) so a server
// restart mid-day can't re-fire the evening recap for the same day. Without
// this, `lastRecapDay` lived only in memory — a restart at/near recap hour
// pushed duplicates.

function recapStateFile(): string {
  return join(appRoot(), ".data", "recap-state.json");
}

/** For tests: persist the last-recap day to disk. */
export function saveLastRecapDay(day: string): void {
  try {
    const file = recapStateFile();
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ lastRecapDay: day }, null, 2));
    renameSync(tmp, file);
  } catch {
    /* best-effort — worst case one duplicate after a restart */
  }
}

/** For tests: read the persisted last-recap day from disk. */
export function readLastRecapDay(): string {
  try {
    const raw = readFileSync(recapStateFile(), "utf8");
    const data = JSON.parse(raw) as { lastRecapDay?: string };
    return typeof data.lastRecapDay === "string" ? data.lastRecapDay : "";
  } catch {
    return "";
  }
}

function todayMoods(rawUser?: unknown): { mood: string; note?: string }[] {
  const today = wibDay(new Date());
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

// Content that should never surface in a recap: raw timestamp headers,
// persona-fact log lines, and injected system/automation turn texts (the user
// never actually said those — they came from schedulers/capture, not the chat).
function isJunkLine(line: string): boolean {
  if (!line || /^\s*$/.test(line)) return true;
  if (/^##\s/.test(line)) return true; // "## 2026-09-06T11:41:29.555Z"
  if (/^\[persona\]/i.test(line)) return true; // persona capture log
  // Automation/system injection inside a "User:" turn — not real conversation.
  if (/terjadwal \(automation\)|\[Scheduled automation\]|laporan terjadwal/i.test(line)) return true;
  // Tool calls / payloads / shell flags / auth ids — never human conversation.
  if (isNoiseLine(line)) return true;
  // Pure small-talk ("alooo beb") is not a "highlight of the day".
  if (isFillerLine(line)) return true;
  return false;
}

/** Clean the daily-memory text into human conversation snippets for the recap. */
function cleanSnippets(mem: string): string[] {
  const out: string[] = [];
  for (const raw of mem.split("\n")) {
    const line = raw.trim();
    if (isJunkLine(line)) continue;
    // Recap "highlights" = what the HUMAN talked about. Mia's turns and orphan
    // lines (system/technical text) made the reflection read like a log.
    const m = line.match(/^User:\s*(.*)$/i);
    if (!m) continue;
    const body = redactSecrets(m[1]).replace(/\s+/g, " ").trim().slice(0, 140);
    if (!body || isJunkLine(body)) continue;
    out.push(`Mas Naufal: ${body}`);
  }
  // Collapse near-duplicates & keep at most 4, most recent at the end.
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const s of out) {
    const key = s.toLowerCase().slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(s);
  }
  return uniq.slice(-4);
}

/** Build the recap text for one user's day. Returns "" when nothing happened. */
export function buildEveningRecap(rawUser?: unknown, now = new Date()): string {
  const mem = readDailyMemory(rawUser, "today");
  const hasMemory = !/^(No memory|\(empty memory)/.test(mem);
  const moods = todayMoods(rawUser);

  if (!hasMemory && !moods.length) return "";

  // ONE tone rule shared with the briefing / proactive nudge / weekly insight.
  const tone = moodTone(moods);
  const positive = moods.filter((m) => (POSITIVE_MOODS as readonly string[]).includes(m.mood)).length;
  const negative = moods.filter((m) => (NEGATIVE_MOODS as readonly string[]).includes(m.mood)).length;

  const snippets = hasMemory ? cleanSnippets(mem) : [];

  // Nothing meaningful to reflect on — stay silent rather than push filler.
  if (!snippets.length && !moods.length) return "";

  const seed = `${String(rawUser ?? "shared")}|${wibDay(now)}`;
  const moodLine =
    moods.length === 0
      ? null
      : tone === "negative"
        ? pickFrom([
            `Hari ini agak menguras ya (${positive}x baik, ${negative}x berat) — terima kasih sudah bertahan, aku di sini kalau mau cerita 🌸`,
            `Beberapa momen hari ini kerasa berat (${negative}x berat), tapi kamu tetap jalanin — keren beb`,
            `Hari ini ada naik-turun, yang berat ${negative}x nongol. Istirahat yang enak ya malam ini.`,
          ], seed + ":mood")
        : tone === "positive"
          ? pickFrom([
              `Mood-mu hari ini lumayan baik (${positive}x positif${negative ? `, ${negative}x agak berat` : ""}) — seneng lihatnya! ✨`,
              `Hari ini vibes kamu oke (${positive}x positif) — pertahankan ya beb 🌸`,
              `Hari ini banyak momen baik (${positive}x) — aku simpan sebagai energi buat besok!`,
            ], seed + ":pos")
          : moods.length > 0
            ? pickFrom([
                `Hari ini moodmu naik-turun (${positive}x positif, ${negative}x berat) — wajar kok, istirahat yang enak ya malam ini.`,
                `Hari ini campur aduk ya beb (${negative}x berat, ${positive}x baik). Nggak apa-apa, besok fresh start 🌸`,
              ], seed + ":moodNeutral")
            : `Hari ini kamu story-telling banyak, tapi mood belum ke-log — gapapa, aku dengerin terus.`;
  const openers = [
    "Tadi kita sempat ngobrol seru soal:",
    "Sebentar-sebentar aku inget kita tadi ngobrol soal:",
    "Tadi yang kita omongin antara lain:",
    "Hari ini jejak obrolan kita:",
    "Kalau di-rewind, tadi kita ngulik:",
    "Highlight hari ini — kita bahas:",
  ];
  const closers = [
    "Besok tinggal lanjutin pelan-pelan aja. Aku selalu standby. 🌸",
    "Jangan lupa tidur cukup — besok masih ada hari baru buat kamu. 😄",
    "Sip, hari ini selesai. Besok kita bikin hari lebih baik lagi. 🌸",
    "Apa pun yang tadi kerasa berat, kamu udah lewatin. Bangga dikit sama diri sendiri.",
    "Malam ini rebahan yang enak ya — besok kita lanjut petualangan baru ✨",
    "Kamu udah keren hari ini. Selamat istirahat, beb 🌙",
    "Sampai besok — aku jaga memory hari ini baik-baik.",
    "Tidur nyenyak, mimpi indah — besok kita bikin lebih seru lagi!",
  ];
  const opener = pickFrom(openers, seed + ":o");
  const closer = pickFrom(closers, seed);

  const lines = ["🌙 *Refleksi Malammu*"];
  if (snippets.length) {
    lines.push(opener);
    snippets.forEach((s) => lines.push(`  • ${s}`));
  }
  const moodLineSafe = moodLine && moodLine.length > 0 ? moodLine : "Semoga istirahatmu cukup ya, Mas Naufal.";
  lines.push(moodLineSafe);
  lines.push(closer);
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
  const day = wibDay(now);
  let hour = NaN;
  try {
    const fmt = new Intl.DateTimeFormat("en-US", { hour12: false, hour: "2-digit", timeZone: "Asia/Jakarta" });
    hour = Number(fmt.format(now));
  } catch { /* fall through */ }
  const target = recapHour();
  if (Number.isNaN(hour) || !target || hour !== target || lastRecapDay === day) return;
  lastRecapDay = day;
  saveLastRecapDay(day);
  for (const user of allUserKeys()) {
    try {
      const msg = buildEveningRecap(user, now);
      if (!msg) continue; // nothing happened today → stay silent
      const delivered = await pushToOwner(msg);
      if (delivered) logInfo("recap", `pushed for ${user}`);
      else logInfo("recap", `no channel for ${user}, skipped`);
    } catch (e) {
      logError("recap", `failed for ${user}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** Start the recap runner. Idempotent. */
export function startRecapRunner(): void {
  // globalThis guard (see lib/once.ts): HMR must not add a second timer.
  if (alreadyStarted("recap")) return;
  if (!recapHour()) {
    logInfo("recap", "disabled (RECAP_HOUR=0)");
    return;
  }
  logInfo("recap", `starting — daily at ${String(recapHour()).padStart(2, "0")}:00`);
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
  resetStarted("recap");
}