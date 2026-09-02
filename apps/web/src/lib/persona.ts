import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Loads the assistant's persona files (IDENTITY/DREAMS/SOUL/USER) from
 * `apps/web/persona` at request time and folds them into a single system
 * prompt prefix. Missing files are skipped gracefully.
 *
 * Also provides a small update helper so the assistant can persist stable
 * user facts and style preferences to these files at runtime (OpenClaw-style
 * "lived" persona): USER.md for facts about the user, SOUL.md for how the
 * assistant speaks. Files stay the single source of truth.
 */
const PERSONA_DIR = join(process.cwd(), "persona");
const PERSONA_ORDER = ["IDENTITY.md", "DREAMS.md", "SOUL.md", "USER.md"] as const;

/** Headers (## ...) whose following lines are treated as a fact list. */
const FACT_SECTIONS: Record<string, string[]> = {
  "USER.md": ["## Facts"],
  "SOUL.md": ["## Style"],
};

export function loadPersonaPrompt(): string {
  const sections: string[] = [];
  for (const file of PERSONA_ORDER) {
    const path = join(PERSONA_DIR, file);
    if (!existsSync(path)) continue;
    try {
      const body = readFileSync(path, "utf8").trim();
      if (body) sections.push(`${file.replace(".md", "")}:\n${body}`);
    } catch {
      // Unreadable persona file: ignore rather than break every turn.
    }
  }
  return sections.join("\n\n");
}

export type PersonaTarget = "USER" | "SOUL";

/**
 * Appends (or updates) a fact line under the matching `## Section` of the
 * persona file. Duplicates are removed; a line with the same key is replaced
 * in place. Fact line format: `- <key>: <value>`.
 */
export function upsertPersonaFact(target: PersonaTarget, key: string, value: string): void {
  const fileName = target === "USER" ? "USER.md" : "SOUL.md";
  const headers = FACT_SECTIONS[fileName];
  if (!headers?.length) return;
  const path = join(PERSONA_DIR, fileName);
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
