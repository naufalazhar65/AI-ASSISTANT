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
 * Failures where another attempt — or another model in the free chain — can
 * plausibly succeed: rate limits, provider/upstream 5xx, overload, a retired or
 * invalid model id, connection resets, timeouts. Deliberately NOT a catch-all:
 * a tool-argument or code error must not spend the fallback chain retrying.
 */
const RETRYABLE_PROVIDER_RE =
  /(rate ?limit|too many requests|tokens per minute|tokens_per_minute|\btpm\b|\brpm\b|\b429\b|provider error|upstream error|overloaded|service unavailable|bad gateway|gateway timeout|\b5\d\d\b|not a valid model|no allowed providers|model not found|\b404\b|econnreset|econnrefused|etimedout|enotfound|socket hang up|fetch failed|timed? out)/i;

/** True when re-sending the request (same model or the next free fallback) is
 *  worth it. Used by the freeride chain to move on to the next model. */
export function isProviderRetryable(err: unknown): boolean {
  const detail = err instanceof Error ? err.message : String(err ?? "");
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
