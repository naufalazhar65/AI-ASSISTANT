// coverage.ts — per-user pentest coverage ledger (adapted from Strix
// strix/tools/coverage/tools.py, Apache-2.0, 2026-09-26).
//
// The gap it closes: Mia tracked WHAT was found (findings.json) and WHERE she
// had been (hunt_log dead/lead + target_brain safeTested), but never WHAT CLASS
// of risk a surface was tested FOR and HOW that test CLOSED. "Full pentest
// sudah selesai" was therefore unmeasurable — a turn could close with 2 probes
// and a PDF. The ledger records one row per (surface × risk_area) with a
// canonical outcome:
//   reported         → a finding was filed for it
//   no_issue_found   → tested, nothing found (no evidence required)
//   ruled_out        → closed as non-issue WITH evidence
//   not_applicable   → out of scope / does not apply WITH evidence
//   needs_follow_up  → not done yet WITH evidence (why + what's next)
// Closing outcomes (ruled_out/not_applicable/needs_follow_up) REQUIRE evidence
// — Strix's honesty rule, kept verbatim: you cannot wave a surface away.
//
// Store: .data/users/<user>/coverage.json (sanitizeUser + atomic write, cap
// MAX_ENTRIES). Pure helpers are unit-tested (coverage.test.ts).

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appRoot, sanitizeUser } from "./users";
import { normalizeHost } from "./engagement";

/** Canonical outcomes, in the canonical order (summary/report rendering). */
export const VALID_OUTCOMES = ["reported", "no_issue_found", "ruled_out", "not_applicable", "needs_follow_up"] as const;
export type CoverageOutcome = (typeof VALID_OUTCOMES)[number];

/** Closing outcomes must carry evidence — you cannot dismiss a surface silently. */
export const OUTCOMES_REQUIRING_EVIDENCE: ReadonlySet<CoverageOutcome> = new Set(["ruled_out", "not_applicable", "needs_follow_up"]);

/** Outcome labels for humans (report section). */
export const OUTCOME_LABEL: Record<CoverageOutcome, string> = {
  reported: "reported (temuan tercatat)",
  no_issue_found: "no issue found",
  ruled_out: "ruled out",
  not_applicable: "not applicable",
  needs_follow_up: "needs follow-up",
};

export type CoverageEntry = {
  id: string;
  /** What was tested — normalize to path-level ("https://host/api/x" → "host/api/x"). */
  surface: string;
  /** What risk class was being tested for ("idor", "sqli", "auth bypass", …). */
  risk_area: string;
  outcome: CoverageOutcome;
  /** Required for ruled_out/not_applicable/needs_follow_up. */
  evidence?: string;
  host: string;
  at: string;
  updatedAt: string;
};

const MAX_ENTRIES = 200;

function storePath(userKey: string): string {
  return join(appRoot(), ".data", "users", userKey, "coverage.json");
}

function readStore(userKey: string): CoverageEntry[] {
  try {
    const p = storePath(userKey);
    if (!existsSync(p)) return [];
    const raw = JSON.parse(readFileSync(p, "utf8")) as { entries?: CoverageEntry[] } | CoverageEntry[];
    const entries = Array.isArray(raw) ? raw : raw.entries || [];
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

function writeStore(userKey: string, entries: CoverageEntry[]): void {
  const p = storePath(userKey);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeFileSync(fd, JSON.stringify({ entries }, null, 2));
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, p);
  } catch {
    unlinkSync(tmp);
    throw new Error("gagal menulis coverage store");
  }
}

/**
 * Canonical surface: strip scheme, keep host + path + query, collapse
 * trailing slash. "https://lab.example/api/x?id=1" → "lab.example/api/x?id=1".
 * A bare host stays a bare host. Pure. Tested.
 */
export function normalizeSurface(raw: string): string {
  const t = String(raw || "").trim();
  if (!t) return "";
  const noScheme = t.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  return noScheme.replace(/\/+$/, "").toLowerCase();
}

