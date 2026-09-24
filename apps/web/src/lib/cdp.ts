// CDP bridge — authenticated testing against a browser the USER controls.
//
// Why: hardened apps (Cloudflare/WAF) block programmatic replays (curl, Headless
// fetch), and auth flow needs the user's real session. Handing cookies/tokens to
// the LLM would leak them to the provider (invariant 5) — so instead Mia talks to
// the user's OWN Chrome over the local DevTools Protocol (127.0.0.1) and runs the
// request INSIDE the page context: the browser holds the secret, only the
// RESPONSE comes back. `token_from` is an in-page expression evaluated at request
// time, so even a Bearer token never appears in Mia's arguments.
//
// Setup (user, once):
//   scripts/chrome-debug.sh            # Chrome with --remote-debugging-port=9222
//   (log into the target app in that window)
// Local-only + scope-gated: a tab/request host must pass targetAllowed (lab or an
// active engagement). No network egress from Mia besides 127.0.0.1.

import { targetAllowed } from "./security";

const PORT = Number(process.env.CDP_PORT) || 9222;
const BASE = `http://127.0.0.1:${PORT}`;
const MAX_OUT = 8000;
const CDP_TIMEOUT = Number(process.env.CDP_TIMEOUT_MS) || 30_000;

type CdpTarget = { id: string; title: string; url: string; type: string; webSocketDebuggerUrl?: string };

async function listTargets(): Promise<CdpTarget[]> {
  const res = await fetch(`${BASE}/json`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`CDP ${res.status}`);
  const all = (await res.json()) as CdpTarget[];
  return all.filter((t) => t.type === "page" && !!t.webSocketDebuggerUrl && !/^devtools:\/\//i.test(t.url));
}

function truncate(s: string): string {
  const t = (s || "").trim();
  return t.length > MAX_OUT ? `${t.slice(0, MAX_OUT)}\n…(dipotong)` : t;
}

/** One `Runtime.evaluate` round-trip over the target page's WebSocket. Exported for cdpProxy (one owner). */
export function evaluate(
  wsUrl: string,
  expression: string,
  timeoutMs = CDP_TIMEOUT
): Promise<{ value?: string; error?: string }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: { value?: string; error?: string }) => {
      if (done) return;
      done = true;
      try { ws.close(); } catch { /* noop */ }
      resolve(r);
    };
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      return finish({ error: e instanceof Error ? e.message : "ws error" });
    }
    const timer = setTimeout(() => finish({ error: `CDP timeout ${timeoutMs}ms` }), timeoutMs);
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    };
    ws.onerror = () => finish({ error: "CDP websocket error (Chrome tidak bisa dihubungi di port " + PORT + ")" });
    ws.onmessage = (ev: MessageEvent) => {
      clearTimeout(timer);
      let msg: { id?: number; result?: { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } } };
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return finish({ error: "CDP reply tidak terbaca" });
      }
      if (msg.id !== 1) return; // ignore events
      if (msg.result?.exceptionDetails) {
        const d = msg.result.exceptionDetails;
        return finish({ error: d.exception?.description || d.text || "evaluate error" });
      }
      const v = msg.result?.result?.value;
      return finish({ value: typeof v === "string" ? v : JSON.stringify(v ?? null) });
    };
  });
}

/** Resolve a tab by URL substring, scope-gated. Exported for cdpProxy (one owner of WS/eval plumbing). */
export function resolveTarget(tabUrlContains: string): Promise<{ t: CdpTarget } | { error: string }> {
  return resolveTargetImpl(tabUrlContains);
}

function pickTarget(targets: CdpTarget[], match: string): CdpTarget | null {
  const m = (match || "").trim().toLowerCase();
  if (!m) return targets[0] ?? null;
  return targets.find((t) => t.url.toLowerCase().includes(m)) ?? null;
}

export async function cdpStatus(): Promise<string> {
  try {
    const targets = await listTargets();
    if (!targets.length) return "CDP: Chrome terjangkau, tapi tak ada tab halaman. Buka tab ke app target.";
    return `CDP OK (127.0.0.1:${PORT}) — ${targets.length} tab:\n${targets
      .map((t, i) => `${i + 1}. ${t.title?.slice(0, 60) || "(tanpa judul)"} — ${t.url.slice(0, 120)}`)
      .join("\n")}`;
  } catch (e) {
    return `Error: Chrome dengan remote debugging belum jalan di 127.0.0.1:${PORT} — jalankan scripts/chrome-debug.sh lalu login ke app target. (${e instanceof Error ? e.message : String(e)})`;
  }
}

async function resolveTargetImpl(tabUrlContains: string): Promise<{ t: CdpTarget } | { error: string }> {
  let targets: CdpTarget[];
  try {
    targets = await listTargets();
  } catch (e) {
    return { error: `Error: Chrome remote-debugging belum jalan di 127.0.0.1:${PORT} — jalankan scripts/chrome-debug.sh. (${e instanceof Error ? e.message : String(e)})` };
  }
  const t = pickTarget(targets, tabUrlContains);
  if (!t) return { error: `Error: tab tidak ditemukan (match="${tabUrlContains}"). Tab: ${targets.map((x) => x.url.slice(0, 80)).join(" | ")}` };
  if (!targetAllowed(t.url)) return { error: `Error: SCOPE — tab ${t.url} bukan lab/engagement aktif.` };
  return { t };
}

