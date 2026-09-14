/**
 * Recon toolkit — attack-surface discovery for authorized targets. Keyless.
 *
 * Passive OSINT (public archives only, any domain): subdomains from Certificate
 * Transparency (crt.sh), URLs/params from public archives (OTX + urlscan + Wayback).
 * Active probing (live hosts): requires `targetAllowed` (lab / active engagement
 * / PENTEST_LAB_TARGETS) — same scope model as the rest of the pentest toolkit.
 *
 * All network calls are bounded (timeouts + caps); nothing here shells out to
 * uninstalled binaries. Results are cached per user so `recon_httpx` can probe
 * the subdomains found by `recon_subdomains`.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";
import { targetAllowed } from "./security";

const UA = "mia-assistant/1.0";
export const RECON_MAX_SUBS = 500;
export const RECON_MAX_PROBE = 30;
const RECON_CONCURRENCY = 8;
const RECON_MAX_DOMAINS = 30;

/** Normalize a domain token (strip scheme/path/port/wildcard); "" if invalid. */
export function cleanDomain(raw: unknown): string {
  const d = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\*\./, "")
    .replace(/^[a-z]+:\/\//, "")
    .split("/")[0]
    .split(":")[0]
    .replace(/\.$/, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d) ? d : "";
}

/** Keep only names that are subdomains of `domain` (dedup, strip wildcard). */
export function parseCertNames(body: string, domain: string): string[] {
  const out = new Set<string>();
  let rows: { name_value?: string; common_name?: string }[];
  try {
    rows = JSON.parse(body) as { name_value?: string; common_name?: string }[];
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  for (const r of rows) {
    for (const name of `${r.name_value || ""}\n${r.common_name || ""}`.split(/\s+/)) {
      const h = name.trim().toLowerCase().replace(/^\*\./, "");
      if (h.endsWith("." + domain) && h !== domain) out.add(h);
    }
  }
  return [...out].sort();
}

export type ParamHit = { name: string; count: number; interesting: boolean; sample: string };

const INTERESTING_PARAM = /(^|_)(id|redirect|url|uri|next|return|returnto|continue|file|path|page|cmd|exec|debug|admin|token|key|q|query|search|include|template|callback|dest|destination|domain|host|src|source|load|download|lang|role|user|pass|secret)(_|$)/i;

/** Extract unique query-parameter names from a list of URLs (ranked). */
export function extractParams(urls: string[], domain: string): ParamHit[] {
  const counts = new Map<string, number>();
  const samples = new Map<string, string>();
  for (const u of urls) {
    let url: URL;
    try {
      url = new URL(u);
    } catch {
      continue;
    }
    if (url.hostname !== domain && !url.hostname.endsWith("." + domain)) continue;
    for (const k of url.searchParams.keys()) {
      counts.set(k, (counts.get(k) || 0) + 1);
      if (!samples.has(k)) samples.set(k, u.slice(0, 160));
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count, interesting: INTERESTING_PARAM.test(name), sample: samples.get(name) || "" }))
    .sort((a, b) => Number(b.interesting) - Number(a.interesting) || b.count - a.count)
    .slice(0, 60);
}

// ── Per-user cache ──────────────────────────────────────────────────────────
export type LiveHost = { url: string; status: number; server: string; title: string };
type ReconEntry = { subdomains?: string[]; live?: LiveHost[]; params?: ParamHit[]; takeovers?: TakeoverHit[]; updatedAt?: string };
type ReconStore = Record<string, ReconEntry>;

function storePath(userKey: string): string {
  return join(userDataRoot(), userKey, "recon.json");
}
export function readRecon(rawUser: unknown): ReconStore {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return {};
  try {
    const j = JSON.parse(readFileSync(storePath(userKey), "utf8"));
    return j && typeof j === "object" ? (j as ReconStore) : {};
  } catch {
    return {};
  }
}
function saveRecon(rawUser: unknown, domain: string, patch: ReconEntry): void {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return;
  const store = readRecon(rawUser);
  store[domain] = { ...(store[domain] || {}), ...patch, updatedAt: new Date().toISOString() };
  const keys = Object.keys(store);
  for (const k of keys.slice(0, Math.max(0, keys.length - RECON_MAX_DOMAINS))) delete store[k];
  const file = storePath(userKey);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, file);
}

