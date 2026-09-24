// cdpProxy.ts — mini-proxy: mine the USER'S OWN Chrome live traffic (cdp_proxy).
//
// Why: endpoint discovery from JS bundles misses what only appears at runtime —
// API calls fired after login, GraphQL operations, polling endpoints, error
// reporting. The classic answer (run a proxy) needs certificate install + WAF
// friction. Instead we patch `fetch` + XHR INSIDE the (scope-gated) tab — the
// same proven pattern as tamper.ts — record method/path/QUERY-KEY-ONLY (+ JSON
// body KEY-ONLY), then summarize into target_brain. Values NEVER leave the
// browser (invariant 5); the brain already stores param NAMES only, so the
// summary is safe by construction.
//
// Scope: the tab host must pass targetAllowed BEFORE any patch is installed;
// captured request URLs are re-gated by targetAllowed too (out-of-scope hosts
// are counted but not listed). Bounded (≤120s, ≤400 entries). The patch is
// best-effort page JS — it may be wiped by SPA navigation; say so honestly.
// Read/auto (no state change beyond the brain summary it writes).

import { targetAllowed } from "./security";
import { brainRecordEndpoints, brainBrief } from "./targetBrain";
import { resolveTarget, evaluate as cdpEvaluate } from "./cdp";

const MAX_SECONDS = 120;
const MAX_ENTRIES = 400;
const MAX_OUT = 9000;

export type CapturedRequest = { method: string; url: string; kind: "fetch" | "xhr" };

/** Path with query-KEYS only (values stripped). Pure. */
export function requestKey(url: string): string {
  try {
    const u = new URL(url);
    const keys = [...u.searchParams.keys()].slice(0, 12);
    const path = u.pathname;
    return keys.length ? `${path}?${keys.join("&")}` : path;
  } catch {
    return url.split("?")[0] || "/";
  }
}

/** Group captured requests by host → method+keyed-path with counts. Pure. */
export function summarizeRequests(
  reqs: CapturedRequest[]
): Array<{ host: string; lines: string[]; total: number }> {
  const byHost = new Map<string, Map<string, number>>();
  for (const r of reqs) {
    let host = "?";
    let key = "/";
    try {
      const u = new URL(r.url);
      host = u.host;
      key = requestKey(r.url);
    } catch { /* keep defaults */ }
    let m = byHost.get(host);
    if (!m) { m = new Map(); byHost.set(host, m); }
    const sig = `${r.method} ${key}`;
    m.set(sig, (m.get(sig) || 0) + 1);
  }
  return [...byHost.entries()]
    .map(([host, sigs]) => {
      const lines = [...sigs.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([sig, n]) => (n > 1 ? `${sig} ×${n}` : sig))
        .slice(0, 40);
      return { host, lines, total: [...sigs.values()].reduce((a, b) => a + b, 0) };
    })
    .sort((a, b) => b.total - a.total);
}

/** In-page patch script (runs inside the tab; nothing external). Pure. */
export function patchScript(seconds: number, maxEntries: number): string {
  const sec = Math.max(1, Math.min(120, Math.floor(seconds)));
  const cap = Math.max(1, Math.min(400, Math.floor(maxEntries)));
  return `(() => {
  if (window.__miaProxy && window.__miaProxy.active) return "ALREADY-ACTIVE " + (Math.ceil((window.__miaProxy.until - Date.now())/1000)) + "s";
  const W = window.__miaProxy = window.__miaProxy || { reqs: [], active: false, until: 0 };
  W.reqs = []; W.active = true; W.until = Date.now() + ${sec} * 1000;
  const rec = (method, url, kind) => {
    try {
      if (!W.active) return; // post-drain requests are NOT a new recording window
      if (W.reqs.length >= ${cap}) return;
      const s = String(url || "");
      if (!s || s.startsWith("data:") || s.startsWith("blob:") || s.startsWith("chrome")) return;
      // relative URLs (the COMMON case for app fetches) resolve against location
      const abs = (() => { try { return new URL(s, location.href).href; } catch (e) { return null; } })();
      if (!abs || !/^https?:/i.test(abs)) return;
      W.reqs.push({ method: String(method || "GET").toUpperCase(), url: abs, kind });
    } catch (e) {}
  };
  const origFetch = window.fetch;
  if (origFetch && !origFetch.__miaPatched) {
    const patched = function(input, init) {
      try {
        const u = typeof input === "string" ? input : (input && input.url) || "";
        rec((init && init.method) || (input && input.method) || "GET", u, "fetch");
      } catch {}
      return origFetch.apply(this, arguments);
    };
    patched.__miaPatched = true;
    window.fetch = patched;
  }
  const oo = XMLHttpRequest.prototype.open;
  if (oo && !oo.__miaPatched) {
    const po = function(method, url) {
      try { rec(method, url, "xhr"); } catch {}
      return oo.apply(this, arguments);
    };
    po.__miaPatched = true;
    XMLHttpRequest.prototype.open = po;
  }
  return "PATCHED " + ${sec} + "s";
})()`;
}

