// Knowledge consolidation — turn old daily-memory logs into compact monthly
// summaries (P2 "Advanced Memory" follow-up). Daily files are never deleted;
// the summary lands at memory/YYYY-MM-summary.md and is indexed by rag.ts so
// Mia can recall the gist of weeks/months past, not just raw fragments.
//
// Triggered from the heartbeat tick. A summary is produced once per fully-past
// month (guarded by a _consolidation.json marker, so 9router isn't hammered and
// a failed LLM call is simply retried on the next tick). Fully deterministic
// grouping/caching; the only external call is the summarizer itself.

import { existsSync, readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";
import { resolveProvider, defaultProviderId } from "./providers";
import { logInfo } from "./appLogger";

const DAY_RE = /^(\d{4}-\d{2})-\d{2}\.md$/;
const SUMMARY_RE = /^\d{4}-\d{2}-summary\.md$/;

interface DayEntry {
  date: string;
  text: string;
}

const SUMMARY_PROMPT = [
  "You are the long-term memory layer of a personal AI assistant (Mia, Indonesian).",
  "Below are raw daily logs from the user's past month. Compress them into ONE",
  "short monthly summary in Indonesian for the user: 2-4 bullet highlights of",
  "what happened, facts learned about the user, and any open plans or pending",
  "items worth remembering. No greetings, no wrap-up sentence — just the bullets.",
  "If the logs are empty of substance, reply with exactly the word NONE.",
].join(" ");

function memoryDir(userKey: string): string {
  return join(userDataRoot(), userKey, "memory");
}

function markedPath(userKey: string): string {
  return join(memoryDir(userKey), "_consolidation.json");
}

function readMarked(userKey: string): Record<string, true> {
  try {
    const f = markedPath(userKey);
    if (!existsSync(f)) return {};
    const parsed = JSON.parse(readFileSync(f, "utf8")) as Record<string, true>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeMarked(userKey: string, marked: Record<string, true>): void {
  try {
    const f = markedPath(userKey);
    mkdirSync(dirname(f), { recursive: true });
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, JSON.stringify(marked));
    renameSync(tmp, f);
  } catch { /* best-effort */ }
}

function summaryPath(userKey: string, month: string): string {
  return join(memoryDir(userKey), `${month}-summary.md`);
}

function eligibleMonths(userKey: string): string[] {
  const dir = memoryDir(userKey);
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const months = new Set<string>();
  for (const f of files) {
    const m = DAY_RE.exec(f);
    if (m) months.add(m[1]);
  }
  const now = new Date();
  const current = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return [...months].filter((m) => m < current).sort();
}

function readMonthDays(userKey: string, month: string): DayEntry[] {
  const dir = memoryDir(userKey);
  const days = readdirSync(dir)
    .filter((f) => DAY_RE.test(f) && f.startsWith(month))
    .sort();
  const out: DayEntry[] = [];
  for (const f of days) {
    try {
      const text = readFileSync(join(dir, f), "utf8");
      if (text.trim()) out.push({ date: f.replace(/\.md$/, ""), text: text.slice(0, 3000) });
    } catch { /* ignore */ }
  }
  return out;
}

export interface ConsolidatedMonth {
  month: string;
  days: number;
  summary: string;
}

type Summarizer = (month: string, days: DayEntry[]) => Promise<string>;

async function summarizeWithLlm(month: string, days: DayEntry[]): Promise<string> {
  const provider = resolveProvider(defaultProviderId());
  if (!provider || !provider.url || !provider.apiKey || !provider.defaultModel) {
    throw new Error("no LLM provider configured for consolidation");
  }
  const joined = (days.length ? days.map((d) => `# ${d.date}\n${d.text}`).join("\n\n") : "").slice(0, 50000);
  if (!joined.trim()) return "";
  const res = await fetch(provider.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: provider.defaultModel,
      messages: [
        { role: "system", content: SUMMARY_PROMPT },
        { role: "user", content: `Month to summarize: ${month}\n\n${joined}` },
      ],
      stream: false,
      temperature: 0.2,
    }),
  });
  if (!res.ok) throw new Error(`summarize ${res.status}`);
  const json = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string | null } }[] } | null;
  const content = json?.choices?.[0]?.message?.content?.trim();
  if (!content || content.toUpperCase() === "NONE") return "";
  return content.slice(0, 3000);
}

/** Consolidate one user; returns the months summarized. `summarize` is injectable for tests. */
export async function consolidateUser(userKey: string, summarize?: Summarizer): Promise<ConsolidatedMonth[]> {
  const clean = sanitizeUser(userKey);
  if (!clean) return [];
  const fn = summarize ?? summarizeWithLlm;
  const marked = readMarked(clean);
  const done: ConsolidatedMonth[] = [];
  for (const month of eligibleMonths(clean)) {
    if (marked[month] || existsSync(summaryPath(clean, month))) continue;
    const days = readMonthDays(clean, month);
    if (!days.length) continue;
    try {
      const summary = await fn(month, days);
      if (!summary.trim()) continue;
      const dir = memoryDir(clean);
      const tmp = `${summaryPath(clean, month)}.tmp`;
      mkdirSync(dir, { recursive: true });
      writeFileSync(tmp, `# Memory summary ${month}\n\n${summary}\n`);
      renameSync(tmp, summaryPath(clean, month));
      marked[month] = true;
      writeMarked(clean, marked);
      done.push({ month, days: days.length, summary });
      logInfo("consolidate", `${clean}: summarized ${month} (${days.length} days)`);
    } catch (err) {
      logInfo("consolidate", `${clean}: ${month} skipped (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return done;
}

/** Consolidated months that have a summary file on disk (for verification). */
export function listSummariesForUser(userKey: string): string[] {
  const clean = sanitizeUser(userKey);
  if (!clean) return [];
  const dir = memoryDir(clean);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((f) => SUMMARY_RE.test(f)).sort();
  } catch {
    return [];
  }
}

/** Consolidated months that have a summary file on disk (for verification). */
export async function runConsolidationForAllUsers(): Promise<(ConsolidatedMonth & { user: string })[]> {
  const root = userDataRoot();
  if (!existsSync(root)) return [];
  const users = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => /^[A-Za-z0-9._-]+$/.test(n));
  const out: (ConsolidatedMonth & { user: string })[] = [];
  for (const user of users) {
    for (const m of await consolidateUser(user)) out.push({ user, ...m });
  }
  return out;
}