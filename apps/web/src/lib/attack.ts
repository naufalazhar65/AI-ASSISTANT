// Active attack helpers for authorized targets: race-condition probing and
// WebSocket probing. Scope-gated via security.targetAllowed; bounded + low-rate.
import { targetAllowed, politeDelay } from "./security";
import { recordHttp } from "./httpHistory";

const UA = "mia-assistant/1.0";

function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

/** Fire N identical requests concurrently to detect race-condition / missing
 *  idempotency (e.g. double-spend, duplicate coupon). Manual; do NOT use it as
 *  a DoS — count is capped. */
export async function raceAttack(
  rawUser: unknown,
  opts: { url: string; method?: string; body?: string; headers?: Record<string, string>; count?: number }
): Promise<string> {
  const u = (opts.url || "").trim();
  if (!/^https?:\/\//i.test(u)) return "Error: URL harus http(s).";
  if (!targetAllowed(u)) return "Error: SCOPE — race hanya untuk lab / engagement aktif / PENTEST_LAB_TARGETS.";
  const method = (opts.method || "POST").toUpperCase();
  const count = Math.min(30, Math.max(2, Number(opts.count) || 10));
  const headers = { "User-Agent": UA, "content-type": "application/json", ...(opts.headers || {}) };
  const send = async () => {
    const t0 = Date.now();
    try {
      const res = await fetch(u, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : opts.body, redirect: "manual", signal: AbortSignal.timeout(12_000) });
      const body = (await res.text()).slice(0, 2000);
      return { status: res.status, len: body.length, h: hash(body) };
    } catch {
      return { status: 0, len: 0, h: 0 };
    }
  };
  await politeDelay();
  const baseline = await send();
  recordHttp(rawUser, { method, url: u, status: baseline.status, bytes: baseline.len, ms: 0, at: new Date().toISOString() });
  // Fire all at (nearly) the same time.
  const results = await Promise.all(Array.from({ length: count }, () => send()));
  const outcomes = new Map<string, number>();
  for (const r of results) {
    const k = `${r.status}|${r.h}`;
    outcomes.set(k, (outcomes.get(k) || 0) + 1);
  }
  const success = results.filter((r) => r.status >= 200 && r.status < 300).length;
  const flags: string[] = [];
  if (success >= count && count >= 3) flags.push(`⚠️ SEMUA ${count} request sukses (2xx) → indikasi tidak ada proteksi race/idempotency (uji double-effect manual).`);
  if (outcomes.size > 1) flags.push(`⚠️ ${outcomes.size} outcome berbeda → indikasi race/TOCTOU (hasil tak deterministik).`);
  const dist = [...outcomes.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ×${n}`);
  const head = `🏁 RACE ${method} ${u} — ${count} request paralel; baseline ${baseline.status}/${baseline.len}b.`;
  return `${head}\nDistribusi: ${dist.join(", ")}${flags.length ? `\n${flags.join("\n")}` : "\nTidak ada indikasi race (respons seragam)."}\n\n⚠️ Sinyal ≠ exploit. Pastikan efek nyata (mis. saldo/kuota berubah) sebelum finding_add — jangan jadikan DoS.`;
}

/** Connect to a WebSocket endpoint and report handshake + first frames (does not
 *  brute force/auth). */
export async function wsProbe(rawUser: unknown, url: string, msg?: string): Promise<string> {
  const u = (url || "").trim();
  if (!/^wss?:\/\//i.test(u)) return "Error: URL harus ws:// atau wss://.";
  if (!targetAllowed(u)) return "Error: SCOPE — ws_probe hanya untuk lab / engagement aktif / PENTEST_LAB_TARGETS.";
  const WS = (globalThis as { WebSocket?: new (url: string) => WebSocket }).WebSocket;
  if (!WS) return "Error: WebSocket client tidak tersedia di Node ini.";
  return await new Promise<string>((resolve) => {
    const frames: string[] = [];
    let settled = false;
    let sock: WebSocket;
    const done = (note: string) => {
      if (settled) return;
      settled = true;
      try {
        sock.close();
      } catch { /* ignore */ }
      resolve(note);
    };
    try {
      sock = new WS(u);
    } catch (e) {
      return resolve(`Error: connect gagal (${e instanceof Error ? e.message : String(e)})`);
    }
    const timer = setTimeout(() => done("⏱️ timeout (handshake/frame tidak lengkap)"), 10_000);
    sock.addEventListener("open", () => {
      frames.push("• OPEN (handshake 101)");
      if (msg) {
        try {
          sock.send(msg);
          frames.push(`• dikirim: ${msg.slice(0, 100)}`);
        } catch { /* ignore */ }
      }
    });
    sock.addEventListener("message", (ev: MessageEvent) => {
      if (frames.length < 12) frames.push(`• recv: ${String(ev.data).slice(0, 200)}`);
    });
    sock.addEventListener("error", () => frames.push("• ERROR event"));
    sock.addEventListener("close", (ev: CloseEvent) => {
      frames.push(`• CLOSE code=${ev.code} reason=${ev.reason || "-"}`);
      clearTimeout(timer);
      done(`🔌 WS ${u}\n${frames.join("\n")}`);
    });
    recordHttp(rawUser, { method: "WS", url: u, status: 0, bytes: 0, ms: 0, at: new Date().toISOString() });
  });
}
