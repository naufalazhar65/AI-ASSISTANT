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
