// "Tebak Lagu" — song-guess game powered by Spotify search (fun feature).
//
// Mia picks a random track via the Spotify search API and the user must guess
// its title/artist from escalating clues. Guesses are validated LOCALLY with
// token-overlap matching (no extra API call), so the game is network-cheap:
// exactly one search per round. Score/streak persists per user in
// `.data/users/<user>/game.json` (same atomic pattern as moods/tasks).
//
// Flow:  game_start → clue 1 → game_guess (wrong → next clue, max 3 tries)
//        → win: score +1 (fewer tries = same +1; keep it simple)
//        → lose after 3 wrongs → reveal + reset. game_quit reveals anytime.

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";
import { spotifyRecentTracks, spotifyRandomTrack, spotifyConnected } from "./spotify";

export const MAX_TRIES = 3;

export interface SongGameSecret {
  id: string;
  name: string;
  artists: string[];
}

export interface SongGameState {
  active: SongGameSecret | null;
  cluesGiven: number; // how many clues already shown (0..MAX_TRIES)
  tries: number; // wrong guesses so far
  startedAt: number;
  wins: number;
  games: number; // rounds started
}

function gamePath(userKey: string): string {
  return join(userDataRoot(), userKey, "game.json");
}

function readGame(rawUser?: unknown): SongGameState {
  const userKey = sanitizeUser(rawUser);
  const empty: SongGameState = { active: null, cluesGiven: 0, tries: 0, startedAt: 0, wins: 0, games: 0 };
  if (!userKey) return empty;
  if (!existsSync(gamePath(userKey))) return empty;
  try {
    const parsed = JSON.parse(readFileSync(gamePath(userKey), "utf8")) as Partial<SongGameState>;
    return {
      active: parsed.active ?? null,
      cluesGiven: typeof parsed.cluesGiven === "number" ? parsed.cluesGiven : 0,
      tries: typeof parsed.tries === "number" ? parsed.tries : 0,
      startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
      wins: typeof parsed.wins === "number" ? parsed.wins : 0,
      games: typeof parsed.games === "number" ? parsed.games : 0,
    };
  } catch {
    return empty;
  }
}

function writeGame(state: SongGameState, rawUser?: unknown): void {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return;
  const file = gamePath(userKey);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file);
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

function artistLastTokens(secret: SongGameSecret): string[] {
  const STOPWORDS = new Set(["the", "and", "for", "are", "you", "not", "with", "from", "all", "feat"]);
  return secret.artists.flatMap((a) =>
    normalize(a).split(" ").filter((w) => w.length >= 3 && !STOPWORDS.has(w))
  );
}

/** Locally valid: guess matches title (loose) OR any meaningful artist token. */
export function answerMatches(guess: string, secret: SongGameSecret): boolean {
  const g = normalize(guess);
  if (!g) return false;
  const t = normalize(secret.name);
  if (!t) return false;
  if (t === g || t.includes(g) || g.includes(t)) return true;
  return artistLastTokens(secret).some((w) => g.includes(w));
}

function initials(artists: string[]): string {
  return artists
    .map((a) => a.trim().split(/\s+/).map((w) => w[0]?.toUpperCase() ?? "").join("."))
    .join(" & ");
}

function firstClue(secret: SongGameSecret): string {
  const letters = secret.name.replace(/[^a-zA-Z]/g, "").length;
  return `Lagu misteri: judul **${letters} huruf**, artis dengan inisial **${initials(secret.artists)}**.`;
}

function secondClue(secret: SongGameSecret): string {
  const firstWord = secret.name.trim().split(/\s+/)[0] ?? "?";
  const artist = secret.artists[0] ?? "?";
  return `Bocor dikit: judul diawali **"${firstWord}"** dan artisnya (di antara) **${artist}**.`;
}

function thirdClue(secret: SongGameSecret): string {
  return `Oke, clue pamungkas: judulnya **"${secret.name}"** — sebut artisnya aja boleh, atau judulnya.`;
}

