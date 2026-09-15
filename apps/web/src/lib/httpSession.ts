// Named HTTP sessions (cookies + headers) for authenticated / multi-identity
// testing (BOLA/IDOR needs two accounts). Pure local store — no network here.
// Used by `http_request` (apply/save) and `bola_diff` in security.ts.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";

export type HttpSession = { headers: Record<string, string>; cookies: Record<string, string>; updatedAt: string };
type Store = Record<string, HttpSession>;

function path(userKey: string): string {
  return join(userDataRoot(), userKey, "http-sessions.json");
}
export function readSessions(rawUser: unknown): Store {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return {};
  try {
    const j = JSON.parse(readFileSync(path(userKey), "utf8"));
    return j && typeof j === "object" ? (j as Store) : {};
  } catch {
    return {};
  }
}
function write(rawUser: unknown, store: Store): void {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return;
  const file = path(userKey);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, file);
}

/** Parse a cookie header (`a=1; b=2`) or Set-Cookie line into a cookie map
 *  (Set-Cookie attributes like Path/Domain/HttpOnly are skipped). */
export function parseCookieString(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (raw || "").split(";")) {
    const kv = part.trim();
    if (!kv) continue;
    const i = kv.indexOf("=");
    if (i <= 0) continue;
    const k = kv.slice(0, i).trim();
    if (/^(path|domain|expires|max-age|samesite|secure|httponly)$/i.test(k)) continue;
    out[k] = kv.slice(i + 1).trim();
  }
  return out;
}

export function setSession(rawUser: unknown, name: string, patch: { headers?: Record<string, string>; cookies?: Record<string, string>; cookie?: string }): HttpSession {
  const key = (name || "").trim();
  if (!key) throw new Error("nama session wajib");
  const store = readSessions(rawUser);
  const prev = store[key] || { headers: {}, cookies: {}, updatedAt: "" };
  const cookies = { ...prev.cookies, ...(patch.cookies || {}) };
  if (patch.cookie) Object.assign(cookies, parseCookieString(patch.cookie));
  const next: HttpSession = { headers: { ...prev.headers, ...(patch.headers || {}) }, cookies, updatedAt: new Date().toISOString() };
  store[key] = next;
  write(rawUser, store);
  return next;
}

export function deleteSession(rawUser: unknown, name: string): boolean {
  const store = readSessions(rawUser);
  if (!(name in store)) return false;
  delete store[name];
  write(rawUser, store);
  return true;
}

export function listSessions(rawUser: unknown): string {
  const store = readSessions(rawUser);
  const entries = Object.entries(store);
  if (!entries.length) return "Belum ada session. Buat: http_session action=set name=A cookie=\"sid=...\" (atau headers).";
  return `🔑 Session (${entries.length}):\n${entries
    .map(([n, s]) => `• ${n} — ${Object.keys(s.cookies).length} cookie, ${Object.keys(s.headers).length} header${s.updatedAt ? ` (${s.updatedAt.slice(0, 19)})` : ""}`)
    .join("\n")}`;
}

/** Merge a session's headers + cookies into a request header map. */
export function sessionHeaders(rawUser: unknown, name: string): { headers: Record<string, string>; cookie: string } | null {
  const s = readSessions(rawUser)[(name || "").trim()];
  if (!s) return null;
  return { headers: { ...s.headers }, cookie: Object.entries(s.cookies).map(([k, v]) => `${k}=${v}`).join("; ") };
}

/** Merge Set-Cookie values into a session (used after an authenticated request). */
export function captureCookies(rawUser: unknown, name: string, setCookies: string[]): number {
  const store = readSessions(rawUser);
  const prev = store[name] || { headers: {}, cookies: {}, updatedAt: "" };
  const cookies = { ...prev.cookies };
  for (const sc of setCookies) {
    const kv = sc.split(";")[0];
    const i = kv.indexOf("=");
    if (i > 0) cookies[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  store[name] = { headers: prev.headers, cookies, updatedAt: new Date().toISOString() };
  write(rawUser, store);
  return Object.keys(cookies).length;
}
