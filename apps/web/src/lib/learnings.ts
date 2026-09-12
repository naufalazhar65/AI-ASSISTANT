import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./users";

function learningsDir(): string {
  return join(repoRoot(), ".learnings");
}

function ensureDir(): void {
  mkdirSync(learningsDir(), { recursive: true });
}

function nextId(prefix: "LRN" | "ERR" | "FEAT"): string {
  const dir = learningsDir();
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
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

function append(file: string, content: string): void {
  ensureDir();
  const full = join(learningsDir(), file);
  // ensure header exists
  if (!existsSync(full)) {
    const headers: Record<string, string> = {
      "LEARNINGS.md": "# Learnings\n\nCorrections, insights, and knowledge gaps captured during development.\n\n**Categories**: correction | insight | knowledge_gap | best_practice\n\n---\n",
      "ERRORS.md": "# Errors\n\nCommand failures and integration errors.\n\n---\n",
      "FEATURE_REQUESTS.md": "# Feature Requests\n\nCapabilities requested by the user.\n\n---\n",
    };
    try { appendFileSync(full, headers[file] ?? ""); } catch { /* ignore */ }
  }
  appendFileSync(full, content);
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
  try {
    const id = nextId("LRN");
    const now = new Date().toISOString();
    const entry = `\n## [${id}] ${opts.category}\n\n**Logged**: ${now}\n**Priority**: ${opts.priority ?? "medium"}\n**Status**: pending\n**Area**: ${opts.area ?? "backend"}\n\n### Summary\n${opts.summary.slice(0, 300)}\n\n### Details\n${(opts.details ?? opts.summary).slice(0, 800)}\n\n### Suggested Action\n${(opts.suggestedAction ?? "-").slice(0, 400)}\n\n### Metadata\n- Source: ${opts.source ?? "conversation"}\n- Related Files: ${(opts.relatedFiles ?? []).join(", ") || "-"}\n- Tags: ${(opts.tags ?? []).join(", ") || "-"}\n- Pattern-Key: ${opts.patternKey ?? "-"}\n- Recurrence-Count: 1\n- First-Seen: ${now.slice(0, 10)}\n- Last-Seen: ${now.slice(0, 10)}\n\n---\n`;
    append("LEARNINGS.md", entry);
    return id;
  } catch { return null; }
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
  try {
    const id = nextId("ERR");
    const now = new Date().toISOString();
    const entry = `\n## [${id}] ${opts.skill ?? "general"}\n\n**Logged**: ${now}\n**Priority**: high\n**Status**: pending\n**Area**: backend\n\n### Summary\n${opts.summary.slice(0, 300)}\n\n### Error\n\`\`\`\n${opts.error.slice(0, 1000)}\n\`\`\`\n\n### Context\n${(opts.context ?? "-").slice(0, 800)}\n\n### Suggested Fix\n${(opts.suggestedFix ?? "-").slice(0, 400)}\n\n### Metadata\n- Reproducible: unknown\n- Related Files: ${(opts.relatedFiles ?? []).join(", ") || "-"}\n- Pattern-Key: ${opts.patternKey ?? "-"}\n- Recurrence-Count: 1\n- First-Seen: ${now.slice(0, 10)}\n- Last-Seen: ${now.slice(0, 10)}\n\n---\n`;
    append("ERRORS.md", entry);
    return id;
  } catch { return null; }
}

export function logFeatureRequest(opts: {
  capability: string;
  context?: string;
  complexity?: "simple" | "medium" | "complex";
  suggestedImplementation?: string;
  patternKey?: string;
}): string | null {
  try {
    const id = nextId("FEAT");
    const now = new Date().toISOString();
    const entry = `\n## [${id}] ${opts.capability.slice(0, 80)}\n\n**Logged**: ${now}\n**Priority**: medium\n**Status**: pending\n**Area**: backend\n\n### Requested Capability\n${opts.capability.slice(0, 500)}\n\n### User Context\n${(opts.context ?? "-").slice(0, 600)}\n\n### Complexity Estimate\n${opts.complexity ?? "medium"}\n\n### Suggested Implementation\n${(opts.suggestedImplementation ?? "-").slice(0, 600)}\n\n### Metadata\n- Frequency: first_time\n- Pattern-Key: ${opts.patternKey ?? "-"}\n\n---\n`;
    append("FEATURE_REQUESTS.md", entry);
    return id;
  } catch { return null; }
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
        // split on ## [TYPE-
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
    for (const f of ["LEARNINGS.md", "ERRORS.md", "FEATURE_REQUESTS.md"]) {
      try {
        const txt = readFileSync(join(dir, f), "utf8");
        const pending = (txt.match(/\*\*Status\*\*: pending/g) || []).length;
        const resolved = (txt.match(/\*\*Status\*\*: resolved/g) || []).length;
        counts[f] = pending;
        totalPending += pending;
        counts[`${f}:resolved`] = resolved;
      } catch { counts[f] = 0; }
    }
    // Find promotion candidates: Recurrence-Count >=3
    const candidates: string[] = [];
    try {
      const txt = readFileSync(join(dir, "LEARNINGS.md"), "utf8");
      const entries = txt.split(/(?=^## \[)/m);
      for (const e of entries) {
        const rc = e.match(/Recurrence-Count:\s*(\d+)/);
        if (rc && Number(rc[1]) >= 3 && e.includes("**Status**: pending")) {
          const id = e.match(/## \[(LRN[^\]]+)\]/)?.[1] ?? "?";
          candidates.push(id);
        }
      }
    } catch {}
    return `Pending: LEARNINGS ${counts["LEARNINGS.md"] ?? 0} | ERRORS ${counts["ERRORS.md"] ?? 0} | FEATURES ${counts["FEATURE_REQUESTS.md"] ?? 0} (total ${totalPending})\nResolved: ${counts["LEARNINGS.md:resolved"] ?? 0}/${counts["ERRORS.md:resolved"] ?? 0}/${counts["FEATURE_REQUESTS.md:resolved"] ?? 0}\nPromotion candidates (Recurrence>=3): ${candidates.length ? candidates.join(", ") : "none"}`;
  } catch (e) { return `Error: ${e instanceof Error ? e.message : String(e)}`; }
}