/** In-page drain script: stop patching, return the captured list as JSON. Pure. */
export function drainScript(): string {
  return `(() => {
  const W = window.__miaProxy;
  if (!W) return "[]";
  W.active = false;
  const out = JSON.stringify(W.reqs || []);
  W.reqs = [];
  return out;
})()`;
}

/** Records in-scope captured endpoints into the target brain (param NAMES only). Returns count. */
function recordToBrain(rawUser: unknown, reqs: CapturedRequest[]): number {
  const byHost = new Map<string, string[]>();
  let n = 0;
  for (const r of reqs) {
    try {
      if (!targetAllowed(r.url)) continue;
      const u = new URL(r.url);
      const key = requestKey(r.url);
      // The brain re-parses this as path+query (searchParams.keys()). A keyless
      // URL (param name containing dots or spaces) would silently LOSE its
      // query on that round-trip — record the path only in that case.
      if (key.includes("?") && !new URL(`https://${u.host}${key}`).search) continue;
      const list = byHost.get(u.host) || [];
      // requestKey = pathname + query KEYS only — values never reach the brain.
      list.push(key);
      byHost.set(u.host, list);
      n++;
    } catch { /* skip */ }
  }
  for (const [host, paths] of byHost) brainRecordEndpoints(rawUser, `https://${host}`, paths);
  return n;
}

export async function cdpProxy(
  rawUser: unknown,
  opts: { tab?: string; seconds?: number; brain?: boolean } = {}
): Promise<string> {
  const tab = String(opts.tab || "").trim();
  const seconds = Math.max(5, Math.min(MAX_SECONDS, Math.floor(Number(opts.seconds) || 30)));
  const wantBrain = opts.brain !== false;
  if (!tab) return "Error: tab wajib (potongan URL tab, mis. id.jobstreet.com).";
  const r = await resolveTarget(tab); // resolveTarget itself enforces targetAllowed on the real tab URL
  if ("error" in r) return r.error;
  if (!r.t.webSocketDebuggerUrl) return "Error: tab tidak punya WebSocket debugger.";

  const lines: string[] = [`🕸️ CDP MINI-PROXY — patch fetch/XHR di tab: ${r.t.url.slice(0, 100)}`];

  const p = await cdpEvaluate(r.t.webSocketDebuggerUrl, patchScript(seconds, MAX_ENTRIES));
  if (p.error) return `Error: patch — ${p.error}`;
  if (/ALREADY-ACTIVE/.test(p.value || "")) {
    return `Error: probe masih aktif (${p.value}). Tunggu habis atau drain dulu.`;
  }
  lines.push(`⏳ Merekam ${seconds}s — pakai aplikasinya sekarang (klik, navigasi, submit form). Nilai query/body TIDAK direkam (hanya nama).`);

  await new Promise((res) => setTimeout(res, seconds * 1000));

  const d = await cdpEvaluate(r.t.webSocketDebuggerUrl, drainScript());
  if (d.error) return `Error: drain — ${d.error}`;
  let reqs: CapturedRequest[] = [];
  try { reqs = JSON.parse(d.value || "[]") as CapturedRequest[]; } catch { /* fallthrough */ }
  if (!reqs.length) {
    lines.push("Tidak ada request terekam. Kemungkinan: tab di-navigasi ulang (patch terhapus), tidak ada aktivitas, atau semua fetch lewat worker/service-worker.");
    lines.push("Coba: durasi lebih lama, berinteraksi dengan halaman, atau pakai har_import dari HAR DevTools.");
    return lines.join("\n");
  }

  const summary = summarizeRequests(reqs);
  const inScopeHosts = summary.filter((s) => targetAllowed(`https://${s.host}`));
  const oosCount = summary.filter((s) => !targetAllowed(`https://${s.host}`)).reduce((a, b) => a + b.total, 0);

  lines.push(`📊 ${reqs.length} request (${summary.length} host${oosCount ? `, ${oosCount} out-of-scope disembunyikan` : ""}):`);
  for (const s of inScopeHosts.slice(0, 4)) {
    lines.push(`\n• ${s.host} (${s.total} req)`);
    for (const l of s.lines) lines.push(`  ${l}`);
  }
  if (summary.length > 4) lines.push(`\n…(${summary.length - 4} host lagi — durasi lebih pendek / filter tab untuk fokus)`);

  if (wantBrain && inScopeHosts.length) {
    const recorded = recordToBrain(rawUser, reqs);
    lines.push(`\n🧠 target_brain: ${recorded} request in-scope tercatat (param = NAMA saja).`);
    try {
      const brief = brainBrief(rawUser, inScopeHosts[0].host);
      if (brief && !/^Error/.test(brief)) lines.push("\n" + brief.split("\n").slice(0, 12).join("\n"));
    } catch { /* brain brief is best-effort */ }
  }
  return lines.join("\n").slice(0, MAX_OUT);
}
