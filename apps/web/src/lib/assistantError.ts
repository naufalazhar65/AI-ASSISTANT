// Assistant error classification (server-side + provider, shared by all
// channels). Lets every surface — web banner, Telegram reply, Discord reply —
// show a clear message when the user's AI token/quota is exhausted instead of a
// generic "internal error", so the user knows to top up.

export type AssistantErrorKind = "rate_limit" | "quota" | "provider" | "other";

export interface ClassifiedError {
  kind: AssistantErrorKind;
  /** Human-friendly, channel-neutral message. */
  userMessage: string;
  /** Original error text (may be empty). */
  detail: string;
}

const RATE_LIMIT_RE =
  /(rate limit|rate_limit|too many requests|tokens per minute|tokens_per_minute|tpm|rpm|requests per minute|429)/i;
const QUOTA_RE =
  /(quota|out of (tokens|credits)|insufficient.*credits|payment required|402|exceeded.*(quota|usage|limit)|billing|topped? up)/i;

/**
 * The provider is healthy — the ACCOUNT is not. Observed live (2026-10-12):
 * `LLM failed (403): … "Upstream request failed: An active OpenCode Go
 * subscription is required to use Go models."` None of the rate-limit/quota
 * patterns above matched it, so it fell through as a generic "provider" error:
 * the failover chain THREW instead of moving on to the next provider, and
 * providerHealth left the dead record untouched so the next turn repeated it.
 */
const SUBSCRIPTION_RE =
  /(an active .*subscription is required|active subscription|subscription (is )?(required|inactive|expired|not active|has expired)|requires? an active subscription|not entitled|entitlement)/i;

/**
 * Failures where another attempt — or another model in the free chain — can
 * plausibly succeed: rate limits, provider/upstream 5xx, overload, a retired or
 * invalid model id, connection resets, timeouts, and entitlement failures.
 *
 * The last two are deliberately included: "worth trying a DIFFERENT provider"
 * is the question this predicate answers (both the outer provider chain and the
 * inner FreeRide model loop use it that way), and for 403/forbidden the answer
 * is always yes — another provider can serve the same request. Whether the SAME
 * provider is worth another try is a separate decision, owned by
 * providerHealth.applyFailure's quota cooldown.
 *
 * Deliberately NOT a catch-all: a tool-argument or code error must not spend
 * the fallback chain retrying.
 */
const RETRYABLE_PROVIDER_RE =
  /(rate ?limit|too many requests|tokens per minute|tokens_per_minute|\btpm\b|\brpm\b|\b429\b|provider error|upstream error|overloaded|service unavailable|bad gateway|gateway timeout|\b5\d\d\b|not a valid model|no allowed providers|model not found|\b404\b|\b403\b|forbidden|subscription|entitle|econnreset|econnrefused|etimedout|enotfound|socket hang up|fetch failed|timed? out)/i;

/**
 * An EXPIRED KEY on one provider is that provider's failure — not the turn's.
 * Live 2026-10-21: the chain reached opencodego whose key had expired
 * ("api_key_expired"), the error was not retryable, so the chain ABORTED and
 * the turn died even though a later provider in the chain could have served
 * it. A dead key moves the chain to the next candidate, exactly like a 429.
 *
 * The pattern matches what the PROVIDER says about the key, not a bare "401".
 * A tool result that quotes "HTTP 401" (an API Mia called, a page that
 * rejected us) is our own code path failing, not the provider's key — and
 * reading it as an expired key both wasted the failover chain and told the
 * owner to go and replace a key that was fine.
 */
const EXPIRED_KEY_RE =
  /(api_key_expired|invalid_api_key|invalid api key|expired key|key expired|key has expired|authentication_error|invalid authentication)/i;

/**
 * The provider's own HTTP 401 — the envelope Mia throws for a failed
 * completion (`LLM failed (401): …`). Only those envelopes count: a 401
 * inside somebody else's text (a tool output, a quoted page, a JSON body)
 * does not match, because it is not anchored to something Mia produced.
 */
const PROVIDER_401_RE = /(?:LLM failed|OpenCode prompt failed|OpenCode session create failed|OpenCode event stream failed) \(401\)/i;

