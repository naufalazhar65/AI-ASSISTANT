/**
 * Central formatter registry — one entry per task type.
 *
 * Each formatter declares:
 *  - `requiredSections`: sections the report MUST have. Missing ones are an
 *    integrity failure (see `validate.ts`), never silently invented.
 *  - `optionalSections`: allowed but not demanded.
 *  - `conciseness`: `report` (structured, may be long) | `answer` (2-4 short
 *    paragraphs, no headings) | `one-liner`.
 *  - `evidence`: `required` (must carry links/quotes/file paths),
 *    `recommended`, or `none`.
 *  - `completionStatus`: whether the format must state delivery/execution
 *    status. `required` is what stops "draft" from reading as "sent".
 *  - `channelRules`: per-channel rendering constraints.
 *
 * A formatter NEVER produces content. It describes the shape the model is asked
 * for (via `guidance()`) and the shape validation enforces. Filling a missing
 * section with invented text is the one thing this module must never do.
 */

import type { FormatChannel, TaskType } from "./taskTypes";

export type Conciseness = "one-liner" | "answer" | "report";
export type EvidenceLevel = "none" | "recommended" | "required";

export interface SectionSpec {
  /** Stable id, used by tests and by the guidance text. */
  id: string;
  /** Heading as it should appear in the answer. */
  title: string;
  /** One-line instruction on what belongs in the section. */
  hint: string;
  /**
   * Other names the model may legitimately use for this section, in any
   * language. Measured live 2026-10-13: asked for "Executive Summary", Agnes
   * wrote "Ringkasan" and "KESIMPULAN" with an emoji prefix. That is PERSONALITY
   * (the brief forbids the formatter from overriding it) and the section really
   * was there — so validation must match MEANING, not a literal string. An
   * exact-match validator would have reported a correct report as broken.
   */
  aliases: readonly string[];
}

export interface ChannelRule {
  /** Extra constraints for a specific channel (Discord/Slack length, mrkdwn…). */
  note: string;
  /** Character budget per message; the caller chunks beyond this. */
  maxChars?: number;
}

export interface FormatterSpec {
  taskType: TaskType;
  /** Template letter from the brief (A=research … J=execution report). */
  template: string;
  label: string;
  requiredSections: readonly SectionSpec[];
  optionalSections: readonly SectionSpec[];
  conciseness: Conciseness;
  evidence: EvidenceLevel;
  completionStatus: "none" | "recommended" | "required";
  channelRules?: Partial<Record<FormatChannel, ChannelRule>>;
  /** Compact instruction block injected into the system prompt. */
  guidance: string;
}

function S(id: string, title: string, hint: string, ...aliases: string[]): SectionSpec {
  return { id, title, hint, aliases: [title.toLowerCase(), ...aliases.map((a) => a.toLowerCase())] };
}

/* ---------------------------------------------------------- section presets */

const REPORT_TITLE = S("title", "Title", "what the report covers, in one line", "judul", "topik", "laporan", "ikhtisar");
const EXEC_SUMMARY = S("executive_summary", "Executive Summary", "2-3 sentences: the answer up front", "ringkasan", "exec summary", "summary", "ikhtisar", "abstrak", "gambaran umum");
const KEY_FINDINGS = S(
  "key_findings",
  "Key Findings",
  "per finding: verified fact, why it matters, publish/event date, direct source link",
  "temuan", "temuan utama", "findings", "hasil riset", "fakta", "poin utama",
);
const CONCLUSION = S("conclusion", "Conclusion", "takeaway + what is still uncertain", "kesimpulan", "simpulan", "takeaway", "penutup", "kesimpulan riset");
const EXEC_STATUS = S(
  "execution_status",
  "Execution Status",
  "research status, finding count when meaningful, Discord delivery status if asked",
  "status eksekusi", "status riset", "status pekerjaan", "status",
);

