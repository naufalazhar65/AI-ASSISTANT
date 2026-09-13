// byterover.ts — mandiri wrapper untuk ByteRover CLI (no .openclaw dependency)
// Storage: <repoRoot>/.brv/context-tree (human-readable Markdown, git VC)
// Binary: <repoRoot>/node_modules/.bin/brv (fallback to "brv" in PATH)
// Mandiri: local-first, no home_dir fallback — .brv lives in repo; jika belum ada, auto init.
// Guards: query/curate/search dibatasi panjang, file scope sandbox, timeout, output cap.

import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { repoRoot, resolveInSandbox } from "./users";

const MAX_OUTPUT = 12000;
const QUERY_TIMEOUT = 60000;
const SEARCH_TIMEOUT = 10000;
const CURATE_TIMEOUT = 60000;
const STATUS_TIMEOUT = 8000;

function brvBin(): string {
  const local = join(repoRoot(), "node_modules/.bin/brv");
  if (existsSync(local)) return local;
  return "brv";
}

function brvCwd(): string {
  return repoRoot();
}

function truncate(s: string): string {
  const t = s.trim();
  if (t.length <= MAX_OUTPUT) return t;
  return t.slice(0, MAX_OUTPUT) + "\n…(truncated)";
}

function execBrv(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise) => {
    const bin = brvBin();
    execFile(bin, args, { timeout: timeoutMs, cwd: brvCwd(), maxBuffer: 1024 * 1024 * 2, env: process.env }, (err, stdout, stderr) => {
      const out = (stdout || "") + (stderr ? `\n${stderr}` : "");
      if (err) {
        // timeout, ENOENT, non-zero — return prefixed error but still useful
        const code = (err as NodeJS.ErrnoException & { code?: string }).code;
        if (code === "ENOENT") return resolvePromise("Error: brv CLI not found — run `npm install` di repo root");
        if (code === "ETIMEDOUT" || (err.message && err.message.includes("ETIMEDOUT"))) return resolvePromise(`Error: brv ${args[0]} timeout ${timeoutMs}ms`);
        // non-zero but may have partial output (e.g. "Not authenticated" help text)
        if (out.trim()) return resolvePromise(truncate(out));
        return resolvePromise(`Error: brv ${args.join(" ")} failed: ${err.message}`);
      }
      if (!out.trim()) return resolvePromise("(no output)");
      return resolvePromise(truncate(out));
    });
  });
}

function ensureQuery(q: string): string | null {
  const t = q.trim();
  if (!t) return "Error: query required";
  if (t.length > 800) return "Error: query too long (max 800)";
  if (t.startsWith("-")) return "Error: query must not start with '-' (flag injection guard)";
  return null;
}

function ensureText(t: string, max: number, label: string): string | null {
  const trimmed = t.trim();
  if (!trimmed) return `Error: ${label} required`;
  if (trimmed.length > max) return `Error: ${label} too long (max ${max})`;
  if (trimmed.startsWith("-")) return `Error: ${label} must not start with '-'`;
  return null;
}

// Public API — used by tools + direct import

export async function brvStatus(): Promise<string> {
  return execBrv(["status"], STATUS_TIMEOUT);
}

export async function brvQuery(query: string): Promise<string> {
  const err = ensureQuery(query);
  if (err) return err;
  // brv query "text" — uses configured LLM (groq) to synthesize from .brv/context-tree
  return execBrv(["query", query], QUERY_TIMEOUT);
}

export async function brvSearch(query: string, limit?: number, scope?: string, format?: string): Promise<string> {
  const err = ensureQuery(query);
  if (err) return err;
  const args = ["search", query];
  if (limit && Number.isFinite(limit)) {
    const n = Math.max(1, Math.min(50, Math.floor(limit)));
    args.push("--limit", String(n));
  }
  if (scope && scope.trim()) {
    // scope is path prefix filter — must be simple, no .. or absolute
    const s = scope.trim();
    if (s.includes("..") || s.startsWith("/") || s.startsWith("~")) return "Error: invalid scope (no .. or absolute)";
    args.push("--scope", s);
  }
  if (format === "json") args.push("--format", "json");
  return execBrv(args, SEARCH_TIMEOUT);
}

export async function brvCurate(text: string, files?: string[]): Promise<string> {
  const e = ensureText(text, 4000, "curate text");
  if (e) return e;
  const t = text.trim();
  const args = ["curate", t];
  if (files && files.length) {
    if (files.length > 5) return "Error: max 5 files per curate";
    for (const f of files) {
      const p = f.trim();
      if (!p) continue;
      // sandbox check — must resolve inside repo
      let resolved: string | null = null;
      try {
        resolved = resolveInSandbox(p);
      } catch {
        return `Error: file "${p}" escapes allowed sandbox root`;
      }
      if (!resolved) return `Error: file "${p}" escapes allowed sandbox root`;
      if (!existsSync(join(repoRoot(), p)) && !existsSync(resolved)) {
        return `Error: file "${p}" does not exist`;
      }
      args.push("-f", p);
    }
  }
  return execBrv(args, CURATE_TIMEOUT);
}

