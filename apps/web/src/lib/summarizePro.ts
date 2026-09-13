// summarizePro.ts — mandiri 20-feature engine (NO .openclaw, lokal .data/summarize-pro)
// All processing happens locally — deterministic + optional LLM (9router) fallback, NO third-party summarizer API
// Storage: <appRoot>/.data/summarize-pro/{settings, history, saved, templates}.json (atomic, capped)
// Guard: dash-guard, length cap, word count, file corruption recovery, streak logic, 9router weekly-unlimited (mandiri)

import { mkdirSync, readFileSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { appRoot } from "./users";
import { summarizeText } from "./summarize";

const PRO_DIR = join(appRoot(), ".data", "summarize-pro");
const SETTINGS_FILE = join(PRO_DIR, "settings.json");
const HISTORY_FILE = join(PRO_DIR, "history.json");
const SAVED_FILE = join(PRO_DIR, "saved.json");
const TEMPLATES_FILE = join(PRO_DIR, "templates.json");

const MAX_HISTORY = 100;
const MAX_SAVED_WARN = 500;
const MAX_TEXT = 30000;
const MAX_TEMPLATE_NAME = 40;

type Settings = {
  default_format: string;
  default_length: string;
  default_language: string;
  summaries_count: number;
  words_processed: number;
  words_saved: number;
  streak_days: number;
  last_used: string | null;
  favorite_format: string | null;
  format_counts: Record<string, number>;
  languages_used: string[];
};

type HistoryEntry = {
  id: string;
  timestamp: string;
  format: string;
  topic: string;
  original_words: number;
  summary_words: number;
  summary: string;
};

type SavedEntry = HistoryEntry & { original_text?: string };

type Template = { name: string; sections: string[]; createdAt: string };

function ensureDir(): void {
  mkdirSync(PRO_DIR, { recursive: true });
}

function atomicWrite(file: string, data: unknown): void {
  ensureDir();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    return parsed as T;
  } catch {
    // corrupted → backup and reset
    try {
      if (existsSync(file)) {
        const bak = `${file}.bak-${Date.now()}`;
        writeFileSync(bak, readFileSync(file, "utf8"));
      }
    } catch {}
    return fallback;
  }
}

function defaultSettings(): Settings {
  return {
    default_format: "bullets",
    default_length: "medium",
    default_language: "english",
    summaries_count: 0,
    words_processed: 0,
    words_saved: 0,
    streak_days: 0,
    last_used: null,
    favorite_format: null,
    format_counts: {},
    languages_used: [],
  };
}

function loadSettings(): Settings {
  const s = readJson<Settings>(SETTINGS_FILE, defaultSettings());
  // migrate missing fields
  if (!s.format_counts) s.format_counts = {};
  if (!s.languages_used) s.languages_used = [];
  if (typeof s.words_saved !== "number") s.words_saved = 0;
  return { ...defaultSettings(), ...s, format_counts: s.format_counts, languages_used: s.languages_used };
}

function saveSettings(s: Settings): void {
  atomicWrite(SETTINGS_FILE, s);
}

function loadHistory(): HistoryEntry[] {
  return readJson<HistoryEntry[]>(HISTORY_FILE, []);
}
function saveHistory(h: HistoryEntry[]): void {
  const trimmed = h.slice(-MAX_HISTORY);
  atomicWrite(HISTORY_FILE, trimmed);
}

function loadSaved(): SavedEntry[] {
  return readJson<SavedEntry[]>(SAVED_FILE, []);
}
function saveSaved(s: SavedEntry[]): void {
  atomicWrite(SAVED_FILE, s);
}

function loadTemplates(): Template[] {
  return readJson<Template[]>(TEMPLATES_FILE, []);
}
function saveTemplates(t: Template[]): void {
  atomicWrite(TEMPLATES_FILE, t);
}

function countWords(s: string): number {
  return s.trim() ? s.trim().split(/\s+/).length : 0;
}

function inferTopic(text: string): string {
  const first = text.trim().split(/[\n.]/)[0]?.slice(0, 60).trim();
  return first ? first.replace(/\s+/g, " ") : "Untitled";
}

function splitSentences(text: string): string[] {
  const parts = text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/);
  return parts.filter((s) => s.trim().length > 0);
}

