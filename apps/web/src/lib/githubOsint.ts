// github_osint — keyless public-source recon on GitHub data.
// Two actions:
//   code    — grep.app public code search (no auth) for a domain/query; hits are
//             scanned with scanTextSecrets (types+lines only, values REDACTED).
//   commits — unauthenticated GitHub REST commit history for a public repo;
//             recent diffs are scanned for secrets ADDED in history (classic
//             "rotated the key but it's still in commit abc123" finding).
// Public OSINT only (like recon_subdomains) — no targetAllowed gate, but all
// output is redacted (types + locations, never secret values). Bounded requests.
import { scanTextSecrets, politeDelay } from "./security";

const UA = "mia-assistant/1.0";

/** Dorks built from a bare domain. Pure — unit-tested. */
export function domainDorks(domain: string): string[] {
  const d = domain.replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "").trim();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d)) return [];
  return [
    `"${d}" password`,
    `"${d}" api_key`,
    `"${d}" authorization bearer`,
    `"@${d}" smtp OR smtp_pass`,
    `"${d}" jdbc OR mongodb+srv OR postgres://`,
    `"${d}" secret`,
  ];
}

type GrepHit = { repo: string; path: string; snippet: string };

/** Parse grep.app API JSON defensively (schema moved between versions). Pure. */
export function parseGrepApp(json: unknown): GrepHit[] {
  const hits = (json as { hits?: { hits?: unknown[] } })?.hits?.hits;
  if (!Array.isArray(hits)) return [];
  const out: GrepHit[] = [];
  for (const h of hits) {
    const src = (h as { _source?: Record<string, unknown> })._source || (h as Record<string, unknown>);
    const pick = (v: unknown): string => {
      if (typeof v === "string") return v;
      if (v && typeof v === "object" && "raw" in (v as Record<string, unknown>)) return String((v as { raw: unknown }).raw);
      return "";
    };
    const repo = pick(src.repo);
    const path = pick(src.path);
    const content = src.content as { snippet?: unknown; raw?: unknown } | undefined;
    const snippet = pick(content?.snippet) || pick(content?.raw) || "";
    if (repo && path) out.push({ repo, path, snippet });
  }
  return out;
}

type Commit = { sha: string; message: string };

/** Repo slug from a URL or owner/name. Pure. */
export function repoSlug(repo: string): string | null {
  const s = repo.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(s) ? s : null;
}

const ROTATE_RE = /\b(rotate|revoke|remove|leak|expose|delete)\b.*\b(key|token|secret|credential|password)s?\b|\b(key|token|secret|credential|password)s?\b.*\b(rotate|revoke|remove|leak|expose)\b/i;

async function getJson(url: string, accept?: string): Promise<{ status: number; json?: unknown; text?: string }> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: accept || "application/vnd.github+json" }, signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    try { return { status: res.status, json: JSON.parse(text), text }; } catch { return { status: res.status, text }; }
  } catch (e) {
    return { status: 0, text: `Error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function githubOsint(rawUser: unknown, opts: { action?: string; domain?: string; q?: string; repo?: string; max?: number }): Promise<string> {
  void rawUser;
  const action = (opts.action || "code").toLowerCase();

  if (action === "code") {
    const queries = opts.q ? [opts.q] : domainDorks(opts.domain || "");
    if (!queries.length) return "Error: isi `domain` (mis. target.com) ATAU `q` (query pencarian).";
    const lines: string[] = [];
    let reqs = 0;
    for (const q of queries) {
      if (reqs >= 6) break;
      const res = await getJson(`https://grep.app/api/search?q=${encodeURIComponent(q)}`);
      reqs++;
      if (res.status !== 200) { lines.push(`• "${q}" — grep.app HTTP ${res.status}`); await politeDelay(); continue; }
      const hits = parseGrepApp(res.json).slice(0, 8);
      if (!hits.length) { lines.push(`• "${q}" — 0 hit publik`); await politeDelay(); continue; }
      for (const h of hits) {
        const secrets = scanTextSecrets(h.snippet, 10);
        // Secret values NEVER reach chat/log/memory (audit 2026-09-23): flagged
        // hits cite repo → path + type only, never the snippet text.
        if (secrets.length) {
          const tag = ` 🚨 secret: ${secrets.map((s) => s.type).join(",")} (nilai DISENSUR — snippet disembunyikan)`;
          lines.push(`• ${h.repo} → ${h.path}${tag}`);
        } else {
          lines.push(`• ${h.repo} → ${h.path}\n   ${h.snippet.replace(/\s+/g, " ").slice(0, 160)}`);
        }
      }
      await politeDelay();
    }
    return `🐙 GITHUB OSINT (code, keyless) — ${queries.length} dork${queries.length > 1 ? "s" : ""}\n${lines.join("\n") || "Tidak ada hasil."}\n\n🚨 = indikasi kredensial publik. Verifikasi repo/commit-nya, konfirmasi kredensial masih hidup (JIKA milik sendiri/berizin), lalu finding_add (cracked/leaked credentials, CVSS sesuai dampak). Nilai rahasia TIDAK pernah ditampilkan.`;
  }

  if (action === "commits") {
    const slug = repoSlug(opts.repo || "");
    if (!slug) return "Error: `repo` harus owner/name atau URL github.com/owner/name.";
    const max = Math.min(10, Math.max(1, Number(opts.max) || 6));
    const list = await getJson(`https://api.github.com/repos/${slug}/commits?per_page=${max}`);
    if (list.status === 404) return `Error: repo ${slug} tidak ditemukan (privat atau salah slug).`;
    if (list.status === 403) return "Error: rate-limit GitHub (60 req/jam tanpa token) — coba lagi nanti.";
    if (list.status !== 200 || !Array.isArray(list.json)) return `Error: GitHub HTTP ${list.status}.`;
    const commits = (list.json as Commit[]).slice(0, max);
    const lines: string[] = [];
    for (const c of commits) {
      const flag = ROTATE_RE.test(c.message) ? " 🚩 commit message menyebut rotate/revoke/leak" : "";
      lines.push(`• ${c.sha.slice(0, 8)} ${c.message.split("\n")[0].slice(0, 90)}${flag}`);
      await politeDelay();
      const diff = await getJson(`https://api.github.com/repos/${slug}/commits/${c.sha}`, "application/vnd.github.diff");
      if (diff.status !== 200 || !diff.text) continue;
      const secrets = scanTextSecrets(diff.text, 15);
      if (secrets.length) {
        const types = [...new Set(secrets.map((s) => s.type))];
        lines.push(`   🚨 ${types.length} jenis secret MASUK di commit ini (${types.join(", ")}) — nilai DISENSUR`);
      }
      await politeDelay();
    }
    return `🐙 GITHUB OSINT (commits) ${slug} — ${commits.length} commit terakhir dipindai\n${lines.join("\n") || "Tidak ada data."}\n\n🚨 = secret ditambahkan di riwayat commit (klasik: key sudah di-rotate tapi lama masih ada). Verifikasi manual → finding_add. Nilai rahasia TIDAK pernah ditampilkan.`;
  }

  return "Error: action harus `code` atau `commits`.";
}