export async function brvVcStatus(): Promise<string> {
  return execBrv(["vc", "status"], STATUS_TIMEOUT);
}

export async function brvVcLog(limit?: number): Promise<string> {
  const args = ["vc", "log"];
  if (limit && Number.isFinite(limit)) args.push("--limit", String(Math.max(1, Math.min(50, Math.floor(limit)))));
  return execBrv(args, STATUS_TIMEOUT);
}

export async function brvLocations(): Promise<string> {
  return execBrv(["locations", "-f", "json"], STATUS_TIMEOUT);
}

export async function brvSwarmQuery(query: string, limit?: number): Promise<string> {
  const err = ensureQuery(query);
  if (err) return err;
  const args = ["swarm", "query", query];
  if (limit && Number.isFinite(limit)) args.push("-n", String(Math.max(1, Math.min(20, Math.floor(limit)))));
  return execBrv(args, SEARCH_TIMEOUT);
}

export async function brvSwarmStatus(): Promise<string> {
  return execBrv(["swarm", "status"], STATUS_TIMEOUT);
}

export async function brvSwarmCurate(text: string, provider?: string): Promise<string> {
  const e = ensureText(text, 2000, "text");
  if (e) return e;
  const args = ["swarm", "curate", text.trim()];
  if (provider && provider.trim()) {
    const p = provider.trim();
    if (p.length > 80 || p.includes("..") || p.includes("/../")) return "Error: invalid provider";
    args.push("--provider", p);
  }
  return execBrv(args, CURATE_TIMEOUT);
}

export async function brvReviewPending(): Promise<string> {
  return execBrv(["review", "pending"], STATUS_TIMEOUT);
}

export async function brvReviewApprove(taskId: string, files?: string[]): Promise<string> {
  const t = taskId.trim();
  if (!t) return "Error: taskId required";
  if (!/^[a-f0-9-]{36}$/i.test(t)) return "Error: invalid taskId (expected UUID)";
  const args = ["review", "approve", t];
  if (files && files.length) {
    for (const f of files) {
      const p = f.trim();
      if (!p || p.includes("..") || p.startsWith("/")) return `Error: invalid file "${p}"`;
      args.push("--file", p);
    }
  }
  return execBrv(args, STATUS_TIMEOUT);
}

export async function brvReviewReject(taskId: string, files?: string[]): Promise<string> {
  const t = taskId.trim();
  if (!t) return "Error: taskId required";
  if (!/^[a-f0-9-]{36}$/i.test(t)) return "Error: invalid taskId (expected UUID)";
  const args = ["review", "reject", t];
  if (files && files.length) {
    for (const f of files) {
      const p = f.trim();
      if (!p || p.includes("..") || p.startsWith("/")) return `Error: invalid file "${p}"`;
      args.push("--file", p);
    }
  }
  return execBrv(args, STATUS_TIMEOUT);
}

export async function brvCurateView(logId?: string, detail?: boolean, limit?: number): Promise<string> {
  const args = ["curate", "view"];
  if (logId && logId.trim()) {
    const id = logId.trim();
    if (!/^cur-/.test(id) && !/^[a-f0-9-]+$/.test(id)) return "Error: invalid logId";
    args.push(id);
  }
  if (detail) args.push("--detail");
  if (limit && Number.isFinite(limit)) args.push("--limit", String(Math.max(1, Math.min(100, Math.floor(limit)))));
  return execBrv(args, STATUS_TIMEOUT);
}

export async function brvQueryLogView(logId?: string, detail?: boolean, limit?: number): Promise<string> {
  const args = ["query-log", "view"];
  if (logId && logId.trim()) {
    const id = logId.trim();
    if (!/^qry-/.test(id) && !/^[a-f0-9-]+$/.test(id)) return "Error: invalid logId";
    args.push(id);
  }
  if (detail) args.push("--detail");
  if (limit && Number.isFinite(limit)) args.push("--limit", String(Math.max(1, Math.min(100, Math.floor(limit)))));
  return execBrv(args, STATUS_TIMEOUT);
}

export async function brvQueryLogSummary(last?: string): Promise<string> {
  const args = ["query-log", "summary"];
  if (last && last.trim()) {
    const v = last.trim();
    if (v.length > 20) return "Error: last too long";
    args.push("--last", v);
  }
  return execBrv(args, STATUS_TIMEOUT);
}

export async function brvProvidersList(): Promise<string> {
  return execBrv(["providers", "list"], STATUS_TIMEOUT);
}

export async function brvVcAdd(files?: string[]): Promise<string> {
  const args = ["vc", "add"];
  if (files && files.length) {
    for (const f of files) {
      const p = f.trim();
      if (!p || p.includes("..") || p.startsWith("/")) return `Error: invalid file "${p}"`;
      args.push(p);
    }
  } else {
    args.push(".");
  }
  return execBrv(args, STATUS_TIMEOUT);
}

export async function brvVcCommit(message: string): Promise<string> {
  const e = ensureText(message, 200, "commit message");
  if (e) return e;
  return execBrv(["vc", "commit", "-m", message.trim()], STATUS_TIMEOUT);
}