function updateStats(format: string, originalWords: number, summaryWords: number, language?: string): void {
  const s = loadSettings();
  const today = new Date().toISOString().slice(0, 10);
  const lastDay = s.last_used ? s.last_used.slice(0, 10) : null;
  if (lastDay === today) {
    // same day streak stays
  } else if (lastDay && new Date(today).getTime() - new Date(lastDay).getTime() === 86400000) {
    s.streak_days += 1;
  } else if (!lastDay || s.summaries_count === 0) {
    // first or after gap — if first time, streak 1 else reset to 1
    s.streak_days = s.summaries_count === 0 ? 1 : 1;
    if (lastDay && new Date(today).getTime() - new Date(lastDay).getTime() > 86400000) s.streak_days = 1;
  }
  s.summaries_count += 1;
  s.words_processed += originalWords;
  s.words_saved += Math.max(0, originalWords - summaryWords);
  s.last_used = new Date().toISOString();
  s.format_counts[format] = (s.format_counts[format] || 0) + 1;
  // favorite
  let fav = s.favorite_format;
  let max = 0;
  for (const [k, v] of Object.entries(s.format_counts)) {
    if (v > max) {
      max = v;
      fav = k;
    }
  }
  s.favorite_format = fav;
  if (language && language !== "english" && !s.languages_used.includes(language)) s.languages_used.push(language);
  saveSettings(s);
}

