import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sanitizeUser, appRoot, userDataRoot } from "./users";
import { loadDailyMemoryPrompt } from "./dailyMemory";

/**
 * Loads the assistant's persona files (IDENTITY/DREAMS/SOUL/USER) at request
 * time and folds them into a single system prompt prefix. Missing files are
 * skipped gracefully.
 *
 * Persona is isolated per user (FR-auth): each user gets a copy of the base
 * persona under `.data/users/<user>/persona/`, so their facts and style never
 * bleed across accounts while every user starts from the same template.
 *
 * Also provides a small update helper so the assistant can persist stable
 * user facts and style preferences at runtime (OpenClaw-style "lived"
 * persona): USER.md for facts about the user, SOUL.md for how the assistant
 * speaks. Files stay the single source of truth.
 */

/** Base persona template (shared, read-only); the seed for every user. */
const TEMPLATE_DIR = join(appRoot(), "persona");
const USER_DATA_DIR = userDataRoot();

const PERSONA_ORDER = ["IDENTITY.md", "DREAMS.md", "SOUL.md", "USER.md"] as const;

/** Headers (## ...) whose following lines are treated as a fact list. */
const FACT_SECTIONS: Record<string, string[]> = {
  "USER.md": ["## Facts"],
  "SOUL.md": ["## Style"],
};

/** Persona dir for a (already-sanitized) user; null falls back to template. */
function personaDir(userKey: string | null): string {
  return userKey ? join(USER_DATA_DIR, userKey, "persona") : TEMPLATE_DIR;
}

/** Seed a user's persona from the shared template if it doesn't exist yet. */
export function ensureUserPersona(rawUser: unknown): string | null {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return null;
  const dir = personaDir(userKey);
  mkdirSync(dir, { recursive: true });
  for (const file of PERSONA_ORDER) {
    const target = join(dir, file);
    if (!existsSync(target) && existsSync(join(TEMPLATE_DIR, file))) {
      copyFileSync(join(TEMPLATE_DIR, file), target);
    }
  }
  return userKey;
}

function extractInjectableBody(file: string, body: string): string {
  // IDENTITY/DREAMS are static narrative already in SYSTEM_PROMPT — skip full
  // injection to avoid ~500 tok duplication every turn. Only dynamic USER/SOUL
  // facts matter for personalization.
  if (file === "IDENTITY.md" || file === "DREAMS.md") {
    // Inject a one-line anchor only, not the full narrative
    const firstLine = body.split("\n").find((l) => l.trim() && !l.trim().startsWith("#"))?.trim() ?? "";
    return firstLine ? `${file.replace(".md", "")} anchor: ${firstLine.slice(0, 120)}` : "";
  }
  // For USER/SOUL, inject only the fact/style block (deduplicating preamble)
  const headers = FACT_SECTIONS[file];
  if (headers?.length) {
    const header = headers[0];
    const idx = body.indexOf(header);
    if (idx !== -1) {
      const block = body.slice(idx).trim();
      // If block is just the header with no facts, fall back to key facts elsewhere
      if (block.length > header.length + 10) return block;
      // SOUL has no facts under ## Style yet — extract tone lines as fallback
      const toneLines = body
        .split("\n")
        .filter((l) => /^\s*-\s*tone:/i.test(l))
        .join("\n")
        .trim();
      if (toneLines) return `${header}\n\n${toneLines}`;
    }
  }
  return body.trim();
}

export function loadPersonaPrompt(rawUser?: unknown): string {
  const userKey = sanitizeUser(rawUser);
  if (userKey) ensureUserPersona(userKey); // seed per-user persona on first load
  const dir = personaDir(userKey);
  const sections: string[] = [];
  for (const file of PERSONA_ORDER) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, "utf8").trim();
      if (!raw) continue;
      const body = extractInjectableBody(file, raw);
      if (!body) continue;
      // Trim oversized persona files so growing lived persona never bloats TTFT
      const cap = file === "USER.md" || file === "SOUL.md" ? PERSONA_MAX_CHARS : 300;
      sections.push(`${file.replace(".md", "")}:\n${truncateWithMarker(body, cap)}`);
    } catch {
      // Unreadable persona file: ignore rather than break every turn.
    }
  }
  // Recent daily-memory context (today + yesterday) so fresh sessions recall
  // what was discussed recently, without bloat. Best effort.
  const recent = loadDailyMemoryPrompt(userKey);
  if (recent) {
    // Keep the two most recent days but trim each day's log (daily logs grow).
    sections.push(
      recent
        .split("\n\n")
        .map((block) => truncateWithMarker(block, DAY_LOG_MAX_CHARS))
        .join("\n\n")
    );
  }
  const joined = sections.join("\n\n");
  // Global cap across all injected persona/memory sections (OpenClaw
  // bootstrapTotalMaxChars analogue) so many modest sections can't add up to a
  // bloated prompt. Per-section caps above stay; this is the second layer.
  return truncateWithMarker(joined, PERSONA_TOTAL_MAX_CHARS);
}

