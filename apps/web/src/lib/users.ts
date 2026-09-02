import { dirname, join, sep } from "node:path";

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