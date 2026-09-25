// paramMiner.ts — unkeyed parameter / hidden header discovery (write/confirm
// tool `param_miner`; Param-Miner-style, CWE-471/232-288 family). Discovers
// inputs that CHANGE server behavior but never appear in the URL/body:
//
//   • hidden query params  (debug, admin, internal flags)
//   • hidden headers       (routing/debug/migratION headers: X-Forwarded-*,
//                           X-Original-URL, X-Debug, X-Remote-Addr, …)
//   • their cache impact   (a param that changes the response on a cacheable
//                           page is unkeying material — the bridge to
//                           web-cache-poisoning, reported as a pointer only)
//
// Method (deterministic, honest): baseline pair → for each candidate, replay
// the EXACT request with exactly one added candidate → a candidate is a HIT
// only when the response differs from the pair in a way the pair's own jitter
// never did (status change, header change, or body delta > threshold). A hit
// is a LEAD (meaning depends on semantics — never auto-claimed as vuln).
// Scope-gated, bounded ≤26 requests, politeDelay, recordHttp, session.
import { targetAllowed, politeDelay } from "./security";
import { recordHttp } from "./httpHistory";
import { sessionHeaders } from "./httpSession";

const UA = "mia-assistant/1.0";
const BODY_BUDGET = 16_000;
const MAX_REQ = 26;

/** Candidate hidden params (server-behavior-shaped, not framework noise). */
export const CANDIDATE_PARAMS = [
  "debug", "test", "admin", "internal", "audit", "impersonate", "as_user",
  "preview", "draft", "render", "trace", "verbose", "source", "is_admin",
  "role", "debugger", "xdebug", "mock", "bypass",
];

/** Candidate hidden headers (routing/debug/infra surface). */
export const CANDIDATE_HEADERS = [
  "x-debug", "x-forwarded-host", "x-original-url", "x-rewrite-url",
  "x-http-method-override", "x-remote-addr", "x-forwarded-for",
  "x-w forwarded", "x-migrate", "x-debug-token",
];

const BODY_DELTA = 60;

/** Normalize a body for comparison (drop volatile bits). Pure — tested. */
export function normalizeBody(body: string): string {
  return (body || "")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "UUID")
    .replace(/\b\d{10,13}\b/g, "TS")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Differential verdict for one candidate. Pure — tested.
 * A hit requires the candidate response to differ from BOTH baseline
 * responses in the same direction the baselines never differed.
 */
export function diffVerdict(
  bA: { status: number; body: string; headers: Record<string, string> },
  bB: { status: number; body: string; headers: Record<string, string> },
  cand: { status: number; body: string; headers: Record<string, string> }
): { lead: boolean; reason: string } {
  const baseStatusChanged = bA.status !== cand.status && bB.status !== cand.status;
  if (baseStatusChanged) return { lead: true, reason: `status ${bA.status}→${cand.status}` };
  const nA = normalizeBody(bA.body);
  const nB = normalizeBody(bB.body);
  const nC = normalizeBody(cand.body);
  const basePairDelta = Math.abs(nA.length - nB.length);
  const candDeltaA = Math.abs(nA.length - nC.length);
  const candDeltaB = Math.abs(nB.length - nC.length);
  if (candDeltaA > BODY_DELTA && candDeltaB > BODY_DELTA && Math.min(candDeltaA, candDeltaB) > basePairDelta * 2) {
    return { lead: true, reason: `body berubah ${Math.min(candDeltaA, candDeltaB)} byte (baseline jitter ${basePairDelta} byte)` };
  }
  // New/changed notable header on the candidate only.
  for (const h of ["content-type", "location", "set-cookie", "x-debug", "warning"]) {
    const inA = bA.headers[h]; const inB = bB.headers[h]; const inC = cand.headers[h];
    if (inC && inC !== inA && inC !== inB && !inA && !inB) return { lead: true, reason: `header ${h} muncul baru` };
  }
  return { lead: false, reason: "identik dengan baseline" };
}

/** Build the probe URL for a candidate param. Pure. */
export function withParam(base: URL, name: string, value: string): string {
  const u = new URL(base.toString());
  u.searchParams.set(name, value);
  return u.toString();
}

async function send(
  url: string,
  extraHeaders: Record<string, string> | undefined,
  session: string | undefined,
  rawUser: unknown
): Promise<{ status: number; body: string; headers: Record<string, string>; ms: number; error?: string }> {
  const headers: Record<string, string> = { "User-Agent": UA };
  if (session && rawUser) {
    const s = sessionHeaders(rawUser, session);
    if (s) {
      Object.assign(headers, s.headers);
      if (s.cookie && !Object.keys(headers).some((k) => k.toLowerCase() === "cookie")) headers.cookie = s.cookie;
    }
  }
  if (extraHeaders) Object.assign(headers, extraHeaders);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(12_000) });
    const hh: Record<string, string> = {};
    res.headers.forEach((v, k) => { hh[k.toLowerCase()] = v; });
    return { status: res.status, body: (await res.text()).slice(0, BODY_BUDGET), headers: hh, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, body: "", headers: {}, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}

