import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "./users";
import { wibDay } from "./time";

function learningsDir(): string {
  return join(repoRoot(), ".learnings");
}

function ensureDir(): void {
  mkdirSync(learningsDir(), { recursive: true });
}

function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

function nextId(prefix: "LRN" | "ERR" | "FEAT"): string {
  const dir = learningsDir();
  const date = wibDay().replace(/-/g, "");
  const files: Record<string, string> = {
    LRN: join(dir, "LEARNINGS.md"),
    ERR: join(dir, "ERRORS.md"),
    FEAT: join(dir, "FEATURE_REQUESTS.md"),
  };
  const file = files[prefix];
  let max = 0;
  try {
    const txt = readFileSync(file, "utf8");
    const re = new RegExp(`\\[${prefix}-${date}-(\\d+)\\]`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(txt))) max = Math.max(max, Number(m[1]));
  } catch { /* no file yet */ }
  const n = String(max + 1).padStart(3, "0");
  return `${prefix}-${date}-${n}`;
}

const HEADERS: Record<string, string> = {
  "LEARNINGS.md": "# Learnings\n\nCorrections, insights, and knowledge gaps captured during development.\n\n**Categories**: correction | insight | knowledge_gap | best_practice\n\n---\n",
  "ERRORS.md": "# Errors\n\nCommand failures and integration errors.\n\n---\n",
  "FEATURE_REQUESTS.md": "# Feature Requests\n\nCapabilities requested by the user.\n\n---\n",
};

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

/**
 * Promote a recurring pattern (Recurrence-Count >= 3) into the self-improving
 * HOT tier (`<repo>/.self-improving/memory.md` + `~/self-improving/memory.md`,
 * both under `## Rules`). Deduped by pattern key; never touches AGENTS.md/SOUL.md
 * (those stay owner-approved). Best-effort.
 */
