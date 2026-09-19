// Server-only key fallbacks (invariant 5). providers.ts is imported by client
// code (Settings UI metadata), so it must stay free of node built-ins — any
// file-based key source lives here and seeds the server env before
// resolveProvider runs.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * OpenCode Go: the opencode CLI login stores the subscription key in
 * ~/.local/share/opencode/auth.json. Slot name varies by CLI version:
 * v1 used "opencode-go", v2 (2026-09) renamed it to "opencode". Try both,
 * prefer the v1 name. Read it once and seed process.env.OPENCODEGO_API_KEY.
 * Never logs or returns the key.
 */
export function ensureOpenCodeGoKey(): void {
  if (process.env.OPENCODEGO_API_KEY) return;
  try {
    const file = join(homedir(), ".local", "share", "opencode", "auth.json");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, { key?: string } | undefined>;
    const key = parsed["opencode-go"]?.key ?? parsed["opencode"]?.key;
    if (typeof key === "string" && key) process.env.OPENCODEGO_API_KEY = key;
  } catch {
    /* no auth.json — the provider stays unconfigured until a key is set */
  }
}
