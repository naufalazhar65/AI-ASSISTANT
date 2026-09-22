// har_import — turn a HAR export (Chrome/Firefox DevTools → "Save all as HAR")
// into pentest-ready material: endpoint inventory, query-param names, a cookie
// union saved as a named http_session (intended credential store), and an
// Authorization/auth-header presence report. Secret VALUES are never printed —
// only names/counts. Parsing is pure; only save_session touches the store.
import { setSession } from "./httpSession";

export type HarEntry = {
  method: string;
  url: string;
  host: string;
  path: string;
  status: number;
  reqHeaders: Record<string, string>;
  params: string[];
  cookies: [string, string][];
  setCookies: string[];
};

/** Parse a HAR JSON string into normalized entries. Pure — unit-tested. */
export function parseHarEntries(text: string): HarEntry[] {
  let j: unknown;
  try { j = JSON.parse(text); } catch { return []; }
  const entries = (j as { log?: { entries?: unknown[] } })?.log?.entries;
  if (!Array.isArray(entries)) return [];
  const out: HarEntry[] = [];
  for (const e of entries) {
    const r = e as {
      request?: { method?: string; url?: string; headers?: { name: string; value: string }[]; queryString?: { name: string; value: string }[]; cookies?: { name: string; value: string }[] };
      response?: { status?: number; headers?: { name: string; value: string }[] };
    };
    const req = r.request;
    if (!req?.url || !req.method) continue;
    const reqHeaders: Record<string, string> = {};
    // Malformed entries are skipped, never fatal (audit 2026-09-23).
    for (const h of req.headers || []) {
      if (!h || typeof h.name !== "string") continue;
      reqHeaders[h.name.toLowerCase()] = typeof h.value === "string" ? h.value : "";
    }
    const setCookies: string[] = (r.response?.headers || []).filter((h) => h && typeof h.name === "string" && h.name.toLowerCase() === "set-cookie").map((h) => h.value);
    const params = (req.queryString || []).map((q) => q && q.name).filter(Boolean);
    let host = ""; let path = "";
    try { const u = new URL(req.url); host = u.host; path = u.pathname; } catch { continue; }
    out.push({
      method: req.method.toUpperCase(), url: req.url, host, path, status: r.response?.status || 0,
      reqHeaders, params, cookies: (req.cookies || []).filter((c) => c && typeof c.name === "string").map((c) => [c.name, typeof c.value === "string" ? c.value : ""] as [string, string]),
      setCookies,
    });
  }
  return out;
}

/** Distinct method+host+path summary lines (bounded). Pure. */
export function harEndpointSummary(entries: HarEntry[], limit = 40): string[] {
  const seen = new Map<string, { n: number; status: number }>();
  for (const e of entries) {
    const k = `${e.method} ${e.host}${e.path}`;
    const prev = seen.get(k);
    seen.set(k, { n: (prev?.n || 0) + 1, status: prev?.status || e.status });
  }
  return [...seen.entries()].slice(0, limit).map(([k, v]) => `• ${k}${v.status ? ` (${v.status})` : ""}${v.n > 1 ? ` ×${v.n}` : ""}`);
}

/** Param-name frequency (top N). Pure. */
export function harParamNames(entries: HarEntry[], limit = 25): [string, number][] {
  const freq = new Map<string, number>();
  for (const e of entries) for (const p of e.params) freq.set(p, (freq.get(p) || 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

/** Union of request cookies for one host. Pure. */
export function harCookieUnion(entries: HarEntry[], host: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of entries) {
    if (e.host !== host) continue;
    for (const [k, v] of e.cookies) if (!(k in out) && v) out[k] = v;
    for (const sc of e.setCookies) {
      const kv = sc.split(";")[0];
      const i = kv.indexOf("=");
      if (i > 0) { const k = kv.slice(0, i).trim(); if (!(k in out)) out[k] = kv.slice(i + 1).trim(); }
    }
  }
  return out;
}

/** Auth-relevant request headers present (names + presence only). Pure. */
export function harAuthHeaders(entries: HarEntry[]): string[] {
  const found = new Map<string, string>();
  for (const e of entries) {
    for (const [k, v] of Object.entries(e.reqHeaders)) {
      if (!["authorization", "cookie", "x-api-key", "x-auth-token", "x-csrf-token"].includes(k)) continue;
      // Presence + length only — zero value chars (audit 2026-09-23: an 8-char
      // token prefix is a real partial leak into chat/audit/memory).
      const masked = `present (${v.length}c)`;
      if (!found.has(k)) found.set(k, masked);
    }
  }
  return [...found.entries()].map(([k, v]) => `• ${k}: ${v}`);
}

export async function harImport(rawUser: unknown, opts: { text: string; save_session?: string; host?: string }): Promise<string> {
  const raw = opts.text || "";
  // Input cap (audit 2026-09-23): a multi-MB paste would blow memory/context.
  const MAX_HAR_CHARS = 2_000_000;
  const clipped = raw.length > MAX_HAR_CHARS;
  const entries = parseHarEntries(clipped ? raw.slice(0, MAX_HAR_CHARS) : raw);
  if (!entries.length) return "Error: HAR tidak terbaca. Export via DevTools → Network → klik kanan → 'Save all as HAR' lalu tempel isinya.";
  const hosts = [...new Set(entries.map((e) => e.host))];
  const hostSel = opts.host && hosts.includes(opts.host) ? opts.host : hosts[0];
  const eps = harEndpointSummary(entries);
  const params = harParamNames(entries);
  const auth = harAuthHeaders(entries);
  const cookies = harCookieUnion(entries, hostSel);
  const lines: string[] = [
    `🧾 HAR IMPORT — ${entries.length} entri, ${hosts.length} host (${hosts.slice(0, 6).join(", ")}${hosts.length > 6 ? " …" : ""})${clipped ? " — input dipotong 2MB (paste terlalu besar)" : ""}`,
    `\nEndpoint (${Math.min(eps.length, 40)}/${new Set(entries.map((e) => `${e.method} ${e.host}${e.path}`)).size}):`,
    ...eps,
  ];
  if (params.length) lines.push(`\nParam terbanyak: ${params.map(([p, n]) => `${p}×${n}`).join(", ")}`);
  if (auth.length) lines.push(`\nHeader auth terdeteksi (nilai dimask):\n${auth.join("\n")}`);
  const cookieNames = Object.keys(cookies);
  let saved = "";
  if (opts.save_session) {
    const authHeader: Record<string, string> = {};
    const a = entries.find((e) => e.host === hostSel && e.reqHeaders.authorization);
    if (a) authHeader["Authorization"] = a.reqHeaders.authorization;
    setSession(rawUser, opts.save_session, { cookies, headers: authHeader });
    saved = `\n\n🔑 Session "${opts.save_session}" tersimpan (${cookieNames.length} cookie${Object.keys(authHeader).length ? " + Authorization" : ""}) — pakai via http_request session=${opts.save_session} / bola_diff / auth_matrix.`;
  } else if (cookieNames.length) {
    saved = `\n\nℹ️ ${cookieNames.length} cookie host ${hostSel} bisa disimpan: panggil ulang dengan save_session=<nama>.`;
  }
  lines.push(`${saved}\n\nLanjut: param → param_fuzz; endpoint ber-ID → bola_diff; endpoint API → api_hunt. Nilai kredensial TIDAK pernah dicetak.`);
  return lines.join("\n");
}
