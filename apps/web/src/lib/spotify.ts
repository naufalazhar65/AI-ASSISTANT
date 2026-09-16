// Spotify integration (Mia feature 2026-09-05). Lets Mia control the owner's
// playback via the Spotify Web API (play/pause/skip/volume/search/status).
//
// Auth is OAuth Authorization Code: the owner authorizes once in a browser
// (`SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET` server-side only, invariant 5),
// the callback exchanges the code for a refresh token, and every API call
// auto-refreshes the short-lived access token. Tokens are stored per-user at
// `.data/users/<user>/spotify.json` (same atomic-write + sanitized-user pattern
// as tasks/moods). Reading never throws; a missing/expired token means "not
// connected" so tools return a friendly "open the link" message.
//
// PLAYBACK CONTROL ENDPOINTS REQUIRE A SPOTIFY PREMIUM ACCOUNT.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { sanitizeUser, userDataRoot } from "./users";

const execFileAsync = promisify(execFileCb);

export const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || "";
export const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || "";
export const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || "http://localhost:3000/api/spotify/callback";

const SPOTIFY_ACCOUNTS = "https://accounts.spotify.com";
const SPOTIFY_API = "https://api.spotify.com/v1";
const SCOPES = "user-read-playback-state user-modify-playback-state user-read-currently-playing user-read-recently-played user-library-read";
const TOKEN_FILE = "spotify.json";
const TIMEOUT_MS = 15000;

export interface SpotifyToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  connectedAt: number;
}

function spotifyPath(userKey: string): string {
  return join(userDataRoot(), userKey, TOKEN_FILE);
}

export function readSpotifyToken(rawUser?: unknown): SpotifyToken | null {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return null;
  const file = spotifyPath(userKey);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const t = parsed as Record<string, unknown>;
    if (typeof t.accessToken !== "string" || typeof t.refreshToken !== "string" || typeof t.expiresAt !== "number") return null;
    return {
      accessToken: t.accessToken,
      refreshToken: t.refreshToken,
      expiresAt: t.expiresAt,
      connectedAt: typeof t.connectedAt === "number" ? t.connectedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

function writeSpotifyToken(token: SpotifyToken, rawUser?: unknown): void {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) throw new Error("invalid user");
  const file = spotifyPath(userKey);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(token, null, 2));
  renameSync(tmp, file);
}

export function clearSpotifyToken(rawUser?: unknown): void {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return;
  const file = spotifyPath(userKey);
  try {
    if (existsSync(file)) renameSync(file, `${file}.revoked.${Date.now()}`);
  } catch { /* best-effort */ }
}

export function spotifyConfigured(): boolean {
  return !!(SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET);
}

/** URL the owner opens in a browser to authorize Mia (one-time, per user). */
export function spotifyAuthUrl(rawUser?: unknown, redirectUri = SPOTIFY_REDIRECT_URI): string {
  const userKey = sanitizeUser(rawUser) || "";
  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES,
    state: userKey,
    show_dialog: "false",
  });
  return `${SPOTIFY_ACCOUNTS}/authorize?${params.toString()}`;
}

/** Exchange the OAuth code for tokens (called by the callback route). */
export async function exchangeSpotifyCode(code: string, rawUser?: unknown, redirectUri = SPOTIFY_REDIRECT_URI): Promise<void> {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) throw new Error("invalid user");
  if (!spotifyConfigured()) throw new Error("Spotify is not configured");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  const res = await fetch(`${SPOTIFY_ACCOUNTS}/api/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64")}`,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`Spotify auth failed: ${String(data.error_description ?? data.error ?? res.status)}`);
  const accessToken = typeof data.access_token === "string" ? data.access_token : "";
  const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token : "";
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
  if (!accessToken || !refreshToken) throw new Error("Spotify auth returned no token");
  writeSpotifyToken(
    { accessToken, refreshToken, expiresAt: Date.now() + (expiresIn - 60) * 1000, connectedAt: Date.now() },
    userKey
  );
}

async function refreshSpotifyToken(token: SpotifyToken, rawUser?: unknown): Promise<SpotifyToken> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: token.refreshToken,
  });
  const res = await fetch(`${SPOTIFY_ACCOUNTS}/api/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64")}`,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`Spotify refresh failed: ${String(data.error_description ?? data.error ?? res.status)}`);
  const accessToken = typeof data.access_token === "string" ? data.access_token : "";
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
  const fresh: SpotifyToken = {
    accessToken,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : token.refreshToken,
    expiresAt: Date.now() + (expiresIn - 60) * 1000,
    connectedAt: token.connectedAt,
  };
  writeSpotifyToken(fresh, rawUser);
  return fresh;
}

/**
 * Authenticated Spotify Web API call with automatic token refresh on expiry.
 * Returns parsed JSON; throws on HTTP/network error with a short message.
 */
async function spotifyRequest<T>(rawUser: unknown, method: string, path: string, body?: unknown): Promise<T> {
  if (!spotifyConfigured()) throw new Error("Spotify is not configured");
  let token = readSpotifyToken(rawUser);
  if (!token) throw new Error("spotify_not_connected");
  if (Date.now() >= token.expiresAt) token = await refreshSpotifyToken(token, rawUser);
  const fetchJson = async (tok: SpotifyToken): Promise<Response> => {
    const headers: Record<string, string> = { Authorization: `Bearer ${tok.accessToken}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(`${SPOTIFY_API}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  };
  let res = await fetchJson(token);
  if (res.status === 401) {
    // Token revoked/expired server-side: try refreshing once.
    token = await refreshSpotifyToken(token, rawUser);
    res = await fetchJson(token);
  }
  if (res.status === 404) {
    // Player endpoints return 404 when nothing is active (no device / no playback).
    throw new Error("spotify_no_active_device");
  }
  if (!res.ok) throw new Error(`Spotify error ${res.status}`);
  const text = await res.text();
  if (!text) return undefined as T;
  // Player-control endpoints (next/previous/pause/volume) return 200/204 with a
  // NON-JSON body (e.g. the raw new track id as plain text) on success. Any
  // body that isn't JSON means "the action succeeded, no structured payload" —
  // never throw a fake "respons aneh" over it.
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined as T;
  }
}

