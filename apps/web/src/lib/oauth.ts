// OAuth / OIDC tester — the redirect_uri class that yields account-takeover
// bounties. Fetches the discovery document, then probes the authorization
// endpoint with bypass variants of `redirect_uri` and checks whether the server
// redirects OFF the provider host (open redirect → code/token theft when it is
// the OAuth authorize endpoint).
//
// Scope-gated, bounded (a handful of GETs), low-rate, no state change.

import { targetAllowed } from "./security";

const MAX_PROBES = 8;
const EVIL = "evil.example";

/** redirect_uri bypass variants to try against a provider host. Pure — tested. */
export function redirectVariants(host: string): { label: string; value: string }[] {
  const h = (host || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return [
    { label: "absolute-evil", value: `https://${EVIL}/` },
    { label: "scheme-relative", value: `//${EVIL}/` },
    { label: "userinfo", value: `https://${h}@${EVIL}/` },
    { label: "suffix", value: `https://${EVIL}.${h}/` },
    { label: "prefix", value: `https://${h}.${EVIL}/` },
    { label: "path-escape", value: `https://${h}/@${EVIL}/` },
  ].slice(0, MAX_PROBES - 2);
}

/**
 * Did a redirect leave the allowed provider hosts? Pure — unit-tested.
 * `location` may be relative (same host) or absolute.
 */
export function classifyOauthRedirect(status: number, location: string, allowedHosts: string[]): { open: boolean; note: string } {
  if (status < 300 || status >= 400 || !location) return { open: false, note: "" };
  const loc = location.trim();
  let host: string;
  if (loc.startsWith("//")) {
    // Protocol-relative Location ("//evil.example/cb") is off-host and browsers
    // follow it — `new URL()` without a base throws, so parse it directly.
    host = loc.slice(2).split(/[/?#]/)[0].toLowerCase();
  } else {
    try {
      host = new URL(loc).host.toLowerCase();
    } catch {
      return { open: false, note: "" }; // relative → same host
    }
  }
  const allowed = allowedHosts.map((h) => h.toLowerCase());
  const off = !allowed.some((a) => host === a || host.endsWith("." + a));
  if (!off) return { open: false, note: "" };
  if (host === EVIL || host.endsWith("." + EVIL)) return { open: true, note: `redirect ke ${host} (di LUAR provider) → open redirect` };
  return { open: false, note: `redirect ke host lain ${host} (verifikasi apakah terdaftar)` };
}

type Probe = { status: number; location: string; body: string };

async function get(url: string): Promise<Probe> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "mia-assistant/1.0" }, redirect: "manual", signal: AbortSignal.timeout(12_000) });
    const body = (await res.text()).slice(0, 3000);
    return { status: res.status, location: res.headers.get("location") || "", body };
  } catch (e) {
    return { status: 0, location: "", body: `Error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function oauthHunt(rawUser: unknown, opts: { url: string; client_id?: string }): Promise<string> {
  const url = (opts.url || "").trim();
  if (!/^https?:\/\//i.test(url)) return "Error: url harus http(s).";
  if (!targetAllowed(url)) return "Error: SCOPE — oauth_hunt hanya untuk lab / engagement aktif.";
  let origin: string;
  let host: string;
  try {
    const u = new URL(url);
    origin = u.origin;
    host = u.hostname;
  } catch {
    return "Error: url tidak valid.";
  }
  void rawUser;

  // 1) discovery
  const discUrl = /openid-configuration|oauth-authorization-server/i.test(url) ? url : `${origin}/.well-known/openid-configuration`;
  const disc = await get(discUrl);
  let cfg: Record<string, unknown> = {};
  if (disc.status === 200) {
    try {
      cfg = JSON.parse(disc.body) as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
  }
  const authEndpoint = typeof cfg.authorization_endpoint === "string" ? cfg.authorization_endpoint : "";

  const lines = [`🔐 OAUTH HUNT ${origin}`];
  const leads: string[] = [];

  lines.push(`discovery: ${discUrl} → ${disc.status}`);
  if (authEndpoint) {
    lines.push(`authorization_endpoint: ${authEndpoint}`);
    for (const k of ["token_endpoint", "jwks_uri", "registration_endpoint", "scopes_supported", "grant_types_supported"]) {
      if (cfg[k]) lines.push(`  ${k}: ${Array.isArray(cfg[k]) ? (cfg[k] as unknown[]).join(",") : String(cfg[k])}`);
    }
    if (typeof cfg.registration_endpoint === "string") leads.push(`dynamic client registration terbuka: ${cfg.registration_endpoint} (uji pendaftaran klien manual)`);
  } else {
    lines.push("discovery tidak memberi authorization_endpoint — mencoba pola umum.");
  }
  const authorize = authEndpoint || `${origin}/oauth/authorize`;
  const authHost = (() => {
    try {
      return new URL(authorize).host;
    } catch {
      return host;
    }
  })();
  const allowedHosts = [host, authHost];
  const cid = opts.client_id || "mia-test-client";

  // 2) redirect_uri bypass probes
  let probed = 0;
  for (const v of redirectVariants(authHost || host)) {
    if (probed++ >= MAX_PROBES) break;
    const u = `${authorize}?response_type=code&client_id=${encodeURIComponent(cid)}&scope=openid&state=miastate&redirect_uri=${encodeURIComponent(v.value)}`;
    const r = await get(u);
    const c = classifyOauthRedirect(r.status, r.location, allowedHosts);
    const reflected = !c.open && r.body.includes(EVIL);
    lines.push(`• ${v.label} → ${r.status}${r.location ? ` → ${r.location.slice(0, 90)}` : ""}${c.open ? "  ⚠️" : reflected ? "  (terefleksi di body)" : ""}`);
    if (c.open) leads.push(`${v.label}: ${c.note} via ${authorize} (redirect_uri=${v.value})`);
    else if (reflected) leads.push(`${v.label}: redirect_uri terefleksi di respons (cek XSS/redirect manual)`);
    await new Promise((res) => setTimeout(res, 150));
  }

  const leadBlock = leads.length
    ? `\n\n🎯 LEADS (verifikasi manual + poc_verify sebelum finding_add):\n${[...new Set(leads)].map((l) => `• ${l}`).join("\n")}`
    : "\n\n🎯 tidak ada open-redirect redirect_uri terdeteksi dari varian ini. Uji manual: state tidak divalidasi, PKCE opsional, account-linking, implicit flow.";
  return `${lines.join("\n")}${leadBlock}\n\n⚠️ Hanya satu aspek (redirect_uri). Alur lengkap (state/PKCE/token) butuh uji manual terkendali; lihat security_playbook name=oauth.`;
}
