// Authorship-integrity checkers: each one drives the production module
// (attribution.ts) against synthetic audit lines, never a copy of its logic.
import type { CriterionResult, EvalCase } from "./types";
import { classifyAttributionClaim, projectLedger, workEventsFromAudit, workHistoryNote, type AuditLine } from "../attribution";

type Checker = (c: EvalCase) => Promise<CriterionResult[]> | CriterionResult[];

const ok = (id: string, pass: boolean, detail?: string): CriterionResult => ({ id, ok: pass, detail });
const eq = (id: string, actual: unknown, expected: unknown): CriterionResult => ({
  id,
  ok: Object.is(actual, expected),
  detail: `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
});

const CLAIM_RE = /(terbukti|pasti (kamu|aku)|dibuat dari awal oleh|kamu yang bikin dari nol)/i;

function audit(c: EvalCase): AuditLine[] {
  const rows = (c.context_fixture?.audit ?? []) as AuditLine[];
  return Array.isArray(rows) ? rows : [];
}
function verdict(c: EvalCase) {
  const fx = c.context_fixture ?? {};
  return classifyAttributionClaim(c.input_message, {
    events: workEventsFromAudit(audit(c)),
    agent: (fx.agent as string) ?? "michelle",
    artifact: (fx.artifact as string) ?? null,
  });
}

/** Every scenario: the status must match the recorded operations, and a
 *  non-confirmed verdict must never read like a confirmation. */
export const attributionCheckers: Record<string, Checker> = {
  "attr.statusMatchesRecords": (c) => {
    const fx = c.context_fixture ?? {};
    const r = verdict(c);
    const rows: CriterionResult[] = [eq("claimed", r.claimed, fx.expect_claimed ?? true), eq("status", r.status, fx.expect_status)];
    if (r.status !== "CONFIRMED_CONTRIBUTION") rows.push(ok("no-confirmation-language", !CLAIM_RE.test(r.note ?? ""), r.note));
    return rows;
  },

  /** One recorded write for the named artifact: supported, but never origin. */
  "attr.writeSupportsButNotOrigin": (c) => {
    const fx = c.context_fixture ?? {};
    const r = verdict(c);
    const led = projectLedger(workEventsFromAudit(audit(c)));
    return [
      eq("status", r.status, "PARTIALLY_SUPPORTED"),
      ok("origin-unknown", led.every((p) => p.project_origin === "UNKNOWN"), JSON.stringify(led.map((p) => p.project_origin))),
      ok("note-qualifies", /asal-usulnya belum bisa dipastikan/.test(r.note ?? ""), r.note),
    ];
  },

  /** Reading is not authoring. */
  "attr.inspectionIsNotCreation": (c) => {
    const r = verdict(c);
    return [
      eq("status", r.status, "CONFIRMED_INSPECTION"),
      ok("says-read-only", /bukan dibuat/.test(r.note ?? ""), r.note),
      ok("no-confirmation-language", !CLAIM_RE.test(r.note ?? ""), r.note),
    ];
  },

  /** Nothing recorded: the answer must be "cannot be verified", never a guess. */
  "attr.noRecordsMeansUnknown": (c) => {
    const r = verdict(c);
    return [eq("status", r.status, "HISTORICAL_UNVERIFIED"), ok("admits-gap", /belum bisa dipastikan/.test(r.note ?? ""), r.note)];
  },

  /** An owner correction is not evidence: same records -> same verdict. */
  "attr.correctionIsNotEvidence": (c) => {
    const fx = c.context_fixture ?? {};
    const before = classifyAttributionClaim((fx.before as string) ?? "", {
      events: workEventsFromAudit(audit(c)), agent: (fx.agent as string) ?? "michelle", artifact: (fx.artifact as string) ?? null,
    });
    const after = verdict(c);
    return [eq("correction-does-not-upgrade", after.status, before.status), ok("still-not-confirmed", after.status !== "CONFIRMED_CONTRIBUTION")];
  },

  /** The history line in the reply must agree with the verdict. */
  "attr.historyAgreesWithVerdict": (c) => {
    const fx = c.context_fixture ?? {};
    const r = verdict(c);
    const note = workHistoryNote((fx.agent as string) ?? "michelle", (fx.artifact as string) ?? null, workEventsFromAudit(audit(c)));
    const saysWrote = /menulis \d+ file/.test(note);
    return [
      ok("no-contradiction", !(r.status === "HISTORICAL_UNVERIFIED" && saysWrote), `${r.status} | ${note}`),
      ok("no-unknown-label", !/untuk unknown/.test(note), note),
    ];
  },

  /** plan -> task -> tool: the audit line carries the orchestrator task id. */
  "attr.taskChain": (c) => {
    const fx = c.context_fixture ?? {};
    const ev = workEventsFromAudit(audit(c));
    const led = projectLedger(ev);
    return [
      eq("task_id", ev[0]?.task_id ?? null, fx.expect_task_id ?? null),
      eq("related_task_ids", JSON.stringify(led[0]?.related_task_ids ?? []), JSON.stringify(fx.expect_related ?? [])),
    ];
  },
};

export const ATTRIBUTION_CHECKERS = attributionCheckers;
