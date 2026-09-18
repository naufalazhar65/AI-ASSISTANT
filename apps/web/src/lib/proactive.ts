// Proactive assistant (P3) — Mia speaks first, initiated from memory, not just
// on schedule. Fills the gap left by heartbeat (task nudges), reminders (exact
// time) and recap (evening wrap): a caring check-in when yesterday was rough
// (negative mood logged) — Mia reaches out once per day, only during waking
// hours, deduped by day+signature, and silent when there's nothing to say.
// Deterministic local data only (no LLM call): works offline and never spams.

import { wibDay, wibDayBefore } from "./time";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { userDataRoot, canonicalUserKey } from "./users";
import { readMoods, moodTone } from "./mood";
import { isFillerLine, isNoiseLine } from "./memoryNoise";
import { readDailyMemory, todayStr } from "./dailyMemory";
import { pushToOwner } from "../channels/pushTarget";
import { proactiveEnabled, proactiveHourStart, proactiveHourEnd } from "./config";
import { greetingFor } from "./briefing";
import { logInfo, logError } from "./appLogger";


function statePath(user: string): string {
  return join(userDataRoot(), user, "context", "proactive.json");
}

function readState(user: string): { lastPushDay: string; lastSignature: string } {
  try {
    const f = statePath(user);
    if (!existsSync(f)) return { lastPushDay: "", lastSignature: "" };
    const parsed = JSON.parse(readFileSync(f, "utf8")) as { lastPushDay?: string; lastSignature?: string };
    return { lastPushDay: parsed.lastPushDay ?? "", lastSignature: parsed.lastSignature ?? "" };
  } catch {
    return { lastPushDay: "", lastSignature: "" };
  }
}

function writeState(user: string, st: { lastPushDay: string; lastSignature: string }): void {
  try {
    const f = statePath(user);
    mkdirSync(dirname(f), { recursive: true });
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, JSON.stringify(st));
    renameSync(tmp, f);
  } catch { /* best-effort */ }
}

function yesterdayDayStr(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return wibDay(d);
}

function localHourJkt(now: Date): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", { hour12: false, hour: "2-digit", timeZone: "Asia/Jakarta" });
    const h = Number(fmt.format(now));
    if (!Number.isNaN(h)) return h;
  } catch { /* fall through */ }
  return Number(now.toLocaleString("en-US", { hour12: false }).split(":")[0]);
}

