// ws_hunt — WebSocket security probe for authorized targets.
// Upgrades ws_probe (handshake + frames) with a REAL origin-validation test:
// a raw HTTP Upgrade handshake lets us set ANY Origin header, so we can tell a
// server that validates Origin (rejects evil) from one that doesn't (CSWSH
// candidate). Optional CDP step replays the handshake from the user's OWN
// browser tab (page cookies) to prove cross-site hijacking with real credentials.
import { targetAllowed } from "./security";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomBytes } from "node:crypto";

export type HandshakeResult = { status: number; headers: Record<string, string>; error?: string };

/** Raw WebSocket Upgrade handshake with arbitrary headers (node:http). Bounded. */
export async function wsHandshake(urlStr: string, extraHeaders: Record<string, string> = {}, timeoutMs = 8000): Promise<HandshakeResult> {
  let u: URL;
  try { u = new URL(urlStr); } catch { return { status: 0, headers: {}, error: "URL tidak valid" }; }
  if (!/^wss?:$/.test(u.protocol)) return { status: 0, headers: {}, error: "harus ws:// atau wss://" };
  // Defense in depth (audit 2026-09-23): gate here too, not just at the
  // ws_hunt entry — this function is exported and carries no session, but it
  // must never be the path that skips scope.
  const httpEquiv = urlStr.replace(/^ws(s?):\/\//i, "http$1://");
  if (!targetAllowed(httpEquiv)) return { status: 0, headers: {}, error: "SCOPE — di luar lab/engagement" };
  const tls = u.protocol === "wss:";
  const mod = tls ? httpsRequest : httpRequest;
  const headers: Record<string, string> = {
    Connection: "Upgrade",
    Upgrade: "websocket",
    "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
    Host: u.host,
    ...extraHeaders,
  };
  return await new Promise<HandshakeResult>((resolve) => {
    let settled = false;
    const finish = (r: HandshakeResult) => { if (!settled) { settled = true; resolve(r); } };
    try {
      const req = mod({ host: u.hostname, port: Number(u.port) || (tls ? 443 : 80), path: `${u.pathname}${u.search}`, headers, timeout: timeoutMs });
      req.on("upgrade", (res) => {
        const h: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) h[k.toLowerCase()] = String(v);
        finish({ status: res.statusCode || 0, headers: h });
        res.socket?.destroy();
      });
      req.on("response", (res) => {
        const h: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) h[k.toLowerCase()] = String(v);
        finish({ status: res.statusCode || 0, headers: h });
        res.destroy();
      });
      req.on("timeout", () => { req.destroy(); finish({ status: 0, headers: {}, error: "timeout" }); });
      req.on("error", (e) => finish({ status: 0, headers: {}, error: e.message }));
      req.end();
    } catch (e) {
      finish({ status: 0, headers: {}, error: e instanceof Error ? e.message : String(e) });
    }
  });
}

/**
 * Origin-validation verdict from three handshakes. Pure — unit-tested.
 * evil = Origin attacker domain; control = Origin target itself; none = no Origin.
 */
export function cswshVerdict(evil: number, control: number, none: number): string {
  const ok = (s: number) => s === 101;
  if (ok(evil) && ok(control)) return "⚠️ Origin TIDAK divalidasi (evil Origin diterima 101) → kandidat CSWSH. Bukti penuh: replay dari browser korban (CDP) dengan cookie korban.";
  if (ok(evil) && !ok(control)) return "🔥 evil Origin diterima, Origin target DITOLAK — validasi origin terbalik/buggy. CSWSH sangat mungkin.";
  if (!ok(evil) && ok(control)) return "✅ Origin divalidasi (evil ditolak, Origin target diterima).";
  if (!ok(control) && ok(none)) return "ℹ️ Semua Origin eksternal ditolak; tanpa Origin diterima — cek aturan origin (mungkin non-browser client diperbolehkan).";
  return `Handshake tidak konklusif (evil=${evil}, control=${control}, none=${none}) — endpoint mungkin butuh auth/token di query/headers.`;
}