/**
 * App-level failures. These are bugs in OUR turn handling (bad tool arguments,
 * malformed JSON from the model, a runtime exception in the agent). No other
 * provider can possibly do better at the same thing, so they must never spend
 * the fallback chain — and, unlike a rate limit, they must never mark a healthy
 * provider "down" in providerHealth.
 *
 * Checked BEFORE the retryable regex on purpose: once `\b403\b`/`forbidden` is
 * in that regex (an inactive subscription IS worth failing over), a message
 * like `invalid tool arguments: missing field "page"` or a stray `403` column
 * name in a SQL error would otherwise be misread as "the provider refused us".
 */
const CODE_ERROR_RE =
  /(invalid tool arguments|tool_call|tool call|json parse|unexpected token|is not defined|is not a function|is not iterable|cannot read propert|referenceerror|typeerror|syntaxerror|rangeerror)/i;

/** True when re-sending the request (same model or the next free fallback) is
 *  worth it. Used by the freeride chain to move on to the next model. */
/**
 * The upstream gateway's Gemini-compat layer INTERMITTENTLY rejects a request
 * whose function-call turn it mis-places:
 *   "Please ensure that function call turn comes immediately after a user turn
 *    or after a function response turn." (400, INVALID_ARGUMENT)
 *
 * Observed live 2026-10-20 on 9router → gemini-3.5-flash-lite: the SAME
 * request failed and then passed 3/3 on an immediate retry, so the shape we
 * send is canonical — the fault is upstream, not ours. Worth exactly one more
 * attempt, never a chain.
 *
 * The phrase is matched on its FIRST WORDS only, never the full sentence:
 * the gateway TRUNCATES the message and appends its own suffix
 * ("Please ensure that function call turn comes i (reset after 29s)"), so a
 * pattern that requires the whole sentence never matches the live text — and
 * a guard that never matches means the retry never happens and Mia dies on a
 * glitch that one more attempt fixes (measured: same request passes 3/3).
 *
 * WHAT THE MESSAGE REALLY IS (measured 2026-10-21, direct probe of the
 * gateway, one shape per process): the ONLY rejected window shape is one that
 * STARTS with an assistant function-call turn (no user turn before it), and
 * one such request POISONS THE KEY — a plain request right after it failed
 * with the same 400 and only worked again ~30s later. The "(reset after Ns)"
 * suffix is that cooldown.
 *
 * Two consequences, both implemented: the window head is trimmed before it is
 * sent (see ./messageWindow), and the retry waits for the cooldown the
 * message states instead of a fixed 1.2s.
 */
const FUNCTION_SHAPE_RE = /function call turn comes/i;

export function isTransientFunctionShapeError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /\b400\b/.test(msg) && FUNCTION_SHAPE_RE.test(msg);
}

/**
 * How long the gateway asks us to wait before repeating a rejected request.
 *
 * The live error carries its own cooldown: "Please ensure that function call
 * turn comes i (reset after 29s)". Retrying after a second guarantees a
 * second rejection — the gateway is not glitching, it is cooling down on this
 * key. So the wait comes from the message, and a rejected turn is worth
 * retrying exactly once, after that cooldown.
 *
 * Capped at 30s: a longer wait would outlive the turn that asked for it.
 */
const SHAPE_RESET_AFTER_RE = /reset after\s+(\d+)\s*s/i;

export function functionShapeResetAfterMs(err: unknown): number {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const m = msg.match(SHAPE_RESET_AFTER_RE);
  if (!m) return 0;
  const secs = Number(m[1]);
  if (!Number.isFinite(secs) || secs <= 0) return 0;
  return Math.min(30000, Math.round(secs * 1000));
}

export function isProviderRetryable(err: unknown): boolean {
  const detail = err instanceof Error ? err.message : String(err ?? "");
  if (CODE_ERROR_RE.test(detail)) return false;
  if (EXPIRED_KEY_RE.test(detail)) return true;
  // The provider's own 401 envelope: that provider's key was rejected. Another
  // provider can still serve the turn, so the chain moves on.
  if (PROVIDER_401_RE.test(detail)) return true;
  // A gateway cooldown is NOT a failover trigger. Measured 2026-10-21: the
  // 400 blocks the KEY for ~30s, so every other model behind the same proxy
  // is blocked too — and the recovery is on the SAME provider after the
  // cooldown the message states. The retry that waits for that cooldown
  // lives in runOneCompletion; failing over would only trade a pause for a
  // worse provider.
  //
  // (The 400 does NOT come from our own window any more: the head of a
  // window is trimmed before it is sent — see ./messageWindow.)
  return RETRYABLE_PROVIDER_RE.test(detail);
}

