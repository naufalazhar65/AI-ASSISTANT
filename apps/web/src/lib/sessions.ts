// Multi-session / resumable conversation history (OpenClaw fitur). Server-side
// only, per-user (auth-lite) — consistent with notes/reminders/persona.
//
// Each user has a lightweight index plus one JSON file per saved session under
// apps/web/.data/users/<user>/sessions/. A session stores the serialized
// conversation (messages + transcripts) that ConversationManager.serialize()
// produces, so a saved conversation can be resumed exactly. The index lets the
// UI list sessions without loading every transcript.

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";

/** Serializable conversation (matches ConversationManager.serialize()). */
export interface SerializedConversation {
  messages: unknown[];
  transcripts: { id: string; role: string; text: string; state: string }[];
  /**
   * Per-message SEND time, aligned with `messages` (same index).
   * `null`/absent = the time is genuinely unknown — never a guess.
   * The office chat persists this so a reload shows the real time a message
   * was sent instead of the time the page happened to be opened.
   */
  stamps?: (number | null)[];
}

export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: number;
  /** Number of final transcripts, for a cheap preview icon in the UI. */
  turns: number;
}

export interface Session extends SessionMeta {
  conversation: SerializedConversation;
}

const sortById = (a: SessionMeta, b: SessionMeta) => b.updatedAt - a.updatedAt;

/**
 * Session COLLECTIONS. One user key can hold several independent collections
 * of conversations, each with its own directory, its own index and its own
 * cap — so two surfaces can never list, cap, prune or restore each other's
 * transcripts.
 *
 * Why this exists (2026-10-22, measured): the office chat persisted under the
 * OWNER scope with ids `office-<agent>`, i.e. all three agents AND the web app
 * shared ONE `sessions/` dir, ONE index and ONE 12-slot cap. The web app
 * restores the NEWEST session on mount, so it could pick an agent's office
 * transcript — and then autosave Mia's web words INTO that file, which the
 * dashboard then showed under that agent. Shared index = shared transcript.
 */
export const SESSION_COLLECTION_WEB = "web";

/** Collection for one office agent's chat: `office-mia`, `office-agnes`, … */
export function officeSessionCollection(agent: string): string {
  return `office-${agent}`;
}

function safeCollection(collection: unknown): string {
  if (typeof collection !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(collection)) {
    return SESSION_COLLECTION_WEB;
  }
  return collection;
}

function sessionsDir(userKey: string, collection: string = SESSION_COLLECTION_WEB): string {
  return collection === SESSION_COLLECTION_WEB
    ? join(userDataRoot(), userKey, "sessions")
    : join(userDataRoot(), userKey, `sessions-${collection}`);
}

function indexPath(userKey: string, collection: string = SESSION_COLLECTION_WEB): string {
  return join(sessionsDir(userKey, collection), "index.json");
}

function sessionPath(userKey: string, id: string, collection: string = SESSION_COLLECTION_WEB): string {
  return join(sessionsDir(userKey, collection), `${id}.json`);
}

function sanitizeId(id: unknown): string | null {
  if (typeof id !== "string") return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  return id;
}

/** Atomic write (temp file + rename) so a crash never leaves a truncated file. */
function writeJson(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}

/**
 * Remove session files missing from the index, so capping/pruning does not
 * leave orphan .json files on disk forever. Errors are swallowed (best-effort).
 */
function pruneOrphans(userKey: string, keep: string[], collection: string = SESSION_COLLECTION_WEB): void {
  let names: string[] = [];
  try {
    names = readdirSync(sessionsDir(userKey, collection)).filter((n) => n.endsWith(".json") && n !== "index.json");
  } catch {
    return;
  }
  const keepSet = new Set(keep);
  for (const name of names) {
    const id = basename(name, ".json");
    if (!keepSet.has(id)) {
      try {
        rmSync(join(sessionsDir(userKey), name), { force: true });
      } catch {
        /* swallowed */
      }
    }
  }
}

/** Read the saved sessions index for a user (empty/missing → nothing). */
export function listSessions(rawUser?: unknown, collection?: string): SessionMeta[] {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return [];
  try {
    const parsed = JSON.parse(readFileSync(indexPath(userKey, safeCollection(collection)), "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s): s is SessionMeta => !!s && typeof (s as SessionMeta).id === "string")
      .sort(sortById);
  } catch {
    return [];
  }
}

/**
 * Load one session's full conversation by id. Returns null if it does not
 * exist or is corrupt.
 */
export function loadSession(rawUser?: unknown, id?: unknown, collection?: string): Session | null {
  const userKey = sanitizeUser(rawUser);
  const sessionId = sanitizeId(id);
  if (!userKey || !sessionId) return null;
  try {
    const parsed = JSON.parse(readFileSync(sessionPath(userKey, sessionId, safeCollection(collection)), "utf8")) as unknown;
    const conv = (parsed as Session)?.conversation;
    if (!conv || typeof conv !== "object" || !Array.isArray((conv as SerializedConversation).transcripts)) {
      return null;
    }
    return parsed as Session;
  } catch {
    return null;
  }
}

/**
 * Create or update a session for a user. The index is rewritten and pruned to
 * at most `MAX_SESSIONS`. Returns the updated session id.
 */
export function upsertSession(
  rawUser: unknown,
  id: string | null,
  conversation: SerializedConversation,
  title?: string,
  collection?: string
): { id: string } {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) throw new Error("invalid user");
  const col = safeCollection(collection);
  const sessionId = (id && sanitizeId(id)) || `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const sessionTitle = (title || "Untitled").trim().slice(0, 60) || "Untitled";
  const dir = sessionsDir(userKey, col);
  mkdirSync(dir, { recursive: true });

  const now = Date.now();
  // A "turn" is a user utterance — count final user transcripts, not every
  // final entry (which would double-count each exchange).
  const turns = Array.isArray(conversation.transcripts)
    ? conversation.transcripts.filter((t) => t.state === "final" && t.role === "user").length
    : 0;

  writeJson(
    sessionPath(userKey, sessionId, col),
    { id: sessionId, title: sessionTitle, updatedAt: now, turns, conversation }
  );

  const index = listSessions(rawUser, col).filter((s) => s.id !== sessionId);
  index.push({ id: sessionId, title: sessionTitle, updatedAt: now, turns });
  index.sort(sortById);
  const trimmed = index.slice(0, MAX_SESSIONS);
  writeJson(indexPath(userKey, col), trimmed);
  pruneOrphans(userKey, trimmed.map((s) => s.id), col);
  return { id: sessionId };
}

/** Delete a session (and its file) for a user. Returns false if it did not exist. */
export function deleteSession(rawUser?: unknown, id?: unknown, collection?: string): boolean {
  const userKey = sanitizeUser(rawUser);
  const sessionId = sanitizeId(id);
  const col = safeCollection(collection);
  if (!userKey || !sessionId) return false;
  try {
    rmSync(sessionPath(userKey, sessionId, col), { force: true });
  } catch {
    /* file may not exist */
  }
  const index = listSessions(rawUser, col).filter((s) => s.id !== sessionId);
  writeJson(indexPath(userKey, col), index);
  return true;
}

const MAX_SESSIONS = 12;