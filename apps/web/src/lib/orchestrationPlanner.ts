/**
 * Deterministic request → plan. No extra LLM call on purpose.
 *
 * Decomposition only fires on asks that name MULTIPLE distinct work items and
 * map to different registered agents. A single-domain ask (plain chat, one
 * research question, one bug fix) never becomes a plan — it keeps the existing
 * direct-turn path, so no model budget is wasted on trivial requests.
 */

import { agentsForCategory, isAvailableAgent } from "./agentRegistry";
import type { AgentLabel } from "./agentRouting";
import { DEFAULT_BUDGET, type OrchestrationPlan, type OrchestrationTask, type OrchestrationTaskType } from "./orchestration";

interface ObjectiveSpec {
  category: OrchestrationTaskType;
  /** Matched against the ask; must be a work signal, not a topic mention. */
  detect: RegExp;
  objective: string;
  expected: string;
  criteria: string[];
  required: boolean;
  idempotent: boolean;
}

/**
 * The decomposition table. Deliberately narrow: each entry needs a WORK verb,
 * because "cari tahu apakah X aman" is research but "cari tahu X" alone must
 * stay a plain turn.
 */
const OBJECTIVES: readonly ObjectiveSpec[] = [
  {
    category: "research",
    detect: /(riset|research|teliti|pelajari)\s+(?:tentang\s+|mengenai\s+)?\S+|bandingkan\s+\S+.*\b(vs|versus|dengan)\b/i,
    objective: "Riset dan verifikasi sumber",
    expected: "Catatan riset dengan tautan sumber + daftar temuan sumber",
    criteria: ["setiap klaim utama punya sumber", "ketidakpastian ditandai"],
    required: false,
    idempotent: true,
  },
  {
    category: "code",
    detect: /(buatkan|buatin|bikin|tulis|tuliskan)\s+.{0,40}(unit\s*test|fungsi|file|kode|skrip|program)|(perbaiki|benerin|fix|debug)\s+.{0,40}(error|eror|bug|test|file|kode|fungsi)/i,
    objective: "Implementasi / perbaikan kode",
    expected: "Perubahan kode + hasil test",
    criteria: ["test terkait dijalankan", "perubahan dijelaskan"],
    required: true,
    idempotent: false,
  },
  {
    category: "security",
    detect: /(audit|scan|pentest|uji ?keamanan|cek\s+kerentanan)\s+\S+/i,
    objective: "Pengujian keamanan pada target yang diotorisasi",
    expected: "Daftar temuan dengan bukti eksekusi",
    criteria: ["setiap temuan punya bukti nyata", "scope tetap di dalam target yang diizinkan"],
    required: false,
    idempotent: true,
  },
  {
    category: "assistant",
    detect: /(ingatkan|reminder|jadwalkan|buat\s+tugas|task)\s+\S+/i,
    objective: "Tugas pribadi (reminder/tugas)",
    expected: "Tugas terjadwal dan terkonfirmasi",
    criteria: ["waktu tercatat", "user diberi konfirmasi"],
    required: false,
    idempotent: false,
  },
];

/** True when the ask carries real work signals at all (cheap pre-filter). */
const WORK_RE = /\b(buatkan|bikin|tulis|perbaiki|fix|debug|riset|research|teliti|pelajari|bandingkan|audit|scan|pentest|uji|cek|analisis|analisa|review|implement)\b/i;

/**
 * Should this ask become a workflow at all?
 * False for: short chat, single-work-item asks, confirmation replies, and
 * anything the specialist detectors already own.
 */
export function shouldOrchestrate(ask: string): boolean {
  const t = (ask || "").trim();
  if (t.length < 25 || t.length > 2000) return false;
  if (/^\s*\/?(ya|tidak|batal|ok|oke|siap|lanjut)\b/i.test(t)) return false;
  if (!WORK_RE.test(t)) return false;
  return matchedObjectives(t).length >= 2;
}

/** Repo/code work a "research" verb can hide: research ABOUT the codebase is
 *  code work, and the research specialist is a public-facts researcher. */
const REPO_WORK_RE = /\b(repo|repository|kode|codebase|source code|file|fungsi|function|test|implementasi|implement|refactor|commit|script|modul|module|class)\b/i;

