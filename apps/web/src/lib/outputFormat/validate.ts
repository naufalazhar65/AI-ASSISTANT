/**
 * Deterministic output validation — runs BEFORE delivery, on the model's own
 * text plus the real execution facts. Zero LLM calls: every check is a regex or
 * a structural comparison, because re-asking a model to "fix the formatting"
 * costs a round-trip per reply and tends to invent content.
 *
 * The validator NEVER rewrites the answer to make a check pass. It reports
 * issues; `render.ts` and the caller decide what to do. A failed check must
 * never be papered over with invented sections — that is the exact failure the
 * brief forbids ("formatter jangan mengarang isi").
 */

import { formatterFor, orderedSections, SECTION_LABELS, type FormatterSpec } from "./registry";
import { scanTextSecrets } from "../security";
import type { FormatChannel, TaskType } from "./taskTypes";

export type ValidationIssueCode =
  | "empty-answer"
  | "missing-section"
  | "section-out-of-order"
  | "missing-evidence"
  | "unsupported-completion-claim"
  | "unsupported-test-claim"
  | "success-claimed-on-failure"
  | "sensitive-data-exposure"
  | "repeated-lines";

export interface ValidationIssue {
  code: ValidationIssueCode;
  /** Human-readable; safe to show in a test or an audit line. */
  detail: string;
  /** Section id when the issue is section-scoped. */
  sectionId?: string;
}

export interface ValidationInput {
  text: string;
  taskType: TaskType;
  channel?: FormatChannel;
  /** Tool names that really executed (collector, not prose). */
  executedTools?: readonly string[];
  /** True when a tool result this turn was an error/refusal. */
  toolError?: boolean;
  /** The original user ask — used only to detect honest "no tools ran" phrasing. */
  askText?: string;
  /** Explicit user format request; suppresses structural checks. */
  explicitFormat?: "json" | "table" | "checklist" | "markdown";
}

const URL_RE = /https?:\/\/[^\s)>\]]+/g;
const FENCED_PATH_RE = /`[^`\n]*[/\\][^`\n]*`/g;

/** Strip fences + inline code so a heading inside a code block is not "found". */
function proseOnly(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "\n").replace(/`[^`\n]*`/g, " ");
}

/**
 * Normalise a line into a comparable section label: strip an emoji/symbol
 * prefix, markdown decoration, and trailing punctuation.
 * "📊 KESIMPULAN" and "## Conclusion" both normalise to a bare label.
 */
export function normalizeLabel(line: string): string {
  return line
    .trim()
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[#*_`~]/g, "")
    .replace(/[:\s.\-]+$/, "")
    .trim()
    .toLowerCase();
}

/**
 * Index of the first line that LABELS a section. Matches any alias, so a report
 * that writes "Ringkasan" for Executive Summary counts as present (measured live
 * 2026-10-13). Longest alias wins so "ringkasan eksekusi" does not match the
 * bare "ringkasan" of a different section.
 */
function firstIndexOfHeading(text: string, spec: { title: string; aliases: readonly string[] }): number {
  const aliases = [...(spec.aliases ?? []), spec.title.toLowerCase()];
  const lines = proseOnly(text).split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const label = normalizeLabel(lines[i]);
    if (!label) continue;
    const hit = aliases.some((a) => label === a || label.startsWith(`${a} `) || label.startsWith(`${a}:`));
    if (hit) return i;
  }
  return -1;
}

/** Looser fallback: the heading words appear together somewhere in the prose. */
function hasSection(text: string, spec: { title: string; aliases: readonly string[] }): boolean {
  if (firstIndexOfHeading(text, spec) >= 0) return true;
  const words = spec.title.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) return false;
  const prose = proseOnly(text).toLowerCase();
  if (words.every((w) => prose.includes(w))) return true;
  return (spec.aliases ?? []).some((a) => {
    const parts = a.split(/\s+/).filter((w) => w.length > 3);
    return parts.length > 0 && parts.every((w) => prose.includes(w));
  });
}

const TEST_TOOL_RE = /test|lint|typecheck|verify|check|coverage|npm|pnpm|yarn|vitest|jest|playwright|ci/i;
const DELIVERY_TOOL_RE =
  /send|post|publish|deliver|share|email|telegram|discord|slack|upload|webhook|notify|push/i;

