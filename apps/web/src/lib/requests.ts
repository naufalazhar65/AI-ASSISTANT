// Saved request collections + {{variable}} substitution, for fast replay of
// auth/IDOR sequences. Runs through security.ts `httpRequest`, so the scope
// guard still applies. Per-user store at .data/users/<user>/requests.json.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";
import { httpRequest } from "./security";

export type SavedRequest = { method: string; url: string; headers: Record<string, string>; body?: string; updatedAt: string };
type Store = Record<string, SavedRequest>;

function path(userKey: string): string {
  return join(userDataRoot(), userKey, "requests.json");
}
export function readRequests(rawUser: unknown): Store {
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
  const f = path(userKey);
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, f);
}

export function requestSave(rawUser: unknown, name: string, patch: { method?: string; url?: string; headers?: Record<string, string>; body?: string }): SavedRequest {
  const key = (name || "").trim();
  if (!key) throw new Error("nama request wajib");
  const store = readRequests(rawUser);
  const prev = store[key] || { method: "GET", url: "", headers: {}, body: "", updatedAt: "" };
  const next: SavedRequest = {
    method: (patch.method || prev.method || "GET").toUpperCase(),
    url: patch.url || prev.url,
    headers: { ...prev.headers, ...(patch.headers || {}) },
    body: patch.body !== undefined ? patch.body : prev.body,
    updatedAt: new Date().toISOString(),
  };
  store[key] = next;
  write(rawUser, store);
  return next;
}
export function requestDelete(rawUser: unknown, name: string): boolean {
  const store = readRequests(rawUser);
  if (!(name in store)) return false;
  delete store[name];
  write(rawUser, store);
  return true;
}
export function requestListText(rawUser: unknown): string {
  const entries = Object.entries(readRequests(rawUser));
  if (!entries.length) return "Belum ada request tersimpan. Buat: request_save action=set name=login method=POST url={{base}}/login ...";
  return `🗂️ Request tersimpan (${entries.length}):\n${entries.map(([n, r]) => `• ${n} — ${r.method} ${r.url}${Object.keys(r.headers).length ? ` [${Object.keys(r.headers).join(",")}]` : ""}`).join("\n")}\n\nJalankan: request_run name=<n> vars={"base":"https://app.x","tokenA":"..."}`;
}

/** Replace `{{name}}` with vars[key] (unknown vars are left intact so they're visible). */
export function substituteVars(template: string, vars: Record<string, string>): string {
  return (template || "").replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, k: string) => vars[k] ?? `{{${k}}}`);
}

export async function requestRun(
  rawUser: unknown,
  name: string,
  opts: { vars?: Record<string, string>; method?: string; url?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<string> {
  const req = readRequests(rawUser)[(name || "").trim()];
  if (!req) return `Error: request "${name}" tidak ada — lihat request_save action=list.`;
  const vars = opts.vars || {};
  const merged = { ...req.headers, ...(opts.headers || {}) };
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) headers[k] = substituteVars(v, vars);
  return httpRequest(
    {
      url: substituteVars(opts.url || req.url, vars),
      method: opts.method || req.method,
      headers,
      body: substituteVars(opts.body !== undefined ? opts.body : req.body || "", vars),
    },
    rawUser
  );
}
