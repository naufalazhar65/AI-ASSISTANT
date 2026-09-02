// Multi-session / resumable conversation history (OpenClaw fitur). Server-side
// only, per-user (auth-lite) — consistent with notes/reminders/persona.
//
// Each user has a lightweight index plus one JSON file per saved session under
// apps/web/.data/users/<user>/sessions/. A session stores the serialized
// conversation (messages + transcripts) that ConversationManager.serialize()
// produces, so a saved conversation can be resumed exactly. The index lets the
// UI list sessions without loading every transcript.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";

/** Serializable conversation (matches ConversationManager.serialize()). */
export interface SerializedConversation {
  messages: unknown[];
  transcripts: { id: string; role: string; text: string; state: string }[];
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

function sessionsDir(userKey: string): string {
  return join(userDataRoot(), userKey, "sessions");
}

function indexPath(userKey: string): string {
  return join(sessionsDir(userKey), "index.json");
}

function sessionPath(userKey: string, id: string): string {
  return join(sessionsDir(userKey), `${id}.json`);
}

function sanitizeId(id: unknown): string | null {
  if (typeof id !== "string") return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  return id;
}

/** Read the saved sessions index for a user (empty/missing → nothing). */
export function listSessions(rawUser?: unknown): SessionMeta[] {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return [];
  try {
    const parsed = JSON.parse(readFileSync(indexPath(userKey), "utf8")) as unknown;
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
export function loadSession(rawUser?: unknown, id?: unknown): Session | null {
  const userKey = sanitizeUser(rawUser);
  const sessionId = sanitizeId(id);
  if (!userKey || !sessionId) return null;
  try {
    const parsed = JSON.parse(readFileSync(sessionPath(userKey, sessionId), "utf8")) as unknown;
    if (!parsed || typeof (parsed as Session).conversation !== "object") return null;
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
  title?: string
): { id: string } {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) throw new Error("invalid user");
  const sessionId = (id && sanitizeId(id)) || `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const sessionTitle = (title || "Untitled").trim().slice(0, 60) || "Untitled";
  const dir = sessionsDir(userKey);
  mkdirSync(dir, { recursive: true });

  const now = Date.now();
  const turns = Array.isArray(conversation.transcripts)
    ? conversation.transcripts.filter((t) => t.state === "final").length
    : 0;

  writeFileSync(sessionPath(userKey, sessionId), JSON.stringify({ id: sessionId, title: sessionTitle, updatedAt: now, turns, conversation }, null, 2));

  const index = listSessions(rawUser).filter((s) => s.id !== sessionId);
  index.push({ id: sessionId, title: sessionTitle, updatedAt: now, turns });
  index.sort(sortById);
  const trimmed = index.slice(0, MAX_SESSIONS);
  writeFileSync(indexPath(userKey), JSON.stringify(trimmed, null, 2));
  return { id: sessionId };
}

/** Delete a session (and its file) for a user. Returns false if it did not exist. */
export function deleteSession(rawUser?: unknown, id?: unknown): boolean {
  const userKey = sanitizeUser(rawUser);
  const sessionId = sanitizeId(id);
  if (!userKey || !sessionId) return false;
  try {
    rmSync(sessionPath(userKey, sessionId), { force: true });
  } catch {
    /* file may not exist */
  }
  const index = listSessions(rawUser).filter((s) => s.id !== sessionId);
  writeFileSync(indexPath(userKey), JSON.stringify(index, null, 2));
  return true;
}

const MAX_SESSIONS = 12;