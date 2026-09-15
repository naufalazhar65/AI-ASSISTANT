// Per-user hunt log — durable memory of what has already been tested per target
// so a hunt session doesn't re-tread dead ends (the biggest source of wasted
// turns in long hunts) and can resume across restarts.
//
// Local notes only (no network). One entry per target key, upserted in place.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";

export type HuntStatus = "todo" | "testing" | "dead" | "lead" | "finding";
const STATUSES: HuntStatus[] = ["todo", "testing", "dead", "lead", "finding"];
const ICON: Record<HuntStatus, string> = { todo: "⬜", testing: "🔬", dead: "🚫", lead: "🟡", finding: "🔴" };
const MAX_ENTRIES = 200;

export type HuntEntry = {
  target: string;
  status: HuntStatus;
  note: string;
  evidence: string;
  updatedAt: string;
  count: number;
};

/** Normalize a target key: lowercase, drop scheme/trailing slash, keep host+path. */
export function normalizeTarget(s: string): string {
  return (s || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .slice(0, 200);
}

function storePath(rawUser: unknown): string {
  const user = sanitizeUser(rawUser) ?? "shared";
  return join(userDataRoot(), user, "hunt-state.json");
}

function read(rawUser: unknown): HuntEntry[] {
  try {
    const p = storePath(rawUser);
    if (!existsSync(p)) return [];
    const j = JSON.parse(readFileSync(p, "utf8")) as unknown;
    return Array.isArray(j) ? (j as HuntEntry[]).filter((e) => e && typeof e.target === "string") : [];
  } catch {
    return [];
  }
}

function write(rawUser: unknown, entries: HuntEntry[]): void {
  const p = storePath(rawUser);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(entries.slice(0, MAX_ENTRIES), null, 2));
  renameSync(tmp, p);
}

/** Upsert one target's status/note (also `evidence` link/text). */
export function huntSet(rawUser: unknown, targetRaw: string, statusRaw: string, note = "", evidence = ""): string {
  const target = normalizeTarget(targetRaw);
  if (!target) return "Error: target wajib (mis. host.tld/path).";
  const status = (STATUSES.includes(statusRaw as HuntStatus) ? statusRaw : "todo") as HuntStatus;
  if (statusRaw && !STATUSES.includes(statusRaw as HuntStatus)) {
    return `Error: status harus salah satu dari: ${STATUSES.join(", ")}.`;
  }
  const entries = read(rawUser);
  const at = new Date().toISOString();
  const i = entries.findIndex((e) => e.target === target);
  if (i >= 0) {
    entries[i] = { ...entries[i], status, note: note || entries[i].note, evidence: evidence || entries[i].evidence, updatedAt: at, count: entries[i].count + 1 };
  } else {
    entries.unshift({ target, status, note, evidence, updatedAt: at, count: 1 });
  }
  write(rawUser, entries);
  return `${ICON[status]} Hunt log ${entries.find((e) => e.target === target)?.count ?? 1}× untuk ${target} → ${status}${note ? `\n   ${note}` : ""}`;
}

/** Human-readable log grouped by status (reading this BEFORE testing avoids repeats). */
export function huntListText(rawUser: unknown): string {
  const entries = read(rawUser);
  if (!entries.length) return "Hunt log kosong — belum ada target yang dicatat.";
  const order: HuntStatus[] = ["finding", "lead", "testing", "todo", "dead"];
  const lines: string[] = [`🗂️ Hunt log (${entries.length} target):`];
  for (const st of order) {
    const group = entries.filter((e) => e.status === st);
    if (!group.length) continue;
    lines.push(`\n${ICON[st]} ${st.toUpperCase()} (${group.length})`);
    for (const e of group) {
      lines.push(`• ${e.target}${e.note ? ` — ${e.note.slice(0, 140)}` : ""}${e.evidence ? ` [${e.evidence.slice(0, 80)}]` : ""}`);
    }
  }
  lines.push("\nSebelum menguji ulang sebuah target, cek status di sini — SKIP yang sudah dead.");
  return lines.join("\n");
}

/** One target's current state ('' when absent). */
export function huntGetText(rawUser: unknown, targetRaw: string): string {
  const target = normalizeTarget(targetRaw);
  const e = read(rawUser).find((x) => x.target === target);
  if (!e) return `Hunt log: ${target} belum pernah dicatat.`;
  return `${ICON[e.status]} ${e.target} → ${e.status} (${e.count}×)\n${e.note || "(tanpa catatan)"}${e.evidence ? `\nBukti: ${e.evidence}` : ""}\nUpdate: ${e.updatedAt}`;
}
