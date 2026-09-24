// blindSsrf.ts — Blind-SSRF via DNS-only callbacks (write/confirm tool `blind_ssrf`).
//
// The existing ssrf chain proves SSRF when the target makes an HTTP call back to
// webhook.site. Targets whose egress allows DNS but blocks HTTP never call back —
// this orchestrator plants PARAM-ATTRIBUTED DNS canaries (subdomain carries the
// param index/name) and reads hits from oastDns (interactsh), so a single poll
// names WHICH parameter fired. Classic blind-SSRF triage, deterministic labels.
//
// Requires `oast_dns_create` (interactsh-client, keyless) — honest install hint
// when missing. Scope-gated via targetAllowed, ≤16 probe requests, polite delay.
// Pure helpers are exported for unit tests. A hit = SINYAL (OOB proof of fetch),
// the model still runs poc_verify before finding_add (CWE-918).
import { targetAllowed, politeDelay } from "./security";
import { recordHttp } from "./httpHistory";
import { sessionHeaders } from "./httpSession";
import { oastDnsCreate, oastDnsPoll } from "./oastDns";

const UA = "mia-assistant/1.0";

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

export const DEFAULT_SSRF_PARAMS = ["url", "uri", "link", "href", "src", "dest", "target", "fetch", "load", "file", "page", "image", "feed", "proxy", "domain", "host", "webhook", "callback"];

/** DNS-safe subdomain label for one param (attributed: index + name). Pure. */
export function ssrfLabel(idx: number, param: string): string {
  const clean = (param || "p").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 24).replace(/^-+|-+$/g, "") || "p";
  return `p${idx}-${clean}`;
}

/** Build the DNS-canary payloads for one param (URL, UNC, bare-host forms). Pure. */
export function ssrfPayloads(idx: number, param: string, oastDomain: string): string[] {
  const label = ssrfLabel(idx, param);
  return [
    `http://${label}.${oastDomain}/x`,
    `\\\\${label}.${oastDomain}\\x`,
    `${label}.${oastDomain}`,
  ];
}

/**
 * Which params fired, parsed from an oastDns poll text. Pure.
 * oastDns prints raw-request/remote lines that include the queried subdomain.
 */
export function attributeHits(pollText: string): Array<{ idx: number; param: string; raw: string }> {
  const out = new Map<number, { idx: number; param: string; raw: string }>();
  const re = /p(\d{1,2})-([a-z0-9-]+)\./gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pollText || "")) !== null) {
    const idx = Number(m[1]);
    const raw = (m[0] || "").replace(/\.$/, "");
    if (!out.has(idx)) out.set(idx, { idx, param: m[2] || "?", raw: raw.slice(0, 80) });
  }
  return [...out.values()].sort((a, b) => a.idx - b.idx);
}

/** GET the target with one param replaced by the payload (bounded body read). */
async function getWith(url: string, param: string, value: string, opts: { session?: string; rawUser?: unknown }): Promise<{ status: number; body: string; error?: string }> {
  const u = new URL(url);
  u.searchParams.set(param, value);
  const headers: Record<string, string> = { "User-Agent": UA };
  if (opts.session && opts.rawUser) {
    const s = sessionHeaders(opts.rawUser, opts.session);
    if (s) {
      Object.assign(headers, s.headers);
      if (s.cookie && !Object.keys(headers).some((k) => k.toLowerCase() === "cookie")) headers.cookie = s.cookie;
    }
  }
  try {
    const res = await fetch(u.toString(), { method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    return { status: res.status, body: (await res.text()).slice(0, 3000) };
  } catch (e) {
    return { status: 0, body: "", error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Runner ──────────────────────────────────────────────────────────────────

export async function blindSsrf(
  rawUser: unknown,
  opts: { url?: string; params?: string; session?: string; seconds?: number }
): Promise<string> {
  const url = (opts.url || "").trim();
  if (!url) return "Error: url wajib (endpoint yang menerima URL/host, mis. https://host/api/fetch?url=…).";
  if (!/^https?:\/\//i.test(url)) return "Error: url harus http(s).";
  if (!targetAllowed(url)) return "Error: SCOPE — blind_ssrf hanya untuk lab / engagement aktif.";
  new URL(url); // throwaway validation (url already ^https?: checked above)

  // 1) DNS-OAST domain (create if the user has none yet — honest error otherwise)
  let domain = "";
  const created = await oastDnsCreate(rawUser);
  const domMatch = /domain unik:\s*(\S+)/.exec(created);
  if (domMatch) domain = domMatch[1];
  if (!domain) return `Error: DNS-OAST tidak tersedia — ${created.slice(0, 300)}`;

  const params = (opts.params || "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  const useParams = (params.length ? params : DEFAULT_SSRF_PARAMS).slice(0, 8);
  const seconds = Math.max(8, Math.min(60, Math.floor(Number(opts.seconds) || 20)));
  const lines: string[] = [`👁️ BLIND SSRF (DNS callback) — ${url.slice(0, 100)}`, `canary domain: ${domain} · params: ${useParams.join(", ")}`];

  // 2) plant param-attributed canaries (3 payload forms × params, ≤16 requests)
  let sent = 0;
  for (let i = 0; i < useParams.length; i++) {
    const payloads = ssrfPayloads(i, useParams[i]!, domain).slice(0, 2); // URL + UNC forms (bare-host rarely parsed)
    for (const p of payloads) {
      const r = await getWith(url, useParams[i]!, p, { session: opts.session, rawUser });
      recordHttp(rawUser, { method: "GET", url: `${url}?${useParams[i]}=<canary>`, status: r.status, bytes: r.body.length, ms: 0, at: new Date().toISOString() });
      sent++;
      await politeDelay();
    }
    if (sent >= 16) break;
  }
  lines.push(`${sent} probe terkirim — menunggu ${seconds}s untuk DNS callback…`);

  // 3) poll OAST for attributed hits
  await new Promise((res) => setTimeout(res, seconds * 1000));
  const poll = await oastDnsPoll(rawUser);
  const hits = attributeHits(poll);

  if (!hits.length) {
    lines.push("", poll.startsWith("🧬")
      ? "Tidak ada DNS callback — endpoint tidak melakukan fetch/resolve pada param ini, ATAU egress DNS-nya juga diblokir. Coba: param lain ( param=… ), surface lain, atau http-OAST (oast_create) untuk egress HTTP."
      : `OAST poll bermasalah: ${poll.slice(0, 200)}`);
    lines.push("SINYAL nihil ≠ aman: blind SSRF sering butuh payload spesifik (gopher/DNS-rebinding). Catat negative-result di hunt_log dan lanjut.");
    return lines.join("\n");
  }

  lines.push("", `🎯 SSRF LEADS (${hits.length}) — DNS callback dari canary ter-atribusi:`);
  for (const h of hits) {
    lines.push(`• param #${h.idx} "${h.param}" → ${h.raw}`);
    lines.push(`  ⚠️ SINYAL OOB — bukti server me-resolve host pilihan attacker (CWE-918). Verifikasi dengan poc_verify (ulangi + timing) sebelum finding_add.`);
  }
  lines.push("", "Lanjutan: cek apakah HTTP egress juga terbuka (oast_create + payload http callback) untuk meningkatkan severity (SSR penuh → RCE potensial).");
  return lines.join("\n").slice(0, 9000);
}
