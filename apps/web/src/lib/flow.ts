// Flow runner — run a named sequence of HTTP steps with variable extraction and
// assertions. This is how multi-request bugs get exercised/proven: login → grab
// an id → hit another object → assert the response, or replay a business-logic
// sequence. Scope-gated per step; secrets stay in saved http_sessions.
//
// Per-user store: .data/users/<user>/flows.json.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";
import { targetAllowed } from "./security";
import { sessionHeaders } from "./httpSession";

export type FlowStep = {
  name?: string;
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  session?: string;
  expect_status?: number;
  expect_contains?: string;
  /** capture vars: { varName: "json.a.b.0" | "regex:<pattern>" } */
  extract?: Record<string, string>;
};
export type Flow = { name?: string; vars?: Record<string, string>; steps: FlowStep[] };

const MAX_STEPS = 25;
const CAP = 2000;

/** Replace `{{var}}` occurrences. Pure — unit-tested. */
export function substitute(input: string, vars: Record<string, string>): string {
  return (input || "").replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, k: string) => (k in vars ? vars[k] : `{{${k}}}`));
}

/** Read a dot/bracket path from a JSON value ("data.items.0.id"). Pure — tested. */
export function getPath(obj: unknown, path: string): string | undefined {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  if (cur === undefined || cur === null) return undefined;
  return typeof cur === "string" ? cur : JSON.stringify(cur);
}

function storeFile(rawUser: unknown): string | null {
  const u = sanitizeUser(rawUser);
  return u ? join(userDataRoot(), u, "flows.json") : null;
}
export function listFlows(rawUser: unknown): Record<string, Flow> {
  const f = storeFile(rawUser);
  if (!f || !existsSync(f)) return {};
  try {
    const j = JSON.parse(readFileSync(f, "utf8")) as unknown;
    return j && typeof j === "object" ? (j as Record<string, Flow>) : {};
  } catch {
    return {};
  }
}
export function saveFlow(rawUser: unknown, name: string, flow: Flow): void {
  const f = storeFile(rawUser);
  if (!f) return;
  const all = listFlows(rawUser);
  all[name.slice(0, 60)] = { ...flow, name };
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2));
  renameSync(tmp, f);
}

export function flowListText(rawUser: unknown): string {
  const all = listFlows(rawUser);
  const names = Object.keys(all);
  if (!names.length) return "Belum ada flow tersimpan. Jalankan flow_run dengan `save=<nama>`.";
  return `🧩 Flows (${names.length}):\n${names.map((n) => `• ${n} — ${all[n].steps.length} langkah`).join("\n")}`;
}

async function runStep(rawUser: unknown, step: FlowStep, vars: Record<string, string>): Promise<{ status: number; body: string; digest: string; ms: number; error?: string }> {
  const method = (step.method || "GET").toUpperCase();
  const url = substitute(step.url, vars);
  const headers: Record<string, string> = { "User-Agent": "mia-assistant/1.0" };
  for (const [k, v] of Object.entries(step.headers || {})) headers[k] = substitute(v, vars);
  if (step.session) {
    const s = sessionHeaders(rawUser, step.session);
    if (!s) return { status: 0, body: "", digest: "", ms: 0, error: `session "${step.session}" tidak ada` };
    Object.assign(headers, s.headers);
    if (s.cookie && !Object.keys(headers).some((k) => k.toLowerCase() === "cookie")) headers["cookie"] = s.cookie;
  }
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : substitute(step.body || "", vars),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.text();
    return { status: res.status, body, digest: createHash("sha256").update(body).digest("hex").slice(0, 12), ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, body: "", digest: "", ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Run a flow (inline steps or `name` from the store). Scope-gated per step. */
export async function flowRun(rawUser: unknown, opts: { flow?: Flow; name?: string; vars?: Record<string, string>; save?: string }): Promise<string> {
  let flow = opts.flow;
  if (!flow && opts.name) {
    flow = listFlows(rawUser)[opts.name];
    if (!flow) return `Error: flow "${opts.name}" tidak ada. ${flowListText(rawUser)}`;
  }
  if (!flow || !Array.isArray(flow.steps) || !flow.steps.length) return "Error: flow wajib punya `steps` (array).";
  if (flow.steps.length > MAX_STEPS) return `Error: terlalu banyak langkah (maks ${MAX_STEPS}).`;
  const vars: Record<string, string> = { ...(flow.vars || {}), ...(opts.vars || {}) };

  const lines: string[] = [`🧩 FLOW ${flow.name || "(inline)"} — ${flow.steps.length} langkah`];
  let failed = -1;
  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i];
    const url = substitute(step.url, vars);
    const label = step.name || `#${i + 1}`;
    if (!/^https?:\/\//i.test(url)) {
      lines.push(`✗ ${label}: url tidak valid (${url})`);
      failed = i;
      break;
    }
    if (!targetAllowed(url)) {
      lines.push(`✗ ${label}: SCOPE — ${url} bukan lab/engagement aktif`);
      failed = i;
      break;
    }
    const r = await runStep(rawUser, step, vars);
    const tag = r.error ? `ERROR ${r.error}` : `${r.status}`;
    if (step.expect_status !== undefined && r.status !== step.expect_status) {
      lines.push(`✓ ${label}: ${tag} — expect_status ${step.expect_status} GAGAL ✗`);
      failed = i;
      break;
    }
    if (step.expect_contains && !r.body.includes(step.expect_contains)) {
      lines.push(`✓ ${label}: ${tag} — expect_contains "${step.expect_contains}" GAGAL ✗`);
      failed = i;
      break;
    }
    // extracts
    const got: string[] = [];
    for (const [varName, spec] of Object.entries(step.extract || {})) {
      let val: string | undefined;
      if (spec.startsWith("regex:")) {
        const m = r.body.match(new RegExp(spec.slice(6)));
        val = m?.[1] ?? m?.[0];
      } else {
        try {
          val = getPath(JSON.parse(r.body), spec);
        } catch {
          val = undefined;
        }
      }
      if (val !== undefined) {
        vars[varName] = val;
        got.push(`${varName}=${val.slice(0, 40)}`);
      } else {
        got.push(`${varName}=?`);
      }
    }
    lines.push(`✓ ${label}: ${tag} (${r.ms}ms, ${r.body.length}b)${got.length ? ` · ${got.join(" ")}` : ""}`);
    if (r.error) {
      failed = i;
      break;
    }
    await new Promise((res) => setTimeout(res, 120));
  }

  if (opts.save && flow.steps.length) {
    saveFlow(rawUser, opts.save, { name: opts.save, vars: flow.vars || {}, steps: flow.steps });
    lines.push(`\n💾 disimpan sebagai "${opts.save}"`);
  }
  lines.push(failed >= 0 ? `\n❌ Flow GAGAL di langkah ${failed + 1} — bukan bukti (perbaiki/cek kontrol).` : `\n✅ Flow SELESAI — semua langkah sesuai ekspektasi (bukti deterministik).`);
  return lines.join("\n");
}
