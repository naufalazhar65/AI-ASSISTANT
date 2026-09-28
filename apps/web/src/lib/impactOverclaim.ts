// impactOverclaim.ts — refuse an impact sentence that claims MORE than the
// evidence shows (bounty-audit §2.3). Pure — unit-tested.
//
// Why (checklist §2.3, "don't overstate impact"): the pre-fix store contained a
// finding whose impact read "An unauthenticated attacker can read the ENTIRE
// database" while the evidence was a single JSON object with one NIK field. That
// sentence is the single most common reason a valid bug gets closed as
// "impact not demonstrated": the triager stops trusting the report. Worse, the
// sentence is still in the language gate's own acceptance fixture, i.e. the
// product was actively accepting it.
//
// The design is deliberately asymmetric so it cannot block honest work:
//   - Only a SCOPE claim ("the entire database", "all user records", "full
//     source code", "remote code execution", "every record") is examined.
//   - The evidence is what earns the claim. A dump/proof marker justifies it
//     (many distinct rows, an explicit count, a poc_verify PASS, an OAST hit,
//     command output for RCE…). Without such a marker the claim is refused
//     with an actionable instruction: narrow the impact, or attach the proof.
//   - A hedged claim ("could/may/potentially …") is a risk statement, not a
//     factual assertion, so it is allowed and merely reported as unchecked.
//   - Anything that is not a scope claim is returned untouched, so ordinary
//     impacts ("allows reading another user's NIK") never touch this gate.

export type OverclaimVerdict = {
  allow: boolean;
  /** Which scope claim was found ("" when none). */
  claim: string;
  /** Why the claim is or is not backed. */
  reason: string;
  /** True when the evidence contains a proof that earns the claimed scope. */
  backed: boolean;
  /** True for a hedged claim (allowed, reported as unchecked). */
  hedged: boolean;
};

const ALLOW = (claim = "", reason = ""): OverclaimVerdict => ({ allow: true, claim, reason, backed: true, hedged: false });

/** Scope claims, most damaging first. */
export const SCOPE_CLAIMS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "full-source-code", re: /\b(?:entire|full|complete|whole)\s+(?:application\s+)?source\s+code\b|\ball\s+source\s+code\b|\bfull\s+source\b/i },
  { name: "remote-code-execution", re: /\b(?:allows?|enables?|permits?)\s+(?:an?\s+)?(?:unauthenticated\s+|remote\s+|unauthenticated\s+remote\s+)?(?:arbitrary\s+|full\s+)?(?:remote\s+)?code\s+execution\b|\b(?:remote|arbitrary)\s+code\s+execution\b|\bfull\s+rce\b|\bcomplete\s+server\s+compromise\b|\bserver\s+compromise\b/i },
  { name: "full-database", re: /\b(?:entire|whole|full|complete|all)\s+(?:user\s+|customer\s+|all\s+)?database\b|\b(?:entire|whole|full|complete)\s+(?:db|dataset|records?|tables?)\b|\bdump\s+the\s+entire\b|\ball\s+(?:the\s+)?(?:tables?|rows?)\b|\b(?:entire|whole|full|complete)\s+(?:users?|customers?|employees?|accounts?)\s+tables?\b/i },
  { name: "all-records", re: /\b(?:every|all)\s+(?:single\s+)?(?:user\s+|customer\s+|employee\s+|account\s+)?(?:records?|accounts?|users?|rows?|entries)\b|\bexfiltrat\w+\s+(?:the\s+)?(?:entire|whole|all|complete)\b|\ball\s+of\s+the\s+(?:user\s+)?data\b/i },
  { name: "arbitrary-file-read", re: /\bread\s+(?:any|arbitrary|all)\s+(?:file|files)\b|\b(?:any|arbitrary)\s+file\s+(?:on|from)\s+the\s+server\b|\bread\s+(?:the\s+)?entire\s+file\s?system\b|\ball\s+environment\s+variables\b|\ball\s+secrets?\b/i },
  { name: "all-sensitive-data", re: /\ball\s+sensitive\s+(?:data|information|fields?)\b|\b(?:entire|complete)\s+pii\b|\ball\s+pii\b/i },
];

/**
 * Proof markers that earn a broad scope claim. Deliberately shape-based: a dump
 * with several distinct rows, an explicit count, an OAST/beacon hit, command
 * output, or a confirmed poc run.
 */
const PROOF_RE =
  /poc_verify[^\n]{0,40}\bPASS\b|\b\d+\/\d+\s+PASS\b|\bSTABIL\b|oast_poll|oast_dns|interactsh|\bbeacon\b|\bcallback\s+(?:hit|received|ter-atribusi)\b|rows?\s+(?:affected|returned|matched)\s*[:=]?\s*\d+|\btotal\s+(?:rows|records|entries)\s*[:=]?\s*\d+|\bSELECT\s+\*|\bINFORMATION_SCHEMA\b|\bshow\s+tables\b|\b(?:uid|user_id|id)\s*[:=]\s*\d+[^\n]{0,60}(?:uid|user_id|id)\s*[:=]\s*\d+/i;