/** Frame-level probe via native WebSocket (open → optional send → frames). */
async function nativeFrames(url: string, msg?: string): Promise<string[]> {
  const WS = (globalThis as { WebSocket?: new (url: string) => WebSocket }).WebSocket;
  if (!WS) return ["(native WebSocket tidak tersedia)"];
  return await new Promise<string[]>((resolve) => {
    const frames: string[] = [];
    let settled = false;
    let sock: WebSocket;
    const done = () => { if (!settled) { settled = true; try { sock.close(); } catch { /* noop */ } resolve(frames); } };
    try { sock = new WS(url); } catch (e) { return resolve([`connect gagal: ${e instanceof Error ? e.message : String(e)}`]); }
    const timer = setTimeout(done, 8000);
    sock.addEventListener("open", () => {
      frames.push("• OPEN (handshake 101)");
      if (msg) { try { sock.send(msg); frames.push(`• dikirim: ${msg.slice(0, 120)}`); } catch { /* noop */ } }
    });
    sock.addEventListener("message", (ev: MessageEvent) => { if (frames.length < 12) frames.push(`• recv: ${String(ev.data).slice(0, 220)}`); });
    sock.addEventListener("error", () => frames.push("• ERROR event"));
    sock.addEventListener("close", (ev: CloseEvent) => { frames.push(`• CLOSE code=${ev.code} ${ev.reason || ""}`); clearTimeout(timer); done(); });
  });
}

export async function wsHunt(rawUser: unknown, opts: { url: string; message?: string; tab?: string }): Promise<string> {
  const u = (opts.url || "").trim();
  if (!/^wss?:\/\//i.test(u)) return "Error: URL harus ws:// atau wss://.";
  const httpEquiv = u.replace(/^ws(s?):\/\//i, "http$1://");
  if (!targetAllowed(httpEquiv)) return "Error: SCOPE — ws_hunt hanya untuk lab / engagement aktif / PENTEST_LAB_TARGETS.";

  const originOf = (s: string) => { try { const x = new URL(s); return `${x.protocol === "wss:" ? "https" : "http"}://${x.host}`; } catch { return ""; } };
  const controlOrigin = originOf(u);

  const [none, evil, control] = await Promise.all([
    wsHandshake(u),
    wsHandshake(u, { Origin: "https://evil.example" }),
    wsHandshake(u, { Origin: controlOrigin || u }),
  ]);
  const verdict = cswshVerdict(evil.status, control.status, none.status);
  const lines = [
    `• tanpa Origin   → ${none.status}${none.error ? ` (${none.error})` : ""}`,
    `• Origin evil    → ${evil.status}${evil.error ? ` (${evil.error})` : ""}`,
    `• Origin target  → ${control.status}${control.error ? ` (${control.error})` : ""}`,
  ];

  let frames = "";
  if (none.status === 101) {
    const f = await nativeFrames(u, opts.message);
    frames = f.length ? `\nFrame awal:\n${f.slice(0, 10).join("\n")}` : "";
  }

  let cdpProof = "";
  if (opts.tab && none.status === 101) {
    const expr = `(async () => {
      try {
        const ws = new WebSocket(${JSON.stringify(u)});
        const out = await new Promise((resolve) => {
          const frames = [];
          const t = setTimeout(() => resolve({ opened: ws.readyState === 1, frames }), 6000);
          ws.onopen = () => { frames.push("open"); };
          ws.onmessage = (e) => { frames.push(String(e.data).slice(0, 200)); if (frames.length >= 3) { clearTimeout(t); resolve({ opened: true, frames }); } };
          ws.onerror = () => { clearTimeout(t); resolve({ opened: false, frames, error: "ws error" }); };
          ws.onclose = (e) => { clearTimeout(t); resolve({ opened: ws.readyState === 1, frames, close: e.code }); };
        });
        try { ws.close(); } catch (e) {}
        return JSON.stringify(out);
      } catch (e) { return JSON.stringify({ error: String(e) }); }
    })()`;
    const { cdpEval } = await import("./cdp");
    const res = await cdpEval(opts.tab, expr);
    cdpProof = /"opened":true/.test(res)
      ? `\n🔥 CDP (browser korban): handshake DARI PAGE dengan cookie korban → TERBUKA. CSWSH terbukti (cookie ikut otomatis).`
      : `\nCDP (browser korban): ${res.slice(0, 200)}`;
  }

  return `🔌 WS HUNT ${u}\n${lines.join("\n")}\n${verdict}${frames}${cdpProof}\n\n⚠️ CSWSH kandidat → poc_verify (evil-origin handshake deterministik) → finding_add (CWE-346).`;
}