/** Accept case/underscore/space variants of the canonical outcomes, else null. Pure. Tested. */
export function canonicalOutcome(raw: string): CoverageOutcome | null {
  const key = String(raw || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (VALID_OUTCOMES as readonly string[]).includes(key) ? (key as CoverageOutcome) : null;
}

/** Pure write-validation: returns an error message or null when the record is honest. Tested. */
export function coverageValidate(input: { surface?: string; risk_area?: string; outcome?: string; evidence?: string }): string | null {
  const surface = normalizeSurface(input.surface || "");
  const risk = String(input.risk_area || "").trim();
  const outcome = canonicalOutcome(input.outcome || "");
  if (!surface) return "surface wajib — apa yang dites (URL atau host)";
  if (!risk) return "risk_area wajib — kelas risiko apa yang diuji (mis. idor, sqli, auth)";
  if (!outcome) return `outcome harus salah satu dari: ${VALID_OUTCOMES.join(", ")}`;
  if (OUTCOMES_REQUIRING_EVIDENCE.has(outcome) && !String(input.evidence || "").trim()) {
    return `outcome "${outcome}" WAJIB evidence — surface tidak boleh ditutup tanpa bukti`;
  }
  return null;
}

/** Stable key for dedupe/update: one row per (surface × risk_area) per host. Pure. */
export function coverageKey(surface: string, riskArea: string): string {
  return `${normalizeSurface(surface)}|${String(riskArea || "").trim().toLowerCase()}`;
}

/** Outcome counts in canonical order — the summary backbone. Pure. Tested. */
export function outcomeCounts(entries: CoverageEntry[]): Record<CoverageOutcome, number> {
  const counts = { reported: 0, no_issue_found: 0, ruled_out: 0, not_applicable: 0, needs_follow_up: 0 } as Record<CoverageOutcome, number>;
  for (const e of entries || []) {
    const o = canonicalOutcome(e.outcome || "");
    if (o) counts[o] += 1;
  }
  return counts;
}

/** Progress line: closed = reported+no_issue_found+ruled_out+not_applicable; open = needs_follow_up. Pure. */
export function coverageProgress(entries: CoverageEntry[]): { total: number; closed: number; open: number } {
  const counts = outcomeCounts(entries);
  const closed = counts.reported + counts.no_issue_found + counts.ruled_out + counts.not_applicable;
  return { total: entries.length, closed, open: counts.needs_follow_up };
}

/** Render the ledger for a host (or all), newest last. Pure. Tested. */
export function renderCoverage(entries: CoverageEntry[]): string {
  if (!entries.length) return "Belum ada coverage tercatat.";
  const counts = outcomeCounts(entries);
  const lines = entries.map((e) => {
    const ev = e.evidence ? ` — ${e.evidence.slice(0, 120)}` : "";
    return `· [${e.outcome}] ${e.surface} · ${e.risk_area}${ev}`;
  });
  const head = `Coverage (${entries.length} surface · ${counts.reported} reported · ${counts.no_issue_found} no-issue · ${counts.ruled_out} ruled-out · ${counts.not_applicable} n/a · ${counts.needs_follow_up} follow-up):`;
  return [head, ...lines].join("\n");
}

/** Report-ready COVERAGE section (used by generateReport). Pure. Tested. */
export function coverageReportSection(entries: CoverageEntry[]): string {
  if (!entries.length) return "";
  const counts = outcomeCounts(entries);
  const progress = coverageProgress(entries);
  const lines: string[] = ["## Coverage", "", `Tested surfaces: ${progress.total} (closed ${progress.closed}, open ${progress.open})`, ""];
  for (const o of VALID_OUTCOMES) {
    const rows = entries.filter((e) => e.outcome === o);
    if (!rows.length) continue;
    lines.push(`### ${OUTCOME_LABEL[o]} (${rows.length})`);
    for (const r of rows) lines.push(`- ${r.surface} — ${r.risk_area}${r.evidence ? `: ${r.evidence.slice(0, 200)}` : ""}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/** Record or update one row (dedupe by surface×risk_area). Bounded at MAX_ENTRIES. */
export function recordCoverage(
  rawUser: unknown,
  input: { surface: string; risk_area: string; outcome: string; evidence?: string; target?: string },
): CoverageEntry {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) throw new Error("invalid user");
  const err = coverageValidate(input);
  if (err) throw new Error(err);
  const outcome = canonicalOutcome(input.outcome) as CoverageOutcome;
  const surface = normalizeSurface(input.surface);
  const host = normalizeHost(input.target || surface) || surface.split("/")[0] || "";
  const now = new Date().toISOString();
  const entries = readStore(userKey);
  const key = coverageKey(surface, input.risk_area);
  const existing = entries.find((e) => coverageKey(e.surface, e.risk_area) === key);
  if (existing) {
    existing.outcome = outcome;
    existing.evidence = input.evidence?.trim() || existing.evidence;
    existing.updatedAt = now;
    writeStore(userKey, entries);
    return existing;
  }
  const entry: CoverageEntry = {
    id: `C-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    surface,
    risk_area: String(input.risk_area).trim(),
    outcome,
    evidence: input.evidence?.trim() || undefined,
    host,
    at: now,
    updatedAt: now,
  };
  entries.push(entry);
  while (entries.length > MAX_ENTRIES) entries.shift();
  writeStore(userKey, entries);
  return entry;
}

/** Update an existing row by id (Strix update_coverage). */
export function updateCoverage(rawUser: unknown, id: string, patch: { outcome?: string; evidence?: string }): CoverageEntry {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) throw new Error("invalid user");
  const entries = readStore(userKey);
  const row = entries.find((e) => e.id === id);
  if (!row) throw new Error(`entry ${id} tidak ditemukan`);
  if (patch.outcome) {
    const o = canonicalOutcome(patch.outcome);
    if (!o) throw new Error(`outcome harus salah satu dari: ${VALID_OUTCOMES.join(", ")}`);
    row.outcome = o;
  }
  if (patch.evidence?.trim()) row.evidence = patch.evidence.trim();
  if (OUTCOMES_REQUIRING_EVIDENCE.has(row.outcome) && !row.evidence) {
    throw new Error(`outcome "${row.outcome}" WAJIB evidence`);
  }
  row.updatedAt = new Date().toISOString();
  writeStore(userKey, entries);
  return row;
}

export function listCoverage(rawUser: unknown, opts: { target?: string } = {}): CoverageEntry[] {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return [];
  const entries = readStore(userKey);
  const host = opts.target ? normalizeHost(opts.target) : "";
  return host ? entries.filter((e) => e.host === host) : entries;
}

/** Delete one row (bookkeeping fix). */
export function forgetCoverage(rawUser: unknown, id: string): boolean {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) throw new Error("invalid user");
  const entries = readStore(userKey);
  const i = entries.findIndex((e) => e.id === id);
  if (i === -1) return false;
  entries.splice(i, 1);
  writeStore(userKey, entries);
  return true;
}
