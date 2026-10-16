/**
 * Orchestration status API — the dashboard and the user read the SAME task
 * state the engine writes (orchestrationStore), never a second implementation.
 *
 * Auth is the project's standard guard (isAuthorized): the middleware already
 * protects /api/* and AUTH_TOKEN-empty means auth is OFF by default. We do not
 * widen PUBLIC_PREFIXES — a new orchestration route must stay behind whatever
 * the owner already chose.
 *
 * Cancellation is the only write path, and it goes through cancelPlan so the
 * engine's own rules apply (finished subtasks keep their result, only
 * un-finished work is cancelled).
 */

import { NextResponse } from "next/server";
import { isAuthorized } from "../../../lib/authGuard";
import { cancelPlan, getPlan, listPlans } from "../../../lib/orchestrationStore";
import { progressLine, reconcile } from "../../../lib/orchestration";
import type { OrchestrationPlan } from "../../../lib/orchestration";

export const runtime = "nodejs";

function authorized(req: Request): boolean {
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const cookie = /mia_auth=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1] ?? "";
  return isAuthorized(cookie, bearer);
}

function shape(plan: OrchestrationPlan) {
  const r = reconcile(plan);
  return {
    plan,
    reconciliation: r,
    progress: progressLine(plan),
    // Per-task view for UIs that need rows rather than prose.
    tasks: plan.tasks.map((t) => ({
      task_id: t.task_id,
      agent_id: t.agent_id,
      objective: t.objective,
      task_type: t.task_type,
      status: t.status,
      required: t.required,
      dependencies: t.dependencies,
      attempts: t.attempts,
      result_reference: t.result_reference,
      evidence_references: t.evidence_references,
      error_summary: t.error_summary,
      started_at: t.started_at,
      completed_at: t.completed_at,
    })),
  };
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const user = url.searchParams.get("user") ?? "";
  const id = url.searchParams.get("id");
  if (!user) return NextResponse.json({ error: "user required" }, { status: 400 });

  if (id) {
    const plan = getPlan(user, id);
    if (!plan) return NextResponse.json({ error: "plan tidak ditemukan" }, { status: 404 });
    return NextResponse.json(shape(plan));
  }
  return NextResponse.json({ plans: listPlans(user).map((p) => shape(p)) });
}

/** Cancellation only. No client value may set a trusted status directly. */
export async function POST(req: Request): Promise<NextResponse> {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: { user?: string; id?: string; action?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "body tidak valid" }, { status: 400 });
  }
  if (body.action && body.action !== "cancel") {
    return NextResponse.json({ error: `action "${body.action}" tidak didukung` }, { status: 400 });
  }
  if (!body.user || !body.id) return NextResponse.json({ error: "user dan id wajib diisi" }, { status: 400 });
  const res = cancelPlan(body.user, body.id);
  // `plan` is returned on refusal too (already DONE/CANCELLED), so the caller
  // can still see the real state instead of an empty error.
  if (!res.ok && !res.plan) return NextResponse.json({ error: res.reason }, { status: 409 });
  return NextResponse.json({ ...shape(res.plan as OrchestrationPlan), error: res.ok ? undefined : res.reason });
}