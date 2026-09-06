import { readFileSync, existsSync, readdirSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";
import { readTasks } from "./tasks";
import { readReminders } from "./reminders";
import { readAutomations } from "./automations";
import { readMoods } from "./mood";
import { embedTexts, cosine, embedModel } from "./embed";
import { cfgStr } from "./config";

export interface DocChunk {
  id: string;
  source: string;
  text: string;
}

interface VecDoc {
  id: string;
  source: string;
  text: string;
  vec: number[];
}

interface EmbedCache {
  model: string;
  docs: VecDoc[];
}

const TOKEN_RE = /[a-z0-9]+/gi;

function cfgFloat(key: string, def: number): number {
  const v = Number(cfgStr(key, String(def)));
  return Number.isFinite(v) ? v : def;
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(TOKEN_RE) || []).filter((t) => t.length > 1);
}

function collectDocs(rawUser?: unknown): DocChunk[] {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return [];
  const docs: DocChunk[] = [];
  const root = userDataRoot();

  try {
    const f = join(root, userKey, "notes.json");
    if (existsSync(f)) {
      const arr = JSON.parse(readFileSync(f, "utf8")) as { content: string }[];
      for (let i = 0; i < arr.length; i++) docs.push({ id: `note:${i}`, source: "notes", text: arr[i].content });
    }
  } catch { /* ignore */ }

  try {
    const tasks = readTasks(rawUser);
    for (let i = 0; i < tasks.length; i++) docs.push({ id: `task:${i}`, source: "tasks", text: `${tasks[i].text} ${tasks[i].status ?? ""}` });
  } catch { /* ignore */ }

  try {
    const rems = readReminders(rawUser);
    for (let i = 0; i < rems.length; i++) docs.push({ id: `reminder:${i}`, source: "reminders", text: rems[i].text });
  } catch { /* ignore */ }

  try {
    const autos = readAutomations(rawUser);
    for (let i = 0; i < autos.length; i++) docs.push({ id: `automation:${i}`, source: "automations", text: autos[i].prompt });
  } catch { /* ignore */ }

  try {
    const moods = readMoods(rawUser);
    for (let i = 0; i < moods.length; i++) {
      const when = new Date(moods[i].at).toISOString().slice(0, 10);
      docs.push({ id: `mood:${i}`, source: "moods", text: `${moods[i].mood} ${moods[i].note ?? ""} (${when})` });
    }
  } catch { /* ignore */ }

  try {
    const upDir = join(root, userKey, "uploads");
    if (existsSync(upDir)) {
      for (const name of readdirSync(upDir)) {
        try {
          const txt = readFileSync(join(upDir, name), "utf8");
          if (txt.trim()) docs.push({ id: `upload:${name}`, source: "uploads", text: txt.slice(0, 4000) });
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  const personaFiles = ["USER.md", "SOUL.md", "IDENTITY.md", "DREAMS.md"];
  for (const pf of personaFiles) {
    try {
      const f = join(root, userKey, "persona", pf);
      if (existsSync(f)) {
        const txt = readFileSync(f, "utf8");
        if (txt.trim()) docs.push({ id: `persona:${pf}`, source: "persona", text: txt.slice(0, 3000) });
      }
    } catch { /* ignore */ }
  }

  try {
    const memDir = join(root, userKey, "memory");
    if (existsSync(memDir)) {
      for (const name of readdirSync(memDir)) {
        if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue;
        try {
          const txt = readFileSync(join(memDir, name), "utf8");
          if (txt.trim()) docs.push({ id: `memory:${name}`, source: "memory", text: txt.slice(0, 4000) });
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  return docs;
}

function embedCachePath(userKey: string): string {
  return join(userDataRoot(), userKey, "memory", "embeddings.json");
}

function readEmbedCache(userKey: string): EmbedCache | null {
  try {
    const f = embedCachePath(userKey);
    if (!existsSync(f)) return null;
    const parsed = JSON.parse(readFileSync(f, "utf8")) as EmbedCache;
    if (!parsed || parsed.model !== embedModel() || !Array.isArray(parsed.docs)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeEmbedCache(userKey: string, cache: EmbedCache): void {
  try {
    const f = embedCachePath(userKey);
    mkdirSync(dirname(f), { recursive: true });
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache));
    renameSync(tmp, f);
  } catch { /* cache is best-effort */ }
}

/** Incremental per-user embedding refresh: only new/changed docs get embedded. */
export async function refreshEmbeddings(userKey: string, docs: DocChunk[]): Promise<VecDoc[]> {
  const model = embedModel();
  const cur = readEmbedCache(userKey) ?? { model, docs: [] };
  const byId = new Map(cur.docs.map((d) => [d.id, d]));
  const need: DocChunk[] = [];
  for (const doc of docs) {
    const ex = byId.get(doc.id);
    if (ex && ex.text === doc.text) continue;
    need.push(doc);
  }
  if (need.length) {
    const vecs = await embedTexts(need.map((d) => d.text));
    for (let i = 0; i < need.length; i++) {
      byId.set(need[i].id, { id: need[i].id, source: need[i].source, text: need[i].text, vec: vecs[i] });
    }
  }
  const fresh: VecDoc[] = [];
  for (const doc of docs) {
    const v = byId.get(doc.id);
    if (v) fresh.push(v);
  }
  writeEmbedCache(userKey, { model, docs: fresh });
  return fresh;
}

function bm25Scores(docs: DocChunk[], qTerms: string[]): { doc: DocChunk; score: number }[] {
  const N = docs.length;
  const avgLen = docs.reduce((s, d) => s + tokenize(d.text).length, 0) / N || 1;
  const df = new Map<string, number>();
  const docTokens: string[][] = docs.map((d) => {
    const toks = tokenize(d.text);
    for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
    return toks;
  });
  const k1 = 1.2;
  const b = 0.75;
  return docs.map((doc, i) => {
    const toks = docTokens[i];
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    const len = toks.length;
    let score = 0;
    for (const qt of qTerms) {
      const f = tf.get(qt) ?? 0;
      if (!f) continue;
      const n = df.get(qt) ?? 1;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (len / avgLen))));
    }
    return { doc, score };
  });
}

export async function searchMemory(query: string, rawUser?: unknown, topK = 5): Promise<string> {
  const q = query.trim().slice(0, 200);
  if (!q) return "empty query";
  const docs = collectDocs(rawUser);
  if (!docs.length) return "No knowledge found for this user.";

  const qTerms = tokenize(q);
  if (!qTerms.length) return "empty query";

  const userKey = sanitizeUser(rawUser);
  if (!userKey) return "No knowledge found for this user.";
  const bm = bm25Scores(docs, qTerms);

  let semantic: Map<string, number> | null = null;
  try {
    const vecDocs = await refreshEmbeddings(userKey, docs);
    const qv = (await embedTexts([q]))[0];
    semantic = new Map(vecDocs.map((d) => [d.id, Math.max(0, cosine(d.vec, qv))]));
  } catch { /* semantic unavailable -> plain BM25 */ }

  let ranked: { doc: DocChunk; score: number }[];
  if (semantic) {
    const maxBm = bm.reduce((m, s) => Math.max(m, s.score), 0);
    const w = cfgFloat("MEMORY_SEMANTIC_WEIGHT", 0.6);
    ranked = bm
      .map((s) => ({ doc: s.doc, score: (1 - w) * (maxBm ? s.score / maxBm : 0) + w * (semantic.get(s.doc.id) ?? 0) }))
      .filter((s) => s.score > 0.01)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  } else {
    ranked = bm.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, topK);
  }
  if (!ranked.length) return "No relevant knowledge found.";

  return ranked.map((r, i) => `${i + 1}. [${r.doc.source}/${r.doc.id}] ${r.doc.text.slice(0, 400)} (score ${r.score.toFixed(2)})`).join("\n").slice(0, 4000);
}

/** Relevant long-term memory for the current query, or "" when none is strong enough. */
export async function recallContext(rawUser?: unknown, query?: string, topK = 3): Promise<string> {
  const q = (query ?? "").trim();
  if (!q) return "";
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return "";
  const docs = collectDocs(rawUser);
  if (docs.length < 2) return "";

  let vecDocs: VecDoc[];
  let qv: number[];
  try {
    vecDocs = await refreshEmbeddings(userKey, docs);
    qv = (await embedTexts([q]))[0];
  } catch {
    return "";
  }

  const threshold = cfgFloat("MEMORY_RECALL_MIN_COS", 0.28);
  const hits = vecDocs
    .map((d) => ({ d, cos: Math.max(0, cosine(d.vec, qv)) }))
    .filter((h) => h.cos >= threshold)
    .sort((a, b) => b.cos - a.cos)
    .slice(0, topK);
  if (!hits.length) return "";

  return hits.map((h) => `- [${h.d.source}/${h.d.id}] ${h.d.text.slice(0, 160)}`).join("\n").slice(0, 900);
}

export function clearEmbedCache(userKey: string): void {
  try { unlinkSync(embedCachePath(userKey)); } catch { /* ignore */ }
}