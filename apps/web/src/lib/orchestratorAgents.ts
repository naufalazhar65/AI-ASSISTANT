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
import { criterionId, type CriterionProbe, type CriterionProbeResult } from "./recovery";

/** The brief handed to a specialist: scoped context, not the whole chat. */
export function buildTaskBrief(task: OrchestrationTask): string {
  const agent = agentProfile(task.agent_id);
  const lines = [
    `Kamu ${agent?.displayName ?? "agen"} (${agent?.role ?? "worker"}) mengerjakan satu subtugas terdelegasi.`,
    `TASK_ID: ${task.task_id}`,
    `Parent: ${task.parent_task_id ?? "-"}${task.dependencies.length ? ` | dependensi: ${task.dependencies.join(", ")}` : ""}`,
    `OBJEKTIF: ${task.objective}`,
    `KONTEKS ASAL (permintaan induk, BUKAN seluruh tugasanmu): ${task.input_context}`,
    "Kerjakan HANYA OBJEKTIF di atas. Bagian dari konteks induk yang di luar OBJEKTIF ini milik subtugas lain — jangan dikerjakan, jangan dialihkan, dan jangan menjawab 'bukan tugasku'.",

    `OUTPUT YANG DIHARAPKAN: ${task.expected_output}`,
    `KRITERIA SELESAI: ${task.acceptance_criteria.join("; ")}`,
    `BATASAN: ${agent?.restrictions.join("; ") ?? "jalan sesuai kapabilitasmu"}`,
  ];
  // Self-correction: the previous attempt's real failure and the criteria the
  // system could not verify. Both come from records, never from memory.
  if (task.ps_recovery && task.ps_recovery !== "stop") {
    lines.push(
      `PERCOBAAN ULANG (${task.ps_recovery}): ${task.ps_failure ?? "kegagalan"} — ${task.ps_recovery_reason ?? ""}`,
      "Ubah pendekatan sesuai penyebab di atas. Jangan mengulang aksi persis yang sama.",
    );
  }
  if (task.criteria_outcome && task.criteria_outcome !== "COMPLETE") {
    lines.push(
      `VERIFIKASI SEBELUMNYA: ${task.criteria_outcome}. Kriteria yang belum terbukti: ${task.acceptance_criteria
        .map((d) => criterionId(d))
        .join(", ")}`,
    );
  }
  if (task.task_type === "research") {
    lines.push("Riset: jangan mengarang bukti atau sumber. Sebutkan kontradiksi dan ketidakpastian apa adanya.");
  }
  if (task.task_type === "code" || task.task_type === "security") {
    lines.push(
      "Kode: jalankan testnya dan laporkan output apa adanya. Jangan mengklaim lulus tanpa menjalankannya, jangan melemahkan assertion demi hijau, jangan membuang perubahan lain yang tidak terkait.",
    );
  }
  lines.push(
    "Kerjakan hanya subtugas ini. Balas ringkas dengan hasil nyata, sertakan bukti/bukti yang kamu benar-benar eksekusi, dan sebutkan bila ada yang terblokir.",
  );
  lines.push(
    `Format bukti per kriteria: satu baris "KRITERIA <id>: <bukti>" untuk setiap id (${task.acceptance_criteria.map((d) => criterionId(d)).join(", ")}). Kriteria tanpa baris ini dianggap belum terverifikasi.`,
  );
  return lines.join("\n");
}

/**
 * Real tool calls the turn executed, counted from the messages the turn
 * returned. The loop's tool-call budget reads this, so it must be counted, never
 * estimated — a guess would either stop healthy work or overrun the cap.
 */
function countToolCalls(messages: ReadonlyArray<{ role?: string; tool_calls?: unknown }>): number {
  let n = 0;
  for (const m of messages ?? []) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) n += m.tool_calls.length;
  }
  return n;
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
    delegatedSubtask: { objective: task.objective },
  });
  const toolCalls = countToolCalls(res.messages ?? []);

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
      tool_calls: toolCalls,
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
      tool_calls: toolCalls,
      errors: ["jawaban kosong"],
      remaining_uncertainty: ["hasil subtugas tidak bisa dikonfirmasi"],
      next_step: "ulangi subtugas dengan konteks lebih spesifik",
    };
  }
  // Criteria evidence is extracted, not read off the prose: only the explicit
  // `KRITERIA <id>: <bukti>` marker counts, so a summary that merely names the
  // criterion cannot certify itself. Everything else stays the summary/findings.
  const ids = task.acceptance_criteria.map((d) => criterionId(d));
  const marked = (line: string): boolean =>
    ids.some((id) => new RegExp(`^\\s*KRITERIA\\s+${id}\\s*[:\\-—]`, "i").test(line));
  const criteriaLines = text
    .split("\n")
    .filter(marked)
    .map((l) => l.trim());
  const prose = text
    .split("\n")
    .filter((l) => !marked(l))
    .join("\n")
    .trim();
  return {
    task_id: task.task_id,
    agent_id: agentId,
    status: "SUCCEEDED",
    summary: firstLine(prose) || firstLine(text),
    findings: lines(prose),
    evidence_references: [],
    artifact_references: [],
    validations: criteriaLines,
    tool_calls: toolCalls,
    errors: [],
    remaining_uncertainty: [],
    next_step: null,
  };
}

/**
 * VERIFY prober for `tool` criteria. Only read-risk tools may run: a probe is
 * verification, never a side effect.
 */
export const toolProber = async (probe: CriterionProbe): Promise<CriterionProbeResult> => {
  if (probe.kind !== "tool") return { ok: false, detail: "bukan tool probe" };
  const { executeTool, getTool, requiresConfirmation } = await import("./tools");
  const plugin = getTool(probe.name);
  if (!plugin) return { ok: false, detail: `tool tidak dikenal: ${probe.name}` };
  if (requiresConfirmation(plugin.definition)) return { ok: false, detail: `probe menolak tool berisiko: ${probe.name}` };
  try {
    const out = await executeTool({
      id: `probe_${probe.name}`,
      name: probe.name,
      arguments: JSON.stringify(probe.args),
    });
    const failed = /^Error:|^SCOPE —/.test(out);
    return { ok: !failed, detail: out.slice(0, 200) };
  } catch (e) {
    return { ok: false, detail: `probe melempar: ${(e as Error).message.slice(0, 120)}` };
  }
};

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