export function spotifyConnected(rawUser?: unknown): boolean {
  return !!readSpotifyToken(rawUser);
}

/** Current playback as a natural Indonesian sentence. `null` item → "terbuka tapi tidak memutar". */
export async function spotifyNowPlaying(rawUser?: unknown): Promise<string> {
  const player = await spotifyRequest<Record<string, unknown> | null>(rawUser, "GET", "/me/player");
  const item = player?.item as Record<string, unknown> | undefined;
  if (!player || !item) return "Spotify terbuka tapi belum ada yang diputar.";
  const artists = ((item.artists as Record<string, string>[]) || []).map((a) => a.name).join(", ");
  const name = String(item.name ?? "(unknown)");
  const device = (player.device as Record<string, unknown>) || {};
  const deviceName = String(device.name ?? "Spotify");
  if (player.is_playing) {
    const progress = (Number(player.progress_ms) || 0) / 1000;
    const duration = (Number(item.duration_ms) || 0) / 1000;
    if (progress && duration) {
      const p = `${Math.floor(progress / 60)} menit ${Math.floor(progress % 60)} detik`;
      const d = `${Math.floor(duration / 60)} menit ${Math.floor(duration % 60)} detik`;
      return `${name} — ${artists} sedang diputar, sudah jalan ${p} dari total ${d}, di perangkat ${deviceName}.`;
    }
    return `${name} — ${artists} sedang diputar di perangkat ${deviceName}.`;
  }
  return `${name} — ${artists} sedang dijeda, diputar di perangkat ${deviceName}.`;
}

export async function spotifySearch(rawUser: unknown, query: string): Promise<string> {
  if (!query.trim()) throw new Error("query required");
  const data = await spotifyRequest<Record<string, unknown>>(rawUser, "GET", `/search?q=${encodeURIComponent(query)}&type=track&limit=5`);
  const tracks = (data.tracks as Record<string, unknown>)?.items as Record<string, unknown>[] | undefined;
  if (!tracks || !tracks.length) return "Tidak ada hasil.";
  return tracks
    .map((t, i) => {
      const artists = ((t.artists as Record<string, string>[]) || []).map((a) => a.name).join(", ");
      return `${i + 1}. ${String(t.name)} — ${artists}`;
    })
    .join("\n");
}

/** Recently played tracks, deduped by id — feeds the song-guess game so the
 *  "lagu misteri" is one the user actually listened to (nice to guess famous
 *  ones). Shape: {id, name, artists}. Empty array when nothing exists yet. */
export async function spotifyRecentTracks(rawUser?: unknown): Promise<{ id: string; name: string; artists: string[] }[]> {
  const data = await spotifyRequest<Record<string, unknown>>(rawUser, "GET", "/me/player/recently-played?limit=50");
  const items = (data.items as Record<string, unknown>[] | undefined) || [];
  const seen = new Set<string>();
  const out: { id: string; name: string; artists: string[] }[] = [];
  for (const it of items) {
    const tr = (it.track as Record<string, unknown>) || {};
    const id = String(tr.id || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: String(tr.name || ""),
      artists: ((tr.artists as Record<string, string>[]) || []).map((a) => String(a.name || "")),
    });
  }
  return out;
}

/** Random track from an arbitrary keyword search — feeds the song-guess game.
 *  Karaoke/live/remix-ish entries are skipped so the game never hides a gimmick
 *  cover. Throws the same "not connected" errors as the other spotify helpers. */
export async function spotifyRandomTrack(
  rawUser: unknown,
  keywords: string[] = ["love", "night", "summer", "dream", "fire", "rock", "jazz", "dance", "rain", "home"],
): Promise<{ id: string; name: string; artists: string[] }> {
  const kw = keywords[Math.floor(Math.random() * keywords.length)];
  const data = await spotifyRequest<Record<string, unknown>>(rawUser, "GET", `/search?q=${encodeURIComponent(kw)}&type=track&limit=10`);
  const items = ((data.tracks as Record<string, unknown>)?.items as Record<string, unknown>[] | undefined) || [];
  const clean = items.filter((t) => {
    const n = String(t.name || "").toLowerCase();
    return !/(karaoke|instrumental|tribute|remix| karaoke| instrumental )/.test(n);
  });
  const pool = clean.length ? clean : items;
  const chosen = pool[Math.floor(Math.random() * pool.length)];
  if (!chosen) throw new Error("no tracks found");
  return {
    id: String(chosen.id || ""),
    name: String(chosen.name || ""),
    artists: ((chosen.artists as Record<string, string>[]) || []).map((a) => String(a.name || "")),
  };
}

/** Score how well a track matches a free-text query: token overlap weighted
 *  to prefer exact artist and title matches over Spotify's opaque ranking
 *  (limit=1 hits are unreliable). Returns the best-scoring track. */
