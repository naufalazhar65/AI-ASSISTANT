/**
 * Binding between orchestration tasks and the real agent runtime.
 *
 * Kept in its own module so `agent.ts` can import the orchestrator without a
 * cycle: `runAssistantTurn` is pulled in dynamically, at call time.
 *
 * Authorization: a delegated subtask never decides its own permissions. Risky
 * tools are auto-denied here (`autoDenyRisky`), exactly like an automation or
 * webhook turn — delegation must not become a way around the approval system.
 * When that blocks the work, the task reports the blocker instead of claiming
 * success, and Mia's own turn keeps the normal approval flow.
 */

import type { AgentLabel } from "./agentRouting";
import type { AgentResult, OrchestrationPlan, OrchestrationTask } from "./orchestration";
import { agentProfile } from "./agentRegistry";

/** The brief handed to a specialist: scoped context, not the whole chat. */
export function buildTaskBrief(task: OrchestrationTask): string {
  const agent = agentProfile(task.agent_id);
  return [
    `Kamu ${agent?.displayName ?? "agen"} (${agent?.role ?? "worker"}) mengerjakan satu subtugas terdelegasi.`,
    `TASK_ID: ${task.task_id}`,
    `Parent: ${task.parent_task_id ?? "-"}${task.dependencies.length ? ` | dependensi: ${task.dependencies.join(", ")}` : ""}`,
    `OBJEKTIF: ${task.objective}`,
    `KONTEKS ASAL: ${task.input_context}`,
    `OUTPUT YANG DIHARAPKAN: ${task.expected_output}`,
    `KRITERIA SELESAI: ${task.acceptance_criteria.join("; ")}`,
    `BATASAN: ${agent?.restrictions.join("; ") ?? "jalan sesuai kapabilitasmu"}`,
    "Kerjakan hanya subtugas ini. Balas ringkas dengan hasil nyata, sertakan bukti/bukti yang kamu benar-benar eksekusi, dan sebutkan bila ada yang terblokir.",
  ].join("\n");
}

/** Turn a real turn into a structured AgentResult — no free-form hand-off. */
export async function runSubtaskViaAgent(task: OrchestrationTask, plan: OrchestrationPlan): Promise<AgentResult> {
  const agentId = (task.agent_id ?? "mia") as AgentLabel;
  const { runAssistantTurn } = await import("./agent");
  const res = await runAssistantTurn({
    messages: [{ role: "user", content: buildTaskBrief(task) }],
    user: plan.user,
    channel: "text",
    agent: agentId,
    autoDenyRisky: true,
  });

  const pending = res.needsConfirmation ?? [];
  if (pending.length > 0) {
    return {
      task_id: task.task_id,
      agent_id: agentId,
      status: "FAILED",
      summary: `terblokir: ${pending.length} aksi berisiko butuh persetujuan owner`,
      findings: [],
      evidence_references: [],
      artifact_references: [],
      validations: [],
      errors: pending.map((c) => `butuh persetujuan: ${c.name}`),
      remaining_uncertainty: ["subtugas butuh approval eksplisit dari owner"],
      next_step: "Minta owner menyetujui aksi tersebut di percakapan utama",
    };
  }

  const text = (res.text || "").trim();
  if (!text) {
    return {
      task_id: task.task_id,
      agent_id: agentId,
      status: "FAILED",
      summary: "tidak ada hasil yang bisa diverifikasi",
      findings: [],
      evidence_references: [],
      artifact_references: [],
      validations: [],
      errors: ["jawaban kosong"],
      remaining_uncertainty: ["hasil subtugas tidak bisa dikonfirmasi"],
      next_step: "ulangi subtugas dengan konteks lebih spesifik",
    };
  }
  return {
    task_id: task.task_id,
    agent_id: agentId,
    status: "SUCCEEDED",
    summary: firstLine(text),
    findings: lines(text),
    evidence_references: [],
    artifact_references: [],
    validations: [],
    errors: [],
    remaining_uncertainty: [],
    next_step: null,
  };
}

function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim().length > 0)?.trim().slice(0, 300) ?? "";
}

function lines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 4)
    .slice(0, 12);
}