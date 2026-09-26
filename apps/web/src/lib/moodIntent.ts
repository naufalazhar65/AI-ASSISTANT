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
// LIVE BUG 2026-09-26 (7 fake mood entries): the keyword alternations had NO
// word boundaries, so any SUBSTRING matched — "markdown" contains "down" and
// every pentest ask with "report markdown nya" logged mood=sad. Keywords are
// now \b-anchored with optional Indonesian clitics (capeknya/sedihku), and a
// negation directly before the keyword cancels it ("belum ngantuk" is NOT
// tired — the owner was saying the opposite).
const negatedBefore = (text: string, index: number): boolean =>
  /\b(belum|nggak|gak|ngga|kagak|tidak|kurang|jangan|not)\s*$/i.test(text.slice(Math.max(0, index - 24), index));
// Clitics are written INLINE in each literal below (interpolating them into a
// regex literal via string concat silently breaks the pattern — caught live).
const MOOD_PATTERNS: Array<{ mood: Mood; re: RegExp }> = [
  { mood: "stressed", re: /(aku|gue|saya)?\s*(lagi|sedang|lag|today)?\s*\b(stres|stress|setres|panik|kewalahan|sumpek|numpuk|banyak\s*banget\s*kerja|kerjaan\s*numpuk)(?:nya|ku|mu)?\b/i },
  { mood: "sad", re: /(aku|gue|saya)?\s*(lagi|sedang)?\s*\b(sedih|galau|down|gak\s*enak\s*hati|kecewa|hancur|kesepian)(?:nya|ku|mu)?\b/i },
  { mood: "tired", re: /(aku|gue|saya)?\s*(lagi|sedang)?\s*\b(capek|lelah|lelah\s*sekali|mengantuk|ngantuk|letih|habis\s*energi|drained)(?:nya|ku|mu)?\b/i },
  { mood: "anxious", re: /(aku|gue|saya)?\s*(lagi|sedang)?\s*\b(cemas|gelisah|khawatir|worried|anxious|takut\s*dan\s*gelisah)(?:nya|ku|mu)?\b/i },
  { mood: "angry", re: /(aku|gue|saya)?\s*(lagi|sedang)?\s*\b(marah|kesel|kesal|meltdown|frustasi|dongkol|geram)(?:nya|ku|mu)?\b/i },
  { mood: "okay", re: /(aku|gue|saya)?\s*(lagi|sedang|feeling)?\s*\b(biasa\s*aja|ok\s*aja|oke\s*aja|fine|so\s*so|netral)(?:nya|ku|mu)?\b/i },
  { mood: "good", re: /(aku|gue|saya)?\s*(lagi|sedang)?\s*\b(senang|gembira|semangat|happy|cheerful|ceria|seneng)(?:nya|ku|mu)?\b/i },
  { mood: "great", re: /(aku|gue|saya)?\s*(lagi|sedang)?\s*\b(bahagia|excited|luar\s*biasa|great|on\s*fire|pokoknya\s*enak)(?:nya|ku|mu)?\b/i },
];

/** Return the first matching mood pattern (order = priority) or null. */
export function detectMoodIntent(userText: string): { mood: Mood; note?: string } | null {
  if (!userText) return null;
  const text = userText.trim();
  // Only share when the user is actually reporting state (not a random mention).
  if (text.length > 200) return null;
  for (const p of MOOD_PATTERNS) {
    const m = p.re.exec(text);
    if (!m) continue;
    // A negation immediately before the keyword inverts the meaning — "belum
    // ngantuk nich" is NOT tired, it is the opposite. Skip this pattern (a
    // later pattern may still legitimately match another keyword).
    if (negatedBefore(text, m.index)) continue;
    const note = text.replace(/[ '"“”`]/g, "").slice(0, 140);
    return { mood: p.mood, note };
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