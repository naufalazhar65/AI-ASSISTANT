// otpProbe.ts — OTP/2FA rate-limit & oracle prover (write/confirm tool
// `otp_probe`). Given a code-verification endpoint, fire a BOUNDED volley of
// wrong codes (never full brute-force), then honestly classify:
//   • rate-limit signals (429 / lockout copy) vs their ABSENCE after N tries,
//   • response-oracle signals (any response that differs from the wrong-code
//     baseline — possible acceptance or state change),
//   • code-space entropy from user-supplied sample codes (pure math).
// A missing rate limit on a small code space is a HIGH-signal lead, but the
// tool never claims acceptance without real verification. Scope-gated via
// targetAllowed, bounded (≤15 attempts), politeDelay spacing. Pure helpers
// are exported for unit tests.
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
  const method = (opts.method || "POST").toUpperCase();
  const headers: Record<string, string> = { "User-Agent": UA };
  if (opts.session && opts.rawUser) {
    const s = sessionHeaders(opts.rawUser, opts.session);
    if (s) {
      Object.assign(headers, s.headers);
      if (s.cookie && !Object.keys(headers).some((k) => k.toLowerCase() === "cookie")) headers.cookie = s.cookie;
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

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

const THROTTLE_RE = /too many|rate.?limit|coba lagi|tunggu|lock(ed|out)|blocked|throttl|429|attempt(s)? (exceeded|remaining)/i;

/**
 * Rate-limit verdict over the volley of statuses/bodies. Pure.
 * "seen" = an explicit throttle/lockout was observed (control exists);
 * "absent" = N wrong-code tries all got normal deny responses (lead when the
 * code space is small); "mixed" = network failures make it inconclusive.
 */
export function rateLimitVerdict(statuses: number[], bodies: string[]): { kind: "seen" | "absent" | "mixed"; detail: string } {
  const failures = statuses.filter((s) => s === 0).length;
  // 401/403 is the NORMAL wrong-code deny here — only explicit throttle
  // statuses (429/423) or throttle/lockout copy count as a control.
  const throttleHits = statuses.filter((s) => s === 429 || s === 423).length
    + bodies.filter((b) => THROTTLE_RE.test(b)).length;
  if (failures === statuses.length) return { kind: "mixed", detail: "semua request gagal jaringan" };
  if (throttleHits > 0) return { kind: "seen", detail: `sinyal throttle/lockout terlihat (${throttleHits} respons) — kontrol rate-limit ADA (coba lagi dengan jeda lebih panjang untuk memetakan batasnya)` };
  if (failures > 0) return { kind: "mixed", detail: `${failures} request gagal jaringan — hasil tidak konklusif` };
  return { kind: "absent", detail: `tidak ada throttle/lockout pada volley ini — kandidat NO-RATE-LIMIT` };
}

/**
 * Oracle detection: did ANY volley response differ from the wrong-code
 * baseline (status or normalized body)? A differing response may be an
 * acceptance, an expiry message, or state change — always needs manual
 * verification. Pure.
 */
export function oracleSignatures(baseline: ProbeResult, responses: ProbeResult[]): { diffIdx: number[]; successLike: number[] } {
  const baseDigest = baseline.body.replace(/\d+/g, "N").slice(0, 200);
  const diffIdx: number[] = [];
  const successLike: number[] = [];
  responses.forEach((r, i) => {
    if (r.error || r.status === 0) return;
    const d = r.body.replace(/\d+/g, "N").slice(0, 200);
    if (r.status !== baseline.status || d !== baseDigest) {
      diffIdx.push(i);
      if (r.status >= 200 && r.status < 300 && !THROTTLE_RE.test(r.body)) successLike.push(i);
    }
  });
  return { diffIdx, successLike };
}

/**
 * Code-space entropy from user-supplied REAL sample codes (e.g. the owner's
 * own SMS/emails — never third-party codes). Pure.
 * 6-digit numeric = 10^6 = ~19.9 bits (feasible without rate limit);
 * 4-digit = 13.3 bits (trivially brute-able). Repeats in a small sample are a
 * weak-entropy signal. Non-numeric/uneven lengths are reported honestly.
 */
export function otpEntropy(codes: string[]): { bits: number | null; space: string; verdict: string } {
  const clean = codes.map((c) => c.trim()).filter(Boolean);
  if (!clean.length) return { bits: null, space: "?", verdict: "tidak ada sample kode — kirim `samples` (kode milikmu sendiri) untuk hitung entropy" };
  const len = clean[0].length;
  if (clean.some((c) => c.length !== len)) return { bits: null, space: "?", verdict: `panjang kode tidak konsisten (${[...new Set(clean.map((c) => c.length))].join(",")}) — entropy tidak bisa dihitung` };
  if (clean.some((c) => !/^\d+$/.test(c))) return { bits: null, space: `len=${len} non-numerik`, verdict: "kode non-numerik — space tergantung alfabet; entropy penuh dihitung manual" };
  const space = Math.pow(10, len);
  const bits = Math.log2(space);
  const uniq = new Set(clean).size;
  let verdict: string;
  if (bits < 17) verdict = `LEMAH — hanya ${space.toExponential()} kemungkinan (4 digit ≈ brute mungkin tanpa rate-limit)`;
  else if (bits < 21) verdict = `feasible-tanpa-rate-limit — ${space.toLocaleString("en-US")} kemungkinan (6 digit); dengan rate-limit mati + retry-expiry lemah = kandidat brute`;
  else verdict = "space besar — brute tidak praktis; fokus ke rate-limit & replay";
  if (uniq < clean.length && clean.length >= 4) verdict += `; ⚠️ ${clean.length - uniq} duplikat di sample kecil — indikasi code-space/rotasi lemah`;
  return { bits, space: String(space), verdict };
}

// ── Runner ──────────────────────────────────────────────────────────────────

/**
 * OTP rate-limit + oracle prover. `body_template` must contain the {OTP}
 * marker (replaced with distinct WRONG codes each shot). Bounded ≤15 shots,
 * politeDelay spacing — this is a controlled probe, NOT brute force.
 */
export async function otpProbe(rawUser: unknown, opts: {
  url: string; method?: string; param?: string; body_template?: string;
  session?: string; attempts?: number; samples?: string[];
}): Promise<string> {
  const u = (opts.url || "").trim();
  if (!/^https?:\/\//i.test(u)) return "Error: URL harus http(s).";
  if (!targetAllowed(u)) return "Error: SCOPE — otp_probe hanya untuk lab / engagement aktif / PENTEST_LAB_TARGETS.";
  const param = (opts.param || "code").replace(/^[^A-Za-z0-9_-]+|[^A-Za-z0-9_-]/g, "") || "code";
  const method = (opts.method || "POST").toUpperCase();
  const attempts = Math.min(15, Math.max(3, Number(opts.attempts) || 8));

  await politeDelay();
  const wrong = (i: number) => String(900000 + i * 137).slice(0, 6);
  const makeBody = (i: number): string | undefined => {
    if (opts.body_template && opts.body_template.includes("{OTP}")) return opts.body_template.replace(/\{OTP\}/g, wrong(i));
    if (opts.body_template) return opts.body_template; // user-supplied literal body (single probe)
    return JSON.stringify({ [param]: wrong(i) });
  };

  // Baseline: one wrong code.
  const base = await fetchProbe(u, { method, body: makeBody(0), session: opts.session, rawUser });
  recordHttp(rawUser, { method, url: u, status: base.status, bytes: base.body.length, ms: base.ms, at: new Date().toISOString() });
  if (base.status === 0) return `Error: baseline gagal jaringan (${base.error || "?"}).`;

  // Volley: distinct wrong codes (dodges naive per-value caching).
  const responses: ProbeResult[] = [];
  for (let i = 1; i <= attempts; i++) {
    await politeDelay();
    const r = await fetchProbe(u, { method, body: makeBody(i), session: opts.session, rawUser });
    recordHttp(rawUser, { method, url: u, status: r.status, bytes: r.body.length, ms: r.ms, at: new Date().toISOString() });
    responses.push(r);
  }

  const statuses = [base.status, ...responses.map((r) => r.status)];
  const bodies = [base.body, ...responses.map((r) => r.body)];
  const rl = rateLimitVerdict(statuses, bodies);
  const oracle = oracleSignatures(base, responses);

  const ent = otpEntropy(Array.isArray(opts.samples) ? opts.samples.map(String) : []);
  const dist = [...new Set(statuses)].map((s) => `×${statuses.filter((x) => x === s).length} ${s || "err"}`).join(", ");

  const head = `🔢 OTP PROBE ${method} ${u} — 1 baseline + ${attempts} kode salah (bounded, bukan brute); status: ${dist}.`;
  const lines: string[] = [];
  lines.push(rl.kind === "seen" ? `🟢 Rate-limit: ${rl.detail}` : rl.kind === "absent" ? `🔴 Rate-limit: ${rl.detail} (N percobaan tanpa throttle/lockout)` : `⚪ Rate-limit: ${rl.detail}`);
  if (oracle.successLike.length) {
    lines.push(`🔥 ${oracle.successLike.length} respons BERBEDA + 2xx tanpa copy throttle (indeks volley ${oracle.successLike.join(",")}) — mungkin kode diterima ATAU oracle status. Verifikasi manual dengan kode asli milikmu sendiri.`);
  } else if (oracle.diffIdx.length) {
    lines.push(`⚠️ ${oracle.diffIdx.length} respons berbeda dari baseline (indeks ${oracle.diffIdx.join(",")}) — oracle pesan (invalid vs expired) atau state berubah; baca isi responsnya.`);
  } else {
    lines.push("Semua respons salah-kode identik — tidak ada oracle terlihat dari volley ini.");
  }
  if (ent.bits !== null || opts.samples) lines.push(`Entropy: ${ent.verdict}${ent.bits !== null ? ` (~${ent.bits.toFixed(1)} bit, space ${ent.space})` : ""}`);
  else lines.push(`Entropy: ${ent.verdict}`);

  const verdict = rl.kind === "seen"
    ? "Rate-limit terlihat — kelas ini aman dari brute sederhana; cek expiry/replay secara manual."
    : rl.kind === "absent" && ent.bits !== null && ent.bits < 21
      ? "NO-RATE-LIMIT + code-space kecil = kombinasi HIGH-signal. BUTUH bukti: verifikasi manual kode asli → poc_verify → finding_add (CWE-307/CWE-330)."
      : rl.kind === "absent"
        ? "No-rate-limit terlihat pada volley ini — gabungkan dengan entropy code-space untuk menilai exploitability, lalu poc_verify sebelum finding_add (CWE-307)."
        : "Hasil tidak konklusif — perbaiki jaringan/session lalu ulangi.";
  return `${head}\n${lines.join("\n")}\n\n${verdict}\n\n⚠️ Tool ini TIDAK pernah menebak kode asli dan tidak melakukan brute penuh.`;
}
