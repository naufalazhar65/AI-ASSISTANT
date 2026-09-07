// Codebase QA (Mia feature 2026-09-07): index the user's project source code
// (repo root + any allowed workspace) into a searchable store so Mia can answer
// developer questions ("where is X implemented?") with real file:line
// references instead of guessing.
//
// Design:
//  - SEPARATE from personal RAG (rag.ts): code chunks must not leak into
//    per-turn memory recall — this index is only read by the codebase_search
//    tool, on demand.
//  - BM25-only ranking (identifiers are exact tokens; embeddings would be slow
//    and expensive over thousands of chunks). bm25Scores/tokenize are shared
//    with rag.ts so ranking can't drift.
//  - The walk applies the same trust boundaries as file_read (deny segments +
//    secret-file patterns, invariants 5) plus binary/media extensions.
//  - Bounded: file size cap, file/chunk caps, and a wall-clock budget so a huge
//    workspace can never hang a turn.
//  - Persisted atomically to .data/codebase-index.json (shared across users —
//    code is global, the sandbox is global) and cached in-memory on globalThis
//    so route/bundle splits share one index (same pattern as pushTarget).

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { appRoot, sandboxRoots } from "./users";
import { bm25Scores, tokenize, DocChunk } from "./rag";

const SOURCE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".css", ".scss",
  ".html", ".py", ".go", ".rs", ".java", ".kt", ".swift", ".rb", ".php", ".sh",
  ".bash", ".yml", ".yaml", ".toml", ".sql", ".prisma", ".graphql", ".vue",
  ".svelte", ".txt",
]);

// Mirrors file_read's deny list (tools.ts) plus walk-only dirs and binaries.
const WALK_DENY_SEGMENTS = new Set([
  ".git", "node_modules", ".next", ".data", "dist", "coverage", "build", "out",
  ".turbo", ".cache", "__pycache__", "venv", ".venv",
]);
const WALK_DENY_FILE: RegExp[] = [
  /^\.env/i,
  /\.local$/i,
  /\.(key|pem|crt|p12)$/i,
  /\.(png|jpe?g|gif|webp|ico|svg|mp4|mov|mp3|wav|ogg|woff2?|ttf|eot|pdf|zip|gz|tgz|dmg|exe|dll|so|dylib|wasm|node|webm|mkv|psd|sketch)$/i,
  /\.(pyc|class|o|obj|map|lock|min\.js)$/i,
];

const FILE_MAX_BYTES = 120_000;
const MAX_FILES = 4000;
const MAX_CHUNKS = 12_000;
const MAX_CHUNKS_PER_FILE = 40;
const CHUNK_LINES = 80;
const CHUNK_OVERLAP = 10;
const BUILD_BUDGET_MS = 15_000;
const STALE_MS = 24 * 60 * 60 * 1000;

export interface CodeIndex {
  builtAt: number;
  roots: string[];
  fileCount: number;
  docs: DocChunk[];
}

interface GlobalCarrier {
  __miaCodeIndex?: CodeIndex | null;
}

function globalCarrier(): GlobalCarrier {
  return globalThis as unknown as GlobalCarrier;
}

function indexFile(): string {
  return join(appRoot(), ".data", "codebase-index.json");
}

/** Split file content into line-window chunks (start/end are 1-based lines). */
export function chunkText(
  text: string,
  chunkLines = CHUNK_LINES,
  overlap = CHUNK_OVERLAP,
  maxChunks = MAX_CHUNKS_PER_FILE
): { start: number; end: number; body: string }[] {
  const lines = text.split("\n");
  const out: { start: number; end: number; body: string }[] = [];
  const step = Math.max(1, chunkLines - overlap);
  for (let i = 0; i < lines.length && out.length < maxChunks; i += step) {
    const slice = lines.slice(i, i + chunkLines);
    if (!slice.join("").trim()) break;
    out.push({ start: i + 1, end: i + slice.length, body: slice.join("\n") });
  }
  return out;
}

