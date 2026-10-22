// Persona fact handling — canonical keys, conflict resolution, secret rejection,
// capping and ordering. Pure helpers so the behaviour is unit-testable and the
// upsert/hygiene paths can't drift.
//
// Why: flat `key: value` facts accumulated synonyms and contradictions
// (`favorite_food: nasi goreng` AND `preference.food: bakso`), and a pasted
// token could be stored as a "fact". Canonical keys merge synonyms (latest value
// wins, old value kept under Superseded), secrets are never stored, and the fact
// list is capped so the always-injected persona stays lean.

export type Fact = { key: string; value: string };

/** Preference-like topics: any key about one of these is the SAME preference. */
const PREF_TOPICS = new Set([
  "food", "drink", "coffee", "tea", "song", "music", "artist", "band", "movie", "film",
  "book", "color", "colour", "hobby", "game", "sport", "place", "travel", "tool",
  "editor", "os", "phone", "cafe", "restaurant", "snack", "dessert", "genre",
  "weather", "weather_complaint", "reminder_tone", "work_music", "accommodation",
]);

const PREF_PREFIX = /^(?:preference|pref|preferensi|favorit|favourite|favorite|fav|kesukaan|suka)[._](.+)$/i;

/**
 * Indonesian first-person aliases → canonical keys (2026-10-07).
 *
 * Live drift this fixes: the owner's USER.md carried `namaku: Naufal` beside
 * `name: Naufal`, `pekerjaan: pentester` beside `job: cybersecurity (…)`, and
 * — worst — `kopi_favoritku: latte` beside `preference.coffee: americano`:
 * two live, contradicting coffee facts, because the keys differed so neither
 * mergeFact nor hygiene ever collapsed them.
 *
 * Deliberately NOT here: `nama_panggilanku` → `nickname`. They look like
 * synonyms but they are two different facts — `nickname: beb` is Mia's pet
 * name for the owner (agentRole.ts: it belongs to HER voice alone) while
 * `nama_panggilanku: Mas` is how the trio addresses him. Merging would make
 * one of them wrong.
 *
 * A trailing `ku` is stripped before lookup (`kotaku` → `kota` → `city`), so
 * the map only lists bare forms.
 */
const ID_ALIASES: Record<string, string> = {
  nama: "name",
  pekerjaan: "job",
  profesi: "job",
  kota: "city",
  umur: "age",
  kopi: "preference.coffee",
  makanan: "preference.food",
  minuman: "preference.drink",
  lagu: "preference.song",
  musik: "preference.music",
  hobi: "preference.hobby",
};

/** Canonical key: merge `favorite_X` / `preference.X` / `fav_X` into one key. Pure. */
export function canonicalFactKey(raw: string): string {
  const k = (raw || "").trim().toLowerCase().replace(/\s+/g, "_").replace(/:$/, "");
  if (!k) return "";
  // Indonesian first-person aliases (`namaku`, `pekerjaanku`, `kopi_favoritku`…)
  // fold to the same canonical key as their English form.
  if (ID_ALIASES[k]) return ID_ALIASES[k];
  const poss = k.replace(/ku$/, "");
  if (poss !== k && ID_ALIASES[poss]) return ID_ALIASES[poss];
  const favKu = /^(kopi|makanan|minuman|lagu|musik|hobi)_favorit$/.exec(poss.replace(/ku$/, ""));
  if (favKu) return ID_ALIASES[favKu[1]];
  const m = PREF_PREFIX.exec(k);
  const topic = (m ? m[1] : k).replace(/[._]/g, "_");
  const bare = topic.replace(/^(?:favorite|favourite|fav)_/, "");
  // Only merge when the topic really is a preference — otherwise keep the key
  // untouched (e.g. `preference.crypto_monitor` stays as-is).
  if (PREF_TOPICS.has(bare)) return `preference.${bare}`;
  // A pet's name and "my cat" are the same fact — without this they were stored
  // twice (`pet: kucing bernama Moly` + `cat_name: Moly`).
  if (bare === "cat_name" || bare === "pet_name" || bare === "kucing") return "pet";
  return k;
}

// Secret/id shapes that must NEVER be stored as a persona fact.
const SECRET_RES: RegExp[] = [
  /\bauth0\|[A-Za-z0-9]+/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  /\bBearer\s+\S+/i,
  /\bAKIA[0-9A-Z]{10,}/,
  /\bsk-[A-Za-z0-9]{12,}/,
  /\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{20,}/,
  /\b[A-Fa-f0-9]{32,}\b/, // long hex (api keys/tokens)
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/, // long base64
];

/** True when a value looks like a credential/token — never store it. Pure. */
export function looksLikeSecret(value: string): boolean {
  const v = (value || "").trim();
  if (!v) return false;
  return SECRET_RES.some((re) => re.test(v));
}

/** Keys always kept first in the injected block (most useful personalisation). */
export const CORE_KEYS = [
  "name", "nickname", "language", "city", "job", "plan", "home", "home_coords",
  "wake_up_time", "timezone", "pet", "age", "education",
];

