/**
 * Link intelligence ("read-it-later").
 *
 * When the user shares a link in any channel (web/Telegram/Discord), the
 * deterministic post-turn hook fetches the page, summarizes it with the active
 * LLM provider (best-effort; deterministic fallback when offline), stores it in
 * a per-user reading library, and appends a note to daily memory so the
 * content becomes searchable through the existing `search_memory` RAG.
 *
 * Everything is fire-and-forget: the turn itself never waits for the network.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";
import { appendDailyMemory } from "./dailyMemory";
import { summarizeText } from "./summarize";
import { canonicalizeUrl, assertPublicUrl } from "./tools";
import { logInfo, logError } from "./appLogger";

export interface LibraryEntry {
  id: string;
  url: string;
  title: string;
  summary: string;
  savedAt: number;
}

const MAX_READS = 60;
const FETCH_TIMEOUT_MS = 12_000;
const FETCH_MAX_BYTES = 1_000_000;
const USER_AGENT = "Mozilla/5.0 (compatible; MiaLinkBot/1.0; +personal assistant)";
export const LIBRARY_SUMMARY_MAX = 900;

function readsFile(userKey: string): string {
  return join(userDataRoot(), userKey, "reads.json");
}

function readReads(rawUser: unknown): LibraryEntry[] {
  const userKey = sanitizeUser(rawUser) || "shared";
  try {
    if (!existsSync(readsFile(userKey))) return [];
    const raw = readFileSync(readsFile(userKey), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeReads(userKey: string, entries: LibraryEntry[]): void {
  const file = readsFile(userKey);
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(entries, null, 2), "utf8");
    renameSync(tmp, file);
  } catch {
    /* best-effort persistence */
  }
}

