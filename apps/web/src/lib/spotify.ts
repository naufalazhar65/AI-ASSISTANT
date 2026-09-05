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
import { sanitizeUser, userDataRoot } from "./users";

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
  return (text ? JSON.parse(text) : undefined) as T;
}

export function spotifyConnected(rawUser?: unknown): boolean {
  return !!readSpotifyToken(rawUser);
}

/** Current playback: song, artist, device, progress. `null` when nothing playing. */
export async function spotifyNowPlaying(rawUser?: unknown): Promise<string> {
  const player = await spotifyRequest<Record<string, unknown> | null>(rawUser, "GET", "/me/player");
  if (!player || !player.item) return "Spotify terbuka tapi tidak sedang memutar apa pun.";
  const item = player.item as Record<string, unknown>;
  const artists = ((item.artists as Record<string, string>[]) || []).map((a) => a.name).join(", ");
  const name = String(item.name ?? "(unknown)");
  const device = (player.device as Record<string, unknown>) || {};
  const progress = (Number(player.progress_ms) || 0) / 1000;
  const duration = (Number(item.duration_ms) || 0) / 1000;
  const state = player.is_playing ? "▶ playing" : "⏸ paused";
  const deviceName = String(device.name ?? "?");
  return `${state} · ${name} — ${artists}${progress ? ` (${Math.floor(progress / 60)}:${String(Math.floor(progress % 60)).padStart(2, "0")}/${Math.floor(duration / 60)}:${String(Math.floor(duration % 60)).padStart(2, "0")})` : ""} · device: ${deviceName}`;
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

/** Play a search result (first track) or resume (`query` empty). Returns a short summary. */
export async function spotifyPlay(rawUser: unknown, query?: string): Promise<string> {
  const start = async (uris?: string[]) => {
    await spotifyRequest<unknown>(rawUser, "PUT", "/me/player/play", uris ? { uris } : {});
  };
  try {
    if (query && query.trim()) {
      const data = await spotifyRequest<Record<string, unknown>>(rawUser, "GET", `/search?q=${encodeURIComponent(query.trim())}&type=track&limit=1`);
      const track = ((data.tracks as Record<string, unknown>)?.items as Record<string, unknown>[] | undefined)?.[0];
      if (!track) return "Tidak ada hasil untuk lagu itu.";
      await start([String(track.uri)]);
      const artists = ((track.artists as Record<string, string>[]) || []).map((a) => a.name).join(", ");
      return `Memutar ${String(track.name)} — ${artists}.`;
    }
    await start();
    return "Melanjutkan pemutaran.";
  } catch (err) {
    // No active device (404): transfer playback to the first available device
    // (e.g. a speaker/client in range) then retry once before failing.
    if (err instanceof Error && err.message === "spotify_no_active_device") {
      const transferred = await transferPlayback(rawUser);
      if (transferred) {
        if (query && query.trim()) {
          const data = await spotifyRequest<Record<string, unknown>>(rawUser, "GET", `/search?q=${encodeURIComponent(query.trim())}&type=track&limit=1`);
          const track = ((data.tracks as Record<string, unknown>)?.items as Record<string, unknown>[] | undefined)?.[0];
          if (track) {
            await start([String(track.uri)]);
            const artists = ((track.artists as Record<string, string>[]) || []).map((a) => a.name).join(", ");
            return `Memutar ${String(track.name)} — ${artists} di ${transferred}.`;
          }
        } else {
          await start();
          return "Melanjutkan pemutaran di " + transferred + ".";
        }
      }
    }
    throw err;
  }
}

/**
 * Transfer playback to the first available device. Returns the device name on
 * success or `null` when there's no device to transfer to.
 */
async function transferPlayback(rawUser: unknown): Promise<string | null> {
  const data = await spotifyRequest<Record<string, unknown>>(rawUser, "GET", "/me/player/devices");
  const devices = (data.devices as Record<string, unknown>[]) || [];
  const available = devices.find((d) => typeof d.id === "string" && d.id);
  if (!available) return null;
  // Prefer an already-active device; otherwise use the first listed one.
  const target = devices.find((d) => d.is_active) || available;
  const targetId = String(target.id);
  await spotifyRequest<unknown>(rawUser, "PUT", "/me/player", { device_ids: [targetId] });
  return String(target.name ?? "Spotify");
}

export async function spotifyPause(rawUser: unknown): Promise<string> {
  try {
    await spotifyRequest<unknown>(rawUser, "PUT", "/me/player/pause");
  } catch (err) {
    if (err instanceof Error && err.message === "spotify_no_active_device") {
      const transferred = await transferPlayback(rawUser);
      if (transferred) {
        await spotifyRequest<unknown>(rawUser, "PUT", "/me/player/pause");
        return `⏸ Dipause di ${transferred}.`;
      }
    }
    throw err;
  }
  return "⏸ Spotify dipause.";
}

export async function spotifyNext(rawUser: unknown): Promise<string> {
  try {
    await spotifyRequest<unknown>(rawUser, "POST", "/me/player/next");
  } catch (err) {
    if (err instanceof Error && err.message === "spotify_no_active_device") {
      const transferred = await transferPlayback(rawUser);
      if (transferred) {
        await spotifyRequest<unknown>(rawUser, "POST", "/me/player/next");
        return `⏭ Lagu berikutnya di ${transferred}.`;
      }
    }
    throw err;
  }
  return "⏭ Lagu berikutnya.";
}

export async function spotifyPrevious(rawUser: unknown): Promise<string> {
  try {
    await spotifyRequest<unknown>(rawUser, "POST", "/me/player/previous");
  } catch (err) {
    if (err instanceof Error && err.message === "spotify_no_active_device") {
      const transferred = await transferPlayback(rawUser);
      if (transferred) {
        await spotifyRequest<unknown>(rawUser, "POST", "/me/player/previous");
        return `⏮ Lagu sebelumnya di ${transferred}.`;
      }
    }
    throw err;
  }
  return "⏮ Lagu sebelumnya.";
}

export async function spotifySetVolume(rawUser: unknown, percent: number): Promise<string> {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  try {
    await spotifyRequest<unknown>(rawUser, "PUT", `/me/player/volume?volume_percent=${p}`);
  } catch (err) {
    if (err instanceof Error && err.message === "spotify_no_active_device") {
      const transferred = await transferPlayback(rawUser);
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