const CODE_SUMMARY = S("summary", "Summary", "what changed, in two or three sentences", "ringkasan", "ikhtisar", "gambaran perubahan");
const FILES_CHANGED = S("files_changed", "Files Changed", "path per file + why it changed", "file yang berubah", "file diubah", "berkas yang diubah", "file yang disentuh");
const IMPL_DETAILS = S("implementation_details", "Implementation Details", "the approach, in fenced code where relevant", "detail implementasi", "rincian implementasi", "detail teknis", "cara kerja");
const VALIDATION = S("validation", "Validation", "tests actually run and their real results", "validasi", "pembuktian", "hasil test", "hasil pengujian", "bukti pengujian");
const REMAINING = S("remaining_issues", "Remaining Issues", "what is left undone or risky", "masalah tersisa", "sisa masalah", "belum selesai", "catatan tersisa", "risiko tersisa");

const DBG_PROBLEM = S("problem", "Problem", "the observed symptom", "masalah", "gejala", "symptom", "apa yang rusak");
const DBG_ROOT_CAUSE = S("root_cause", "Root Cause", "confirmed cause, or a hypothesis clearly labelled as one", "akar masalah", "akar penyebab", "penyebab", "kenapa terjadi");
const DBG_FIX = S("fix", "Fix", "the change that addresses the root cause", "perbaikan", "solusi", "tindakan", "yang dilakukan");
const DBG_VERIFICATION = S("verification", "Verification", "how you know it is fixed", "verifikasi", "pembuktian", "bukti", "cara memastikan");
const DBG_RISKS = S("remaining_risks", "Remaining Risks", "what could still break", "risiko tersisa", "risiko", "bahaya", "ancaman");

const AUDIT_SCOPE = S("scope", "Scope", "target, files or endpoints reviewed", "cakupan", "lingkup", "target");
const AUDIT_FINDINGS = S(
  "findings",
  "Findings",
  "per finding: title, severity, component+location, description, impact, evidence/repro, remediation",
  "temuan", "hasil audit", "hasil pengujian", "issues",
);
const AUDIT_POSITIVE = S("positive_observations", "Positive Observations", "what is already done well", "positif", "yang sudah benar", "hal positif", "kebaikan");
const AUDIT_LIMITATIONS = S("limitations", "Limitations", "what was not covered and why", "batasan", "keterbatasan", "catatan", "cakupan terbatas");

const TEST_SUMMARY = S("test_summary", "Test Summary", "scope and environment", "ringkasan test", "ringkasan pengujian", "lingkup test");
const TEST_RESULTS = S("results", "Results", "passed / failed / blocked / skipped counts as actually observed", "hasil", "hasil test", "hasil pengujian");
const TEST_FAILED = S("failed_tests", "Failed Tests", "name, expected, actual, evidence, defect reference", "test gagal", "pengujian gagal", "kegagalan", "gagal");
const TEST_CONCLUSION = S("conclusion_test", "Conclusion", "is it green, and on what evidence");

const PENTEST_SUMMARY = S("summary", "Summary", "target + verified/unverified counts from this turn", "ringkasan", "ikhtisar", "ringkasan temuan");
const VERIFIED_FINDINGS = S(
  "verified_findings",
  "Verified Findings",
  "only findings with poc_verify/retest proof this turn or recorded earlier: title, severity, location, evidence",
  "temuan terverifikasi", "temuan terbukti", "temuan valid", "verified",
);
const UNVERIFIED_LEADS = S(
  "unverified_leads",
  "Unverified Leads",
  "candidate signals that are NOT findings yet — never given a severity as if confirmed",
  "dugaan", "kandidat", "sinyal", "leads", "belum terverifikasi", "unverified",
);
const POC_VALIDATION = S("poc_validation", "Validation", "what poc_verify/retest proved, what is still open", "validasi", "pembuktian", "bukti poc", "status validasi");
const PENTEST_ATTACHMENT = S("attachment", "Attachment", "the PDF/md path that really exists from this turn", "lampiran", "file laporan", "pdf");

