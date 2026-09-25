// actionReceipt.ts — structured action narration (one owner, 2026-09-25).
//
// The whack-a-mole pattern (live forensics 17:00 → 20:10 → 14:09 → 15:25):
// every fabrication was a NEW wording of the SAME lie ("sudah aku simpan ke
// PDF", "sudah selesai aku tuntaskan", "diuji dengan 12 request yang dikirim",
// "sudah selesai aku jalankan"). Guards chase unbounded language with bounded
// regexes. The structural fix: claims about executed actions are WRITTEN BY THE
// SYSTEM, not the model. This module renders ONE deterministic receipt line per
// executed action tool per turn; the prompt forbids the model from making
// action claims in free prose (the receipt is authoritative; the model adds
// context, never claims).
//
// Receipt is purely ADDITIVE and language-safe: the model never narrates an
// action again, so the narration-guard layer becomes a backstop for drift
// instead of the primary defense. Pure helpers here — tested in
// actionReceipt.test.ts.

/** Tools whose execution the user must see as a system line (probe/write/effector tools). */
export const RECEIPT_TOOLS: ReadonlySet<string> = new Set([
  // probing / proving
  "poc_verify", "pentest_scan", "suite_hunt", "security_hunt", "auth_hunt",
  "ato_prove", "auth_setup", "param_fuzz", "workflow_fuzz", "race_attack",
  "exploit_chain", "smuggle_probe", "dom_xss_prove", "csrf_prove", "bypass403",
  "otp_probe", "otp_hunt", "account_recovery", "csv_inject", "blind_cmdi",
  "ssti_enum", "param_miner", "cache_decep", "nosql_hunt", "blind_ssrf",
  "mass_assignment", "upload_fuzz", "xss_hunt", "idor_enum", "host_header_hunt",
  "llm_hunt", "mcp_hunt", "prompt_injection_hunt", "ws_hunt",
  "cache_poison_prover", "xxe_chain", "open_redirect_chain", "graphql_hunt",
  "vuln_compose", "exploit_build", "crawl", "recon_full", "api_hunt",
  "evidence_capture", "nuclei_custom", "sqlmap_scan", "zap_scan",
  "teamcity_check", "sast_scan",
  // Reads that really TOUCH an endpoint/browser (READ_TOUCH class + prober
  // scans). Live 2026-09-25 drill: fetch_url ran in round 1 but never rendered
  // — a visible action the user never saw. Store reads (finding_list,
  // hunt_log, reminders_list…) still stay OUT.
  "fetch_url", "browser_open", "browser_snapshot", "browser_navigate",
  "browser_click", "browser_type", "cdp_eval", "web_audit", "csp_audit",
  "cors_audit",
  // report / record (deliverables)
  "report_generate", "report_save", "report_pdf", "hardening_pdf",
  "finding_add", "finding_resolve",
  // real-world effectors
  "http_request", "http_session", "cdp_request", "cdp_proxy", "cdp_open",
  "mac_open", "git_commit", "exec_write", "bounty_run", "campaign_run",
]);

const RECEIPT_SUMMARY_MAX = 100;
/** Result text for executions whose tool output is unavailable (side-ledger backfill after transcript summarization). Only ever sourced from recordExecuted, which holds REAL executions. */
export const EXECUTED_PLACEHOLDER = "(dieksekusi)";
/** A sweep can fire dozens of requests — the receipt stays readable. */
const RECEIPT_MAX_LINES = 8;

/** Executed-looking tool result (same semantics as agent's toolResultExecuted — kept local to avoid an agent import cycle). */
function executedResult(content: string): boolean {
  const t = (content || "").trim();
  if (!t) return false;
  // Ledger backfill: recordExecuted only ever holds REAL executions, so the
  // placeholder is trusted evidence even though the tool output is gone.
  if (t === EXECUTED_PLACEHOLDER) return true;
  if (/^(?:Not selected|Not executed|Auto-declined|The user declined)/i.test(t)) return false;
  if (/not available on this provider|refused to execute/i.test(t)) return false;
  return true;
}