/** Walk the given roots and build a fresh index (bounded by budget + caps). */
export function buildIndexFromRoots(roots: string[], now = Date.now()): CodeIndex {
  const docs: DocChunk[] = [];
  let fileCount = 0;
  const deadline = Date.now() + BUILD_BUDGET_MS;
  for (let r = 0; r < roots.length; r++) {
    const root = roots[r];
    if (!existsSync(root)) continue;
    const tag = `w${r}`;
    const stack: string[] = [root];
    while (stack.length) {
      if (docs.length >= MAX_CHUNKS || fileCount >= MAX_FILES || Date.now() > deadline) break;
      const dir = stack.pop()!;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (WALK_DENY_SEGMENTS.has(name)) continue;
        const full = join(dir, name);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!st.isFile()) continue;
        if (WALK_DENY_FILE.some((re) => re.test(name))) continue;
        const dot = name.lastIndexOf(".");
        const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
        if (!SOURCE_EXTS.has(ext)) continue;
        if (st.size > FILE_MAX_BYTES) continue;
        let content: string;
        try {
          content = readFileSync(full, "utf8");
        } catch {
          continue;
        }
        fileCount++;
        const rel = relative(root, full).split("\\").join("/");
        for (const c of chunkText(content)) {
          if (docs.length >= MAX_CHUNKS) break;
          docs.push({
            id: `code:${tag}/${rel}#L${c.start}-L${c.end}`,
            source: "codebase",
            text: `${rel} (L${c.start}-L${c.end})\n${c.body}`,
          });
        }
        if (docs.length >= MAX_CHUNKS) break;
      }
    }
  }
  return { builtAt: now, roots, fileCount, docs };
}

function isFresh(idx: CodeIndex | null | undefined, roots: string[], maxAgeMs: number): boolean {
  return !!idx && Date.now() - idx.builtAt < maxAgeMs && idx.roots.join("|") === roots.join("|") && idx.docs.length > 0;
}

/** In-memory index if present, else the persisted one, else null. */
export function currentIndex(): CodeIndex | null {
  return globalCarrier().__miaCodeIndex ?? loadPersistedIndex();
}

export function loadPersistedIndex(): CodeIndex | null {
  try {
    const f = indexFile();
    if (!existsSync(f)) return null;
    const parsed = JSON.parse(readFileSync(f, "utf8")) as CodeIndex;
    if (!parsed || !Array.isArray(parsed.docs) || typeof parsed.builtAt !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveIndex(idx: CodeIndex): void {
  try {
    const f = indexFile();
    mkdirSync(join(f, ".."), { recursive: true });
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, JSON.stringify(idx));
    renameSync(tmp, f);
    globalCarrier().__miaCodeIndex = idx;
  } catch {
    /* persistence is best-effort; the in-memory copy still works */
  }
}

/** Rebuild from the current sandbox roots, persist, and cache in memory. */
export function rebuildIndex(roots: string[] = sandboxRoots()): CodeIndex {
  const idx = buildIndexFromRoots(roots);
  saveIndex(idx);
  return idx;
}

/**
 * Return a usable index: in-memory → persisted → fresh build when stale
 * (older than maxAgeMs or different roots). Never throws.
 */
export function ensureFreshIndex(maxAgeMs = STALE_MS): CodeIndex | null {
  const roots = sandboxRoots();
  const mem = globalCarrier().__miaCodeIndex;
  if (isFresh(mem, roots, maxAgeMs)) return mem!;
  const persisted = loadPersistedIndex();
  if (isFresh(persisted, roots, maxAgeMs)) {
    globalCarrier().__miaCodeIndex = persisted;
    return persisted;
  }
  try {
    return rebuildIndex(roots);
  } catch {
    return currentIndex();
  }
}

/**
 * Rank code chunks for a query (BM25 over identifiers — exact token match is
 * what code search needs). Pure: takes the index explicitly.
 */
export function searchCodebaseIn(idx: CodeIndex, query: string, topK = 5): string {
  const q = query.trim().slice(0, 300);
  const qTerms = tokenize(q);
  if (!qTerms.length || !idx.docs.length) return "No code indexed yet.";
  const ranked = bm25Scores(idx.docs, qTerms)
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  if (!ranked.length) return "No matching code found. Try a different term (function/file names help).";
  return ranked
    .map((r, i) => {
      const id = r.doc.id.replace(/^code:/, "");
      // Generous snippets: the model should answer from these alone — each
      // extra tool round costs seconds of latency.
      const snippet = r.doc.text.replace(/^[^\n]*\n/, "").slice(0, 1200);
      return `${i + 1}. ${id} (score ${r.score.toFixed(2)})\n${snippet}`;
    })
    .join("\n\n")
    .slice(0, 7000);
}

/** One-line summary for the refresh tool. */
export function indexSummary(idx: CodeIndex): string {
  const ageMin = Math.max(0, Math.round((Date.now() - idx.builtAt) / 60000));
  return `${idx.fileCount} file(s) → ${idx.docs.length} chunk(s), di-index ${ageMin} menit lalu dari ${idx.roots.length} root.`;
}