export type PersonaTarget = "USER" | "SOUL";

/**
 * Appends (or updates) a fact line under the matching `## Section` of the
 * user's persona file. Duplicates are removed; a line with the same key is
 * replaced in place. Fact line format: `- <key>: <value>`. Writes to the
 * per-user persona when a valid user is provided, else the shared template.
 */
export function upsertPersonaFact(
  target: PersonaTarget,
  key: string,
  value: string,
  rawUser?: unknown
): void {
  const userKey = sanitizeUser(rawUser);
  if (userKey) ensureUserPersona(userKey);
  const fileName = target === "USER" ? "USER.md" : "SOUL.md";
  const headers = FACT_SECTIONS[fileName];
  if (!headers?.length) return;
  const dir = personaDir(userKey);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, fileName);
  if (!existsSync(path)) return;
  const valueTrim = value.trim();
  if (!key.trim() || !valueTrim) return;

  const text = readFileSync(path, "utf8");
  const header = headers[0];
  const headerIdx = text.indexOf(header);
  const prefix = `${key}:`;

  let head: string;
  let block: string;
  let tail: string;

  if (headerIdx === -1) {
    // No section yet: append a new section at the end.
    head = text.replace(/\s*$/, "\n");
    block = "";
    tail = "";
  } else {
    head = text.slice(0, headerIdx);
    const blockStart = headerIdx + header.length;
    const nextHeaderMatch = text.slice(blockStart).match(/\n## /);
    const blockEnd = nextHeaderMatch ? blockStart + nextHeaderMatch.index! : text.length;
    block = text.slice(blockStart, blockEnd);
    tail = text.slice(blockEnd);
  }

  const lines = block.split("\n").filter((l) => !l.trimStart().startsWith(`- ${prefix}`));
  const insertion = `- ${prefix} ${valueTrim}`;
  const newBlock = block === "" ? `\n${header}\n\n${insertion}\n\n` : `${lines.join("\n").replace(/\s*$/, "")}\n${insertion}\n\n`;

  writeFileSync(path, `${head}${newBlock}${tail.replace(/^\n+/, "").trimStart()}`, "utf8");

  // Continuous hygiene: collapse duplicates left by parallel capture passes.
  try {
    hygienizePersona(rawUser);
  } catch {
    /* best-effort */
  }
}

// --- Memory hygiene (feature #6) ---
//
// Lived persona files accumulate duplicates: parallel/fire-and-forget capture
// passes and older formats wrote the same fact many times, and `name` flipping
// between values ("Naufal" ↔ "beb") left conflicting rows. `hygienizePersona`
// normalizes the per-user persona:
//   - USER.md: every `- key: value` line anywhere collapses to ONE row per key
//     (last value wins — newest wins), superseded values are reported as
//     conflicts so Mia can ask the user which value to keep. The file is
//     rewritten in the canonical `## Facts` shape.
//   - SOUL.md: only EXACT duplicate lines are collapsed (tone/style bullets are
//     narrative — different values are NOT a conflict and are left untouched).
// Idempotent: a second run reports no change.

export interface HygieneConflict {
  key: string;
  kept: string;
  superseded: string;
}

export interface HygieneResult {
  file: "USER.md" | "SOUL.md";
  removed: number;
  changed: boolean;
  conflicts: HygieneConflict[];
}

/** Collapse runs of blank lines to a single blank; trim stray edges. */
function collapseBlanks(lines: string[]): string {
  const out: string[] = [];
  let blankPending = false;
  for (const line of lines) {
    const isBlank = line.trim() === "";
    if (isBlank) {
      if (out.length && !blankPending) out.push("");
      blankPending = true;
    } else {
      out.push(line);
      blankPending = false;
    }
  }
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  return out.join("\n");
}

const FACT_LINE_RE = /^\s*-\s*([^:]{1,120}?):\s*(.*?)\s*$/;

