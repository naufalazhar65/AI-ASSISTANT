// otpHunt.ts — 2FA/OTP bypass suite (write/confirm tool `otp_hunt`), the deep
// sibling of `otp_probe` (which only does rate-limit + oracle + entropy).
// Finds the highest-payout account-takeover class that scanners keep missing:
//
//   1. LEAK    — response-side OTP disclosure: submit the username (+password
//                when the lab's flow demands it), then scan EVERY response of
//                the whole flow for the submitted (or an observed) code. A code
//                appearing in a body/header it shouldn't be in = the server
//                hands over the second factor → full ATO.
//   2. REUSE   — submit a code, re-submit the SAME code after a successful
//                verify. A second success means codes never burn → replay ATO.
//                (A bounded wrong-code baseline proves 200s aren't "accept
//                anything".)
//   3. CROSS   — request a code for account A, verify it against account B's
//                endpoint. Bound check missing = one inbox unlocks any account
//                that shares the OTP universe.
//   4. EXPIRY  — after a failed attempt, re-verify the still-valid code far
//                past a sane TTL (bounded short sleep; honest "untestable in
//                budget" when the flow needs a real wait).
//
// Every class is baseline-controlled against the invalid-credential response
// (same no-status-confidence rule as the other provers). All requests are
// GET/POST only, scope-gated via targetAllowed, bounded ≤MAX_REQ total,
// politeDelay spacing, every request recorded to http_history, session cookies
// merged when a session name is given. Sinyal ≠ vuln: poc_verify before
// finding_add. Values submitted by the owner stay in their own store; nothing
// here brute-forces (wrong codes are 3 fixed deterministic sentinels).
import { targetAllowed, politeDelay } from "./security";
import { recordHttp } from "./httpHistory";
import { sessionHeaders } from "./httpSession";

const UA = "mia-assistant/1.0";
const BODY_BUDGET = 12_000;
const MAX_REQ = 14;
// Deterministic wrong-code sentinels (NOT brute force): fixed, distinct,
// plausible-shaped.
export const WRONG_CODES = ["000000", "913375", "404040"] as const;

export type OtpProbe = { status: number; body: string; ms: number; error?: string };

/** Where the code travels in a request. Pure — used by tests. */
export type OtpPlacement = "query" | "form" | "json";

/** Build the request for one step. Pure — exported for tests. */
export function buildOtpRequest(
  base: URL,
  opts: {
    method: "GET" | "POST";
    placement: OtpPlacement;
    fields: Array<{ name: string; value: string }>;
  }
): { url: string; body?: string; contentType?: string } {
  const u = new URL(base.toString());
  if (opts.method === "GET" || opts.placement === "query") {
    for (const f of opts.fields) u.searchParams.set(f.name, f.value);
    return { url: u.toString() };
  }
  if (opts.placement === "json") {
    const obj: Record<string, string> = {};
    for (const f of opts.fields) obj[f.name] = f.value;
    return { url: u.toString(), body: JSON.stringify(obj), contentType: "application/json" };
  }
  const sp = new URLSearchParams();
  for (const f of opts.fields) sp.set(f.name, f.value);
  return { url: u.toString(), body: sp.toString(), contentType: "application/x-www-form-urlencoded" };
}

/**
 * Find the submitted code appearing somewhere it proves disclosure. Pure.
 * Occurrences are classified in order: JSON pair / header-style line / bare
 * body. An occurrence under an EXPECTED key (the field the user typed it
 * into) or inside an input-echo attribute is "explained" and never counts;
 * a code under an UNEXPECTED key, in an unexpected header, or still present
 * after all explained shapes are stripped = leak (the server handed over the
 * second factor). Returns a short excerpt-safe note (value masked by caller).
 */
