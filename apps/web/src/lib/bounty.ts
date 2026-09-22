// bounty_run — one command, draft-only bug-bounty pipeline.
//
// Stages: engagement (authorization) → worklist ranked by ROI → bounded hunt
// campaign → classify leads → DRAFT findings for high-signal leads (+ dup_check)
// → draft report → handoff list of what still needs a human.
//
// Hard boundaries (by design): never submits to a program, never uses
// destructive tools, never bypasses a WAF, never touches out-of-scope hosts.
// Resumable: campaign skips hosts already dead/lead/finding in hunt_log, and the
// run state records progress.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appRoot } from "./users";
import { getEngagement, newestActiveEngagement } from "./engagement";
import { campaignRunDetailed } from "./campaign";
import { rankTargets } from "./roi";
import { addFinding, generateReport, reportPdf } from "./security";
import { dupCheck } from "./dupes";
import { runExploitChain } from "./exploitChains";
import { evidenceCapture } from "./evidence";

type RunState = { lastRun: string; runs: { at: string; engagement: string; hosts: number; leads: number; drafts: number; stop: string }[] };
function stateFile(): string {
  return join(appRoot(), ".data", "bounty-state.json");
}
function readState(): RunState {
  try {
    const s = JSON.parse(readFileSync(stateFile(), "utf8")) as RunState;
    return { lastRun: s.lastRun || "", runs: Array.isArray(s.runs) ? s.runs.slice(0, 10) : [] };
  } catch {
    return { lastRun: "", runs: [] };
  }
}
function writeState(s: RunState): void {
  const f = stateFile();
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, f);
}

/** A lead worth turning into a draft finding (vs. just noise in the handoff). */
export function isHighSignalLead(lead: string): boolean {
  return /BUCKET TERBUKA|REALTIME DB TERBUKA|tanpa HttpOnly|tanpa Secure|tanpa SameSite|TANPA auth|200 TANPA|ter-reflect|open redirect|SQL error|SSTI|command output|terkonfirmasi|PUBLIK|kebocoran|exposed/i.test(
    lead || ""
  );
}

/** One-line, honest verdict from an exploit chain output (skips the header/meta). Pure — tested. */
export function chainSummary(t: string): string {
  const lines = t.split("\n");
  // Aggregate (comma-separated chains) output ends with a Ringkasan block that
  // states how many chains actually ran vs. were skipped — surface THAT first
  // (the header line plus the following count line, e.g. "0 chain dengan
  // langkah nyata · 4 dilewati" + the "TIDAK ADA chain ..." zero-run note).
  const aggIdx = lines.findIndex((l) => /━━ Ringkasan ━━/.test(l.trim()));
  if (aggIdx >= 0) {
    const tail = lines.slice(aggIdx).map((l) => l.trim()).filter(Boolean);
    return tail.join(" · ").slice(0, 140);
  }
  const aggLine = lines.find((l) => /chain dengan langkah nyata|TIDAK ADA chain yang benar-benar dijalankan/.test(l.trim()));
  if (aggLine) return aggLine.trim().slice(0, 140);
  // A skipped chain is a structural no-op (missing sessions/token/credentials).
  // Surface that honest marker FIRST — a fallback to the first non-empty line
  // would otherwise return the "⛓️ EXPLOIT CHAIN: ..." header and read as success.
  const skipped = t.match(/⛔ CHAIN TIDAK DIJALANKAN[^\n]*/);
  if (skipped) return skipped[0].trim().slice(0, 140);
  const findCount = t.match(/📋 FINDINGS SIAP REPORT \((\d+)\)/);
  const sigCount = t.match(/🚨 SIGNALS \((\d+)\)/);
  const verdict = lines.find((l) => /🔴 \d+ potensi|✅ Tidak ada indikasi|✅ Tidak ada bypass|✅ Tidak ada session|✅ Tidak ada akses/.test(l.trim()));
  const bits = [verdict?.trim(), findCount ? `${findCount[1]} finding (belum diverifikasi)` : "", sigCount ? `${sigCount[1]} sinyal` : ""].filter(Boolean).join(" · ");
  if (bits) return bits;
  const first = lines.map((l) => l.trim()).find(Boolean);
  return (first || t).slice(0, 140);
}

function scopeHostsFor(engId?: string): { hosts: string[]; label: string } {
  const eng = engId ? getEngagement(engId) : newestActiveEngagement();
  if (!eng) return { hosts: [], label: engId ? `engagement ${engId} tak ditemukan` : "tak ada engagement aktif" };
  if (eng.status !== "active") return { hosts: [], label: `engagement ${eng.id} tidak aktif` };
  const hosts: string[] = [];
  for (const s of eng.scope) {
    const h = s.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (h && !h.startsWith("*.")) hosts.push(h);
  }
  return { hosts, label: `${eng.id} — ${eng.name}` };
}