export type ParamMinerOpts = {
  url?: string;          // page whose hidden inputs we hunt
  params?: string;       // candidate params override (comma list)
  headers?: string;      // candidate headers override (comma list)
  cache_note?: boolean;  // include the unkeying/cache pointer (default true)
  session?: string;
};

/**
 * Unkeyed param/header discovery. Bounded ≤26 requests, honest leads.
 */
export async function paramMiner(rawUser: unknown, opts: ParamMinerOpts = {}): Promise<string> {
  const raw = String(opts.url || "").trim();
  if (!/^https?:\/\//i.test(raw)) return "Error: url harus http(s).";
  if (!targetAllowed(raw)) return "Error: SCOPE — param_miner hanya untuk lab / engagement aktif / PENTEST_LAB_TARGETS.";
  let base: URL;
  try { base = new URL(raw); } catch { return "Error: URL tidak valid."; }
  const session = typeof opts.session === "string" && opts.session ? opts.session : undefined;

  const paramList = [...new Set((String(opts.params || "").split(",").map((s) => s.trim()).filter(Boolean).length
    ? String(opts.params).split(",").map((s) => s.trim()).filter(Boolean)
    : CANDIDATE_PARAMS))].slice(0, 12);
  const headerList = [...new Set((String(opts.headers || "").split(",").map((s) => s.trim()).filter(Boolean).length
    ? String(opts.headers).split(",").map((s) => s.trim()).filter(Boolean)
    : CANDIDATE_HEADERS))].slice(0, 10);

  // ---- Baseline pair (jitter + self-noise measurement). ----
  await politeDelay();
  const bA = await send(base.toString(), undefined, session, rawUser);
  recordHttp(rawUser, { method: "GET", url: base.toString(), status: bA.status, bytes: bA.body.length, ms: bA.ms, at: new Date().toISOString() });
  await politeDelay();
  const bB = await send(base.toString(), undefined, session, rawUser);
  recordHttp(rawUser, { method: "GET", url: base.toString(), status: bB.status, bytes: bB.body.length, ms: bB.ms, at: new Date().toISOString() });
  if (bA.error || bB.error || bA.status === 0 || bB.status === 0) {
    return `Error: baseline gagal jaringan (${bA.error || bB.error || "no status"}) — target down / salah endpoint.`;
  }
  let used = 2;
  const paramHits: Array<{ name: string; reason: string }> = [];
  const headerHits: Array<{ name: string; reason: string }> = [];

  // ---- Hidden params ----
  for (const p of paramList) {
    if (used >= MAX_REQ) break;
    await politeDelay();
    const url = withParam(base, p, "mia-probe-1");
    const c = await send(url, undefined, session, rawUser);
    used++;
    recordHttp(rawUser, { method: "GET", url, status: c.status, bytes: c.body.length, ms: c.ms, at: new Date().toISOString() });
    if (c.error || c.status === 0) continue;
    const v = diffVerdict(bA, bB, c);
    if (v.lead) paramHits.push({ name: p, reason: v.reason });
  }

  // ---- Hidden headers (value mirroring the host; benign sentinel) ----
  for (const h of headerList) {
    if (used >= MAX_REQ) break;
    await politeDelay();
    const hv = h.includes("forwarded-for") || h.includes("remote-addr") ? "127.0.0.1" : "mia-probe-1";
    const c = await send(base.toString(), { [h]: hv }, session, rawUser);
    used++;
    recordHttp(rawUser, { method: "GET", url: base.toString(), status: c.status, bytes: c.body.length, ms: c.ms, at: new Date().toISOString() });
    if (c.error || c.status === 0) continue;
    const v = diffVerdict(bA, bB, c);
    if (v.lead) headerHits.push({ name: h, reason: v.reason });
  }

  const head = `⛏️ PARAM MINER ${base.origin}${base.pathname} — ${used} request (budget ${MAX_REQ}), ${paramHits.length} param + ${headerHits.length} header hidup.`;
  const lines = [
    ...paramHits.map((h) => `• PARAM "${h.name}": ${h.reason} → uji nilai bermakna (debug flags/role/internal routes)`),
    ...headerHits.map((h) => `• HEADER "${h.name}": ${h.reason} → uji routing/poisoning (X-Original-URL → bypass403; X-Forwarded-Host → cache_poison)`),
  ];
  const cacheNote = (paramHits.length || headerHits.length) && opts.cache_note !== false
    ? "\n\n🌐 CACHE: bila halaman ini cacheable dan kandidat mengubah respons TANPA masuk cache-key → material web-cache unkeying; lanjutkan via cache_poison_prover untuk membuktikan."
    : "";
  const tail = lines.length
    ? `⚠️ LEAD ≠ vuln — makna tiap kandidat diuji manual/lewat tool spesifiknya sebelum poc_verify → finding_add.`
    : `Tidak ada kandidat yang mengubah respons dalam budget. (Negatif ≠ aman — wordlist lebih besar / authenticated page bisa berbeda.)`;
  return [head, "", ...lines, cacheNote, tail].filter(Boolean).join("\n");
}
