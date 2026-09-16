// Tool-argument coercion helpers.
//
// Models often pass a JSON body as an OBJECT (`{"query":"{__typename}"}`) instead
// of a string. Tools that build an HTTP request previously accepted only strings
// and silently dropped an object body — which showed up as a server error like
// "HTTP request body must be a valid, non-empty JSON array or object". Coerce
// here so both shapes work.

/** A request body as a string: strings pass through, objects/arrays are stringified. */
export function asBodyString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return undefined;
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return undefined;
    }
  }
  // numbers/booleans are still valid JSON payloads
  return String(v);
}

/** Number | numeric string (models often send "3") | undefined. */
export function asNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** String array from an array, or a comma/space separated string. */
export function asStringArray(v: unknown): string[] | undefined {
  if (Array.isArray(v)) {
    const out = v.map((x) => String(x).trim()).filter(Boolean);
    return out.length ? out : undefined;
  }
  if (typeof v === "string" && v.trim()) {
    const out = v.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    return out.length ? out : undefined;
  }
  return undefined;
}

import { redactSecrets } from "./memoryNoise";

const SECRET_ARG_KEY = /(secret|token|password|passwd|api[_-]?key|access[_-]?key|authorization|cookie|bearer|credential|otp|pin|salt|signature)/i;

/** Mask secret-ish argument values (recursively) for chat/audit display. Pure. */
export function redactArgsForDisplay(json: string): string {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return redactSecrets(json);
  }
  const walk = (v: unknown, key = ""): unknown => {
    if (key && SECRET_ARG_KEY.test(key)) return "[redacted]";
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val, k);
      return out;
    }
    return v;
  };
  try {
    return redactSecrets(JSON.stringify(walk(obj)));
  } catch {
    return redactSecrets(json);
  }
}
