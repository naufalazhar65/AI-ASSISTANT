// exposureHunt.ts — predictable-resource exposure scanner (exposure_hunt).
//
// Bounded GET-only sweep of well-known sensitive paths (.git/HEAD, .env,
// backups, VCS metadata, API docs) on ONE origin derived from the given URL.
// Keyless, scope-gated (base URL must pass targetAllowed; every probe is
// same-origin by construction). Secret VALUES never printed (keys only).
//
// Verdicts are honest: 200 + content marker = LEAD (poc_verify before
// finding_add); 401/403 = "exists but forbidden" (info); 404/other = silent.
// Sinyal ≠ vuln. Write — confirm (active probing).

import { targetAllowed, politeDelay } from "./security";

export type ExposureHit = { path: string; status: number; level: "lead" | "info"; note: string };

/** Bounded candidate list: { path, match (content marker), level, note }. Pure data. */
export const EXPOSURE_PATHS: Array<{ path: string; match: RegExp; level: "lead" | "info"; note: string }> = [
  { path: "/.git/HEAD", match: /ref:\s*refs\//i, level: "lead", note: "git metadata terekspos (HIGH) — coba /.git/config + object enumeration" },
  { path: "/.git/config", match: /\[(core|remote)\b/i, level: "lead", note: "git config terekspos (remotes/URL bocor)" },
  { path: "/.env", match: /^[A-Z0-9_]+=.*/m, level: "lead", note: ".env terekspos (CRITICAL bila ada KEY/SECRET — nilai di-redact)" },
  { path: "/.env.bak", match: /^[A-Z0-9_]+=.*/m, level: "lead", note: "backup .env terekspos" },
  { path: "/.env.local", match: /^[A-Z0-9_]+=.*/m, level: "lead", note: ".env.local terekspos" },
  { path: "/.svn/entries", match: /dir\b|file\b/i, level: "lead", note: "SVN metadata terekspos" },
  { path: "/.hg/requires", match: /revlog|generaldelta/i, level: "lead", note: "Mercurial metadata terekspos" },
  { path: "/.DS_Store", match: /Bud1/, level: "info", note: ".DS_Store terekspos (info disclosure ringan)" },
  { path: "/backup.zip", match: /PK\x03\x04/, level: "lead", note: "arsip backup terunduh (source disclosure)" },
  { path: "/db.sql.gz", match: /CREATE TABLE/i, level: "lead", note: "dump database terekspos (CRITICAL)" },
  { path: "/phpinfo.php", match: /PHP Version/i, level: "info", note: "phpinfo terekspos (version disclosure)" },
  { path: "/info.php", match: /PHP Version/i, level: "info", note: "phpinfo terekspos (version disclosure)" },
  { path: "/server-status", match: /Apache Status|requests currently/i, level: "lead", note: "mod_status terbuka (internal visibility)" },
  { path: "/package.json", match: /"dependencies"\s*:/, level: "info", note: "package.json terekspos (dependency enumeration)" },
  { path: "/composer.json", match: /"require"\s*:/, level: "info", note: "composer.json terekspos" },
  { path: "/swagger.json", match: /"openapi"\s*:\s*"3|"swagger"\s*:\s*"2/, level: "info", note: "spesifikasi API publik (umbrella recon)" },
  { path: "/swagger/v1/swagger.json", match: /"openapi"\s*:\s*"3|"swagger"\s*:\s*"2/, level: "info", note: "spesifikasi API publik" },
  { path: "/openapi.json", match: /"openapi"\s*:\s*"3/, level: "info", note: "spesifikasi OpenAPI publik" },
  { path: "/api-docs", match: /swagger|redoc|openapi/i, level: "info", note: "API docs terekspos" },
  { path: "/robots.txt", match: /Disallow:/i, level: "info", note: "robots.txt (cek path Disallow menarik)" },
  { path: "/sitemap.xml", match: /<urlset|<sitemapindex/i, level: "info", note: "sitemap (surface enumeration)" },
  { path: "/.well-known/security.txt", match: /Contact:/i, level: "info", note: "security.txt (kontak pelapor — justru bagus)" },
  { path: "/.gitignore", match: /\.env|node_modules/i, level: "info", note: ".gitignore terekspos (petunjuk struktur)" },
  { path: "/web.config", match: /<configuration/i, level: "info", note: "web.config terekspos (IIS)" },
];

const MAX_PATHS = 24;
const CONCURRENCY = 4;

export type ExposureProbe = (url: string) => Promise<{ status: number; body: string }>;

/** Mask secret VALUES in .env-style bodies, keep key names. Pure. */
export function redactEnvValues(body: string): string {
  return (body || "")
    .split("\n")
    .slice(0, 12)
    .map((l) => (/^\s*[A-Za-z_][A-Za-z0-9_]*\s*[:=]/.test(l) ? l.replace(/([:=]\s*).+$/, "$1[redacted]") : l))
    .join("\n")
    .slice(0, 600);
}

/** Classify one probe response. Pure. */
export function classifyExposure(path: string, status: number, body: string): ExposureHit | null {
  const spec = EXPOSURE_PATHS.find((p) => p.path === path);
  if (!spec) return null;
  if (status === 401 || status === 403) {
    return { path, status, level: "info", note: `ada tapi forbidden (${status}) — bukan temuan, catat sebagai existing surface` };
  }
  if (status !== 200) return null;
  if (!spec.match.test(body || "")) return null;
  return { path, status, level: spec.level, note: spec.note };
}

/** Default probe: plain GET with timeout (same-origin URLs only by construction). */
async function defaultProbe(url: string): Promise<{ status: number; body: string }> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "mia-assistant/1.0" }, redirect: "manual", signal: AbortSignal.timeout(12_000) });
    return { status: res.status, body: (await res.text()).slice(0, 12_000) };
  } catch {
    return { status: 0, body: "" };
  }
}