/** Persist a summarized link (deduped by normalized URL). Returns the entry or null. */
export function addLibraryEntry(rawUser: unknown, next: Omit<LibraryEntry, "id" | "savedAt">): LibraryEntry | null {
  const userKey = sanitizeUser(rawUser) || "shared";
  const entries = readReads(userKey);
  const norm = next.url.trim().toLowerCase();
  if (entries.some((e) => e.url.trim().toLowerCase() === norm)) return null;
  const entry: LibraryEntry = { ...next, savedAt: Date.now(), id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` };
  writeReads(userKey, [entry, ...entries].slice(0, MAX_READS));
  return entry;
}

export function listReads(rawUser: unknown): LibraryEntry[] {
  return readReads(rawUser);
}

/** Remove an entry by id or 1-based index (like notes). Returns a human summary. */
export function removeLibraryEntry(rawUser: unknown, ref: string): string {
  const userKey = sanitizeUser(rawUser) || "shared";
  const entries = readReads(userKey);
  const idx = entries.findIndex((e) => e.id === ref) ?? -1;
  let removeAt = idx;
  if (removeAt < 0 && /^\d+$/.test(ref.trim())) {
    const n = Number.parseInt(ref, 10);
    removeAt = n >= 1 && n <= entries.length ? n - 1 : -1;
  }
  if (removeAt < 0) return `Tidak ada entri "${ref.trim()}" di daftar bacaan.`;
  const removed = entries[removeAt];
  writeReads(userKey, entries.filter((_, i) => i !== removeAt));
  return `Dihapus dari daftar bacaan: ${removed.title || removed.url}`;
}

/** Extract the first http(s) URL from a text (strips trailing punctuation/closing brackets). */
export function firstUrlInText(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s"<>]+/i);
  if (!m) return null;
  return m[0].replace(/[.,;:!?)\]}>'"]+$/, "");
}

function extractTitleAndText(html: string): { title: string; body: string } {
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || "";
  const og = html.match(/<meta\s+(?:name|property)=["']?og:description["'][^>]*content=["']([^"']*)["']/i);
  // Drop boilerplate before extracting text: navs, sidebars, headers/footers
  // and table-of-contents blocks (they pollute the first-4000-chars window).
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<div[^>]*class=["'][^"']*\b(toc|mw-toc|infobox|sidebar)\b[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, " ");
  let block: string | null = null;
  const art = cleaned.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (art) block = art[1];
  if (!block) {
    const main = cleaned.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    if (main) block = main[1];
  }
  if (!block) {
    const body = cleaned.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    if (body) block = body[1];
  }
  const text = (block || cleaned)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  const fallback = og?.[1] ?? "";
  return { title: title || fallback.slice(0, 120), body: (text || fallback).slice(0, 4000) };
}

/** Fetch a public http(s) page and return {html}. SSRF-guarded like tools.fetch_url. */
export type FetchHtml = (url: string) => Promise<string>;
export const defaultFetchHtml: FetchHtml = async (urlStr: string): Promise<string> => {
  const url = assertPublicUrl(canonicalizeUrl(urlStr));
  const res = await fetch(url.toString(), {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > FETCH_MAX_BYTES) throw new Error("page too large");
  return buf.toString("utf8", 0, FETCH_MAX_BYTES);
};

export interface CaptureLinkOptions {
  messages: { role: string; content?: unknown }[];
  user?: unknown;
  provider?: string;
  model?: string;
  /** Injectable for tests; defaults to the SSRF-guarded network fetch. */
  fetchHtml?: FetchHtml;
  /** Injectable summarizer for tests; defaults to the active provider. */
  summarize?: (title: string, body: string) => Promise<string>;
}

/**
 * Fetch + summarize + persist the first link found in the last user message.
 * Never throws; returns the saved entry or null (no link / dup / fetch failed).
 */
export async function captureLinkFromMessage(opts: CaptureLinkOptions): Promise<LibraryEntry | null> {
  const lastUserRaw = [...opts.messages].reverse().find((m) => m.role === "user" && m.content)?.content;
  const lastUserText = typeof lastUserRaw === "string" ? lastUserRaw : String(lastUserRaw ?? "");
  const url = firstUrlInText(lastUserText);
  if (!url) return null;
  try {
    const html = await (opts.fetchHtml ?? defaultFetchHtml)(url);
    const { title, body } = extractTitleAndText(html);
    let summary = "";
    try {
      summary = opts.summarize
        ? (await opts.summarize(title, body)).trim()
        : (await summarizeText({ text: body, provider: opts.provider, model: opts.model })).trim();
    } catch {
      summary = "";
    }
    if (!summary) summary = body.slice(0, 220) || "(tidak ada teks terbaca)";
    const entry = addLibraryEntry(opts.user, {
      url,
      title: title || url,
      summary: summary.slice(0, LIBRARY_SUMMARY_MAX),
    });
    if (entry) {
      void appendDailyMemory(
        opts.user,
        `Mia membaca link: ${entry.title} — ${entry.url}\nRingkasan: ${entry.summary.slice(0, 300)}`,
      );
      logInfo("library", `saved ${entry.url} for ${sanitizeUser(opts.user) || "shared"}`);
    }
    return entry;
  } catch (err) {
    logError("library", `capture failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Post-turn deterministic hook: captures the shared link in the background and
 * (when the model reply doesn't already acknowledge it) appends a spoken
 * confirmation suffix so the user knows it was saved. Never throws.
 */
export function scheduleLinkCapture(
  messages: { role: string; content?: unknown }[],
  user: unknown,
  provider?: string,
  model?: string,
  text = "",
  /** True when the turn ends in a @@CONFIRM frame — suffix is suppressed then. */
  hasPendingConfirmation = false,
): string {
  try {
    const lastUser = [...messages].reverse().find((m) => m.role === "user" && m.content)?.content;
    const lastUserText = String(lastUser ?? "");
    if (!firstUrlInText(lastUserText)) return text;
    void captureLinkFromMessage({ messages, user, provider, model });
    if (!hasPendingConfirmation && !/simpan|saved|kurangkum|rangkum|kuarsipkan|daftar bacaan|bookmark/i.test(text)) {
      return `${text.trim()} (Udah kusimpan link-nya ke daftar bacaan — bilang "daftar bacaan-ku" kalau mau kubuka lagi ya 🌸)`.trim();
    }
  } catch {
    /* never break the turn over link capture */
  }
  return text;
}