/* Narrow, high-precision claim vocabularies. Each pattern must match an
 * UNAMBIGUOUS claim; anything hedged ("sepertinya", "maybe", "belum") must not
 * match, which is why we require the completion verb directly. */
// Indonesian passive is "dikirim" / "terkirim", NOT "kirim" — the first version of
// this pattern missed "sudah dikirim" entirely, so the guard never fired on the
// most natural phrasing. Test S3b now pins both forms.
const DELIVERY_CLAIM_RE =
  /\b(sudah\s+(di(?:ter)?|ke)?kirim|di(?:ter)?kirim|terkirim|keterkirim|has\s+been\s+sent|sent\s+to)\b/i;
const TEST_PASS_CLAIM_RE =
  /\b(semua\s+test\s+(lulus|passed| hijau)|test\s+(lulus|passed)\s+semua|all\s+tests?\s+(pass|passed|green)|tests?\s+are\s+green|0\s+(failure|failed))\b/i;
const SUCCESS_CLAIM_RE =
  /\b(semua\s+(berhasil|sukses|selesai)|berhasil\s+(semua|penuh)|tidak\s+ada\s+(masalah|error)|all\s+good|100%\s+sukses|semua\s+aman)\b/i;
/**
 * Contextual safety claim: "merespons dengan aman terhadap X", "tidak rentan",
 * "safe against". Measured live 2026-10-13 -- Michelle probed `q=''` and concluded
 * the endpoint "merespons dengan aman terhadap karakter khusus" while an earlier run
 * had proven UNION-based SQLi on the same parameter. A bare `aman` must NOT trip
 * this (it appears in ordinary prose), hence the required context word.
 */
const SAFETY_CLAIM_RE =
  /\b(aman|selamat|tidak\s+rentan)\s+(terhadap|untuk|dari|saat|ketika)|\b(tidak\s+rentan|not\s+vulnerable|safe\s+against)\b/i;
const HEDGE_RE = /\b(sepertinya|mungkin|kemungkinan|belum\s+(ter)?pasti|nanti|kayaknya|sepertinya)\b/i;

/**
 * How many lines are RECOGNISED section labels (alias-based, any language, emoji
 * prefix tolerated). This is the single definition of "this is a report", shared
 * with the renderer.
 *
 * Why it exists outside this module (measured live 2026-10-13): Agnes wrote a
 * perfectly structured 9-line report with "Ringkasan:" and "Waktu:" labels, and
 * `reflowStructuredReply` in agent.ts flattened it to ONE line via
 * `.replace(/\s+/g," ")`. Its own guard only recognised markdown bullets and
 * numbered lists, so emoji/label-shaped reports slipped straight through. Rather
 * than teach that function a second private list, it now asks this one.
 */
export function countSectionLabels(text: string): number {
  let n = 0;
  for (const line of proseOnly(text).split("\n")) {
    const label = normalizeLabel(line);
    if (!label || label.length > 64) continue;
    if (SECTION_LABELS.has(label)) {
      n += 1;
      continue;
    }
    for (const alias of SECTION_LABELS) {
      if (label.startsWith(`${alias} `) || label.startsWith(`${alias}:`)) {
        n += 1;
        break;
      }
    }
  }
  return n;
}

/** Strip the deterministic inbox digest before validation. The digest is
 *  SYSTEM-authored from tool results (subjects/senders/dates), not model
 *  claims — scoring its snippet prose for "claims without sources" produces
 *  false accusations (live 2026-10-15: "menemukan" inside a LinkedIn snippet
 *  fired missing-evidence on an inbox list). The model's own prose is still
 *  fully validated. Pure. */
export function withoutGmailDigest(text: string): string {
  const lines = String(text || "").split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (/^\*\*📧 Email terbaru \(\d+\)\*\*/.test(line.trim())) {
      skipping = true;
      continue;
    }
    if (skipping && (/^\*\*/.test(line.trim()) || /^⚙️/.test(line.trim()))) skipping = false;
    if (!skipping) out.push(line);
  }
  return out.join("\n");
}

/** Count distinct source links / code paths — our evidence proxy. */
export function countEvidence(text: string): number {
  const urls = new Set(text.match(URL_RE) ?? []);
  const paths = new Set(text.match(FENCED_PATH_RE) ?? []);
  return urls.size + paths.size;
}

