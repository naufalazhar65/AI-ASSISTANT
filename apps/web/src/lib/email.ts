// Gmail inbox integration — read-only, tidy, no bug.
// Mirrors spotify.ts OAuth pattern: per-user token store, auto-refresh,
// server-only secrets (invariant 5). Tools are read-only (risk: read).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalUserKey, sanitizeUser, userDataRoot } from "./users";

export const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID || "";
export const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || "";
export const GMAIL_REDIRECT_URI = process.env.GMAIL_REDIRECT_URI || "http://localhost:3000/api/gmail/callback";

const GMAIL_ACCOUNTS = "https://accounts.google.com/o/oauth2/v2/auth";
const GMAIL_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
const SCOPES = "https://www.googleapis.com/auth/gmail.readonly";
const TOKEN_FILE = "gmail.json";
const TIMEOUT_MS = 15000;

export interface GmailToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  connectedAt: number;
}

function gmailPath(userKey: string): string {
  return join(userDataRoot(), userKey, TOKEN_FILE);
}

export function gmailConfigured(): boolean {
  return !!(GMAIL_CLIENT_ID && GMAIL_CLIENT_SECRET);
}

export function readGmailToken(rawUser?: unknown): GmailToken | null {
  const userKey = canonicalUserKey(rawUser);
  if (!userKey) return null;
  const file = gmailPath(userKey);
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

function writeGmailToken(token: GmailToken, rawUser?: unknown): void {
  const userKey = canonicalUserKey(rawUser);
  if (!userKey) throw new Error("invalid user");
  const file = gmailPath(userKey);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(token, null, 2));
  renameSync(tmp, file);
}

export function clearGmailToken(rawUser?: unknown): void {
  const userKey = canonicalUserKey(rawUser);
  if (!userKey) return;
  const file = gmailPath(userKey);
  try {
    if (existsSync(file)) renameSync(file, `${file}.revoked.${Date.now()}`);
  } catch { /* best-effort */ }
}

export function gmailAuthUrl(rawUser?: unknown, redirectUri = GMAIL_REDIRECT_URI): string {
  const userKey = canonicalUserKey(rawUser) || "";
  const params = new URLSearchParams({
    client_id: GMAIL_CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    state: userKey,
  });
  return `${GMAIL_ACCOUNTS}?${params.toString()}`;
}

