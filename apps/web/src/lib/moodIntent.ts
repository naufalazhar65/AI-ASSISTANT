// Deterministic mood detection (Mia feature 2026-09-05). Companion to the
// `mood_log`/`mood_recent` tools: models (esp. local OpenCode) often skip tool
// calls, so we detect mood statements directly in the user's message and log
// them via `addMood` — "aku lagi stres banget" should register even if the
// model never emits a tool call. Runs after each turn like the reminder intent
// path. When state-of-mind statements appear, this returns the detected mood +
// note (or null), never throws.

import { addMood, Mood } from "./mood";

// Positive / neutral / negative state keywords, ordered so "stres" beats
// generic "capek" when both appear. Kept deliberately small and exact.
const MOOD_PATTERNS: Array<{ mood: Mood; re: RegExp }> = [
  { mood: "stressed", re: /(aku|gue|saya)?\s*(lagi|sedang|lag|today)?\s*(stres|stress|setres|panik|kewalahan|sumpek|numpuk|banyak\s*banget\s*kerja|kerjaan\s*numpuk)/i },
  { mood: "sad", re: /(aku|gue|saya)?\s*(lagi|sedang)?\s*(sedih|galau|down|gak\s*enak\s*hati|kecewa|hancur|kesepian)/i },
  { mood: "tired", re: /(aku|gue|saya)?\s*(lagi|sedang)?\s*(capek|lelah|lelah\s*sekali|mengantuk|ngantuk|letih|habis\s*energi|drained)/i },
  { mood: "anxious", re: /(aku|gue|saya)?\s*(lagi|sedang)?\s*(cemas|gelisah|khawatir|worried|anxious|takut\s*dan\s*gelisah)/i },
  { mood: "angry", re: /(aku|gue|saya)?\s*(lagi|sedang)?\s*(marah|kesel|kesal|meltdown|frustasi|dongkol|geram)/i },
  { mood: "okay", re: /(aku|gue|saya)?\s*(lagi|sedang|feeling)?\s*(biasa\s*aja|ok\s*aja|oke\s*aja|fine|so\s*so|netral)/i },
  { mood: "good", re: /(aku|gue|saya)?\s*(lagi|sedang)?\s*(senang|gembira|semangat|happy|cheerful|ceria|seneng)/i },
  { mood: "great", re: /(aku|gue|saya)?\s*(lagi|sedang)?\s*(bahagia|excited|luar\s*biasa|great|on\s*fire|pokoknya\s*enak)/i },
];

/** Return the first matching mood pattern (order = priority) or null. */
export function detectMoodIntent(userText: string): { mood: Mood; note?: string } | null {
  if (!userText) return null;
  const text = userText.trim();
  // Only share when the user is actually reporting state (not a random mention).
  if (text.length > 200) return null;
  for (const p of MOOD_PATTERNS) {
    const m = p.re.exec(text);
    if (m) {
      const note = text.replace(/['"“”`]/g, "").slice(0, 140);
      return { mood: p.mood, note };
    }
  }
  return null;
}

/** Best-effort log of a detected mood; never throws. Returns true when logged. */
export function logDetectedMood(userText: string, rawUser?: unknown): boolean {
  const hit = detectMoodIntent(userText);
  if (!hit) return false;
  try {
    addMood(hit.mood, rawUser, hit.note);
    return true;
  } catch {
    return false;
  }
}