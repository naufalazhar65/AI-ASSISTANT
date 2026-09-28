// sweepGate.ts — a sweep-grade ask ("full pentest menyeluruh") must be backed by
// a REAL probe before a report is produced from it.
//
// Live 2026-09-28, three consecutive turns on the same ask (14:48 most clearly):
// the model read the page (http_request, web_audit, js_mine), listed stored
// findings, wrote the report — and never sent a single payload. The honesty stack
// CORRECTED the reply ("klaim 'sudah menguji' di atas belum didukung
// pengujian — tidak ada probe yang berjalan di giliran ini"), which is the
// correct outcome, but a correction is not a fix: the user still got a report
// from a turn that tested nothing.
//
// The prompt already says "JANGAN menutup giliran full pentest tanpa pengujian",
// and the prompt does not hold — the house lesson repeated many times. So this
// is the mechanism that DID work, reused: refuse the deliverable with an
// actionable `Error:` tool result. Proven on 2026-09-25 by `EMPTY_REPORT`: the
// model read `Error: EMPTY_REPORT`, then self-corrected WITHIN THE SAME TURN
// (6 more rounds, poc_verify, finding_add) and re-requested the report
// legitimately. A tool result the model must read beats a rule it may ignore.
//
// Two deliberate bounds:
//  - ONE refusal per turn. Without it a model that cannot probe (a target with
//    no forms, a scope refusal, an outage) would loop until the round budget
//    burned, and the user would get a refusal instead of a report.
//  - The rule is a SWEEP rule. A plain "uji /api/x" or "cek header ini" ask must
//    never be blocked — demanding a probe before answering a single check would
//    be a regression, not a safeguard.
//
// Pure: no IO, no clock, no store. The caller supplies the turn's own facts.
// Unit-tested both ways (blocked and never-blocked).

/** Report tools that would deliver findings from a turn that probed nothing. */
export const SWEEP_REPORT_TOOLS: ReadonlySet<string> = new Set([
  "report_generate",
  "report_save",
  "report_pdf",
  "writeup",
]);

/**
 * Sweep-grade wording. Kept separate from `isPentestAsk` in library.ts on
 * purpose: that one means "any security question" (it drives the round budget),
 * and this one means "go over the whole thing" — the only grade where holding
 * back a report is correct. Indonesian + English, because the model writes both.
 */
export const SWEEP_GRADE_RE =
  /\b(?:menyeluruh|seluruh\s+host|sepenuhnya|penuh(?:an)?|semua\s+(?:endpoint|permukaan|surface|target)|lengkap\s+(?:sekali|penuh)?|kedua\s+bagian|comprehensively|comprehensive|full|throughout|entire\s+(?:app|application|surface|site|target)|all\s+endpoints)\b/i;

/** The turn's executed calls, in the shape `collector.executedCalls` already uses. */
export interface SweepTurnCall {
  name: string;
  executed?: boolean;
}

/** The tools that actually send something and look at what came back. */
const PROBE_TOOLS: ReadonlySet<string> = new Set([
  "poc_verify",
  "bola_diff",
  "auth_matrix",
  "idor_enum",
  "idor_chain",
  "exploit_chain",
  "vuln_compose",
  "workflow_fuzz",
  "race_attack",
  "graphql_hunt",
  "xxe_chain",
  "smuggle_probe",
  "open_redirect_chain",
  "cache_poison_prover",
  "cache_decep",
  "bypass403",
  "otp_probe",
  "otp_hunt",
  "account_recovery",
  "csv_inject",
  "path_traversal",
  "blind_cmdi",
  "ssti_enum",
  "param_fuzz",
  "param_miner",
  "nosql_hunt",
  "blind_ssrf",
  "h2c_smuggle",
  "mass_assignment",
  "csrf_prove",
  "prompt_injection_hunt",
  "llm_hunt",
  "mcp_hunt",
  "dom_xss_prove",
  "ato_prove",
  "auth_hunt",
  "auth_setup",
  "suite_hunt",
  "security_hunt",
  "pentest_scan",
  "sqlmap_scan",
  "retest_run",
]);