function clueFor(secret: SongGameSecret, level: number): string {
  if (level >= 2) return thirdClue(secret);
  if (level === 1) return secondClue(secret);
  return firstClue(secret);
}

function reveal(secret: SongGameSecret): string {
  const artists = secret.artists.join(", ") || "?";
  const syllables = secret.name.replace(/[^a-zA-Z ]/g, "").trim().split(/\s+/).length;
  return `🎵 Jawabannya: **${secret.name}** — ${artists}${syllables > 1 ? " (dua kata, gimana bisa lupa ya 😄)" : ""}.`;
}

/** Start a new round. Picks a secret song from the user's recently played
 *  (so it's realistically one they'd know); falls back to a random search hit
 *  when the history is empty. Returns the message to show (clue 1). */
export async function startSongGame(rawUser?: unknown): Promise<string> {
  if (!spotifyConnected(rawUser)) {
    return "Spotify belum tersambung — hubungin dulu ya biar bisa aku ambil lagunya (minta `spotify_link`).";
  }
  const recent = await spotifyRecentTracks(rawUser);
  const secret = recent.length
    ? recent[Math.floor(Math.random() * recent.length)]
    : await spotifyRandomTrack(rawUser);
  const state = readGame(rawUser);
  state.active = secret;
  state.cluesGiven = 0;
  state.tries = 0;
  state.startedAt = Date.now();
  state.games += 1;
  writeGame(state, rawUser);
  return `🎲 *Tebak Lagu* (ronde #${state.games}!)\n${firstClue(secret)}\n\nTebak judul atau artisnya — ini dari lagu yang baru kamu putar 😉. Salah = dapet clue tambahan (maks ${MAX_TRIES} kesempatan).`;
}

/** Handle a guess. Returns celebratory/reveal message. */
export function guessSong(rawUser?: unknown, guess?: unknown): string {
  const state = readGame(rawUser);
  const secret = state.active;
  if (!secret) return "Belum ada ronde aktif — minta aku `game_start` dulu ya.";
  const g = typeof guess === "string" ? guess.trim() : "";
  if (!g) return "Jawab dulu donk, eh maksudnya jawabnya apa coba. 😄";

  if (answerMatches(g, secret)) {
    state.wins += 1;
    state.active = null;
    writeGame(state, rawUser);
    return `🎉 *BENER!* Itu tadi **${secret.name}** — ${secret.artists.join(", ")}.\nSkor: ${state.wins} kemenangan dari ${state.games} ronde. Mau lanjut? Bilang *lagi* ya!`;
  }

  state.tries += 1;
  if (state.tries >= MAX_TRIES) {
    const answer = reveal(secret);
    state.active = null;
    writeGame(state, rawUser);
    return `💀 Waktu habis!\n${answer}\nSkor: ${state.wins} kemenangan dari ${state.games} ronde. Gas lagi?`;
  }
  state.cluesGiven = state.tries;
  writeGame(state, rawUser);
  return `Hmm, bukan ${g}.\n${clueFor(secret, state.tries)}\nSisa ${MAX_TRIES - state.tries} kesempatan.`;
}

/** Give up: reveal the answer and keep the score stopped. */
export function quitSongGame(rawUser?: unknown): string {
  const state = readGame(rawUser);
  if (!state.active) return "Nggak ada ronde yang lagi jalan — mulai dulu pake `game_start` ya.";
  const answer = reveal(state.active);
  state.active = null;
  writeGame(state, rawUser);
  return `Menyerah? Oke.\n${answer}\nSkor: ${state.wins} kemenangan dari ${state.games} ronde. Kapan-kapan kita ulang!`;
}

/** Track-score readout, used by tools after a game ends. */
export function gameStats(rawUser?: unknown): string {
  const s = readGame(rawUser);
  return `${s.wins} kemenangan dari ${s.games} ronde.`;
}