function repeatedLinePenalty(text: string): number {
  const counts = new Map<string, number>();
  for (const raw of proseOnly(text).split("\n")) {
    const line = raw.trim();
    if (line.length < 12) continue;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  let worst = 0;
  for (const n of counts.values()) if (n > worst) worst = n;
  return worst;
}

/**
 * Validate one answer. Returns every issue found; an empty array means the
 * answer passed. `issues` never blocks delivery by itself — the caller decides
 * (today: record it on the outcome, and fall back to the original text if the
 * renderer cannot produce a readable result).
 */
export function validateOutput(input: ValidationInput): ValidationIssue[] {
  const spec: FormatterSpec = formatterFor(input.taskType);
  const text = withoutGmailDigest(input.text ?? "").trim();
  const issues: ValidationIssue[] = [];

  if (!text) {
    issues.push({ code: "empty-answer", detail: "no answer text" });
    return issues;
  }

  // An explicit format request wins over the template's own structure.
  const structural = spec.conciseness === "report" && input.explicitFormat !== "json" && input.explicitFormat !== "markdown";

  if (structural && spec.requiredSections.length > 0) {
    for (const section of spec.requiredSections) {
      if (!hasSection(text, section)) {
        issues.push({ code: "missing-section", sectionId: section.id, detail: `missing section: ${section.title}` });
      }
    }
    // Order check over every section we actually found (required AND optional),
    // compared against the template's declared order.
    const found = orderedSections(spec)
      .map((s) => ({ id: s.id, at: firstIndexOfHeading(text, s) }))
      .filter((x) => x.at >= 0)
      .sort((a, b) => a.at - b.at);
    const declared = found.map((x) => x.id);
    const expected = orderedSections(spec)
      .map((s) => s.id)
      .filter((id) => declared.includes(id));
    if (declared.join("|") !== expected.join("|")) {
      issues.push({
        code: "section-out-of-order",
        detail: `sections out of order: got ${declared.join(" -> ")}, expected ${expected.join(" -> ")}`,
      });
    }
  }

  if (spec.evidence === "required" && countEvidence(text) === 0) {
    issues.push({ code: "missing-evidence", detail: "no source link or file path found in a report that requires evidence" });
  }

  const executed = input.executedTools ?? [];
  const hedged = HEDGE_RE.test(text);

  // "Sent" claims need a delivery-capable tool in this turn.
  if (DELIVERY_CLAIM_RE.test(text) && !hedged && !executed.some((t) => DELIVERY_TOOL_RE.test(t))) {
    issues.push({
      code: "unsupported-completion-claim",
      detail: "claims delivery but no delivery tool executed this turn",
    });
  }

  // Test-report honesty: passing tests need a test runner in this turn.
  if ((input.taskType === "test_report" || input.taskType === "coding_result") && TEST_PASS_CLAIM_RE.test(text)) {
    if (!hedged && !executed.some((t) => TEST_TOOL_RE.test(t))) {
      issues.push({
        code: "unsupported-test-claim",
        detail: "claims tests passed but no test/lint/verify tool executed this turn",
      });
    }
  }

  // A failed turn may not be reported as an all-clear.
  if (input.toolError === true && (SUCCESS_CLAIM_RE.test(text) || SAFETY_CLAIM_RE.test(text)) && !hedged) {
    issues.push({
      code: "success-claimed-on-failure",
      detail: "turn had a tool error but the answer claims everything succeeded",
    });
  }

  // Secrets in a user-facing answer. scanTextSecrets only matches real key
  // formats (AWS/GCP/Slack/OpenAI/GitHub/JWT/private-key/secret assignment),
  // never ordinary prose — and only the TYPE is recorded, never the value. A
  // 16-digit run is only a NIK next to an identity word, so bare CVSS vectors
  // ("CVSS:4.0/...") and timestamps can never trip it.
  if (input.taskType === "pentest_report" || input.taskType === "security_audit") {
    const secretHits = scanTextSecrets(text);
    const nikHit = /\b\d{16}\b/.test(text) && /\b(nik|ktp|kependudukan|no\.?\s*ktp)\b/i.test(text);
    if (secretHits.length > 0 || nikHit) {
      issues.push({
        code: "sensitive-data-exposure",
        detail: `possible secret value in answer (${secretHits.map((h) => h.type).join(",") || "NIK-like number"}) — mask or omit it`,
      });
    }
  }

  if (repeatedLinePenalty(text) >= 3) {
    issues.push({ code: "repeated-lines", detail: "the same line is repeated 3+ times" });
  }

  return issues;
}

/**
 * A deterministic, factual note about the answer's OWN integrity — never a
 * judgment about the world.
 *
 * Measured live 2026-10-13: a research answer named "TechCrunch" and "Gartner"
 * and then wrote "dua sumber utama terverifikasi" with ZERO links; a security
 * answer declared a SQLi "terbukti" with ZERO sources. Both were true positives,
 * and both were DELIVERED UNCHANGED because validation only recorded. This is
 * the same pattern the repo already uses for its honesty suffixes: state what
 * the message itself is missing, never invent the missing content.
 *
 * Capped at two clauses on purpose — a validator that talks more than the
 * problem it found is just noise.
 */
/**
 * Does this answer actually ASSERT something that would need a source?
 *
 * Measured live 2026-10-13: Michelle answered "daftar temuan kita masih kosong
 * karena belum ada tes yang dijalankan" -- an honest report with NO claims -- and
 * the missing-evidence note then accused HER of unverifiable claims. A false
 * accusation is worse than no note, and this repo's rule is "no wrong
 * accusations". So the note is gated on an actual assertion marker.
 */
export function hasEvidentiaryClaims(text: string): boolean {
  // Measured live 2026-10-13: a security audit listed 8 findings with severities
  // ("level kritis", "IDOR", "stored XSS") and the note stayed silent, because the
  // first vocabulary only knew "terbukti/terverifikasi". The claim was real; the
  // detector missed it. Severities and vulnerability classes ARE claims.
  const ASSERTION_RE =
    /\b(terbukti|terbuktikan|terverifikasi|terkonfirmasi|terbantar|menunjukkan|membuktikan|menemukan|ditemukan|berbocor|membocorkan|rentan|ada\s+celah|level\s+(kritis|tinggi|menengah|rendah|low|medium|high|critical)|cvss|cwe-|sqli|sql\s*injection|\bxss\b|\bidor\b|\bcsrf\b|\bssrf\b|\brce\b|bypass|\bcve-\d|vulnerab\w*|prove\w*|confirmed|verified)\b/i;
  if (!ASSERTION_RE.test(text)) return false;
  return text.trim().length > 120;
}

export function integrityNote(issues: readonly ValidationIssue[], taskType: TaskType, text: string): string {
  // No assertion -> no note. An honest "nothing to report" must stay clean.
  // The deterministic inbox digest is stripped first: its snippet prose is
  // system-quoted, not model claims (live 2026-10-15 false "sumber" note).
  if (!hasEvidentiaryClaims(withoutGmailDigest(text))) return "";
  const parts: string[] = [];
  if (issues.some((i) => i.code === "missing-evidence")) {
    parts.push("laporan ini tidak memuat tautan sumber, jadi klaim di dalamnya belum bisa diverifikasi dari pesan ini");
  }
  const missingFindings = issues.some((i) => i.code === "missing-section" && i.sectionId === "findings");
  if (missingFindings) {
    parts.push("bagian Temuan belum tertulis, jadi hasil di atas belum diringkas per temuan");
  }
  const missingFailed = issues.some((i) => i.code === "missing-section" && i.sectionId === "failed_tests");
  if (missingFailed) {
    parts.push("bagian Test Gagal belum tertulis, jadi kasus gagalnya belum dirinci");
  }
  if (issues.some((i) => i.code === "sensitive-data-exposure")) {
    parts.push("pesan ini kelihatannya memuat nilai rahasia (kunci/token/NIK) — samarkan sebelum diteruskan");
  }
  if (parts.length === 0) return "";
  return `(Catatan: ${parts.join("; ")})`;
}

/** True when any issue is severe enough to warrant a fallback render. */
export function hasBlockingIssue(issues: readonly ValidationIssue[]): boolean {
  return issues.some((i) => i.code === "empty-answer" || i.code === "success-claimed-on-failure");
}