/** Core keys first, then alphabetical — stable, deterministic order. Pure. */
export function sortFacts(facts: Fact[]): Fact[] {
  const rank = (k: string) => {
    const i = CORE_KEYS.indexOf(k);
    return i === -1 ? 999 : i;
  };
  return [...facts].sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key));
}

/**
 * Merge one fact: same canonical key replaces the previous value (latest wins)
 * and the superseded pair is returned so the caller can record it. Pure.
 */
export function mergeFact(
  facts: Fact[],
  key: string,
  value: string
): { facts: Fact[]; superseded?: { key: string; from: string; to: string } } {
  const canon = canonicalFactKey(key);
  const v = (value || "").trim();
  if (!canon || !v) return { facts };
  const out = [...facts];
  const i = out.findIndex((f) => canonicalFactKey(f.key) === canon);
  if (i === -1) {
    out.push({ key: canon, value: v });
    return { facts: out };
  }
  const prev = out[i].value;
  out[i] = { key: canon, value: v };
  return { facts: out, superseded: prev === v ? undefined : { key: canon, from: prev, to: v } };
}

/** Cap the number of facts (core keys survive first). Pure. */
export function capFacts(facts: Fact[], max: number): { facts: Fact[]; dropped: number } {
  if (facts.length <= max) return { facts, dropped: 0 };
  const ordered = sortFacts(facts);
  return { facts: ordered.slice(0, max), dropped: facts.length - max };
}

/** A `- key: value` line. Pure. */
const FACT_LINE_RE = /^\s*-\s*([^:]{1,120}?):\s*(.*?)\s*$/;

/** Parse `- key: value` lines from a section block. Pure. */
export function parseFactLines(block: string): Fact[] {
  const out: Fact[] = [];
  for (const line of (block || "").split("\n")) {
    const m = FACT_LINE_RE.exec(line);
    if (m && m[2]) out.push({ key: m[1].trim(), value: m[2].trim() });
  }
  return out;
}

/**
 * Index of a section heading that starts a LINE, not a plain substring match.
 *
 * A plain `indexOf("## Style")` matches an inline mention inside a sentence
 * ("lihat aturan di `## Style`"), which silently splits the file at the wrong
 * place — that bug shipped into the prompt for every user. Pure.
 */
export function findHeaderLine(body: string, header: string): number {
  const escaped = header.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}[ \\t]*$`, "m").exec(body);
  return match ? match.index : -1;
}

/**
 * Render the facts block (facts + optional Superseded history). Pure.
 *
 * `header` is the section heading to write — "## Facts" for USER.md, "## Style"
 * for SOUL.md. Hardcoding "## Facts" here renamed the SOUL section on every
 * soul write, which emptied the style block the prompt injects.
 */
export function renderFactsBlock(facts: Fact[], superseded: string[] = [], header = "## Facts", prose: string[] = []): string {
  const lines = sortFacts(facts).map((f) => `- ${f.key}: ${f.value}`);
  // Prose first (the style rules), facts after — the prose must survive a write.
  let out = `${header}\n\n${[...prose, ...lines].join("\n")}\n`;
  if (superseded.length) out += `\n## Superseded\n\n${superseded.slice(-20).join("\n")}\n`;
  return out;
}

/**
 * Split a persona file into preamble + facts + superseded history + prose.
 *
 * `prose` holds the section lines that are NOT facts (the style rules written
 * as sentences). They must survive a write verbatim: the fact mechanism
 * canonicalises keys, and a rule like "- Hangat itu keluar dari relevansi,
 * bukan dari pengumuman: ..." was rewritten into a slug and, when the key was
 * rejected, dropped entirely — the prompt then lost the rule.
 *
 * `proseMultiWord` marks a section where a multi-word key means prose rather
 * than a fact (the SOUL style section). USER.md keeps the old reading, so
 * legacy fact keys there are untouched. Pure.
 */
export function splitFactFile(
  text: string,
  header = "## Facts",
  opts: { proseMultiWord?: boolean } = {},
): { head: string; facts: Fact[]; superseded: string[]; prose: string[] } {
  const supMarker = "## Superseded";
  const supIdx = findHeaderLine(text, supMarker);
  const main = supIdx === -1 ? text : text.slice(0, supIdx);
  const superseded =
    supIdx === -1
      ? []
      : text
          .slice(supIdx + supMarker.length)
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.startsWith("- "));
  const idx = findHeaderLine(main, header);
  if (idx === -1) {
    const head = main.replace(/\s*$/, "");
    return { head: head ? `${head}\n\n` : "", facts: [], superseded, prose: [] };
  }
  const head = main.slice(0, idx).replace(/\s*$/, "");
  const sectionLines = main
    .slice(idx + header.length)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const facts: Fact[] = [];
  const prose: string[] = [];
  for (const line of sectionLines) {
    const m = FACT_LINE_RE.exec(line);
    if (!m || (opts.proseMultiWord && /\s/.test(m[1]))) {
      prose.push(line);
      continue;
    }
    facts.push({ key: canonicalFactKey(m[1]) || m[1], value: m[2] });
  }
  return { head: head ? `${head}\n\n` : "", facts, superseded, prose };
}
