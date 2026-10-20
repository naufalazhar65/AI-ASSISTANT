// Gmail inbox integration — read-only, tidy, no bug.
// Mirrors spotify.ts OAuth pattern: per-user token store, auto-refresh,
// server-only secrets (invariant 5). Tools are read-only (risk: read).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalUserKey, userDataRoot } from "./users";
import { dateTimeLabel, dateTimeShort, userTimeZone } from "./time";

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
  /**
   * Set once the refresh token was rejected as dead (invalid_grant / expired
   * or revoked). A Google app still in "Testing" consent status gets its
   * refresh token killed after 7 days, so this is permanent until the owner
   * re-authorizes — retrying can never succeed (measured 2026-10-07: refresh
   * failed with "Token has been expired or revoked." after ~7.4 days).
   * Cleared implicitly by `writeGmailToken` on the next successful exchange.
   */
  revokedAt?: number;
}

function gmailPath(userKey: string): string {
  return join(userDataRoot(), userKey, TOKEN_FILE);
}

export function gmailConfigured(): boolean {
  return !!(GMAIL_CLIENT_ID && GMAIL_CLIENT_SECRET);
}

/**
 * Thrown (as a message prefix) when the refresh token itself is dead.
 *
 * Distinct from a transient failure (network blip, 5xx, 400 from a malformed
 * request): `invalid_grant` / `expired or revoked` are terminal — the token
 * is gone and no amount of retrying brings it back, so the only fix is
 * re-authorizing through `gmailAuthUrl`. One owner for both the marker and the
 * human wording, so the tool layer and the honesty guard can never drift.
 */
export const GMAIL_TOKEN_REVOKED = "gmail_token_revoked";

/** Pure: does a Google token-endpoint error describe a dead refresh token? */
export function isRevokedRefreshError(description: string): boolean {
  const d = (description || "").toLowerCase();
  return (
    d.includes("invalid_grant") ||
    d.includes("expired or revoked") ||
    d.includes("token has been expired") ||
    d.includes("unauthorized_client")
  );
}