// ── Network helpers ─────────────────────────────────────────────────────────
async function fetchText(url: string, timeoutMs = 15_000): Promise<string | null> {
  try {
    const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": UA, Accept: "*/*" }, signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

async function crtsh(domain: string): Promise<string[]> {
  const body = await fetchText(`https://crt.sh/?q=${encodeURIComponent("%." + domain)}&output=json`, 25_000);
  return body ? parseCertNames(body, domain) : [];
}

async function hackertarget(domain: string): Promise<string[]> {
  const body = await fetchText(`https://api.hackertarget.com/hostsearch/?q=${encodeURIComponent(domain)}`, 15_000);
  if (!body || /error|exceeded/i.test(body)) return [];
  const out = new Set<string>();
  for (const line of body.split("\n")) {
    const h = line.split(",")[0]?.trim().toLowerCase();
    if (h && h.endsWith("." + domain)) out.add(h);
  }
  return [...out].sort();
}

// ── Passive: subdomains ─────────────────────────────────────────────────────
export async function reconSubdomains(rawUser: unknown, domainRaw: string): Promise<string> {
  const d = cleanDomain(domainRaw);
  if (!d) return "Error: domain tidak valid, mis. example.com";
  const found = new Set<string>();
  const sources: string[] = [];
  const crt = await crtsh(d);
  if (crt.length) sources.push("crt.sh");
  for (const h of crt) found.add(h);
  if (!found.size) {
    const ht = await hackertarget(d);
    if (ht.length) sources.push("hackertarget");
    for (const h of ht) found.add(h);
  }
  const subs = [...found].sort();
  const capped = subs.slice(0, RECON_MAX_SUBS);
  if (capped.length) saveRecon(rawUser, d, { subdomains: capped });
  if (!capped.length) {
    return `🔍 recon_subdomains ${d}: tidak ada subdomain ditemukan (sumber: crt.sh${sources.includes("hackertarget") ? ", hackertarget" : ""}). Coba domain lain atau target yang lebih punya banyak sertifikat.`;
  }
  const extra = subs.length > capped.length ? ` (ditampilkan ${capped.length} dari ${subs.length})` : "";
  return `🔍 Subdomain ${d} — ${subs.length} unik${extra} (sumber: ${sources.join(", ")}):\n${capped.map((h) => `• ${h}`).join("\n")}\n\nLanjut: recon_httpx domain=${d} untuk probe host hidup.`;
}

// ── Active: live-host probing (scope-gated) ─────────────────────────────────
/** Read at most `cap` bytes of a body (never buffers a huge response). */
async function readCapped(res: Response, cap: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.length;
      }
    }
  } catch {
    /* return what we have so far */
  }
  try {
    await reader.cancel();
  } catch {
    /* already closed */
  }
  return Buffer.concat(chunks).toString("utf8").slice(0, cap);
}