function promote(patternKey: string, block: string): void {
  try {
    const summary = (block.match(/### (?:Summary|Requested Capability)\n([^\n]+)/)?.[1] ?? patternKey).trim();
    const rule = `- [${patternKey}] ${summary.slice(0, 160)} (Recurrence>=3)`;
    for (const p of [join(repoRoot(), ".self-improving", "memory.md"), join(homedir(), "self-improving", "memory.md")]) {
      try {
        if (!existsSync(p)) continue;
        let t = readFileSync(p, "utf8");
        if (t.includes(`[${patternKey}]`)) continue;
        t = /## Rules/.test(t) ? t.replace(/## Rules\n/, `## Rules\n\n${rule}\n`) : `${t.trimEnd()}\n\n## Rules\n\n${rule}\n`;
        writeAtomic(p, t);
      } catch { /* best-effort per mirror */ }
    }
  } catch { /* never throw */ }
}

type Kind = { file: string; prefix: "LRN" | "ERR" | "FEAT" };

/**
 * Shared writer: if a PENDING entry with the same Pattern-Key exists, bump its
 * Recurrence-Count + Last-Seen instead of appending a duplicate (and promote at
 * 3). Otherwise append a new entry. Best-effort, never throws.
 */
function record(kind: Kind, patternKey: string, build: (id: string, now: string) => string): string | null {
  try {
    ensureDir();
    const full = join(learningsDir(), kind.file);
    let txt = existsSync(full) ? readFileSync(full, "utf8") : "";
    if (!txt.trim()) txt = HEADERS[kind.file] ?? "";
    if (patternKey && patternKey !== "-") {
      // Split into entries first so a match can never span across entries.
      const parts = txt.split(/(?=^## \[)/m);
      const idx = parts.findIndex(
        (p) => p.startsWith("## [") && p.includes(`\n- Pattern-Key: ${patternKey}\n`) && p.includes("**Status**: pending")
      );
      if (idx >= 0) {
        const block = parts[idx];
        const count = Number(block.match(/Recurrence-Count:\s*(\d+)/)?.[1] ?? "1") + 1;
        const now = new Date().toISOString();
        parts[idx] = block
          .replace(/Recurrence-Count:\s*\d+/, `Recurrence-Count: ${count}`)
          .replace(/Last-Seen:\s*\d{4}-\d{2}-\d{2}/, `Last-Seen: ${now.slice(0, 10)}`);
        writeAtomic(full, parts.join(""));
        if (count === 3) promote(patternKey, block);
        return block.match(/## \[([^\]]+)\]/)?.[1] ?? null;
      }
    }
    const id = nextId(kind.prefix);
    writeAtomic(full, txt + build(id, new Date().toISOString()));
    return id;
  } catch { return null; }
}

// Best-effort, never throw (fire-and-forget from agent)
export function logLearning(opts: {
  category: "correction" | "insight" | "knowledge_gap" | "best_practice";
  summary: string;
  details?: string;
  suggestedAction?: string;
  priority?: "low" | "medium" | "high" | "critical";
  area?: string;
  tags?: string[];
  patternKey?: string;
  source?: string;
  relatedFiles?: string[];
}): string | null {
  const key = opts.patternKey || `learning.${opts.category}.${slug(opts.summary)}`;
  return record({ file: "LEARNINGS.md", prefix: "LRN" }, key, (id, now) =>
    `\n## [${id}] ${opts.category}\n\n**Logged**: ${now}\n**Priority**: ${opts.priority ?? "medium"}\n**Status**: pending\n**Area**: ${opts.area ?? "backend"}\n\n### Summary\n${opts.summary.slice(0, 300)}\n\n### Details\n${(opts.details ?? opts.summary).slice(0, 800)}\n\n### Suggested Action\n${(opts.suggestedAction ?? "-").slice(0, 400)}\n\n### Metadata\n- Source: ${opts.source ?? "conversation"}\n- Related Files: ${(opts.relatedFiles ?? []).join(", ") || "-"}\n- Tags: ${(opts.tags ?? []).join(", ") || "-"}\n- Pattern-Key: ${key}\n- Recurrence-Count: 1\n- First-Seen: ${now.slice(0, 10)}\n- Last-Seen: ${now.slice(0, 10)}\n\n---\n`
  );
}

export function logError(opts: {
  skill?: string;
  summary: string;
  error: string;
  context?: string;
  suggestedFix?: string;
  patternKey?: string;
  relatedFiles?: string[];
}): string | null {
  const key = opts.patternKey || `error.${slug(opts.skill ?? "general")}.${slug(opts.summary)}`;
  return record({ file: "ERRORS.md", prefix: "ERR" }, key, (id, now) =>
    `\n## [${id}] ${opts.skill ?? "general"}\n\n**Logged**: ${now}\n**Priority**: high\n**Status**: pending\n**Area**: backend\n\n### Summary\n${opts.summary.slice(0, 300)}\n\n### Error\n\`\`\`\n${opts.error.slice(0, 1000)}\n\`\`\`\n\n### Context\n${(opts.context ?? "-").slice(0, 800)}\n\n### Suggested Fix\n${(opts.suggestedFix ?? "-").slice(0, 400)}\n\n### Metadata\n- Reproducible: unknown\n- Related Files: ${(opts.relatedFiles ?? []).join(", ") || "-"}\n- Pattern-Key: ${key}\n- Recurrence-Count: 1\n- First-Seen: ${now.slice(0, 10)}\n- Last-Seen: ${now.slice(0, 10)}\n\n---\n`
  );
}

export function logFeatureRequest(opts: {
  capability: string;
  context?: string;
  complexity?: "simple" | "medium" | "complex";
  suggestedImplementation?: string;
  patternKey?: string;
}): string | null {
  const key = opts.patternKey || `feat.${slug(opts.capability)}`;
  return record({ file: "FEATURE_REQUESTS.md", prefix: "FEAT" }, key, (id, now) =>
    `\n## [${id}] ${opts.capability.slice(0, 80)}\n\n**Logged**: ${now}\n**Priority**: medium\n**Status**: pending\n**Area**: backend\n\n### Requested Capability\n${opts.capability.slice(0, 500)}\n\n### User Context\n${(opts.context ?? "-").slice(0, 600)}\n\n### Complexity Estimate\n${opts.complexity ?? "medium"}\n\n### Suggested Implementation\n${(opts.suggestedImplementation ?? "-").slice(0, 600)}\n\n### Metadata\n- Frequency: first_time\n- Pattern-Key: ${key}\n- Recurrence-Count: 1\n- First-Seen: ${now.slice(0, 10)}\n- Last-Seen: ${now.slice(0, 10)}\n\n---\n`
  );
}

// ── Read/search for Mia (exposed as tool) ───────────────────────────────
export function listLearnings(limit = 10, status: string | null = "pending"): string {
  try {
    const dir = learningsDir();
    const files = ["LEARNINGS.md", "ERRORS.md", "FEATURE_REQUESTS.md"];
    const blocks: string[] = [];
    for (const f of files) {
      try {
        const txt = readFileSync(join(dir, f), "utf8");
        const entries = txt.split(/(?=^## \[)/m).filter((s) => s.trim().startsWith("## ["));
        for (const e of entries) {
          if (status && !e.includes(`**Status**: ${status}`)) continue;
          blocks.push(`[${f}] ${e.trim().split("\n")[0]} — ${e.slice(0, 400).replace(/\n/g, " ")}`);
          if (blocks.length >= limit) break;
        }
      } catch {}
      if (blocks.length >= limit) break;
    }
    if (!blocks.length) return status ? `Tidak ada ${status} learnings.` : "Belum ada learnings.";
    return blocks.join("\n");
  } catch (e) { return `Error: ${e instanceof Error ? e.message : String(e)}`; }
}

export function searchLearnings(query: string, limit = 10): string {
  const q = query.toLowerCase();
  try {
    const dir = learningsDir();
    const files = ["LEARNINGS.md", "ERRORS.md", "FEATURE_REQUESTS.md"];
    const hits: string[] = [];
    for (const f of files) {
      try {
        const txt = readFileSync(join(dir, f), "utf8");
        const entries = txt.split(/(?=^## \[)/m).filter((s) => s.trim().startsWith("## ["));
        for (const e of entries) {
          if (e.toLowerCase().includes(q)) {
            hits.push(`[${f}] ${e.trim().split("\n")[0]}`);
            if (hits.length >= limit) break;
          }
        }
      } catch {}
      if (hits.length >= limit) break;
    }
    if (!hits.length) return `Tidak ada learnings untuk "${query}".`;
    return hits.join("\n");
  } catch (e) { return `Error: ${e instanceof Error ? e.message : String(e)}`; }
}

export function reviewLearnings(): string {
  try {
    const dir = learningsDir();
    const counts: Record<string, number> = {};
    let totalPending = 0;
    const candidates: string[] = [];
    for (const f of ["LEARNINGS.md", "ERRORS.md", "FEATURE_REQUESTS.md"]) {
      try {
        const txt = readFileSync(join(dir, f), "utf8");
        const pending = (txt.match(/\*\*Status\*\*: pending/g) || []).length;
        const resolved = (txt.match(/\*\*Status\*\*: resolved/g) || []).length;
        counts[f] = pending;
        totalPending += pending;
        counts[`${f}:resolved`] = resolved;
        // Promotion candidates live in LEARNINGS.md AND ERRORS.md.
        if (f !== "FEATURE_REQUESTS.md") {
          for (const e of txt.split(/(?=^## \[)/m)) {
            const rc = e.match(/Recurrence-Count:\s*(\d+)/);
            if (rc && Number(rc[1]) >= 3 && e.includes("**Status**: pending")) {
              candidates.push(e.match(/## \[([^\]]+)\]/)?.[1] ?? "?");
            }
          }
        }
      } catch { counts[f] = 0; }
    }
    return `Pending: LEARNINGS ${counts["LEARNINGS.md"] ?? 0} | ERRORS ${counts["ERRORS.md"] ?? 0} | FEATURES ${counts["FEATURE_REQUESTS.md"] ?? 0} (total ${totalPending})\nResolved: ${counts["LEARNINGS.md:resolved"] ?? 0}/${counts["ERRORS.md:resolved"] ?? 0}/${counts["FEATURE_REQUESTS.md:resolved"] ?? 0}\nPromotion candidates (Recurrence>=3): ${candidates.length ? candidates.join(", ") : "none"}`;
  } catch (e) { return `Error: ${e instanceof Error ? e.message : String(e)}`; }
}