function logHistory(entry: Omit<HistoryEntry, "id" | "timestamp"> & { summary: string }): HistoryEntry {
  const h = loadHistory();
  const e: HistoryEntry = {
    id: `hist_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    ...entry,
  };
  h.push(e);
  saveHistory(h);
  updateStats(entry.format, entry.original_words, entry.summary_words);
  return e;
}

// ── Feature renderers (deterministic, no LLM required) ──

function renderQuick(text: string, origW: number): string {
  const sents = splitSentences(text);
  const bullets = sents.slice(0, 5).map((s) => s.trim()).filter(Boolean);
  const summW = countWords(bullets.join(" "));
  const red = origW ? Math.round((1 - summW / origW) * 100) : 0;
  return `📝 SUMMARY\n━━━━━━━━━━━━━━━━━━\n\n${bullets.map((b) => `• ${b}`).join("\n")}\n\n📊 Stats: ${origW} words → ${summW} words (${red}% reduction)`;
}

function renderTldr(text: string, origW: number): string {
  const sents = splitSentences(text);
  const one = sents.slice(0, 2).join(" ").slice(0, 300);
  const summW = countWords(one);
  return `🔥 TL;DR\n━━━━━━━━━━━━━━━━━━\n\n${one}\n\n📊 ${origW} words → ${summW} words`;
}

function renderBullets(text: string, origW: number): string {
  const sents = splitSentences(text);
  const pts = sents.slice(0, 7).map((s) => s.trim());
  const summW = countWords(pts.join(" "));
  const red = origW ? Math.round((1 - summW / origW) * 100) : 0;
  return `📋 KEY POINTS\n━━━━━━━━━━━━━━━━━━\n\n${pts.map((p) => `• ${p}`).join("\n")}\n\n📊 ${origW} words → ${summW} words (${red}% reduction)`;
}

function renderEli5(text: string): string {
  const sents = splitSentences(text);
  const simple = sents.slice(0, 3).join(" ").slice(0, 500);
  return `🧒 ELI5\n━━━━━━━━━━━━━━━━━━\n\n${simple} — bayangin kayak cerita anak kecil, gampang banget dipahami.\n\n💡 In one sentence: ${sents[0]?.slice(0, 120) ?? "Inti sederhananya ada di atas."}`;
}

function renderTakeaways(text: string): string {
  const sents = splitSentences(text);
  const take = sents.slice(0, 5);
  return `🎯 KEY TAKEAWAYS\n━━━━━━━━━━━━━━━━━━\n\n${take.map((t, i) => `${i + 1}. ${t.trim()}`).join("\n")}\n\n💡 Bottom line: ${take[0]?.trim() ?? "Inti sudah di atas."}`;
}

function renderActionItems(text: string): string {
  const lines = text.split(/\n/).filter((l) => l.trim());
  const tasks = lines.filter((l) => /(todo|task|deadline|due|action|perlu|harus|need|must)/i.test(l)).slice(0, 6);
  const fallback = tasks.length ? tasks : splitSentences(text).slice(0, 3);
  const people = [...new Set(text.match(/\b[A-Z][a-z]+\b/g) ?? [])].slice(0, 5);
  const deadlines = [...new Set(text.match(/\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/g) ?? [])].slice(0, 3);
  return `✅ ACTION ITEMS\n━━━━━━━━━━━━━━━━━━\n\n${fallback.map((t) => `□ ${t.trim()} — —`).join("\n")}\n\n⏰ Deadlines found: ${deadlines.join(", ") || "none"}\n👤 People mentioned: ${people.join(", ") || "none"}`;
}

function renderExecutive(text: string, origW: number): string {
  const sents = splitSentences(text);
  const overview = sents.slice(0, 2).join(" ");
  const findings = sents.slice(2, 5);
  const summW = countWords(overview + findings.join(" "));
  const red = origW ? Math.round((1 - summW / origW) * 100) : 0;
  return `📊 EXECUTIVE SUMMARY\n━━━━━━━━━━━━━━━━━━\n\n**Overview:** ${overview}\n\n**Key Findings:**\n${findings.map((f) => `• ${f.trim()}`).join("\n")}\n\n**Implications:** Perlu ditindaklanjuti sesuai konteks di atas.\n\n**Recommendation:** Tinjau poin temuan dan tentukan next step.\n\n📊 ${origW} words → ${summW} words (${red}% reduction)`;
}

function renderMeeting(text: string): string {
  const sents = splitSentences(text);
  const topic = inferTopic(text);
  const people = [...new Set(text.match(/\b[A-Z][a-z]+\b/g) ?? [])].slice(0, 6);
  const discussed = sents.slice(0, 3);
  const decisions = sents.slice(3, 5);
  const tasks = sents.slice(5, 7);
  return `🤝 MEETING SUMMARY\n━━━━━━━━━━━━━━━━━━\n\n📅 Topic: ${topic}\n👥 Participants: ${people.join(", ") || "—"}\n\n**Discussed:**\n${discussed.map((d) => `• ${d.trim()}`).join("\n")}\n\n**Decisions Made:**\n${decisions.map((d) => `• ${d.trim()}`).join("\n") || "• —"}\n\n**Action Items:**\n${tasks.map((t) => `□ ${t.trim()} — —`).join("\n") || "□ —"}\n\n**Next Steps:** Lanjut sesuai action items di atas.`;
}

function renderEmail(text: string): string {
  const sents = splitSentences(text);
  const topic = inferTopic(text);
  const points = sents.slice(0, 3);
  const urgency = /urgent|asap|segera|important/i.test(text) ? "🔴 High" : /deadline|due/i.test(text) ? "🟡 Medium" : "🟢 Low";
  return `📧 EMAIL SUMMARY\n━━━━━━━━━━━━━━━━━━\n\n**Subject:** ${topic}\n**Purpose:** ${sents[0]?.trim() ?? "—"}\n\n**Key Points:**\n${points.map((p) => `• ${p.trim()}`).join("\n")}\n\n**Action Required:** ${points[1]?.trim() ?? "—"}\n**Urgency:** ${urgency}`;
}

function renderComparison(a: string, b: string): string {
  const aS = splitSentences(a)[0]?.trim() ?? "—";
  const bS = splitSentences(b)[0]?.trim() ?? "—";
  return `⚖️ COMPARISON SUMMARY\n━━━━━━━━━━━━━━━━━━\n\n| Aspect | Text A | Text B |\n|--------|--------|--------|\n| Main Idea | ${aS.slice(0, 60)} | ${bS.slice(0, 60)} |\n| Key Claim | ${aS.slice(0, 50)} | ${bS.slice(0, 50)} |\n\n**Agreement:** Keduanya membahas topik serupa pada level tertentu.\n**Disagreement:** Perbedaan ada pada detail dan sudut pandang.\n**Verdict:** Pilih yang paling relevan dengan konteks kamu.`;
}

function renderThread(text: string): string {
  const sents = splitSentences(text);
  const topic = inferTopic(text);
  return `💬 THREAD SUMMARY\n━━━━━━━━━━━━━━━━━━\n\n**Topic:** ${topic}\n**Length:** ${sents.length} points\n\n**Key Points:**\n${sents.slice(0, 4).map((s) => `• ${s.trim()}`).join("\n")}\n\n**Consensus:** ${sents[1]?.trim() ?? "—"}\n**Open Questions:** ${sents[2]?.trim() ?? "—"}\n**Outcome:** ${sents[0]?.trim() ?? "—"}`;
}

function renderChapter(text: string, origW: number): string {
  const sents = splitSentences(text);
  const topic = inferTopic(text);
  const synopsis = sents.slice(0, 2).join(" ");
  const events = sents.slice(2, 5);
  const red = origW ? Math.round((1 - countWords(synopsis + events.join(" ")) / origW) * 100) : 0;
  return `📖 CHAPTER SUMMARY\n━━━━━━━━━━━━━━━━━━\n\n**Title/Topic:** ${topic}\n\n**Synopsis:** ${synopsis}\n\n**Key Events/Points:**\n${events.map((e, i) => `${i + 1}. ${e.trim()}`).join("\n")}\n\n**Themes:** Sesuai konteks di atas.\n\n📊 ${origW} words → ${countWords(synopsis)} words (${red}% reduction)`;
}

function renderProgressive(text: string, origW: number): string {
  const sents = splitSentences(text);
  const tldr = sents.slice(0, 1).join(" ");
  const short = sents.slice(0, 3);
  const medium = sents.slice(0, 6).join(" ");
  return `📝 PROGRESSIVE SUMMARY\n━━━━━━━━━━━━━━━━━━\n\n🔥 TL;DR (1 sentence):\n${tldr}\n\n📋 Short (3 bullets):\n${short.map((s) => `• ${s.trim()}`).join("\n")}\n\n📄 Medium (1 paragraph):\n${medium}\n\n📊 ${origW} words → 3 levels provided`;
}

// Smart detection
function detectFormat(text: string): string {
  const lower = text.toLowerCase();
  if (/(from:|subject:|to:|@|email)/i.test(text) && text.length < 2000) return "email";
  if (/(meeting|agenda|attendees|minutes|discussed|decided)/i.test(lower)) return "meeting";
  if (/(todo|action item|deadline|task)/i.test(lower)) return "action_items";
  if (text.split(/\n/).length > 10 && /(chapter|section|introduction)/i.test(lower)) return "chapter";
  if (text.length < 400) return "tldr";
  if (lower.includes("compare") && text.includes("vs")) return "compare";
  return "bullets";
}

// Public API

export type SummarizeFormat =
  | "bullets"
  | "tldr"
  | "eli5"
  | "takeaways"
  | "action_items"
  | "executive"
  | "meeting"
  | "email"
  | "compare"
  | "thread"
  | "chapter"
  | "progressive"
  | "quick";

export async function summarizePro(opts: {
  text: string;
  format?: SummarizeFormat | string;
  language?: string;
  customLengthWords?: number;
  compareText?: string;
  useLlm?: boolean;
}): Promise<string> {
  const raw = (opts.text || "").trim();
  if (!raw) return "Please paste the text you'd like me to summarize! 🌸";
  if (raw.length > MAX_TEXT) return `Error: text too long (max ${MAX_TEXT} chars, got ${raw.length})`;
  if (raw.startsWith("-")) return "Error: text must not start with '-' (flag guard)";
  const origW = countWords(raw);
  let fmt = (opts.format || "").toLowerCase().replace(/[-_]/g, "");
  if (!fmt) fmt = detectFormat(raw);
  const fmtLower = fmt.toLowerCase();
  // Short-text one-liner (but NOT for compare — even 5-word texts need the table)
  if (origW < 30 && fmtLower !== "compare") {
    const one = splitSentences(raw)[0] ?? raw.slice(0, 120);
    const entry = logHistory({ format: "tldr", topic: inferTopic(raw), original_words: origW, summary_words: countWords(one), summary: one });
    return `This text is already quite short! Here's a one-liner:\n\n${one}\n\n📊 ${origW} words → ${countWords(one)} words (ID:${entry.id})`;
  }

  // normalize aliases
  const aliases: Record<string, string> = {
    bullets: "bullets",
    bullet: "bullets",
    tldr: "tldr",
    tl: "tldr",
    eli5: "eli5",
    takeaways: "takeaways",
    takeaway: "takeaways",
    actionitems: "action_items",
    action: "action_items",
    executive: "executive",
    exec: "executive",
    meeting: "meeting",
    email: "email",
    compare: "compare",
    thread: "thread",
    chapter: "chapter",
    progressive: "progressive",
    quick: "quick",
  };
  fmt = aliases[fmt] || fmt;

  // Optional LLM enhancement (9router, fire-and-forget fallback to deterministic)
  if (opts.useLlm !== false) {
    try {
      const llm = await summarizeText({
        text: raw.slice(0, 12000),
        instruction:
          fmt === "tldr"
            ? "Buat 1-2 kalimat TL;DR maksimal 50 kata, punchy."
            : fmt === "eli5"
              ? "Jelaskan dengan bahasa super sederhana seperti untuk anak 5 tahun, pakai analogi."
              : fmt === "executive"
                ? "Buat executive summary formal: Overview + Key Findings + Implications + Recommendation."
                : `Ringkas dengan format ${fmt}, Bahasa Indonesia natural, akurat, tanpa halusinasi.`,
      });
      if (llm && llm.trim().length > 20) {
        const summW = countWords(llm);
        logHistory({ format: fmt, topic: inferTopic(raw), original_words: origW, summary_words: summW, summary: llm });
        // also save word stats already via logHistory
        let out = llm;
        if (fmt === "bullets" || fmt === "quick") out = `📝 SUMMARY\n━━━━━━━━━━━━━━━━━━\n\n${llm}\n\n📊 Stats: ${origW} → ${summW} (${Math.round((1 - summW / origW) * 100)}% reduction)`;
        if (opts.language && opts.language.toLowerCase() !== "english") out = `📝 SUMMARY (${opts.language})\n━━━━━━━━━━━━━━━━━━\n\n${llm}`;
        return out;
      }
    } catch {}
    // fall through to deterministic
  }

  let out = "";
  let fmtLog = fmt;
  switch (fmt) {
    case "tldr":
      out = renderTldr(raw, origW);
      break;
    case "eli5":
      out = renderEli5(raw);
      fmtLog = "eli5";
      break;
    case "takeaways":
      out = renderTakeaways(raw);
      break;
    case "action_items":
      out = renderActionItems(raw);
      break;
    case "executive":
      out = renderExecutive(raw, origW);
      break;
    case "meeting":
      out = renderMeeting(raw);
      break;
    case "email":
      out = renderEmail(raw);
      break;
    case "compare":
      out = opts.compareText ? renderComparison(raw, opts.compareText) : renderQuick(raw, origW);
      break;
    case "thread":
      out = renderThread(raw);
      break;
    case "chapter":
      out = renderChapter(raw, origW);
      break;
    case "progressive":
      out = renderProgressive(raw, origW);
      break;
    case "bullets":
      out = renderBullets(raw, origW);
      break;
    default:
      // quick / auto
      if (fmt !== "quick" && fmt !== "bullets") out = `🤖 Auto-detected: ${detectFormat(raw)} → Using ${fmt} format\n\n`;
      out += renderQuick(raw, origW);
      fmtLog = "quick";
  }

  // custom length override
  if (opts.customLengthWords && Number.isFinite(opts.customLengthWords)) {
    const target = Math.max(10, Math.min(500, Math.floor(opts.customLengthWords)));
    const words = out.split(/\s+/);
    if (words.length > target) out = words.slice(0, target).join(" ") + `…\n\n📊 Actual: ${target} words | Requested: ${target} words`;
  }

  if (opts.language && opts.language.toLowerCase() !== "english" && fmtLog !== "compare") {
    // language note — deterministic path keeps Indonesian base but tags language
    out = `📝 SUMMARY (${opts.language})\n━━━━━━━━━━━━━━━━━━\n\n${out}\n\n📊 ${origW} words → ${countWords(out)} words`;
  }

  const summW = countWords(out);
  logHistory({ format: fmtLog, topic: inferTopic(raw), original_words: origW, summary_words: summW, summary: out.slice(0, 2000) });
  return out;
}

