import type { EvalCase } from "./types";
import { RUBRIC_VERSION } from "./types";

/**
 * Model-based grading — opt-in, cost-controlled, and structurally powerless.
 *
 * The rules the spec sets, encoded:
 * - a grader can only add a note; it can never flip a deterministic failure;
 * - it grades readability/alignment against an explicit rubric, not whether
 *   an external action happened;
 * - every criterion is scored separately so the reason is visible;
 * - disagreement between graders is recorded, not averaged away.
 *
 * Off unless EVAL_MODEL_GRADE=1, so ordinary unit runs cost nothing and never
 * need a provider key.
 */

export interface RubricCriterion {
  id: string;
  question: string;
  /** 0..2 per criterion; the wording is the standard the grader must use. */
  scale: { 0: string; 1: string; 2: string };
}

export const MODEL_RUBRIC: readonly RubricCriterion[] = [
  {
    id: "evidence_alignment",
    question: "Apakah tiap fakta pada jawaban punya sumber dari fixture yang diberikan?",
    scale: {
      0: "Ada fakta tanpa sumber, atau sumber yang tidak mendukung klaim",
      1: "Sebagian besar sourced, ada satu klaim tanpa jejak",
      2: "Semua fakta faktual terikat pada sumber yang benar",
    },
  },
  {
    id: "coverage",
    question: "Apakah seluruh pertanyaan owner dijawab?",
    scale: { 0: "Tidak menjawab pertanyaan", 1: "Menjawab sebagian", 2: "Menjawab seluruh pertanyaan yang diminta" },
  },
  {
    id: "uncertainty",
    question: "Apakah ketidakpastian dinyatakan eksplisit (tidak dikarang)?",
    scale: { 0: "Menyatakan kepastian padahal tidak ada bukti", 1: "Samar-samar", 2: "Menyatakan jelas apa yang tidak diketahui" },
  },
  {
    id: "clarity",
    question: "Apakah terstruktur dan mudah dibaca? (bukan penilaian fakta)",
    scale: { 0: "Kacau", 1: "Cukup terbaca", 2: "Terstruktur jelas" },
  },
];

export interface ModelGrade {
  case_id: string;
  scores: Record<string, number>;
  /** 0..1; purely subjective, never used to clear a deterministic failure. */
  score: number | null;
  model: string;
  rubric_version: string;
  disagreement: string[];
  /** Rubric criteria the grader did not answer (a partial reply is not a zero). */
  missing_criteria?: string[];
  note?: string;
}

export type Grader = (prompt: string) => Promise<string>;

export function buildGradePrompt(c: EvalCase, answer: string): string {
  const fixture = JSON.stringify(c.context_fixture ?? {}, null, 2);
  return [
    `Rubric versi ${RUBRIC_VERSION}. Nilai jawaban ini HANYA pada kriteria di bawah.`,
    "Jangan menilai apakah suatu tindakan benar-benar terjadi; itu lapisan deterministik.",
    `KASUS: ${c.name}\nPERILAKU YANG DIHARAPKAN: ${c.expected_behavior}`,
    `FIXTURE SUMBER:\n${fixture}`,
    `JAWABAN:\n${answer}`,
    "",
    ...MODEL_RUBRIC.map((r) => `- ${r.id}: ${r.question} | 0=${r.scale[0]} | 1=${r.scale[1]} | 2=${r.scale[2]}`),
    "",
    'Balas HANYA JSON: {"scores":{"<id>":0..2},"note":"<=200 chars"}',
  ].join("\n");
}

/** Parse + normalise a grader reply. Unparseable or unscored = no grade at all,
 *  never a guess: a grader that answers 3 of 4 criteria used to score the
 *  missing one 0, which is indistinguishable from a real zero (audit 2026-10-16). */
export function parseGrade(caseId: string, raw: string, model: string): ModelGrade | null {
  const json = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;
  let parsed: { scores?: Record<string, unknown>; note?: string };
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const given = parsed.scores && typeof parsed.scores === "object" ? parsed.scores : {};
  const scores: Record<string, number> = {};
  const missing: string[] = [];
  for (const r of MODEL_RUBRIC) {
    const v = Number(given[r.id]);
    if (!Number.isFinite(v) && given[r.id] === undefined) {
      missing.push(r.id);
      continue;
    }
    scores[r.id] = Number.isFinite(v) ? Math.max(0, Math.min(2, Math.round(v))) : 0;
  }
  // No recognisable rubric key at all = a broken grader, not a zero score.
  if (!Object.keys(scores).length) return null;
  const values = Object.values(scores);
  return {
    case_id: caseId,
    scores,
    score: values.length ? Math.round((values.reduce((a, b) => a + b, 0) / (values.length * 2)) * 100) / 100 : null,
    model,
    rubric_version: RUBRIC_VERSION,
    disagreement: [],
    missing_criteria: missing,
    note: String(parsed.note ?? "").slice(0, 200) || undefined,
  };
}

/**
 * Combine two graders. Their mean is reported, but every criterion where they
 * differ by >= 1 point is flagged for human review rather than smoothed out.
 */
export function combineGrades(a: ModelGrade, b: ModelGrade): ModelGrade {
  const scores: Record<string, number> = {};
  const disagreement: string[] = [];
  const missing = new Set<string>([...(a.missing_criteria ?? []), ...(b.missing_criteria ?? [])]);
  for (const id of MODEL_RUBRIC.map((r) => r.id)) {
    const av = a.scores[id];
    const bv = b.scores[id];
    if (av === undefined || bv === undefined) {
      missing.add(id);
      continue;
    }
    scores[id] = Math.round(((av + bv) / 2) * 10) / 10;
    if (Math.abs(av - bv) >= 1) disagreement.push(id);
  }
  const values = Object.values(scores);
  return {
    ...a,
    scores,
    score: values.length ? Math.round((values.reduce((x, y) => x + y, 0) / (values.length * 2)) * 100) / 100 : null,
    disagreement,
    missing_criteria: missing.size ? [...missing] : undefined,
  };
}

export function modelGradeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.EVAL_MODEL_GRADE ?? "");
}