/** Did anything in this turn actually send a payload and read the answer? */
export function turnHasProbe(calls: readonly SweepTurnCall[] | undefined): boolean {
  for (const c of calls ?? []) {
    if (c?.executed === false) continue;
    if (c?.name && PROBE_TOOLS.has(c.name)) return true;
  }
  return false;
}

/** Is this ask the grade where holding a report back is correct? */
export function isFullSweepAsk(userText: string, isPentestAsk: (t: string) => boolean): boolean {
  const t = String(userText || "");
  if (!t || !isPentestAsk(t)) return false;
  return SWEEP_GRADE_RE.test(t);
}

export interface SweepGateInput {
  /** The owner's ask for this turn. */
  userText: string;
  /** Reused from library.ts — the existing pentest-ask gate, one owner. */
  isPentestAsk: (t: string) => boolean;
  /** The tool about to run. */
  toolName: string;
  /** Everything executed so far in this turn. */
  executed: readonly SweepTurnCall[] | undefined;
  /** Has this turn already spent its single refusal? */
  alreadyRefused: boolean;
}

export type SweepGateDecision = { allow: true; reason: string } | { allow: false; reason: string };

/**
 * Should this report tool run, given what this turn has actually done?
 *
 * Returns `allow: false` only in the one situation worth blocking: a
 * sweep-grade ask, zero probes so far, a report about to be produced, and the
 * turn's single refusal still unspent. Every other path is `allow: true` with
 * the reason it was allowed, so the decision is diagnosable rather than a
 * silent branch.
 */
export function sweepReportGate(input: SweepGateInput): SweepGateDecision {
  const allow = (reason: string): SweepGateDecision => ({ allow: true, reason });
  const block = (reason: string): SweepGateDecision => ({ allow: false, reason });

  if (!SWEEP_REPORT_TOOLS.has(input.toolName)) return allow("not-a-report-tool");
  if (input.alreadyRefused) return allow("already-refused-once-this-turn");
  if (!isFullSweepAsk(input.userText, input.isPentestAsk)) return allow("not-a-sweep-grade-ask");
  if (turnHasProbe(input.executed)) return allow("this-turn-already-probed");
  return block("sweep-ask-without-any-probe");
}

/**
 * The refusal text. Actionable on purpose and free of jargon: the model reads
 * this as a tool result, and the house pattern (EMPTY_REPORT) is that it
 * corrects itself when the tool tells it exactly what is missing and what to do
 * instead. It names the concrete next step, and it never claims the report is
 * broken — only that it would describe testing this turn did not do.
 */
export function sweepGateRefusal(toolName: string): string {
  return [
    `Error: belum ada pengujian nyata di giliran ini — laporan belum dibuat.`,
    `Permintaanmu adalah sweep menyeluruh, tapi giliran ini hanya membaca (GET/audit/read) tanpa satu pun payload yang dikirim dan dijawab.`,
    `Laporan yang disusun sekarang akan berisi temuan dari giliran lain, bukan hasil pengujian ini — jadi itu akan salah label.`,
    `Langkah berikutnya: kirim payload nyata ke endpoint yang dicurigai (http_request dengan body/param payload, atau prover seperti poc_verify, param_fuzz, idor_enum, ssti_enum, bypass403, path_traversal, otp_hunt, race_attack, workflow_fuzz), cek jawabannya, lalu catat temuan dengan finding_add — baru panggil ${toolName} lagi.`,
    `Kalau memang tidak ada yang bisa diuji (misalnya tidak ada form, atau endpoint-nya menolak semua payload), bilang saja — aku laporkan apa yang sudah dibaca tanpa mengklaim ada pengujian.`,
  ].join(" ");
}
