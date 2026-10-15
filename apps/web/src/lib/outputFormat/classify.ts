/**
 * Deterministic task classification.
 *
 * Rules of the house (learned the hard way in this repo — the agent's honesty
 * guards only work because they never guess):
 *  1. ZERO extra LLM calls. Everything below is regex + the real execution
 *     outcome. A formatter that needs a model round-trip to decide a shape is
 *     a formatter that adds latency and cost to every single turn.
 *  2. Never LABEL a simple question as a report. `question_answer` and
 *     `general_chat` stay short; over-formatting is itself a defect.
 *  3. Never LABEL a research ask as general chat, and never label a coding ask
 *     as a research report (the two mistakes the brief calls out explicitly).
 *  4. The real execution outcome wins over the ask's wording: a turn whose tool
 *     result is an error is an `error_report` whatever it was asked as.
 *
 * Inputs are the four things the brief names as legitimate context: the task
 * (`askText`), the original user request, the responsible agent, and the real
 * execution result (`executedTools` / `toolError`).
 */

import { detectDelegation } from "../delegation";
import type { Classification, ClassificationBasis, FormatChannel, TaskType } from "./taskTypes";

export interface ClassifyInput {
  /** The user's own words for this turn (last user message). */
  askText: string;
  /** Trio member running the turn, when known (`mia` | `agnes` | `michelle`). */
  agent?: string;
  /** Where the answer will be delivered. Affects shape, never the label. */
  channel?: FormatChannel;
  /** Tool names that really ran this turn (from the collector, not the prose). */
  executedTools?: readonly string[];
  /** True when a tool result in this turn was an error/refusal. */
  toolError?: boolean;
  /** The assistant's answer, used only for escape hatches (JSON body, etc.). */
  answer?: string;
}

function lower(v: string | undefined): string {
  return (v ?? "").toLowerCase();
}

/* ---------------------------------------------------------------- vocabulary */

/** Explicit "give me a report/laporan" request. */
const REPORT_RE = /\b(laporan|report|riset|research|study|analisis|analysis)\b/i;
/** Summarise a document/text the user supplied or linked. */
const SUMMARIZE_RE = /\b(rangkum|ringkas|rangkuman|ringkasan|resume|summary|summarize|summarise)\b/i;
/** Compare two or more options. */
const COMPARE_RE = /\b(bandingkan|bandingkan|perbandingan|compare|comparison|vs\b|versus)\b/i;
/** Step-by-step / how-to. */
const STEPS_RE = /\b(langkah[- ]?langkah|step[- ]?by[- ]?step|cara\s+(itu|begini|agar)|bagaimana\s+cara|how\s+to|checklist|tutorial|panduan|guide)\b/i;
/** News / trend / "what's going viral". */
const TRENDS_RE = /\b(berita|news|tren|trend|viral|hangat|popular|sekarang lagi|terbaru|update)\b/i;
/** Coding verbs that imply real work, not an explanation. */
const CODE_RE = /\b(buatkan|buat|bikin|tulis|tuliskan|implement|implementasi|refactor|refactoring|edit|ubah|perbaiki|fix|debug|patch|commit|deploy)\b/i;
/** Pure explanation questions ("apa itu X", "gimana cara kerja X"). */
const EXPLAIN_RE = /\b(apa\s+(itu|bedanya|bedanya)|kenapa|mengapa|gimana\s+(cara\s+kerja| workings?)|how\s+does|what\s+is|jelaskan|explain)\b/i;
/** Status/heartbeat style asks. */
const STATUS_RE = /\b(status|keadaan|kabar|beritahari|update|progress|progres)\b/i;
/** Execution+delivery report asks — "do X and report back". */
const DELIVERY_RE = /\b(kirim|send|delivery|antar|share|broadcast|post ke|buat(?:kan)? laporan)\b/i;
const DELIVER_ONLY_RE = /\b(kirim|send|antar|broadcast|post ke)\b/i;
const REPORT_ONLY_RE = /\b(buat(?:kan)?|buat|hasilkan|hasil)\b/i;

/** Errors worth an error-report shape. */
const ERROR_RE = /\b(error|errored|gagal|failed|failure|exception|traceback|stack\s*trace|timeout|timed\s*out|crash)\b/i;
/** Test vocabulary. */
const TEST_RE = /\b(test|testing|tests|unit\s*test|integration\s*test|e2e|coverage|lint|typecheck|ci)\b/i;
/** Code-review vocabulary. */
const REVIEW_RE = /\b(review|code\s*review|audit|reviewer|tinjau|evaluasi\s+kode)\b/i;
/**
 * Security vocabulary — mirrors delegation.ts PENTEST_RE on purpose and adds the
 * plain-language audit words ("audit keamanan", "review keamanan", "temuan").
 * Missing those was a real classification bug: a security-audit ask with
 * findings vocabulary classified as general chat, which strips the mandatory
 * severity/evidence sections.
 */
