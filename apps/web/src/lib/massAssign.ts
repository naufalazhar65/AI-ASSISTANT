// massAssign.ts — mass-assignment prover (mass_assignment).
//
// Injects privileged fields (role/admin/verified/user_id/…) into a POST/PUT/
// PATCH body and diffs against the baseline as the SAME low-priv session:
//  - ECHO: injected value reflected in the response (candidate);
//  - ACCEPTED-DIFF: status/digest differs meaningfully from baseline;
//  - optional verify_url GET afterwards to confirm persisted elevation
//    (strongest signal: /me/profile shows the new role).
// No diff / rejected / error → honest negative. Sinyal ≠ vuln: confirm with
// `poc_verify` → `finding_add`. Scope-gated, bounded, session-safe.
// Write — confirm.

import { targetAllowed, politeDelay } from "./security";
import { sessionHeaders } from "./httpSession";

export type MassVerdict = "ECHO" | "ACCEPTED-DIFF" | "NO-DIFF" | "REJECTED" | "ERROR";

/** Privileged field injections tried in order (bounded). Pure data. */
export function massPayloads(): Array<{ field: string; values: string[] }> {
  return [
    { field: "role", values: ["admin", "administrator"] },
    { field: "is_admin", values: ["true"] },
    { field: "admin", values: ["true", "1"] },
    { field: "verified", values: ["true"] },
    { field: "email_verified", values: ["true"] },
    { field: "user_id", values: ["1"] },
    { field: "account_type", values: ["admin"] },
  ];
}

export type MassRun = { status: number; digest: string; body: string };

/** Merge extra fields into a JSON body string (falls back to form-encoding). Pure. */
export function bodyWithFields(base: string, extra: Record<string, string>): { body: string; contentType: string } {
  try {
    const obj = JSON.parse(base || "{}");
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return { body: JSON.stringify({ ...(obj as Record<string, unknown>), ...extra }), contentType: "application/json" };
    }
  } catch { /* fall through to form */ }
  const params = new URLSearchParams(base || "");
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  return { body: params.toString(), contentType: "application/x-www-form-urlencoded" };
}

/**
 * Verdict for one injected field: baseline vs test run. Pure.
 * ECHO (value reflected) outranks ACCEPTED-DIFF (outcome changed silently).
 */
export function massVerdict(base: MassRun, test: MassRun, field: string, value: string): { verdict: MassVerdict; note: string } {
  if (test.status === 0) return { verdict: "ERROR", note: `${field}=${value}: request gagal (network)` };
  if (test.status === 401 || test.status === 403) return { verdict: "REJECTED", note: `${field}=${value}: ditolak (${test.status}) — terkontrol` };
  if (test.status >= 400) return { verdict: "REJECTED", note: `${field}=${value}: ditolak (${test.status})` };
  if (test.body.includes(value) && !base.body.includes(value)) {
    return { verdict: "ECHO", note: `${field}=${value}: nilai ter-reflect di respons (${test.status}) — kandidat mass assignment` };
  }
  if (test.status === base.status && test.digest === base.digest) {
    return { verdict: "NO-DIFF", note: `${field}=${value}: respons identik baseline (${test.status}) — field diabaikan` };
  }
  return { verdict: "ACCEPTED-DIFF", note: `${field}=${value}: outcome berubah (${base.status}→${test.status}, digest beda) — kandidat, verifikasi persistensi` };
}

export type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; body: string }>;

function digest(s: string): string {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h1 ^= s.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return h1.toString(16);
}

async function defaultFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> {
  try {
    const res = await fetch(url, {
      method: init.method || "GET",
      headers: { "User-Agent": "mia-assistant/1.0", ...(init.headers || {}) },
      body: init.method && init.method !== "GET" && init.method !== "HEAD" ? init.body : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(12_000),
    });
    return { status: res.status, body: (await res.text()).slice(0, 12_000) };
  } catch {
    return { status: 0, body: "" };
  }
}