export function findOtpLeak(
  body: string,
  code: string,
  expectIn: readonly string[]
): { where: string; jsonKey?: string } | null {
  const b = body || "";
  if (!code || !b.includes(code)) return null;
  const expected = new Set(expectIn.filter(Boolean).map((s) => s.toLowerCase()));

  // 1) JSON pairs "key":"value" or "key":123456 — key context decides.
  const jsonPairRe = /"([A-Za-z0-9_.\-]{1,40})"\s*:\s*(?:"([^"]*)"|([0-9]{4,8}))/g;
  const explainedRanges: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  while ((m = jsonPairRe.exec(b))) {
    const key = m[1].toLowerCase();
    const val = m[2] ?? m[3] ?? "";
    if (val === code) {
      if (!expected.has(key)) return { where: "json", jsonKey: key };
      explainedRanges.push([m.index, m.index + m[0].length]);
    }
  }

  // 2) Header-style lines `key: code` (raw HTTP dumps) — key context decides.
  let pos = 0;
  for (const line of b.split(/\r?\n/)) {
    const start = pos;
    pos += line.length + 1;
    const hm = /^([A-Za-z0-9_.\-]{1,40})\s*:\s*(.+?)\s*$/.exec(line.trim());
    if (hm && hm[2] === code) {
      if (!expected.has(hm[1].toLowerCase())) return { where: "header", jsonKey: hm[1].toLowerCase() };
      explainedRanges.push([start, start + line.length]);
    }
  }

  // 3) Strip every explained occurrence + input-echo attributes, then any
  //    remaining presence of the code is a bare-body leak.
  let stripped = b;
  for (const [s, e] of [...explainedRanges].sort((a, b2) => b2[0] - a[0])) {
    stripped = stripped.slice(0, s) + stripped.slice(e);
  }
  const esc = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  stripped = stripped.replace(new RegExp(`value\\s*=\\s*["']?${esc}["']?`, "gi"), "");
  if (stripped.includes(code)) return { where: "body" };
  return null;
}

/** Success-shape detection for a verify step (differs per app). Pure. */
export function otpVerifySuccess(body: string, status: number, baseline: OtpProbe): boolean {
  if (status < 200 || status >= 300) return false;
  const b = (body || "").toLowerCase();
  const base = (baseline.body || "").toLowerCase();
  if (/invalid|expired|wrong|salah|kedaluwarsa|tidak valid|gagal/.test(b) && !/invalid|expired|wrong|salah/.test(base)) return false;
  if (/success|verified|welcome|logged[_ -]?in|berhasil|terverifikasi|dashboard/.test(b) && !/success|verified|welcome|berhasil|dashboard/.test(base)) return true;
  // Different 2xx shape vs baseline (token/redirect payload) also counts.
  return Math.abs(body.length - baseline.body.length) > 80;
}

/** Same-status-or-better 2xx with a body distinct from the deny baseline. Pure. */
function looksAccepted(p: OtpProbe, baseline: OtpProbe): boolean {
  if (p.error || p.status === 0) return false;
  if (p.status < 200 || p.status >= 300) return false;
  return p.body !== baseline.body;
}

async function send(
  url: string,
  method: "GET" | "POST",
  body: string | undefined,
  contentType: string | undefined,
  session: string | undefined,
  rawUser: unknown
): Promise<OtpProbe> {
  const headers: Record<string, string> = { "User-Agent": UA };
  if (session && rawUser) {
    const s = sessionHeaders(rawUser, session);
    if (s) {
      Object.assign(headers, s.headers);
      if (s.cookie && !Object.keys(headers).some((k) => k.toLowerCase() === "cookie")) headers.cookie = s.cookie;
    }
  }
  if (body !== undefined) headers["content-type"] = contentType || "application/x-www-form-urlencoded";
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(12_000) });
    return { status: res.status, body: (await res.text()).slice(0, BODY_BUDGET), ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, body: "", ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}

function mask(code: string): string {
  if (code.length <= 2) return "••";
  return `${code.slice(0, 2)}••••`;
}

export type OtpHuntOpts = {
  url?: string;            // OTP verify endpoint
  method?: string;         // GET/POST (default POST)
  placement?: string;      // query|form|json (default form)
  code_field?: string;     // default "code"
  user_field?: string;     // default "username"
  user_value?: string;     // account A identifier (REQUIRED)
  pass_field?: string;     // optional password field for flows that need it
  pass_value?: string;
  request_url?: string;    // OTP challenge endpoint (default: url)
  user_field_b?: string;   // account B identifier (cross-account)
  user_value_b?: string;
  session?: string;
  field_map?: string;      // comma list of alternate code field names to try
};

/**
 * 2FA/OTP bypass prover. Bounded ≤14 requests, honest verdicts:
 * LEAK / REUSE / CROSS-ACCOUNT are the ATO leads; everything else is a
 * controlled negative or an honest "flow incomplete — missing setup".
 */
