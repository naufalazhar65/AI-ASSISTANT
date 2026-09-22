// uploadFuzz.ts — file-upload attack surface prover (upload_fuzz).
//
// Sends small BENIGN marker files through an upload endpoint with bypass
// variants, then GETs the returned location to verify accessibility:
//  - extension bypass: .phtml/.php5/.phar/.svg/.jpg.php/case tricks;
//  - content-type confusion (code MIME on image ext and vice versa);
//  - polyglot marker (GIF89a + text marker, inert);
//  - path traversal in filename (../../marker.txt, bounded, lab-only).
// Verdicts per vector: UPLOADED+ACCESSIBLE (lead) / UPLOADED-unverified /
// REJECTED / ERROR. Deliberately NO .htaccess/server-config writes (could
// break the lab for everyone) and NO webshell code (marker text only).
// Sinyal ≠ vuln: confirm execution impact + `poc_verify` → `finding_add`.
// Scope-gated, bounded (≤8 vectors), session-safe. Write — confirm.

import { targetAllowed, politeDelay } from "./security";
import { sessionHeaders } from "./httpSession";

export type UploadVerdict = "LEAD" | "UNVERIFIED" | "REJECTED" | "ERROR";

export type UploadVector = {
  name: string;
  filename: string;
  contentType: string;
  body: string;
  expectAccess: boolean;
};

const MARKER = "mia-upload-probe-marker-7f3a";

/** Bounded bypass matrix (benign bodies only). Pure data. */
export function uploadVectors(): UploadVector[] {
  const txt = `${MARKER}\nplain marker file — inert\n`;
  const gif = `GIF89a\n${MARKER}\n/* inert polyglot marker */\n`;
  return [
    { name: "double-ext", filename: "shell.jpg.php", contentType: "image/jpeg", body: txt, expectAccess: true },
    { name: "phtml", filename: "shell.phtml", contentType: "text/plain", body: txt, expectAccess: true },
    { name: "php5", filename: "shell.php5", contentType: "text/plain", body: txt, expectAccess: true },
    { name: "case-trick", filename: "SHELL.PHP", contentType: "image/jpeg", body: txt, expectAccess: true },
    { name: "mime-confusion", filename: "photo.jpg", contentType: "application/x-php", body: txt, expectAccess: true },
    { name: "polyglot-gif", filename: "pic.gif", contentType: "image/gif", body: gif, expectAccess: true },
    { name: "traversal", filename: "../../marker-traverse.txt", contentType: "text/plain", body: txt, expectAccess: true },
    { name: "svg-script", filename: "img.svg", contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg"><desc>${MARKER}</desc></svg>`, expectAccess: true },
  ];
}

export type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string | FormData }) => Promise<{ status: number; body: string; headers?: Record<string, string> }>;

