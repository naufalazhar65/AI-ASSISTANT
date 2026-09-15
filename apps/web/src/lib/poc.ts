// PoC verify — turn a candidate finding into PROOF before it is reported.
//
// A lead ("B could read A's object") is only reportable when it reproduces
// deterministically and the difference is real, not a cache/timing artifact —
// otherwise it gets closed as N/A / Not Reproducible / Duplicate. This runs the
// same request N times, fingerprints each response, asserts an expected
// status/substring, and (optionally) compares against a baseline request so the
// delta is explicit. Output is report-ready; evidence can be saved.
//
// Active → scope-gated (targetAllowed). Secrets: pass a saved http_session name
// (or nothing) — never raw credentials in args.

import { createHash } from "node:crypto";
import { targetAllowed } from "./security";
import { recordHttp } from "./httpHistory";
import { sessionHeaders } from "./httpSession";
import { evidenceCapture } from "./evidence";

type Req = { url: string; method?: string; headers?: Record<string, string>; body?: string; session?: string };
type Run = { status: number; len: number; ms: number; digest: string; snippet: string; error?: string };

const MAX_TIMES = 8;
const DEFAULT_TIMES = 3;

async function once(rawUser: unknown, r: Req): Promise<Run> {
  const method = (r.method || "GET").toUpperCase();
  const headers: Record<string, string> = { "User-Agent": "mia-assistant/1.0", ...(r.headers || {}) };
  if (r.session) {
    const s = sessionHeaders(rawUser, r.session);
    if (!s) return { status: 0, len: 0, ms: 0, digest: "", snippet: "", error: `session "${r.session}" tidak ada` };
    Object.assign(headers, s.headers);
    if (s.cookie && !Object.keys(headers).some((k) => k.toLowerCase() === "cookie")) headers["cookie"] = s.cookie;
  }
  const t0 = Date.now();
  try {
    const res = await fetch(r.url, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : r.body,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    recordHttp(rawUser, { method, url: r.url, status: res.status, bytes: text.length, ms: Date.now() - t0, at: new Date().toISOString() });
    return {
      status: res.status,
      len: text.length,
      ms: Date.now() - t0,
      digest: createHash("sha256").update(text).digest("hex").slice(0, 16),
      snippet: text.slice(0, 240).replace(/\s+/g, " "),
    };
  } catch (e) {
    return { status: 0, len: 0, ms: Date.now() - t0, digest: "", snippet: "", error: e instanceof Error ? e.message : String(e) };
  }
}

function summarize(label: string, runs: Run[], expectStatus?: number, expectContains?: string): string {
  const ok = runs.filter((r) => !r.error);
  if (!ok.length) return `${label}: GAGAL semua (${runs[0]?.error || "?"})`;
  const statuses = [...new Set(ok.map((r) => r.status))];
  const digests = [...new Set(ok.map((r) => r.digest))];
  const det = digests.length === 1 && statuses.length === 1;
  const lines = [`${label}: ${ok.length}/${runs.length} jalan — status [${statuses.join(", ")}]${det ? " · body identik ✓ (deterministik)" : ` · body BERBEDA (${digests.length} varian) ⚠`}`];
  if (expectStatus !== undefined) {
    const pass = ok.filter((r) => r.status === expectStatus).length;
    lines.push(`   expect_status ${expectStatus}: ${pass}/${ok.length} ${pass === ok.length ? "PASS ✓" : "FAIL ✗"}`);
  }
  if (expectContains) {
    const pass = ok.filter((r) => r.snippet.includes(expectContains)).length;
    lines.push(`   expect_contains "${expectContains}": ${pass}/${ok.length} ${pass === ok.length ? "PASS ✓" : "FAIL ✗"}`);
  }
  return lines.join("\n");
}

/** Run the PoC (and optional baseline) and return a report-ready verdict. */
export async function pocVerify(
  rawUser: unknown,
  opts: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    session?: string;
    times?: number;
    expect_status?: number;
    expect_contains?: string;
    baseline_url?: string;
    baseline_method?: string;
    baseline_headers?: Record<string, string>;
    baseline_body?: string;
    baseline_session?: string;
    save_evidence?: boolean;
  }
): Promise<string> {
  const url = (opts.url || "").trim();
  if (!/^https?:\/\//i.test(url)) return "Error: url harus http(s).";
  if (!targetAllowed(url)) return "Error: SCOPE — poc_verify hanya untuk lab / engagement aktif.";
  if (opts.baseline_url && !targetAllowed(opts.baseline_url)) return "Error: SCOPE — baseline_url di luar lab/engagement.";
  const times = Math.min(MAX_TIMES, Math.max(1, Number(opts.times) || DEFAULT_TIMES));
  const req: Req = { url, method: opts.method, headers: opts.headers, body: opts.body, session: opts.session };

  const runs: Run[] = [];
  for (let i = 0; i < times; i++) {
    runs.push(await once(rawUser, req));
    if (i < times - 1) await new Promise((r) => setTimeout(r, 250));
  }

  const out: string[] = [`🧪 POC VERIFY ${(opts.method || "GET").toUpperCase()} ${url}`, summarize("target", runs, opts.expect_status, opts.expect_contains)];

  const ok = runs.filter((r) => !r.error);
  const det = ok.length > 0 && new Set(ok.map((r) => r.digest)).size === 1 && new Set(ok.map((r) => r.status)).size === 1;
  const expStatus = opts.expect_status;
  const expContains = opts.expect_contains;
  const assertsOk =
    (expStatus === undefined || ok.every((r) => r.status === expStatus)) &&
    (!expContains || ok.every((r) => r.snippet.includes(expContains)));

  let baselineDelta = "";
  if (opts.baseline_url) {
    const b = await once(rawUser, { url: opts.baseline_url, method: opts.baseline_method, headers: opts.baseline_headers, body: opts.baseline_body, session: opts.baseline_session });
    const differs = b.status !== (ok[0]?.status ?? 0);
    baselineDelta = `\nbaseline: ${(opts.baseline_method || "GET").toUpperCase()} ${opts.baseline_url} → ${b.status}${b.error ? ` (${b.error})` : ""}\n   delta status: ${ok[0]?.status} vs ${b.status} ${differs ? "→ BERBEDA ✓ (indikasi otorisasi/objek)" : "→ SAMA (tidak ada sinyal)"}`;
    out.push(baselineDelta.trimStart());
  }

  // Report-ready verdict.
  const verdict = det && assertsOk ? "✅ PoC STABIL & terkonfirmasi — layak dilaporkan (sertakan langkah + bukti)." : det ? "⚠️ PoC deterministik tapi assertion belum terpenuhi — perbaiki ekspektasi/target sebelum lapor." : "❌ PoC TIDAK stabil (respons bervariasi) — jangan dilaporkan sebelum dipastikan.";
  out.push(`\n${verdict}`);
  out.push("Status sampel: " + (ok[0] ? `${ok[0].status} (${ok[0].len}b) — ${ok[0].snippet}` : "(gagal)"));

  if (opts.save_evidence) {
    try {
      const ev = await evidenceCapture(rawUser, { request: { url, method: (opts.method || "GET").toUpperCase(), headers: opts.headers, body: opts.body } });
      out.push(`\n📎 ${ev.split("\n")[0]}`);
    } catch (e) {
      out.push(`\n📎 evidence gagal: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out.join("\n");
}
