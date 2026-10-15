/**
 * Compact prompt-side guidance.
 *
 * This is the ONLY way the formatter influences the model's writing, and it is
 * deliberately a static block rather than a per-turn prompt build: this repo's
 * Groq path already sits close to the request-size limit (free tier 413s at
 * ~37k tokens with persona + tools), so the block stays small and is only added
 * for the channels that render markdown at all. Voice is excluded -- a spoken
 * answer must never be a report.
 *
 * WHY THIS BLOCK IS CHANNEL-AWARE (measured live 2026-10-13, Discord):
 * the pre-existing channel hints already say "keep every reply short and
 * natural", "do NOT invent heading levels" and "do not use markdown characters
 * in normal prose". A first version of this block asked for section labels
 * without saying how to write them; the model resolved the conflict in favour
 * of the channel rule and produced ZERO headings -- the audit line read
 * "research_report/A discord: 0 heading(s) as bold". The classification was
 * right; the writing instruction lost. So:
 *   1. the override is stated EXPLICITLY, and
 *   2. the syntax matches what the channel can actually render.
 *
 * House rule that also applies here: small models imitate CONCRETE shapes. So
 * each report family gets one short shape to imitate, and no BAD example is ever
 * quoted (a quoted anti-pattern gets copied verbatim by these models).
 */

import { FORMATTERS } from "./registry";
import type { FormatChannel } from "./taskTypes";

/** Per report family: section list + the literal syntax + one shape to imitate. */
const FAMILIES: Array<{ types: string; sections: string; shape: string }> = [
  {
    types: "research_report, news_and_trends",
    sections:
      "Title · Executive Summary (2-3 sentences) · Key Findings (each: verified fact, why it matters, date, DIRECT link) · Conclusion (takeaway + uncertainty) · Execution Status only if delivery was asked.",
    shape: [
      "**Title** — one line",
      "**Executive Summary** — 2-3 sentences",
      "**Key Findings**",
      "1. **<finding title>** — verified fact, why it matters, publish/event date, then the DIRECT link: https://source.example/article",
      "2. **<finding title>** — ... https://source.example/other",
      "**Conclusion** — takeaway + what is still uncertain",
    ].join("\n"),
  },
  {
    types: "security_audit, code_review",
    sections:
      "Scope · Findings (each: title · severity · component+location · description · impact · evidence/repro · remediation) · Positive Observations · Limitations. Every finding needs a severity. Never invent a vulnerability, its evidence or its severity; say 'suspected' or 'confirmed'.",
    shape: [
      "**Scope** — https://host.example, 4 endpoint diuji",
      "**Findings**",
      "1. **CRITICAL 9.8** `GET /api/cari-berita?q=` — SQLi: dump tabel users + password plaintext; bukti: poc_verify 3/3 stabil",
      "2. **HIGH 7.5** `GET /api/dokumen` — broken access control via header x-user-role; 200 tanpa auth vs 403 dengan auth",
      "3. **MEDIUM 6.1** `POST /api/pengaduan` — stored XSS: payload tersimpan mentah",
      "**Limitations** — hanya 4 endpoint; belum ada uji race/konkurensi",
    ].join("\n"),
  },
  {
    types: "pentest_report",
    sections:
      "Summary · Verified Findings (proof + severity) · Unverified Leads (candidates only) · Validation · Attachment. Mask secrets.",
    shape: [
      "**Summary** — 8 temuan: 5 terverifikasi, 3 kandidat",
      "1. **CRITICAL 9.8** SQLi `GET /api/x` — poc_verify 3/3",
    ].join("\n"),
  },
  {
    types: "coding_result, test_report",
    sections:
      "Summary · Files Changed (path + why) · Implementation Details · Validation (tests you ACTUALLY ran + real results) · Remaining Issues. Never claim code changed, tests passed or a publish succeeded without evidence from this turn. Fence code blocks with a language id.",
    shape: "1. `apps/web/src/lib/x.ts` — ditambah parser baru; validasi: 12 test lulus, 1 gagal (namanya)",
  },
  {
    types: "debugging_report, error_report",
    sections:
      "Problem (real error text) · Root Cause (CONFIRMED or HYPOTHESIS) · Fix · Verification · Remaining Risks. Never dress a failure up as a success.",
    shape: "1. **CONFIRMED** — akar masalah ada di seed yang tidak di-migrate; hipotesis kedua (race) ruled out lewat log",
  },
  {
    types: "task_execution_report, status_update",
    sections:
      "Task · Actions Taken (what really happened) · Result (verified outcome/artifact) · Delivery Status (a draft is NOT a delivery, an attempt is NOT a success) · Remaining Issues.",
    shape: "1. **Result** — 1 file PDF 293 KB benar-benar ada di folder laporan; delivery: terkirim ke #lab",
  },
  {
    types: "comparison",
    sections:
      "Criteria · a comparison table (one row per option) · Advantages · Limitations · Recommendation only when asked and evidence-supported. Mark missing data 'unavailable' — never invent it.",
    shape: "| Opsi | Biaya | Keterbatasan |\n| --- | --- | --- |\n| A | 10 | perlu migrasi |",
  },
  {
    types: "document_summary, document_analysis, step_by_step_guide",
    sections:
      "Overview / Prerequisites · body in numbered steps or topics · Important Details (dates, numbers, decisions) · Conclusion. Keep the source's statements separate from your interpretation.",
    shape: "1. **Langkah 1** — jalankan `npm test`; hasil yang diharapkan: semua suite hijau",
  },
];

