import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";

export interface Correction {
  id: string;
  original: string;
  corrected: string;
  at: number;
}

const MAX_CORRECTIONS = 100;

function correctionsPath(userKey: string): string {
  return join(userDataRoot(), userKey, "corrections.json");
}

export function readCorrections(rawUser?: unknown): Correction[] {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return [];
  try {
    const raw = readFileSync(correctionsPath(userKey), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is Correction =>
        !!e && typeof (e as Correction).id === "string" && typeof (e as Correction).corrected === "string" && typeof (e as Correction).at === "number"
    );
  } catch {
    return [];
  }
}

function writeCorrections(corrections: Correction[], userKey: string): void {
  const file = correctionsPath(userKey);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(corrections, null, 2));
  renameSync(tmp, file);
}

export function addCorrection(original: string, corrected: string, rawUser?: unknown): Correction | null {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return null;
  const corr = corrected.trim().slice(0, 500);
  if (!corr) return null;
  const orig = original.trim().slice(0, 500);
  const entry: Correction = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, original: orig, corrected: corr, at: Date.now() };
  const list = readCorrections(rawUser);
  // dedupe: same corrected within 1h -> skip
  if (list.some((c) => c.corrected === corr && Date.now() - c.at < 3600000)) return null;
  list.push(entry);
  while (list.length > MAX_CORRECTIONS) list.shift();
  writeCorrections(list, userKey);
  return entry;
}
