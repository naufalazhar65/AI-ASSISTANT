// humanizer.ts — mandiri 24-pattern Wikipedia Humanizer + soul
// Based on Wikipedia:Signs_of_AI_writing (WikiProject AI Cleanup), 24 patterns
// Lokal .data/humanizer/{history.json,settings.json} (NO ~/.openclaw), atomic, dash-guard, 30k cap
// No external API — deterministic rewrite + optional 9router LLM polish

import { mkdirSync, readFileSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { appRoot } from "./users";
import { summarizeText } from "./summarize";

const DIR = join(appRoot(), ".data", "humanizer");
const HIST_FILE = join(DIR, "history.json");
const SETTINGS_FILE = join(DIR, "settings.json");
const MAX_TEXT = 30000;
const MAX_HIST = 100;

type Hist = { id: string; timestamp: string; original_words: number; humanized_words: number; patterns: string[]; original: string; humanized: string };
type Settings = { count: number; words_processed: number; last_used: string | null };

function ensureDir(): void {
  mkdirSync(DIR, { recursive: true });
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
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
function countWords(s: string): number {
  return s.trim() ? s.trim().split(/\s+/).length : 0;
}

// ── 24 pattern detectors (keywords/regex) ──
const PATTERNS: { id: string; name: string; re: RegExp; fix: string }[] = [
  { id: "p01", name: "Inflated significance", re: /\b(stands as|serves as|is a testament|vital role|crucial role|pivotal moment|underscores its importance|reflects broader|indelible mark|deeply rooted|setting the stage)\b/gi, fix: "simplify to 'is'" },
  { id: "p02", name: "Notability puff", re: /\b(independent coverage|national media outlets|leading expert|active social media presence with over)\b/gi, fix: "give one concrete source" },
  { id: "p03", name: "Superficial -ing", re: /\b(highlighting|underscoring|emphasizing|ensuring|reflecting|symbolizing|fostering|cultivating|encompassing|showcasing)[^,.;]{0,40},/gi, fix: "cut -ing phrase" },
  { id: "p04", name: "Promotional", re: /\b(vibrant|rich cultural|stunning|breathtaking|nestled|in the heart of|groundbreaking|renowned|must-visit|boasts a)\b/gi, fix: "neutral: is/has" },
  { id: "p05", name: "Vague attribution", re: /\b(Industry reports|Experts believe|Observers have cited|Some critics argue|several sources)\b/gi, fix: "name the source" },
  { id: "p06", name: "Challenges boilerplate", re: /\b(Despite its.*faces several challenges|Despite these challenges|Future Outlook|Challenges and Legacy)\b/gi, fix: "give concrete challenge" },
  { id: "p07", name: "AI vocab", re: /\b(Additionally|delve|crucial|enduring|enhance|fostering|garner|intricate|tapestry|testament|underscore|landscape)\b/gi, fix: "also/deep/important" },
  { id: "p08", name: "Copula avoidance", re: /\b(serves as|stands as|boasts|features|offers) a\b/gi, fix: "is/has" },
  { id: "p09", name: "Negative parallelism", re: /\bIt's not (just|merely) about[^;]{0,80}; it's\b/gi, fix: "one plain sentence" },
  { id: "p10", name: "Rule of three", re: /\b(\w+, \w+, and \w+)\b/g, fix: "break into 2 or 1" },
  { id: "p11", name: "Elegant variation", re: /\b(The protagonist|The main character|The central figure|The hero) faces/gi, fix: "keep one name" },
  { id: "p12", name: "False ranges", re: /\bfrom the .* to the .* cosmic web\b/gi, fix: "list concrete items" },
  { id: "p13", name: "Em dash overuse", re: /—/g, fix: "use comma" },
  { id: "p14", name: "Bold overuse", re: /\*\*[^*]{2,40}\*\*/g, fix: "remove **" },
  { id: "p15", name: "Inline-header list", re: /^-\s\*\*[^*]+\*\*:/gm, fix: "plain sentence" },
  { id: "p16", name: "Title Case headings", re: /^#{1,6}\s[A-Z][a-z]+(\sAnd\s|\s[A-Z][a-z]+)+/gm, fix: "Sentence case" },
  { id: "p17", name: "Emojis in body", re: /[🚀💡✅📝🔥📋]/g, fix: "remove unless user wants" },
  { id: "p18", name: "Curly quotes", re: /[“”]/g, fix: 'straight "' },
  { id: "p19", name: "Chatbot artifacts", re: /\b(I hope this helps|Of course!|Certainly!|You're absolutely right|Would you like|let me know|here is a)\b/gi, fix: "cut" },
  { id: "p20", name: "Cutoff disclaimer", re: /\b(as of \d{4}|Up to my last training|While specific details are limited)\b/gi, fix: "give date/source" },
  { id: "p21", name: "Sycophantic", re: /\b(Great question!|excellent point|You're absolutely right that)\b/gi, fix: "neutral" },
  { id: "p22", name: "Filler phrases", re: /\b(In order to|Due to the fact that|At this point in time|In the event that|It is important to note that)\b/gi, fix: "To/Because/Now/If" },
  { id: "p23", name: "Excessive hedging", re: /\b(could potentially possibly|might have some effect)\b/gi, fix: "may affect" },
  { id: "p24", name: "Generic positive conclusion", re: /\b(The future looks bright|Exciting times lie ahead|major step in the right direction)\b/gi, fix: "give concrete next step" },
  // Indonesian AI-writing clichés (the Wikipedia set is English-only)
  { id: "p25", name: "Klise pembuka ID", re: /\b(Di era (digital )?yang serba cepat|Dalam dunia yang [a-z]+|Seiring (dengan )?perkembangan (zaman|teknologi|era))\b/gi, fix: "hapus klise pembuka" },
  { id: "p26", name: "Filler ID", re: /\b(Penting untuk dicatat bahwa|Perlu diketahui bahwa|Sebagai kesimpulan|Pada akhirnya|Dengan demikian)\b/gi, fix: "hapus/cut" },
  { id: "p27", name: "Negative parallelism ID", re: /\btidak hanya\b[^.;]{0,60}\b(tetapi|tapi) juga\b/gi, fix: "satu kalimat lugas" },
  { id: "p28", name: "Peran penting ID", re: /\bmemainkan peran (yang )?(sangat )?penting\b/gi, fix: "penting saja" },
  { id: "p29", name: "Kesimpulan generik ID", re: /\b(masa depan (terlihat|tampak) cerah|langkah besar ke arah yang benar)\b/gi, fix: "beri langkah konkret" },
];

function detectPatterns(text: string): string[] {
  const found: string[] = [];
  for (const p of PATTERNS) {
    // reset lastIndex for global
    p.re.lastIndex = 0;
    if (p.re.test(text)) found.push(`${p.id}:${p.name}`);
  }
  // soulless checks
  const sents = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
  if (sents.length >= 3 && sents.every((s) => Math.abs(s.split(/\s+/).length - sents[0].split(/\s+/).length) < 3)) found.push("soul:uniform sentence length");
  if (!/\b(I|aku|saya)\b/i.test(text) && text.length > 200) found.push("soul:no first-person");
  if (!text.includes("—") && !text.includes("...") && sents.length > 4 && !/(tapi|but|however)/i.test(text)) found.push("soul:no mixed feelings");
  return found;
}

function deterministicHumanize(text: string): string {
  let out = text;
  // 1) em dash → comma (with spacing; avoid "word , word")
  out = out.replace(/\s*—\s*/g, ", ");
  // 2) curly quotes → straight
  out = out.replace(/[“”]/g, '"');
  // 3) bold → plain
  out = out.replace(/\*\*([^*]+)\*\*/g, "$1");
  // 4) inline-header lists → plain
  out = out.replace(/^-\s\*\*[^*]+\*\*:\s*/gm, "");
  // 5) chatbot artifacts
  out = out.replace(/\b(I hope this helps!|Of course!|Certainly!|let me know if you'd like.+?\.|here is a .+?:)\s*/gi, "");
  // 6) AI vocab
  out = out.replace(/\bAdditionally,/gi, "Also,");
  out = out.replace(/\bdelve\b/gi, "explore");
  out = out.replace(/\bcrucial\b/gi, "important");
  out = out.replace(/\btapestry\b/gi, "mix");
  out = out.replace(/\blandscape\b/gi, "field");
  out = out.replace(/\btestament\b/gi, "example");
  // 7) copula
  out = out.replace(/\bserves as\b/gi, "is");
  out = out.replace(/\bstands as\b/gi, "is");
  out = out.replace(/\bboasts a\b/gi, "has a");
  // 8) negative parallelism
  out = out.replace(/It's not just about[^;]+; it's /gi, "");
  // 9) filler (EN + ID)
  out = out.replace(/\bIn order to\b/gi, "To");
  out = out.replace(/\bDue to the fact that\b/gi, "Because");
  out = out.replace(/\bAt this point in time\b/gi, "Now");
  out = out.replace(/\bIt is important to note that\b/gi, "");
  out = out.replace(/\bPenting untuk dicatat bahwa\s*/gi, "");
  out = out.replace(/\bPerlu diketahui bahwa\s*/gi, "");
  out = out.replace(/\bSebagai kesimpulan,?\s*/gi, "Jadi, ");
  out = out.replace(/\bDi era digital yang serba cepat,?\s*/gi, "");
  out = out.replace(/\bmemainkan peran (yang )?(sangat )?penting\b/gi, "penting");
  // 10) promotional
  out = out.replace(/\bnestled within the breathtaking region of\b/gi, "in");
  out = out.replace(/\bvibrant\b/gi, "");
  out = out.replace(/\bstunning\b/gi, "");
  // 11) title case → sentence case (preserve ALL-CAPS acronyms & digits)
  out = out.replace(/^##\s(.+)/gm, (_, t: string) => {
    const words = t.split(/\s+/);
    const caps = words.filter((w) => /^[A-Z]/.test(w)).length;
    if (words.length < 2 || caps / words.length < 0.5) return `## ${t}`;
    return `## ${words.map((w, i) => (i === 0 || /^[A-Z]{2,}$/.test(w) || /\d/.test(w) ? w : w.toLowerCase())).join(" ")}`;
  });
  // 12) sycophantic
  out = out.replace(/\bGreat question!?\s*/gi, "");
  out = out.replace(/\bYou're absolutely right that\s*/gi, "");
  // 13) generic conclusion
  out = out.replace(/\bThe future looks bright for[^.]+\.\s*/gi, "");
  // 14) article agreement broke by word swaps ("a important" → "an important").
  // Conservative: only a/e/i (skip u/o which are often "you"/"one" sounds, e.g.
  // "a unique", "a one") and never rewrite "an <consonant>" (an hour/honest).
  out = out.replace(/\ba ([aei])/g, "an $1");
  // 15) trim doubles
  out = out.replace(/[ \t]{2,}/g, " ").replace(/ ,/g, ",").replace(/\n{3,}/g, "\n\n").trim();
  // NOTE: no deterministic "soul injection" — it produced awkward, broken
  // sentences (and re-introduced an em dash). Voice comes from the LLM polish.
  return out;
}

function loadHistory(): Hist[] {
  return readJson<Hist[]>(HIST_FILE, []);
}
function saveHistory(h: Hist[]): void {
  atomicWrite(HIST_FILE, h.slice(-MAX_HIST));
}
function loadSettings(): Settings {
  return readJson<Settings>(SETTINGS_FILE, { count: 0, words_processed: 0, last_used: null });
}
function saveSettings(s: Settings): void {
  atomicWrite(SETTINGS_FILE, s);
}

export async function humanize(text: string, opts?: { useLlm?: boolean }): Promise<{ humanized: string; patterns: string[]; original_words: number; humanized_words: number }> {
  const raw = (text || "").trim();
  if (!raw) throw new Error("text required");
  if (raw.length > MAX_TEXT) throw new Error(`text too long (max ${MAX_TEXT})`);
  if (raw.startsWith("-")) throw new Error("text must not start with '-' (flag guard)");
  const ow = countWords(raw);
  const patterns = detectPatterns(raw);
  // deterministic base
  let out = deterministicHumanize(raw);
  // Optional LLM polish (default provider; falls back to the deterministic
  // result if it returns nothing/too long). This is the main quality lever —
  // the deterministic pass only cleans surface patterns.
  if (opts?.useLlm !== false) {
    const isId = /\b(yang|dan|dengan|untuk|adalah|tidak|dari|ini|itu|kita|saya)\b/i.test(raw);
    const langNote = isId
      ? "Balas dalam Bahasa Indonesia yang natural (bahasa yang sama dengan input)."
      : "Reply in English (same language as the input).";
    try {
      const llm = await summarizeText({
        text: `Humanize this text (remove AI patterns, add voice). Keep meaning, vary rhythm, be specific, no AI vocab, no em dash, no bold, no sycophantic:\n\n${raw.slice(0, 12000)}`,
        instruction:
          `You are a humanizer per Wikipedia Signs of AI writing (24 patterns) + Indonesian clichés. Rewrite to sound human: remove inflated symbolism, promotional wording, -ing fluff, vague attribution, em dash, rule of three, AI vocab, negative parallelism, bold, emoji, chatbot artifacts, hedging, generic conclusions, and Indonesian fillers ("Sebagai kesimpulan", "Penting untuk dicatat", "Di era digital yang serba cepat", "memainkan peran penting"). Inject voice: varied rhythm, opinions, mixed feelings, first person when natural. Keep every fact. ${langNote}`,
      });
      if (llm && llm.trim().length > 20 && countWords(llm) < ow * 1.5) out = llm.trim();
    } catch {}
  }
  const hw = countWords(out);
  // log
  try {
    const h = loadHistory();
    h.push({ id: `hum_${Date.now()}`, timestamp: new Date().toISOString(), original_words: ow, humanized_words: hw, patterns, original: raw.slice(0, 2000), humanized: out.slice(0, 2000) });
    saveHistory(h);
    const s = loadSettings();
    s.count += 1;
    s.words_processed += ow;
    s.last_used = new Date().toISOString();
    saveSettings(s);
  } catch {}
  return { humanized: out, patterns, original_words: ow, humanized_words: hw };
}

export function getHumanizerHistory(limit = 10): Hist[] {
  return loadHistory().slice(-limit).reverse();
}
export function getHumanizerStats(): string {
  const s = loadSettings();
  const h = loadHistory();
  return `📝 HUMANIZER STATS\n━━━━━━━━━━━━━━━━━━\n\n🔢 Total: ${s.count}\n📄 Words: ${s.words_processed}\n📜 History: ${h.length}/${MAX_HIST}\n🕒 Last: ${s.last_used ?? "—"}\n\nPatterns covered: 24 Wikipedia + soul (uniform/no I/no mixed)`;
}
