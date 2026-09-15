// Security Hunt — one-shot autonomous recon + audit for an in-scope host.
// Orchestrates the existing tools (web/csp/cors audit, content discovery, crawl,
// JS mining, hidden-param discovery) into a single structured, actionable report.
// Active → write/confirm; scope-gated (targetAllowed); bounded + low-rate.
import { targetAllowed } from "./security";
import { webAudit, corsAudit, cspAudit } from "./security";
import { contentDiscover, crawlSite, jsMine } from "./recon";
import { paramDiscover } from "./paramFuzz";

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
