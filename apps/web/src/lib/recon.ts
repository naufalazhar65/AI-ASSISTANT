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
import { targetAllowed, scanTextSecrets, splitHostPort, politeDelay } from "./security";

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
type ReconEntry = { subdomains?: string[]; live?: LiveHost[]; params?: ParamHit[]; takeovers?: TakeoverHit[]; endpoints?: string[]; updatedAt?: string };
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

/** Parse Cert Spotter issuances JSON → subdomains of `domain`. */
export function parseCertspotter(body: string, domain: string): string[] {
  let rows: { dns_names?: string[] }[];
  try {
    rows = JSON.parse(body) as { dns_names?: string[] }[];
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const out = new Set<string>();
  for (const r of rows) {
    for (const n of r.dns_names || []) {
      const h = String(n).toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
      if (h.endsWith("." + domain) && h !== domain) out.add(h);
    }
  }
  return [...out].sort();
}

async function certspotter(domain: string): Promise<string[]> {
  const body = await fetchText(`https://api.certspotter.com/v1/issuances?domain=${encodeURIComponent(domain)}&include_subdomains=true&expand=dns_names`, 20_000);
  return body ? parseCertspotter(body, domain) : [];
}

/** Merged passive subdomains: crt.sh + certspotter (+ hackertarget fallback). */
export async function passiveSubdomains(domain: string): Promise<string[]> {
  const d = cleanDomain(domain);
  if (!d) return [];
  const found = new Set<string>();
  const [crt, cs] = await Promise.all([crtsh(d), certspotter(d)]);
  for (const h of [...crt, ...cs]) found.add(h);
  if (!found.size) for (const h of await hackertarget(d)) found.add(h);
  return [...found].sort();
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
  const sources: string[] = [];
  const found = new Set<string>();
  const [crt, cs] = await Promise.all([crtsh(d), certspotter(d)]);
  if (crt.length) sources.push("crt.sh");
  if (cs.length) sources.push("certspotter");
  for (const h of [...crt, ...cs]) found.add(h);
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

// ── Active: content discovery (robots/sitemap/links/JS mining + common paths) ─
async function getText(url: string, cap = 200_000): Promise<string | null> {
  try {
    const res = await fetch(url, { redirect: "manual", headers: { "User-Agent": UA, Accept: "*/*" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const t = await res.text();
    return t.slice(0, cap);
  } catch {
    return null;
  }
}

const COMMON_PATHS = ["/admin", "/api", "/api/v1", "/login", "/dashboard", "/graphql", "/swagger.json", "/openapi.json", "/api-docs", "/.well-known/security.txt", "/.env", "/.git/config", "/backup", "/actuator/health", "/server-status", "/phpinfo.php", "/robots.txt", "/sitemap.xml"];

/**
 * Active content discovery for an authorized host: robots.txt + sitemap, page
 * links, JS endpoint mining, and a small bounded common-path probe. Low-rate,
 * capped. Scope-gated (`targetAllowed`).
 */
export async function contentDiscover(rawUser: unknown, urlRaw: string): Promise<string> {
  const raw = (urlRaw || "").trim();
  if (!/^https?:\/\//i.test(raw)) return "Error: URL harus http(s), mis. https://app.example.com";
  if (!targetAllowed(raw)) return "Error: SCOPE — content_discover hanya untuk lab / engagement aktif / PENTEST_LAB_TARGETS.";
  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    return "Error: URL tidak valid.";
  }
  const origin = base.origin;
  const paths = new Set<string>([base.pathname + base.search]);
  const jsFiles = new Set<string>();

  const robots = await getText(`${origin}/robots.txt`, 100_000);
  const sitemaps: string[] = [];
  if (robots) {
    for (const m of robots.matchAll(/^(?:Disallow|Allow):\s*(\S+)/gim)) if (m[1] && m[1] !== "/") paths.add(m[1]);
    for (const m of robots.matchAll(/^Sitemap:\s*(\S+)/gim)) sitemaps.push(m[1]);
  }
  for (const sm of [`${origin}/sitemap.xml`, ...sitemaps].slice(0, 3)) {
    const xml = await getText(sm, 300_000);
    if (xml) for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
      try {
        const u = new URL(m[1]);
        if (u.origin === origin) paths.add(u.pathname + u.search);
      } catch { /* skip */ }
    }
  }

  // Base fetch (manual redirect) — capture the page body AND any catch-all
  // redirect target, so a host that 301s everything to /login isn't reported
  // as "19 interesting paths".
  let html: string | null = null;
  let baseRedirect = "";
  try {
    const br = await fetch(raw, { redirect: "manual", headers: { "User-Agent": UA, Accept: "*/*" }, signal: AbortSignal.timeout(8000) });
    if (br.status >= 300 && br.status < 400) baseRedirect = br.headers.get("location") || "";
    else if (br.ok) html = (await br.text()).slice(0, 400_000);
  } catch { /* ignore */ }
  if (html) {
    for (const m of html.matchAll(/(?:href|src|action)=["']([^"']+)["']/gi)) {
      try {
        const u = new URL(m[1], raw);
        if (u.origin === origin) {
          paths.add(u.pathname + u.search);
          if (/\.js(\?|$)/i.test(u.pathname)) jsFiles.add(u.toString());
        }
      } catch { /* skip */ }
    }
  }

  const endpoints = new Set<string>();
  await pool([...jsFiles].slice(0, 8), 4, async (s) => {
    const js = await getText(s, 500_000);
    if (!js) return;
    for (const m of js.matchAll(/["'`](\/[A-Za-z0-9_\-./]{2,}(?:\?[^"'`\s]*)?)["'`]/g)) {
      if (!/\.(png|jpe?g|gif|svg|css|woff2?|ttf|ico|map|webp)$/i.test(m[1])) endpoints.add(m[1]);
    }
    for (const m of js.matchAll(/(?:fetch|axios(?:\.\w+)?|\.open)\(\s*["'`]([^"'`]+)["'`]/g)) {
      try {
        const u = new URL(m[1], s);
        if (u.origin === origin) endpoints.add(u.pathname + u.search);
      } catch { /* skip */ }
    }
  });

  // Common-path probe with catch-all suppression.
  // - SPA shell: a path returning the SAME HTML as the base page is a router.
  // - Redirect catch-all: many paths 301/302 to the SAME Location → universal redirect.
  const baseShell = (html || "").replace(/\s+/g, " ").slice(0, 3000);
  const probed: { status: number; path: string; loc: string }[] = [];
  await pool([...new Set(COMMON_PATHS)].slice(0, 20), 6, async (p) => {
    try {
      const r = await fetch(`${origin}${p}`, { method: "GET", redirect: "manual", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(6000) });
      if (r.status === 404 || r.status >= 500) return;
      const loc = r.status >= 300 && r.status < 400 ? r.headers.get("location") || "" : "";
      if (loc && baseRedirect && loc === baseRedirect) return; // same redirect as the base page
      const ct = r.headers.get("content-type") || "";
      if (baseShell && ct.includes("text/html")) {
        const body = (await r.text()).replace(/\s+/g, " ").slice(0, 3000);
        if (body === baseShell || Math.abs(body.length - baseShell.length) < 20) return; // SPA shell
      }
      probed.push({ status: r.status, path: p, loc });
    } catch { /* skip */ }
  });
  // Suppress redirects that many probed paths share (universal catch-all).
  const locCount = new Map<string, number>();
  for (const r of probed) if (r.loc) locCount.set(r.loc, (locCount.get(r.loc) || 0) + 1);
  const hits = probed.filter((r) => !(r.loc && (locCount.get(r.loc) || 0) >= 3)).map((r) => `${r.status} ${r.path}`);

  const links = [...paths].filter((p) => p && p !== "/").slice(0, 60);
  const eps = [...endpoints].slice(0, 60);
  const saved = [...new Set([...links, ...eps])].slice(0, RECON_MAX_SUBS);
  if (saved.length) saveRecon(rawUser, base.hostname, { endpoints: saved });
  const parts = [`🔎 CONTENT DISCOVER ${origin} — ${links.length} path, ${eps.length} endpoint JS, ${hits.length} path umum "menarik".`];
  if (links.length) parts.push(`\n🔗 Path/link:\n${links.map((p) => `• ${p}`).join("\n")}`);
  if (eps.length) parts.push(`\n🧩 Endpoint dari JS:\n${eps.map((p) => `• ${p}`).join("\n")}`);
  if (hits.length) parts.push(`\n⚠️ Path umum (cek manual):\n${hits.sort().map((h) => `• ${h}`).join("\n")}`);
  parts.push("\nLanjut: uji tiap endpoint ber-parameter dengan http_request / playbook kelas terkait → finding_add.");
  return parts.join("\n");
}

// ── Active: JS mining (endpoints + secrets from bundles) ────────────────────
export async function jsMine(rawUser: unknown, urlRaw: string): Promise<string> {
  void rawUser;
  const raw = (urlRaw || "").trim();
  if (!/^https?:\/\//i.test(raw)) return "Error: URL harus http(s).";
  if (!targetAllowed(raw)) return "Error: SCOPE — js_mine hanya untuk lab / engagement aktif / PENTEST_LAB_TARGETS.";
  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    return "Error: URL tidak valid.";
  }
  const origin = base.origin;
  const jsUrls = new Set<string>();
  // A direct `.js` URL is ALWAYS a JS bundle — check it FIRST. (Bundles often
  // contain the literal string "<script" inside strings, which used to make the
  // HTML heuristic misfire and report "no JS found".)
  const html = await getText(raw, 900_000);
  if (/\.jsx?(\?|$)/i.test(base.pathname)) {
    jsUrls.add(raw);
  } else if (html && /<script|<!doctype|<html/i.test(html)) {
    for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
      try {
        const u = new URL(m[1], raw);
        if (u.origin === origin) jsUrls.add(u.toString());
      } catch { /* skip */ }
    }
  }
  if (!jsUrls.size) return `Tidak menemukan file JS di ${raw}. (Arahkan langsung ke file .js, atau ke halaman HTML yang memuat script.)`;
  const endpoints = new Set<string>();
  const secrets: string[] = [];
  await pool([...jsUrls].slice(0, 10), 4, async (js) => {
    const body = await getText(js, 900_000);
    if (!body) return;
    const name = new URL(js).pathname.split("/").pop() || js;
    for (const m of body.matchAll(/["'`](\/[A-Za-z0-9_\-./]{2,}(?:\?[^"'`\s]*)?)["'`]/g)) {
      if (!/\.(png|jpe?g|gif|svg|css|woff2?|ttf|ico|map|webp)$/i.test(m[1])) endpoints.add(m[1]);
    }
    for (const m of body.matchAll(/(?:https?:)?\/\/[A-Za-z0-9._-]+\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]*/g)) {
      try {
        const u = new URL(m[0], js);
        if (u.origin === origin) endpoints.add(u.pathname + u.search);
      } catch { /* skip */ }
    }
    for (const h of scanTextSecrets(body)) secrets.push(`${name}:${h.line} — ${h.type}`);
  });
  const eps = [...endpoints].slice(0, 80);
  const parts = [`🧩 JS MINE ${origin} — ${jsUrls.size} JS, ${eps.length} endpoint, ${secrets.length} indikasi secret.`];
  if (eps.length) parts.push(`\n🔗 Endpoint dari JS:\n${eps.map((e) => `• ${e}`).join("\n")}`);
  if (secrets.length) parts.push(`\n🔐 Secret terdeteksi (nilai di-redact):\n${[...new Set(secrets)].slice(0, 40).map((s) => `• ${s}`).join("\n")}`);
  parts.push("\nLanjut: uji endpoint ber-parameter (param_fuzz/param_discover). Secret → WAJIB rotate + finding_add.");
  return parts.join("\n");
}

// ── Active: same-origin crawler (bounded BFS) ───────────────────────────────
export async function crawlSite(rawUser: unknown, urlRaw: string, maxPages = 30, depth = 2): Promise<string> {
  const raw = (urlRaw || "").trim();
  if (!/^https?:\/\//i.test(raw)) return "Error: URL harus http(s).";
  if (!targetAllowed(raw)) return "Error: SCOPE — crawl hanya untuk lab / engagement aktif / PENTEST_LAB_TARGETS.";
  const start = new URL(raw);
  const origin = start.origin;
  const cap = Math.min(60, Math.max(1, Number(maxPages) || 30));
  const maxDepth = Math.min(3, Math.max(0, Number(depth) || 2));
  const seen = new Set<string>([start.pathname + start.search]);
  const queue: { url: string; d: number }[] = [{ url: start.toString(), d: 0 }];
  const paths = new Set<string>();
  const forms: string[] = [];
  const scripts = new Set<string>();
  let fetched = 0;
  while (queue.length && fetched < cap) {
    const { url, d } = queue.shift() as { url: string; d: number };
    if (fetched < cap) fetched++;
    const html = await getText(url, 400_000);
    if (!html) continue;
    try {
      paths.add(new URL(url).pathname + new URL(url).search);
    } catch { /* skip */ }
    if (d < maxDepth) {
      for (const m of html.matchAll(/(?:href|src)=["']([^"']+)["']/gi)) {
        try {
          const nu = new URL(m[1], url);
          if (nu.origin !== origin) continue;
          if (/\.(png|jpe?g|gif|svg|css|woff2?|ttf|ico|map|webp|pdf|zip)$/i.test(nu.pathname)) continue;
          const key = nu.pathname + nu.search;
          if (seen.has(key)) continue;
          seen.add(key);
          queue.push({ url: nu.toString(), d: d + 1 });
          if (/\.js(\?|$)/i.test(nu.pathname)) scripts.add(nu.toString());
        } catch { /* skip */ }
      }
    }
    for (const fm of html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)) {
      const formTag = fm[0].match(/<form\b[^>]*>/i)?.[0] || "";
      const action = formTag.match(/action=["']([^"']*)["']/i)?.[1] || "";
      const method = (formTag.match(/method=["']([^"']*)["']/i)?.[1] || "GET").toUpperCase();
      const names = [...fm[1].matchAll(/<(?:input|select|textarea)\b[^>]*name=["']([^"']+)["']/gi)].map((x) => x[1]);
      if (names.length) {
        try {
          const au = new URL(action || url, url);
          forms.push(`${method} ${au.pathname} — ${names.join(", ")}`);
        } catch { /* skip */ }
      }
    }
  }
  const found = [...paths].filter((p) => p && p !== "/").slice(0, 200);
  if (found.length) saveRecon(rawUser, start.hostname, { endpoints: found });
  const parts = [`🕷️ CRAWL ${origin} — ${fetched} halaman, ${found.length} path, ${forms.length} form, ${scripts.size} JS.`];
  if (found.length) parts.push(`\n🔗 Path:\n${found.slice(0, 80).map((p) => `• ${p}`).join("\n")}`);
  if (forms.length) parts.push(`\n📝 Form (method action — field):\n${[...new Set(forms)].slice(0, 40).map((f) => `• ${f}`).join("\n")}`);
  if (scripts.size) parts.push(`\n📜 JS (${scripts.size}): ${[...scripts].slice(0, 15).join(", ")}`);
  parts.push("\nLanjut: `param_fuzz`/`param_discover` pada path/form → finding_add.");
  return parts.join("\n");
}

// ── Passive: new-asset diff (subdomains since last run) ─────────────────────
export async function reconDiff(rawUser: unknown, domainRaw: string): Promise<string> {
  const d = cleanDomain(domainRaw);
  if (!d) return "Error: domain tidak valid, mis. example.com";
  const prev = readRecon(rawUser)[d]?.subdomains || [];
  const found = new Set<string>();
  for (const h of await crtsh(d)) found.add(h);
  if (!found.size) for (const h of await hackertarget(d)) found.add(h);
  const next = [...found].sort().slice(0, RECON_MAX_SUBS);
  const prevSet = new Set(prev);
  const nextSet = new Set(next);
  const added = next.filter((h) => !prevSet.has(h));
  const removed = prev.filter((h) => !nextSet.has(h));
  if (next.length) saveRecon(rawUser, d, { subdomains: next });
  if (!prev.length) return `🗂️ recon_diff ${d}: belum ada cache — ${next.length} subdomain disimpan sebagai baseline. Jalankan lagi nanti untuk melihat aset BARU.`;
  const head = `🔄 recon_diff ${d}: +${added.length} baru, -${removed.length} hilang (total ${next.length}).`;
  if (!added.length && !removed.length) return `${head}\nTidak ada perubahan.`;
  const parts = [head];
  if (added.length) parts.push(`\n🆕 BARU (prioritaskan — aset baru = bug baru):\n${added.map((h) => `• ${h}`).join("\n")}`);
  if (removed.length) parts.push(`\n🗑️ Hilang:\n${removed.map((h) => `• ${h}`).join("\n")}`);
  return parts.join("\n");
}

// ── Active: visual recon (screenshot cached live hosts) ─────────────────────
export async function reconScreenshot(rawUser: unknown, domainRaw: string, hostsRaw?: string[]): Promise<string> {
  const explicit = (hostsRaw || []).map((h) => h.trim()).filter(Boolean);
  const d = cleanDomain(domainRaw);
  if (!explicit.length && !d) return "Error: beri `domain` (FQDN) atau `hosts` eksplisit (mis. 127.0.0.1:4010).";
  const cached = d ? readRecon(rawUser)[d]?.live?.map((l) => l.url) || [] : [];
  const hosts = [...new Set((explicit.length ? explicit : cached).map((h) => (/^https?:\/\//i.test(h) ? h : `http://${h}`)))]
    .filter((h) => targetAllowed(h))
    .slice(0, 12);
  if (!hosts.length) return `Tidak ada host dalam scope untuk ${d || "hosts"} — jalankan recon_httpx dulu, atau beri \`hosts\`, atau atur scope (engagement/PENTEST_LAB_TARGETS).`;
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return "Error: invalid user";
  const dir = join(userDataRoot(), userKey, "reports", "evidence");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const saved: string[] = [];
  try {
    for (const h of hosts) {
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        await page.goto(h, { waitUntil: "domcontentloaded", timeout: 15_000 });
        await page.waitForTimeout(700);
        const safe = h.replace(/^https?:\/\//, "").replace(/[^a-z0-9.-]/gi, "_").slice(0, 60);
        const f = join(dir, `site-${safe}-${stamp}.png`);
        await page.screenshot({ path: f });
        await page.close();
        saved.push(`• ${h} → ${f}`);
      } catch {
        saved.push(`• ${h} → gagal`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return `📸 Screenshot ${saved.length}/${hosts.length} host:\n${saved.join("\n")}`;
}

// ── DNS brute (native, keyless) ─────────────────────────────────────────────
const DNS_WORDS = [
  "www", "api", "app", "admin", "dev", "staging", "stage", "test", "uat", "qa", "prod", "portal", "dashboard", "auth", "login", "sso", "id", "accounts",
  "static", "cdn", "assets", "media", "img", "images", "mail", "smtp", "mx", "vpn", "git", "gitlab", "jenkins", "ci", "jira", "confluence", "wiki",
  "docs", "support", "help", "status", "blog", "shop", "store", "pay", "payments", "billing", "internal", "intranet", "db", "database", "redis",
  "mongo", "mysql", "postgres", "kibana", "grafana", "prometheus", "metrics", "monitoring", "sentry", "logs", "backup", "files", "upload", "downloads",
  "s3", "storage", "bucket", "mobile", "m", "web", "webmail", "remote", "ftp", "demo", "sandbox", "preview", "beta", "alpha", "edge", "origin", "gw",
  "gateway", "proxy", "lb", "k8s", "kube", "registry", "docker", "repo", "packages",
];

export async function reconDnsBrute(rawUser: unknown, domainRaw: string): Promise<string> {
  const d = cleanDomain(domainRaw);
  if (!d) return "Error: domain tidak valid, mis. example.com";
  const dns = await import("node:dns");
  const resolve = (h: string) => dns.promises.resolve4(h).catch(() => [] as string[]);
  const wildcard = (await resolve(`mia-wildcard-${Math.random().toString(36).slice(2, 8)}.${d}`)).length > 0;
  const names = DNS_WORDS.slice(0, 120);
  const hits: { host: string; ips: string[] }[] = [];
  await pool(names, 20, async (w) => {
    await politeDelay();
    const h = `${w}.${d}`;
    const ips = await resolve(h);
    if (ips.length) hits.push({ host: h, ips });
  });
  if (hits.length) {
    const prev = readRecon(rawUser)[d]?.subdomains || [];
    saveRecon(rawUser, d, { subdomains: [...new Set([...prev, ...hits.map((h) => h.host)])].slice(0, RECON_MAX_SUBS) });
  }
  const head = `🧬 DNS BRUTE ${d} — ${names.length} nama, ${hits.length} resolve${wildcard ? " ⚠️ WILDCARD aktif (bisa false-positive)" : ""}.`;
  return hits.length ? `${head}\n${hits.map((h) => `• ${h.host} → ${h.ips.slice(0, 3).join(", ")}`).join("\n")}` : `${head}\nTidak ada yang resolve.`;
}

// ── Port check (native TCP connect / naabu if present) ──────────────────────
const COMMON_PORTS = [21, 22, 23, 25, 53, 80, 110, 135, 139, 143, 443, 445, 993, 995, 1433, 1521, 2049, 2375, 3000, 3306, 3389, 4443, 5000, 5432, 5601, 5900, 6379, 8000, 8008, 8080, 8081, 8443, 9000, 9090, 9200, 11211, 27017];

export async function reconPorts(rawUser: unknown, hostRaw: string, ports?: number[]): Promise<string> {
  void rawUser;
  const raw = (hostRaw || "").trim();
  if (!raw) return "Error: beri host, mis. 127.0.0.1 atau example.com";
  if (!targetAllowed(raw)) return "Error: SCOPE — recon_ports hanya untuk lab / engagement aktif / PENTEST_LAB_TARGETS.";
  const { host } = splitHostPort(raw);
  const list = (ports && ports.length ? ports : COMMON_PORTS).filter((p) => Number.isInteger(p) && p > 0 && p < 65536).slice(0, 100);
  const net = await import("node:net");
  const check = (port: number) =>
    new Promise<boolean>((resolve) => {
      const s = net.connect({ host, port });
      let done = false;
      const fin = (v: boolean) => {
        if (!done) {
          done = true;
          s.destroy();
          resolve(v);
        }
      };
      s.setTimeout(1500);
      s.on("connect", () => fin(true));
      s.on("timeout", () => fin(false));
      s.on("error", () => fin(false));
    });
  const open: number[] = [];
  await pool(list, 25, async (p) => {
    if (await check(p)) open.push(p);
  });
  const head = `🔌 PORTS ${host} — ${list.length} diperiksa, ${open.length} terbuka.`;
  return open.length ? `${head}\n${open.sort((a, b) => a - b).join(", ")}` : `${head}\nTidak ada port umum yang terbuka (bisa difilter firewall).`;
}

// ── Cloud bucket enumeration (S3 / GCS, keyless) ────────────────────────────
const BUCKET_SUFFIXES = ["", "-backup", "-backups", "-dev", "-staging", "-test", "-prod", "-assets", "-static", "-media", "-public", "-files", "-uploads", "-data", "-logs", "-cdn", "-images", "-prod-backup", "-archive"];

async function headStatus(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { method: "GET", redirect: "manual", headers: { "User-Agent": "mia-assistant/1.0" }, signal: AbortSignal.timeout(8000) });
    return res.status;
  } catch {
    return null;
  }
}

export async function bucketEnum(rawUser: unknown, domainRaw: string, names?: string[]): Promise<string> {
  void rawUser;
  const d = cleanDomain(domainRaw);
  if (!d) return "Error: domain tidak valid, mis. example.com";
  if (!targetAllowed(d)) return "Error: SCOPE — bucket_enum butuh domain dalam scope (engagement / PENTEST_LAB_TARGETS).";
  const base = d.split(".")[0].replace(/[^a-z0-9-]/g, "");
  const candidates = [...new Set([...BUCKET_SUFFIXES.map((s) => `${base}${s}`), ...(names || []).map((n) => n.toLowerCase().trim()).filter(Boolean)])].slice(0, 30);
  const hits: string[] = [];
  await pool(candidates, 5, async (b) => {
    const s3 = await headStatus(`https://${b}.s3.amazonaws.com`);
    if (s3 && s3 !== 404) hits.push(`• S3 ${b} → ${s3}${s3 === 200 ? " (LIST PUBLIK!)" : " (ada)"}`);
    const gcs = await headStatus(`https://storage.googleapis.com/${b}`);
    if (gcs && gcs !== 404) hits.push(`• GCS ${b} → ${gcs}${gcs === 200 ? " (LIST PUBLIK!)" : " (ada)"}`);
  });
  const head = `🪣 BUCKET ENUM ${d} — ${candidates.length} kandidat, ${hits.length} bucket ada.`;
  return hits.length ? `${head}\n${hits.join("\n")}\n\nVerifikasi isi (jangan eksfiltrasi data nyata); 200 = listing publik.` : `${head}\nTidak ada bucket publik terdeteksi.`;
}

/** Cached recon summary (no network). */
export function reconList(rawUser: unknown): string {
  const store = readRecon(rawUser);
  const rows = Object.entries(store);
  if (!rows.length) return "Belum ada cache recon. Jalankan recon_subdomains / recon_httpx / recon_params dulu.";
  return `🗂️ Cache recon:\n${rows.map(([d, e]) => `• ${d} — ${e.subdomains?.length || 0} subdomain, ${e.live?.length || 0} host hidup, ${e.params?.length || 0} param, ${e.takeovers?.length || 0} takeover${e.updatedAt ? ` (${e.updatedAt.slice(0, 10)})` : ""}`).join("\n")}`;
}