function firstLine(s: string): string {
  const line = (s || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
  return line.length > RECEIPT_SUMMARY_MAX ? `${line.slice(0, RECEIPT_SUMMARY_MAX - 1)}…` : line;
}

export type ReceiptRecord = { name: string; args?: string; result?: string; prior?: boolean; at?: Date };

/** Short human summary of what the call was pointed at (path/query), bounded. */
function argDigest(args: string): string {
  if (!args) return "";
  try {
    const j = JSON.parse(args) as Record<string, unknown>;
    const v = j.url ?? j.target ?? j.endpoint ?? j.base_url ?? j.path ?? j.query ?? "";
    if (typeof v === "string" && v) return firstLine(v);
  } catch {
    /* non-JSON args — fall through */
  }
  return "";
}

/**
 * One receipt line per executed RECEIPT_TOOLS call, in execution order.
 * Lines from a PRIOR turn (confirm continuation) are tagged "(turn sebelumnya)"
 * so the narration never blurs which turn did the work. Dedupes identical
 * (name+args) pairs. Returns "" when nothing executed — never decorative.
 * Pure. Tested.
 */
export function actionReceipt(records: ReceiptRecord[]): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const r of records || []) {
    // Receipt lines are the SYSTEM's monopoly: only well-formed tool names
    // render (live 19:30: the model imitated the receipt shape in prose,
    // including a degenerate "⚙️ : (dieksekusi)" line).
    if (!r || !/^[a-z][a-z0-9_]*$/.test(r.name || "")) continue;
    if (!RECEIPT_TOOLS.has(r.name)) continue;
    if (!executedResult(r.result ?? "")) continue;
    const key = `${r.name}|${r.args ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const digest = argDigest(r.args ?? "");
    const head = digest ? `${r.name} → ${digest}` : r.name;
    lines.push(`⚙️ ${head}${r.prior ? " (turn sebelumnya)" : ""}: ${firstLine(r.result ?? "")}`);
  }
  // Header stays turn-neutral: on the confirm path prior-turn lines are merged
  // in and attributed per-line via the "(turn sebelumnya)" tag.
  if (!lines.length) return "";
  const extra = lines.length > RECEIPT_MAX_LINES ? `\n… +${lines.length - RECEIPT_MAX_LINES} aksi lainnya` : "";
  return `\n\nAksi yang benar-benar dijalankan:\n${lines.slice(0, RECEIPT_MAX_LINES).join("\n")}${extra}`;
}



/** Prior-turn lines past this age are history, not "the previous turn" — dropped from the receipt. */
const PRIOR_MAX_AGE_MS = 10 * 60 * 1000;

/** The exact header actionReceipt() renders — one owner for the block marker. */
export const RECEIPT_HEADER = "Aksi yang benar-benar dijalankan:";

/**
 * Remove the system receipt block from a reply. Used by the daily-memory
 * writer: the receipt is SYSTEM-authored narration of tool executions — if it
 * lands in memory files it self-primes later prompts via RAG recall (gotcha
 * 2026-09-07: small models imitate what gets recalled) and eats the 800-char
 * snippet budget meant for real conversation. Pure. Tested.
 */
export function stripReceiptBlock(text: string): string {
  const i = (text || "").indexOf(`\n\n${RECEIPT_HEADER}`);
  return i === -1 ? (text || "") : text.slice(0, i);
}

/**
 * Dedupe receipt groups by name+args, keeping the first occurrence per key but
 * upgrading a placeholder/absent result when a group carries the real tool
 * output (confirm-path records win over ledger backfill). Pure. Tested.
 */
export function mergeReceiptRecords(...groups: ReceiptRecord[][]): ReceiptRecord[] {
  const byKey = new Map<string, ReceiptRecord>();
  const real = (r: ReceiptRecord) => !!r.result && r.result !== EXECUTED_PLACEHOLDER;
  const stalePrior = (r: ReceiptRecord) =>
    !!r.prior && !!r.at && Date.now() - r.at.getTime() > PRIOR_MAX_AGE_MS;
  const fresh = (r: ReceiptRecord) => !stalePrior(r);
  for (const group of groups || []) {
    for (const r of group || []) {
      if (!r?.name) continue;
      const key = `${r.name}|${r.args ?? ""}`;
      const prev = byKey.get(key);
      if (!prev) byKey.set(key, r);
      else if (!real(prev) && real(r)) byKey.set(key, { ...prev, result: r.result });
    }
  }
  return [...byKey.values()].filter(fresh);
}
