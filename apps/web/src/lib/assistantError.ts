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

/** Classify a thrown error or its message string into a user-facing kind. */
export function classifyAssistantError(err: unknown): ClassifiedError {
  const detail = err instanceof Error ? err.message : String(err ?? "");
  if (RATE_LIMIT_RE.test(detail)) {
    return {
      kind: "rate_limit",
      detail,
      userMessage:
        "Jatah token AI (rate limit) sedang habis atau melonjak. Tunggu beberapa saat lalu coba lagi, atau upgrade tier di console Groq kalau sering kena. 🌸",
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
