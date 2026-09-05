import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";
import { readTasks } from "./tasks";
import { readReminders } from "./reminders";
import { readAutomations } from "./automations";
import { readMoods } from "./mood";

export interface DocChunk {
  id: string;
  source: string;
  text: string;
}

const TOKEN_RE = /[a-z0-9]+/gi;

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

export function searchMemory(query: string, rawUser?: unknown, topK = 5): string {
  const q = query.trim().slice(0, 200);
  if (!q) return "empty query";
  const docs = collectDocs(rawUser);
  if (!docs.length) return "No knowledge found for this user.";

  const qTerms = tokenize(q);
  if (!qTerms.length) return "empty query";

  const N = docs.length;
  const avgLen = docs.reduce((s, d) => s + tokenize(d.text).length, 0) / N || 1;

  const df = new Map<string, number>();
  const docTokens: string[][] = docs.map((d) => {
    const toks = tokenize(d.text);
    const uniq = new Set(toks);
    for (const t of uniq) df.set(t, (df.get(t) ?? 0) + 1);
    return toks;
  });

  const k1 = 1.2;
  const b = 0.75;

  const scores = docs.map((doc, i) => {
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

  const ranked = scores.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, topK);
  if (!ranked.length) return "No relevant knowledge found.";

  return ranked.map((r, i) => `${i + 1}. [${r.doc.source}/${r.doc.id}] ${r.doc.text.slice(0, 400)} (score ${r.score.toFixed(2)})`).join("\n").slice(0, 4000);
}
