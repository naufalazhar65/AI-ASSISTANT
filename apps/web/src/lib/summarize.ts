// Rolling conversation summary — keeps long chats under control.
//
// When a conversation's textual size passes ROLLING_SUMMARY_TRIGGER_CHARS, the
// OLDEST messages are dropped and compressed into one short "[percakapan
// sebelumnya]" user message via one short LLM call (same provider as the turn).
// Only the oldest messages are ever touched: the tail (last
// ROLLING_SUMMARY_KEEP_RECENT messages) stays verbatim, so tool-confirmation
// continuations, mock mode and recent context are never broken.
//
// The summary is deduped: cached (disk per-user + in-memory by hash) and
// recomputed only when the dropped slice changes — one LLM call per
// truncation boundary, not per turn. When no provider is configured, offline,
// mock, or the call fails, a deterministic compact digest is used instead —
// never a fatal network dependency.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";
import { resolveProvider, defaultProviderId, isProviderId } from "./providers";
import { ensureOpenCodeGoKey } from "./serverKeys";
import { rollingSummaryEnabled, rollingSummaryTriggerChars, rollingSummaryKeepRecent } from "./config";

export interface ChatLikeMessage {
  role?: string;
  content?: string | null | Array<{ type?: string; text?: string; image_url?: unknown }>;
  name?: string;
  tool_call_id?: string;
  [k: string]: unknown;
}

/** Human-readable text of a message (handles string content + array parts). */
export function messageText(m: ChatLikeMessage): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .filter((p): p is { text: string } => !!p && typeof p === "object" && typeof (p as { text?: string }).text === "string")
      .map((p) => p.text)
      .join(" ");
  }
  return "";
}

function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

/** Deterministic fallback digest: compact bullets, capped. */
export function deterministicDigest(texts: string[]): string {
  const LINE_CAP = 160;
  const TOTAL_CAP = 2000;
  const lines: string[] = [];
  let budget = TOTAL_CAP;
  for (const t of texts) {
    if (budget <= 0) break;
    const clean = t.replace(/\s+/g, " ").trim();
    if (!clean) continue;
    const piece = clean.length > LINE_CAP ? `${clean.slice(0, LINE_CAP - 1)}…` : clean;
    lines.push(`- ${piece}`);
    budget -= piece.length + 2;
  }
  return lines.join("\n");
}

interface SummaryCache {
  hash: string;
  summary: string;
}

const memCache = new Map<string, string>();
const MAX_MEM_ENTRIES = 200;

function cacheFile(userKey: string | null): string | null {
  if (!userKey) return null;
  return join(userDataRoot(), userKey, "rollup.json");
}

function readCache(userKey: string | null): SummaryCache | null {
  const file = cacheFile(userKey);
  if (!file) return null;
  try {
    const raw = readFileSync(file, "utf8");
    const p = JSON.parse(raw) as SummaryCache;
    return p && typeof p.hash === "string" && typeof p.summary === "string" ? p : null;
  } catch {
    return null;
  }
}

function writeCache(userKey: string | null, hash: string, summary: string): void {
  const file = cacheFile(userKey);
  memCache.set(hash, summary);
  if (memCache.size > MAX_MEM_ENTRIES) memCache.delete(memCache.keys().next().value as string);
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ hash, summary } satisfies SummaryCache));
    renameSync(tmp, file);
  } catch { /* cache is best-effort */ }
}

export interface SummarizeTextOptions {
  text: string;
  provider?: string;
  model?: string;
  /** System instruction; defaults to a concise Bahasa Indonesia summary. */
  instruction?: string;
  maxChars?: number;
}

/**
 * One-shot non-streaming summary of arbitrary text against the default (or
 * given) provider. Returns "" when no provider is configured, on mock, or on
 * failure — callers decide their own deterministic fallback.
 */
export async function summarizeText(opts: SummarizeTextOptions): Promise<string> {
  const { text, provider, model } = opts;
  const providerId = provider && isProviderId(provider) ? provider : defaultProviderId();
  if (providerId === "opencodego") ensureOpenCodeGoKey();
  const conf = resolveProvider(providerId);
  if (!conf || !conf.url) return "";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (conf.apiKey && conf.apiKey !== "EMPTY") headers.Authorization = `Bearer ${conf.apiKey}`;
  const body = JSON.stringify({
    model: model || conf.defaultModel,
    messages: [
      {
        role: "system",
        content:
          opts.instruction ??
          "Ringkas teks berikut ke dalam Bahasa Indonesia yang natural: inti utama + 2-4 poin kunci. Maksimal 150 kata, tanpa dialog baru.",
      },
      { role: "user", content: text.slice(0, opts.maxChars ?? 30000) },
    ],
    stream: false,
    temperature: 0.3,
  });
  try {
    const res = await fetch(conf.url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return "";
    const json = (await res.json().catch(() => null)) as {
      choices?: { message?: { content?: string | null } }[];
    } | null;
    return json?.choices?.[0]?.message?.content?.trim() ?? "";
  } catch {
    return "";
  }
}

export interface SummarizeOptions {
  messages: ChatLikeMessage[];
  user?: unknown;
  provider?: string;
  model?: string;
  /** Injectable summarizer (tests, opencode path). Falls back gracefully. */
  summarize?: (texts: string[]) => string | Promise<string>;
  /** Disable config gating (force on, for tests). */
  force?: boolean;
}

/**
 * Return the message list ready for a turn, with a rolling summary prepended
 * when the conversation grew past the trigger. Input array is never mutated.
 */
export async function buildSummarizedMessages(opts: SummarizeOptions): Promise<ChatLikeMessage[]> {
  const { messages, user, provider, model, summarize } = opts;
  if (!opts.force && !rollingSummaryEnabled()) return messages;
  const keepRecent = rollingSummaryKeepRecent();
  if (messages.length <= keepRecent + 2) return messages;

  const totalChars = messages.reduce((acc, m) => acc + messageText(m).length, 0);
  const trigger = rollingSummaryTriggerChars();
  if (totalChars <= trigger) return messages;

  const keep = messages.slice(-keepRecent);
  const dropped = messages.slice(0, messages.length - keepRecent);
  const textLines = dropped
    .map((m) => `${m.role ?? "?"}${m.tool_call_id ? " (tool result)" : ""}: ${messageText(m)}`)
    .filter((l) => !/:\s*$/.test(l));
  if (!textLines.length) return messages;

  const hash = sha1(textLines.join("\n"));
  const userKey = sanitizeUser(user);

  let summary = memCache.get(hash) ?? "";
  if (!summary) {
    const cached = readCache(userKey);
    if (cached && cached.hash === hash) summary = cached.summary;
  }
  if (!summary) {
    try {
      summary = (
        summarize
          ? await summarize(textLines)
          : await summarizeText({ text: textLines.join("\n").slice(0, 30000), provider, model })
      ).trim();
    } catch {
      summary = "";
    }
    if (!summary) summary = deterministicDigest(textLines);
    writeCache(userKey, hash, summary);
  }

  return [
    {
      role: "user",
      content: `[Percakapan sebelumnya — singkatan yang harus kamu pahami, JANGAN balas ini, lanjutkan konteksnya saja]\n${summary}`,
    },
    ...keep,
  ];
}