const SECURITY_RE =
  /\b(pentest|penetrasi|penetration|kerentanan|vulnerab\w*|exploit|nmap|sqlmap|metasploit|burp|cve|payload|bypass|xss|sqli|csrf|idor|ssrf|rce|traversal|injection|hacking|nuclei|ffuf|dirb|nikto|hydra|owasp|fuzz|scanner|audit|keamanan|security|red.?team)\b/i;
/** A finding-shaped security ask implies the audit template. */
const FINDINGS_RE = /\b(temuan|findings?|kerentanan|vuln|severity|critical|high|medium|low)\b/i;
/** Deliverable signal: the ask wants a report FILE, not just findings prose. */
const PDF_RE = /\b(pdf|lampiran|attachment|deliverable)\b/i;
const REPORT_TOOL_RE = /^(report_generate|report_save|report_pdf)$/;
/** Progress-of-work asks (distinct from a point-in-time status). */
const PROGRESS_RE = /\b(progress|progres|kemajuan|perkembangan|sejauh\s+mana|sudah\s+sampai\s+mana)\b/i;
/** System-health asks (distinct from task status). */
const SYSSTATUS_RE = /\b(sistem|system|server|layanan|service|bot|instance)\b/i;

/* ------------------------------------------------------- explicit formats */

function explicitFormatOf(ask: string): Classification["explicitFormat"] {
  if (/\b(json)\b/i.test(ask) && /\b(kasih|beri|balas|return|output|formatted?|format)\b|\bjson\b/i.test(ask)) return "json";
  if (/\b(tabel|table)\b/i.test(ask)) return "table";
  if (/\b(checklist|check\s*list|daftar\s+cek)\b/i.test(ask)) return "checklist";
  if (/\b(markdown|md)\b/i.test(ask)) return "markdown";
  return undefined;
}

/**
 * A JSON request is only honoured when the answer really is JSON. The model
 * sometimes wraps it in prose; in that case we must NOT try to reformat it
 * (that is exactly the "formatter destroys the original result" failure).
 */
