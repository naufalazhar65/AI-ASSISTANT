import { existsSync, readdirSync, mkdirSync, cpSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { appRoot } from "./users";

const DATA_DIR = () => join(appRoot(), ".data");
const BACKUPS_DIR = () => join(DATA_DIR(), "backups");
const MAX_BACKUPS = 5;
// A snapshot is for STATE recovery: skip derived caches, transient artifacts and
// oversized binaries. Without this each backup copied the 11 MB codebase index,
// 8 MB of CUA screenshots, logs and the user's multi-MB uploads — 5 snapshots hit
// 430 MB with almost nothing restorable beyond what a few MB would have held.
const SKIP_DIRS = new Set(["backups", "cua", "logs", "tool-output"]);
const SKIP_FILES = new Set(["codebase-index.json"]);
const MAX_BACKUP_FILE_BYTES = 4 * 1024 * 1024;

/** Should this path be left out of a backup? Pure — unit-tested. */
export function shouldSkipInBackup(rel: string, sizeBytes = 0, isDir = false): boolean {
  const parts = rel.split("/");
  if (parts.some((p) => SKIP_DIRS.has(p))) return true;
  if (parts.some((p) => SKIP_FILES.has(p))) return true;
  if (parts.some((p) => p === "uploads") && sizeBytes > MAX_BACKUP_FILE_BYTES) return true;
  if (!isDir && sizeBytes > MAX_BACKUP_FILE_BYTES) return true;
  return false;
}

export function backupNow(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(BACKUPS_DIR(), ts);
  if (!existsSync(DATA_DIR())) return `No data dir at ${DATA_DIR()}`;

  mkdirSync(dest, { recursive: true });

  // Walk manually instead of cpSync(DATA_DIR(), dest): Node rejects copying a
  // directory into its own subdirectory, and we want to skip the `backups`
  // folder anyway so each backup can't capture its own growing contents.
  try {
    const moves: { from: string; to: string }[] = [];
    walk(DATA_DIR(), "", dest, moves);
    for (const m of moves) {
      const st = statSync(m.from);
      if (st.isFile()) {
        mkdirSync(dirname(m.to), { recursive: true });
        writeFileSync(m.to, readFileSync(m.from));
      } else if (st.isDirectory()) {
        mkdirSync(m.to, { recursive: true });
      }
    }
  } catch (e) {
    return `Backup failed: ${String(e).slice(0, 200)}`;
  }

  pruneOld();
  return dest;
}

function walk(dir: string, rel: string, dest: string, moves: { from: string; to: string }[]): void {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const toRel = rel ? `${rel}/${name.name}` : name.name;
    const from = join(dir, name.name);
    let size = 0;
    try {
      const st = statSync(from);
      size = st.isFile() ? st.size : 0;
    } catch {
      continue;
    }
    if (shouldSkipInBackup(toRel, size, name.isDirectory())) continue;
    moves.push({ from, to: join(dest, toRel) });
    if (name.isDirectory()) {
      walk(from, toRel, dest, moves);
    }
  }
}

export function listBackups(): string[] {
  if (!existsSync(BACKUPS_DIR())) return [];
  return readdirSync(BACKUPS_DIR(), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

export function restoreBackup(ts: string): string {
  const src = join(BACKUPS_DIR(), ts);
  if (!existsSync(src)) return `Backup not found: ${ts}`;
  try {
    cpSync(src, DATA_DIR(), { recursive: true, force: true });
    return `Restored from ${ts}`;
  } catch (e) {
    return `Restore failed: ${String(e).slice(0, 200)}`;
  }
}

function pruneOld() {
  const all = listBackups();
  if (all.length <= MAX_BACKUPS) return;
  const toRemove = all.slice(0, all.length - MAX_BACKUPS);
  for (const n of toRemove) {
    try {
      rmSync(join(BACKUPS_DIR(), n), { recursive: true, force: true });
    } catch { /* ignore */ }
  }
}