/** Command/shell evidence that earns an RCE claim. */
const RCE_PROOF_RE =
  /\b(?:uid=\d+\(|root:|www-data|whoami|id -u|command output|executed\s+(?:the\s+)?command|command\s+injection\s+executed|TOOL_EXECUTED|AGENT_DONE)\b|oast_poll|interactsh|\bbeacon\b|\btime-based\b|\bblind_cmdi\b|\bcmd\s+ran\b|\bprocess\s+spawned\b/i;

/** Hedges that turn a factual assertion into a risk statement. */
const HEDGE_RE = /\b(?:could|may|might|potentially|possibly|likely|appears? to|has the potential|allows? an? attacker to potentially)\b/i;

/**
 * A negated claim is not a claim. "This does not give access to the entire
 * database" is the tester ruling a class OUT, which is the opposite of
 * overclaiming — without this the gate fired on accurate scope-limiting
 * language and taught the model to avoid the word instead of the claim.
 */
const NEGATION_BEFORE = /\b(?:not|no|never|cannot|can't|without|neither|nor|isn't|doesn't|didn't|won't)\b[^.?!]{0,40}$/i;

const STOPWORDS = /\b(?:a|an|the|and|or|of|to|in|on|at|for|with|is|are|be|by|from|that|this|it|as|any|all|its|their|his|her|user|users|attacker|an attacker|they|he|she|which|who|can|may|might|could|would|should|will|does|do|did|has|have|had|been|being|if|than|then|so|such|into|over|under|about|after|before|between|each|more|most|some|no|not|only|also|use|used|using|own|per|via|per)\b/gi;

const CONTENT_WORDS = (s: string): number =>
  (s.toLowerCase().replace(STOPWORDS, " ").match(/[a-z]{4,}/g) || []).length;

/**
 * Is this evidence set substantive enough to be a real submission at all? Used
 * to decide whether a hedge is acceptable (a hedged claim over thin evidence is
 * still a "please confirm this" case, so it is reported but not refused).
 */
export function evidenceIsSubstantive(evidence: string, steps: string): boolean {
  return CONTENT_WORDS(`${evidence || ""}\n${steps || ""}`) >= 8;
}

/**
 * Decide whether an impact statement may be stored.
 *
 * @param impact  the tester's impact sentence
 * @param evidence everything the tester supplied (evidence + steps + root cause)
 */
export function overclaimVerdict(impact: string, evidence: string, steps = ""): OverclaimVerdict {
  const text = String(impact || "");
  if (!text.trim()) return ALLOW("", "no impact supplied");

  const hit = SCOPE_CLAIMS.map((c) => ({ name: c.name, m: c.re.exec(text) })).find((x) => x.m);
  if (!hit) return ALLOW("", "no scope claim to check");
  if (NEGATION_BEFORE.test(text.slice(0, hit.m!.index))) {
    return ALLOW("", "the scope word is negated — that is scope-limiting language, not a claim");
  }

  const proof = String(evidence || "") + "\n" + String(steps || "");
  const backed = hit.name === "remote-code-execution" ? RCE_PROOF_RE.test(proof) : PROOF_RE.test(proof);
  const claim = (hit.m?.[0] || hit.name).replace(/\s+/g, " ").trim();

  if (backed) {
    return { allow: true, claim, reason: "evidence contains a proof that earns the claimed scope", backed: true, hedged: false };
  }

  // Hedge: a risk statement, not an assertion. Allowed, but the caller reports
  // it as unchecked so the tester confirms it before submitting.
  if (HEDGE_RE.test(text)) {
    return {
      allow: true,
      claim,
      reason: "hedged risk statement — scope not demonstrated by the evidence; confirm before submitting",
      backed: false,
      hedged: true,
    };
  }

  const hint: Record<string, string> = {
    "remote-code-execution": "prove execution (command output / oast_poll hit / time-based delay), or describe the primitive you actually observed (e.g. 'the parameter is passed to a shell via exec()')",
    "full-database": "attach the dump output (or a row count) that demonstrates the breadth, or narrow the impact to what you observed (e.g. 'returns records from any id, verified on 3 records')",
    "all-records": "show how many records/accounts you actually verified, or scope the claim to the ones you demonstrated",
    "full-source-code": "attach the recovered source, or scope the claim to the file(s) you read",
    "arbitrary-file-read": "attach the file you read, or scope the claim to the paths you verified",
    "all-sensitive-data": "list the fields you actually obtained, or scope the claim to those",
  };

  return {
    allow: false,
    claim,
    reason:
      `impact claims "${claim}" but the evidence does not demonstrate that scope. ` +
      `Overstated impact is the most common reason a valid report is closed as "impact not demonstrated". ` +
      `Either ${hint[hit.name] || "attach the evidence that demonstrates the claimed scope"}, or rewrite the impact to the scope you actually verified.`,
    backed: false,
    hedged: false,
  };
}

/** Refusal footer shared with findingGate so the honesty guards see a refusal. */
export const OVERCLAIM_REFUSAL_FOOTER =
  "\n\n(refused to execute — pencatatan DIBATALKAN, tidak ada temuan tersimpan. Jangan klaim temuan ini tercatat.)";
