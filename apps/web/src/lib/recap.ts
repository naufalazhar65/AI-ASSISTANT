// Evening recap ("refleksi malam") — fun/persona feature (B3).
//
// Every evening at RECAP_HOUR Mia composes a short, warm recap of the user's
// day from local data: today's daily memory (memory/YYYY-MM-DD.md, written every
// turn) and today's mood entries (moods.json). Deterministic template text —
// no LLM call, works offline/mock. The runner mirrors `heartbeat.ts`: one
// in-process interval, silent when no data for the day (no spam).

import { wibDay } from "./time";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { appRoot, canonicalUserKey } from "./users";
import { readDailyMemory } from "./dailyMemory";
import { readMoods, moodTone, NEGATIVE_MOODS, POSITIVE_MOODS } from "./mood";
import { pushToOwner } from "../channels/pushTarget";
import { recapHour } from "./config";
import { logInfo, logError } from "./appLogger";
import { isFillerLine, isInternalTurn, isNoiseLine, redactSecrets } from "./memoryNoise";
import { contentTokens, similarity } from "./dupes";
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
  // Automation/system injection + internal carriers (rolling summary, self-correct,
  // superseded) — never real conversation, never the user's words.
  if (isInternalTurn(line)) return true;
  // Tool calls / payloads / shell flags / auth ids — never human conversation.
  if (isNoiseLine(line)) return true;
  // Pure small-talk ("alooo beb") is not a "highlight of the day".
  if (isFillerLine(line)) return true;
  return false;
}

/** Drop URLs/punctuation before comparing asks (so the same request with and
 *  without its link is recognised). Pure. */
function stripUrl(s: string): string {
  return s.replace(/https?:\/\/\S+/gi, " ").replace(/[^\p{L}\p{N}\s]/gu, " ").toLowerCase();
}

/** Drop the "Mas Naufal: " speaker label so it cannot act as a topic token. */
function stripLabel(s: string): string {
  return s.replace(/^[^:]{1,30}:\s*/, "");
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
  // Collapse asks about the SAME topic, then keep at most 4 (most recent last).
  // A prefix key missed paraphrases; Jaccard alone is too weak on long sentences
  // (four variants of one pentest ask all survived the reflection).
  const uniq: string[] = [];
  const all = out.map((s) => contentTokens(stripLabel(stripUrl(s))));
  // A "topic token" is distinctive: shared by some asks but NOT by all of them
  // (the speaker label/salutation appears everywhere and would collapse all).
  const topicCount = new Map<string, number>();
  for (const toks of all) for (const t of toks) if (t.length >= 5) topicCount.set(t, (topicCount.get(t) ?? 0) + 1);
  const isTopic = (t: string) => t.length >= 5 && (topicCount.get(t) ?? 0) > 1 && (topicCount.get(t) ?? 0) < all.length;
  for (let i = 0; i < out.length; i++) {
    const keep = uniq.map((u) => contentTokens(stripLabel(stripUrl(u))));
    const mine = all[i];
    const sameTopic =
      keep.some((k) => similarity([...k].join(" "), [...mine].join(" ")) >= 0.4) ||
      keep.some((k) => [...mine].some((t) => isTopic(t) && k.has(t)));
    if (sameTopic) continue;
    uniq.push(out[i]);
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
                `Hari ini campur aduk ya beb (${negative}x berat, ${positive}x baik). Nggak apa-apa, besok kita mulai lagi dari awal 🌸`,
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
  // ONE reflection for the owner, like the briefing: looping every profile on
  // this machine (aliases + leftovers) pushed the same evening several times.
  const owner = canonicalUserKey("naufalazhar652952") || "naufalazhar652952";
  try {
    const msg = buildEveningRecap(owner, now);
    if (!msg) return; // nothing happened today → stay silent
    const delivered = await pushToOwner(msg);
    if (delivered) logInfo("recap", `pushed for ${owner} (single)`);
    else logInfo("recap", `no channel for ${owner}, skipped`);
  } catch (e) {
    logError("recap", `failed for ${owner}: ${e instanceof Error ? e.message : String(e)}`);
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