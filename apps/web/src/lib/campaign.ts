// Campaign — a bounded, resumable hunt loop over a target list.
//
// Runs suite_hunt per host (security + auth + optional api), skips hosts already
// marked dead/finding in the hunt log, hard-stops on a time budget, and reports
// per-host outcome. This is the "autonomy" piece, deliberately small: it never
// chains beyond recon→hunt→triage (no exploitation), and every step is the same
// scope-gated code the manual tools use.

import { listEngagements, getEngagement, newestActiveEngagement } from "./engagement";
import { readHunt, huntSet, normalizeTarget } from "./huntLog";
import { suiteHunt, extractLeads } from "./hunt";
import { targetAllowed } from "./security";

const MAX_HOSTS_CAP = 12;

/**
 * Hosts for a campaign. With `engagement` → that engagement only. Without it →
 * the NEWEST active engagement (never the union of all active engagements, which
 * once pointed a run at another program's hosts).
 */
function scopeHosts(engagement?: string): { hosts: string[]; label: string } {
  const eng = engagement ? getEngagement(engagement) : newestActiveEngagement();
  if (!eng) return { hosts: [], label: engagement ? `engagement ${engagement} tidak ditemukan` : "tidak ada engagement aktif" };
  if (eng.status !== "active") return { hosts: [], label: `engagement ${eng.id} tidak aktif` };
  const out = new Set<string>();
  for (const s of eng.scope) {
    const h = s.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (h && !h.startsWith("*.")) out.add(h);
  }
  return { hosts: [...out], label: `${eng.id} — ${eng.name}` };
}

/**
 * Status of a host in the hunt log, using the SAME key normalization hunt_log
 * writes with. Pure — unit-tested (the previous inline lookup used a different
 * key and misreported status).
 */
export function huntStatusFor(entries: { target: string; status: string }[], url: string): string | undefined {
  const key = normalizeTarget(url);
  return entries.find((e) => e.target === key)?.status;
}

export type CampaignHostResult = { host: string; status: string; leads: string[] };
export type CampaignOutcome = { results: CampaignHostResult[]; ran: number; leadHosts: number; stop: string; skipped: string[] };

/** Structured campaign run (shared by campaign_run and bounty_run). */
export async function campaignRunDetailed(
  rawUser: unknown,
  opts: { targets?: string[]; engagement?: string; deep?: boolean; max_hosts?: number; max_seconds?: number; stop_on_lead?: boolean; spec?: string; session?: string }
): Promise<{ outcome: CampaignOutcome; log: string[] }> {
  const explicit = (opts.targets || []).map((t) => t.trim()).filter(Boolean);
  const scope = explicit.length ? { hosts: explicit, label: "targets eksplisit" } : scopeHosts(opts.engagement);
  let targets = scope.hosts;
  const lines: string[] = [explicit.length ? "" : `Engagement: ${scope.label}`].filter(Boolean);
  const results: CampaignHostResult[] = [];
  const skipped: string[] = [];
  if (!targets.length) return { outcome: { results, ran: 0, leadHosts: 0, stop: "tidak ada target", skipped }, log: [...lines, `Tidak ada target: ${scope.label}. Beri \`targets\`, atau buat/aktifkan engagement.`] };
  targets = targets.filter((t) => targetAllowed(/^https?:\/\//i.test(t) ? t : `https://${t}`));
  if (!targets.length) return { outcome: { results, ran: 0, leadHosts: 0, stop: "semua target di luar scope", skipped }, log: ["Error: SCOPE — semua target di luar lab/engagement aktif."] };

  const maxHosts = Math.min(MAX_HOSTS_CAP, Math.max(1, Number(opts.max_hosts) || 5));
  const budgetMs = Math.min(30 * 60_000, Math.max(60_000, (Number(opts.max_seconds) || 480) * 1000));
  const started = Date.now();

  const done = new Set(readHunt(rawUser).filter((e) => ["dead", "finding", "lead"].includes(e.status)).map((e) => e.target));

  lines.push(`🚩 CAMPAIGN — maks ${maxHosts} host, budget ${Math.round(budgetMs / 1000)}s${opts.stop_on_lead ? ", stop saat ada lead" : ""}`);
  let ran = 0;
  let stop = "";
  let leadHosts = 0;

  for (const t of targets) {
    if (ran >= maxHosts) { stop = `batas host (${maxHosts}) tercapai`; break; }
    if (Date.now() - started > budgetMs) { stop = "budget waktu habis"; break; }
    const url = /^https?:\/\//i.test(t) ? t : `https://${t}`;
    // Use the SAME normalization hunt_log uses, or the skip/status lookups miss
    // (the stored target has no trailing slash / scheme).
    const key = normalizeTarget(url);
    if (done.has(key)) { skipped.push(t); lines.push(`⏭️ ${t} — dilewati (sudah dead/lead/finding di hunt_log)`); continue; }

    const res = await suiteHunt(rawUser, url, { deep: opts.deep !== false, spec: opts.spec, session: opts.session });
    const st = huntStatusFor(readHunt(rawUser), url) || (/^Error:/.test(res) ? "error" : "?");
    ran++;
    if (/^Error:/.test(res)) {
      results.push({ host: t, status: "error", leads: [] });
      lines.push(`✗ ${t} — ${res.split("\n")[0].slice(0, 100)}`);
      continue;
    }
    const leads = extractLeads(res);
    if (st === "lead") leadHosts++;
    results.push({ host: t, status: st, leads });
    lines.push(`• ${t} → ${st}${leads.length ? ` — ${leads[0].slice(0, 120)}` : ""}`);
    if (opts.stop_on_lead && st === "lead") { stop = "lead ditemukan (stop_on_lead)"; break; }
  }
  return { outcome: { results, ran, leadHosts, stop, skipped }, log: lines };
}

export async function campaignRun(
  rawUser: unknown,
  opts: { targets?: string[]; engagement?: string; deep?: boolean; max_hosts?: number; max_seconds?: number; stop_on_lead?: boolean; spec?: string; session?: string }
): Promise<string> {
  const { outcome, log } = await campaignRunDetailed(rawUser, opts);
  log.push(`\nRingkas: ${outcome.ran} host dijalankan, ${outcome.leadHosts} menghasilkan lead.${outcome.stop ? ` Berhenti: ${outcome.stop}.` : ""}`);
  log.push("Lanjut: uji lead secara manual (CDP/tamper_script) → poc_verify → finding_add. Resume: jalankan campaign lagi (host dead dilewati).");
  return log.join("\n");
}

/** Mark a host dead from the campaign (used when triage confirms a false lead). */
export function campaignMarkDead(rawUser: unknown, host: string, note = "tanpa lead"): string {
  return huntSet(rawUser, host, "dead", note);
}
