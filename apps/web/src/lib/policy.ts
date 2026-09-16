// Per-engagement auto-approval policy — removes confirmation friction for a
// vetted subset of tools DURING an active engagement, without weakening the
// trust boundary. Hard rules:
//   - only `read`/`write` tools can ever be auto-approved (never delete /
//     transaction / external);
//   - any URL in the args must pass targetAllowed (lab or the active engagement);
//   - the whole approval is inert when no engagement is active.
//
// Owner-level store: .data/policy.json (one personal deploy).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appRoot } from "./users";

export type Policy = { autoApprove: string[]; note: string; updatedAt: string };

function file(): string {
  return join(appRoot(), ".data", "policy.json");
}

export function readPolicy(): Policy {
  try {
    const j = JSON.parse(readFileSync(file(), "utf8")) as Partial<Policy>;
    return { autoApprove: Array.isArray(j.autoApprove) ? j.autoApprove.filter((x) => typeof x === "string") : [], note: typeof j.note === "string" ? j.note : "", updatedAt: typeof j.updatedAt === "string" ? j.updatedAt : "" };
  } catch {
    return { autoApprove: [], note: "", updatedAt: "" };
  }
}

function write(p: Policy): void {
  const f = file();
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(p, null, 2));
  renameSync(tmp, f);
}

/** Replace (set) or extend (add) the auto-approve list; `reset` clears it. */
export function setPolicy(action: "set" | "add" | "reset", tools: string[], note = ""): Policy {
  const cur = readPolicy();
  let list: string[];
  if (action === "reset") list = [];
  else if (action === "set") list = tools.map((t) => t.trim()).filter(Boolean);
  else list = [...new Set([...cur.autoApprove, ...tools.map((t) => t.trim()).filter(Boolean)])];
  const next: Policy = { autoApprove: list.slice(0, 50), note: note || cur.note, updatedAt: new Date().toISOString() };
  write(next);
  return next;
}

export function policyText(): string {
  const p = readPolicy();
  if (!p.autoApprove.length) return "Policy: auto-approve kosong (semua tool berisiko tetap minta konfirmasi).";
  return `Policy auto-approve (${p.autoApprove.length}): ${p.autoApprove.join(", ")}${p.note ? `\nCatatan: ${p.note}` : ""}\n(aktif hanya saat engagement aktif; delete/transaction/external TIDAK pernah auto)`;
}

/** Collect http(s) URLs from tool args (recursive). */
function urlsIn(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") {
    if (/^https?:\/\//i.test(v)) out.push(v);
  } else if (Array.isArray(v)) {
    for (const x of v) urlsIn(x, out);
  } else if (v && typeof v === "object") {
    for (const x of Object.values(v)) urlsIn(x, out);
  }
  return out;
}

/**
 * Decide whether a risky call may run without confirmation. Pure-ish (reads the
 * policy + engagement store). `risk` is the tool's declared risk.
 */
export function autoApproveAllowed(
  toolName: string,
  risk: string,
  args: Record<string, unknown>,
  opts: { hasActiveEngagement: boolean; urlAllowed: (u: string) => boolean }
): boolean {
  const p = readPolicy();
  if (!p.autoApprove.includes(toolName)) return false;
  if (!["read", "write"].includes(risk)) return false; // never delete/transaction/external
  const urls = urlsIn(args);
  if (urls.length) {
    if (!opts.hasActiveEngagement) return false;
    return urls.every((u) => opts.urlAllowed(u));
  }
  // No network target (e.g. finding_add, report_generate, hunt_log): local write,
  // safe to auto-run when explicitly listed.
  return true;
}