/** Label syntax per channel: what the platform can actually render. */
const LABEL_SYNTAX: Record<FormatChannel, string> = {
  chat: "Write each section label as its own line starting with `## ` (for example `## Executive Summary`), followed by a blank line and the content. Three or more items = one item per line, never one run-on paragraph.",
  discord:
    "Write each section label as its own line in BOLD -- the labels are Scope, Findings, Executive Summary, Key Findings, Conclusion, Validation, etc., e.g. `**Scope**` and `**Findings**`. Do NOT use `##` on Discord, it renders literally. Put a blank line after each label, then the content. Three or more findings or results = ONE per line as a numbered list, never a single run-on paragraph.",
  slack:
    "Write each section label as its own line in SINGLE-asterisk bold (`*Scope*`, `*Findings*`) -- Slack mrkdwn has no headings and no tables. Put a blank line after each label, then the content. Three or more findings = ONE per line as a numbered list.",
  plain: "",
};

export function outputFormatGuidance(channel?: FormatChannel): string | undefined {
  if (channel === "plain" || channel === undefined) return undefined;
  const syntax = LABEL_SYNTAX[channel];
  if (!syntax) return undefined;
  const total = Object.keys(FORMATTERS).length;
  return [
    `OUTPUT SHAPE (${total} templates; pick the one the ask actually calls for).`,
    // The carve-out is stated as a TRIGGER, never as a length. An earlier wording
    // ("for a simple question or small talk, ignore this block") was read by the
    // model as PERMISSION to skip the shape whenever the ask was short, and three
    // consecutive "ada topik viral ga?" turns came back as emoji-report, bullet
    // list, then one run-on paragraph. The ask being SHORT is not the signal; the
    // signal is whether answering it requires looking something up.
    "This OVERRIDES the channel rule above for REPORT-SHAPED TASKS ONLY. Skip this block ONLY when you can answer from what you already know (what is X, the time, a definition). If the user asks for something CURRENT, something that needs SEARCHING, or anything with findings/severity/delivery, you MUST use the shape even if the ask is one short sentence.",
    syntax,
    "Shapes (imitate the layout, never the content):",
    ...FAMILIES.map((f) => `- ${f.types}: ${f.sections}\n  SHAPE (imitate layout, not content):\n${f.shape
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n")}`),
    "Never invent a section you lack evidence for - omit it or mark it unavailable. Keep citations, URLs, code and error text intact. Formatting never overrides accuracy.",
  ].join("\n");
}