// Transient/internal keys that must never persist as persona facts (drift/noise)
const DISALLOWED_USER_KEYS = new Set([
  "ios_device_pairing_requested",
  "status", // transient ("working") — not a stable fact
  "tool", // bare `tool:` duplicates `preference.tool:` and is volatile
  "preference.crypto_monitor",
  "preference.crypto_threshold",
  "preference.crypto_direction",
  "preference.monitor_product",
]);

function hygienizeUserFile(path: string): HygieneResult {
  const result: HygieneResult = { file: "USER.md", removed: 0, changed: false, conflicts: [] };
  const original = readFileSync(path, "utf8");
  const seen = new Map<string, number>();
  const facts: { key: string; value: string }[] = [];
  const conflicts = new Map<string, HygieneConflict>();
  const nonFact: string[] = [];
  for (const line of original.split("\n")) {
    const m = FACT_LINE_RE.exec(line);
    if (m) {
      const key = m[1].trim();
      const value = m[2].trim();
      // Drop transient/internal keys and empty-bloated values
      if (DISALLOWED_USER_KEYS.has(key.toLowerCase())) {
        result.removed++;
        continue;
      }
      if (value.length > 200) {
        // Overlong value likely junk/prose — skip
        result.removed++;
        continue;
      }
      const prev = seen.get(key);
      if (prev !== undefined) {
        const old = facts[prev].value;
        if (old !== value) conflicts.set(key, { key, kept: value, superseded: old });
        facts[prev].value = value;
        result.removed++;
      } else {
        seen.set(key, facts.length);
        facts.push({ key, value });
      }
      continue;
    }
    if (/^##\s+Facts\s*$/i.test(line.trim())) continue; // rebuilt below
    nonFact.push(line);
  }
  const head = collapseBlanks(nonFact);
  const rebuilt = `${head}\n\n## Facts\n\n${facts.map((f) => `- ${f.key}: ${f.value}`).join("\n")}\n`;
  result.conflicts = [...conflicts.values()];
  if (rebuilt.replace(/\s+$/, "") !== original.replace(/\s+$/, "")) {
    writeFileSync(path, rebuilt, "utf8");
    result.changed = true;
  }
  return result;
}

function hygienizeSoulFile(path: string): HygieneResult {
  const result: HygieneResult = { file: "SOUL.md", removed: 0, changed: false, conflicts: [] };
  const original = readFileSync(path, "utf8");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of original.split("\n")) {
    if (/^\s*- /.test(line)) {
      const normalized = line.trim();
      if (seen.has(normalized)) {
        result.removed++;
        continue;
      }
      seen.add(normalized);
    }
    out.push(line);
  }
  const rebuilt = collapseBlanks(out);
  if (rebuilt !== original.replace(/\s+$/, "")) {
    writeFileSync(path, `${rebuilt}\n`, "utf8");
    result.changed = true;
  }
  return result;
}

/**
 * Dedupe/merge a user's persona files on disk. Returns per-file results
 * (removed rows + conflicts to raise with the user). Never throws.
 */
export function hygienizePersona(rawUser: unknown): HygieneResult[] {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return [];
  const dir = personaDir(userKey);
  const results: HygieneResult[] = [];
  for (const file of ["USER.md", "SOUL.md"] as const) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    try {
      results.push(file === "USER.md" ? hygienizeUserFile(path) : hygienizeSoulFile(path));
    } catch {
      /* hygiene is best-effort — never break persona serving */
    }
  }
  return results;
}

/** Run hygiene for every user that has a persona dir (server startup). */
export function hygienizeAllUsers(): HygieneResult[] {
  let dirs: string[] = [];
  try {
    dirs = readdirSync(USER_DATA_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  return dirs.flatMap((u) => hygienizePersona(u));
}

// --- Truncation-with-marker (OpenClaw-style prompt hygiene) ---
//
// Lived persona facts and daily logs grow as the assistant remembers more, so
// cap each injected section to keep the prompt lean (invariant: latency). When
// a section exceeds its cap, keep the leading content (the durable heading +
// earliest facts), append a marker that tells the model it can read the file
// itself rather than rely on the shortened preview.

/** Per-section caps (characters). Keep them modest. */
export const PERSONA_MAX_CHARS = 4000;
export const DAY_LOG_MAX_CHARS = 2000;
/** Global cap across all injected persona + daily-memory sections combined. */
export const PERSONA_TOTAL_MAX_CHARS = 12000;

/** Clip `text` to `maxChars`, appending a marker when anything was dropped. */
export function truncateWithMarker(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n… (truncated — file has more; ask to read it if needed)`;
}
