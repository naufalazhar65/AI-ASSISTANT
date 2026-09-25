// sstiEnum.ts — SSTI engine-fingerprint prover (write/confirm tool
// `ssti_enum`, CWE-1336). paramFuzz's ssti class only proves "the template
// evaluated 7*7" generically; the payout lives in KNOWING the engine — each
// has a different safe-RCE ladder, and a report naming the engine + the
// exact payload is 10× the value.
//
// Decision tree (pure, unit-tested), driven by probe responses:
//   1. arithmetic: `{{7*7}}` → 49, `${7*7}` → 49, `#{7*7}` → 49, `<%= 7*7 %>` → 49
//   2. engine-teller: `{{7*'7'}}` → 7777777 (Jinja2/Twig family), 
//      `{{7*'7'}}` error shape → Twig, `${7*7}` + `<%= 7*7 %>` both → EJS/ERB split
//   3. error-shape fingerprint: each engine's exception text differs
//      (Twig "Unexpected token", Jinja "unexpected end of", Freemarker
//      "Expression syntax error", Velocity, Pebble, Thymeleaf, ERB, EJS).
//
// The tool probes one param with the ladder (≤9 requests), classifies via
// sstiClassify, and reports the ENGINE + the safe next payload (never ships
// an RCE chain itself — the ladder to RCE is in the matching playbook).
// Scope-gated (targetAllowed), bounded, politeDelay, recordHttp, session.
import { targetAllowed, politeDelay } from "./security";
import { recordHttp } from "./httpHistory";
import { sessionHeaders } from "./httpSession";

const UA = "mia-assistant/1.0";
const BODY_BUDGET = 12_000;
const MAX_REQ = 9;

/** Probe ladder: arithmetic first, then engine-tellers. */
export const SSTI_LADDER: Array<{ p: string; note: string }> = [
  { p: "{{7*7}}", note: "Jinja2/Twig family arithmetic" },
  { p: "${7*7}", note: "Freemarker/Velocity/EJS/Thymeleaf arithmetic" },
  { p: "#{7*7}", note: "Ruby ERB / Thymeleaf arithmetic" },
  { p: "<%= 7*7 %>", note: "ERB/EJS arithmetic" },
  { p: "{{7*'7'}}", note: "Jinja2 (7777777) vs Twig (49) teller" },
  { p: "{{7*'7'}}", note: "duplicate probe for stability" },
  { p: "{{not.a.real.namespace}}", note: "error-shape fingerprint A" },
  { p: "${NotARealClass.static}", note: "error-shape fingerprint B" },
  { p: "{{ '{{7*7}}' }}", note: "brace-escape check (double-curly literal)" },
];

export type Probe = { status: number; body: string; ms: number; error?: string };

/**
 * Classify one probe body. Pure — tested. Returns the engine when the body
 * evaluates the arithmetic (49) or matches an engine-teller/error shape.
 */
export function sstiClassify(body: string, payload: string): string | null {
  const b = body || "";
  if (payload === "{{7*'7'}}") {
    if (/7777777/.test(b) && !/7777777.*7777777.*7777777.*7777777.*7777777/.test(b)) return "jinja2-likely";
    if (/\b49\b/.test(b)) return "twig-likely";
  }
  if (/\b49\b/.test(b)) {
    if (payload === "{{7*7}}") return "jinja-twig-family";
    if (payload === "${7*7}") return "freemarker-velocity-ejs-family";
    if (payload === "#{7*7}") return "erb-thymeleaf-family";
    if (payload === "<%= 7*7 %>") return "erb-ejs-family";
  }
  // Error-shape fingerprints (best-effort, honest "shape-match" wording).
  if (/unexpected end of (test|input)|jinja|undefined error/i.test(b)) return "jinja-shape";
  if (/unexpected token "?(punctuation|variable|name)"?/i.test(b)) return "twig-shape";
  if (/expression syntax error|freemarker/i.test(b)) return "freemarker-shape";
  if (/velocity|velocimacro/i.test(b)) return "velocity-shape";
  if (/pebble/i.test(b)) return "pebble-shape";
  if (/thymeleaf|spel|springel/i.test(b)) return "thymeleaf-shape";
  if (/erb|syntaxerror.*<%|tilt/i.test(b)) return "erb-shape";
  if (/ejs|referenceerror.*include|module.*ejs/i.test(b)) return "ejs-shape";
  return null;
}

/** Final verdict across all probes. Pure — tested. */
export function sstiFinalVerdict(
  results: Array<{ payload: string; probe: Probe; label: string | null }>
): { engine: string; confidence: "confirmed" | "likely" | "shape-only" | "none"; evidence: string } {
  const evalHits = results.filter((r) => r.label && !r.label.endsWith("-shape") && !r.label.endsWith("-likely"));
  const teller = results.find((r) => r.label === "jinja2-likely" || r.label === "twig-likely");
  const shapes = results.filter((r) => r.label && r.label.endsWith("-shape"));
  if (teller?.label === "jinja2-likely" && evalHits.some((r) => r.label === "jinja-twig-family")) {
    return { engine: "Jinja2", confidence: "confirmed", evidence: "7*7=49 + 7*'7'=7777777 (string-repeat semantics)" };
  }
  if (teller?.label === "twig-likely" && evalHits.some((r) => r.label === "jinja-twig-family")) {
    return { engine: "Twig", confidence: "confirmed", evidence: "7*7=49 + 7*'7'=49 (no string-repeat)" };
  }
  if (evalHits.length) {
    const fam = evalHits[0].label!.replace("-family", "");
    return { engine: fam, confidence: "likely", evidence: `arithmetic evaluated via ${evalHits[0].payload}` };
  }
  if (shapes.length) {
    return { engine: shapes[0].label!.replace("-shape", ""), confidence: "shape-only", evidence: `error text matches ${shapes[0].payload.slice(0, 30)}` };
  }
  return { engine: "unknown", confidence: "none", evidence: "tidak ada evaluasi maupun error-shape yang dikenali" };
}

