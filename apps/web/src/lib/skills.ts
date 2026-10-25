// Skills marketplace — SKILL.md loader + discovery + routing (Modular Pentest Skills System).
// Scans apps/web/skills/*/SKILL.md and registers tools via ToolPlugin.
// Each skill is a directory with SKILL.md describing its tools; the loader
// is deterministic, works offline, and is the single source for skill tools.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appRoot } from "./users";
import { registerTool } from "./tools";
import {
  PENTEST_SKILLS,
  SKILL_REGISTRY,
  routeSkills,
  type PentestSkill,
  type SkillMeta,
  type SkillRouteContext,
  type SkillRouteResult,
} from "./findingSchema";

export type { PentestSkill, SkillMeta, SkillRouteContext, SkillRouteResult };
export { PENTEST_SKILLS, SKILL_REGISTRY };

export interface SkillInfo {
  id: string;
  title: string;
  description: string;
  tools: string[];
}

function skillsDir(): string {
  return join(appRoot(), "skills");
}

export function listSkills(): SkillInfo[] {
  const dir = skillsDir();
  if (!existsSync(dir)) return [];
  const out: SkillInfo[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const skillPath = join(dir, entry.name, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    try {
      const md = readFileSync(skillPath, "utf8");
      const title = md.match(/^#\s+Skill:\s*(.+)$/m)?.[1]?.trim() || entry.name;
      const desc = md.match(/^>\s*(.+)$/m)?.[1]?.trim() || "";
      const tools = [...md.matchAll(/-\s+\*\*(\w+)\*\*/g)].map((m) => m[1]);
      out.push({ id: entry.name, title, description: desc, tools });
    } catch { /* ignore corrupt */ }
  }
  return out;
}

export function loadSkills(): number {
  const skills = listSkills();
  let loaded = 0;
  for (const skill of skills) {
    // Example: hello_world from hello skill
    if (skill.id === "hello" && skill.tools.includes("hello_world")) {
      try {
        registerTool({
          definition: {
            type: "function",
            risk: "read",
            function: {
              name: "hello_world",
              description: "Say hello warmly as Mia — demo skill from marketplace.",
              parameters: { type: "object", properties: {}, required: [] },
            },
          },
          execute: async () => "Halo beb 🌸 — hello dari skill marketplace Mia!",
        });
        loaded++;
      } catch { /* already registered */ }
    }
  }
  return loaded;
}

export function searchSkillsText(query: string): string {
  const q = query.trim().toLowerCase();
  const skills = listSkills();
  if (!skills.length) return "Belum ada skill di marketplace — buat di apps/web/skills/<id>/SKILL.md 🌸";
  const filtered = q ? skills.filter((s) => `${s.id} ${s.title} ${s.description} ${s.tools.join(" ")}`.toLowerCase().includes(q)) : skills;
  if (!filtered.length) return `Tidak ada skill untuk "${query}" — coba kata lain.`;
  return filtered.map((s) => `• ${s.id} — ${s.title}: ${s.description} (tools: ${s.tools.join(", ") || "none"})`).join("\n").slice(0, 4000);
}

/** Discover pentest skills from SKILL.md files + registry. */
export function discoverPentestSkills(): SkillMeta[] {
  const fromFiles = listSkills();
  const result: SkillMeta[] = [];
  for (const skillId of PENTEST_SKILLS) {
    const meta = SKILL_REGISTRY[skillId];
    const fileSkill = fromFiles.find((s) => s.id === skillId);
    result.push({
      ...meta,
      title: fileSkill?.title || meta.title,
      description: fileSkill?.description || meta.description,
      tools: fileSkill?.tools?.length ? fileSkill.tools : meta.tools,
    });
  }
  return result;
}

/** Search pentest skills by keyword. */
export function searchPentestSkills(query: string): SkillMeta[] {
  const q = query.trim().toLowerCase();
  if (!q) return discoverPentestSkills();
  return discoverPentestSkills().filter((s) =>
    `${s.id} ${s.title} ${s.description} ${s.tools.join(" ")} ${s.whenToUse}`.toLowerCase().includes(q),
  );
}

/** Route a target context to the appropriate skills (delegates to findingSchema). */
export function routePentestSkills(ctx: SkillRouteContext): SkillRouteResult {
  return routeSkills(ctx);
}

/** Format a skill route result as human-readable text. */
export function formatSkillRoute(result: SkillRouteResult): string {
  const lines: string[] = [];
  lines.push(`🧭 SKILL ROUTE: ${result.primary.length} primary + ${result.secondary.length} secondary`);
  lines.push("");
  lines.push("Primary (run first):");
  for (const s of result.primary) lines.push(`  → ${s}`);
  lines.push("");
  lines.push("Secondary (run after):");
  for (const s of result.secondary) lines.push(`  → ${s}`);
  if (result.skipped.length > 0) {
    lines.push("");
    lines.push("Skipped:");
    for (const s of result.skipped) lines.push(`  ⊘ ${s.skill} — ${s.reason}`);
  }
  lines.push("");
  lines.push(result.reason);
  return lines.join("\n");
}