const PROGRESS_RESULT = S("result", "Result", "what is true right now", "hasil", "capaian");
const PROGRESS_NEXT = S("next_steps", "Next Steps", "what happens next and who does it", "langkah berikut", "selanjutnya", "tindak lanjut");

const SYS_STATUS = S("status", "Status", "each service: up/down/degraded with evidence", "keadaan", "kondisi");
const SYS_NOTES = S("notes", "Notes", "incidents, restarts, quota states that explain the status", "catatan", "insiden");

const DOC_OVERVIEW = S("overview", "Overview", "what the document is and its purpose", "ikhtisar", "gambaran umum", "tentang dokumen", "pengantar");
const DOC_KEY_POINTS = S("key_points", "Key Points", "grouped by topic", "poin utama", "pokok bahasan", "hal penting");
const DOC_DETAILS = S("important_details", "Important Details", "dates, numbers, requirements, decisions", "detail penting", "rincian penting", "angka dan tanggal");
const DOC_CONCLUSION = S("conclusion_doc", "Conclusion", "the document's own conclusion, separate from interpretation");

const CMP_CRITERIA = S("criteria", "Criteria", "what the options are compared on", "kriteria", "dasar perbandingan", "aspek");
const CMP_TABLE = S("table", "Comparison", "a markdown table, one row per option", "perbandingan", "tabel", "table");
const CMP_PROS = S("advantages", "Advantages", "where each option wins");
const CMP_CONS = S("limitations", "Limitations", "where each option loses; mark unavailable data as unavailable");

const STEP_PREREQ = S("prerequisites", "Prerequisites", "what must exist before starting", "prasyarat", "syarat", "yang perlu disiapkan", "kebutuhan awal");
const STEP_STEPS = S("steps", "Steps", "numbered, in the order they are executed", "langkah", "langkah-langkah", "urutan langkah");
const STEP_EXPECTED = S("expected_result", "Expected Result", "what success looks like per step", "hasil yang diharapkan", "hasil harapan");
const STEP_TROUBLE = S("troubleshooting", "Troubleshooting", "only when genuinely useful", "pemecahan masalah", "Jika bermasalah", "saat error");

const TASK_LINE = S("task", "Task", "what was asked", "tugas", "permintaan", "apa yang diminta");
const TASK_ACTIONS = S("actions_taken", "Actions Taken", "the significant operations that really happened", "tindakan yang dilakukan", "aksi", "yang dilakukan", "langkah kerja");
const TASK_RESULT = S("result", "Result", "the verified outcome or artifact", "hasil", "output", "artefak");
const TASK_DELIVERY = S("delivery_status", "Delivery Status", "was the message/file actually sent - never equate draft with sent", "status pengiriman", "status kiriman", "pengiriman");
const TASK_ISSUES = S("remaining_issues", "Remaining Issues", "what is outstanding");

/* ------------------------------------------------------------- registry */