function answerIsJson(answer: string | undefined): boolean {
  if (!answer) return false;
  const t = answer.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------- heuristics */

/** Short conversational asks must stay conversational. */
function looksConversational(ask: string, executed: number): boolean {
  const t = ask.trim();
  if (!t) return true;
  if (executed > 0) return false;
  if (t.length > 320) return false;
  if (/\?$/.test(t) && !/\b(laporan|report|bandingkan|banding|tabel|checklist|ringkas|rangkum)\b/i.test(t)) return true;
  if (/\b(halo|hai|hi|hey|hei|oke|ok|thanks|makasih|terima\s+kasih|bye|sampai\s+jumpa)\b/i.test(t)) return true;
  return false;
}

/** Document-oriented asks (a file/link is the subject). */
function looksDocumentTask(ask: string): boolean {
  return /\b(dokumen|document|file|pdf|laporan\s+ini|artikel\s+ini|transkrip|notulen|isi\s+file|baca\s+file)\b/i.test(ask);
}

/* ------------------------------------------------------------- classifier */

export function classifyTask(input: ClassifyInput): Classification {
  const ask = lower(input.askText);
  const executed = input.executedTools?.length ?? 0;
  const hasToolError = input.toolError === true;

  const finish = (taskType: TaskType, basis: ClassificationBasis, signal: string): Classification => ({
    taskType,
    basis,
    signal,
    ...(explicitFormatOf(ask) ? { explicitFormat: explicitFormatOf(ask) } : {}),
  });

  // 1. Real failure. An error report must never read as a success report -- but
  //    this must NOT erase the shape of a report-shaped ask. Measured live
  //    2026-10-13: a security audit hit two `finding_add` errors and the whole turn
  //    became error_report, whose "answer" conciseness suppressed every section on
  //    a turn that still had real findings. The "failure must not read as success"
  //    rule is already enforced by the success-claimed-on-failure check in
  //    validate.ts, so the label override was both redundant and lossy. It now only
  //    applies when no strong report signal is present.
  const strongReportSignal =
    SECURITY_RE.test(ask) || REPORT_RE.test(ask) || TEST_RE.test(ask) || REVIEW_RE.test(ask) || CODE_RE.test(ask);
  if (hasToolError && !strongReportSignal) return finish("error_report", "outcome", "tool-error");

  // 2. Explicit user format request. JSON wins outright when the body is JSON.
  const fmt = explicitFormatOf(ask);
  if (fmt === "json" && answerIsJson(input.answer)) {
    return { taskType: "question_answer", basis: "explicit", signal: "explicit-json", explicitFormat: "json" };
  }
  if (fmt === "table" && /\b(bandingkan|bandingkan|compare|vs\b|versus)\b/i.test(ask)) {
    return finish("comparison", "explicit", "explicit-table-compare");
  }

  // 3. Pentest report: a security ask that wants a DELIVERABLE (PDF/laporan file)
  //    or whose turn actually recorded/proved findings. Sits above the generic
  //    security_audit so "full pentest ... dan buatkan report pdf nya" gets the
  //    verified-vs-unverified split instead of the flat findings list. A probe
  //    turn with no deliverable signal stays an audit.
  if (
    SECURITY_RE.test(ask) &&
    (PDF_RE.test(ask) || (input.executedTools ?? []).some((t) => REPORT_TOOL_RE.test(t)))
  ) {
    return finish("pentest_report", "workflow", "pentest-deliverable");
  }

  // 4. Security testing outranks everything: it has mandatory finding/severity
  //    requirements, so a misclassification would strip them.
  if (SECURITY_RE.test(ask) && (FINDINGS_RE.test(ask) || REVIEW_RE.test(ask) || REPORT_RE.test(ask))) {
    return finish("security_audit", "workflow", "security-vocab");
  }

  // 5. Delegation tells us WHO is answering; the vocabulary tells us the shape.
  //    Michelle = code, Agnes = research. We never route research to the code
  //    template or vice versa — the two error cases the brief names.
  const delegated = detectDelegation(input.askText ?? "");
  const responsible = delegated?.agent ?? input.agent;

  // 5. Test & review shapes, checked before the generic coding shape.
  if (TEST_RE.test(ask) && (CODE_RE.test(ask) || responsible === "michelle")) {
    return finish("test_report", "workflow", "test-vocab");
  }
  if (REVIEW_RE.test(ask) && CODE_RE.test(ask) && responsible !== "agnes") {
    return finish("code_review", "workflow", "review-vocab");
  }
  if (ERROR_RE.test(ask) && CODE_RE.test(ask)) {
    return finish("debugging_report", "workflow", "debug-vocab");
  }

  // 6. Comparison is its own shape: it needs a table, not prose sections.
  if (COMPARE_RE.test(ask)) return finish("comparison", "workflow", "compare-vocab");

  // 7. Document work (summary/analysis of supplied content) before generic
  //    summarising, which is often just "rangkum jawaban tadi".
  if (looksDocumentTask(ask)) {
    if (/analis|analisis|analysis/i.test(ask)) return finish("document_analysis", "workflow", "document-analyze");
    if (SUMMARIZE_RE.test(ask)) return finish("document_summary", "workflow", "document-summarize");
  }

  // 8. Research: a real research ask is a REPORT, never plain chat.
  if (TRENDS_RE.test(ask) && (REPORT_RE.test(ask) || responsible === "agnes")) {
    return finish("news_and_trends", "workflow", "trends-vocab");
  }
  if (REPORT_RE.test(ask) || responsible === "agnes") {
    // Agnes on a bare "cari tahu X" is research; a one-line fact stays short.
    if (!looksConversational(ask, executed)) return finish("research_report", "workflow", "research-vocab");
  }

  // 9. Step-by-step guides.
  if (STEPS_RE.test(ask)) return finish("step_by_step_guide", "workflow", "steps-vocab");

  // 10. Pure execution + delivery reporting (automation/office/webhook turns).
  if (DELIVERY_RE.test(ask) && (executed > 0 || /kirim|send|broadcast|antar/i.test(ask))) {
    if (DELIVER_ONLY_RE.test(ask) && !REPORT_ONLY_RE.test(ask) && executed === 0) {
      return finish("discord_message", "workflow", "delivery-only");
    }
    return finish("task_execution_report", "workflow", "delivery-vocab");
  }

  // 11. Coding work (Michelle, or an explicit build verb) — after every report
  //     shape above, so a coding ask can never fall into a research template.
  if (responsible === "michelle" || (CODE_RE.test(ask) && executed > 0)) {
    return finish("coding_result", "workflow", "coding-vocab");
  }

  // 12. Progress-of-work vs point-in-time status vs system health. Progress asks
  //     ("sudah sampai mana") need done/doing/next, not a status snapshot; a
  //     system-health ask needs per-service state, not task status.
  if (PROGRESS_RE.test(ask) && executed > 0) return finish("progress_update", "workflow", "progress-vocab");
  if (SYSSTATUS_RE.test(ask) && /\bstatus\b/i.test(ask)) return finish("system_status", "workflow", "system-status-vocab");
  if (STATUS_RE.test(ask) && executed > 0) return finish("status_update", "workflow", "status-vocab");

  // 13. Explanation questions stay SHORT — no report headings.
  if (EXPLAIN_RE.test(ask)) return finish("question_answer", "workflow", "explain-vocab");
  if (looksConversational(ask, executed)) return finish("question_answer", "fallback", "conversational");

  // 14. Something happened (tools ran) without a clear shape: report the work.
  if (executed > 0) return finish("task_execution_report", "outcome", "tools-ran");

  return finish("general_chat", "fallback", "default");
}