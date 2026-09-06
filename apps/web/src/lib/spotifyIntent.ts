// Spotify request detection (Indonesian + English). Strong trigger: an explicit
// play verb attached to "lagu/song/musik/playlist/album". We then extract the
// query that follows (strip platform mention + filler particles) so the search
// hits the right track/playlist instead of the whole sentence.

const STRONG_RE =
  /\b(?:putar(?:in|kan)?|play|mainkan|dengerin|stel|nyalain)\s+(?:lagu|song|musik|music|playlist|album)\b/i;

const VERB_NOUN_RE =
  /(?:putar(?:in|kan)?|play|mainkan|dengerin|stel|nyalain)\s+(lagu|song|musik|music|playlist|album)/i;

export interface SpotifyIntent {
  query: string;
  kind?: "playlist" | "album" | "track";
}

export function detectSpotifyIntent(text: string): SpotifyIntent | null {
  const strong = STRONG_RE.test(text);
  if (!strong) return null;

  const m = text.match(VERB_NOUN_RE);
  if (!m) return null;

  const noun = m[1].toLowerCase();
  const kind =
    noun === "playlist" ? "playlist" : noun === "album" ? "album" : "track";

  const afterVerb = text.slice(m.index! + m[0].length).trim();
  let cleaned = afterVerb
    .replace(/\s+(?:di|on|ke|untuk|pake|pakai)\s+spotify\b.*$/i, "")
    .replace(/\b(?:dong|ya|yuk|deh|donk|lah|beb|mas|bang|kak|plis|please|a|nya|sih|coba|tolong|bantu|aku|gue|saya|kan)\b.*$/i, "")
    .trim()
    .replace(/^[\s\-:"]+|[\s\-:"]+$/g, "");

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

export function detectSpotifyControl(text: string): SpotifyControlIntent | null {
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