/**
 * Prove mass assignment on an endpoint. Scope-gated, bounded (≤7 fields,
 * ≤2 requests each + optional verify GET).
 */
export async function massAssign(
  rawUser: unknown,
  opts: { url?: string; method?: string; body?: string; session?: string; fields?: string[]; verify_url?: string; fetchFn?: FetchFn } = {}
): Promise<string> {
  const raw = String(opts.url || "").trim();
  if (!/^https?:\/\//i.test(raw)) return "Error: url harus http(s).";
  if (!targetAllowed(raw)) return "Error: SCOPE — mass_assignment hanya untuk lab / engagement aktif.";
  const method = (opts.method || "POST").toUpperCase();
  if (!["POST", "PUT", "PATCH"].includes(method)) return "Error: method harus POST/PUT/PATCH.";
  const fetchFn = opts.fetchFn || defaultFetch;
  const sess = opts.session ? sessionHeaders(rawUser, opts.session) : null;
  if (opts.session && !sess) return `Error: session "${opts.session}" tidak dikenal (buat via http_session / auth_setup / har_import).`;
  const headers: Record<string, string> = { ...(sess?.headers || {}) };
  if (sess?.cookie) headers["cookie"] = sess.cookie;
  const verifyUrl = String(opts.verify_url || "").trim();
  if (verifyUrl && (!/^https?:\/\//i.test(verifyUrl) || !targetAllowed(verifyUrl))) {
    return "Error: SCOPE — verify_url di luar izin.";
  }

  const run = async (body: string, ct: string) => {
    await politeDelay();
    const r = await fetchFn(raw, { method, headers: { ...headers, "Content-Type": ct }, body });
    return { status: r.status, digest: digest(r.body), body: r.body.slice(0, 2000) };
  };

  const lines: string[] = [`💉 MASS ASSIGNMENT ${method} ${raw}${opts.session ? ` (session ${opts.session})` : ""}`];
  const bb = bodyWithFields(String(opts.body || ""), {});
  const baseProf = await run(bb.body, bb.contentType);
  if (baseProf.status === 0) return lines.concat("Error: baseline tidak terjangkau.").join("\n");
  lines.push(`Baseline: ${baseProf.status} (digest ${baseProf.digest}).`);

  const wanted = Array.isArray(opts.fields) && opts.fields.length
    ? massPayloads().filter((p) => (opts.fields as string[]).includes(p.field))
    : massPayloads();
  if (!wanted.length) return lines.concat("Error: tidak ada field dikenal yang diminta.").join("\n");
  let hits = 0;
  for (const p of wanted) {
    for (const value of p.values) {
      const t = bodyWithFields(String(opts.body || ""), { [p.field]: value });
      const test = await run(t.body, t.contentType);
      const v = massVerdict(
        { status: baseProf.status, digest: baseProf.digest, body: baseProf.body },
        { status: test.status, digest: test.digest, body: test.body },
        p.field, value
      );
      let line = `• ${v.note}`;
      if (v.verdict === "ECHO" || v.verdict === "ACCEPTED-DIFF") {
        hits++;
        line = `• 🚨 ${v.note}`;
        if (verifyUrl) {
          try {
            await politeDelay();
            const vr = await fetchFn(verifyUrl, { headers });
            const persisted = vr.body.includes(value);
            line += persisted
              ? `\n   ↳ TERKONFIRMASI PERSISTEN di ${verifyUrl} (nilai "${value}" terbaca kembali) — temuan kuat.`
              : `\n   ↳ tidak persist di ${verifyUrl} (cek manual — bisa refleksi sesaat).`;
          } catch {
            line += `\n   ↳ verify gagal dijangkau — cek manual.`;
          }
        }
      }
      lines.push(line);
    }
  }
  lines.push("");
  lines.push(hits ? `⚠️ ${hits} kandidat mass assignment — konfirmasi persistensi + \`poc_verify\` → \`finding_add\`.` : "Tidak ada kandidat (semua ditolak/diabaikan).");
  return lines.join("\n");
}
