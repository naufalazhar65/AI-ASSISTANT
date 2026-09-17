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
  "weather_complaint", "reminder_tone", "work_music", "accommodation",
]);

const PREF_PREFIX = /^(?:preference|pref|preferensi|favorit|favourite|favorite|fav|kesukaan|suka)[._](.+)$/i;

/** Canonical key: merge `favorite_X` / `preference.X` / `fav_X` into one key. Pure. */
export function canonicalFactKey(raw: string): string {
  const k = (raw || "").trim().toLowerCase().replace(/\s+/g, "_").replace(/:$/, "");
  if (!k) return "";
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

/** Parse `- key: value` lines from a section block. Pure. */
export function parseFactLines(block: string): Fact[] {
  const out: Fact[] = [];
  for (const line of (block || "").split("\n")) {
    const m = /^\s*-\s*([^:]{1,120}?):\s*(.*?)\s*$/.exec(line);
    if (m && m[2]) out.push({ key: m[1].trim(), value: m[2].trim() });
  }
  return out;
}

/** Render the `## Facts` block (facts + optional Superseded history). Pure. */
export function renderFactsBlock(facts: Fact[], superseded: string[] = []): string {
  const lines = sortFacts(facts).map((f) => `- ${f.key}: ${f.value}`);
  let out = `## Facts\n\n${lines.join("\n")}\n`;
  if (superseded.length) out += `\n## Superseded\n\n${superseded.slice(-20).join("\n")}\n`;
  return out;
}

/**
 * Split a persona file into preamble + facts + superseded history. The
 * Superseded block is kept verbatim so its `- key: value` lines are never
 * re-read as live facts (that would break idempotency). Pure.
 */
export function splitFactFile(text: string, header = "## Facts"): { head: string; facts: Fact[]; superseded: string[] } {
  const supMarker = "## Superseded";
  const supIdx = text.indexOf(supMarker);
  const main = supIdx === -1 ? text : text.slice(0, supIdx);
  const superseded =
    supIdx === -1
      ? []
      : text
          .slice(supIdx + supMarker.length)
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.startsWith("- "));
  const idx = main.indexOf(header);
  if (idx === -1) {
    const head = main.replace(/\s*$/, "");
    return { head: head ? `${head}\n\n` : "", facts: [], superseded };
  }
  const head = main.slice(0, idx).replace(/\s*$/, "");
  return {
    head: head ? `${head}\n\n` : "",
    facts: parseFactLines(main.slice(idx + header.length)).map((f) => ({ key: canonicalFactKey(f.key) || f.key, value: f.value })),
    superseded,
  };
}