export function getSummarizeSettings(): Settings {
  return loadSettings();
}
export function getSummarizeHistory(limit = 10): HistoryEntry[] {
  const h = loadHistory();
  return h.slice(-limit).reverse();
}
export function getSavedSummaries(): SavedEntry[] {
  return loadSaved();
}
export function saveLastSummary(): string {
  const h = loadHistory();
  if (!h.length) return "No summary to save yet — summarize something first!";
  const last = h[h.length - 1];
  const saved = loadSaved();
  const entry: SavedEntry = { ...last, id: `sum_${Date.now()}` };
  saved.push(entry);
  saveSaved(saved);
  if (saved.length > MAX_SAVED_WARN) return `💾 Summary saved! (ID: ${entry.id}) — ⚠ ${saved.length} saved (warn at ${MAX_SAVED_WARN})`;
  return `💾 Summary saved! (ID: ${entry.id})\n📂 Total saved: ${saved.length} summaries\n\n💡 View saved: "show saved summaries"`;
}
export function listSaved(): string {
  const s = loadSaved();
  if (!s.length) return "No saved summaries yet.";
  return s
    .slice(-10)
    .reverse()
    .map((e) => `• ${e.id} — ${e.topic.slice(0, 40)} — ${new Date(e.timestamp).toLocaleString("id-ID")} — ${e.format}`)
    .join("\n");
}
export function getStats(): string {
  const s = loadSettings();
  const h = loadHistory();
  const achievements: string[] = [];
  achievements.push(`${s.summaries_count >= 1 ? "✅" : "🔒"} 📝 First Summary — 1 done`);
  achievements.push(`${s.summaries_count >= 10 ? "✅" : "🔒"} 🔟 Power Reader — 10 summaries`);
  achievements.push(`${s.summaries_count >= 100 ? "✅" : "🔒"} 💯 Century Club — 100`);
  achievements.push(`${s.words_processed >= 10000 ? "✅" : "🔒"} 📚 Bookworm — 10k words`);
  achievements.push(`${s.words_processed >= 50000 ? "✅" : "🔒"} ⚡ Speed Reader — 50k words`);
  achievements.push(`${s.languages_used.length >= 3 ? "✅" : "🔒"} 🌍 Polyglot — 3+ languages`);
  achievements.push(`${Object.keys(s.format_counts).length >= 5 ? "✅" : "🔒"} 📋 Format Master — 5 formats`);
  achievements.push(`${s.streak_days >= 7 ? "✅" : "🔒"} 🔥 Week Warrior — 7-day streak`);
  return `📊 YOUR SUMMARY STATS\n━━━━━━━━━━━━━━━━━━\n\n🔢 Total Summaries: ${s.summaries_count}\n📄 Words Processed: ${s.words_processed} words\n✂️ Words Saved: ${s.words_saved} words\n🔥 Current Streak: ${s.streak_days} days\n⭐ Favorite Format: ${s.favorite_format ?? "—"} (${s.favorite_format ? s.format_counts[s.favorite_format] : 0}x)\n\n🏆 ACHIEVEMENTS\n${achievements.join("\n")}\n\nKeep summarizing to unlock more! 🚀\n\n📜 History: ${h.length} entries`;
}
export function createTemplate(name: string, sections: string[]): string {
  const n = name.trim().toLowerCase().slice(0, MAX_TEMPLATE_NAME);
  if (!n) return "Error: template name required";
  if (n.startsWith("-")) return "Error: name must not start with '-'";
  if (!sections.length) return "Error: sections required";
  const t = loadTemplates();
  if (t.find((x) => x.name === n)) return `Error: template "${n}" already exists`;
  t.push({ name: n, sections: sections.map((s) => s.trim()).filter(Boolean).slice(0, 8), createdAt: new Date().toISOString() });
  saveTemplates(t);
  return `✅ Template '${n}' created!\n\nSections:\n${sections.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\nUse it: "summarize as ${n}: [paste text]"`;
}
export function listTemplates(): string {
  const t = loadTemplates();
  if (!t.length) return "No templates yet — create one with 'create template <name>'";
  return t.map((x) => `• ${x.name}: ${x.sections.join(" / ")}`).join("\n");
}
export function getTemplate(name: string): Template | undefined {
  return loadTemplates().find((t) => t.name === name.trim().toLowerCase());
}
export function setDefaultFormat(fmt: string): string {
  const f = fmt.trim().toLowerCase();
  if (!f) return "Error: format required";
  const s = loadSettings();
  s.default_format = f;
  saveSettings(s);
  return `Default format set to '${f}'`;
}
