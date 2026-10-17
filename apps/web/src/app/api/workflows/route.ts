/**
 * Workflow control plane. Same auth model as every other private route
 * (bearer/cookie via `isAuthorized`); nothing is added to PUBLIC_PREFIXES, and
 * a manual trigger uses the identical execution path as a scheduled run so it
 * cannot bypass authorization.
 */

import { NextResponse } from "next/server";
import { isAuthorized } from "../../../lib/authGuard";
import {
  buildWorkflow,
  deleteWorkflow,
  readExecutions,
  readWorkflow,
  readWorkflows,
  saveWorkflow,
  updateWorkflowProgress,
  workflowSummary,
} from "../../../lib/workflow/store";
import { resolveApproval } from "../../../lib/workflow/engine";
import { dispatchWorkflowRun, runningSlots } from "../../../lib/workflow/worker";
import { slotKey } from "../../../lib/workflow/schedule";
import type { WorkflowDefinition } from "../../../lib/workflow/types";

export const runtime = "nodejs";

function unauthorized(): NextResponse {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

function authed(req: Request): boolean {
  const raw = req.headers.get("authorization") ?? "";
  const bearer = raw.replace(/^Bearer\s+/i, "").trim();
  // `middleware.ts` admits the session cookie, so a logged-in browser passed the
  // edge and was then refused here (401) — the header comment promised bearer
  // AND cookie (audit 2026-10-16).
  const cookie = /(?:^|;\s*)mia_auth=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1]?.trim() ?? null;
  return isAuthorized(cookie, bearer);
}

function shape(wf: WorkflowDefinition) {
  return { ...wf, summary: workflowSummary(wf) };
}

export async function GET(req: Request) {
  if (!authed(req)) return unauthorized();
  const url = new URL(req.url);
  const user = url.searchParams.get("user") ?? req.headers.get("x-mia-user") ?? "";
  const id = url.searchParams.get("id");
  if (id) {
    const wf = readWorkflow(user, id);
    if (!wf) return NextResponse.json({ error: "workflow tidak ditemukan" }, { status: 404 });
    return NextResponse.json({
      workflow: shape(wf),
      executions: readExecutions(user).filter((e) => e.workflow_id === id),
      running: runningSlots().filter((s) => s.startsWith(`${id}-`)),
    });
  }
  // Filter running slots to THIS user's workflows: runningSlots() is
  // process-global, so the list branch leaked other users' workflow ids
  // (audit 2026-10-16).
  const mine = new Set(readWorkflows(user).map((w) => w.workflow_id));
  const mineSlots = runningSlots().filter((s) => [...mine].some((id) => s.startsWith(`${id}-`)));
  return NextResponse.json({ workflows: readWorkflows(user).map(shape), running: mineSlots });
}

export async function POST(req: Request) {
  if (!authed(req)) return unauthorized();
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const user = String(body.user ?? req.headers.get("x-mia-user") ?? "");
  const action = String(body.action ?? "");

  try {
    if (action === "add") {
      const wf = buildWorkflow(user, body.workflow as never);
      saveWorkflow(user, wf);
      return NextResponse.json({ workflow: shape(wf) }, { status: 201 });
    }
    if (action === "delete") {
      const ok = deleteWorkflow(user, String(body.id ?? ""));
      if (!ok) return NextResponse.json({ error: "workflow tidak ditemukan" }, { status: 404 });
      return NextResponse.json({ deleted: String(body.id) });
    }
    if (action === "pause" || action === "resume") {
      const wf = updateWorkflowProgress(user, String(body.id ?? ""), { paused: action === "pause" });
      if (!wf) return NextResponse.json({ error: "workflow tidak ditemukan" }, { status: 404 });
      return NextResponse.json({ workflow: shape(wf) });
    }
    if (action === "run_now") {
      const wf = readWorkflow(user, String(body.id ?? ""));
      if (!wf) return NextResponse.json({ error: "workflow tidak ditemukan" }, { status: 404 });
      const sk = slotKey(wf.workflow_id, Date.now());
      if (wf.concurrency_policy !== "ALLOW_PARALLEL" && runningSlots().some((s) => s.startsWith(`${wf.workflow_id}-`)))
        return NextResponse.json({ error: "workflow sedang berjalan (kebijakan concurrency aktif)" }, { status: 409 });
      const exec = await dispatchWorkflowRun(user, wf, sk, Date.now());
      return NextResponse.json({ execution: exec }, { status: 201 });
    }
    if (action === "cancel") {
      const wf = readWorkflow(user, String(body.id ?? ""));
      if (!wf) return NextResponse.json({ error: "workflow tidak ditemukan" }, { status: 404 });
      const open = readExecutions(user).find((e) => e.workflow_id === wf.workflow_id && e.status === "RUNNING");
      if (!open) return NextResponse.json({ error: "tidak ada eksekusi yang sedang berjalan" }, { status: 409 });
      const { saveExecution } = await import("../../../lib/workflow/store");
      const cancelled = { ...open, status: "CANCELLED" as const, finished_at: new Date().toISOString(), error_summary: "dibatalkan manual" };
      saveExecution(user, cancelled);
      return NextResponse.json({ execution: cancelled });
    }
    if (action === "approve") {
      // Explicit allow only — a missing/zero-ish `allow` used to count as
      // approval (audit 2026-10-16). `by` is bounded to a safe label so an
      // audit line cannot attribute an approval to an arbitrary identity.
      if (body.allow !== true)
        return NextResponse.json({ error: "allow harus true atau false secara eksplisit" }, { status: 400 });
      const by = String(body.by ?? "api").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40) || "api";
      const exec = await resolveApproval(user, String(body.execution_id ?? ""), true, by);
      return NextResponse.json({ execution: exec });
    }
    return NextResponse.json({ error: `action tidak dikenal: ${action}` }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