async function searchBestTrack(
  rawUser: unknown,
  query: string,
): Promise<Record<string, unknown> | undefined> {
  const data = await spotifyRequest<Record<string, unknown>>(rawUser, "GET", `/search?q=${encodeURIComponent(query)}&type=track&limit=10`);
  const tracks = ((data.tracks as Record<string, unknown>)?.items as Record<string, unknown>[] | undefined) || [];
  // Hard filter out unwanted versions (karaoke, instrumental, cover, tribute) unless requested
  const cleanTracks = tracks.filter((t) => {
    const title = String(t.name || "").toLowerCase();
    const qLower = query.toLowerCase();
    if (!qLower.includes("karaoke") && title.includes("karaoke")) return false;
    if (!qLower.includes("instrumental") && title.includes("instrumental")) return false;
    if (!qLower.includes("tribute") && title.includes("tribute")) return false;
    if (!qLower.includes("cover") && title.includes("cover") && !title.includes("discovered")) return false;
    return true;
  });

  const candidates = cleanTracks.length ? cleanTracks : tracks;
  if (!candidates.length) return undefined;
  // Normalize a word so "lo-fi" and "lofi" (and hyphens/3am etc.) match the
  // same token. Split on whitespace (not [^a-z0-9]+) so hyphenated words stay
  // whole — the old split turned "lo-fi" into ["lo","fi"] and the length>2
  // filter then dropped both, leaving only "vibes" and letting either track
  // with "vibes" in the title win the tie.
  const normWord = (w: string): string => w.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const qTokens = new Set(
    query.toLowerCase().split(/\s+/).map(normWord).filter((w) => w.length > 1),
  );
  if (!qTokens.size) return candidates[0];
  const qPhrase = [...qTokens].join(" ");
  let best = candidates[0];
  let bestScore = -Infinity;
  for (const t of candidates) {
    const title = String(t.name || "").toLowerCase();
    const titleNorm = title.split(/\s+/).map(normWord).filter((w) => w.length > 1).join(" ");
    const titleWords = new Set(titleNorm.split(" "));
    const artistWords = new Set(
      ((t.artists as Record<string, string>[]) || [])
        .flatMap((a) => String(a.name || "").toLowerCase().split(/\s+/).map(normWord))
        .filter((w) => w.length > 1),
    );
    let bonus = 0;
    for (const tok of qTokens) {
      if (artistWords.has(tok)) bonus += 5; // Artist match is strong
      if (titleWords.has(tok)) bonus += 4;  // Title match is strong
    }
    // Boost exact (whole-query) matches, penalize unwanted versions
    if (titleNorm.includes(qPhrase)) bonus += 10;
    if (title.includes("karaoke") && !query.toLowerCase().includes("karaoke")) bonus -= 15;
    if (title.includes("live") && !query.toLowerCase().includes("live")) bonus -= 15;
    if (title.includes("instrumental") && !query.toLowerCase().includes("instrumental")) bonus -= 15;
    if (title.includes("remix") && !query.toLowerCase().includes("remix")) bonus -= 15;

    const artistNames = ((t.artists as Record<string, string>[]) || []).map((a) => String(a.name || ""));
    const denom = 1 + Math.abs(artistNames.join(" ").length - String(query).length) / 50; // Normalize
    const score = bonus / denom;
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

/** Snapshot of Spotify's current player state. `null` when there's no
 *  perceivable playback (nothing loaded/paused/no device) or the state can't be
 *  read — callers must treat the absence as "playback not confirmed" and never
 *  claim a track started. */
interface PlayerSnapshot {
  isPlaying: boolean;
  trackUri?: string;
  contextUri?: string;
  deviceName?: string;
  trackName?: string;
  artists?: string;
  shuffle?: boolean;
  repeat?: string;
}

async function currentPlayer(rawUser: unknown): Promise<PlayerSnapshot | null> {
  try {
    const player = await spotifyRequest<Record<string, unknown> | undefined>(rawUser, "GET", "/me/player");
    if (!player) return null;
    const item = (player.item as Record<string, unknown>) || undefined;
    const context = (player.context as Record<string, unknown>) || undefined;
    const device = (player.device as Record<string, unknown>) || undefined;
    return {
      isPlaying: !!player.is_playing,
      trackUri: item && typeof item.uri === "string" ? item.uri : undefined,
      contextUri: context && typeof context.uri === "string" ? context.uri : undefined,
      deviceName: device && typeof device.name === "string" ? device.name : undefined,
      shuffle: typeof player.shuffle_state === "boolean" ? player.shuffle_state : undefined,
      repeat: typeof player.repeat_state === "string" ? player.repeat_state : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Poll until the requested playback is actually audible (`is_playing`) or the
 * timeout elapses. Returns the verified snapshot when playback of `expectedUri`
 * (track or playlist/album context) is confirmed, otherwise the last snapshot —
 * so the caller can honestly say "belum kedengeran muter" instead of claiming
 * success from a bare PUT/`open` request that didn't start audio.
 */
async function verifyPlayback(rawUser: unknown, expectedUri?: string, timeoutMs = 5000): Promise<PlayerSnapshot | null> {
  const deadline = Date.now() + timeoutMs;
  let last: PlayerSnapshot | null = null;
  while (Date.now() < deadline) {
    const snap = await currentPlayer(rawUser);
    if (snap) {
      last = snap;
      if (snap.isPlaying && (!expectedUri || snap.trackUri === expectedUri || snap.contextUri === expectedUri)) {
        return snap;
      }
    }
    await new Promise((r) => setTimeout(r, 650));
  }
  return last;
}

/** Play a search result (first track) or resume (`query` empty). Returns a short summary. */

/**
 * "lagu favoritku" must NOT be searched literally (returns junk). Resolve it to
 * the persona's saved song (+ artist when the song text lacks it). Pure — tested.
 */
export function resolveFavoriteQuery(query: string, favSong?: string | null, favArtist?: string | null): string {
  const q = (query || "").trim();
  if (!q) return q;
  if (!/favorit|favourite|kesukaan|favoritku|lagu\s+fav\b|fav\s+song/i.test(q)) return q;
  if (!favSong) return q;
  const artist = (favArtist || "").trim();
  const song = favSong.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return artist && !new RegExp(artist.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(song) ? `${song} ${artist}` : song;
}

export async function spotifyPlay(rawUser: unknown, query?: string, kind?: "playlist" | "album" | "track"): Promise<string> {
  console.log("[spotify] play requested:", { query, kind });
  // "lagu favoritku" → use the persona fact (preference.song) as the query.
  if (query && (!kind || kind === "track")) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getPersonaFact } = require("./persona") as typeof import("./persona");
      query = resolveFavoriteQuery(query, getPersonaFact(rawUser, "preference.song"), getPersonaFact(rawUser, "preference.artist"));
    } catch { /* keep the raw query */ }
  }
  let track: Record<string, unknown> | undefined;
  let contextUri: string | undefined;
  if (query && query.trim()) {
    const q = query.trim();
    // Playlist/album requests resolve via their own search type (context play).
    if (kind === "playlist" || /playlist/i.test(q)) {
      const data = await spotifyRequest<Record<string, unknown>>(rawUser, "GET", `/search?q=${encodeURIComponent(q)}&type=playlist&limit=5`);
      const playlists = ((data.playlists as Record<string, unknown>)?.items as Record<string, unknown>[] | undefined) || [];
      if (playlists.length && playlists[0].uri) {
        contextUri = String(playlists[0].uri);
        return await playContext(rawUser, contextUri, String(playlists[0].name || "playlist"));
      }
      return "Tidak ada playlist dengan nama itu.";
    }
    if (kind === "album" || /album/i.test(q)) {
      const data = await spotifyRequest<Record<string, unknown>>(rawUser, "GET", `/search?q=${encodeURIComponent(q)}&type=album&limit=5`);
      const albums = ((data.albums as Record<string, unknown>)?.items as Record<string, unknown>[] | undefined) || [];
      if (albums.length && albums[0].uri) {
        contextUri = String(albums[0].uri);
        return await playContext(rawUser, contextUri, String(albums[0].name || "album"));
      }
      return "Tidak ada album dengan nama itu.";
    }
    track = await searchBestTrack(rawUser, q);
    if (!track) return "Tidak ada hasil untuk lagu itu.";
  }
  const start = async (uris?: string[]) => {
    await spotifyRequest<unknown>(rawUser, "PUT", "/me/player/play", uris ? { uris } : {});
  };
  const artistsOf = (t: Record<string, unknown>): string =>
    ((t.artists as Record<string, string>[]) || []).map((a) => a.name).join(", ");
  const onDevice = (snap: PlayerSnapshot): string =>
    snap.isPlaying && snap.deviceName ? ` di ${snap.deviceName}` : "";
  const confirmTrack = async (t: Record<string, unknown>): Promise<string> => {
    // SEBELUM Start/Polling: Cek dulu apa sudah muter?
    const snapNow = await currentPlayer(rawUser);
    if (snapNow?.isPlaying && snapNow.trackUri === String(t.uri)) {
      return `${String(t.name)} — ${artistsOf(t)} sudah muter${onDevice(snapNow)}.`;
    }

    const snap = (await verifyPlayback(rawUser, String(t.uri))) || { isPlaying: false };
    const label = `${String(t.name)} — ${artistsOf(t)}`;
    if (snap.isPlaying) return `${label} sudah benar-benar keputar${onDevice(snap)}.`;
    return `Perintah putar ${label} sudah masuk, tapi belum kedengeran muter — cek aplikasi/device Spotify-nya ya.`;
  };
  const confirmResume = async (transferred?: string): Promise<string> => {
    // SEBELUM Start/Polling: Cek dulu apa sudah muter?
    const snapNow = await currentPlayer(rawUser);
    if (snapNow?.isPlaying) {
      return `Pemutaran dilanjutkan${onDevice(snapNow).trim() ? ` ${onDevice(snapNow).trim()}` : ""}.`;
    }

    const snap = (await verifyPlayback(rawUser)) || { isPlaying: false };
    const suffix = transferred ? ` di ${transferred}` : onDevice(snap);
    // Report WHICH track is actually playing: resuming plays whatever was queued,
    // so a bare "dilanjutkan" let the model claim the wrong song.
    const now = snap.trackName ? ` — yang jalan sekarang: ${snap.trackName}${snap.artists ? ` (${snap.artists})` : ""}` : "";
    if (snap.isPlaying) return `Pemutaran dilanjutkan${suffix ? ` ${suffix.trim()}` : ""}${now}.`;
    return transferred
      ? `Sudah kuarahkan ke ${transferred}, tapi belum kedengeran muter — cek device-nya ya.`
      : "Perintah lanjut muter sudah masuk, tapi belum kedengeran — pastikan ada device aktif ya.";
  };
  try {
    if (track) {
      // SPOTIFY_FORCE_LOCAL=1: bypass the Web API play path entirely and drive
      // the local macOS app via AppleScript — used to test the osascript route.
      if (process.env.SPOTIFY_FORCE_LOCAL === "1" && process.platform === "darwin") {
        const ok = await execFileAsync("osascript", [
          "-e",
          'tell application "Spotify"',
          "-e",
          "activate",
          "-e",
          `play track ${JSON.stringify(String(track.uri))}`,
          "-e",
          "end tell",
        ], { timeout: 8000 }).then(() => true).catch(() => false);
        if (!ok) {
          return "Perintah buka Spotify lokal gagal — cek izin otomatisasi (TCC) untuk proses server ya.";
        }
        // The app can take a few seconds to load/decode the track before its
        // player state flips from "stopped" to "playing" — poll instead of a
        // single 1200ms snapshot so an honest "lagu sudah muter" isn't a
        // premature "belum kedeteksi".
        for (let attempt = 0; attempt < 6; attempt++) {
          if (attempt) await new Promise((r) => setTimeout(r, 1200));
          const snap = await spotifyOsascriptSnapshot().catch(() => null);
          if (snap && snap.state === "playing" && snap.name) {
            return `${snap.name}${snap.artist ? ` — ${snap.artist}` : ""} sudah muter di Spotify macOS.`;
          }
        }
        return `Spotify sudah kubuka lewat app lokal, tapi belum kedeteksi muter — cek aplikasinya ya.`;
      }
      await start([String(track.uri)]);
      return await confirmTrack(track);
    }
    await start();
    return await confirmResume();
  } catch (err) {
    // No active device (404). Two robust fallbacks before giving up:
    //   1. macOS: activate Spotify and play the resolved track URI via
    //      AppleScript (`play track`) — this launches the app AND starts
    //      playback immediately, no wait for the app to register as a device
    //      (waiting for registration is flaky). If the node process lacks the
    //      Spotify Automation (TCC) grant, it silent-fails — fall back to the
    //      `open spotify:track:<uri>` LaunchServices deeplink, which needs no
    //      grant at all.
    //   2. Transfer playback to a listed device, then retry the play once.
    if (err instanceof Error && err.message === "spotify_no_active_device") {
      if (track && process.platform === "darwin") {
        // AppleScript path first: `play track` takes the resolved track URI
        // (`spotify:track:<id>`), not a search URI, so playback starts at once.
        try {
          await execFileAsync("osascript", [
            "-e",
            'tell application "Spotify"',
            "-e",
            "activate",
            "-e",
            `play track ${JSON.stringify(String(track.uri))}`,
            "-e",
            "end tell",
          ], { timeout: 8000 });
        } catch {
          // osascript unavailable / TCC not granted for Spotify — LaunchServices
          // deeplink opens the app and starts playback without any grant.
          await execFileAsync("open", [String(track.uri)], { timeout: 4000 });
        }
        
        // Wait briefly for Spotify to spin up and confirm playback started
        // (osascript or deeplink path; playback can lag cold app start).
        const snap = await verifyPlayback(rawUser, String(track.uri), 8000);
        if (snap?.isPlaying) {
          return await confirmTrack(track);
        }

        // Fallback: If the launch path opened the app but didn't start playing automatically,
        // Wait for the app to register as a device (cold start can take 15-40s),
        // then explicitly issue the start command. ensureDevice is retried once
        // mid-poll in case the device appears but isn't "active" yet.
        const deadline = Date.now() + 30000;
        let played = false;
        let transferred = false;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1500));
          const devices = await listDevices(rawUser);
          if (!devices.length) {
            if (!transferred && Date.now() > deadline - 15000) {
              transferred = !!(await ensureDevice(rawUser));
            }
            continue;
          }
          try {
            await start([String(track.uri)]);
            played = true;
            break;
          } catch {
            if (!transferred) transferred = !!(await ensureDevice(rawUser));
            /* device not ready yet; keep polling */
          }
        }
        if (!played) {
          // Last check: playback may have started via the deeplink after all.
          const final = await currentPlayer(rawUser);
          if (final?.isPlaying) return await confirmTrack(track);
          return `Spotify sudah kubuka, tapi belum kedeteksi sebagai device — cek aplikasi Spotify-nya dan pastikan ada device aktif ya.`;
        }
        return await confirmTrack(track);
      }
      const transferred = await ensureDevice(rawUser);
      if (transferred) {
        if (track) {
          await start([String(track.uri)]);
          return await confirmTrack(track);
        }
        await start();
        return await confirmResume(transferred);
      }
    }
    throw err;
  }
}

