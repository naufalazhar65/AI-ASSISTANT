// Engagement & Scope — records a client pentest authorization so Mia can help
// legally and traceably. Non-lab targets are only allowed if an ACTIVE
// engagement lists them. Owner-level store: .data/engagements.json.
//
// NOTE: Mia cannot verify legal authorization — the user asserts it; the record
// (client + authorization reference + scope + window) is the audit trail.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appRoot } from "./users";

export type Engagement = {
  id: string;
  name: string;
  client: string;
  authorization: string;
  scope: string[];
  outOfScope: string[];
  windowStart?: string;
  windowEnd?: string;
  contact?: string;
  notes?: string;
  status: "active" | "closed";
  createdAt: string;
  closedAt?: string;
};

function file(): string {
  return join(appRoot(), ".data", "engagements.json");
}
function readAll(): Engagement[] {
  try {
    const a = JSON.parse(readFileSync(file(), "utf8"));
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}
function writeAll(rows: Engagement[]): void {
  const f = file();
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(rows, null, 2));
  renameSync(tmp, f);
}

/** Extract the bare host from an authority token, handling IPv6 + port. */
function hostOnly(authority: string): string {
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    return end >= 0 ? authority.slice(1, end) : authority.slice(1);
  }
  const parts = authority.split(":");
  // More than one colon means a bare (unbracketed) IPv6 literal, not host:port.
  return parts.length > 2 ? authority : parts[0];
}

/** Normalize a URL/host/CIDR-ish token to a bare lowercase host. */
export function normalizeHost(raw: unknown): string {
  return hostOnly(
    String(raw ?? "")
      .trim()
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, "")
      .replace(/^\*\./, "") // wildcard scope (`*.example.com`) → base domain
      .split("/")[0]
  );
}

export function createEngagement(f: { name?: string; client?: string; authorization?: string; scope?: string[]; outOfScope?: string[]; windowStart?: string; windowEnd?: string; contact?: string; notes?: string }): Engagement {
  const name = (f.name || "").trim();
  const client = (f.client || "").trim();
  const authorization = (f.authorization || "").trim();
  const scope = (f.scope || []).map((s) => String(s).trim()).filter(Boolean);
  if (!name || !client || !authorization || !scope.length) {
    throw new Error("wajib: name, client, authorization (no. izin/PO/email), dan scope[] minimal 1 host");
  }
  const rows = readAll();
  const eng: Engagement = {
    id: `ENG-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    client,
    authorization,
    scope,
    outOfScope: (f.outOfScope || []).map((s) => String(s).trim()).filter(Boolean),
    windowStart: f.windowStart,
    windowEnd: f.windowEnd,
    contact: f.contact,
    notes: f.notes,
    status: "active",
    createdAt: new Date().toISOString(),
  };
  rows.push(eng);
  while (rows.length > 50) rows.shift();
  writeAll(rows);
  return eng;
}

export function listEngagements(): Engagement[] {
  return readAll().sort((a, b) => (a.status === b.status ? 0 : a.status === "active" ? -1 : 1));
}

export function getEngagement(id: string): Engagement | null {
  return readAll().find((e) => e.id === id) ?? null;
}

export function closeEngagement(id: string): boolean {
  const rows = readAll();
  const e = rows.find((x) => x.id === id);
  if (!e) return false;
  e.status = "closed";
  e.closedAt = new Date().toISOString();
  writeAll(rows);
  return true;
}

function inWindow(e: Engagement): boolean {
  const now = Date.now();
  if (e.windowStart && now < Date.parse(e.windowStart)) return false;
  if (e.windowEnd && now > Date.parse(e.windowEnd)) return false;
  return true;
}

/** The active engagement that authorizes this host, if any. */
export function activeEngagementFor(raw: unknown): Engagement | null {
  const h = normalizeHost(raw);
  if (!h) return null;
  for (const e of readAll()) {
    if (e.status !== "active" || !inWindow(e)) continue;
    const out = e.outOfScope.map(normalizeHost);
    if (out.some((o) => o && (h === o || h.endsWith("." + o)))) continue;
    // Only the scoped host or a SUBDOMAIN of it is authorized; a parent domain
    // (e.g. `ptx.co.id` when only `app.ptx.co.id` is in scope) must NOT match.
    const hit = e.scope.map(normalizeHost).some((s) => s && (h === s || h.endsWith("." + s)));
    if (hit) return e;
  }
  return null;
}

export function engagementAllows(raw: unknown): boolean {
  return !!activeEngagementFor(raw);
}

export function engagementsText(): string {
  const rows = listEngagements();
  if (!rows.length) return "Belum ada engagement. Buat dengan engagement_create (name, client, authorization, scope[]).";
  return rows
    .map((e) => `• ${e.id} [${e.status}] ${e.name} — ${e.client}\n   Izin: ${e.authorization}\n   Scope: ${e.scope.join(", ")}${e.outOfScope.length ? ` | out: ${e.outOfScope.join(", ")}` : ""}${e.windowStart || e.windowEnd ? `\n   Window: ${e.windowStart || "?"} .. ${e.windowEnd || "?"}` : ""}`)
    .join("\n");
}
