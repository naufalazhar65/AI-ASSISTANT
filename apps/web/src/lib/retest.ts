// Regression Retest Suite — every proven finding becomes a SAVED retest case
// (request + assertion of the VULNERABLE signature), so "sudah dipatch belum?"
// is one command instead of a manual re-hunt. finding_add auto-creates a case
// when retest_* args are supplied; retest_add adds/edits cases manually.
//
// Verdict per case:
//   🔴 STILL VULNERABLE — the response still matches the vulnerable signature
//   🟢 PATCHED          — the response no longer matches (control expected)
//   ⚪ ERROR            — request failed (network/scope/session)
//
// Scope-gated per case URL (targetAllowed). Store:
// .data/users/<user>/retest.json (atomic, capped). Pure helpers exported for tests.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";
import { targetAllowed } from "./security";
import { sessionHeaders } from "./httpSession";

export type RetestCase = {
  id: string;
  title: string;
  target: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  session?: string;
  /** signature of the VULNERABLE response (substring, case-insensitive) */
  expect_contains: string;
  /** status the VULNERABLE response had (0 = ignore) */
  expect_status: number;
  findingId?: string;
  severity: string;
  createdAt: string;
  lastRunAt?: string;
  lastVerdict?: "vulnerable" | "patched" | "error";
};

const MAX_CASES = 120;
const UA = "mia-assistant/1.0";

function storePath(rawUser: unknown): string {
  const user = sanitizeUser(rawUser) ?? "shared";
  return join(userDataRoot(), user, "retest.json");
}

function read(rawUser: unknown): RetestCase[] {
  try {
    const p = storePath(rawUser);
    if (!existsSync(p)) return [];
    const j = JSON.parse(readFileSync(p, "utf8")) as unknown;
    return Array.isArray(j) ? (j as RetestCase[]).filter((c) => c && typeof c.url === "string") : [];
  } catch {
    return [];
  }
}

function write(rawUser: unknown, cases: RetestCase[]): void {
  const p = storePath(rawUser);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(cases.slice(0, MAX_CASES), null, 2));
  renameSync(tmp, p);
}