/** Pull a file URL/path out of an upload response (JSON keys or Location). Pure. */
export function extractFileUrl(body: string, headers?: Record<string, string>): string {
  const h = headers || {};
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === "location" && h[k]) return h[k];
  }
  try {
    const j = JSON.parse(body || "{}");
    const walk = (v: unknown): string => {
      if (typeof v === "string" && /(\/[\w\-.]+)+\.\w+|uploads?\/\S+/i.test(v)) return v;
      if (Array.isArray(v)) { for (const x of v) { const r = walk(x); if (r) return r; } }
      else if (v && typeof v === "object") { for (const x of Object.values(v as Record<string, unknown>)) { const r = walk(x); if (r) return r; } }
      return "";
    };
    return walk(j);
  } catch {
    const m = /(?:["']((?:\/|https?:\/\/)[^"']+\.\w+))/i.exec(body || "");
    return m ? m[1] : "";
  }
}

function boundary(): string {
  return `----mia${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function multipart(field: string, filename: string, contentType: string, body: string): { payload: string; contentType: string } {
  const b = boundary();
  const payload =
    `--${b}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n${body}\r\n--${b}--\r\n`;
  return { payload, contentType: `multipart/form-data; boundary=${b}` };
}

async function defaultFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string; headers?: Record<string, string> }> {
  try {
    const res = await fetch(url, {
      method: init.method || "GET",
      headers: { "User-Agent": "mia-assistant/1.0", ...(init.headers || {}) },
      body: init.method && init.method !== "GET" && init.method !== "HEAD" ? init.body : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    return { status: res.status, body: (await res.text()).slice(0, 12_000), headers };
  } catch {
    return { status: 0, body: "", headers: {} };
  }
}

/**
 * Fuzz an upload endpoint. Scope-gated, bounded.
 * `field`: form field name (default "file"). `session`: saved http_session.
 */
export async function uploadFuzz(
  rawUser: unknown,
  opts: { url?: string; field?: string; session?: string; vectors?: string[]; fetchFn?: FetchFn } = {}
): Promise<string> {
  const raw = String(opts.url || "").trim();
  if (!/^https?:\/\//i.test(raw)) return "Error: url harus http(s).";
  if (!targetAllowed(raw)) return "Error: SCOPE — upload_fuzz hanya untuk lab / engagement aktif.";
  const field = String(opts.field || "file").trim() || "file";
  const sess = opts.session ? sessionHeaders(rawUser, opts.session) : null;
  if (opts.session && !sess) return `Error: session "${opts.session}" tidak dikenal (buat via http_session / auth_setup / har_import).`;
  const headers: Record<string, string> = { ...(sess?.headers || {}) };
  if (sess?.cookie) headers["cookie"] = sess.cookie;

  const all = uploadVectors();
  const list = Array.isArray(opts.vectors) && opts.vectors.length ? all.filter((v) => (opts.vectors as string[]).includes(v.name)) : all;
  if (!list.length) return "Error: tidak ada vektor dikenal yang diminta.";
  const fetchFn = opts.fetchFn || defaultFetch;
  const origin = new URL(raw).origin;
  const lines: string[] = [`📤 UPLOAD FUZZ ${raw} (field=${field}, ${list.length} vektor, marker inert — tanpa webshell, tanpa .htaccess)`];
  let leads = 0;
  for (const v of list) {
    const mp = multipart(field, v.filename, v.contentType, v.body);
    let up: { status: number; body: string; headers?: Record<string, string> };
    try {
      await politeDelay();
      up = await fetchFn(raw, { method: "POST", headers: { ...headers, "Content-Type": mp.contentType }, body: mp.payload });
    } catch (e) {
      lines.push(`• [${v.name}] upload gagal (${e instanceof Error ? e.message : String(e)}) — ERROR.`);
      continue;
    }
    if (up.status < 200 || up.status >= 300) {
      lines.push(`• [${v.name}] ${v.filename} → ditolak (${up.status}) — REJECTED.`);
      continue;
    }
    // Accepted — resolve the stored location and verify accessibility.
    let loc = extractFileUrl(up.body, up.headers);
    if (loc && !/^https?:\/\//i.test(loc)) {
      try { loc = new URL(loc, origin).toString(); } catch { loc = ""; }
    }
    if (!loc) {
      lines.push(`• [${v.name}] ${v.filename} → diterima (${up.status}) tapi lokasi file tak terungkap — UNVERIFIED (cek manual).`);
      continue;
    }
    if (!targetAllowed(loc)) {
      lines.push(`• [${v.name}] lokasi di luar scope (${loc.slice(0, 80)}) — dilewati, UNVERIFIED.`);
      continue;
    }
    try {
      await politeDelay();
      const g = await fetchFn(loc, { headers });
      if (g.status === 200 && g.body.includes(MARKER)) {
        leads++;
        lines.push(`• [${v.name}] 🔴 ${v.filename} → TERAKSES + marker utuh di ${loc} — LEAD upload bypass.`);
      } else {
        lines.push(`• [${v.name}] ${v.filename} → lokasi ${g.status}, marker tak utuh — UNVERIFIED.`);
      }
    } catch (e) {
      lines.push(`• [${v.name}] verifikasi GET gagal (${e instanceof Error ? e.message : String(e)}) — UNVERIFIED.`);
    }
  }
  lines.push("");
  lines.push(leads ? `⚠️ ${leads} LEAD upload bypass — konfirmasi dampak eksekusi (bukan sekadar terbaca) + \`poc_verify\` → \`finding_add\`.` : "Tidak ada bypass terbukti (semua ditolak/tak terverifikasi).");
  return lines.join("\n");
}
