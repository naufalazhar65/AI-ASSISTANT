// Security Hunt — one-shot autonomous recon + audit for an in-scope host.
// Orchestrates the existing tools (web/csp/cors audit, content discovery, crawl,
// JS mining, hidden-param discovery) into a single structured, actionable report.
// Active → write/confirm; scope-gated (targetAllowed); bounded + low-rate.
import { targetAllowed } from "./security";
import { webAudit, corsAudit, cspAudit } from "./security";
import { contentDiscover, crawlSite, jsMine } from "./recon";
import { paramDiscover } from "./paramFuzz";
import { parseOpenApi, parsePostman } from "./apiSpec";
import { sessionHeaders } from "./httpSession";

const MAX_LINE = 1600;

function head(s: string, n: number): string {
  return s.split("\n").slice(0, n).join("\n").slice(0, MAX_LINE);
}
function flags(s: string): string[] {
  return s
    .split("\n")
    .filter((l) => /⚠️|❌|HILANG|tanpa |ter-reflect|reflection|open redirect|SSTI|SQL error|command output|LSIT|PUBLIK|TERKONFIRMASI|BARU/i.test(l))
    .map((l) => l.trim())
    .slice(0, 12);
}
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    return (typeof fallback === "string" ? (`(gagal: ${e instanceof Error ? e.message : String(e)})`) : fallback) as T;
  }
}

