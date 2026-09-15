// Bug-bounty submission tracker — per-user record of reports sent to a program,
// with status, so Mia can track follow-ups and avoid duplicates.
// Store: .data/users/<user>/submissions.json
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";

export type Submission = { id: string; title: string; severity: string; cvss: number | null; platform: string; url: string; status: string; submittedAt: string; updatedAt: string };
export const SUBMISSION_STATUSES = ["draft", "submitted", "triaged", "needs-info", "duplicate", "n/a", "resolved", "paid"];

function file(userKey: string): string {
  return join(userDataRoot(), userKey, "submissions.json");
}
export function readSubmissions(rawUser: unknown): Submission[] {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return [];
  try {
    const j = JSON.parse(readFileSync(file(userKey), "utf8"));
    return Array.isArray(j) ? (j as Submission[]) : [];
  } catch {
    return [];
  }
}
function write(rawUser: unknown, rows: Submission[]): void {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return;
  const f = file(userKey);
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(rows, null, 2));
  renameSync(tmp, f);
}

function similar(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 3);
  const A = new Set(norm(a));
  const hit = norm(b).filter((w) => A.has(w)).length;
  return hit >= 2;
}

export function submissionTrack(rawUser: unknown, action: string, f: { id?: string; title?: string; severity?: string; cvss?: number; platform?: string; url?: string; status?: string }): string {
  const a = (action || "").toLowerCase();
  const rows = readSubmissions(rawUser);
  if (a === "list") {
    if (!rows.length) return "Belum ada submission tercatat.";
    const byStatus: Record<string, number> = {};
    for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    return `📮 Submission (${rows.length}) — ${Object.entries(byStatus).map(([k, v]) => `${k}:${v}`).join(" ")}\n${rows
      .slice()
      .reverse()
      .map((r) => `• [${r.status}] ${r.title} (${r.severity}${r.cvss != null ? ` ${r.cvss}` : ""}) ${r.platform || ""}${r.url ? ` — ${r.url}` : ""}`)
      .join("\n")}`;
  }
  if (a === "add") {
    const title = (f.title || "").trim();
    if (!title) return "Error: title wajib.";
    const dup = rows.find((r) => similar(r.title, title) && r.status !== "duplicate" && r.status !== "n/a");
    const status = SUBMISSION_STATUSES.includes((f.status || "").toLowerCase()) ? (f.status as string).toLowerCase() : "submitted";
    const row: Submission = { id: `S-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, title, severity: (f.severity || "medium").toLowerCase(), cvss: typeof f.cvss === "number" ? f.cvss : null, platform: f.platform || "", url: f.url || "", status, submittedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    rows.push(row);
    while (rows.length > 300) rows.shift();
    write(rawUser, rows);
    return `📮 Tercatat ${row.id} [${status}] ${title}${dup ? `\n⚠️ Mirip dengan yang sudah ada (${dup.id}) — cek duplikat sebelum submit.` : ""}`;
  }
  if (a === "update" || a === "delete") {
    const idx = rows.findIndex((r) => r.id === f.id);
    if (idx < 0) return `Error: submission ${f.id} tidak ditemukan.`;
    if (a === "delete") {
      rows.splice(idx, 1);
      write(rawUser, rows);
      return `🗑️ Submission ${f.id} dihapus.`;
    }
    if (f.status && SUBMISSION_STATUSES.includes(f.status.toLowerCase())) rows[idx].status = f.status.toLowerCase();
    if (f.url) rows[idx].url = f.url;
    if (f.severity) rows[idx].severity = f.severity.toLowerCase();
    rows[idx].updatedAt = new Date().toISOString();
    write(rawUser, rows);
    return `✏️ Submission ${f.id} → [${rows[idx].status}]${rows[idx].url ? ` ${rows[idx].url}` : ""}`;
  }
  return "Error: action harus add|list|update|delete.";
}