/** The one honest Indonesian explanation, with the relink link attached. */
export function revokedMessage(authUrl: string): string {
  return (
    `Error: ${GMAIL_TOKEN_REVOKED}: token Gmail sudah dicabut atau kedaluwarsa (biasanya Google mencabut refresh token setelah 7 hari kalau aplikasi masih berstatus consent "Testing"). ` +
    `Mencoba lagi sendiri TIDAK akan berhasil — satu-satunya jalan: hubungkan ulang lewat link ini: ${authUrl}`
  );
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
      ...(typeof t.revokedAt === "number" ? { revokedAt: t.revokedAt } : {}),
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

/** Stamp `revokedAt` on the stored token so later calls know it is dead. */
function markGmailTokenRevoked(rawUser?: unknown): void {
  const userKey = canonicalUserKey(rawUser);
  if (!userKey) return;
  const token = readGmailToken(userKey);
  if (!token) return;
  try {
    // Re-stamp is harmless; a token already stamped keeps its first timestamp
    // so "known dead since <date>" stays stable across turns.
    writeGmailToken({ ...token, revokedAt: token.revokedAt ?? Date.now() }, userKey);
  } catch { /* best-effort: the in-memory throw still carries the reason */ }
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
  if (!res.ok) {
    const desc = String(data.error_description ?? data.error ?? res.status);
    // Terminal failure: remember it so `gmailConnected` stops claiming the
    // account is usable and `gmail_link` hands back the relink URL.
    if (isRevokedRefreshError(desc)) {
      markGmailTokenRevoked(rawUser);
      throw new Error(`${GMAIL_TOKEN_REVOKED}: ${desc}`);
    }
    throw new Error(`Gmail refresh failed: ${desc}`);
  }
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
  // Known-dead token: fail fast with the terminal reason instead of spending a
  // network round-trip on a refresh that Google will reject again. Still
  // throws the same marker, so the tool layer maps it identically.
  if (token.revokedAt) throw new Error(`${GMAIL_TOKEN_REVOKED}: token ditandai mati sejak ${token.revokedAt}`);
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

/**
 * Is the account actually USABLE? A token file whose refresh token was
 * rejected as dead counts as disconnected — otherwise `gmail_link` answers
 * "sudah terhubung" and the only fix (re-authorize) becomes unreachable.
 */
export function gmailConnected(rawUser?: unknown): boolean {
  const token = readGmailToken(rawUser);
  return !!token && !token.revokedAt;
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

/**
 * Inbox list — COMPACT, privacy-aware and timezone-aware.
 *
 * What changed (2026-10-20): the old output was a wall of text — every email
 * repeated as 4 lines (index, subject, the RAW `From:` header with the full
 * address, the RAW RFC-2822 date, then the snippet) and the whole thing was
 * printed into the chat as the assistant's message. The owner saw 10 emails
 * as an unstructured dump and had to read it in the chat pane.
 *
 * Now: one line per email — subject, sender DISPLAY NAME (never the full
 * address), the time in the USER's timezone, and a short snippet. No bodies,
 * no raw headers. The full sender address stays behind `gmail_read`, which
 * takes a deliberate action.
 *
 * The line format is deterministic and parseable (`parseInboxSummary` in
 * officeChat.ts) so the UI can render a real list instead of prose:
 *   `N. [id] Subject | Display Name | 20 Okt 2026, 14.45 WIB | snippet`
 */
export async function gmailList(rawUser: unknown, maxResults = 10, query = ""): Promise<string> {
  const q = query ? `?q=${encodeURIComponent(query)}&maxResults=${maxResults}` : `?maxResults=${maxResults}`;
  const data = await gmailRequest<{ messages?: Array<{ id: string; threadId: string }>; resultSizeEstimate?: number }>(rawUser, "GET", `/users/me/messages${q}`);
  const msgs = data.messages || [];
  if (!msgs.length) return "📬 Ringkasan Inbox — 0 email. Inbox kosong atau tidak ada hasil.";
  const zone = userTimeZone();
  const rows: { id: string; subject: string; from: string; at: string; snippet: string; atMs: number }[] = [];
  for (let i = 0; i < Math.min(msgs.length, maxResults); i++) {
    const id = msgs[i].id;
    try {
      const full = await gmailRequest<Record<string, unknown>>(rawUser, "GET", `/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
      const hdrs = (full.payload as Record<string, unknown>)?.headers as Array<{ name: string; value: string }> | undefined;
      const rawFrom = hdrs ? headerValue(hdrs, "From") : "";
      const subject = hdrs ? headerValue(hdrs, "Subject") : "";
      const rawDate = hdrs ? headerValue(hdrs, "Date") : "";
      const atMs = rawDate ? Date.parse(rawDate) : NaN;
      rows.push({
        id,
        subject: oneLine(subject) || "(tanpa judul)",
        from: senderDisplayName(rawFrom),
        // An unparseable provider date stays EMPTY — a date is never invented.
        at: Number.isNaN(atMs) ? "" : dateTimeLabel(atMs, zone),
        snippet: oneLine(String(full.snippet || "")).slice(0, 90),
        atMs: Number.isNaN(atMs) ? 0 : atMs,
      });
    } catch {
      rows.push({ id, subject: "(gagal baca metadata)", from: "", at: "", snippet: "", atMs: 0 });
    }
  }
  const stamps = rows.map((r) => r.atMs).filter((n) => n > 0);
  const range = stamps.length
    ? `${dateTimeShort(Math.min(...stamps), zone)} – ${dateTimeLabel(Math.max(...stamps), zone)}`
    : "";
  const header = `📬 Ringkasan Inbox — ${rows.length} email terbaru${range ? ` · ${range}` : ""}`;
  const lines = rows.map(
    (r, i) => `${i + 1}. [${r.id}] ${r.subject} | ${r.from} | ${r.at} | ${r.snippet}`,
  );
  return [header, ...lines].join("\n");
}

/** Collapse whitespace; the inbox summary is one line per email. */
function oneLine(text: string): string {
  return String(text || "").replace(/\s+/g, " ").replace(/\|/g, " ").trim();
}

/**
 * "Home Credit Indonesia <donotreply@homecredit.co.id>" → "Home Credit
 * Indonesia". A bare address is masked ("d***@homecredit.co.id") — the full
 * address is only revealed by gmail_read, on purpose.
 */
export function senderDisplayName(from: string): string {
  const raw = oneLine(from);
  if (!raw) return "";
  const m = raw.match(/^(.*?)\s*<([^>]+)>$/);
  if (m) {
    const name = m[1].replace(/^["']|["']$/g, "").trim();
    if (name) return name;
    return maskAddress(m[2]);
  }
  if (raw.includes("@")) return maskAddress(raw);
  return raw;
}

/** "donotreply@x.co" → "d***@x.co" — enough to recognise, not to contact. */
export function maskAddress(addr: string): string {
  const raw = String(addr || "").trim();
  const at = raw.indexOf("@");
  if (at <= 0) return raw;
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  return `${local.slice(0, 1)}***@${domain}`;
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

/**
 * True when the ask wants to LOOK at the inbox (not send mail). Pure.
 * "kirim email" is deliberately excluded — that is a send task, and nudging
 * a read there would misfire the turn.
 */
export function isEmailCheckAsk(text: string): boolean {
  const t = String(text || "");
  if (!t || /\bkirim\b/i.test(t)) return false;
  return /\b(cek|lihat|buka|baca|tampilkan|tunjukin|cari)\b.{0,24}\bemail\b/i.test(t) || /\bemail\b.{0,24}\b(masuk|baru|terbaru|ada|nggak|belum)\b/i.test(t) || /\binbox\b/i.test(t);
}

export interface GmailGateInput {
  userText: string;
  executedNames: readonly string[];
  hasRoundBudget: boolean;
  alreadyNudged?: boolean;
  isConfirmContinuation?: boolean;
  headless?: boolean;
}

/**
 * One retry round when a "cek email" turn is about to end with zero gmail_*
 * tools (live 2026-10-15 14:32: the model answered from memory — "ada email
 * baru dari Trabajo.org ..." — with no fresh check, so dates/subjects were
 * stale-or-absent). Mirrors probeGateNudge: bounded once per turn, skipped on
 * confirm continuations and headless turns. The caller posts the return as a
 * `[email-gate]` user message (internal-turn, never shadows the real ask).
 */
export function gmailGateNudge(input: GmailGateInput): string {
  if (!isEmailCheckAsk(input.userText)) return "";
  if (input.isConfirmContinuation) return "";
  if (input.headless) return "";
  if (!input.hasRoundBudget) return "";
  if (input.alreadyNudged) return "";
  if (input.executedNames.some((n) => /^gmail_(list|search|read)$/.test(n))) return "";
  return [
    `Error: giliran ini belum mengecek email — belum ada SATU pun pemanggilan gmail_list/search/read yang berjalan.`,
    `Yang kamu tulis baru ingatan dari percakapan sebelumnya, BUKAN hasil cek baru, dan tanggal/subjeknya bisa basi.`,
    `Lakukan sekarang juga: panggil gmail_list dulu (tanpa query bila user tidak menyebut filter), baca hasilnya, baru jawab dari situ.`,
    `Kalau inbox memang kosong atau tool-nya error, bilang terus terang dari hasil tool itu — jangan mengarang isi email.`,
  ].join(" ");
}