async function probeOne(host: string): Promise<LiveHost | null> {
  for (const scheme of ["https", "http"]) {
    let url = `${scheme}://${host}`;
    // Follow redirects manually and only within scope — a scoped host must not
    // be able to bounce the probe to an out-of-scope third party.
    for (let hop = 0; hop <= 5; hop++) {
      let res: Response;
      try {
        res = await fetch(url, { redirect: "manual", headers: { "User-Agent": UA, Accept: "text/html,*/*" }, signal: AbortSignal.timeout(6000) });
      } catch {
        break; // scheme failed — try the next one
      }
      const server = res.headers.get("server") || "";
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        let next = "";
        if (loc) {
          try {
            next = new URL(loc, url).toString();
          } catch {
            next = "";
          }
        }
        if (!next || !targetAllowed(next)) return { url: next || url, status: res.status, server, title: next ? "(redirect ke luar scope)" : "" };
        url = next;
        continue;
      }
      let title = "";
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("text/html")) {
        const html = await readCapped(res, 20_000);
        title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim().slice(0, 120);
      }
      return { url, status: res.status, server, title };
    }
  }
  return null;
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function reconHttpx(rawUser: unknown, domainRaw: string, hostsRaw?: string[]): Promise<string> {
  const d = cleanDomain(domainRaw);
  if (!d) return "Error: domain tidak valid, mis. example.com";
  if (!targetAllowed(d)) {
    return "Error: SCOPE — recon_httpx (probe aktif) hanya untuk lab, host di engagement AKTIF, atau PENTEST_LAB_TARGETS (aset sendiri/berizin). Subdomain pasif tetap boleh.";
  }
  const cached = readRecon(rawUser)[d]?.subdomains || [];
  const given = (hostsRaw || []).map((h) => cleanDomain(h) || String(h).toLowerCase().trim()).filter(Boolean);
  let hosts = (given.length ? given : cached.length ? cached : [d]);
  hosts = [...new Set(hosts.map((h) => h.toLowerCase().replace(/^https?:\/\//, "").split("/")[0].split(":")[0]))]
    .filter((h) => h && (h === d || h.endsWith("." + d)) && targetAllowed(h))
    .slice(0, RECON_MAX_PROBE);
  if (!hosts.length) return `Error: tidak ada host dalam scope untuk ${d} (semua subdomain di luar izin).`;
  const live = (await pool(hosts, RECON_CONCURRENCY, probeOne)).filter((x): x is LiveHost => !!x);
  saveRecon(rawUser, d, { live });
  if (!live.length) return `🌐 recon_httpx ${d}: ${hosts.length} host diprobe, tidak ada yang merespons HTTP(S).`;
  return `🌐 Host hidup ${d} — ${live.length}/${hosts.length}:\n${live
    .sort((a, b) => a.url.localeCompare(b.url))
    .map((h) => `• [${h.status}] ${h.url}${h.server ? ` — ${h.server}` : ""}${h.title ? `\n   “${h.title}”` : ""}`)
    .join("\n")}`;
}

// ── Passive: URLs/params from public archives (OTX + urlscan + Wayback) ──────
async function otxUrls(domain: string): Promise<string[]> {
  const body = await fetchText(`https://otx.alienvault.com/api/v1/indicators/domain/${encodeURIComponent(domain)}/url_list?limit=500`, 12_000);
  if (!body) return [];
  try {
    const j = JSON.parse(body) as { url_list?: { url?: string }[] };
    return (j.url_list || []).map((u) => u.url || "").filter(Boolean);
  } catch {
    return [];
  }
}

async function urlscanUrls(domain: string): Promise<string[]> {
  const body = await fetchText(`https://urlscan.io/api/v1/search/?q=${encodeURIComponent("domain:" + domain)}&size=200`, 15_000);
  if (!body) return [];
  try {
    const j = JSON.parse(body) as { results?: { page?: { url?: string }; task?: { url?: string } }[] };
    const out: string[] = [];
    for (const r of j.results || []) {
      if (r.page?.url) out.push(r.page.url);
      if (r.task?.url) out.push(r.task.url);
    }
    return out;
  } catch {
    return [];
  }
}

async function waybackUrls(domain: string): Promise<string[]> {
  const body = await fetchText(`https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(domain + "/*")}&output=text&fl=original&collapse=urlkey&limit=10000`, 15_000);
  return body ? body.split("\n").map((l) => l.trim()).filter(Boolean) : [];
}

export async function reconParams(rawUser: unknown, domainRaw: string): Promise<string> {
  const d = cleanDomain(domainRaw);
  if (!d) return "Error: domain tidak valid, mis. example.com";
  const [otx, urlscan, wayback] = await Promise.all([otxUrls(d), urlscanUrls(d), waybackUrls(d)]);
  const urls = [...otx, ...urlscan, ...wayback].slice(0, 20_000);
  const sources = [otx.length && "OTX", urlscan.length && "urlscan", wayback.length && "Wayback"].filter(Boolean) as string[];
  if (!urls.length) return `🔍 recon_params ${d}: tidak ada URL dari arsip publik (OTX/urlscan/Wayback kosong atau tidak terjangkau).`;
  const params = extractParams(urls, d);
  saveRecon(rawUser, d, { params });
  if (!params.length) return `🔍 recon_params ${d}: ${urls.length} URL (${sources.join(", ")}) tapi tanpa query-parameter (kemungkinan SPA/statis).`;
  const interesting = params.filter((p) => p.interesting);
  const lines = params.slice(0, 40).map((p) => `• ${p.name}${p.interesting ? " ⭐" : ""} (${p.count}${p.sample ? `) — ${p.sample}` : ")"}`);
  return `🔍 Parameter ${d} — ${params.length} unik dari ${urls.length} URL (sumber: ${sources.join(", ")})${interesting.length ? `; ${interesting.length} menarik: ${interesting.slice(0, 12).map((p) => p.name).join(", ")}` : ""}:\n${lines.join("\n")}\n\n⭐ = kandidat IDOR/SSRF/open-redirect/LFI — uji manual di URL berizin.`;
}

// ── Passive: subdomain takeover candidates (CNAME fingerprints) ─────────────
export type TakeoverHit = { host: string; cname: string; service: string };

const TAKEOVER_FINGERPRINTS: { service: string; re: RegExp }[] = [
  { service: "GitHub Pages", re: /(^|\.)github\.io$/ },
  { service: "Heroku", re: /(^|\.)(herokuapp\.com|herokudns\.com)$/ },
  { service: "AWS S3", re: /(^|\.)(s3[.-][a-z0-9-]*\.amazonaws\.com|s3\.amazonaws\.com)$/ },
  { service: "AWS CloudFront", re: /(^|\.)cloudfront\.net$/ },
  { service: "AWS ELB", re: /(^|\.)elb\.amazonaws\.com$/ },
  { service: "Azure", re: /(^|\.)(azurewebsites\.net|cloudapp\.azure\.com|azureedge\.net|trafficmanager\.net)$/ },
  { service: "Netlify", re: /(^|\.)(netlify\.app|netlify\.com)$/ },
  { service: "Vercel", re: /(^|\.)(vercel\.app|now\.sh)$/ },
  { service: "Fly.io", re: /(^|\.)fly\.dev$/ },
  { service: "Surge", re: /(^|\.)surge\.sh$/ },
  { service: "Fastly", re: /(^|\.)fastly\.net$/ },
  { service: "Shopify", re: /(^|\.)myshopify\.com$/ },
  { service: "Zendesk", re: /(^|\.)zendesk\.com$/ },
  { service: "Read the Docs", re: /(^|\.)readthedocs\.io$/ },
  { service: "WordPress", re: /(^|\.)wordpress\.com$/ },
  { service: "Bitbucket", re: /(^|\.)bitbucket\.io$/ },
  { service: "Ghost", re: /(^|\.)ghost\.io$/ },
  { service: "Webflow", re: /(^|\.)(webflow\.io|proxy\.webflow\.com)$/ },
  { service: "Cargo", re: /(^|\.)cargocollective\.com$/ },
  { service: "Pantheon", re: /(^|\.)pantheonsite\.io$/ },
  { service: "WPEngine", re: /(^|\.)wpengine\.com$/ },
  { service: "Ngrok", re: /(^|\.)ngrok\.io$/ },
  { service: "Unbounce", re: /(^|\.)unbounce\.com$/ },
  { service: "Pingdom", re: /(^|\.)pingdom\.com$/ },
  { service: "Tilda", re: /(^|\.)tilda\.ws$/ },
];

/** Classify a CNAME target as a known dangling-service fingerprint (or null). */
export function matchTakeover(cname: string): string | null {
  const c = (cname || "").trim().toLowerCase().replace(/\.$/, "");
  if (!c) return null;
  for (const f of TAKEOVER_FINGERPRINTS) if (f.re.test(c)) return f.service;
  return null;
}

/**
 * Passive subdomain-takeover check: resolves CNAMEs of cached subdomains and
 * flags those pointing at known claimable services. DNS-only (no HTTP), so it
 * is safe/auto. A flagged CNAME is a CANDIDATE — verify the service is unclaimed
 * before calling it a real takeover.
 */
export async function reconTakeover(rawUser: unknown, domainRaw: string): Promise<string> {
  const d = cleanDomain(domainRaw);
  if (!d) return "Error: domain tidak valid, mis. example.com";
  const cached = readRecon(rawUser)[d]?.subdomains || [];
  const hosts = [...new Set((cached.length ? cached : [d]).map((h) => h.toLowerCase()))].slice(0, RECON_MAX_PROBE);
  const dns = await import("node:dns");
  const results = await pool(hosts, RECON_CONCURRENCY, async (h) => {
    let cnames: string[] = [];
    try {
      cnames = await dns.promises.resolveCname(h);
    } catch {
      cnames = [];
    }
    return { h, cnames, service: cnames.map(matchTakeover).find(Boolean) || null };
  });
  const hits: TakeoverHit[] = results.filter((r) => r.service).map((r) => ({ host: r.h, cname: r.cnames[0], service: r.service as string }));
  const withCname = results.filter((r) => r.cnames.length);
  saveRecon(rawUser, d, { takeovers: hits }); // always overwrite so stale hits don't linger
  const head = `🎯 TAKEOVER CHECK ${d} — ${hosts.length} host, ${withCname.length} punya CNAME, ${hits.length} kandidat.`;
  if (!withCname.length) {
    return `${head}\nTidak ada CNAME (bisa jadi A/Cloudflare). Jalankan recon_subdomains dulu agar lebih banyak host diuji.`;
  }
  const list = withCname.slice(0, 40).map((r) => `• ${r.h} → ${r.cnames.join(", ")}${r.service ? `  ⚠️ ${r.service}` : ""}`);
  return `${head}\n${list.join("\n")}${hits.length ? `\n\n⚠️ Kandidat: ${hits.map((h) => `${h.host} (${h.service})`).join(", ")} — VERIFIKASI apakah layanan belum diklaim sebelum menyimpulkan takeover.` : "\nTidak ada CNAME layanan yang dikenal rentan."}`;
}

/** Cached recon summary (no network). */
export function reconList(rawUser: unknown): string {
  const store = readRecon(rawUser);
  const rows = Object.entries(store);
  if (!rows.length) return "Belum ada cache recon. Jalankan recon_subdomains / recon_httpx / recon_params dulu.";
  return `🗂️ Cache recon:\n${rows.map(([d, e]) => `• ${d} — ${e.subdomains?.length || 0} subdomain, ${e.live?.length || 0} host hidup, ${e.params?.length || 0} param, ${e.takeovers?.length || 0} takeover${e.updatedAt ? ` (${e.updatedAt.slice(0, 10)})` : ""}`).join("\n")}`;
}
