// Tech/CVE watch — fingerprint a host's technology, diff it against the last
// snapshot, and surface CVE candidates for what changed (new framework/version
// = fresh attack surface). New assets/versions are where fresh bugs live.
//
// Per-user store: .data/users/<user>/tech-watch.json. Scope-gated; the fetch is
// bounded (one GET) and read-only.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";
import { targetAllowed } from "./security";

type Snap = { host: string; tech: string[]; status: number; at: string };
const CAP = 100;

function file(rawUser: unknown): string | null {
  const u = sanitizeUser(rawUser);
  return u ? join(userDataRoot(), u, "tech-watch.json") : null;
}
function read(rawUser: unknown): Snap[] {
  const f = file(rawUser);
  if (!f || !existsSync(f)) return [];
  try {
    const j = JSON.parse(readFileSync(f, "utf8")) as unknown;
    return Array.isArray(j) ? (j as Snap[]).filter((s) => s && typeof s.host === "string") : [];
  } catch {
    return [];
  }
}
function write(rawUser: unknown, rows: Snap[]): void {
  const f = file(rawUser);
  if (!f) return;
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(rows.slice(0, CAP), null, 2));
  renameSync(tmp, f);
}

/**
 * Detect technologies from response headers + an HTML snippet. Pure — unit-tested.
 * Deliberately conservative: only well-known markers, no guessing.
 */
export function detectTech(headers: Record<string, string>, body: string): string[] {
  const out = new Set<string>();
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const b = (body || "").slice(0, 200_000);

  const server = h["server"] || "";
  if (server) out.add(`server:${server.slice(0, 80)}`);
  if (h["x-powered-by"]) out.add(`x-powered-by:${h["x-powered-by"].slice(0, 60)}`);
  if (h["x-generator"]) out.add(`x-generator:${h["x-generator"].slice(0, 60)}`);
  if (h["x-aspnet-version"]) out.add(`aspnet:${h["x-aspnet-version"]}`);
  if (h["x-drupal-cache"] || h["x-drupal-dynamic-cache"]) out.add("drupal");
  if (h["x-rack-cache"] || /_rails|rails/i.test(h["x-powered-by"] || "")) out.add("rails");
  if (h["cf-ray"]) out.add("cloudflare");

  const markers: [RegExp, string][] = [
    [/wp-content|wp-includes|\/wp-json/i, "wordpress"],
    [/_next\/static|__NEXT_DATA__/i, "next.js"],
    [/data-reactroot|react(?:\.production)?\.min\.js/i, "react"],
    [/ng-version|angular/i, "angular"],
    [/csrf-token" content=/i, "rails"],
    [/laravel_session|XSRF-TOKEN/i, "laravel"],
    [/django|csrfmiddlewaretoken/i, "django"],
    [/__VIEWSTATE|__EVENTVALIDATION/i, "asp.net webforms"],
    [/jsessionid|Spring/i, "java/spring"],
    [/shopify/i, "shopify"],
    [/wp-json|drupal/i, "drupal"],
    [/firebaseio\.com|firebaseapp\.com/i, "firebase"],
  ];
  for (const [re, name] of markers) if (re.test(b)) out.add(name);

  // Version hints (only when explicit).
  const gen = b.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']{1,80})["']/i);
  if (gen) out.add(`generator:${gen[1]}`);
  const wp = b.match(/content=["']WordPress ([\d.]+)["']/i);
  if (wp) out.add(`wordpress:${wp[1]}`);
  return [...out].slice(0, 20);
}

async function fingerprint(url: string): Promise<{ status: number; headers: Record<string, string>; tech: string[] }> {
  const res = await fetch(url, { headers: { "User-Agent": "mia-assistant/1.0" }, redirect: "follow", signal: AbortSignal.timeout(12_000) });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  const body = (await res.text()).slice(0, 200_000);
  return { status: res.status, headers, tech: detectTech(headers, body) };
}

/** Fingerprint + diff vs last snapshot + CVE candidates for changed versions. */
export async function techWatch(rawUser: unknown, urlRaw: string, opts: { cve?: boolean } = {}): Promise<string> {
  const url = (urlRaw || "").trim();
  if (!/^https?:\/\//i.test(url)) return "Error: url harus http(s).";
  if (!targetAllowed(url)) return "Error: SCOPE — tech_watch hanya untuk lab / engagement aktif.";
  let fp: { status: number; headers: Record<string, string>; tech: string[] };
  try {
    fp = await fingerprint(url);
  } catch (e) {
    return `Error: gagal fingerprint ${url} — ${e instanceof Error ? e.message : String(e)}`;
  }
  const host = new URL(url).host.toLowerCase();
  const rows = read(rawUser);
  const prev = rows.find((r) => r.host === host);
  const prevTech = new Set(prev?.tech || []);
  const added = fp.tech.filter((t) => !prevTech.has(t));
  const removed = (prev?.tech || []).filter((t) => !fp.tech.includes(t));

  const idx = rows.findIndex((r) => r.host === host);
  const snap: Snap = { host, tech: fp.tech, status: fp.status, at: new Date().toISOString() };
  if (idx >= 0) rows[idx] = snap; else rows.unshift(snap);
  write(rawUser, rows);

  const lines = [`🔎 TECH WATCH ${url}`, `status ${fp.status}`, `tech: ${fp.tech.length ? fp.tech.join(", ") : "(tak terdeteksi)"}`];
  if (!prev) lines.push("snapshot pertama — belum ada pembanding.");
  else if (added.length || removed.length) {
    lines.push(`\n⚠️ BERUBAH sejak ${prev.at}:`);
    if (added.length) lines.push(`   + ${added.join(", ")}`);
    if (removed.length) lines.push(`   - ${removed.join(", ")}`);
  } else lines.push("(tak ada perubahan teknologi sejak snapshot terakhir)");

  if (opts.cve !== false && (added.length || !prev)) {
    const targets = added.length ? added : fp.tech;
    const queries = targets
      .map((t) => t.replace(/^(server|x-powered-by|x-generator|generator):/i, "").trim())
      .filter((t) => t && !/^(cloudflare|react|firebase)$/i.test(t))
      .slice(0, 2);
    for (const q of queries) {
      try {
        const { cveIntel } = await import("./cveIntel");
        const cves = await cveIntel(q);
        lines.push(`\n🧨 CVE untuk "${q}":\n${cves.split("\n").slice(0, 6).join("\n")}`);
      } catch (e) {
        lines.push(`\n(CVE intel gagal untuk "${q}": ${e instanceof Error ? e.message : String(e)})`);
      }
    }
  }
  return lines.join("\n");
}