export async function securityHunt(rawUser: unknown, urlRaw: string, opts: { deep?: boolean } = {}): Promise<string> {
  const url = (urlRaw || "").trim();
  if (!/^https?:\/\//i.test(url)) return "Error: URL harus http(s).";
  if (!targetAllowed(url)) return "Error: SCOPE — security_hunt hanya untuk lab / engagement aktif / PENTEST_LAB_TARGETS.";
  const leads: string[] = [];
  const sections: string[] = [];

  const audit = await safe(() => webAudit(url), "");
  const auditFlags = flags(audit);
  if (auditFlags.length) leads.push(...auditFlags.map((f) => `header/cookie: ${f}`));
  sections.push(`【1】HEADER & COOKIE\n${head(audit, 8)}`);

  const csp = await safe(() => cspAudit(url), "");
  const cspFlags = flags(csp);
  if (cspFlags.length) leads.push(...cspFlags.map((f) => `CSP: ${f}`));
  sections.push(`【2】CSP\n${head(csp, 4)}`);

  const cors = await safe(() => corsAudit(url, rawUser), "");
  const corsFlags = flags(cors);
  if (corsFlags.length) leads.push(...corsFlags.map((f) => `CORS: ${f}`));
  sections.push(`【3】CORS\n${head(cors, 4)}`);

  const content = await safe(() => contentDiscover(rawUser, url), "");
  const contentFlags = flags(content);
  if (contentFlags.length) leads.push(...contentFlags.map((f) => `content: ${f}`));
  sections.push(`【4】CONTENT DISCOVERY\n${head(content, 10)}`);

  const crawl = await safe(() => crawlSite(rawUser, url, 15, 2), "");
  const crawlFlags = flags(crawl);
  if (crawlFlags.length) leads.push(...crawlFlags.map((f) => `crawl: ${f}`));
  sections.push(`【5】CRAWL\n${head(crawl, 8)}`);

  const js = await safe(() => jsMine(rawUser, url), "");
  const jsFlags = flags(js);
  if (jsFlags.length) leads.push(...jsFlags.map((f) => `js: ${f}`));
  sections.push(`【6】JS MINING\n${head(js, 10)}`);

  if (opts.deep) {
    const pd = await safe(() => paramDiscover(undefined, { url }), "");
    const pdFlags = flags(pd);
    if (pdFlags.length) leads.push(...pdFlags.map((f) => `param: ${f}`));
    sections.push(`【7】PARAM DISCOVERY\n${head(pd, 8)}`);
  }

  const header = `🛰️ SECURITY HUNT ${url}${opts.deep ? " (deep)" : ""}\n${sections.join("\n\n")}`;
  const leadBlock = leads.length
    ? `\n\n🎯 LEADS (verifikasi manual sebelum finding_add):\n${[...new Set(leads)].slice(0, 20).map((l) => `• ${l}`).join("\n")}`
    : "\n\n🎯 LEADS: tidak ada sinyal otomatis — lanjutkan uji manual (alur auth/IDOR/logic).";
  return `${header}${leadBlock}\n\n⚠️ Ini pemetaan otomatis, bukan temuan final. Jalankan deep=true untuk param-discovery; verifikasi + counterevidence dulu.`;
}

// ── auth_hunt: auth-flow surface probe (server-side chain) ───────────────────
// One call instead of many model rounds: fetch the common auth endpoints and
// report status/redirect/cookie-flag/CSP signals per path, then derive leads.
// Active → scope-gated; bounded (one request per path, low-rate).

const AUTH_PATHS = [
  "/login",
  "/signin",
  "/auth/login",
  "/register",
  "/signup",
  "/forgot-password",
  "/auth/login/forgot-password",
  "/reset-password",
  "/auth/login/reset-password",
  "/api/auth/providers",
  "/api/auth/csrf",
  "/api/auth/session",
  "/.well-known/openid-configuration",
];
const SESSIONISH = /sess|sid|auth|token|jwt|login|credential/i;

type Probe = { status: number; location: string; server: string; csp: boolean; cookies: string[]; ct: string };

async function probe(url: string, headers?: Record<string, string>): Promise<Probe> {
  const res = await fetch(url, {
    method: "GET",
    headers: { "User-Agent": "mia-assistant/1.0", ...(headers || {}) },
    redirect: "manual",
    signal: AbortSignal.timeout(12_000),
  });
  const h = res.headers as unknown as { getSetCookie?: () => string[] };
  const cookies =
    typeof h.getSetCookie === "function" ? h.getSetCookie.call(res.headers) : [res.headers.get("set-cookie")].filter((x): x is string => !!x);
  return {
    status: res.status,
    location: res.headers.get("location") || "",
    server: res.headers.get("server") || "",
    csp: !!res.headers.get("content-security-policy"),
    cookies,
    ct: res.headers.get("content-type") || "",
  };
}

function cookieProblems(setCookies: string[]): string[] {
  const out: string[] = [];
  for (const c of setCookies) {
    const name = c.split("=")[0].trim();
    const lower = c.toLowerCase();
    const missing = ["httponly", "secure", "samesite"].filter((f) => !lower.includes(f));
    if (missing.length && SESSIONISH.test(name)) out.push(`${name} [tanpa ${missing.join("/")}]`);
    else if (missing.length) out.push(`${name} [tanpa ${missing.join("/")}] (kemungkinan tracking)`);
  }
  return out;
}

export async function authHunt(rawUser: unknown, urlRaw: string): Promise<string> {
  const url = (urlRaw || "").trim();
  if (!/^https?:\/\//i.test(url)) return "Error: URL harus http(s).";
  if (!targetAllowed(url)) return "Error: SCOPE — auth_hunt hanya untuk lab / engagement aktif / PENTEST_LAB_TARGETS.";
  let base: string;
  try {
    base = new URL(url).origin;
  } catch {
    return "Error: URL tidak valid.";
  }
  const leads: string[] = [];
  const rows: string[] = [];
  for (const p of AUTH_PATHS) {
    const r = await safe(() => probe(base + p), null as Probe | null);
    if (!r) {
      rows.push(`${p} → (gagal)`);
      continue;
    }
    const bits = [`${r.status}`];
    if (r.location) bits.push(`→ ${r.location.slice(0, 80)}`);
    if (r.server) bits.push(`server=${r.server}`);
    if (!r.csp) bits.push("tanpa CSP");
    const cp = cookieProblems(r.cookies);
    if (cp.length) bits.push(`cookie: ${cp.join(", ")}`);
    rows.push(`${p} → ${bits.join(" | ")}`);
    // Leads
    if (/forgot|reset|register|signup/i.test(p) && r.status >= 200 && r.status < 300) leads.push(`auth-flow ${p} → ${r.status} (alur ber-akun; uji enumerasi/reset-token manual)`);
    if (/providers|openid-configuration/i.test(p) && r.status === 200) leads.push(`${p} → 200 (konfigurasi auth terbuka; cek info yang bocor)`);
    for (const c of cp) if (SESSIONISH.test(c) && !/tracking/.test(c)) leads.push(`cookie sesi tanpa flag di ${p}: ${c}`);
    await new Promise((res) => setTimeout(res, 150));
  }
  const body = rows.map((r) => `• ${r}`).join("\n");
  const leadBlock = leads.length
    ? `\n\n🎯 LEADS (verifikasi manual + counterevidence):\n${[...new Set(leads)].slice(0, 20).map((l) => `• ${l}`).join("\n")}`
    : "\n\n🎯 LEADS: tidak ada sinyal otomatis — uji manual alur auth (enumerasi, reset token, session).";
  return `🔐 AUTH HUNT ${base}\n${body}${leadBlock}\n\n⚠️ Pemetaan otomatis, bukan temuan. Alur ber-akun (forgot/reset/login) perlu akun uji + uji manual; lihat security_playbook name=browser-transport-tampering / idor-triage.`;
}

// ── api_hunt: spec-driven unauthenticated authz probe ────────────────────────
// Feed an OpenAPI/Postman spec URL (or JSON via `spec`): enumerate endpoints,
// then probe each unauthenticated (optionally with a saved session) to flag
// endpoints that answer without credentials. Bounded (≤20 endpoints).

export async function apiHunt(rawUser: unknown, urlRaw: string, opts: { spec?: string; session?: string } = {}): Promise<string> {
  const url = (urlRaw || "").trim();
  if (!/^https?:\/\//i.test(url)) return "Error: URL harus http(s).";
  if (!targetAllowed(url)) return "Error: SCOPE — api_hunt hanya untuk lab / engagement aktif / PENTEST_LAB_TARGETS.";
  let specText = opts.spec || "";
  if (!specText) {
    const raw = await safe(
      async () => (await fetch(url, { headers: { "User-Agent": "mia-assistant/1.0" }, signal: AbortSignal.timeout(15_000) })).text(),
      ""
    );
    if (!raw) return "Error: gagal mengambil spec — pastikan URL spec OpenAPI/Postman dapat diakses.";
    specText = raw;
  }
  let spec: unknown;
  try {
    spec = JSON.parse(specText);
  } catch {
    return "Error: spec bukan JSON — ambil raw OpenAPI/Postman JSON dulu (api_spec text=...).";
  }
  const endpoints = [...parseOpenApi(spec), ...parsePostman(spec)];
  if (!endpoints.length) return "Tidak ada endpoint terbaca dari spec (butuh OpenAPI atau Postman collection JSON).";
  const session = opts.session ? sessionHeaders(rawUser, opts.session) : null;
  const authHeaders = session ? { ...session.headers, ...(session.cookie && !session.headers.cookie ? { cookie: session.cookie } : {}) } : undefined;
  const origin = new URL(url).origin;
  const leads: string[] = [];
  const rows: string[] = [];
  for (const ep of endpoints.slice(0, 20)) {
    const path = ep.path.replace(/\{[^}]+\}/g, "1");
    const full = /^https?:\/\//i.test(path) ? path : origin + (path.startsWith("/") ? path : `/${path}`);
    // Probe with GET (safe, no side effects); a write method in the spec is only
    // noted — we don't send POST/PUT/DELETE unauth (RoE: no state-changing calls).
    const specMethod = (ep.method || "GET").toUpperCase();
    const probeMethod = /^(GET|HEAD)$/.test(specMethod) ? specMethod : "GET";
    const r = await safe(() => probe(full, authHeaders), null as Probe | null);
    if (!r) {
      rows.push(`${probeMethod} ${ep.path} → (gagal)`);
      continue;
    }
    rows.push(`${probeMethod} ${ep.path} → ${r.status}${r.ct ? ` (${r.ct.split(";")[0]})` : ""}${probeMethod !== specMethod ? ` [spec: ${specMethod}]` : ""}`);
    if (!authHeaders && r.status >= 200 && r.status < 300 && /admin|user|account|secret|token|internal|private/i.test(ep.path)) {
      leads.push(`${probeMethod} ${ep.path} → ${r.status} TANPA auth (kandidat broken function-level authorization)`);
    }
    await new Promise((res) => setTimeout(res, 150));
  }
  const leadBlock = leads.length
    ? `\n\n🎯 LEADS (verifikasi manual + counterevidence):\n${[...new Set(leads)].slice(0, 20).map((l) => `• ${l}`).join("\n")}`
    : "\n\n🎯 LEADS: tidak ada endpoint sensitif yang terbuka tanpa auth dari sampel ini.";
  return `🧭 API HUNT ${origin} — ${endpoints.length} endpoint${session ? ` (dengan sesi "${opts.session}")` : " (tanpa auth)"}\n${rows.join("\n")}${leadBlock}\n\n⚠️ 2xx tanpa auth belum tentu vuln (endpoint publik sah) — konfirmasi dampak sebelum finding_add. BOLA butuh 2 identitas (bola_diff).`;
}

// ── suite_hunt: one confirmation runs the whole per-host chain + logs it ─────
// security_hunt + auth_hunt (+ api_hunt when a spec is given), merged into one
// prioritized lead list and written to hunt_log automatically so the next turn
// (or session) starts from memory instead of re-discovering.

/** Pull the `• …` bullets out of each engine's 🎯 LEADS block. */
export function extractLeads(text: string): string[] {
  const after = text.split("🎯 LEADS")[1];
  if (!after) return [];
  const block = after.split("⚠️")[0];
  return block
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("• "))
    .map((l) => l.slice(2).trim());
}

export async function suiteHunt(
  rawUser: unknown,
  urlRaw: string,
  opts: { deep?: boolean; spec?: string; session?: string } = {}
): Promise<string> {
  const url = (urlRaw || "").trim();
  if (!/^https?:\/\//i.test(url)) return "Error: URL harus http(s).";
  if (!targetAllowed(url)) return "Error: SCOPE — suite_hunt hanya untuk lab / engagement aktif / PENTEST_LAB_TARGETS.";

  const sections: string[] = [];
  const leads: string[] = [];

  const sec = await safe(() => securityHunt(rawUser, url, { deep: opts.deep === true }), "");
  if (sec) {
    leads.push(...extractLeads(sec));
    sections.push(`━━ security_hunt ━━\n${sec}`);
  }

  const auth = await safe(() => authHunt(rawUser, url), "");
  if (auth) {
    leads.push(...extractLeads(auth));
    sections.push(`━━ auth_hunt ━━\n${auth}`);
  }

  if (opts.spec || opts.session) {
    const api = await safe(() => apiHunt(rawUser, url, { spec: opts.spec, session: opts.session }), "");
    if (api) {
      leads.push(...extractLeads(api));
      sections.push(`━━ api_hunt ━━\n${api}`);
    }
  }

  const uniq = [...new Set(leads)];
  const status = uniq.length ? "lead" : "dead";
  const note = uniq.length ? `${uniq.length} lead (${uniq[0].slice(0, 100)})` : "tanpa sinyal otomatis (pemetaan bersih)";
  const logged = await safe(async () => {
    const { huntSet } = await import("./huntLog");
    return huntSet(rawUser, url, status, note);
  }, "");

  const leadBlock = uniq.length
    ? `🎯 LEADS GABUNGAN (${uniq.length}) — verifikasi manual + counterevidence:\n${uniq.slice(0, 25).map((l) => `• ${l}`).join("\n")}`
    : "🎯 LEADS: tidak ada sinyal otomatis dari ketiga mesin — tandai dead atau uji manual alur ber-akun.";

  return `🧪 SUITE HUNT ${url}${opts.deep ? " (deep)" : ""}\n\n${leadBlock}\n\n🗂️ ${logged}\n\n${sections.join("\n\n")}`;
}
