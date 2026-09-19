// Role/Permission Matrix — upgrade of the two-session bola_diff to a full
// N-role authorization matrix. Give Mia a set of named http_sessions, one
// representative endpoint per check, and it iterates EVERY session (plus an
// anonymous no-session control) against each endpoint, diffs the outcomes,
// and flags cross-role access that should not exist.
//
// Scope-gated per request (targetAllowed). Bounded (≤6 sessions, ≤6 endpoints,
// 1 request per pair). Store: none — stateless run; results feed finding_add.
//
// Pure helpers (parseSpec, verdicts) are exported for unit tests.

import { targetAllowed } from "./security";
import { sessionHeaders, readSessions } from "./httpSession";

const UA = "mia-assistant/1.0";
const MAX_SESSIONS = 6;
const MAX_ENDPOINTS = 6;
const MAX_BODY = 60_000;

export type MatrixRow = {
  endpoint: string;
  session: string; // "" = anonymous
  status: number;
  len: number;
  digest: string;
  error?: string;
};

export type MatrixSpec = {
  endpoints: string[];
  sessions: string[];
  /** statuses that count as "access granted" (default: <400) */
  grantedStatusMax?: number;
};

/** Parse `sessions=a,b,c` / `endpoints=u1,u2` args into a validated spec. Pure — tested. */
export function parseMatrixSpec(input: { endpoints?: unknown; sessions?: unknown; granted_status_max?: unknown }): { ok: true; spec: MatrixSpec } | { ok: false; error: string } {
  const toList = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.map((x) => String(x).trim()).filter(Boolean)
      : typeof v === "string"
        ? v.split(/[,;]+/).map((s) => s.trim()).filter(Boolean)
        : [];
  const endpoints = [...new Set(toList(input.endpoints))].slice(0, MAX_ENDPOINTS);
  const sessions = [...new Set(toList(input.sessions))].slice(0, MAX_SESSIONS);
  if (!endpoints.length) return { ok: false, error: "endpoints wajib (mis. endpoints=/api/dokumen?id=1,/api/admin — koma untuk banyak)" };
  if (!sessions.length) return { ok: false, error: "sessions wajib (mis. sessions=guest,user,admin — koma untuk banyak; anonymous otomatis ditambahkan)" };
  const granted = input.granted_status_max === undefined ? 399 : Number(input.granted_status_max);
  if (!Number.isFinite(granted) || granted < 100 || granted > 599) return { ok: false, error: "granted_status_max harus 100-599" };
  return { ok: true, spec: { endpoints, sessions, grantedStatusMax: granted } };
}

/** Does a row's outcome count as "granted access"? Pure — tested. */
export function matrixGranted(row: Pick<MatrixRow, "status" | "error">, grantedMax: number): boolean {
  if (row.error) return false;
  return row.status > 0 && row.status <= grantedMax;
}

/**
 * Compare two responses for "same data" (status equal-granted + similar body).
 * Pure — tested.
 */
export function matrixSame(a: Pick<MatrixRow, "status" | "len" | "digest">, b: Pick<MatrixRow, "status" | "len" | "digest">): boolean {
  return a.status === b.status && Math.abs(a.len - b.len) <= Math.max(64, Math.floor(Math.max(a.len, b.len) * 0.05));
}

type Fetcher = (url: string, headers: Record<string, string>) => Promise<{ status: number; body: string; error?: string }>;

async function defaultFetcher(url: string, headers: Record<string, string>): Promise<{ status: number; body: string; error?: string }> {
  try {
    const res = await fetch(url, { method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(12_000) });
    const body = (await res.text()).slice(0, MAX_BODY);
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: "", error: e instanceof Error ? e.message : String(e) };
  }
}

function digestOf(body: string): string {
  // Cheap stable digest for same-data comparison (length + sampled chars).
  const sampled = body.slice(0, 2000) + body.slice(-500);
  let h = 0;
  for (let i = 0; i < sampled.length; i++) h = (h * 31 + sampled.charCodeAt(i)) | 0;
  return `${body.length}:${h}`;
}

export type MatrixFinding = {
  endpoint: string;
  kind: "cross-role" | "anonymous-access" | "uniform";
  detail: string;
  severity: string;
};

/**
 * Decide findings from the matrix. Pure — unit-tested.
 * - anonymous-access: anonymous was granted on an endpoint where any named
 *   session exists (named roles imply it's meant to be protected).
 * - cross-role: a LOW-privilege session got the same granted response as a
 *   HIGHER one (first session in the list = most privileged by convention).
 */