/**
 * Play a context (playlist/album) via its `context_uri`, with the same
 * no-active-device fallback as `spotifyPlay` (device transfer / app launch).
 */
async function playContext(rawUser: unknown, contextUri: string, label: string): Promise<string> {
  const start = async () => {
    await spotifyRequest<unknown>(rawUser, "PUT", "/me/player/play", { context_uri: contextUri });
  };
  const onDevice = (snap: PlayerSnapshot): string =>
    snap.isPlaying && snap.deviceName ? ` di ${snap.deviceName}` : "";
  try {
    await start();
    const snap = (await verifyPlayback(rawUser, contextUri)) || { isPlaying: false };
    if (snap.isPlaying) return `${label} sudah benar-benar keputar${onDevice(snap)}.`;
    return `${label} sudah masuk antrean, tapi belum kedengeran muter — cek aplikasi/device Spotify-nya ya.`;
  } catch (err) {
    if (err instanceof Error && err.message === "spotify_no_active_device") {
      const transferred = await ensureDevice(rawUser);
      if (transferred) {
        await start();
        const snap = (await verifyPlayback(rawUser, contextUri)) || { isPlaying: false };
        if (snap.isPlaying) return `${label} sudah keputar di ${transferred}.`;
        return `${label} sudah kuarahkan ke ${transferred}, tapi belum kedengeran muter — cek device-nya ya.`;
      }
    }
    throw err;
  }
}