/** Safe next-step payload per engine (pointer, not weapon). Pure — tested. */
export function nextStepFor(engine: string): string {
  switch (engine) {
    case "Jinja2": return "playbook ssti → Jinja2 ladder (safe probes dulu: {{config}}/{{ self }})";
    case "Twig": return "playbook ssti → Twig map/filter ladder";
    case "freemarker-velocity-ejs": return "playbook ssti → static/class resolution probe untuk memisahkan engine";
    case "erb-thymeleaf": case "erb-ejs": case "erb": return "playbook ssti → ERB/EJS instantiation probe";
    case "velocity": case "pebble": case "thymeleaf": return "playbook ssti → engine-specific ladder";
    default: return "lanjutkan dengan payload baterai param_fuzz / playbook ssti";
  }
}

async function send(url: string, method: "GET" | "POST", body: string | undefined, session: string | undefined, rawUser: unknown): Promise<Probe> {
  const headers: Record<string, string> = { "User-Agent": UA };
  if (session && rawUser) {
    const s = sessionHeaders(rawUser, session);
    if (s) {
      Object.assign(headers, s.headers);
      if (s.cookie && !Object.keys(headers).some((k) => k.toLowerCase() === "cookie")) headers.cookie = s.cookie;
    }
  }
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(12_000) });
    return { status: res.status, body: (await res.text()).slice(0, BODY_BUDGET), ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, body: "", ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}

export type SstiEnumOpts = {
  url?: string;         // endpoint reflecting input into a rendered template
  param?: string;       // default "name"
  method?: string;      // GET (default) or POST
  session?: string;
};

/**
 * SSTI engine-fingerprint prover. Bounded ≤9 requests. Reports the engine
 * (confirmed / likely / shape-only) + the safe next step. Never ships RCE.
 */
export async function sstiEnum(rawUser: unknown, opts: SstiEnumOpts = {}): Promise<string> {
  const raw = String(opts.url || "").trim();
  if (!/^https?:\/\//i.test(raw)) return "Error: url harus http(s).";
  if (!targetAllowed(raw)) return "Error: SCOPE — ssti_enum hanya untuk lab / engagement aktif / PENTEST_LAB_TARGETS.";
  let base: URL;
  try { base = new URL(raw); } catch { return "Error: URL tidak valid."; }
  const method: "GET" | "POST" = (opts.method || "GET").toUpperCase() === "POST" ? "POST" : "GET";
  const param = String(opts.param || "name").trim() || "name";
  const session = typeof opts.session === "string" && opts.session ? opts.session : undefined;

  // Baseline (plain value) — 49 must be ABSENT here (same baseline rule).
  await politeDelay();
  const baseBody = method === "POST" ? new URLSearchParams({ [param]: "probe" }).toString() : undefined;
  const baseUrl = (() => { const u = new URL(base.toString()); u.searchParams.set(param, "probe"); return u.toString(); })();
  const baseRes = await send(baseUrl, method, baseBody, session, rawUser);
  recordHttp(rawUser, { method, url: baseUrl, status: baseRes.status, bytes: baseRes.body.length, ms: baseRes.ms, at: new Date().toISOString() });
  if (baseRes.error) return `Error: baseline gagal jaringan (${baseRes.error}) — target down / salah endpoint.`;
  if (/\b49\b/.test(baseRes.body)) {
    return `⚠️ Halaman baseline SUDAH mengandung "49" — tidak bisa membedakan evaluasi dari kebetulan. Pilih param/halaman lain.`;
  }

  const results: Array<{ payload: string; probe: Probe; label: string | null }> = [];
  let used = 1;
  for (const step of SSTI_LADDER.slice(0, MAX_REQ - 1)) {
    if (used >= MAX_REQ) break;
    await politeDelay();
    const body = method === "POST" ? new URLSearchParams({ [param]: step.p }).toString() : undefined;
    const url = (() => { const u = new URL(base.toString()); u.searchParams.set(param, step.p); return u.toString(); })();
    const p = await send(url, method, body, session, rawUser);
    used++;
    recordHttp(rawUser, { method, url, status: p.status, bytes: p.body.length, ms: p.ms, at: new Date().toISOString() });
    if (p.error || p.status === 0) continue;
    results.push({ payload: step.p, probe: p, label: sstiClassify(p.body, step.p) });
  }

  const v = sstiFinalVerdict(results);
  const head = `🧬 SSTI ENUM ${base.origin}${base.pathname} (param "${param}") — ${used} request, engine: ${v.engine} (${v.confidence}).`;
  if (v.confidence === "none") {
    return `${head}\nTidak ada evaluasi template yang terbukti. ${v.evidence}. (Negatif ≠ aman — coba param lain / cek reflection di sumber render.)`;
  }
  return [
    head,
    `• Bukti: ${v.evidence}`,
    `• Langkah lanjut (aman dulu): ${nextStepFor(v.engine)}`,
    "",
    `⚠️ Sinyal → poc_verify (replay deterministik) sebelum finding_add (CWE-1336). Tool ini TIDAK mengirim payload RCE — ladder RCE ada di playbook ssti, jalankan manual terkendali.`,
  ].join("\n");
}