export async function bountyRun(
  rawUser: unknown,
  opts: { 
    engagement?: string; 
    targets?: string[]; 
    max_hosts?: number; 
    max_seconds?: number; 
    deep?: boolean; 
    spec?: string; 
    session?: string;
    auto_chain?: boolean;
    auto_evidence?: boolean;
    max_chains?: number;
  } = {}
): Promise<string> {
  const explicit = (opts.targets || []).map((t) => t.trim()).filter(Boolean);
  const { hosts, label } = explicit.length ? { hosts: explicit, label: "targets eksplisit" } : scopeHostsFor(opts.engagement);
  if (!hosts.length) {
    const hint = /tak ada engagement aktif|tak ditemukan|tidak aktif/.test(label)
      ? "Buat dulu dengan engagement_create (name, client, authorization, scope[]), atau beri `targets`."
      : `${label} tidak menghasilkan host konkret (scope wildcard-only seperti *.example.com tidak bisa di-enumerasi) — beri \`targets\` eksplisit.`;
    return `Tidak bisa jalan: ${label}. ${hint}`;
  }
  const ranked = rankTargets(hosts).map((r) => r.host).slice(0, Math.min(12, Math.max(1, Number(opts.max_hosts) || 5)));

  const out: string[] = [`🎯 BOUNTY RUN — ${label}`, `Worklist (prioritas ROI): ${ranked.map((h, i) => `${i + 1}.${h}`).join(", ")}`, ""];

  const { outcome, log } = await campaignRunDetailed(rawUser, {
    targets: ranked,
    deep: opts.deep === true,
    max_hosts: ranked.length,
    max_seconds: opts.max_seconds,
    spec: opts.spec,
    session: opts.session,
  });
  out.push(...log);

  // Classify the leads from every host.
  const allLeads: { host: string; lead: string }[] = [];
  for (const r of outcome.results) for (const l of r.leads) allLeads.push({ host: r.host, lead: l });
  const candidates = allLeads.filter((x) => isHighSignalLead(x.lead));

  // ===== AUTO CHAIN: run exploit_chain on high-signal leads =====
  const chainResults: string[] = [];
  if (opts.auto_chain === true) {
    const maxChains = Math.min(5, Math.max(1, Number(opts.max_chains) || 3));
    let chainCount = 0;
    for (const c of candidates) {
      if (chainCount >= maxChains) break;
      const lead = c.lead.toLowerCase();
      let chainType: "idor" | "auth_bypass" | "ssrf" | "session_fixation" | null = null;
      // Candidate hosts come bare (no scheme) from the campaign — exploit_chain
      // requires a full http(s) URL, so coerce here or every chain would fail
      // with "URL harus http(s)". 
      const targetUrl = /^https?:\/\//i.test(c.host) ? c.host : `https://${c.host}`;
      const chainOpts: Record<string, unknown> = { url: targetUrl };

      // Heuristic: pick chain based on lead content
      if (/idor|bola|object.*level|broken.*access/i.test(lead)) chainType = "idor";
      else if (/auth.*bypass|jwt|alg.*none|token/i.test(lead)) chainType = "auth_bypass";
      else if (/ssrf|server.*side.*request/i.test(lead)) chainType = "ssrf";
      else if (/session.*fix|login.*session/i.test(lead)) chainType = "session_fixation";

      if (chainType) {
        try {
          const chainRes = await runExploitChain(rawUser, chainType, chainOpts);
          // Structural skips (no sessions/creds/setup) must not burn the
          // max_chains budget (audit 2026-09-23) — only real runs count.
          const skipped = /⛔ CHAIN TIDAK DIJALANKAN|0 langkah dijalankan|0 chain dengan langkah nyata/.test(chainRes);
          chainResults.push(`⛓️ ${c.host} (${chainType}): ${chainSummary(chainRes)}`);
          if (!skipped) chainCount++;
        } catch (e) {
          chainResults.push(`⛓️ ${c.host} (${chainType}) error: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    if (chainResults.length) out.push(...chainResults);
  }

  // ===== AUTO EVIDENCE: save REAL evidence (screenshot file) per candidate =====
  const evidenceResults: string[] = [];
  if (opts.auto_evidence === true) {
    for (const c of candidates.slice(0, 5)) {
      try {
        const targetUrl = /^https?:\/\//i.test(c.host) ? c.host : `https://${c.host}`;
        const saved = await evidenceCapture(rawUser, { url: targetUrl });
        const shot = saved.split("\n").map((l) => l.trim()).filter(Boolean).find((l) => l.includes("screenshot")) || saved.split("\n")[0];
        evidenceResults.push(`📸 ${c.host}: ${shot}`);
      } catch (e) {
        evidenceResults.push(`📸 ${c.host} error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (evidenceResults.length) out.push(...evidenceResults);
  }

  // Draft findings for high-signal leads (NOT verified — clearly labelled).
  const drafts: string[] = [];
  for (const c of candidates.slice(0, 10)) {
    const title = `[DRAFT, belum diverifikasi] ${c.lead.slice(0, 120)}`;
    const dup = dupCheck(rawUser, { title: c.lead, target: c.host });
    if (dup.startsWith("⚠️")) {
      drafts.push(`⏭️ ${c.host}: dilewati (kemungkinan duplikat) — "${c.lead.slice(0, 80)}"`);
      continue;
    }
    try {
      const f = addFinding(rawUser, { title, target: c.host, severity: "low", owasp: "A02:2025 Security Misconfiguration", evidence: `[auto dari bounty_run] ${c.lead}`, remediation: "Verifikasi manual lalu tentukan remediasi tepat." });
      drafts.push(`📝 draft ${f.id} — ${c.lead.slice(0, 90)}`);
    } catch (e) {
      drafts.push(`✗ gagal buat draft untuk ${c.host}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  let report = "";
  let pdfReport = "";
  if (drafts.some((d) => d.startsWith("📝"))) {
    try {
      report = generateReport(rawUser, { target: ranked[0] }).split("\n")[0];
    } catch {
      /* best-effort */
    }
    try {
      pdfReport = await reportPdf(rawUser, { target: ranked[0] });
    } catch {
      /* best-effort */
    }
  }
  // Honest coverage (audit 2026-09-23): the report/PDF is scoped to ranked[0]
  // only — drafts on other hosts are NOT in it. Say so instead of implying
  // full coverage.
  const draftHosts = [...new Set(candidates.map((c) => c.host))];
  const uncovered = draftHosts.filter((h) => h !== ranked[0]);
  const coverageNote = uncovered.length
    ? `\n📑 Cakupan laporan: PDF/markdown di atas hanya memuat ${ranked[0]} — draft di ${uncovered.join(", ")} TIDAK termasuk (minta report per host bila perlu).`
    : "";

  // Persist run state (resumable history).
  const st = readState();
  const next: RunState = {
    lastRun: new Date().toISOString(),
    runs: [{ at: new Date().toISOString(), engagement: opts.engagement || label, hosts: outcome.ran, leads: allLeads.length, drafts: drafts.filter((d) => d.startsWith("📝")).length, stop: outcome.stop }, ...st.runs].slice(0, 10),
  };
  writeState(next);

  const handoff: string[] = [];
  if (allLeads.length && !candidates.length) handoff.push("Tinjau lead manual: " + allLeads.slice(0, 5).map((l) => `[${l.host}] ${l.lead.slice(0, 70)}`).join(" | "));
  if (candidates.length) handoff.push("Verifikasi draft dengan flow_run/cdp_request + `poc_verify` sebelum submit.");
  handoff.push("Submit ke program TIDAK diotomasi — lakukan manual (akun + RoE).");
  if (opts.session === undefined) handoff.push("Untuk bug ber-login: jalankan scripts/chrome-debug.sh + login, lalu cdp_status → cdp_request.");

  return [
    out.join("\n"),
    `\n── RINGKASAN ──`,
    `Host dijalankan: ${outcome.ran} · lead: ${allLeads.length} · kandidat: ${candidates.length} · draft finding: ${drafts.filter((d) => d.startsWith("📝")).length}`,
    drafts.length ? `\nDraft/tindak lanjut:\n${drafts.map((d) => `• ${d}`).join("\n")}` : "\nTidak ada kandidat high-signal (lead lain tetap di hunt_log).",
    report ? `\n📄 ${report}` : "",
    pdfReport ? `\n📎 ${pdfReport}` : "",
    coverageNote,
    `\n── HANDOFF (butuh kamu) ──\n- ${handoff.join("\n- ")}`,
    `\n⚠️ Semua draft belum diverifikasi & TIDAK disubmit. Ini pemetaan otomatis, bukan jaminan temuan.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function bountyStatus(): string {
  const s = readState();
  if (!s.runs.length) return "Belum ada bounty_run. Jalankan bounty_run setelah engagement dibuat.";
  return `🗂️ bounty_run terakhir: ${s.lastRun}\n${s.runs.map((r) => `• ${r.at.slice(0, 16)} — ${r.engagement}: ${r.hosts} host, ${r.leads} lead, ${r.drafts} draft${r.stop ? ` (${r.stop})` : ""}`).join("\n")}`;
}