export function matrixFindings(spec: MatrixSpec, rows: MatrixRow[]): MatrixFinding[] {
  const out: MatrixFinding[] = [];
  const grantedMax = spec.grantedStatusMax ?? 399;
  for (const ep of spec.endpoints) {
    const epRows = rows.filter((r) => r.endpoint === ep);
    const anon = epRows.find((r) => r.session === "");
    const named = epRows.filter((r) => r.session !== "");
    if (anon && matrixGranted(anon, grantedMax) && named.some((r) => !r.error)) {
      out.push({ endpoint: ep, kind: "anonymous-access", detail: `anonymous dapat ${anon.status} tanpa sesi`, severity: "high" });
    }
    // baseline = the most-privileged named session's response (first in list)
    const base = named.find((r) => !r.error && matrixGranted(r, grantedMax));
    if (!base) continue;
    const baseIdx = spec.sessions.indexOf(base.session);
    for (const r of named) {
      if (r === base || r.error) continue;
      const idx = spec.sessions.indexOf(r.session);
      if (idx <= baseIdx) continue; // equal/higher privilege — fine
      if (matrixGranted(r, grantedMax) && matrixSame(base, r)) {
        out.push({ endpoint: ep, kind: "cross-role", detail: `${r.session} (idx ${idx}) melihat respons sama dengan ${base.session} (idx ${baseIdx}) — ${r.status}, ${r.len}b`, severity: "high" });
      }
    }
    if (!out.some((f) => f.endpoint === ep)) {
      out.push({ endpoint: ep, kind: "uniform", detail: "tidak ada akses lintas-role terdeteksi", severity: "info" });
    }
  }
  return out;
}

/** Run the matrix. Returns a report + ready-to-add findings. */
export async function authMatrix(
  rawUser: unknown,
  input: { endpoints?: unknown; sessions?: unknown; granted_status_max?: unknown; base_url?: string }
): Promise<string> {
  const parsed = parseMatrixSpec(input);
  if (!parsed.ok) return `Error: ${parsed.error}`;
  const spec = parsed.spec;

  // Resolve every endpoint to an absolute URL (base_url prefix allowed).
  const urls: { ep: string; url: string }[] = [];
  for (const ep of spec.endpoints) {
    const url = /^https?:\/\//i.test(ep) ? ep : `${(input.base_url || "").replace(/\/+$/, "")}/${ep.replace(/^\/+/, "")}`;
    if (!/^https?:\/\//i.test(url)) return `Error: endpoint "${ep}" bukan URL absolut dan base_url kosong/tidak valid.`;
    if (!targetAllowed(url)) return `Error: SCOPE — ${url} bukan lab/engagement/PENTEST_LAB_TARGETS.`;
    urls.push({ ep, url });
  }

  // Validate sessions exist (fail fast with the store's names).
  const store = readSessions(rawUser);
  for (const s of spec.sessions) {
    if (!(s in store)) return `Error: session "${s}" tidak ada. Simpan dulu via http_session action=set name=${s} ... (yang ada: ${Object.keys(store).join(", ") || "—"})`;
  }

  const rows: MatrixRow[] = [];
  const fetcher: Fetcher = defaultFetcher;
  for (const { ep, url } of urls) {
    // anonymous first
    rows.push({ endpoint: ep, session: "", ...(await (async () => { const r = await fetcher(url, { "User-Agent": UA }); return { status: r.status, len: r.body.length, digest: digestOf(r.body), error: r.error }; })()) });
    for (const s of spec.sessions) {
      const sh = sessionHeaders(rawUser, s);
      const headers: Record<string, string> = { "User-Agent": UA };
      if (sh) {
        Object.assign(headers, sh.headers);
        if (sh.cookie && !Object.keys(headers).some((k) => k.toLowerCase() === "cookie")) headers.cookie = sh.cookie;
      }
      const r = await fetcher(url, headers);
      rows.push({ endpoint: ep, session: s, status: r.status, len: r.body.length, digest: digestOf(r.body), error: r.error });
    }
  }

  const findings = matrixFindings(spec, rows);
  const lines: string[] = [`👥 AUTH MATRIX — ${urls.length} endpoint × ${spec.sessions.length + 1} identitas (incl. anonymous)`];
  lines.push(`\nMatriks (status/len):`);
  for (const ep of spec.endpoints) {
    lines.push(`\n• ${ep}`);
    for (const r of rows.filter((x) => x.endpoint === ep)) {
      const mark = r.error ? `ERR` : matrixGranted(r, spec.grantedStatusMax ?? 399) ? `✅ ${r.status}` : `⛔ ${r.status}`;
      lines.push(`   ${r.session === "" ? "(anonymous)" : r.session.padEnd(12)} ${mark}${r.error ? ` — ${r.error.slice(0, 60)}` : ` — ${r.len}b`}`);
    }
  }
  const actionable = findings.filter((f) => f.kind !== "uniform");
  if (actionable.length) {
    lines.push(`\n🎯 TEMUAN KANDIDAT (verifikasi + poc_verify sebelum finding_add):`);
    for (const f of actionable) lines.push(`• [${f.severity.toUpperCase()}] ${f.kind} ${f.endpoint} — ${f.detail}`);
    lines.push(`\nLanjut: poc_verify per pasangan → finding_add (OWASP A01, CWE-862/639).`);
  } else {
    lines.push(`\n✅ Tidak ada akses lintas-role terdeteksi pada pasangan yang diuji.`);
  }
  return lines.join("\n");
}
