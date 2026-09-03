import { existsSync, readdirSync, mkdirSync, cpSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { appRoot } from "./users";

const DATA_DIR = () => join(appRoot(), ".data");
const BACKUPS_DIR = () => join(DATA_DIR(), "backups");
const MAX_BACKUPS = 5;

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
    if (name.isDirectory() && name.name === "backups") continue;
    const from = join(dir, name.name);
    const toRel = rel ? `${rel}/${name.name}` : name.name;
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