export const FORMATTERS: Record<TaskType, FormatterSpec> = {
  general_chat: {
    taskType: "general_chat",
    template: "B",
    label: "Percakapan",
    requiredSections: [],
    optionalSections: [REPORT_TITLE],
    conciseness: "answer",
    evidence: "none",
    completionStatus: "none",
    guidance: "Keep it conversational: no report headings, no empty section labels. Answer in 1-4 short paragraphs.",
  },
  question_answer: {
    taskType: "question_answer",
    template: "B",
    label: "Jawaban langsung",
    requiredSections: [],
    optionalSections: [],
    conciseness: "answer",
    evidence: "none",
    completionStatus: "none",
    guidance:
      "Answer the question directly in the first sentence. Use bullets only when they genuinely clarify. NO report headings for a simple question.",
  },
  research_report: {
    taskType: "research_report",
    template: "A",
    label: "Laporan riset",
    requiredSections: [REPORT_TITLE, EXEC_SUMMARY, KEY_FINDINGS, CONCLUSION],
    optionalSections: [EXEC_STATUS],
    conciseness: "report",
    evidence: "required",
    completionStatus: "recommended",
    guidance:
      "Structure the answer as: Title, Executive Summary (2-3 sentences), Key Findings (per finding: the verified fact, why it matters, the publish/event date, and the direct source link), Conclusion (takeaway + what remains uncertain). Add Execution Status when the user asked for something to be delivered. Never present an unverified claim as a finding.",
    channelRules: { discord: { note: "Keep each finding on its own line; long reports are split into ordered messages.", maxChars: 2000 } },
  },
  news_and_trends: {
    taskType: "news_and_trends",
    template: "A",
    label: "Laporan berita & tren",
    requiredSections: [REPORT_TITLE, EXEC_SUMMARY, KEY_FINDINGS, CONCLUSION],
    optionalSections: [EXEC_STATUS],
    conciseness: "report",
    evidence: "required",
    completionStatus: "recommended",
    guidance:
      "Structure as: Title, Executive Summary, Key Findings with source links, Conclusion. Separate VERIFIED TRENDS from ordinary news coverage, and never call something viral without evidence of virality (spread, volume, or a stated source). If you could not verify virality, say so plainly.",
    channelRules: { discord: { note: "One finding per line.", maxChars: 2000 } },
  },
  document_summary: {
    taskType: "document_summary",
    template: "G",
    label: "Ringkasan dokumen",
    requiredSections: [DOC_OVERVIEW, DOC_KEY_POINTS, DOC_DETAILS, DOC_CONCLUSION],
    optionalSections: [],
    conciseness: "report",
    evidence: "recommended",
    completionStatus: "none",
    guidance:
      "Structure as: Overview, Key Points grouped by topic, Important Details (dates, numbers, requirements, decisions), Conclusion. Preserve the source's meaning; label any added interpretation as interpretation.",
  },
  document_analysis: {
    taskType: "document_analysis",
    template: "G",
    label: "Analisis dokumen",
    requiredSections: [DOC_OVERVIEW, DOC_KEY_POINTS, DOC_DETAILS, DOC_CONCLUSION],
    optionalSections: [S("interpretation", "Interpretation", "clearly separated from what the document states", "interpretasi", "tafsir", "analisis tambahan")],
    conciseness: "report",
    evidence: "recommended",
    completionStatus: "none",
    guidance:
      "Structure as: Overview, Key Points by topic, Important Details, Conclusion. Keep the document's own statements separate from your interpretation, and label the latter.",
  },
  coding_result: {
    taskType: "coding_result",
    template: "C",
    label: "Hasil implementasi kode",
    requiredSections: [CODE_SUMMARY, FILES_CHANGED, IMPL_DETAILS, VALIDATION],
    optionalSections: [REMAINING],
    conciseness: "report",
    evidence: "required",
    completionStatus: "required",
    guidance:
      "Structure as: Summary, Files Changed (path + why), Implementation Details, Validation (the tests you actually ran and their real results), Remaining Issues. Never claim code was changed, tests passed, or a publish succeeded without evidence from this turn. Put every code block in a fenced block WITH a language identifier.",
    channelRules: { discord: { note: "Fenced code blocks are fine but keep them short; split across messages rather than truncating.", maxChars: 2000 } },
  },
  debugging_report: {
    taskType: "debugging_report",
    template: "D",
    label: "Laporan debug",
    requiredSections: [DBG_PROBLEM, DBG_ROOT_CAUSE, DBG_FIX, DBG_VERIFICATION],
    optionalSections: [DBG_RISKS],
    conciseness: "report",
    evidence: "required",
    completionStatus: "required",
    guidance:
      "Structure as: Problem, Root Cause (state clearly whether it is CONFIRMED or a HYPOTHESIS), Fix, Verification, Remaining Risks. Keep confirmed facts and assumptions in separate lines.",
  },
  code_review: {
    taskType: "code_review",
    template: "E",
    label: "Code review",
    requiredSections: [AUDIT_SCOPE, AUDIT_FINDINGS],
    optionalSections: [AUDIT_POSITIVE, AUDIT_LIMITATIONS],
    conciseness: "report",
    evidence: "required",
    completionStatus: "none",
    guidance:
      "Structure as: Scope, Findings (per finding: title, priority, file/function + location, description, impact, evidence, remediation), then Positive Observations and Limitations. Do not invent vulnerabilities, evidence, severity, or repro steps; mark suspected vs confirmed explicitly.",
  },
  security_audit: {
    taskType: "security_audit",
    template: "E",
    label: "Security audit",
    requiredSections: [AUDIT_SCOPE, AUDIT_FINDINGS],
    optionalSections: [EXEC_SUMMARY, AUDIT_POSITIVE, AUDIT_LIMITATIONS],
    conciseness: "report",
    evidence: "required",
    completionStatus: "recommended",
    guidance:
      "Structure as: Scope, Executive Summary, Findings (per finding: title, severity, component/file + location, description, impact, evidence/repro, remediation), Positive Observations, Limitations. Every finding needs a severity. Never fabricate a vulnerability, its evidence, or its severity; distinguish suspected from confirmed, and say when nothing was confirmed.",
    channelRules: { discord: { note: "One finding per line, severity bold at the start.", maxChars: 2000 } },
  },
  pentest_report: {
    taskType: "pentest_report",
    template: "D",
    label: "Laporan pentest",
    requiredSections: [PENTEST_SUMMARY, POC_VALIDATION],
    optionalSections: [VERIFIED_FINDINGS, UNVERIFIED_LEADS, PENTEST_ATTACHMENT],
    conciseness: "report",
    evidence: "required",
    completionStatus: "required",
    guidance:
      "Structure as: Summary (target + verified/unverified counts from THIS turn), Verified Findings (only findings with poc_verify/retest proof or already recorded — each: title, severity, location, evidence), Unverified Leads (candidate signals labelled as candidates, NEVER given a confirmed severity), Validation (what was proven, what is still open), Attachment (the PDF/md path that really exists from this turn). Never print a password, token, session cookie, NIK, or other secret value — mask or omit it. Never claim a dump, bypass, or access succeeded without the evidence line that proves it.",
    channelRules: { discord: { note: "One finding per line, severity bold at the start.", maxChars: 2000 } },
  },
  test_report: {
    taskType: "test_report",
    template: "F",
    label: "Laporan test",
    requiredSections: [TEST_SUMMARY, TEST_RESULTS, TEST_FAILED, TEST_CONCLUSION],
    optionalSections: [],
    conciseness: "report",
    evidence: "required",
    completionStatus: "required",
    guidance:
      "Structure as: Test Summary (scope + environment), Results (passed/failed/blocked/skipped as actually observed), Failed Tests (name, expected, actual, evidence, defect ref), Conclusion. NEVER invent test counts and NEVER claim success when the tests were not run — if they were not run, say so in Results.",
  },
  comparison: {
    taskType: "comparison",
    template: "H",
    label: "Perbandingan",
    requiredSections: [CMP_CRITERIA, CMP_TABLE],
    optionalSections: [CMP_PROS, CMP_CONS, S("recommendation", "Recommendation", "only when asked, and only when the evidence supports it", "rekomendasi", "saran", "pilihan terbaik")],
    conciseness: "report",
    evidence: "recommended",
    completionStatus: "none",
    guidance:
      "Use a markdown table with one row per option and a criteria column, then Advantages, Limitations, and Recommendation (only if asked and evidence-supported). Mark missing data as 'unavailable' — never invent it.",
  },
  step_by_step_guide: {
    taskType: "step_by_step_guide",
    template: "I",
    label: "Panduan langkah",
    requiredSections: [STEP_PREREQ, STEP_STEPS],
    optionalSections: [STEP_EXPECTED, STEP_TROUBLE],
    conciseness: "report",
    evidence: "recommended",
    completionStatus: "none",
    guidance:
      "Structure as: Prerequisites, then numbered Steps in execution order, Expected Result per step, Troubleshooting when useful. Include exact commands/code where relevant. Never merge several unrelated procedures into one paragraph.",
  },
  task_execution_report: {
    taskType: "task_execution_report",
    template: "J",
    label: "Laporan eksekusi",
    requiredSections: [TASK_LINE, TASK_ACTIONS, TASK_RESULT, TASK_DELIVERY],
    optionalSections: [TASK_ISSUES],
    conciseness: "report",
    evidence: "required",
    completionStatus: "required",
    guidance:
      "Structure as: Task, Actions Taken (the significant operations that really happened), Result (the verified outcome/artifact), Delivery Status (was it actually sent — a draft is not a delivery, an attempt is not a success), Remaining Issues.",
  },
  discord_message: {
    taskType: "discord_message",
    template: "B",
    label: "Pesan Discord",
    requiredSections: [],
    optionalSections: [],
    conciseness: "one-liner",
    evidence: "none",
    completionStatus: "none",
    guidance: "This is a short message for a chat channel: plain, brief, no report structure.",
  },
  status_update: {
    taskType: "status_update",
    template: "J",
    label: "Update status",
    requiredSections: [TASK_RESULT, TASK_DELIVERY],
    optionalSections: [TASK_ACTIONS, TASK_ISSUES],
    conciseness: "answer",
    evidence: "recommended",
    completionStatus: "required",
    guidance: "State what is true right now: the verified outcome and the delivery/execution status. No padding, no invented progress.",
  },
  progress_update: {
    taskType: "progress_update",
    template: "J",
    label: "Update progres",
    requiredSections: [PROGRESS_RESULT],
    optionalSections: [PROGRESS_NEXT, TASK_ISSUES],
    conciseness: "answer",
    evidence: "recommended",
    completionStatus: "required",
    guidance: "State what is done, what is in progress, and what is next — each grounded in this turn's real execution. Never report a step as done when it only started.",
  },
  system_status: {
    taskType: "system_status",
    template: "H",
    label: "Status sistem",
    requiredSections: [SYS_STATUS],
    optionalSections: [SYS_NOTES],
    conciseness: "answer",
    evidence: "recommended",
    completionStatus: "none",
    guidance: "State each service's state (up/down/degraded) with the evidence for it (health check, restart time, quota state). Distinguish measured state from assumption.",
  },
  error_report: {
    taskType: "error_report",
    template: "D",
    label: "Laporan error",
    requiredSections: [DBG_PROBLEM, DBG_ROOT_CAUSE],
    optionalSections: [DBG_FIX, DBG_VERIFICATION, DBG_RISKS],
    conciseness: "answer",
    evidence: "required",
    completionStatus: "required",
    guidance:
      "Report the failure honestly: what broke (with the real error text), what caused it (confirmed vs hypothesis), what you did about it, and what is still broken. NEVER dress a failure up as a success.",
  },
};

/**
 * Every section label the models are allowed to use, in any language.
 * The renderer uses this to BOLD a label line it recognises, which is what makes
 * "📊 KESIMPULAN" and "## Conclusion" read the same on Discord without the
 * formatter inventing or renaming anything.
 */
export const SECTION_LABELS: ReadonlySet<string> = new Set(
  Object.values(FORMATTERS).flatMap((f) => orderedSections(f).flatMap((s) => s.aliases)),
);

export function formatterFor(taskType: TaskType): FormatterSpec {
  return FORMATTERS[taskType];
}

/**
 * Sections in declared report order (required first, then optional, de-duped).
 * The order check in `validate.ts` runs over this list, so an OPTIONAL section
 * that appears in the wrong place is still reported — an out-of-order
 * "Conclusion" before "Scope" is a readability defect even when Conclusion is
 * not mandatory.
 */
export function orderedSections(spec: FormatterSpec): SectionSpec[] {
  const seen = new Set<string>();
  const out: SectionSpec[] = [];
  for (const section of [...spec.requiredSections, ...spec.optionalSections]) {
    if (seen.has(section.id)) continue;
    seen.add(section.id);
    out.push(section);
  }
  return out;
}