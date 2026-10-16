/**
 * Persistence for orchestration plans — the authoritative task state that
 * Discord, Telegram, the dashboard and the runtime all read. Atomic per user,
 * capped, and deliberately separate from the personal to-do list (tasks.ts),
 * which is a user-facing checklist, not a workflow.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { userDataRoot } from "./users";
import { sanitizeUser } from "./users";
import type { OrchestrationPlan } from "./orchestration";

const MAX_PLANS = 20;

function planFile(rawUser: unknown): string {
  return join(userDataRoot(), sanitizeUser(rawUser) ?? "shared", "orchestration.json");
}

interface Store {
  plans: OrchestrationPlan[];
}

function readStore(rawUser: unknown): Store {
  const f = planFile(rawUser);
  if (!existsSync(f)) return { plans: [] };
  try {
    const parsed = JSON.parse(readFileSync(f, "utf8")) as Store;
    return { plans: Array.isArray(parsed?.plans) ? parsed.plans : [] };
  } catch {
    return { plans: [] };
  }
}

function writeStore(rawUser: unknown, store: Store): void {
  const f = planFile(rawUser);
  mkdirSync(join(f, ".."), { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  renameSync(tmp, f);
}

/** Newest first, capped. Unknown/corrupt entries are dropped, never trusted. */
export function listPlans(rawUser: unknown, limit = MAX_PLANS): OrchestrationPlan[] {
  return readStore(rawUser).plans.slice(0, limit);
}

export function getPlan(rawUser: unknown, planId: string): OrchestrationPlan | undefined {
  return readStore(rawUser).plans.find((p) => p.id === planId);
}

export function savePlan(plan: OrchestrationPlan): OrchestrationPlan {
  const store = readStore(plan.user);
  const idx = store.plans.findIndex((p) => p.id === plan.id);
  if (idx >= 0) store.plans[idx] = plan;
  else store.plans.unshift(plan);
  store.plans = store.plans.slice(0, MAX_PLANS);
  writeStore(plan.user, store);
  return plan;
}

/**
 * Cancel a plan and every task that has not produced a result yet. Terminal
 * tasks keep their state — a completed subtask must not be erased by a later
 * cancellation.
 */
export function cancelPlan(rawUser: unknown, planId: string): { ok: boolean; plan?: OrchestrationPlan; reason?: string } {
  const plan = getPlan(rawUser, planId);
  if (!plan) return { ok: false, reason: "plan tidak ditemukan" };
  if (plan.status === "DONE" || plan.status === "CANCELLED" || plan.status === "PARTIALLY_COMPLETED") {
    return { ok: false, reason: `plan sudah ${plan.status}`, plan };
  }
  const now = new Date().toISOString();
  plan.tasks = plan.tasks.map((t) =>
    t.status === "SUCCEEDED" || t.status === "FAILED" || t.status === "CANCELLED" || t.status === "PARTIALLY_COMPLETED"
      ? t
      : { ...t, status: "CANCELLED", completed_at: now, error_summary: t.error_summary ?? "dibatalkan oleh user" }
  );
  plan.status = "CANCELLED";
  savePlan(plan);
  return { ok: true, plan };
}