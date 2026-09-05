// Mood tracking (Mia feature 2026-09-05). Persistent per-user mood log so Mia
// can know "kamu sedang butuh apa" and offer support/recommendations.
//
// A mood entry is {id, mood, note, at}. `mood` is one of a small fixed set so
// it's stable for pattern analysis ("stressed", "sad", "good", ...). `note` is
// optional free text ("kerjaan numpuk banget"). Store is a per-user JSON file
// (same atomic-write + sanitized user-key pattern as tasks/notes/reminders):
// apps/web/.data/users/<user>/moods.json
//
// Reading never throws (missing/corrupt file → empty). Moods are chronological;
// we keep the most recent MAX_MOODS for trend analysis in chat.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";

/** Fixed, stable mood vocabulary for pattern analysis. */
export const MOOD_VALUES = [
  "great",
  "good",
  "okay",
  "meh",
  "stressed",
  "anxious",
  "sad",
  "tired",
  "angry",
] as const;

export type Mood = (typeof MOOD_VALUES)[number];

export interface MoodEntry {
  id: string;
  mood: Mood;
  /** Optional free-text detail ("kerjaan numpuk banget"). */
  note?: string;
  /** Epoch ms of when this was recorded. */
  at: number;
}

const MAX_MOODS = 200;

/** Dedupe window: identical moods logged this close together collapse to one. */
const DEDUPE_WINDOW_MS = 10_000;

function moodsPath(userKey: string): string {
  return join(userDataRoot(), userKey, "moods.json");
}

export function readMoods(rawUser?: unknown): MoodEntry[] {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return [];
  try {
    const raw = readFileSync(moodsPath(userKey), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is MoodEntry =>
        !!e &&
        typeof (e as MoodEntry).id === "string" &&
        typeof (e as MoodEntry).mood === "string" &&
        MOOD_VALUES.includes((e as MoodEntry).mood as Mood) &&
        typeof (e as MoodEntry).at === "number"
    );
  } catch {
    return [];
  }
}

function writeMoods(moods: MoodEntry[], userKey: string): void {
  const file = moodsPath(userKey);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(moods, null, 2));
  renameSync(tmp, file);
}

/** Normalize a raw mood string to one of the fixed set (falls back to "meh"). */
function normalizeMood(value: unknown): Mood {
  const v = String(value ?? "").toLowerCase().trim();
  const map: Record<string, Mood> = {
    great: "great", happy: "great", senang: "great", semangat: "great", bahagia: "great",
    good: "good", baik: "good", gembira: "good", fine: "good",
    okay: "okay", ok: "okay", oke: "okay", biasa: "okay", biasa_aja: "okay",
    meh: "meh", so_so: "meh", bosan: "meh", netral: "meh",
    stressed: "stressed", stress: "stressed", stres: "stressed", overwhelmed: "stressed", sumpek: "stressed",
    anxious: "anxious", cemas: "anxious", gelisah: "anxious", khawatir: "anxious",
    sad: "sad", sedih: "sad", down: "sad", galau: "sad",
    tired: "tired", capek: "tired", lelah: "tired", exhausted: "tired", mengantuk: "tired",
    angry: "angry", marah: "angry", kesal: "angry", frustasi: "angry",
  };
  return map[v] ?? (MOOD_VALUES.includes(v as Mood) ? (v as Mood) : "meh");
}

/**
 * Log a mood for the user. Returns the saved entry. Empty mood → rejects with
 * an error so the caller can tell the user it was invalid.
 *
 * The `mood_log` tool (called by the model mid-turn) and the deterministic
 * `logDetectedMood` capture (run after the turn) can BOTH fire on the same
 * utterance; a mood entry identical to the previous one within
 * `DEDUPE_WINDOW_MS` is treated as such a duplicate and collapsed into the
 * existing entry instead of stacking two rows.
 */
export function addMood(moodValue: unknown, rawUser?: unknown, note?: unknown): MoodEntry {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) throw new Error("invalid user");
  const mood = normalizeMood(moodValue);
  const trimmed = typeof note === "string" ? note.trim().slice(0, 300) : "";
  const moods = readMoods(rawUser);
  const last = moods[moods.length - 1];
  if (last && last.mood === mood && Date.now() - last.at < DEDUPE_WINDOW_MS) {
    return last;
  }
  const entry: MoodEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    mood,
    ...(trimmed ? { note: trimmed } : {}),
    at: Date.now(),
  };
  moods.push(entry);
  while (moods.length > MAX_MOODS) moods.shift();
  writeMoods(moods, userKey);
  return entry;
}

/**
 * Human-readable mood log summary, newest first, for the chat. Options:
 *  - `since`: only moods at/after this epoch ms (used for "how have I been").
 */
export function listMoods(rawUser?: unknown, since?: number): string {
  const moods = readMoods(rawUser);
  const filtered = since ? moods.filter((m) => m.at >= since) : moods;
  if (!filtered.length) return "Belum ada catatan mood.";
  const rows = [...filtered].reverse().map((m) => {
    const when = new Date(m.at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
    return `- ${when}: ${m.mood}${m.note ? ` (${m.note})` : ""}`;
  });
  return rows.slice(0, 25).join("\n");
}

/**
 * Recent-mood trend summary: e.g. "terakhir kali stres 2 hari lalu; 3 dari 5
 * hari terakhir stressed". Lightweight; purely for Mia's reply, no ML.
 */
export function moodTrend(rawUser?: unknown): string {
  const moods = readMoods(rawUser);
  if (!moods.length) return "Belum ada data mood.";
  const last = moods[moods.length - 1]!;
  const days = Math.max(1, Math.round((Date.now() - last.at) / 86400000));
  const recent = moods.filter((m) => m.at >= Date.now() - 7 * 86400000);
  const stressed = recent.filter((m) => m.mood === "stressed" || m.mood === "anxious" || m.mood === "angry").length;
  const good = recent.filter((m) => m.mood === "great" || m.mood === "good" || m.mood === "okay").length;
  const lastLabel = new Date(last.at).toLocaleDateString("en-GB", { dateStyle: "medium" });
  const parts = [`terakhir (${lastLabel}) kamu ${last.mood}${last.note ? ` — "${last.note}"` : ""}`];
  if (recent.length >= 3) {
    parts.push(`${days} hari terakhir: ${good}x positif, ${stressed}x stres`);
  }
  return parts.join("; ") + ".";
}