/**
 * Sweep predictable paths on the origin of `rawUrl`. Scope-gated, bounded.
 * Secret values never leave this function unredacted.
 */
export async function exposureHunt(
  rawUser: unknown,
  opts: { url?: string; paths?: string[]; probe?: ExposureProbe } = {}
): Promise<string> {
  const raw = String(opts.url || "").trim();
  if (!/^https?:\/\//i.test(raw)) return "Error: url harus http(s).";
  if (!targetAllowed(raw)) return "Error: SCOPE — exposure_hunt hanya untuk lab / engagement aktif.";
  let origin = "";
  try {
    origin = new URL(raw).origin;
  } catch {
    return "Error: URL tidak valid.";
  }
  const wanted = Array.isArray(opts.paths) && opts.paths.length
    ? EXPOSURE_PATHS.filter((p) => (opts.paths as string[]).includes(p.path))
    : EXPOSURE_PATHS;
  const list = wanted.slice(0, MAX_PATHS);
  if (!list.length) return "Error: tidak ada path dikenal yang diminta.";
  const probe = opts.probe || defaultProbe;
  void rawUser;
  const hits: Array<ExposureHit & { preview?: string }> = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, list.length) }, async () => {
    while (i < list.length) {
      const spec = list[i++];
      try {
        await politeDelay();
        const r = await probe(origin + spec.path);
        const h = classifyExposure(spec.path, r.status, r.body);
        // Lead preview is ALWAYS redacted (keys only) — raw bodies never
        // reach chat/log/memory (audit 2026-09-23).
        if (h) hits.push(h.level === "lead" ? { ...h, preview: redactEnvValues(r.body) } : h);
      } catch { /* per-path best-effort */ }
    }
  });
  await Promise.all(workers);
  hits.sort((a, b) => (a.level === b.level ? a.path.localeCompare(b.path) : a.level === "lead" ? -1 : 1));
  const head = `🧭 EXPOSURE HUNT ${origin} — ${list.length} path, ${hits.length} temuan/info.`;
  if (!hits.length) return `${head}\nTidak ada resource predictable yang terekspos (semua 404/ditolak/tanpa marker).`;
  const lines = hits.map((h) => `• [${h.level === "lead" ? "LEAD" : "info"} ${h.status}] ${h.path}\n   ↳ ${h.note}${h.preview ? `\n   ↳ cuplikan (redacted): ${h.preview.replace(/\n/g, " / ").slice(0, 200)}` : ""}`);
  const leads = hits.filter((h) => h.level === "lead").length;
  return [
    head, ...lines, "",
    leads
      ? `⚠️ ${leads} LEAD — verifikasi manual + \`poc_verify\` sebelum \`finding_add\`. Nilai secret TIDAK pernah ditampilkan (keys only).`
      : "Semua temuan level info — tidak ada kandidat finding.",
  ].join("\n");
}