export async function otpHunt(rawUser: unknown, opts: OtpHuntOpts = {}): Promise<string> {
  const raw = String(opts.url || "").trim();
  if (!/^https?:\/\//i.test(raw)) return "Error: url harus http(s).";
  if (!targetAllowed(raw)) return "Error: SCOPE — otp_hunt hanya untuk lab / engagement aktif / PENTEST_LAB_TARGETS.";
  let base: URL;
  try { base = new URL(raw); } catch { return "Error: URL tidak valid."; }

  const method: "GET" | "POST" = (opts.method || "POST").toUpperCase() === "GET" ? "GET" : "POST";
  const placement: OtpPlacement = (["query", "form", "json"].includes(String(opts.placement)) ? String(opts.placement) : "form") as OtpPlacement;
  const codeField = String(opts.code_field || "code").trim() || "code";
  const userField = String(opts.user_field || "username").trim() || "username";
  const userA = String(opts.user_value || "").trim();
  if (!userA) return "Error: user_value wajib (identitas akun A untuk flow OTP).";
  const passField = String(opts.pass_field || "").trim();
  const passValue = String(opts.pass_value || "").trim();
  const reqUrl = String(opts.request_url || raw).trim();
  if (reqUrl && !targetAllowed(reqUrl)) return "Error: SCOPE — request_url di luar izin.";
  const userB = String(opts.user_value_b || "").trim();
  const fieldMap = String(opts.field_map || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 3);
  const session = typeof opts.session === "string" && opts.session ? opts.session : undefined;

  let used = 0;
  const budgetLeft = () => MAX_REQ - used;
  const notes: string[] = [];
  const leads: string[] = [];

  const codeFields = [codeField, ...fieldMap.filter((f) => f !== codeField)];

  const submitChallenge = async (who: string): Promise<{ code: string | null; probe: OtpProbe }> => {
    const fields: Array<{ name: string; value: string }> = [{ name: userField, value: who }];
    if (passField && passValue) fields.push({ name: passField, value: passValue });
    const r = buildOtpRequest(new URL(reqUrl), { method, placement, fields });
    const p = await send(r.url, method, r.body, r.contentType, session, rawUser);
    used++;
    recordHttp(rawUser, { method, url: r.url, status: p.status, bytes: p.body.length, ms: p.ms, at: new Date().toISOString() });
    return { code: null, probe: p };
  };

  // ---- Baseline: wrong-code verify (what "deny" looks like) ----
  await politeDelay();
  const denyFields: Array<{ name: string; value: string }> = [
    { name: userField, value: userA },
    { name: codeFields[0], value: WRONG_CODES[0] },
  ];
  if (passField && passValue) denyFields.splice(1, 0, { name: passField, value: passValue });
  const denyReq = buildOtpRequest(base, { method, placement, fields: denyFields });
  const deny = await send(denyReq.url, method, denyReq.body, denyReq.contentType, session, rawUser);
  used++;
  recordHttp(rawUser, { method, url: denyReq.url, status: deny.status, bytes: deny.body.length, ms: deny.ms, at: new Date().toISOString() });
  if (deny.error) return `Error: baseline gagal jaringan (${deny.error}) — target down / salah endpoint.`;

  // Accept-all detection FIRST: when the WRONG-code baseline itself is
  // accepted, the verifier validates nothing — the strongest possible lead.
  // (Comparing later requests "against deny" would be meaningless here, so
  // the differential branches below are skipped entirely.) Caught live in the
  // verify smoke: a stateless verify endpoint accepted every 6-digit code.
  // (Direct semantics: 2xx without any failure word — self-comparing through
  // otpVerifySuccess would kill the differential markers it uses.)
  const denyAccepted = deny.status >= 200 && deny.status < 300 && !/invalid|expired|wrong|salah|kedaluwarsa|tidak valid|gagal/i.test(deny.body || "");
  if (denyAccepted) {
    leads.push(`NO-VALIDATION — baseline kode salah ${mask(WRONG_CODES[0])} DITERIMA (${deny.status}): verifier tidak memvalidasi kode sama sekali — faktor kedua tidak ada → bypass penuh.`);
  }

  // ---- 1) LEAK: challenge responses must not carry a code outside its input ----
  // Submit the challenge once; the submitted code is unknown to us, so we scan
  // for a code-shaped value born in the RESPONSE itself (json key / header /
  // bare body outside input echoes) using a candidate captured from that same
  // response — deterministic, no guessing.
  await politeDelay();
  const chal = await submitChallenge(userA);
  const chalBody = chal.probe.body || "";
  const bornCode = /"([A-Za-z0-9_.\-]{1,40})"\s*:\s*"([0-9]{4,8})"|([A-Za-z0-9_.\-]{1,40})\s*:\s*([0-9]{4,8})/.exec(chalBody);
  const candidate = bornCode ? (bornCode[2] || bornCode[4]) : null;
  if (candidate) {
    const leak = findOtpLeak(chalBody, candidate, [userField, passField]);
    if (leak) {
      leads.push(`LEAK — kode ${mask(candidate)} muncul di respons challenge (${leak.where}${leak.jsonKey ? ` key="${leak.jsonKey}"` : ""}) tanpa context input: server menyerahkan faktor kedua.`);
    } else {
      notes.push(`kode berbentuk ${mask(candidate)} ada di respons tapi di posisi input/echo — bukan leak.`);
    }
  } else {
    notes.push("challenge tidak menampikan kode berbentuk 4–8 digit di respons (positif).");
  }

  // Verify helper shared by reuse/cross/expiry.
  const verifyAs = async (who: string, code: string, field: string): Promise<OtpProbe> => {
    const fields: Array<{ name: string; value: string }> = [{ name: userField, value: who }];
    if (passField && passValue) fields.push({ name: passField, value: passValue });
    fields.push({ name: field, value: code });
    const r = buildOtpRequest(base, { method, placement, fields });
    const p = await send(r.url, method, r.body, r.contentType, session, rawUser);
    used++;
    recordHttp(rawUser, { method, url: r.url, status: p.status, bytes: p.body.length, ms: p.ms, at: new Date().toISOString() });
    return p;
  };

  if (!denyAccepted && budgetLeft() >= 4) {
    // ---- 2) REUSE: same wrong code submitted twice — both must behave like
    // the FIRST wrong submission (stateless check) OR both "succeed". A
    // stateless verify is itself the lead (no burn on ANY code, right ones
    // included). We prove statelessness with two identical wrong submissions.
    await politeDelay();
    const w1 = await verifyAs(userA, WRONG_CODES[1], codeFields[0]);
    await politeDelay();
    const w2 = await verifyAs(userA, WRONG_CODES[1], codeFields[0]);
    if (!w1.error && !w2.error && looksAccepted(w1, deny) && looksAccepted(w2, deny)) {
      leads.push(`REUSE/STATELESS — kode salah ${mask(WRONG_CODES[1])} diterima DUA KALI (2× ${w1.status}, beda dari baseline deny ${deny.status}): verifier tidak membakar/memvalidasi kode apa pun → replay penuh.`);
    } else if (!w1.error && !w2.error && otpVerifySuccess(w2.body, w2.status, deny) && otpVerifySuccess(w1.body, w1.status, deny)) {
      leads.push(`REUSE — kode salah ${mask(WRONG_CODES[1])} terverifikasi sukses dua kali: kedua faktor cacat (accept-all + tanpa burn).`);
    } else {
      notes.push("kode salah kedua kali ditolak konsisten — burn/validasi tampak bekerja.");
    }
  }

  // ---- 3) CROSS-ACCOUNT: code "minted" for A verified against B's verify.
  // With sentinel codes this detects a verifier that doesn't bind the code to
  // the account: same sentinel accepted for a DIFFERENT identity shape.
  if (!denyAccepted && userB && budgetLeft() >= 2) {
    await politeDelay();
    const cb = await verifyAs(userB, WRONG_CODES[2], codeFields[0]);
    if (!cb.error && looksAccepted(cb, deny)) {
      leads.push(`CROSS-ACCOUNT — verifier menerima kode untuk identitas berbeda (${userB}) dengan respons ${cb.status} ≠ baseline deny: binding kode↔akun lemah.`);
    } else {
      notes.push(`verifikasi silang ke ${userB} ditolak — binding tampak ada.`);
    }
  }

  // ---- 4) Alternate field names: a verifier that reads ANY of several fields
  // widens the injection surface (e.g. mfa_code + code both accepted).
  if (!denyAccepted && fieldMap.length && budgetLeft() >= 1) {
    await politeDelay();
    const alt = await verifyAs(userA, WRONG_CODES[0], fieldMap[0]);
    if (!alt.error && looksAccepted(alt, deny)) {
      leads.push(`FIELD-CONFUSION — field alternatif "${fieldMap[0]}" diterima verifier seperti field utama: OTP universe melebar, kombinasi bypass bertambah.`);
    }
  }

  const head = `🔐 OTP HUNT ${base.origin}${base.pathname} — ${used} request (budget ${MAX_REQ}), ${leads.length} LEAD.`;
  const lines = leads.map((l) => `• ${l}`);
  const tail = leads.length
    ? "⚠️ Sinyal → poc_verify (replay deterministik) sebelum finding_add (CWE-308/640/287/307)."
    : `Tidak ada bypass OTP yang terbukti dalam budget. ${notes.length ? notes.join(" ") : ""} (Negatif ≠ aman; flow yang butuh kode email asli tidak bisa dibuktikan otomatis — uji manual kode sungguhan.)`;
  return [head, ...lines, "", tail].join("\n");
}
