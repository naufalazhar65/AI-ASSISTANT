// Campaign — a bounded, resumable hunt loop over a target list.
//
// Runs suite_hunt per host (security + auth + optional api), skips hosts already
// marked dead/finding in the hunt log, hard-stops on a time budget, and reports
// per-host outcome. This is the "autonomy" piece, deliberately small: it never
// chains beyond recon→hunt→triage (no exploitation), and every step is the same
// scope-gated code the manual tools use.

import { listEngagements } from "./engagement";
import { readHunt, huntSet, normalizeTarget } from "./huntLog";
import { suiteHunt } from "./hunt";
import { targetAllowed } from "./security";

const MAX_HOSTS_CAP = 12;

function scopeHosts(): string[] {
  const out = new Set<string>();
  for (const e of listEngagements()) {
    if (e.status !== "active") continue;
    for (const s of e.scope) {
      const h = s.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      if (!h || h.startsWith("*.")) continue; // wildcards can't be scanned directly
      out.add(h);
    }
  }
  return [...out];
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

export async function campaignRun(
  rawUser: unknown,
  opts: { targets?: string[]; deep?: boolean; max_hosts?: number; max_seconds?: number; stop_on_lead?: boolean; spec?: string; session?: string }
): Promise<string> {
  const explicit = (opts.targets || []).map((t) => t.trim()).filter(Boolean);
  let targets = explicit.length ? explicit : scopeHosts();
  if (!targets.length) return "Tidak ada target: beri `targets` atau buat engagement aktif dengan scope host konkret.";
  targets = targets.filter((t) => targetAllowed(/^https?:\/\//i.test(t) ? t : `https://${t}`));
  if (!targets.length) return "Error: SCOPE — semua target di luar lab/engagement aktif.";

  const maxHosts = Math.min(MAX_HOSTS_CAP, Math.max(1, Number(opts.max_hosts) || 5));
  const budgetMs = Math.min(30 * 60_000, Math.max(60_000, (Number(opts.max_seconds) || 480) * 1000));
  const started = Date.now();

  const prior = readHunt(rawUser);
  const done = new Set(prior.filter((e) => ["dead", "finding", "lead"].includes(e.status)).map((e) => e.target));

  const lines: string[] = [`🚩 CAMPAIGN — maks ${maxHosts} host, budget ${Math.round(budgetMs / 1000)}s${opts.stop_on_lead ? ", stop saat ada lead" : ""}`];
  let ran = 0;
  let stop = "";
  let leads = 0;

  for (const t of targets) {
    if (ran >= maxHosts) { stop = `batas host (${maxHosts}) tercapai`; break; }
    if (Date.now() - started > budgetMs) { stop = "budget waktu habis"; break; }
    const url = /^https?:\/\//i.test(t) ? t : `https://${t}`;
    // Use the SAME normalization hunt_log uses, or the skip/status lookups miss
    // (the stored target has no trailing slash / scheme).
    const key = normalizeTarget(url);
    if (done.has(key)) { lines.push(`⏭️ ${t} — dilewati (sudah dead/lead/finding di hunt_log)`); continue; }

    const res = await suiteHunt(rawUser, url, { deep: opts.deep === true, spec: opts.spec, session: opts.session });
    const st = huntStatusFor(readHunt(rawUser), url) || (/^Error:/.test(res) ? "error" : "?");
    ran++;
    if (/^Error:/.test(res)) {
      lines.push(`✗ ${t} — ${res.split("\n")[0].slice(0, 100)}`);
      continue;
    }
    if (st === "lead") leads++;
    const firstLead = res.split("🎯 LEADS")[1]?.split("\n").find((l) => l.trim().startsWith("• "))?.trim() || "";
    lines.push(`• ${t} → ${st}${firstLead ? ` — ${firstLead.slice(0, 120)}` : ""}`);
    if (opts.stop_on_lead && st === "lead") { stop = "lead ditemukan (stop_on_lead)"; break; }
  }

  lines.push(`\nRingkas: ${ran} host dijalankan, ${leads} menghasilkan lead.${stop ? ` Berhenti: ${stop}.` : ""}`);
  lines.push("Lanjut: uji lead secara manual (CDP/tamper_script) → poc_verify → finding_add. Resume: jalankan campaign lagi (host dead dilewati).");
  return lines.join("\n");
}

/** Mark a host dead from the campaign (used when triage confirms a false lead). */
export function campaignMarkDead(rawUser: unknown, host: string, note = "tanpa lead"): string {
  return huntSet(rawUser, host, "dead", note);
}
