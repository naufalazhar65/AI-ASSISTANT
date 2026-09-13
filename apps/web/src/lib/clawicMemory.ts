// Clawic Memory — mandiri durable store di .memory/ (plain markdown, no network)
// Rules: write before reply, dated+sourced, one fact one home, INDEX capped, never store secrets

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { repoRoot } from "./users";

function memRoot(): string { return join(repoRoot(), ".memory"); }
function cfgPath(): string { return join(memRoot(), "config.yaml"); }
function indexPath(cat?: string): string { return cat ? join(memRoot(), cat, "INDEX.md") : join(memRoot(), "INDEX.md"); }

function ensureRoot(): void { mkdirSync(memRoot(), { recursive: true }); }

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "entry";
}

function today(): string { return new Date().toISOString().slice(0, 10); }

function isSecret(text: string): boolean {
  return /(api[_-]?key|password|token|secret|sk-|bearer)/i.test(text);
}

// Write before reply: create category from user's words (Rule 2), not preset taxonomy
export function remember(category: string, name: string, fact: string, source: "stated"|"observed"|"inferred" = "stated"): string {
  if (isSecret(fact)) return "Error: never store secrets — declined, store a pointer instead (Rule 9)";
  if (!fact.trim()) return "Error: empty fact";
  ensureRoot();
  const cat = category.trim() ? slug(category) : "inbox";
  const catDir = join(memRoot(), cat);
  mkdirSync(catDir, { recursive: true });
  const file = join(catDir, `${slug(name)}.md`);
  const date = today();
  const keywords = name.toLowerCase().split(/\s+/).slice(0, 5).join(", ");
  let content = "";
  if (existsSync(file)) {
    const prev = readFileSync(file, "utf8");
    // If fact already exists (same line), don't duplicate (Rule 5)
    if (prev.includes(fact.trim())) return `Already stored in ${cat}/${slug(name)}.md`;
    // Prepend new fact on top of Facts section
    content = prev.replace(/(## Facts\n)/, `$1- ${date} · ${source} · ${fact.trim()}\n`);
    if (!content.includes("## Facts")) content = `# ${name}\n**Keywords:** ${keywords}\n**Updated:** ${date}\n\n## Facts\n- ${date} · ${source} · ${fact.trim()}\n\n## History\n`;
    content = content.replace(/\*\*Updated:\*\*.*/, `**Updated:** ${date}`);
  } else {
    content = `# ${name}\n**Keywords:** ${keywords}\n**Updated:** ${date}\n\n## Facts\n- ${date} · ${source} · ${fact.trim()}\n\n## History\n`;
  }
  // entry_max_lines guard (Rule 7) — keep lean, move History if >200 lines
  const lines = content.split("\n").length;
  if (lines > 200) {
    const parts = content.split("## History");
    const historyFile = join(catDir, `${slug(name)}-history.md`);
    writeFileSync(historyFile, `## History for ${name}\n` + (parts[1] || ""));
    content = parts[0] + "## History\n(see history file)\n";
  }
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
  // update category INDEX (Rule 6, capped)
  try { updateIndex(cat, slug(name)); } catch {}
  // update root INDEX
  try { updateRootIndex(cat); } catch {}
  return `Stored in ${cat}/${slug(name)}.md — ${fact.slice(0, 80)}`;
}

function updateIndex(cat: string, fileSlug: string): void {
  const idx = indexPath(cat);
  let rows: string[] = [];
  if (existsSync(idx)) rows = readFileSync(idx, "utf8").split("\n").filter((l) => l.startsWith("|") && !l.includes("Category") && !l.includes("---"));
  if (!rows.some((r) => r.includes(fileSlug))) rows.push(`| ${fileSlug} | 1 | ${today()} |`);
  // cap check
  if (rows.length > 100) {
    // split signal — for now just keep, scaling.md would handle
  }
  const header = `# ${cat} Index\n\n| File | Lines | Last Updated |\n|------|-------|--------------|\n`;
  writeFileSync(idx, header + rows.join("\n") + "\n");
}

function updateRootIndex(cat: string): void {
  const idx = indexPath();
  let txt = "";
  if (existsSync(idx)) txt = readFileSync(idx, "utf8");
  if (!txt.includes(`| ${cat} |`)) {
    const line = `| ${cat} | 1 | ${cat} |`;
    const tmp = `${idx}.tmp`;
    const next = txt.trim().endsWith("---") ? txt + `\n${line}\n` : txt + (txt.endsWith("\n") ? "" : "\n") + line + "\n";
    // ensure header exists
    const final = next.includes("# Memory Index") ? next : `# Memory Index\n\n| Category | Files | Description |\n|----------|-------|-------------|\n${line}\n`;
    writeFileSync(tmp, final);
    renameSync(tmp, idx);
  }
}

export function recall(query: string): string {
  const q = query.toLowerCase();
  const variants = [q, q.replace(/\s+/g, "-"), q.replace(/\s+/g, "_")];
  // ladder: root INDEX -> category INDEX -> file
  try {
    const rootIdx = existsSync(indexPath()) ? readFileSync(indexPath(), "utf8") : "";
    // grep category INDEX first (50-500 files optimization)
    const cats = readdirSync(memRoot(), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    for (const cat of cats) {
      const idx = indexPath(cat);
      if (!existsSync(idx)) continue;
      const idxTxt = readFileSync(idx, "utf8").toLowerCase();
      if (!variants.some((v) => idxTxt.includes(v))) continue;
      // open matching file
      const files = readdirSync(join(memRoot(), cat)).filter((f) => f.endsWith(".md") && f !== "INDEX.md");
      for (const f of files) {
        const txt = readFileSync(join(memRoot(), cat, f), "utf8");
        if (variants.some((v) => txt.toLowerCase().includes(v))) {
          const snippet = txt.split("\n").filter((l) => l.startsWith("- ")).slice(0, 3).join("\n");
          return `📄 ${cat}/${f}:15-22\n${snippet.slice(0, 500)}\n\nWant full source?`;
        }
      }
    }
    // fallback full scan <50 files
    for (const cat of cats) {
      const files = readdirSync(join(memRoot(), cat)).filter((f) => f.endsWith(".md") && f !== "INDEX.md");
      for (const f of files) {
        const txt = readFileSync(join(memRoot(), cat, f), "utf8");
        if (variants.some((v) => txt.toLowerCase().includes(v))) {
          return `📄 ${cat}/${f}\n${txt.slice(0, 600)}`;
        }
      }
    }
  } catch {}
  return `No recall for "${query}" — try 3 variants (your word, formal, slug) or add to Keywords.`;
}

export function forget(target: string): string {
  const q = slug(target);
  let removed = 0;
  try {
    const cats = readdirSync(memRoot(), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    for (const cat of cats) {
      const dir = join(memRoot(), cat);
      const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
      for (const f of files) {
        if (f.includes(q) || readFileSync(join(dir, f), "utf8").toLowerCase().includes(target.toLowerCase())) {
          // delete_policy confirm — for Mia auto, direct
          try { const { unlinkSync } = require("node:fs"); unlinkSync(join(dir, f)); removed++; } catch {}
        }
      }
    }
  } catch {}
  return removed ? `Forgot ${removed} file(s) for "${target}"` : `Nothing to forget for "${target}"`;
}

export function memoryStats(): string {
  try {
    const cats = readdirSync(memRoot(), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    let total = 0;
    const lines: string[] = ["📊 Memory (Clawic mandiri)\n", `HOT: ${cats.length} categories`];
    for (const cat of cats) {
      const n = readdirSync(join(memRoot(), cat)).filter((f) => f.endsWith(".md") && f !== "INDEX.md").length;
      total += n;
      lines.push(`  ${cat}: ${n} files`);
    }
    lines.push(`\nTotal: ${total} entry files`);
    return lines.join("\n");
  } catch (e) { return `Error: ${e instanceof Error ? e.message : String(e)}`; }
}
