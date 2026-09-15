// Security playbooks — vendored pentest knowledge packs loaded ON DEMAND
// (mirrors Strix's dynamic skill injection, so the base prompt stays small).
// Source: adapted from Strix (https://github.com/usestrix/strix), Apache-2.0.
// Files live in apps/web/security-playbooks/<category>/<name>.md (frontmatter
// `name`/`description` + a Markdown body).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appRoot } from "./users";

type Pack = { id: string; category: string; name: string; description: string; body: string };
const MAX_CHARS = 20_000;

function packsDir(): string {
  return join(appRoot(), "security-playbooks");
}

let cache: Pack[] | null = null;
function loadPacks(): Pack[] {
  if (cache) return cache;
  const out: Pack[] = [];
  const dir = packsDir();
  if (existsSync(dir)) {
    for (const cat of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const cdir = join(dir, cat.name);
      let files: string[];
      try {
        files = readdirSync(cdir).filter((n) => n.endsWith(".md"));
      } catch {
        continue;
      }
      for (const f of files) {
        try {
          const text = readFileSync(join(cdir, f), "utf8");
          const name = text.match(/^name:\s*(.+)$/m)?.[1]?.trim() || f.replace(/\.md$/, "");
          const description = text.match(/^description:\s*(.+)$/m)?.[1]?.trim() || "";
          out.push({ id: `${cat.name}/${f.replace(/\.md$/, "")}`, category: cat.name, name, description, body: text });
        } catch {
          /* skip unreadable */
        }
      }
    }
  }
  cache = out.sort((a, b) => a.id.localeCompare(b.id));
  return cache;
}

function format(p: Pack): string {
  const body = p.body.length > MAX_CHARS ? `${p.body.slice(0, MAX_CHARS)}\n…(dipotong)` : p.body;
  return `📘 PLAYBOOK: ${p.name} [${p.category}]\n${p.description}\n\n${body}`;
}

export function listPlaybooksText(): string {
  const packs = loadPacks();
  if (!packs.length) return "Belum ada security playbook di apps/web/security-playbooks/.";
  return `📚 Security playbooks (${packs.length}):\n${packs.map((p) => `• ${p.name} [${p.category}] — ${p.description.slice(0, 120)}`).join("\n")}\n\nMuat: security_playbook name=<name> atau query=<kata kunci>.`;
}

/** Normalize a pack name/id: lowercase, drop separators (`fix-verification` == `fix_verification`). */
function normId(s: string): string {
  return s.toLowerCase().replace(/[-_\s]+/g, "");
}

/** Load one pack by name/id, or search; no args lists the catalog. */
export function securityPlaybook(name?: string, query?: string): string {
  const packs = loadPacks();
  if (!packs.length) return "Belum ada security playbook.";
  const key = normId((name || "").trim());
  if (key) {
    const p =
      packs.find((x) => normId(x.name) === key) ||
      packs.find((x) => normId(x.id) === key) ||
      packs.find((x) => normId(x.id.split("/").pop() || "") === key);
    if (!p) return `Playbook "${name}" tidak ditemukan.\n\n${listPlaybooksText()}`;
    return format(p);
  }
  const q = (query || "").trim().toLowerCase();
  if (q) {
    const terms = q.split(/[^a-z0-9]+/).filter((t) => t.length > 2);
    const scored = packs
      .map((p) => {
        const pname = p.name.toLowerCase();
        const nameTokens = new Set(pname.split(/[^a-z0-9]+/));
        const descTokens = new Set(p.description.toLowerCase().split(/[^a-z0-9]+/));
        const body = p.body.toLowerCase();
        let score = 0;
        for (const t of terms) {
          // Exact name-token match dominates so `sql` prefers sql_injection over nosql_injection.
          if (nameTokens.has(t)) score += 50;
          else if (pname.includes(t)) score += 8;
          if (descTokens.has(t)) score += 10;
          score += Math.min(body.split(t).length - 1, 8); // small, capped term-frequency signal
        }
        return { p, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    if (!scored.length) return `Tidak ada playbook cocok untuk "${query}".\n\n${listPlaybooksText()}`;
    const others = scored.slice(1, 4).map((x) => x.p.name);
    return format(scored[0].p) + (others.length ? `\n\n_(Terkait: ${others.join(", ")})_` : "");
  }
  return listPlaybooksText();
}
