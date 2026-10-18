// Acceptance criteria defined BEFORE execution, evaluated in the VERIFY phase.
// Honesty rules: a criterion is "met" only with a passing probe or an explicit
// attestation carrying evidence; anything else stays UNKNOWN and can never
// yield COMPLETE. No probe runner => unknown, never a silent pass.

import { existsSync, readFileSync } from "node:fs";

import { resolveInSandbox } from "../users";
import type {
  AcceptanceCriterion,
  CriteriaOutcome,
  CriteriaVerdict,
  CriterionProbe,
  CriterionStatus,
} from "./types";

export interface CriterionProbeResult {
  ok: boolean;
  detail: string;
}

export type CriterionProber = (probe: CriterionProbe) => Promise<CriterionProbeResult>;

/** id -> evidence reference (quote, test name, artifact path). */
export type Attestations = Record<string, string>;

const cap = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Default prober: file-shaped probes only. Tool probes need an injected prober. */
export const fileProber: CriterionProber = async (probe) => {
  if (probe.kind === "tool") return { ok: false, detail: "tool probe needs an injected prober" };
  const resolved = resolveInSandbox(probe.path);
  if (!resolved) return { ok: false, detail: `di luar sandbox: ${probe.path}` };
  if (!existsSync(resolved)) return { ok: false, detail: `absent: ${probe.path}` };
  if (probe.kind === "file_exists") return { ok: true, detail: `exists: ${probe.path}` };
  try {
    const body = readFileSync(resolved, "utf8");
    const needle = probe.needle;
    return body.includes(needle)
      ? { ok: true, detail: `found "${cap(needle, 60)}" in ${probe.path}` }
      : { ok: false, detail: `missing "${cap(needle, 60)}" in ${probe.path}` };
  } catch (e) {
    return { ok: false, detail: `unreadable: ${(e as Error).message.slice(0, 80)}` };
  }
};

export interface EvaluateOptions {
  prober?: CriterionProber;
  attestations?: Attestations;
  /** Set when the environment made verification impossible (not a criterion failure). */
  blocked?: string;
}

export async function evaluateCriteria(
  criteria: AcceptanceCriterion[],
  opts: EvaluateOptions = {},
): Promise<CriteriaOutcome> {
  const rows: { id: string; status: CriterionStatus; detail?: string }[] = [];
  for (const c of criteria) {
    if (c.probe && opts.prober) {
      let res: CriterionProbeResult;
      try {
        res = await opts.prober(c.probe);
      } catch (e) {
        res = { ok: false, detail: `probe threw: ${(e as Error).message.slice(0, 80)}` };
      }
      rows.push({ id: c.id, status: res.ok ? "met" : "unmet", detail: res.detail });
      continue;
    }
    const evidence = opts.attestations?.[c.id];
    if (evidence && evidence.trim()) {
      rows.push({ id: c.id, status: "met", detail: `attested: ${cap(evidence, 100)}` });
      continue;
    }
    rows.push({
      id: c.id,
      status: "unknown",
      detail: c.probe ? "no prober available" : "no probe; needs manual verification",
    });
  }
  const met = rows.filter((r) => r.status === "met").length;
  const unmet = rows.filter((r) => r.status === "unmet").length;
  const unknown = rows.filter((r) => r.status === "unknown").length;
  let verdict: CriteriaVerdict;
  if (opts.blocked) verdict = "BLOCKED";
  else if (rows.length === 0) verdict = "UNKNOWN";
  else if (unmet > 0) verdict = "FAILED";
  else if (unknown > 0) verdict = "PARTIALLY_COMPLETED";
  else verdict = "COMPLETE";
  return { verdict, rows, met, unmet, unknown };
}

/** Stable id from a description, used by the planner and by eval fixtures. */
export function criterionId(description: string): string {
  const slug = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return slug || "criterion";
}

/** Cheap deterministic fingerprint of an attempt (action + params). */
export function attemptFingerprint(parts: (string | number | boolean | undefined)[]): string {
  return parts
    .filter((p) => p !== undefined)
    .map((p) => String(p).trim().replace(/\s+/g, " "))
    .join("|")
    .slice(0, 160);
}