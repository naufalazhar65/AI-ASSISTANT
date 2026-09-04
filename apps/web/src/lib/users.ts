import { dirname, isAbsolute, join, resolve, sep } from "node:path";

/**
 * Per-user isolation key. `user` arrives from the client and is used to build
 * filesystem paths (persona/notes folders), so it MUST be validated server-side
 * (invariant 5) to prevent path traversal / injection. We fold it down to a
 * safe key: non-empty, only [A-Za-z0-9._-], ≤60 chars. Anything else is
 * rejected (returns null) so callers fall back to the shared/default store
 * rather than creating an arbitrary directory.
 */
export function sanitizeUser(user: unknown): string | null {
  if (typeof user !== "string") return null;
  const trimmed = user.trim();
  if (!trimmed || trimmed.length > 60) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return null;
  if (trimmed === "." || trimmed === "..") return null;
  return trimmed;
}

/**
 * Stable repo-root anchor. The dev server starts with cwd = `apps/web`, but
 * `verify.ts` / tsx proofs run with cwd = repo root. Both share the same
 * persisted data, so derive the app root from `process.cwd()` once: if the
 * cwd already ends in `apps/web`, use it directly; otherwise append it.
 */
export function appRoot(): string {
  const cwd = process.cwd();
  return cwd.endsWith(`${sep}apps/web`) ? cwd : join(cwd, "apps/web");
}

/** Root for all runtime-written per-user state (notes, persona, …). */
export function userDataRoot(): string {
  return join(appRoot(), ".data", "users");
}

/** The repository root (parent of apps/web) — stable across cwd differences. */
export function repoRoot(): string {
  return dirname(dirname(appRoot()));
}

/**
 * Extra project workspaces the agent may read/exec into, beyond repoRoot().
 * Read from ALLOWED_WORKSPACES env (comma-separated absolute paths). Only
 * explicitly listed dirs are permitted — the agent never slides outside the
 * repo by default. Returns absolute, normalized paths.
 */
export function allowedWorkspaces(): string[] {
  const raw = process.env.ALLOWED_WORKSPACES || "";
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const p = part.trim();
    if (p && isAbsolute(p)) out.push(resolve(p));
  }
  if (!out.length) return [];
  // Dedupe while preserving order.
  return [...new Set(out)];
}

/** All read/exec sandbox roots: the repo root plus any allowed workspaces. */
export function sandboxRoots(): string[] {
  return [repoRoot(), ...allowedWorkspaces()];
}

/**
 * Resolve a path string (relative to a sandbox root, or an absolute path inside
 * a sandbox root) into an absolute path. Returns null when the path escapes
 * every sandbox root (path traversal guard — invariant 5). Relative inputs are
 * tried against each root; absolute inputs are normalized then checked to lie
 * within a root.
 */
export function resolveInSandbox(rawPath: string): string | null {
  const p = (rawPath || "").trim();
  if (!p) return null;
  if (p.includes("~")) return null;
  const roots = sandboxRoots();
  if (isAbsolute(p)) {
    const abs = resolve(p);
    for (const root of roots) {
      if (abs === root || abs.startsWith(root + sep)) return abs;
    }
    return null;
  }
  // If p starts with an allowed workspace basename (e.g. "flowtest-studio"
  // or "flowtest-studio/src/app.ts"), map it directly to that workspace.
  // This lets the model use `cwd: "flowtest-studio"` or paths like
  // "flowtest-studio/AGENTS.md" without knowing the full absolute path.
  const firstSeg = p.split(/[/\\]/)[0];
  for (const ws of allowedWorkspaces()) {
    const base = ws.split(sep).pop() || ws;
    if (base === firstSeg) {
      const rest = p.slice(firstSeg.length).replace(/^[/\\]+/, "");
      return rest ? join(ws, rest) : ws;
    }
  }
  for (const root of roots) {
    const abs = resolve(root, p);
    if (abs === root || abs.startsWith(root + sep)) return abs;
  }
  return null;
}