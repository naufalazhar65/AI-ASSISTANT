// Spotify request detection (Indonesian + English). Strong trigger: an explicit
// play verb attached to "lagu/song/musik/playlist/album". We then extract the
// query that follows (strip platform mention + filler particles) so the search
// hits the right track/playlist instead of the whole sentence.

const NOUN = "(?:lagu|song|musik|music|playlist|album)";
const VERB = "(?:putar(?:in|kan)?|play|mainkan|dengerin|stel|nyalain)";
// A play verb or a polite particle followed by the music noun:
//   "putar lagu X", "coba lagu X", "tolong lagu X", "mau dengerin lagu X".
const STRONG_RE = new RegExp(
  "\\b(?:(?:coba|tolong|mau|ingin|dengar(?:in|kan)?)\\s+)?" + VERB + "\\s+" + NOUN + "\\b|\\b(?:(?:coba|tolong\\s+)?)(" + NOUN + ")\\b",
  "i"
);

const VERB_NOUN_RE = new RegExp(
  "(?:(?:coba|tolong|mau|ingin|dengar(?:in|kan)?)\\s+)?" + VERB + "\\s+(" + NOUN + ")|(?:(?:coba|tolong)\\s+)(" + NOUN + ")",
  "i"
);

export interface SpotifyIntent {
  query: string;
  kind?: "playlist" | "album" | "track";
}

/**
 * Resume intent: "play lagi", "putar lagi lagunya", "lanjutin lagu" — the user
 * wants the CURRENT (paused) track, not a search. Must be checked before the
 * search path, otherwise the model reuses a stale query from history and
 * replays the wrong (older) song.
 */
export function detectSpotifyResume(text: string): boolean {
  if (!text) return false;
  const t = text.replace(/\s+/g, " ").trim().slice(0, 200);
  return (
    /\b(?:play|putar(?:in|kan)?)\s+lagi\b/i.test(t) ||
    /\b(?:lagu|musik)\s+(?:lagi|tadi)\b/i.test(t) ||
    /\blanjut(?:in|kan)?\s+(?:lagu|musik|laginya|lagunya)\b/i.test(t)
  );
}

/**
 * A question ABOUT the current track ("sedang putar lagu apa", "lagu apa yang
 * lagi diputar", "what's playing") is a STATUS query — never a play command.
 * Without this guard the phrase "putar lagu" matched and the question word
 * ("apa") was used as the search query, so Mia played the top hit for "apa".
 */
const NOW_PLAYING_Q_RE =
  /\b(?:lagu|musik|song|track)\s+apa\b|\bapa\s+(?:yang\s+)?(?:lagi\s+)?(?:diputar|diputarkan|diputer|dimainkan|main|dengerin|didengar)\b|\bwhat(?:'s| is)\s+(?:currently\s+)?playing\b|\bjudul\s+(?:lagu|musik)s?\b|\bsedang\s+(?:putar|dengar|main)\w*\s+apa\b|\blagu\s+(?:yang\s+)?(?:sekarang|lagi)\b/i;

export function detectSpotifyIntent(text: string): SpotifyIntent | null {
  if (text && NOW_PLAYING_Q_RE.test(text)) return null;
  const strong = STRONG_RE.test(text);
  if (!strong) return null;

  const m = text.match(VERB_NOUN_RE);
  if (!m) return null;

  const noun = ((m[1] || m[2]) ?? "").toLowerCase();
  const kind =
    noun === "playlist" ? "playlist" : noun === "album" ? "album" : "track";

  const afterVerb = text.slice(m.index! + m[0].length).trim();
  const cleaned = afterVerb
    .replace(/\s+(?:di|on|ke|untuk|pake|pakai)\s+spotify\b.*$/i, "")
    .replace(
      /\b(?:dong|ya|yuk|deh|donk|lah|beb|mas|bang|kak|plis|please|a|nya|sih|coba|tolong|bantu|aku|gue|saya|kan|itu|ini|kesana|kesini|distu|disini|begitu|begini|gitu|gini|apa|yang|sekarang|sedang|diputar|diputarkan)\b.*$/i,
      ""
    )
    .trim()
    .replace(/^[\s\-:"]+|[\s\-:"]+$/g, "");

  // A deictic/question remnant ("itu", "ini", "apa") has no searchable content —
  // return null so the caller falls back to the model's own (context-aware) query.
  if (!cleaned) return null;
  return { query: cleaned, kind };
}

export type SpotifyControl = "pause" | "next" | "previous" | "volume";

export interface SpotifyControlIntent {
  action: SpotifyControl;
  value?: number;
}

const PAUSE_RE = /\b(?:pause|jeda|berhenti|berhentiin|stop|matikan)\s*(?:lagu|musik|nyanyian)?\b/i;
const NEXT_RE = /\b(?:next|skip|lanjut\s+lagu|ganti\s+lagu|pindah\s*(?:ke)?\s*(?:lagu|next)|lewati)\b/i;
const PREV_RE = /\b(?:previous|prev|kembali\s+ke\s+lagu|lagu\s+sebelumnya|mundur)\b/i;
const VOLUME_RE = /\b(?:volume|besarin\s+suara|kecilin\s+suara|naikin\s+volume|turunin\s+volume|keras(?:in)?|pelan(?:in)?)\s*(?:\(|lagu|suara)?\b\s*(\d{1,3})?/i;


/**
 * True when "stop/pause" is meant for WHEN THE SONG ENDS ("stop aja kalau
 * lagunya udah selesai", "matiin biar ga bablas sampe pagi") — that must become
 * a sleep timer, NOT an immediate pause. Pure — unit-tested.
 */
export function detectSpotifyAfterTrack(text: string): boolean {
  const t = (text || "").toLowerCase();
  if (!t) return false;
  const stop = /(stop|matiin|matikan|jeda|pause|berhenti|mati)/.test(t);
  if (!stop) return false;
  const afterWord = /(setelah|sesudah|abis|habis|selesai|berakhir|kelar|kalau|kalo|bila|udah|sudah)/.test(t);
  const songEnd = /(lagu(nya)?|musik(nya)?|nyanyian(nya)?)\s*(ini|itu|udah|sudah)?\s*(selesai|habis|abis|berakhir|kelar)?/.test(t);
  const bablas = /bablas/.test(t);
  // "stop ... setelah/kalau ... lagu (selesai)" or the "biar ga bablas" idiom
  return (afterWord && songEnd) || bablas || /(selesai|habis|abis|berakhir|kelar)[^.!?]{0,25}(stop|matiin|matikan|jeda|pause|berhenti)/.test(t);
}

/** The spotify_* tool that performs a given control action (turn-dedupe key). */
export function spotifyControlToolName(action: string): string {
  return action === "pause" ? "spotify_pause"
    : action === "next" ? "spotify_next"
    : action === "previous" ? "spotify_previous"
    : action === "volume" ? "spotify_volume"
    : "spotify_play";
}

export function detectSpotifyControl(text: string): SpotifyControlIntent | null {
  // "stop kalau lagunya udah selesai" is a SLEEP TIMER, not an immediate pause.
  if (detectSpotifyAfterTrack(text)) return null;
  if (PAUSE_RE.test(text)) return { action: "pause" };
  if (NEXT_RE.test(text)) return { action: "next" };
  if (PREV_RE.test(text)) return { action: "previous" };
  const vm = text.match(VOLUME_RE);
  if (vm) {
    const raw = vm[1];
    if (raw !== undefined) {
      const v = Math.max(0, Math.min(100, parseInt(raw, 10)));
      return { action: "volume", value: v };
    }
    return { action: "volume" };
  }
  return null;
}