/**
 * Ensure a reachable Spotify device exists. Returns the device name of the target
 * on success or `null` when no device exists (e.g. the Spotify app is closed).
 *
 * Strategy when playback has no active device (player endpoints return 404):
 *   1. If any device is listed, transfer playback to it (prefer the active one).
 *   2. If the device list is empty and we're on macOS, launch the local Spotify
 *      app (`open -a Spotify`), poll until it registers as a device, then transfer.
 *   3. Otherwise return null so the caller can give the friendly "buka Spotify dulu".
 */
async function ensureDevice(rawUser: unknown): Promise<string | null> {
  const devices = await listDevices(rawUser);
  if (devices.length) {
    const target = devices.find((d) => d.is_active) || devices[0];
    await spotifyRequest<unknown>(rawUser, "PUT", "/me/player", { device_ids: [target.id] });
    return String(target.name ?? "Spotify");
  }
  if (process.platform !== "darwin") return null;
  try {
    await execFileAsync("open", ["-a", "Spotify"], { timeout: 4000 });
  } catch {
    return null;
  }
  // Poll up to ~45s for the freshly launched app to register as a device
  // (cold start on the owner's Mac can take anywhere from ~15s to ~40s).
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const d = await listDevices(rawUser);
    if (d.length) {
      await spotifyRequest<unknown>(rawUser, "PUT", "/me/player", { device_ids: [d[0].id] });
      return String(d[0].name ?? "Spotify");
    }
  }
  return null;
}