export async function exchangeGmailCode(code: string, rawUser?: unknown, redirectUri = GMAIL_REDIRECT_URI): Promise<void> {
  const userKey = canonicalUserKey(rawUser);
  if (!userKey) throw new Error("invalid user");
  if (!gmailConfigured()) throw new Error("Gmail is not configured");
  const body = new URLSearchParams({
    code,
    client_id: GMAIL_CLIENT_ID,
    client_secret: GMAIL_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch(GMAIL_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`Gmail auth failed: ${String(data.error_description ?? data.error ?? res.status)}`);
  const accessToken = typeof data.access_token === "string" ? data.access_token : "";
  const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token : "";
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
  if (!accessToken) throw new Error("Gmail auth returned no token");
  const existing = readGmailToken(userKey);
  const finalRefresh = refreshToken || existing?.refreshToken || "";
  if (!finalRefresh) throw new Error("Gmail refresh token missing — re-authorize with consent");
  writeGmailToken(
    { accessToken, refreshToken: finalRefresh, expiresAt: Date.now() + (expiresIn - 60) * 1000, connectedAt: Date.now() },
    userKey
  );
}

async function refreshGmailToken(token: GmailToken, rawUser?: unknown): Promise<GmailToken> {
  const body = new URLSearchParams({
    client_id: GMAIL_CLIENT_ID,
    client_secret: GMAIL_CLIENT_SECRET,
    refresh_token: token.refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(GMAIL_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`Gmail refresh failed: ${String(data.error_description ?? data.error ?? res.status)}`);
  const accessToken = typeof data.access_token === "string" ? data.access_token : "";
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
  const fresh: GmailToken = {
    accessToken,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : token.refreshToken,
    expiresAt: Date.now() + (expiresIn - 60) * 1000,
    connectedAt: token.connectedAt,
  };
  writeGmailToken(fresh, rawUser);
  return fresh;
}

async function gmailRequest<T>(rawUser: unknown, method: string, path: string, body?: unknown): Promise<T> {
  if (!gmailConfigured()) throw new Error("Gmail is not configured");
  let token = readGmailToken(rawUser);
  if (!token) throw new Error("gmail_not_connected");
  if (Date.now() >= token.expiresAt) token = await refreshGmailToken(token, rawUser);
  const doFetch = async (tok: GmailToken): Promise<Response> => {
    const headers: Record<string, string> = { Authorization: `Bearer ${tok.accessToken}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(`${GMAIL_API}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  };
  let res = await doFetch(token);
  if (res.status === 401) {
    token = await refreshGmailToken(token, rawUser);
    res = await doFetch(token);
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Gmail error ${res.status}: ${txt.slice(0, 200)}`);
  }
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined as T;
  }
}

export function gmailConnected(rawUser?: unknown): boolean {
  return !!readGmailToken(rawUser);
}

// Helpers: decode base64url, extract text from Gmail payload
function decodeBase64Url(s: string): string {
  try {
    const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function extractBody(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  const walk = (p: Record<string, unknown>) => {
    const mime = String(p.mimeType || "");
    const body = p.body as Record<string, unknown> | undefined;
    if (body?.data && typeof body.data === "string") {
      if (mime.startsWith("text/plain") || mime.startsWith("text/html")) {
        const decoded = decodeBase64Url(body.data);
        const text = mime.includes("html") ? decoded.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() : decoded;
        if (text) parts.push(text);
      }
    }
    const sub = p.parts as Record<string, unknown>[] | undefined;
    if (Array.isArray(sub)) sub.forEach(walk);
  };
  walk(payload);
  return parts.join("\n").slice(0, 8000).trim();
}

function headerValue(headers: Array<{ name: string; value: string }>, name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
}

export async function gmailList(rawUser: unknown, maxResults = 10, query = ""): Promise<string> {
  const q = query ? `?q=${encodeURIComponent(query)}&maxResults=${maxResults}` : `?maxResults=${maxResults}`;
  const data = await gmailRequest<{ messages?: Array<{ id: string; threadId: string }>; resultSizeEstimate?: number }>(rawUser, "GET", `/users/me/messages${q}`);
  const msgs = data.messages || [];
  if (!msgs.length) return "Inbox kosong atau tidak ada hasil.";
  const lines: string[] = [];
  for (let i = 0; i < Math.min(msgs.length, maxResults); i++) {
    try {
      const full = await gmailRequest<Record<string, unknown>>(rawUser, "GET", `/users/me/messages/${msgs[i].id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
      const hdrs = (full.payload as Record<string, unknown>)?.headers as Array<{ name: string; value: string }> | undefined;
      const from = hdrs ? headerValue(hdrs, "From") : "";
      const subject = hdrs ? headerValue(hdrs, "Subject") : "";
      const date = hdrs ? headerValue(hdrs, "Date") : "";
      const snippet = String(full.snippet || "").slice(0, 120);
      lines.push(`${i + 1}. [${msgs[i].id}] ${subject || "(no subject)"}\n   From: ${from}\n   Date: ${date}\n   ${snippet}`);
    } catch {
      lines.push(`${i + 1}. [${msgs[i].id}] (gagal baca metadata)`);
    }
  }
  return lines.join("\n\n");
}

export async function gmailRead(rawUser: unknown, id: string): Promise<string> {
  if (!id.trim()) throw new Error("message id required");
  const data = await gmailRequest<Record<string, unknown>>(rawUser, "GET", `/users/me/messages/${encodeURIComponent(id)}?format=full`);
  const payload = data.payload as Record<string, unknown> | undefined;
  const hdrs = payload?.headers as Array<{ name: string; value: string }> | undefined;
  const from = hdrs ? headerValue(hdrs, "From") : "";
  const to = hdrs ? headerValue(hdrs, "To") : "";
  const subject = hdrs ? headerValue(hdrs, "Subject") : "";
  const date = hdrs ? headerValue(hdrs, "Date") : "";
  const body = payload ? extractBody(payload) : "";
  const snippet = String(data.snippet || "");
  return `From: ${from}\nTo: ${to}\nSubject: ${subject}\nDate: ${date}\n\n${body || snippet}`.slice(0, 10000).trim() || "Email kosong.";
}

export async function gmailSearch(rawUser: unknown, query: string, maxResults = 10): Promise<string> {
  if (!query.trim()) throw new Error("query required");
  return gmailList(rawUser, maxResults, query);
}
