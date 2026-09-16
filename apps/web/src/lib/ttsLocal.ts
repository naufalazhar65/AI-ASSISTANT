// Local Indonesian TTS via macOS `say` (voice: Damayanti, id_ID) + afconvert.
//
// Why: Groq Orpheus has no Indonesian model, so Indonesian was read with English
// pronunciation. macOS ships a real Indonesian voice and works fully offline —
// no key, no quota, instant. Used only when the text looks Indonesian AND the
// platform provides the tools; otherwise the caller falls back to the provider.
//
// macOS only (guard on process.platform); returns null on any failure so the
// existing provider path is never broken.

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Common Indonesian function words / verb-ish tokens (lowercased). */
const ID_WORDS = new Set([
  "yang", "dan", "aku", "kamu", "saya", "anda", "dia", "kita", "kami", "mereka",
  "tidak", "tak", "bukan", "jangan", "sudah", "belum", "masih", "akan", "sedang",
  "dengan", "untuk", "dari", "ke", "di", "pada", "ini", "itu", "ada", "juga",
  "apa", "siapa", "kapan", "dimana", "kemana", "bagaimana", "kenapa", "karena",
  "bisa", "dapat", "mau", "ingin", "harus", "perlu", "tolong", "silakan", "maaf",
  "terima", "kasih", "sama", "atau", "tapi", "tetapi", "kalau", "jika", "biar",
  "buat", "bikin", "pesan", "ingat", "ingetin", "catat", "kirim", "buka", "tutup",
  "jam", "menit", "hari", "besok", "kemarin", "sekarang", "nanti", "pagi", "siang",
  "sore", "malam", "makan", "minum", "tidur", "bangun", "kerja", "tugas",
  "cuaca", "hujan", "panas", "lagi", "aja", "saja", "kok", "sih", "dong", "ya",
  "baik", "oke", "siap", "betul", "benar", "salah", "bagus", "senang", "sedih",
  "capek", "lelah", "stres", "semangat", "hati", "cinta", "sayang", "teman",
]);

/**
 * Heuristic Indonesian detector (Latin script). Conservative so English prose is
 * never misrouted. Pure — unit-tested.
 */
export function looksIndonesian(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(t)) return false; // Arabic, not Indonesian
  const words = t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  let hits = 0;
  for (const w of words) if (ID_WORDS.has(w)) hits++;
  const ratio = hits / words.length;
  const hasAffix = words.some((w) => /^(me|ber|ter|pe|di)[a-z]{3,}/.test(w) || /(kan|nya)$/.test(w));
  // Any of: a healthy stopword ratio, several hits plus an affix, or 3+ hits.
  return ratio >= 0.25 || (hits >= 2 && hasAffix) || hits >= 3;
}

/** Local Indonesian TTS is available only on macOS with the system tools. */
export function localIdTtsEnabled(): boolean {
  return process.platform === "darwin" && process.env.TTS_LOCAL_ID !== "0";
}

function execFileP(bin: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Synthesize Indonesian speech to a 16-bit PCM WAV using `say` + `afconvert`.
 * Returns null (never throws) when unavailable/failed so the caller can fall back.
 */
export async function sayToWav(text: string, voice = process.env.TTS_ID_VOICE || "Damayanti"): Promise<Buffer | null> {
  if (!localIdTtsEnabled()) return null;
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "mia-tts-id-"));
    const aiff = join(dir, "a.aiff");
    const wav = join(dir, "a.wav");
    // `say` writes AIFF; --data-format is rejected for AIFF ("Opening output file
    // failed: fmt?"), so let `say` pick and convert with afconvert instead.
    await execFileP("say", ["-v", voice, "-o", aiff, text], 20_000);
    await execFileP("afconvert", ["-f", "WAVE", "-d", "LEI16@22050", aiff, wav], 20_000);
    const buf = readFileSync(wav);
    return buf.length > 100 ? buf : null;
  } catch {
    return null;
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}
