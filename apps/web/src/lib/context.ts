// Context awareness (P2) — know what the user is currently doing on the Mac so
// Mia can answer "lagi ngapain?" or tailor help without being asked for it.
//
// Privacy-safe on purpose: only the foreground app name + window title are
// captured (no screen content, no keystrokes). Sampled periodically and stored
// at .data/context/last.json; the sampler is macOS-only (osascript/System
// Events) and degrades to "tidak tersedia" when it can't run or the user hasn't
// granted Accessibility permission.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { appRoot } from "./users";
import { contextSampleSeconds } from "./config";
import { logInfo } from "./appLogger";

export interface ActiveContext {
  app: string;
  window?: string;
  sampledAt: number;
  firstSeenAt: number;
}

let timer: NodeJS.Timeout | null = null;
let started = false;
let lastWrite: ActiveContext | null = null;

function lastFile(): string {
  return join(appRoot(), ".data", "context", "last.json");
}

function readLast(): ActiveContext | null {
  try {
    const f = lastFile();
    if (!existsSync(f)) return null;
    const parsed = JSON.parse(readFileSync(f, "utf8")) as ActiveContext;
    return parsed && typeof parsed.app === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function writeLast(ctx: ActiveContext): void {
  try {
    const f = lastFile();
    mkdirSync(dirname(f), { recursive: true });
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, JSON.stringify(ctx));
    renameSync(tmp, f);
  } catch { /* best-effort */ }
}

/** Parse osascript output (line 1 = app, line 2 = window title, may be empty). */
export function parseActiveOutput(stdout: string): { app?: string; window?: string } {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  return { app: lines[0] || undefined, window: lines[1] || undefined };
}

async function activeFromOsascript(): Promise<{ app: string; window?: string } | null> {
  const script = [
    'tell application "System Events"',
    'try',
    '  set appName to name of first application process whose frontmost is true',
    'on error',
    '  set appName to ""',
    'end try',
    'set winName to ""',
    'try',
    '  set winName to name of first window of first application process whose frontmost is true',
    'end try',
    'return appName & linefeed & winName',
    'end tell',
  ].join("\n");
  const out = await new Promise<string>((resolve, reject) => {
    execFile("osascript", ["-e", script], { timeout: 4000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout ?? "");
    });
  });
  const parsed = parseActiveOutput(out);
  if (!parsed.app) return null;
  return { app: parsed.app, window: parsed.window };
}

/** Sample the active app/window once and persist it. Returns null when unavailable. */
export async function sampleContext(): Promise<ActiveContext | null> {
  const found = await activeFromOsascript();
  if (!found) return null;
  const prev = readLast();
  const sameFocus = prev && prev.app === found.app && prev.window === found.window;
  const ctx: ActiveContext = {
    app: found.app,
    window: found.window,
    sampledAt: Date.now(),
    firstSeenAt: sameFocus ? prev.firstSeenAt : Date.now(),
  };
  writeLast(ctx);
  lastWrite = ctx;
  return ctx;
}

/** Most recently sampled context (from memory or disk). Can be stale. */
export function getCurrentContext(): ActiveContext | null {
  return lastWrite ?? readLast();
}

/** Nice Indonesian one-liner for the tool, sampling fresh when nothing is cached yet. */
export async function currentContextTextFresh(): Promise<string> {
  let ctx = getCurrentContext();
  if (!ctx) {
    ctx = await sampleContext();
  }
  if (!ctx || !ctx.app) return "";
  const mins = Math.max(0, Math.round((Date.now() - ctx.firstSeenAt) / 60000));
  const where = ctx.window ? `${ctx.app} — ${ctx.window}` : ctx.app;
  const terse = mins < 1 ? "baru aja ini" : mins < 60 ? `sejak ±${mins} menit` : `sejak ±${Math.round(mins / 60)} jam`;
  return `User sedang di ${where} (${terse})`;
}

/** Start the periodic sampler. Idempotent; macOS-only, unref'd (never keeps process alive). */
export function startContextSampler(): void {
  if (started) return;
  started = true;
  const seconds = contextSampleSeconds();
  if (!seconds) {
    logInfo("context", "disabled (CONTEXT_SAMPLE_SECONDS=0) — context_active akan sample saat dipanggil");
    return;
  }
  logInfo("context", `starting — sample every ${seconds}s`);
  const run = async () => {
    try {
      await sampleContext();
    } catch { /* ignore */ }
  };
  setTimeout(() => void run(), 5000);
  timer = setInterval(() => void run(), seconds * 1000);
  if (timer && typeof timer.unref === "function") timer.unref();
}

export function stopContextSampler(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}