/** New id from title+url (stable-ish, short). Pure — tested. */
export function retestCaseId(title: string, url: string): string {
  const base = `${title}|${url}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `R-${base || "case"}`;
}

/** Host key of a case URL (for grouping). Pure — tested. */
export function retestHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Create or update one case. Returns the saved case. */
export function retestSave(
  rawUser: unknown,
  input: {
    title: string;
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    session?: string;
    expect_contains?: string;
    expect_status?: number;
    findingId?: string;
    severity?: string;
  }
): RetestCase {
  const url = (input.url || "").trim();
  if (!/^https?:\/\//i.test(url)) throw new Error("url harus http(s)");
  const title = (input.title || "").trim().slice(0, 200) || "Retest case";
  const id = retestCaseId(title, url);
  const cases = read(rawUser);
  const prev = cases.find((c) => c.id === id);
  const row: RetestCase = {
    id,
    title,
    target: retestHost(url),
    method: (input.method || "GET").toUpperCase(),
    url,
    headers: input.headers || {},
    body: (input.body || "").slice(0, 4000),
    session: input.session,
    expect_contains: (input.expect_contains || "").slice(0, 300),
    expect_status: Math.max(0, Math.min(599, Number(input.expect_status) || 0)),
    findingId: input.findingId,
    severity: (input.severity || "medium").slice(0, 20),
    createdAt: prev?.createdAt || new Date().toISOString(),
    lastRunAt: prev?.lastRunAt,
    lastVerdict: prev?.lastVerdict,
  };
  const next = [row, ...cases.filter((c) => c.id !== id)].slice(0, MAX_CASES);
  write(rawUser, next);
  return row;
}

export function retestDelete(rawUser: unknown, id: string): boolean {
  const cases = read(rawUser);
  const next = cases.filter((c) => c.id !== id);
  if (next.length === cases.length) return false;
  write(rawUser, next);
  return true;
}

export function retestListText(rawUser: unknown, opts: { target?: string } = {}): string {
  let cases = read(rawUser);
  if (opts.target) {
    const host = opts.target.toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
    cases = cases.filter((c) => c.target === host || c.target.endsWith(`.${host}`));
  }
  if (!cases.length) return "Belum ada retest case. Case dibuat otomatis saat finding_add dengan retest_url+retest_expect, atau manual via retest_add.";
  const icon = (v?: string) => (v === "vulnerable" ? "🔴" : v === "patched" ? "🟢" : v === "error" ? "⚪" : "▫️");
  return `♻️ Retest cases (${cases.length}):\n${cases
    .map((c) => `${icon(c.lastVerdict)} ${c.id} [${c.severity}] ${c.title}\n   ${c.method} ${c.url}${c.expect_contains ? `\n   expect: ${c.expect_contains.slice(0, 80)}` : ""}${c.expect_status ? ` status=${c.expect_status}` : ""}${c.lastVerdict ? `\n   last: ${c.lastVerdict} @ ${(c.lastRunAt || "").slice(0, 19)}` : ""}`)
    .join("\n")}`;
}

type RunResult = { status: number; body: string; error?: string };

async function runOnce(rawUser: unknown, c: RetestCase): Promise<RunResult> {
  const headers: Record<string, string> = { "User-Agent": UA, ...c.headers };
  if (c.session) {
    const s = sessionHeaders(rawUser, c.session);
    if (!s) return { status: 0, body: "", error: `session "${c.session}" tidak ada` };
    Object.assign(headers, s.headers);
    if (s.cookie && !Object.keys(headers).some((k) => k.toLowerCase() === "cookie")) headers.cookie = s.cookie;
  }
  try {
    const res = await fetch(c.url, {
      method: c.method,
      headers,
      body: c.method === "GET" || c.method === "HEAD" || !c.body ? undefined : c.body,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.text()).slice(0, 100_000);
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: "", error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Verdict from one response. Pure — unit-tested.
 * vulnerable = still matches the vulnerable signature (status AND/OR contains).
 */
export function retestVerdict(c: Pick<RetestCase, "expect_contains" | "expect_status">, r: RunResult): "vulnerable" | "patched" | "error" {
  if (r.error) return "error";
  const statusOk = !c.expect_status || r.status === c.expect_status;
  const containsOk = !c.expect_contains || r.body.toLowerCase().includes(c.expect_contains.toLowerCase());
  // A case with NO assertion always counts by status: 2xx = still-vulnerable signal.
  const matched = c.expect_contains || c.expect_status ? statusOk && containsOk : r.status >= 200 && r.status < 300;
  return matched ? "vulnerable" : "patched";
}

/** Run one case or every case (optionally filtered by target). */
export async function retestRun(rawUser: unknown, opts: { id?: string; target?: string } = {}): Promise<string> {
  let cases = read(rawUser);
  if (opts.id) cases = cases.filter((c) => c.id === opts.id);
  else if (opts.target) {
    const host = opts.target.toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
    cases = cases.filter((c) => c.target === host || c.target.endsWith(`.${host}`));
  }
  if (!cases.length) return "Tidak ada retest case yang cocok. Lihat daftar: retest_list.";
  const out: string[] = [`♻️ RETEST ${opts.id ? opts.id : opts.target || "SEMUA"} — ${cases.length} case`];
  let vuln = 0;
  let patched = 0;
  let err = 0;
  const all = read(rawUser);
  for (const c of cases.slice(0, 30)) {
    if (!targetAllowed(c.url)) {
      out.push(`⚪ ${c.id} ${c.title} — SCOPE: URL tidak lagi diizinkan (skip)`);
      err++;
      continue;
    }
    const r = await runOnce(rawUser, c);
    const v = retestVerdict(c, r);
    if (v === "vulnerable") {
      vuln++;
      out.push(`🔴 ${c.id} ${c.title} — MASIH RENTAN (${r.status})${r.body && c.expect_contains ? ` — signature ditemukan` : ""}`);
    } else if (v === "patched") {
      patched++;
      out.push(`🟢 ${c.id} ${c.title} — sudah dipatch (status ${r.status})`);
    } else {
      err++;
      out.push(`⚪ ${c.id} ${c.title} — error: ${r.error || `status ${r.status}`}`);
    }
    const row = all.find((x) => x.id === c.id);
    if (row) {
      row.lastRunAt = new Date().toISOString();
      row.lastVerdict = v;
    }
  }
  write(rawUser, all);
  out.push(`\nRingkasan: ${vuln} masih rentan, ${patched} patched, ${err} error/skip.`);
  return out.join("\n");
}
