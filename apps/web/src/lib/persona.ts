import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
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

export function loadPersonaPrompt(rawUser?: unknown): string {
  const userKey = sanitizeUser(rawUser);
  if (userKey) ensureUserPersona(userKey); // seed per-user persona on first load
  const dir = personaDir(userKey);
  const sections: string[] = [];
  for (const file of PERSONA_ORDER) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    try {
      const body = readFileSync(path, "utf8").trim();
      // Trim oversized persona files (OpenClaw-style truncation-with-marker) so
      // a growing lived persona never bloats the prompt or TTFT budget.
      sections.push(`${file.replace(".md", "")}:\n${truncateWithMarker(body, PERSONA_MAX_CHARS)}`);
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
  return sections.join("\n\n");
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

/** Clip `text` to `maxChars`, appending a marker when anything was dropped. */
export function truncateWithMarker(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n… (truncated — file has more; ask to read it if needed)`;
}