interface SpotifyDevice {
  id: string;
  name?: string;
  is_active?: boolean;
}

async function listDevices(rawUser: unknown): Promise<SpotifyDevice[]> {
  const data = await spotifyRequest<Record<string, unknown>>(rawUser, "GET", "/me/player/devices");
  const devices = ((data.devices as Record<string, unknown>[]) || [])
    .filter((d): d is Record<string, unknown> => typeof d.id === "string" && !!d.id)
    .map((d) => ({ id: String(d.id), name: String(d.name ?? "Spotify"), is_active: !!d.is_active }));
  return devices;
}

/** Snapshot from the local Spotify app via AppleScript (state, track, artist).
 *  `null` when not on macOS / osascript unavailable / TCC not granted. */
interface SpotifyOsascriptSnapshot {
  state: string;
  name: string;
  artist: string;
}

async function spotifyOsascriptSnapshot(): Promise<SpotifyOsascriptSnapshot | null> {
  if (process.platform !== "darwin") return null;
  try {
    // Single `-e` `to return ...` — multi-`-e` `set st to ...` lines fail with
    // `Expected expression but found "st"` (-2741); this form has been
    // verified live. "|" separators avoid tab-escaping bugs in osascript.
    const { stdout } = await execFileAsync("osascript", [
      "-e",
      'tell application "Spotify" to return ((player state as text) & "|" & (name of current track) & "|" & (artist of current track))',
    ], { timeout: 8000 });
    const [st, tn, ar] = String(stdout).trim().split("|");
    return { state: st, name: tn ?? "", artist: ar ?? "" };
  } catch {
    return null;
  }
}

/** Run a control verb against the local Spotify app via AppleScript
 *  (`pause`, `next track`, `previous track`). Returns false when not on macOS
 *  or osascript is unavailable / TCC not granted. */