/** Classify a thrown error or its message string into a user-facing kind. */
export function classifyAssistantError(err: unknown): ClassifiedError {
  const detail = err instanceof Error ? err.message : String(err ?? "");
  if (RATE_LIMIT_RE.test(detail)) {
    // Try to surface concise Groq numbers like "TPD 199244/200000 (wait 31m40s)" when present in detail.
    const mLimit = detail.match(/Limit\s+(\d+)[^0-9]*Used\s+(\d+)/i);
    const mWait = detail.match(/try again in\s+([\d.]+)s|wait\s+([\dmsh]+)/i);
    let suffix = "";
    if (mLimit) {
      const used = mLimit[2];
      const limit = mLimit[1];
      suffix = ` — TPD ${used}/${limit}`;
      const mWaitFull = detail.match(/try again in\s+([^\n]+?)(?:\.\s|—|$)/i);
      if (mWaitFull) {
        let raw = mWaitFull[1].trim();
        // Shorten "31m40.368s" → "31m40s", "40.500s" → "40s"
        raw = raw.replace(/\.\d+s$/, "s");
        suffix += ` (wait ${raw})`;
      } else if (mWait) {
        const raw = mWait[1] || mWait[2];
        suffix += ` (wait ${raw})`;
      }
    }
    return {
      kind: "rate_limit",
      detail,
      userMessage:
        `Jatah token AI (rate limit) habis${suffix}. Tunggu beberapa saat lalu coba lagi, atau upgrade tier di console Groq kalau sering kena. 🌸`,
    };
  }
  if (SUBSCRIPTION_RE.test(detail)) {
    // `kind: "quota"` on purpose: callers already treat quota as "tell the user
    // to top up / fix the account" (isQuotaExhaustion, Slack/Discord/Telegram
    // replies). The generic "provider" branch would tell them to just retry,
    // which can never work — the plan is gone, not the server.
    return {
      kind: "quota",
      detail,
      userMessage:
        "Langganan AI provider-nya sudah tidak aktif, jadi model itu nggak bisa kupakai. Aku otomatis pindah ke provider lain — kalau tetap gagal, cek langganan/isi ulang kuncinya ya. 🌸",
    };
  }
  if (EXPIRED_KEY_RE.test(detail)) {
    // The owner's key for that provider is dead — no amount of retrying helps.
    // Say it plainly instead of the vague "layanan sedang bermasalah".
    return {
      kind: "quota",
      detail,
      userMessage:
        "Kunci API provider-nya sudah kedaluwarsa, jadi provider itu nggak bisa kupakai. Aku otomatis pindah ke provider lain — kalau provider ini kepakai terus, ganti kuncinya ya. 🌸",
    };
  }
  if (PROVIDER_401_RE.test(detail)) {
    // The provider rejected our key, but it did not say WHY (expired, revoked,
    // wrong account). Say what we know: the key was refused, and that needs
    // the owner. Guessing "expired" would be a story we cannot back.
    return {
      kind: "quota",
      detail,
      userMessage:
        "Provider AI-nya menolak kunci API Mia, jadi provider itu nggak bisa kupakai. Aku otomatis pindah ke provider lain — kalau provider ini kepakai terus, cek kuncinya ya. 🌸",
    };
  }
  if (QUOTA_RE.test(detail)) {
    return {
      kind: "quota",
      detail,
      userMessage:
        "Kuota token AI sudah habis. Aktifkan/top-up di console Groq (atau isi kunci baru) supaya aku bisa bantu lagi. 🌸",
    };
  }
  if (/is not available for provider|is not configured|LLM failed|AI_APICallError|ECONNREFUSED|Cannot connect/i.test(detail)) {
    return { kind: "provider", detail, userMessage: "Layanan AI sedang bermasalah. Coba lagi sebentar lagi ya. 🌸" };
  }
  return { kind: "other", detail, userMessage: "Terjadi kendala. Coba lagi ya. 🌸" };
}

/** True when the error is a token/quota exhaustion the user should be told about. */
export function isQuotaExhaustion(err: unknown): boolean {
  const c = classifyAssistantError(err);
  return c.kind === "rate_limit" || c.kind === "quota";
}
