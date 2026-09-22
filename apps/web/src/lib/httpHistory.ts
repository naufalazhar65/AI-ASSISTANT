// Per-user HTTP history — a lightweight Burp-like log of active requests made
// by Mia's tools (http_request / bola_diff), for review and reporting.
// Store: .data/users/<user>/http-history.json (cap 200).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";

export type HttpRecord = { method: string; url: string; status: number; bytes: number; ms: number; at: string };
const CAP = 200;

function file(userKey: string): string {
  return join(userDataRoot(), userKey, "http-history.json");
}
export function readHttpHistory(rawUser: unknown): HttpRecord[] {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return [];
  try {
    const j = JSON.parse(readFileSync(file(userKey), "utf8"));
    return Array.isArray(j) ? (j as HttpRecord[]) : [];
  } catch {
    return [];
  }
}
const SENSITIVE_KEYS = /pass|passwd|pwd|secret|token|api_?key|auth|session|cookie|credential|private/i;

/**
 * Scrub credential-bearing query values from a URL before storage (audit
 * 2026-09-23: `admin-login?u=…&p=…` was stored verbatim and recalled into
 * findings/prompts). Param NAMES stay (IDOR evidence needs id/q); VALUES of
 * sensitive keys become [redacted]. Pure — tested.
 */
export function sanitizeHttpUrl(raw: string): string {
  try {
    const u = new URL(raw);
    let hit = false;
    for (const k of [...u.searchParams.keys()]) {
      if (SENSITIVE_KEYS.test(k) || ((k === "u" || k === "p" || k === "user" || k === "pass") && /login|signin|auth|admin/i.test(u.pathname))) {
        u.searchParams.set(k, "REDACTED");
        hit = true;
      }
    }
    return hit ? u.toString() : raw;
  } catch {
    return raw;
  }
}
export function recordHttp(rawUser: unknown, rec: HttpRecord): void {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return;
  try {
    const rows = readHttpHistory(rawUser);
    rows.push({ ...rec, url: sanitizeHttpUrl(rec.url) });
    while (rows.length > CAP) rows.shift();
    const f = file(userKey);
    mkdirSync(dirname(f), { recursive: true });
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, JSON.stringify(rows, null, 2));
    renameSync(tmp, f);
  } catch {
    /* best-effort */
  }
}
export function httpHistoryText(rawUser: unknown, limit = 40): string {
  const rows = readHttpHistory(rawUser);
  if (!rows.length) return "Belum ada riwayat HTTP (tool aktif akan tercatat di sini).";
  const shown = rows.slice().reverse().slice(0, limit);
  return `🌐 Riwayat HTTP (${rows.length} terakhir dari ${rows.length}):\n${shown.map((r) => `• [${r.method} ${r.status}] ${r.url} (${r.bytes}b, ${r.ms}ms) ${r.at.slice(11, 19)}`).join("\n")}`;
}
