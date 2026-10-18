// Barrel for the autonomous problem-solving loop.
// PLAN -> EXECUTE -> OBSERVE -> VERIFY -> DIAGNOSE -> RECOVER|STOP.
// Pure decision logic lives in ./types, ./classify, ./criteria, ./policy;
// persistence in ./session; reporting in ./report. No model, no prompts here:
// the loop decides, the orchestrator executes.

export * from "./types";
export { classifyFailure, errorLine, isNonRetryable } from "./classify";
export type { FailureInput, FailureClassification } from "./classify";
export {
  attemptFingerprint,
  criterionId,
  evaluateCriteria,
  fileProber,
} from "./criteria";
export type { Attestations, CriterionProbeResult, CriterionProber, EvaluateOptions } from "./criteria";
export {
  approvalFingerprint,
  decideRecovery,
  detectLoop,
  stableArgs,
} from "./policy";
export type { RecoveryContext } from "./policy";
export {
  getSession,
  markSessionActive,
  newSession,
  readSessions,
  reconcileSessions,
  recordAttempt,
  releaseSession,
  saveSession,
} from "./session";
export { computeLoopMetrics, renderMetricsLine, renderPsReport } from "./report";
export type { LoopMetrics } from "./report";