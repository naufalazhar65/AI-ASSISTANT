// Skills marketplace — SKILL.md loader (P0 Extensions.Skills).
// Scans apps/web/skills/*/SKILL.md and registers tools via ToolPlugin.
// Each skill is a directory with SKILL.md describing its tools; the loader
// is deterministic, works offline, and is the single source for skill tools.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appRoot } from "./users";
import { registerTool } from "./tools";

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
          execute: async () => "Halo beb 🌸 — hello dari skill marketplace Mia! Seneng kamu coba.",
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
