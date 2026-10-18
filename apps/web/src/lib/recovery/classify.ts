// Deterministic failure classification.
// Order matters: the first matching rule wins, and a rule that matched by hard
// signal is "confirmed"; a rule that matched by wording alone is a "hypothesis"
// so the recovery policy can require more evidence before repeating itself.

import type { FailureClass, PsPhase } from "./types";

export interface FailureInput {
  /** Error line as surfaced by the failing action. */
  error?: string;
  /** Tool name that failed, when known. */
  tool?: string;
  /** Phase the failure happened in. */
  phase?: PsPhase;
  /** A verification/test step actually ran and reported failure. */
  verificationFailed?: boolean;
  /** The failure message names a concrete, actionable cause. */
  clearCause?: boolean;
  /** Tool paused for owner approval, or owner declined it. */
  approvalState?: "required" | "declined";
  /** Scope / role / policy refusal. */
  blockedBy?: "scope" | "role" | "policy" | "unknown";
  /** Caller could not state what was wanted. */
  missingInformation?: boolean;
}

export interface FailureClassification {
  failure: FailureClass;
  confidence: "confirmed" | "hypothesis";
  evidence: string;
}

interface Rule {
  failure: FailureClass;
  confirmed: (i: FailureInput) => boolean;
  matches: (i: FailureInput) => boolean;
  evidence: string;
}

const has = (s: string | undefined, re: RegExp) => (s ? re.test(s) : false);

const RULES: Rule[] = [
  {
    failure: "APPROVAL_REQUIRED",
    confirmed: (i) => i.approvalState === "required",
    matches: (i) => i.approvalState === "required" || has(i.error, /butuh persetujuan|perlu persetujuan|needs? approval|approval_required|menunggu izin/i),
    evidence: "approval not granted",
  },
  {
    failure: "AUTHORIZATION_BLOCKED",
    confirmed: (i) => !!i.blockedBy,
    matches: (i) => i.blockedBy !== undefined || has(i.error, /SCOPE —|role gate|dilarang|not available on this provider|Auto-declined|The user declined/i),
    evidence: "scope/role/policy refusal",
  },
  {
    failure: "VERIFICATION_FAILURE",
    confirmed: (i) => i.verificationFailed === true,
    matches: (i) => i.verificationFailed === true || has(i.error, /assertion failed|tests? failed|verdict:\s*(MASIH RENTAN|NO-DESYNC|no-signal)/i),
    evidence: "verification step failed",
  },
  {
    failure: "MISSING_INFORMATION",
    confirmed: (i) => i.missingInformation === true,
    matches: (i) => i.missingInformation === true || has(i.error, /belum ada konteks|kurang info|butuh input|missing required|jawaban kosong|tidak jelas|kebetulan apa/i),
    evidence: "required input absent",
  },
  {
    failure: "DEPENDENCY_ERROR",
    confirmed: (i) => has(i.error, /Cannot find module|Cannot find package|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|dependency/i),
    matches: (i) => has(i.error, /Cannot find module|Cannot find package|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|is not installed|brew install|npm i(nstall)?\b/i),
    evidence: "dependency missing/unresolvable",
  },
  {
    failure: "ENVIRONMENT_ERROR",
    confirmed: (i) => has(i.error, /\b(EACCES|EPERM|ENOSPC|ENOTEMPTY|ENODEV|ECONNREFUSED)\b/i),
    matches: (i) => has(i.error, /\b(EACCES|EPERM|ENOSPC|ENOTEMPTY|ENODEV|ECONNREFUSED)\b|permission denied|no space left|docker/i),
    evidence: "host/environment problem",
  },
  {
    failure: "TRANSIENT",
    confirmed: (i) => has(i.error, /\b(ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENETUNREACH)\b|\b(429|500|502|503|504)\b/i),
    matches: (i) => has(i.error, /timeout|timed out|fetch failed|socket hang up|rate limit|quota|temporarily|502|503|504|ECONNRESET|ETIMEDOUT|EAI_AGIN/i),
    evidence: "retryable transport/provider signal",
  },
  {
    failure: "INPUT_ERROR",
    confirmed: (i) => has(i.error, /\b400\b|invalid|unknown_agent|prompt_required|prompt_too_long|out of range|must be a|expected .* but got/i),
    matches: (i) => has(i.error, /\b400\b|\b404\b|invalid|unknown_agent|prompt_required|out of range|unknown_root|must be a|wajib\b/i),
    evidence: "input rejected before work started",
  },
  {
    failure: "EXTERNAL_FAILURE",
    confirmed: () => false,
    matches: (i) => has(i.error, /web_search|upstream|\b(403|405|451)\b|tunnel|third[- ]party|DNS|OAST/i),
    evidence: "external service failed (wording only)",
  },
  {
    failure: "IMPLEMENTATION_ERROR",
    confirmed: (i) => i.clearCause === true,
    matches: (i) => has(i.error, /TypeError|ReferenceError|SyntaxError|AssertionError|compile|type error|cannot read propert/i) || i.clearCause === true,
    evidence: "code/impl defect",
  },
];

const NEVER_RETRY: FailureClass[] = [
  "APPROVAL_REQUIRED",
  "AUTHORIZATION_BLOCKED",
  "MISSING_INFORMATION",
  "INPUT_ERROR",
];

export function isNonRetryable(failure: FailureClass): boolean {
  return NEVER_RETRY.includes(failure);
}

/** Immutable, quotable first line of an error. Never invents detail. */
export function errorLine(err: unknown): string {
  const s = err instanceof Error ? err.message : typeof err === "string" ? err : String(err ?? "");
  return (s.split("\n")[0] ?? "").slice(0, 200);
}

export function classifyFailure(input: FailureInput): FailureClassification {
  const err = input.error ?? "";
  for (const r of RULES) {
    if (r.confirmed(input)) return { failure: r.failure, confidence: "confirmed", evidence: r.evidence };
  }
  for (const r of RULES) {
    if (r.matches(input)) return { failure: r.failure, confidence: "hypothesis", evidence: r.evidence };
  }
  return {
    failure: "UNKNOWN",
    confidence: err ? "hypothesis" : "confirmed",
    evidence: err ? "no rule matched the error text" : "no error detail supplied",
  };
}