function splitClauses(text: string): string[] {
  return text
    .split(/(?:\s+lalu\s+|\s+kemudian\s+|\s*[,;]\s+|\s+dan's?\s+|\s+then\s+)/i)
    .map((c) => c.trim())
    .filter(Boolean);
}

function matchedObjectives(text: string): ObjectiveSpec[] {
  const t = text.trim();
  const hits: ObjectiveSpec[] = [];
  const clauses = splitClauses(t);
  for (const spec of OBJECTIVES) {
    if (!spec.detect.test(t)) continue;
    // Live drill 2026-10-18: "riset pola pagination yang dipakai di repo ini"
    // matched research and was handed to the public-facts researcher, who
    // answered "bukan tugasku ... itu ranahnya Michelle" and attested nothing.
    // Research ABOUT the codebase is code work, so it must not become a
    // research subtask nobody can finish.
    if (spec.category === "research") {
      const researchClauses = clauses.filter((c) => spec.detect.test(c));
      if (researchClauses.length > 0 && researchClauses.every((c) => REPO_WORK_RE.test(c))) continue;
    }
    hits.push(spec);
  }
  return hits;
}

/**
 * The ask clause that carries THIS objective, so a subtask is not handed to a
 * specialist as the generic objective alone.
 *
 * Measured by the live drill 2026-10-18: "Riset dan verifikasi sumber" plus a
 * parent ask that also asks for a code fix bounced — Agnes read the code half,
 * her persona boundary rule fired, and the subtask ended with nothing attested.
 * The objective has to name the work; the parent context stays as context.
 */
function clauseFor(text: string, spec: ObjectiveSpec): string | null {
  const clauses = splitClauses(text);
  const hit = clauses.find((c) => spec.detect.test(c));
  // The split leaves the conjunction on the next clause ("lalu perbaiki ...").
  return hit ? hit.replace(/^(lalu|kemudian|dan|then|sedangkan|berikutnya)\s+/i, "").slice(0, 160) : null;
}

/**
 * Build a plan from the request. Order = OBJECTIVES order (research → code →
 * security → assistant), and dependencies follow the pipeline order so a
 * research task precedes code that depends on it.
 */
export function planFromRequest(
  request: string,
  opts: { user: string; now?: string; budget?: OrchestrationPlan["budget"]; planId?: string } = { user: "" }
): OrchestrationPlan {
  const now = opts.now ?? new Date().toISOString();
  const specs = matchedObjectives(request);
  const tasks: OrchestrationTask[] = [];
  let prev: string | null = null;

  specs.forEach((spec, i) => {
    const agent = pickAgent(spec.category);
    const id = `t${i + 1}`;
    tasks.push({
      task_id: id,
      parent_task_id: null,
      agent_id: agent,
      objective: clauseFor(request, spec) ? `${spec.objective}: ${clauseFor(request, spec)}` : spec.objective,
      task_type: spec.category,
      input_context: request,
      expected_output: spec.expected,
      acceptance_criteria: spec.criteria,
      dependencies: prev ? [prev] : [],
      priority: specs.length - i,
      required: spec.required,
      status: "PLANNED",
      created_at: now,
      started_at: null,
      completed_at: null,
      result_reference: null,
      evidence_references: [],
      error_summary: null,
      attempts: 0,
      idempotent: spec.idempotent,
    });
    prev = id;
  });

  return {
    id: opts.planId ?? `orch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    user: opts.user,
    request: request.trim(),
    created_at: now,
    status: "PLANNED",
    tasks,
    budget: opts.budget ?? DEFAULT_BUDGET,
    notes: [],
  };
}

/**
 * Assign the agent that can actually do the work, or null for a capability
 * gap. Mia is only a fallback for categories no specialist claims — she is not
 * a universal specialist, and pretending otherwise would hide the gap.
 */
export function pickAgent(category: OrchestrationTaskType): AgentLabel | null {
  const specialists = agentsForCategory(category).filter((p) => p.role !== "coordinator" && isAvailableAgent(p.label));
  if (specialists.length > 0) return specialists[0].label;
  const coordinator = agentsForCategory(category).find((p) => p.role === "coordinator");
  return coordinator && isAvailableAgent(coordinator.label) ? coordinator.label : null;
}