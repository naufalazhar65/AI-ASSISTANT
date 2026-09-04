import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";

function memoryDir(userKey: string | null): string {
  const key = userKey || "shared";
  return join(userDataRoot(), key, "memory");
}

export function dailyMemoryPath(rawUser: unknown, dateStr: string): string {
  const userKey = sanitizeUser(rawUser) || "shared";
  const dir = memoryDir(userKey);
  // Validate dateStr is YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw new Error("date must be YYYY-MM-DD");
  return join(dir, `${dateStr}.md`);
}

export function todayStr(tz?: string): string {
  const now = new Date();
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz || "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" });
    return fmt.format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function appendDailyMemory(rawUser: unknown, content: string): void {
  if (!content.trim()) return;
  const userKey = sanitizeUser(rawUser) || "shared";
  const dir = memoryDir(userKey);
  mkdirSync(dir, { recursive: true });
  const date = todayStr();
  const path = join(dir, `${date}.md`);
  const timestamp = new Date().toISOString();
  const entry = `\n## ${timestamp}\n${content.trim()}\n`;
  try {
    appendFileSync(path, entry, "utf8");
  } catch {
    // Fallback: create file
    writeFileSync(path, `# Memory ${date}\n${entry}`, "utf8");
  }
}

export function readDailyMemory(rawUser: unknown, dateStr: string): string {
  // Handle "today", "yesterday"
  let target = dateStr.trim().toLowerCase();
  if (target === "today") target = todayStr();
  else if (target === "yesterday") {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    try {
      const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" });
      target = fmt.format(d);
    } catch {
      target = d.toISOString().slice(0, 10);
    }
  }
  const path = dailyMemoryPath(rawUser, target);
  if (!existsSync(path)) return `No memory for ${target}`;
  const content = readFileSync(path, "utf8");
  return content.slice(0, 60000) || `(empty memory for ${target})`;
}

export function listDailyMemories(rawUser: unknown): string[] {
  const userKey = sanitizeUser(rawUser) || "shared";
  const dir = memoryDir(userKey);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .map((f) => f.replace(/\.md$/, ""))
      .sort();
  } catch {
    return [];
  }
}

export function loadDailyMemoryPrompt(rawUser: unknown): string {
  const userKey = sanitizeUser(rawUser) || "shared";
  const today = todayStr();
  const yesterday = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    try {
      const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" });
      return fmt.format(d);
    } catch {
      return d.toISOString().slice(0, 10);
    }
  })();
  const parts: string[] = [];
  for (const date of [today, yesterday]) {
    try {
      const path = dailyMemoryPath(rawUser, date);
      if (existsSync(path)) {
        const content = readFileSync(path, "utf8").trim();
        if (content) parts.push(`Daily memory ${date}:\n${content.slice(0, 3000)}`);
      }
    } catch { /* ignore */ }
  }
  return parts.join("\n\n");
}