/** Run arbitrary JS in the (scope-gated) target tab. Read the page's own state. */
export async function cdpEval(tabUrlContains: string, expr: string): Promise<string> {
  if (!expr.trim()) return "Error: expr wajib.";
  const r = await resolveTarget(tabUrlContains);
  if ("error" in r) return r.error;
  // Pass the source through unwrapped: CDP's Runtime.evaluate returns the
  // completion value, so BOTH an expression (`1+1`, `Object.keys(localStorage)`)
  // and a statement list / IIFE work. (A wrapper like `return (expr)` broke the
  // latter with "Unexpected token ';'".)
  const out = await evaluate(r.t.webSocketDebuggerUrl!, expr);
  if (out.error) return `Error: eval — ${out.error}`;
  return `🧠 eval @ ${r.t.url.slice(0, 100)}\n${truncate(out.value ?? "(no value)")}`;
}

/**
 * Authenticated request executed INSIDE the tab (cookies + CF clearance apply).
 * Secrets stay in the browser: `token_from` is an in-page expression evaluated at
 * request time and attached as Bearer — it never enters this process's args.
 */
export async function cdpRequest(opts: {
  tab: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  token_from?: string;
  /** Fetch credentials mode. `include` (cookies) is rejected by the browser when
   *  the API answers `Access-Control-Allow-Origin: *` — use `omit` for
   *  token-in-header cross-origin APIs. Default: include. */
  credentials?: "include" | "omit" | "same-origin";
}): Promise<string> {
  const url = (opts.url || "").trim();
  if (!/^https?:\/\//i.test(url)) return "Error: url harus http(s).";
  if (!targetAllowed(url)) return "Error: SCOPE — cdp_request hanya untuk lab / engagement aktif.";
  const cred = ["include", "omit", "same-origin"].includes(opts.credentials || "") ? opts.credentials : "include";
  const r = await resolveTarget(opts.tab);
  if ("error" in r) return r.error;
  const method = (opts.method || "GET").toUpperCase();
  const expr = `(async () => {
  try {
    const token = ${opts.token_from ? `(function(){ return (${opts.token_from}); })()` : "null"};
    const headers = Object.assign({}, ${JSON.stringify(opts.headers || {})});
    if (token) headers["authorization"] = "Bearer " + token;
    const init = { method: ${JSON.stringify(method)}, headers: headers, credentials: ${JSON.stringify(cred)}, redirect: "manual" };
    ${opts.body !== undefined ? `init.body = ${JSON.stringify(opts.body)};` : ""}
    const res = await fetch(${JSON.stringify(url)}, init);
    const text = await res.text();
    const h = {}; try { res.headers.forEach((v, k) => { h[k] = v; }); } catch (e) {}
    return JSON.stringify({ status: res.status, headers: h, body: text.slice(0, 6000) });
  } catch (e) { return JSON.stringify({ error: String(e) }); }
})()`;
  const out = await evaluate(r.t.webSocketDebuggerUrl!, expr);
  if (out.error) return `Error: cdp_request — ${out.error}`;
  try {
    const parsed = JSON.parse(out.value || "{}") as { status?: number; headers?: Record<string, string>; body?: string; error?: string };
    if (parsed.error) return `Error: fetch di halaman gagal — ${parsed.error}`;
    const hdr = parsed.headers || {};
    const interesting = ["content-type", "location", "access-control-allow-origin", "set-cookie", "www-authenticate"]
      .filter((k) => hdr[k])
      .map((k) => `${k}: ${String(hdr[k]).slice(0, 160)}`)
      .join("\n");
    return `✅ ${method} ${url} → ${parsed.status} (via tab "${r.t.title?.slice(0, 40)}", sesi browser)\n${interesting ? `\n${interesting}\n` : ""}\n${truncate(parsed.body || "")}`;
  } catch {
    return `🧠 cdp_request @ ${r.t.url.slice(0, 100)}\n${truncate(out.value ?? "")}`;
  }
}

/** Navigate the (scope-gated) real browser to a URL. */
export async function cdpOpen(url: string): Promise<string> {
  const u = (url || "").trim();
  if (!/^https?:\/\//i.test(u)) return "Error: url harus http(s).";
  if (!targetAllowed(u)) return "Error: SCOPE — cdp_open hanya untuk lab / engagement aktif.";
  let targets: CdpTarget[];
  try {
    targets = await listTargets();
  } catch (e) {
    return `Error: Chrome remote-debugging belum jalan — scripts/chrome-debug.sh. (${e instanceof Error ? e.message : String(e)})`;
  }
  const t = targets[0];
  if (!t) return "Error: tak ada tab halaman untuk dinavigasi.";
  const out = await evaluate(t.webSocketDebuggerUrl!, `location.href = ${JSON.stringify(u)}; "navigating"`);
  if (out.error) return `Error: cdp_open — ${out.error}`;
  await new Promise((res) => setTimeout(res, 1500));
  return `🌐 navigasi ke ${u} di tab "${t.title?.slice(0, 40) || "?"}" — cek dengan cdp_status.`;
}