async function spotifyOsascriptAct(verb: "pause" | "next track" | "previous track"): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  try {
    await execFileAsync("osascript", [
      "-e",
      'tell application "Spotify"',
      "-e",
      "activate",
      "-e",
      verb,
      "-e",
      "end tell",
    ], { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

export async function spotifyPause(rawUser: unknown): Promise<string> {
  try {
    await spotifyRequest<unknown>(rawUser, "PUT", "/me/player/pause");
  } catch (err) {
    if (err instanceof Error && err.message === "spotify_no_active_device") {
      // Local app first: AppleScript pause works without any active device.
      if (process.platform === "darwin") {
        try {
          const launched = await spotifyOsascriptAct("pause");
          if (launched) {
            await new Promise((r) => setTimeout(r, 800));
            const snap = await spotifyOsascriptSnapshot();
            if (snap && snap.state !== "playing") {
              return "Pemutaran dijeda di Spotify macOS.";
            }
            return "Sudah kusuruh jeda di Spotify, tapi belum kedeteksi jedanya — cek aplikasinya ya.";
          }
        } catch {
          /* fall through to web API device transfer */
        }
      }
      const transferred = await ensureDevice(rawUser);
      if (transferred) {
        await spotifyRequest<unknown>(rawUser, "PUT", "/me/player/pause");
        return `Pemutarannya dijeda di ${transferred}.`;
      }
    }
    throw err;
  }
  return "Pemutaran dijeda.";
}

export async function spotifyNext(rawUser: unknown): Promise<string> {
  try {
    await spotifyRequest<unknown>(rawUser, "POST", "/me/player/next");
  } catch (err) {
    if (err instanceof Error && err.message === "spotify_no_active_device") {
      // Local app first: AppleScript `next track` works without any active device.
      if (process.platform === "darwin") {
        try {
          const before = await spotifyOsascriptSnapshot();
          const launched = await spotifyOsascriptAct("next track");
          if (launched) {
            await new Promise((r) => setTimeout(r, 1200));
            const after = await spotifyOsascriptSnapshot();
            if (after && before && after.name !== before.name) {
              return `Lagu berikutnya diputar${after.name ? `: ${after.name}${after.artist ? ` — ${after.artist}` : ""}` : " di Spotify macOS"}.`;
            }
            return `Sudah kusuruh geser ke lagu berikutnya di Spotify, tapi lagu di layar belum berubah — cek aplikasinya ya.`;
          }
        } catch {
          /* fall through to web API device transfer */
        }
      }
      const transferred = await ensureDevice(rawUser);
      if (transferred) {
        await spotifyRequest<unknown>(rawUser, "POST", "/me/player/next");
        return `Lagu berikutnya diputar di ${transferred}.`;
      }
    }
    throw err;
  }
  return "Lagu berikutnya diputar.";
}

export async function spotifyPrevious(rawUser: unknown): Promise<string> {
  try {
    await spotifyRequest<unknown>(rawUser, "POST", "/me/player/previous");
  } catch (err) {
    if (err instanceof Error && err.message === "spotify_no_active_device") {
      // Local app first: AppleScript `previous track` works without any active device.
      if (process.platform === "darwin") {
        try {
          const before = await spotifyOsascriptSnapshot();
          const launched = await spotifyOsascriptAct("previous track");
          if (launched) {
            await new Promise((r) => setTimeout(r, 1200));
            const after = await spotifyOsascriptSnapshot();
            if (after && before && after.name !== before.name) {
              return `Lagu sebelumnya diputar${after.name ? `: ${after.name}${after.artist ? ` — ${after.artist}` : ""}` : " di Spotify macOS"}.`;
            }
            return `Sudah kusuruh geser ke lagu sebelumnya di Spotify, tapi lagu di layar belum berubah — cek aplikasinya ya.`;
          }
        } catch {
          /* fall through to web API device transfer */
        }
      }
      const transferred = await ensureDevice(rawUser);
      if (transferred) {
        await spotifyRequest<unknown>(rawUser, "POST", "/me/player/previous");
        return `Lagu sebelumnya diputar di ${transferred}.`;
      }
    }
    throw err;
  }
  return "Lagu sebelumnya diputar.";
}

export async function spotifySetVolume(rawUser: unknown, percent: number): Promise<string> {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  try {
    await spotifyRequest<unknown>(rawUser, "PUT", `/me/player/volume?volume_percent=${p}`);
  } catch (err) {
    if (err instanceof Error && err.message === "spotify_no_active_device") {
      const transferred = await ensureDevice(rawUser);
      if (transferred) {
        await spotifyRequest<unknown>(rawUser, "PUT", `/me/player/volume?volume_percent=${p}`);
        return `Volume ${p}% di ${transferred}.`;
      }
    }
    throw err;
  }
  return `Volume ${p}%.`;
}

/** List available playback devices (id/type/name + active). */
export async function spotifyDevices(rawUser?: unknown): Promise<string> {
  const data = await spotifyRequest<Record<string, unknown>>(rawUser, "GET", "/me/player/devices");
  const devices = (data.devices as Record<string, unknown>[]) || [];
  if (!devices.length) return "Tidak ada perangkat aktif. Buka Spotify di perangkat dulu.";
  return devices
    .map((d) => `- ${String(d.name)} (${String(d.type)})${d.is_active ? " ✓ aktif" : ""}`)
    .join("\n");
}
// ── Sleep timer ──────────────────────────────────────────────────────────────
// "stop lagunya kalau udah selesai" / "matiin spotify 20 menit lagi". Playback
// has no native "stop at end of track", so we schedule an in-process pause at
// the computed moment. (In-process only: a server restart drops the timer — the
// tool says so honestly when none is armed.)

type SleepTimer = { timer: NodeJS.Timeout; stopAt: number; label: string };
const sleepTimers = new Map<string, SleepTimer>();

/** Pure plan for a sleep timer — unit-tested (no network). */
export function sleepTimerPlan(
  opts: { after_track?: boolean; minutes?: number },
  player: { is_playing?: boolean; progress_ms?: number; item?: { duration_ms?: number; name?: string } } | null
): { ms: number; label: string } | { error: string } {
  const now = Date.now();
  const hhmm = (at: number) => new Date(at).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
  if (typeof opts.minutes === "number" && opts.minutes > 0) {
    const mins = Math.min(Math.round(opts.minutes), 360);
    return { ms: mins * 60_000, label: `${mins} menit lagi (≈ ${hhmm(now + mins * 60_000)})` };
  }
  if (opts.after_track) {
    if (!player || !player.item) return { error: "Spotify belum memutar lagu — tak ada yang bisa dijadwalkan." };
    if (!player.is_playing) return { error: "Playback sedang dijeda; kalau mau, jadwalkan pakai minutes=N." };
    const dur = Number(player.item.duration_ms) || 0;
    const prog = Number(player.progress_ms) || 0;
    if (!dur) return { error: "Durasi lagu tidak terbaca — coba lagi sebentar lagi." };
    const ms = Math.min(Math.max(1000, dur - prog) + 1500, 360 * 60_000);
    return { ms, label: `setelah lagu ini selesai (${player.item.name ? `"${player.item.name}" ` : ""}≈ ${hhmm(now + ms)})` };
  }
  return { error: "Sebutkan after_track=true (setelah lagu ini) atau minutes=N (N menit lagi)." };
}

/** Arm/cancel/status a playback sleep timer. */
export async function spotifySleepTimer(
  rawUser: unknown,
  opts: { after_track?: boolean; minutes?: number; cancel?: boolean } = {}
): Promise<string> {
  if (!spotifyConfigured()) return "Spotify belum dikonfigurasi (SPOTIFY_CLIENT_ID/CLIENT_SECRET).";
  if (!spotifyConnected(rawUser)) return spotifyToolErrorText(rawUser);
  const key = sanitizeUser(rawUser) || "shared";

  if (opts.cancel) {
    const cur = sleepTimers.get(key);
    if (!cur) return "Tidak ada sleep timer aktif.";
    clearTimeout(cur.timer);
    sleepTimers.delete(key);
    return "🛑 Sleep timer dibatalkan — playback dibiarkan jalan.";
  }

  let player: Record<string, unknown> | null = null;
  if (opts.after_track) player = await spotifyRequest<Record<string, unknown> | null>(rawUser, "GET", "/me/player");
  const plan = sleepTimerPlan(opts, player as never);
  if ("error" in plan) return `Error: ${plan.error}`;

  const prev = sleepTimers.get(key);
  if (prev) clearTimeout(prev.timer);
  const stopAt = Date.now() + plan.ms;
  const timer = setTimeout(() => {
    sleepTimers.delete(key);
    void spotifyPause(rawUser)
      .then((r) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { pushToOwner } = require("../channels/pushTarget") as typeof import("../channels/pushTarget");
          void pushToOwner(`⏹️ Sleep timer: playback kumatikan. ${r}`);
        } catch {
          /* best-effort notify */
        }
      })
      .catch(() => {});
  }, plan.ms);
  timer.unref?.();
  sleepTimers.set(key, { timer, stopAt, label: plan.label });
  return `⏱️ Oke — Spotify kumatikan ${plan.label}.`;
}

/** Human status of the current sleep timer (no args path). */
export function spotifySleepTimerStatus(rawUser: unknown): string {
  const cur = sleepTimers.get(sanitizeUser(rawUser) || "shared");
  if (!cur) return "Tidak ada sleep timer aktif. Sebutkan after_track=true atau minutes=N untuk memasang.";
  const left = Math.max(0, Math.round((cur.stopAt - Date.now()) / 60_000));
  return `⏱️ Sleep timer aktif — berhenti ${cur.label} (≈ ${left} menit lagi).`;
}

const REPEAT_VALUES = ["track", "context", "off"] as const;
export type SpotifyRepeat = (typeof REPEAT_VALUES)[number];

/** Indonesian/English repeat phrasing → Spotify repeat state. Pure — tested. */
export function normalizeRepeat(value: unknown): SpotifyRepeat | null {
  if (typeof value === "boolean") return value ? "track" : "off";
  const v = String(value ?? "").trim().toLowerCase();
  if (!v) return null;
  if (["off", "stop", "no", "tidak", "nggak", "gak", "jangan", "false", "0", "matiin", "matikan"].includes(v)) return "off";
  if (["track", "lagu", "lagu ini", "song", "this song", "one", "satu", "ulang lagu", "ulangi lagu", "repeat one", "ulangi lagu ini"].includes(v)) return "track";
  if (["context", "album", "playlist", "semua", "all", "antrean", "queue", "list", "ulangi semua"].includes(v)) return "context";
  return null;
}

/** Lenient boolean for shuffle ("nyala/on/ya/1" → true). Pure — tested. */
export function truthyFlag(value: unknown, fallback = true): boolean {
  if (typeof value === "boolean") return value;
  const s = String(value ?? "").trim().toLowerCase();
  if (!s) return fallback;
  return ["true", "1", "on", "ya", "yes", "nyala", "hidup", "aktif", "enable"].includes(s);
}

const repeatLabel = (r: SpotifyRepeat): string =>
  r === "track" ? "lagu ini (track)" : r === "context" ? "album/playlist (context)" : "OFF";

/** Add a track to the play queue ("tambahin ke antrean / putar ini berikutnya"). */
export async function spotifyQueue(rawUser: unknown, query?: string): Promise<string> {
  let q = (query || "").trim();
  if (!q) return "Sebutkan lagu yang mau diantre ya — misalnya 'antrekan lagu Perfect-nya Ed Sheeran'.";
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getPersonaFact } = require("./persona") as typeof import("./persona");
    q = resolveFavoriteQuery(q, getPersonaFact(rawUser, "preference.song"), getPersonaFact(rawUser, "preference.artist"));
  } catch { /* keep the raw query */ }
  const track = await searchBestTrack(rawUser, q);
  if (!track?.uri) return `Lagu "${q}" nggak ketemu di Spotify.`;
  const uri = String(track.uri);
  const path = `/me/player/queue?uri=${encodeURIComponent(uri)}`;
  try {
    await spotifyRequest<unknown>(rawUser, "POST", path);
  } catch (err) {
    if (err instanceof Error && err.message === "spotify_no_active_device") {
      const transferred = await ensureDevice(rawUser);
      if (transferred) await spotifyRequest<unknown>(rawUser, "POST", path);
      else throw err;
    } else {
      throw err;
    }
  }
  const artists = ((track.artists as Record<string, string>[]) || []).map((a) => a.name).join(", ");
  return `Sudah masuk antrean: ${String(track.name)}${artists ? ` — ${artists}` : ""}. Bakal muter setelah lagu yang sekarang.`;
}

