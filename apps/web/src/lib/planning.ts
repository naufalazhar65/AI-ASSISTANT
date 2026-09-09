// Planning — Mia's internal todo/planning for multi-step work (P0 Brain.Planning).
// Different from tasks.ts (user-facing task list). A plan is Mia's own breakdown
// of a complex request: title + steps with status. Persisted per-user at
// .data/users/<user>/plans/<id>.json, so it survives restarts and can be
// inspected via tools. No LLM call, deterministic, works offline.

import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";

export type PlanStepStatus = "pending" | "in_progress" | "completed" | "cancelled";
export interface PlanStep {
  id: string;
  title: string;
  status: PlanStepStatus;
  notes?: string;
}
export interface Plan {
  id: string;
  title: string;
  goal: string;
  status: "active" | "done" | "archived";
  steps: PlanStep[];
  createdAt: number;
  updatedAt: number;
}

const MAX_PLANS = 20;
const MAX_STEPS = 30;

function plansDir(userKey: string): string {
  return join(userDataRoot(), userKey, "plans");
}
function planPath(userKey: string, id: string): string {
  return join(plansDir(userKey), `${id}.json`);
}

function listPlanFiles(userKey: string): string[] {
  try {
    return readdirSync(plansDir(userKey)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

export function readPlans(rawUser?: unknown): Plan[] {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return [];
  const out: Plan[] = [];
  for (const f of listPlanFiles(userKey)) {
    try {
      const raw = readFileSync(join(plansDir(userKey), f), "utf8");
      const p = JSON.parse(raw) as Plan;
      if (p && typeof p.id === "string" && Array.isArray(p.steps)) out.push(p);
    } catch { /* ignore corrupt */ }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function readPlan(rawUser: unknown, id: string): Plan | null {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return null;
  try {
    const raw = readFileSync(planPath(userKey, id), "utf8");
    const p = JSON.parse(raw) as Plan;
    if (!p || typeof p.id !== "string") return null;
    return p;
  } catch {
    return null;
  }
}

function writePlan(plan: Plan, userKey: string): void {
  const file = planPath(userKey, plan.id);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  plan.updatedAt = Date.now();
  writeFileSync(tmp, JSON.stringify(plan, null, 2));
  renameSync(tmp, file);
}

export function createPlan(title: string, goal: string, rawUser?: unknown): Plan {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) throw new Error("invalid user");
  const t = title.trim().slice(0, 120);
  if (!t) throw new Error("title required");
  const g = goal.trim().slice(0, 500);
  const now = Date.now();
  const plan: Plan = {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    title: t,
    goal: g || t,
    status: "active",
    steps: [],
    createdAt: now,
    updatedAt: now,
  };
  // prune oldest if over limit
  const existing = readPlans(rawUser);
  if (existing.length >= MAX_PLANS) {
    const oldest = existing.sort((a, b) => a.createdAt - b.createdAt)[0];
    try { require("node:fs").unlinkSync(planPath(userKey, oldest.id)); } catch {}
  }
  writePlan(plan, userKey);
  return plan;
}

export function addPlanStep(planId: string, stepTitle: string, rawUser?: unknown): PlanStep {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) throw new Error("invalid user");
  const plan = readPlan(rawUser, planId);
  if (!plan) throw new Error(`plan ${planId} not found`);
  if (plan.steps.length >= MAX_STEPS) throw new Error("too many steps");
  const title = stepTitle.trim().slice(0, 200);
  if (!title) throw new Error("step title required");
  const step: PlanStep = { id: `s${Date.now().toString(36)}`, title, status: "pending" };
  plan.steps.push(step);
  writePlan(plan, userKey);
  return step;
}

export function updatePlanStep(planId: string, stepId: string, status: PlanStepStatus, rawUser?: unknown, notes?: string): PlanStep {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) throw new Error("invalid user");
  const plan = readPlan(rawUser, planId);
  if (!plan) throw new Error(`plan ${planId} not found`);
  const idx = plan.steps.findIndex((s) => s.id === stepId);
  if (idx < 0) throw new Error(`step ${stepId} not found`);
  plan.steps[idx] = { ...plan.steps[idx], status, ...(notes ? { notes: notes.slice(0, 500) } : {}) };
  // auto-complete plan when all steps done
  if (plan.steps.every((s) => s.status === "completed" || s.status === "cancelled")) plan.status = "done";
  else plan.status = "active";
  writePlan(plan, userKey);
  return plan.steps[idx];
}

export function listPlansText(rawUser?: unknown): string {
  const plans = readPlans(rawUser);
  if (!plans.length) return "Belum ada plan beb — mau bikin plan baru? 🌸";
  const lines = [`Daftar plan kamu beb — ${plans.length} plan 🌸`];
  for (const p of plans.slice(0, 10)) {
    const done = p.steps.filter((s) => s.status === "completed").length;
    lines.push(`• ${p.id} — "${p.title}" [${p.status}] ${done}/${p.steps.length} steps — ${p.goal.slice(0, 80)}`);
  }
  return lines.join("\n").slice(0, 4000);
}

export function planToText(plan: Plan): string {
  const steps = plan.steps.map((s, i) => `  ${i + 1}. [${s.status}] ${s.title}${s.notes ? ` — ${s.notes}` : ""}`).join("\n");
  return `Plan "${plan.title}" (${plan.id}) [${plan.status}]\nGoal: ${plan.goal}\nSteps:\n${steps || "  (belum ada step)"}`.slice(0, 4000);
}
