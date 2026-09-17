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
import { fetchFingerprint } from "./techFingerprint";

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

/** Fingerprint + diff vs last snapshot + CVE candidates for changed versions. */
export async function techWatch(rawUser: unknown, urlRaw: string, opts: { cve?: boolean } = {}): Promise<string> {
  const url = (urlRaw || "").trim();
  if (!/^https?:\/\//i.test(url)) return "Error: url harus http(s).";
  if (!targetAllowed(url)) return "Error: SCOPE — tech_watch hanya untuk lab / engagement aktif.";
  let fp: { status: number; headers: Record<string, string>; tech: string[] };
  try {
    fp = await fetchFingerprint(url);
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