/** Shuffle/repeat control. No args = report the current state honestly. */
export async function spotifyMode(
  rawUser: unknown,
  opts: { shuffle?: unknown; repeat?: unknown },
): Promise<string> {
  const wantShuffle = opts.shuffle === undefined || opts.shuffle === null || String(opts.shuffle).trim() === ""
    ? undefined
    : truthyFlag(opts.shuffle);
  const repeat = normalizeRepeat(opts.repeat);
  if (wantShuffle === undefined && !repeat) {
    const snap = await currentPlayer(rawUser);
    if (!snap) return "Tidak ada playback aktif — buka Spotify dulu ya, biar aku bisa cek status shuffle/repeat.";
    const sh = snap.shuffle === undefined ? "?" : snap.shuffle ? "ON" : "OFF";
    const rp = snap.repeat ? repeatLabel(normalizeRepeat(snap.repeat) ?? "off") : "OFF";
    return `Mode sekarang: shuffle ${sh} · repeat ${rp}${snap.trackName ? ` (${snap.trackName})` : ""}.`;
  }
  const apply = async () => {
    const parts: string[] = [];
    if (wantShuffle !== undefined) {
      await spotifyRequest<unknown>(rawUser, "PUT", `/me/player/shuffle?state=${wantShuffle}`);
      parts.push(`shuffle ${wantShuffle ? "ON" : "OFF"}`);
    }
    if (repeat) {
      await spotifyRequest<unknown>(rawUser, "PUT", `/me/player/repeat?state=${repeat}`);
      parts.push(`repeat ${repeatLabel(repeat)}`);
    }
    return parts.join(" · ");
  };
  try {
    return `Oke — ${await apply()}.`;
  } catch (err) {
    if (err instanceof Error && err.message === "spotify_no_active_device") {
      const transferred = await ensureDevice(rawUser);
      if (transferred) return `Oke — ${await apply()} (di ${transferred}).`;
    }
    throw err;
  }
}

/** Map "not connected" to the auth link (mirrors tools.ts spotifyToolError). */
function spotifyToolErrorText(rawUser: unknown): string {
  if (!spotifyConfigured()) return "Spotify belum dikonfigurasi (SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET).";
  return `Koneksi Spotify belum dibuat. Buka link ini sekali untuk menghubungkan: ${spotifyAuthUrl(rawUser)}`;
}
