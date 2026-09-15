// Parameter fuzzer — inject a small, non-destructive payload set into each query
// parameter and flag signals: reflection (XSS), SQL errors (SQLi), template eval
// (SSTI), open redirect, command output, timing. Scope-gated (targetAllowed);
// low-rate + bounded. Confirmed hits still need manual counterevidence.
import { targetAllowed } from "./security";

const UA = "mia-assistant/1.0";
const MAX_PARAMS = 20;
const MAX_PER_CLASS = 12;
const CONCURRENCY = 5;
const MAX_TOTAL = 160;

export const PAYLOADS: Record<string, string[]> = {
  xss: ['"><img src=x onerror=alert(1)>', "'\"><svg/onload=alert(1)>", '"><script>alert(1)</script>', "javascript:alert(1)", '"><iframe src=javascript:alert(1)>', "<script>alert(document.domain)</script>"],
  sqli: ["'", '"', "')", "1' OR '1'='1", "1 AND 1=1", "1' AND SLEEP(5)-- -", "1) AND 1=1-- -", "' UNION SELECT NULL-- -"],
  ssti: ["{{7*7}}", "${7*7}", "#{7*7}", "{{7*'7'}}", "<%= 7*7 %>"],
  redirect: ["https://evil.example/", "//evil.example/", "https://evil.example", "/\\evil.example", "//evil.example/%2f.."],
  cmdi: [";id", "|id", "`id`", "$(id)", "%0aid"],
};

const SQL_ERR = /(SQL syntax|SQLite|sqlite3|mysql_|You have an error in your SQL|ORA-\d{4,}|PostgreSQL.*ERROR|unclosed quotation mark|syntax error at or near|SequelizeDatabaseError|pg::SyntaxError)/i;

export type FuzzHit = { param: string; klass: string; payload: string; signal: string; evidence: string };

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

type Probe = { status: number; body: string; loc: string; ms: number; err: boolean };

async function probe(url: string, method: string, body?: string): Promise<Probe> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers: { "User-Agent": UA, ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      body: method === "POST" ? body : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
    const text = (await res.text()).slice(0, 8000);
    return { status: res.status, body: text, loc: res.headers.get("location") || "", ms: Date.now() - t0, err: false };
  } catch {
    return { status: 0, body: "", loc: "", ms: Date.now() - t0, err: true };
  }
}

/** Analyze one response against a payload + baseline. Returns signal names. */
export function classify(payload: string, klass: string, r: Probe, base: Probe): string[] {
  const out: string[] = [];
  if (r.err) return out;
  const reflected = r.body.includes(payload) || r.body.includes(encodeURIComponent(payload));
  // Reflection is only a meaningful signal for XSS (every reflecting endpoint
  // echoes all payloads, so flagging it for every class would be pure noise).
  if (reflected && klass === "xss") out.push("reflection (cek XSS konteks)");
  if ((klass === "sqli" || klass === "xss") && SQL_ERR.test(r.body) && !SQL_ERR.test(base.body)) out.push("SQL error signature");
  if (klass === "ssti" && /\b49\b/.test(r.body) && !/\b49\b/.test(base.body)) out.push("SSTI eval (7*7=49)");
  if (klass === "redirect" && r.status >= 300 && r.status < 400 && /(evil\.example|^\/\\|\/\/(evil\.example))/i.test(r.loc)) out.push(`open redirect -> ${r.loc.slice(0, 80)}`);
  if (klass === "cmdi" && /uid=\d+.*gid=\d+/i.test(r.body) && !/uid=\d+.*gid=\d+/i.test(base.body)) out.push("command output (uid=)");
  if (r.ms - base.ms > 4000) out.push(`timing +${r.ms - base.ms}ms`);
  if (r.status !== base.status && r.status > 0) out.push(`status ${base.status}->${r.status}`);
  return out;
}

export async function paramFuzz(rawUser: unknown, opts: { url: string; params?: string[]; classes?: string[]; method?: string; callback?: string }): Promise<string> {
  void rawUser;
  const raw = (opts.url || "").trim();
  if (!/^https?:\/\//i.test(raw)) return "Error: URL harus http(s).";
  if (!targetAllowed(raw)) return "Error: SCOPE — param_fuzz hanya untuk lab / engagement aktif / PENTEST_LAB_TARGETS.";
  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    return "Error: URL tidak valid.";
  }
  const params = (opts.params && opts.params.length ? opts.params : [...base.searchParams.keys()]).filter(Boolean).slice(0, MAX_PARAMS);
  if (!params.length) return "Error: tidak ada parameter untuk diuji. Sertakan ?a=1 di URL atau isi `params`.";
  const classes = (opts.classes && opts.classes.length ? opts.classes : Object.keys(PAYLOADS)).filter((c) => c in PAYLOADS || (c === "ssrf" && opts.callback)).slice(0, 8);
  const method = (opts.method || "GET").toUpperCase() === "POST" ? "POST" : "GET";

  // baseline with original values
  const baseline = await probe(base.toString(), method, method === "POST" ? base.searchParams.toString() : undefined);

  const baseVal: Record<string, string> = {};
  for (const p of params) baseVal[p] = base.searchParams.get(p) || "1";

  const jobs: { param: string; klass: string; payload: string }[] = [];
  for (const klass of classes) {
    if (klass === "ssrf") {
      for (const p of params) jobs.push({ param: p, klass, payload: opts.callback as string });
      continue;
    }
    for (const p of params) for (const pl of PAYLOADS[klass].slice(0, MAX_PER_CLASS)) jobs.push({ param: p, klass, payload: pl });
  }
  const capped = jobs.slice(0, MAX_TOTAL);

  const hits: FuzzHit[] = [];
  await pool(capped, CONCURRENCY, async (j) => {
    const u = new URL(base.toString());
    u.searchParams.set(j.param, j.payload);
    const p = await probe(u.toString(), method, method === "POST" ? u.searchParams.toString() : undefined);
    let signals: string[] = [];
    if (j.klass === "ssrf") signals = ["payload terkirim — cek `oast_poll` untuk bukti OOB"];
    else signals = classify(j.payload, j.klass, p, baseline);
    if (signals.length) {
      const idx = j.klass === "ssrf" ? 0 : p.body.indexOf(j.payload);
      const ev = idx >= 0 ? p.body.slice(Math.max(0, idx - 40), idx + j.payload.length + 40).replace(/\s+/g, " ") : `${p.status} ${p.loc}`.slice(0, 120);
      hits.push({ param: j.param, klass: j.klass, payload: j.payload, signal: signals.join("; "), evidence: ev });
    }
  });

  const head = `🧪 PARAM FUZZ ${base.origin}${base.pathname} — ${capped.length} request (${params.length} param × ${classes.join(",")}), ${hits.length} sinyal.`;
  if (!hits.length) return `${head}\nTidak ada sinyal (reflection/error/timing/redirect) — coba param lain atau kelas payload lain.`;
  const lines = hits.map((h) => `• [${h.klass}] ${h.param} = ${h.payload.slice(0, 40)}\n   ↳ ${h.signal}${h.evidence ? `\n   ↳ ${h.evidence.slice(0, 180)}` : ""}`);
  return `${head}\n${lines.join("\n")}\n\n⚠️ Sinyal ≠ vuln. Verifikasi manual (konteks reflection, counterevidence, pastikan bukan WAF/halaman default) sebelum finding_add.`;
}
