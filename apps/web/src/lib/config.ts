// Central runtime config (Fase 5). Single typed source for tunable knobs so we
// stop scattering `process.env.X` reads across modules. Precedence:
//   1. environment variable (the explicit deploy/infra knob),
//   2. optional per-deploy JSON file at `.data/config.json` (gitignored — allows
//      editing knobs on a self-hosted box without touching the shell/env),
//   3. built-in default.
//
// The JSON file uses the SAME keys as the env vars (plain strings), e.g.
// `{ "RATE_LIMIT_TURNS_PER_MIN": 5, "TOOLS_DENY": "exec,write_file" }`.
// Server-side only (imports node:fs).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appRoot } from "./users";

interface RawConfig {
  [key: string]: string | number | boolean | undefined;
}

let cached: RawConfig | null = null;

function reload(): RawConfig {
  try {
    const file = join(appRoot(), ".data", "config.json");
    if (!existsSync(file)) return {};
    const parsed = JSON.parse(readFileSync(file, "utf8")) as RawConfig;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Re-read `.data/config.json` (called by tests; on the server it's read once). */
export function resetConfigCache(): void {
  cached = null;
}

function fileValue(key: string): string | number | boolean | undefined {
  if (cached === null) cached = reload();
  return cached[key];
}

export function cfgStr(key: string, def: string): string {
  const env = process.env[key];
  if (env !== undefined && env !== "") return env;
  const fv = fileValue(key);
  if (fv !== undefined) return String(fv);
  return def;
}

export function cfgInt(key: string, def: number): number {
  const env = process.env[key];
  if (env !== undefined && env !== "") {
    const n = Number(env);
    if (!Number.isNaN(n)) return n;
  }
  const fv = fileValue(key);
  if (fv !== undefined && typeof fv !== "boolean") {
    const n = Number(fv);
    if (!Number.isNaN(n)) return n;
  }
  return def;
}

export function cfgBool(key: string, def: boolean): boolean {
  const env = process.env[key];
  if (env !== undefined && env !== "") {
    if (env === "1" || env.toLowerCase() === "true") return true;
    if (env === "0" || env.toLowerCase() === "false") return false;
  }
  const fv = fileValue(key);
  if (typeof fv === "boolean") return fv;
  if (typeof fv === "string") {
    if (fv === "1" || fv.toLowerCase() === "true") return true;
    if (fv === "0" || fv.toLowerCase() === "false") return false;
  }
  return def;
}

/** Comma-separated list knob → trimmed string[]. Empty = []. */
export function cfgList(key: string, def: string): string[] {
  return cfgStr(key, def)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ——— Typed knobs used across the app (single place to read them) ———

export function rateLimitPerMin(): number {
  return cfgInt("RATE_LIMIT_TURNS_PER_MIN", 30);
}

export function auditEnabled(): boolean {
  return cfgBool("AUDIT_ENABLED", true);
}

export function auditKeepDays(): number {
  return cfgInt("AUDIT_KEEP_DAYS", 7);
}

export function recapHour(): number {
  return cfgInt("RECAP_HOUR", 21);
}

export function heartbeatMinutes(): number {
  return cfgInt("HEARTBEAT_INTERVAL_MINUTES", 30);
}

export function appLogEnabled(): boolean {
  return cfgBool("APP_LOG_ENABLED", true);
}

export function appLogKeepDays(): number {
  return cfgInt("APP_LOG_KEEP_DAYS", 14);
}

/** Tools disabled by policy (TOOLS_DENY). Blocked in executeTool. */
export function toolsDeny(): string[] {
  return cfgList("TOOLS_DENY", "");
}