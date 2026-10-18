// WHY probe (2026-10-18): the live drill showed the REAL model never produced a
// `KRITERIA <id>: <bukti>` line, so every orchestrated task degrades to
// PARTIALLY_COMPLETED. This probe isolates WHO drops it: the model, or a
// post-processor inside runAssistantTurn.
//
// Prints, for one real subtask: the brief, res.text, the final assistant message
// from res.messages, and whether either contains a KRITERIA marker.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const envRaw = readFileSync(join(process.cwd(), "apps/web/.env.local"), "utf8");
for (const line of envRaw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const { planFromRequest } = await import("./src/lib/orchestrationPlanner");
const { buildTaskBrief } = await import("./src/lib/orchestratorAgents");
const { runAssistantTurn } = await import("./src/lib/agent");
const { criterionId } = await import("./src/lib/recovery");

const USER = `verify_psattest_${Date.now().toString(36)}`;
const plan = planFromRequest(
  "riset best practice pagination REST API di internet, lalu perbaiki fungsi helper pagination yang masih salah di test terkait",
  { user: USER },
);
const task = plan.tasks.find((t: { task_type: string }) => t.task_type === "research")!;
const brief = buildTaskBrief(task);
console.log("ids:", task.acceptance_criteria.map((d: string) => criterionId(d)).join(", "));
console.log("=== BRIEF TAIL ===\n" + brief.split("\n").slice(-4).join("\n"));

const res = await runAssistantTurn({
  messages: [{ role: "user", content: brief }],
  user: USER,
  channel: "text",
  agent: "agnes",
  autoDenyRisky: true,
});

const lastAssistant = [...(res.messages ?? [])].reverse().find((m: { role?: string }) => m.role === "assistant");
console.log("\n=== res.text (" + (res.text || "").length + " chars) ===");
console.log(res.text);
console.log("\n=== last assistant message (" + String(lastAssistant?.content ?? "").length + " chars) ===");
console.log(String(lastAssistant?.content ?? ""));
console.log("\n=== VERDICT ===");
console.log("res.text has KRITERIA:", /KRITERIA/i.test(res.text || ""));
console.log("lastAssistant has KRITERIA:", /KRITERIA/i.test(String(lastAssistant?.content ?? "")));
console.log("identical text vs message:", (res.text || "") === String(lastAssistant?.content ?? ""));