function isWakingHour(now: Date): boolean {
  const hour = localHourJkt(now);
  if (Number.isNaN(hour)) return false;
  return hour >= proactiveHourStart() && hour < proactiveHourEnd();
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function pickFrom<T>(arr: T[], seed: string): T {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return arr[h % arr.length];
}

/** Build the proactive nudge for a user, or "" when there's nothing worth saying. */
export function buildProactiveMessage(rawUser?: unknown, now = new Date()): string {
  if (!proactiveEnabled()) return "";
  if (!isWakingHour(now)) return "";
  const yday = yesterdayDayStr();
  const yMoods = readMoods(rawUser).filter((m) => {
    try {
      return wibDay(new Date(m.at)) === yday;
    } catch {
      return false;
    }
  });
  // Tone comes from the shared rule (tie = neutral). A "neutral" day still gets a
  // check-in, but NEVER the heavy "kemarin kerasa capek dan berat" claim, which
  // was fabricated whenever ANY negative mood existed.
  const tone = moodTone(yMoods);
  if (!yMoods.length || tone === "positive") return "";

  const mem = readDailyMemory(rawUser, "yesterday");
  // First MEANINGFUL line — skip timestamp headers, [persona] captures, Mia's
  // own lines, and automation junk (a raw "## 2026-09-07T14:40:…Z" leaked into
  // the push otherwise).
  const snippet = /^(No memory|\(empty memory)/.test(mem) ? "" :
    mem.split("\n").map((l) => l.trim()).filter(Boolean)
      .filter((l) => !/^##\s/.test(l) && !/^\[persona\]/i.test(l) && !/^Mia:/i.test(l) && !/\(automation\)/.test(l) && !/laporan terjadwal/i.test(l))
      .map((l) => l.replace(/^User:\s*/, ""))
      .filter((l) => !isFillerLine(l))
      .filter((l) => !isNoiseLine(l))[0] ?? "";

  const seed = `${String(rawUser ?? "shared")}|${yday}`;
  // The nudging window is configurable (morning..evening), so the label must
  // follow the clock — "Check-in pagi" at 4 PM read as a bug.
  const part = greetingFor(now).toLowerCase();
  const opener = pickFrom(tone === "negative" ? [
    "💙 *Inisiatif Mia* — kemarin mood-mu sempat kerasa berat (aku catat sendiri dari yang kamu ceritakan).",
    "💙 *Hai beb* — kemarin aku notice kamu agak berat, mau aku temenin sebentar? 🌸",
    `💙 *Check-in ${part}* — kemarin ada yang ngganjel dan agak berat ya, aku di sini kalau mau cerita.`,
    "💙 *Mia di sini* — kemarin kerasa capek dan berat, aku simpen sebagai pengingat buat lebih gentle hari ini.",
  ] : [
    `💙 *Mia di sini* — ${part} beb. Kemarin moodmu naik-turun (ada cerah, ada berat) — aku simpen catatannya.`,
    `💙 *Check-in ${part}* — kemarin campur aduk ya beb, ada yang bikin seneng ada yang bikin capek. Gimana ${part} ini?`,
  ], seed + ":o");
  const closer = pickFrom([
    "Kamu nggak usah buru-buru balas. Kalau ada yang mau diceritain atau mau aku bantu kecil-kecilin bebannya, aku di sini. 🌸",
    "Santai aja beb, cerita kalau mau — kalau enggak, aku tetap standby di sampingmu.",
    "Mau spill sedikit atau cuma mau ditemenin silent, aku ikut ritmemu ya.",
    "Pelan-pelan aja hari ini — aku siap bantu hal kecil apa pun.",
  ], seed + ":c");
  const lines = [opener];
  if (snippet) lines.push(`  • "${snippet.slice(0, 140)}" — aku inget ini kemarin ✨`);
  lines.push(closer);
  return lines.join("\n");
}

function signatureOf(rawUser: unknown): string {
  const yday = yesterdayDayStr();
  const moods = readMoods(rawUser).filter((m) => {
    try {
      return wibDay(new Date(m.at)) === yday;
    } catch {
      return false;
    }
  });
  const mem = readDailyMemory(rawUser, "yesterday");
  return hash(yday + "|" + JSON.stringify(moods.map((m) => m.mood + ":" + (m.note ?? ""))) + "|" + mem.slice(0, 200));
}


/** Run the proactive nudge pass for all users; returns how many messages were pushed. */
export async function runProactiveNudge(): Promise<number> {
  const day = todayStr();
  let pushed = 0;
  // Owner only (anti-spam): one nudge per slot, not one per profile on the box.
  {
    const owner = canonicalUserKey("naufalazhar652952") || "naufalazhar652952";
    try {
      const wrote = await proactivePushForUser(owner, day);
      if (wrote) pushed++;
    } catch (e) {
      logError("proactive", `failed for ${owner}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return pushed;
}

async function proactivePushForUser(user: string, day: string): Promise<boolean> {
  const msg = buildProactiveMessage(user);
  if (!msg) return false;
  const st = readState(user);
  if (st.lastPushDay === day) return false;
  const sig = signatureOf(user);
  if (st.lastSignature === sig) return false;
  const delivered = await pushToOwner(msg);
  if (delivered) {
    writeState(user, { lastPushDay: day, lastSignature: sig });
    logInfo("proactive", `pushed for ${user}`);
  }
  return delivered;
}