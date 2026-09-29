// baseline.ts — the ONE owner of response comparison for every prover.
//
// Why (bounty precision, 2026-09-28): each prover carried its own copy of
// "does this response differ from the baseline?" — paramMiner.normalizeBody,
// nosqlHunt.classifyOutcome's inline successish(), otpProbe's own digest
// normalization, blindCmdi's timing threshold. Five copies of the same
// decision cannot drift-proof themselves: a fix in one leaves four stale
// (the house lesson from duplicate formatters / WIB copies). This module is
// now the single owner; provers import from here (keeping their old exports
// as re-exports so callers and tests cannot break).
//
// Semantics are copied VERBATIM from the original owners (semantics must not
// shift in a refactor): normalizeBody ← paramMiner, successish/classifyOutcome
// ← nosqlHunt, timingVerdict ← blindCmdi, digest normalization ← otpProbe.
// The only NEW capability here is bodiesDiffer(): the paramMiner diff rule
// (pair-jitter-aware) extracted so poc/bola-style callers can use it too.

/**
 * Normalize a response body for comparison (drop volatile bits):
 * UUIDs → UUID, 10–13-digit numbers → TS, whitespace collapsed. Pure.
 * (Copied verbatim from paramMiner.normalizeBody.)
 */
export function normalizeBody(body: string): string {
  return (body || "")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "UUID")
    .replace(/\b\d{10,13}\b/g, "TS")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Does the body differ from the baseline by more than the pair's own jitter
 * can explain? Pure. Rule (extracted from paramMiner.diffVerdict's body arm):
 * the candidate must differ from BOTH baseline bodies by > `delta` bytes AND
 * that minimum delta must exceed 2× the baseline pair's own spread.
 */
export function bodiesDiffer(
  bA: { body: string },
  bB: { body: string },
  cand: { body: string },
  delta = 60
): boolean {
  const nA = normalizeBody(bA.body);
  const nB = normalizeBody(bB.body);
  const nC = normalizeBody(cand.body);
  const basePairDelta = Math.abs(nA.length - nB.length);
  const candDeltaA = Math.abs(nA.length - nC.length);
  const candDeltaB = Math.abs(nB.length - nC.length);
  return candDeltaA > delta && candDeltaB > delta && Math.min(candDeltaA, candDeltaB) > basePairDelta * 2;
}

/** Response shapes this repo treats as "success-ish" (2xx or a redirect). Pure. */
export function successish(status: number, location: string): boolean {
  return (status >= 200 && status < 300) || (status >= 300 && status < 400 && !!location);
}

/**
 * Differential outcome classification vs the baseline. Pure.
 * (Copied verbatim from nosqlHunt.classifyOutcome — that module now re-exports
 * this as its own.)
 * - `lead`: success-ish where the baseline denied (auth-bypass candidate).
 * - `info`: server stumbled (5xx) or a new error fingerprint at a new status.
 * - `none`: same as baseline.
 */
export function classifyOutcome(
  baseline: { status: number; location: string },
  hit: { status: number; location: string; body: string },
  fingerprint?: (body: string) => string | null
): "lead" | "info" | "none" {
  if (baseline.status === 0 || hit.status === 0) return "none";
  if (successish(hit.status, hit.location) && !successish(baseline.status, baseline.location)) return "lead";
  if (hit.status >= 500) return "info";
  if (hit.status !== baseline.status && fingerprint && fingerprint(hit.body)) return "info";
  return "none";
}

/**
 * Timing verdict past the jitter-aware threshold. Pure.
 * (Copied verbatim from blindCmdi.timingVerdict — that module re-exports it.)
 * A lead needs: delta ≥ minDelayMs AND injected > 3× baseline average AND
 * delta > 3× the baseline pair's own jitter.
 */
export const MIN_DELAY_MS = 5_000;
export function timingVerdict(baseA: number, baseB: number, injected: number): { lead: boolean; detail: string } {
  const baseAvg = (baseA + baseB) / 2;
  const jitter = Math.abs(baseA - baseB);
  const delta = injected - baseAvg;
  if (delta >= MIN_DELAY_MS && injected > baseAvg * 3 && delta > jitter * 3) {
    // The delay the payload actually asked for is NOT always 6s: blindCmdi
    // tries `sleep 6` but a prover may use another value, and MIN_DELAY_MS is
    // 5_000. Hardcoding "sleep 6" put a factually wrong string in a security
    // deliverable (audit 2026-09-29), so the narration states the MEASURED
    // delta and the threshold that judged it, and never names a payload the
    // function never saw.
    return { lead: true, detail: `+${Math.round(delta)}ms vs baseline (jitter ${Math.round(jitter)}ms) — delay di atas ambang ${Math.round(MIN_DELAY_MS / 1000)}s, konsisten dengan time-based injection` };
  }
  return { lead: false, detail: `delta ${Math.round(delta)}ms tidak cukup (butuh ≥${MIN_DELAY_MS}ms, >3× jitter ${Math.round(jitter)}ms)` };
}

/**
 * Fingerprint digest for oracle comparisons (otpProbe's rule): digits → N,
 * first 200 chars. Two responses that differ only in volatile numbers compare
 * equal. Pure.
 */
export function oracleDigest(body: string): string {
  return (body || "").replace(/\d+/g, "N").slice(0, 200);
}
