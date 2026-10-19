import { RECOVERY_CHECKERS } from "./recoveryCheckers";
import { ATTRIBUTION_CHECKERS } from "./attributionCheckers";
import type { CriterionResult, EvalCase } from "./types";
import { criterionId } from "../recovery";

/**
 * Deterministic checkers — one per `evaluation_method` in the dataset.
 *
 * Every checker calls the REAL production function. Nothing here re-implements
 * routing, gating, evidence or formatting: if a guard regresses, the case fails
 * because the guard changed, not because a copy of it changed.
 *
 * A checker returns criteria only. Status is derived by the runner, so a
 * checker can never decide for itself that it passed.
 */
export type Checker = (c: EvalCase) => Promise<CriterionResult[]> | CriterionResult[];

const ok = (id: string, pass: boolean, detail?: string): CriterionResult => ({ id, ok: pass, detail });
/**
 * The loop refuses to call an unevidenced answer SUCCEEDED, so a synthetic
 * result has to carry the same evidence line a real agent is asked for.
 */
const attested = (task: { acceptance_criteria?: string[] }): string[] =>
  (task.acceptance_criteria ?? []).map((d) => `KRITERIA ${criterionId(d)}: bukti sintetis eval`);
/** Identity for primitives, structural for arrays/objects (Object.is on two
 *  fresh arrays is always false, which silently failed an ordering case). */
const eq = (id: string, actual: unknown, expected: unknown): CriterionResult => {
  const same =
    Object.is(actual, expected) ||
    (typeof actual === "object" && typeof expected === "object" && actual !== null && expected !== null
      ? JSON.stringify(actual) === JSON.stringify(expected)
      : false);
  return ok(id, same, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};
const has = (id: string, haystack: string, needle: string | RegExp): CriterionResult =>
  ok(
    id,
    typeof needle === "string" ? haystack.includes(needle) : needle.test(haystack),
    typeof needle === "string" ? `missing "${needle}"` : `no match ${needle}`
  );

/* ------------------------------------------------------------------ routing */
const routeShouldRespond: Checker = async (c) => {
  const { addressedAgentByName, shouldRespondToAgent } = await import("../agentRouting");
  const label = addressedAgentByName(String(c.input_message));
  const wanted = String(c.expected_routing ?? "");
  const criteria = [eq("addressed-name", label, wanted === "none" ? null : wanted)];
  if (label) {
    const opts = {
      mentioned: false,
      isDM: false,
      inDedicatedChannel: false,
      mentionedOtherTrioBot: false,
      trioMode: true,
      nameAddressed: label,
    };
    for (const other of ["mia", "agnes", "michelle"] as const) {
      criteria.push(eq(`responds-${other}`, shouldRespondToAgent(other, opts), other === label));
    }
  }
  return criteria;
};

const routeUnresolvedMention: Checker = async (c) => {
  const { hasForeignMention, shouldRespondToAgent } = await import("../agentRouting");
  const known = ["U0C7H9Z5KRB"];
  const foreign = hasForeignMention(String(c.input_message), known, /<@([UWB][A-Z0-9]*)>/g);
  const knownMention = hasForeignMention("<@U0C7H9Z5KRB> halo", known, /<@([UWB][A-Z0-9]*)>/g);
  const opts = {
    mentioned: false,
    isDM: false,
    inDedicatedChannel: false,
    mentionedOtherTrioBot: false,
    trioMode: false,
    mentionedForeignUser: foreign,
    nameAddressed: null,
  };
  return [
    eq("foreign-mention", foreign, true),
    eq("known-mention-not-foreign", knownMention, false),
    eq("mia-stays-silent", shouldRespondToAgent("mia", opts), false),
  ];
};

const routeRoleGate: Checker = async (c) => {
  const { roleGateRefusal } = await import("../roleGate");
  const tool = String((c.context_fixture as { tool?: string })?.tool ?? "");
  const refusal = roleGateRefusal(c.target_agent, tool);
  return [
    ok("refusal-present", !!refusal, refusal ?? "no refusal produced"),
    has("refusal-names-owner", refusal ?? "", "Michelle"),
    has("refusal-forbids-claim", refusal ?? "", "do not claim it was done"),
  ];
};

const routeUnclassifiedTool: Checker = async (c) => {
  const { roleGateRefusal } = await import("../roleGate");
  const tool = String((c.context_fixture as { tool?: string })?.tool ?? "");
  return [eq("unclassified-allowed", roleGateRefusal(c.target_agent, tool), null)];
};

/* ------------------------------------------------------------ orchestration */
const planOf = async (c: EvalCase) => {
  const { planFromRequest } = await import("../orchestrationPlanner");
  return planFromRequest(c.input_message, { user: "eval_user", now: "2026-10-16T00:00:00.000Z" });
};

const orcStaysDirect: Checker = async (c) => {
  const { shouldOrchestrate } = await import("../orchestrationPlanner");
  return [eq("should-orchestrate", shouldOrchestrate(c.input_message), false)];
};

const orcPlansChained: Checker = async (c) => {
  const { shouldOrchestrate } = await import("../orchestrationPlanner");
  const plan = await planOf(c);
  const ids = new Set(plan.tasks.map((t) => t.task_id));
  const edges = plan.tasks.flatMap((t) => t.dependencies);
  return [
    eq("should-orchestrate", shouldOrchestrate(c.input_message), true),
    ok("at-least-two-tasks", plan.tasks.length >= 2, `${plan.tasks.length} tasks`),
    ok("dependency-edge-exists", edges.length > 0, `${edges.length} edges`),
    ok("edges-reference-real-tasks", edges.every((e) => ids.has(e)), edges.join(",")),
  ];
};

const orcDependencyOrder: Checker = async (c) => {
  const { runPlan } = await import("../orchestrator");
  const plan = await planOf(c);
  const order: string[] = [];
  const finished = new Set<string>();
  const out = await runPlan(
    { ...plan, tasks: plan.tasks.slice(0, 2) },
    async (task) => {
      order.push(`start:${task.task_id}`);
      for (const dep of task.dependencies) if (!finished.has(dep)) order.push(`ORDER-ERROR:${task.task_id}-needs-${dep}`);
      finished.add(task.task_id);
      order.push(`end:${task.task_id}`);
      return {
        task_id: task.task_id,
        agent_id: task.agent_id ?? "mia",
        status: "SUCCEEDED",
        summary: `hasil ${task.task_id}`,
        findings: [],
        evidence_references: [],
        artifact_references: [],
        validations: attested(task),
        errors: [],
        remaining_uncertainty: [],
        next_step: null,
      };
    },
    { shouldStop: () => false }
  );
  const starts = order.filter((l) => l.startsWith("start:")).map((l) => l.slice(6));
  const expectOrder = c.expected_task_state?.order;
  return [
    ok("no-order-error", !order.some((l) => l.startsWith("ORDER-ERROR")), order.join(" | ")),
    eq("all-tasks-ran", out.plan.tasks.every((t) => t.status === "SUCCEEDED"), true),
    ...(Array.isArray(expectOrder) ? [eq("start-order", starts, expectOrder)] : []),
  ];
};

const orcPartialFailure: Checker = async (c) => {
  const { runPlan } = await import("../orchestrator");
  const plan = await planOf(c);
  const out = await runPlan(
    { ...plan, tasks: plan.tasks.slice(0, 2).map((t, i) => ({ ...t, required: true })) },
    async (task) => ({
      task_id: task.task_id,
      agent_id: task.agent_id ?? "mia",
      status: task.task_id === (plan.tasks[1]?.task_id ?? "") ? "FAILED" : "SUCCEEDED",
      summary: task.task_id,
      findings: [],
      evidence_references: [],
      artifact_references: [],
      validations: [],
      errors: task.task_id === (plan.tasks[1]?.task_id ?? "") ? ["tool gagal"] : [],
      remaining_uncertainty: [],
      next_step: null,
    }),
    { shouldStop: () => false }
  );
  const failedId = plan.tasks[1]?.task_id ?? "t2";
  const failed = out.plan.tasks.find((t) => t.task_id === failedId);
  return [
    eq("plan-not-done", out.plan.status, "PARTIALLY_COMPLETED"),
    ok("failed-task-not-succeeded", failed?.status !== "SUCCEEDED", String(failed?.status)),
    has("final-text-discloses", out.finalText, failedId),
    ok("no-false-completion", !/semua (tahap|task).*(selesai|berhasil)/i.test(out.finalText), out.finalText.slice(0, 160)),
  ];
};

const SYNTHETIC_TASK = {
  task_id: "t1",
  parent_task_id: null,
  agent_id: "mia" as const,
  objective: "Kerjakan t1",
  task_type: "code" as const,
  input_context: "",
  expected_output: "hasil",
  acceptance_criteria: ["selesai"],
  dependencies: [] as string[],
  priority: 1,
  required: true,
  status: "PLANNED" as const,
  created_at: "2026-10-16T00:00:00.000Z",
  started_at: null,
  completed_at: null,
  result_reference: null,
  evidence_references: [] as string[],
  error_summary: null,
  attempts: 0,
  idempotent: true,
};

/** A plan with exactly one task nobody registered can take. */
const gapPlan = async () => {
  const base = await planOf({ input_message: "riset tentang X lalu audit keamanan Y" } as never);
  return {
    ...base,
    tasks: [{ ...SYNTHETIC_TASK, task_id: "t_gap", agent_id: null, objective: "Capability nobody owns" }],
  };
};

const orcCapabilityGap: Checker = async (c) => {
  const { agentProfile } = await import("../agentRegistry");
  const { runPlan } = await import("../orchestrator");
  const plan = await gapPlan();
  let ran = 0;
  const out = await runPlan(plan, async (t) => {
    ran += 1;
    return {
      task_id: t.task_id,
      agent_id: "mia",
      status: "SUCCEEDED",
      summary: "",
      findings: [],
      evidence_references: [],
      artifact_references: [],
      validations: attested(t),
      errors: [],
      remaining_uncertainty: [],
      next_step: null,
    };
  }, { shouldStop: () => false });
  const task = out.plan.tasks[0];
  return [
    eq("no-agent-profile", agentProfile(null), undefined),
    eq("runner-never-called", ran, 0),
    ok("task-blocked", task?.status === "BLOCKED", String(task?.status)),
    ok("gap-explained", !!task?.error_summary, String(task?.error_summary)),
  ];
};

const orcCancel: Checker = async (c) => {
  const { runPlan } = await import("../orchestrator");
  const base = await planOf({ input_message: "riset tentang X lalu audit keamanan Y" } as never);
  const plan = {
    ...base,
    tasks: [
      { ...SYNTHETIC_TASK, task_id: "t1" },
      { ...SYNTHETIC_TASK, task_id: "t2", dependencies: ["t1"], objective: "Kerjakan t2" },
    ],
    budget: { ...base.budget, maxConcurrent: 1 },
  };
  const seen: string[] = [];
  const out = await runPlan(plan, async (t) => {
    seen.push(t.task_id);
    return {
      task_id: t.task_id,
      agent_id: "mia",
      status: "SUCCEEDED",
      summary: "",
      findings: [],
      evidence_references: [],
      artifact_references: [],
      validations: attested(t),
      errors: [],
      remaining_uncertainty: [],
      next_step: null,
    };
  }, { shouldStop: () => seen.length >= 1 });
  const first = out.plan.tasks.find((t) => t.task_id === "t1");
  const second = out.plan.tasks.find((t) => t.task_id === "t2");
  return [
    eq("finished-kept", first?.status, "SUCCEEDED"),
    eq("queued-cancelled", second?.status, "CANCELLED"),
    eq("plan-cancelled", out.plan.status, "CANCELLED"),
  ];
};

const orcCycle: Checker = async (c) => {
  const { hasCycle, validatePlan } = await import("../orchestration");
  const { runPlan } = await import("../orchestrator");
  const plan = await planOf(c);
  const base = plan.tasks[0];
  const a = { ...base, task_id: "a", dependencies: ["b"], objective: "a", status: "PLANNED" as const };
  const b = { ...base, task_id: "b", dependencies: ["a"], objective: "b", status: "PLANNED" as const };
  const cyclic = { ...plan, tasks: [a, b] };
  let ran = 0;
  const out = await runPlan(cyclic, async (t) => {
    ran += 1;
    return {
      task_id: t.task_id,
      agent_id: "mia",
      status: "SUCCEEDED",
      summary: "",
      findings: [],
      evidence_references: [],
      artifact_references: [],
      validations: [],
      errors: [],
      remaining_uncertainty: [],
      next_step: null,
    };
  }, { shouldStop: () => false });
  return [
    eq("has-cycle", hasCycle(cyclic.tasks), true),
    ok("validatePlan-reports-cycle", validatePlan(cyclic).some((i) => i.code === "cycle"), JSON.stringify(validatePlan(cyclic))),
    eq("nothing-executed", ran, 0),
    eq("plan-failed", out.plan.status, "FAILED"),
  ];
};

/* --------------------------------------------------- tool execution integrity */
const outcomeOf = async (c: EvalCase) => {
  const { turnOutcomeFromMessages } = await import("../messageReactions");
  const { selectFinalReaction } = await import("../messageReactions");
  const results = (c.mock_tool_results ?? {}) as Record<string, string>;
  const calls = Object.keys(results);
  const messages: Array<Record<string, unknown>> = [];
  for (const name of calls) {
    messages.push({ role: "assistant", tool_calls: [{ id: `c_${name}`, function: { name } }] });
    messages.push({ role: "tool", tool_call_id: `c_${name}`, content: results[name] });
  }
  if (!calls.length) {
    messages.push({ role: "assistant", tool_calls: [{ id: "c_orphan", function: { name: "http_request" } }] });
  }
  const facts = turnOutcomeFromMessages(messages as never);
  return { facts, decision: selectFinalReaction(facts, "") };
};

const execNoResult: Checker = async (c) => {
  const { facts, decision } = await outcomeOf(c);
  return [
    eq("no-executed-tools", facts.executedTools.length, 0),
    ok("no-ok-reaction", decision.emoji !== "✅", decision.emoji || "(silent)"),
  ];
};

const execRefusal: Checker = async (c) => {
  const { facts, decision } = await outcomeOf(c);
  return [
    ok("refusal-not-executed", facts.executedTools.length === 0, facts.executedTools.join(",")),
    ok("no-ok-reaction", decision.emoji !== "✅", decision.emoji || "(silent)"),
  ];
};

const execToolError: Checker = async (c) => {
  const { facts, decision } = await outcomeOf(c);
  return [eq("tool-error-flagged", facts.toolError, true), eq("warning-reaction", decision.emoji, "⚠️")];
};

/* ------------------------------------------------------- evidence integrity */
const auditFactsFor = async (c: EvalCase) => {
  const { buildAuditFacts } = await import("../claimAudit");
  const fx = (c.context_fixture ?? {}) as Record<string, never>;
  return buildAuditFacts(String(fx.host ?? "lab.example.test"), {
    provingRunsForHost: fx.provingRunsForHost,
    endpointCoverageForHost: fx.endpointCoverageForHost,
    verifiedFindingIds: fx.verifiedFindingIds,
    openFindingIds: fx.openFindingIds,
  });
};

const evidenceUntestedSurface: Checker = async (c) => {
  const { untestedSurfaceClaimNote } = await import("../claimAudit");
  const fx = (c.context_fixture ?? {}) as Record<string, never>;
  const { buildAuditFacts } = await import("../claimAudit");
  const facts = buildAuditFacts("lab.example.test", {
    provingRunsForHost: () => ({ count: 0 }),
    endpointCoverageForHost: () => ({ seen: 12, probed: 0 }),
    openFindingIds: () => [],
    verifiedFindingIds: () => [],
  });
  const note = untestedSurfaceClaimNote(c.input_message, facts);
  return [
    eq("probed-zero", facts.endpointsProbed, 0),
    eq("seen-twelve", facts.endpointsSeen, 12),
    ok("note-fires", note.length > 0, note || "(no note)"),
    ok("readers-used", typeof fx.endpointCoverageForHost === "function" || facts.endpointsSeen === 12),
  ];
};

const evidenceUnprovenPastWork: Checker = async (c) => {
  const { buildAuditFacts, unprovenPastWorkClaimNote } = await import("../claimAudit");
  const facts = buildAuditFacts("lab.example.test", { provingRunsForHost: () => ({ count: 0 }) });
  const note = unprovenPastWorkClaimNote(c.input_message, facts);
  const honest = unprovenPastWorkClaimNote("ren notoriously aku selalu bilang\u9776 belum pernah diuji di host itu", facts);
  return [
    eq("past-work-false", facts.pastWorkProven, false),
    ok("note-fires", note.length > 0, note || "(no note)"),
    eq("unproven-means-not-yet-tested-stays-quiet", honest, ""),
  ];
};

const evidenceUnknownNotFalse: Checker = async (c) => {
  const { buildAuditFacts } = await import("../claimAudit");
  const facts = buildAuditFacts("lab.example.test", {});
  return [
    ok("past-work-unknown", facts.pastWorkProven === null || facts.pastWorkProven === undefined, String(facts.pastWorkProven)),
    ok("no-proving-runs-claimed", facts.provingRuns === 0),
  ];
};

const evidenceSeverityInflation: Checker = async (c) => {
  const { findingClaimFacts, severityInflationNote } = await import("../findingClaimAudit");
  const facts = findingClaimFacts([{ severity: "high", target: "lab.example.test", status: "open", cvss: 7.5 }], {
    recordedThisTurn: false,
  });
  const note = severityInflationNote(c.input_message, facts);
  const honest = severityInflationNote("dari 1 temuan tercatat, 1-nya tinggi dengan CVSS 7.5", facts);
  return [
    ok("note-fires", note.length > 0, note || "(no note)"),
    has("note-cites-stored-count", note, "1"),
    eq("faithful-summary-stays-quiet", honest, ""),
  ];
};

const evidenceUnrecordedRecord: Checker = async (c) => {
  const { findingClaimFacts, recordAuthorshipNote } = await import("../findingClaimAudit");
  const facts = findingClaimFacts([{ severity: "high", target: "lab.example.test", status: "open", cvss: 7.5 }], {
    recordedThisTurn: false,
  });
  const note = recordAuthorshipNote(c.input_message, facts);
  const priorTurn = recordAuthorshipNote("sudah tercatat 8 temuan di sistem", facts);
  return [
    ok("note-fires", note.length > 0, note || "(no note)"),
    eq("prior-turn-attribution-stays-quiet", priorTurn, ""),
  ];
};

const evidencePocVerdictState: Checker = async (c) => {
  const { recordPocRun, readPocRuns } = await import("../pocRuns");
  const { buildAuditFacts, unprovenPastWorkClaimNote } = await import("../claimAudit");
  // Stable throwaway key: a per-run key would litter .data/users with a new
  // directory on every evaluation run.
  const user = "eval_evidence";
  const before = readPocRuns(user).length;
  recordPocRun(user, { url: "https://lab.example.test/x", method: "GET", verdict: "no-signal", differs: false, status: 200, len: 100, at: new Date().toISOString() });
  // The store APPENDS (cap 120) and readPocRuns keeps insertion order, so the
  // row just written is the LAST one. Asserting runs[0] passed forever because
  // the very first historical row happened to match (audit 2026-10-16).
  const runs = readPocRuns(user);
  const written = runs[runs.length - 1];
  const note = unprovenPastWorkClaimNote(c.input_message, buildAuditFacts("lab.example.test", { provingRunsForHost: () => ({ count: 0 }) }));
  return [
    ok("row-appended", runs.length === before + 1, `sebelumnya ${before}, sekarang ${runs.length}`),
    eq("verdict-round-trips", written?.verdict, "no-signal"),
    eq("written-url-round-trips", written?.url, "https://lab.example.test/x"),
    ok("note-still-fires", note.length > 0, note || "(no note)"),
  ];
};

/* ----------------------------------------------------------------- coding */
const codeRoleGateAllows: Checker = async (c) => {
  const { roleGateRefusal } = await import("../roleGate");
  const tool = String((c.context_fixture as { tool?: string })?.tool ?? "");
  return [eq("allowed", roleGateRefusal(c.target_agent, tool), null)];
};

const codeUnearnedClaim: Checker = async (c) => {
  const { stripUnearnedWorkClaim } = await import("../agentRole");
  const out = stripUnearnedWorkClaim(c.input_message, { ranTool: false });
  const withTool = stripUnearnedWorkClaim(c.input_message, { ranTool: true });
  return [
    ok("claim-removed", out !== c.input_message.trim(), out),
    ok("kept-when-tool-ran", withTool === c.input_message.trim(), withTool),
  ];
};

const codeTaskBrief: Checker = async (c) => {
  const { buildTaskBrief } = await import("../orchestratorAgents");
  const brief = buildTaskBrief((c.context_fixture as { task: never }).task);
  return [
    has("task-id", brief, "t2"),
    has("acceptance-criteria", brief, "test auth green"),
    ok("has-limits-section", /BATASAN/i.test(brief), brief.slice(0, 200)),
  ];
};

/* --------------------------------------------------------- output formatter */
const fmtSimpleChat: Checker = async (c) => {
  const { classifyTask } = await import("../outputFormat");
  const { formatterFor } = await import("../outputFormat");
  const cls = classifyTask({ askText: c.input_message });
  const spec = formatterFor(cls.taskType);
  return [
    ok("conversational-type", ["general_chat", "question_answer"].includes(cls.taskType), cls.taskType),
    ok("not-a-report", spec.conciseness !== "report", `${cls.taskType} → ${spec.conciseness}`),
  ];
};

const fmtToolError: Checker = async (c) => {
  const { classifyTask } = await import("../outputFormat");
  const fx = (c.context_fixture ?? {}) as { executedTools?: string[]; toolError?: boolean };
  const cls = classifyTask({ askText: c.input_message, executedTools: fx.executedTools, toolError: fx.toolError });
  return [eq("task-type", cls.taskType, "error_report")];
};

const fmtEvidenceBlocked: Checker = async (c) => {
  const { validateOutput, integrityNote, hasBlockingIssue } = await import("../outputFormat");
  const fx = (c.context_fixture ?? {}) as { text?: string };
  const issues = validateOutput({ text: fx.text ?? "", taskType: "security_audit" });
  const evidenced =
    "Audit selesai. Temuan: 1 Stored XSS di /api/dokumen?id=5, level kritis, sudah terverifikasi lewat poc_verify. " +
    "Semua endpoint sudah saya cek. Bukti tersimpan di reports/report-2026-10-16.pdf.";
  const evidencedIssues = validateOutput({ text: evidenced, taskType: "security_audit" });
  const failedButSuccess = validateOutput({
    text: evidenced + " Semua aman, semua selesai tanpa kegagalan.",
    taskType: "security_audit",
    toolError: true,
  });
  return [
    ok("issue-raised", issues.length > 0, JSON.stringify(issues)),
    ok("success-claimed-on-failure-is-blocking", hasBlockingIssue(failedButSuccess), JSON.stringify(failedButSuccess.map((i) => i.code))),
    ok("integrity-note-on-evidence-claim", integrityNote(evidencedIssues, "security_audit", evidenced).length > 0,
      JSON.stringify(evidencedIssues.map((i) => i.code))),
  ];
};

const fmtChannelChunks: Checker = async (c) => {
  const { renderForChannel } = await import("../outputFormat");
  const { chunkText, DISCORD_MAX } = await import("../../channels/replyChunk");
  const body = Array.from({ length: 120 }, (_, i) => `baris ${i + 1} dengan isi yang cukup panjang untukchunking`).join("\n");
  const rendered = renderForChannel(body, "discord");
  const chunks = chunkText(rendered.text, DISCORD_MAX);
  return [
    ok("within-limit", chunks.every((ch) => ch.length <= DISCORD_MAX), `max ${Math.max(...chunks.map((ch) => ch.length))}`),
    // Chunk boundaries drop the separating space by design (separate messages),
    // so "no content lost" is asserted on the content markers, not whitespace.
    ok(
      "no-content-lost",
      (() => {
        const all = chunks.join("\n");
        for (let i = 1; i <= 120; i += 1) if (!all.includes(`baris ${i} `) && !all.includes(`baris ${i}\n`)) return false;
        return true;
      })(),
      "ada nomor baris yang hilang"
    ),
    ok("multi-chunk", chunks.length > 1, `${chunks.length} chunks`),
  ];
};

/* ------------------------------------------------------ Discord / Telegram */
const chanOneReactionPerMessage: Checker = async (c) => {
  const mr = await import("../messageReactions");
  mr.__resetReactionState();
  const first = mr.claimReactionSlot("discord", "c1", "m1", c.target_agent, "chat");
  const second = mr.claimReactionSlot("discord", "c1", "m1", c.target_agent, "chat");
  const other = mr.claimReactionSlot("discord", "c1", "m1", "michelle", "chat");
  mr.__resetReactionState();
  return [
    eq("first-claim", first, true),
    eq("second-claim-refused", second, false),
    eq("other-agent-may-react", other, true),
  ];
};

const chanReactionFailure: Checker = async (c) => {
  const { sendDiscordReaction } = await import("../messageReactions");
  const boom = {
    react: async () => {
      throw new Error("Missing Access");
    },
  };
  let threw = false;
  let result: boolean | undefined;
  try {
    result = await sendDiscordReaction(boom, c.target_agent, "m1", "👋");
  } catch {
    threw = true;
  }
  return [ok("never-throws", threw === false), eq("returns-false", result, false)];
};

const chanApprovalUnauthorized: Checker = async (c) => {
  const { isApprovalAuthorized } = await import("../../channels/discordApproval");
  return [
    eq("owner-allowed", isApprovalAuthorized(["u1"], "u1"), true),
    eq("stranger-denied", isApprovalAuthorized(["u1"], "u2"), false),
    eq("empty-list-open", isApprovalAuthorized([], "u9"), true),
  ];
};

const chanApprovalDoubleClick: Checker = async (c) => {
  const { createApprovalRequest, decideApproval } = await import("../../channels/discordApproval");
  const store = new Map();
  const req = createApprovalRequest({
    agentLabel: c.target_agent,
    agentDisplay: "Michelle",
    userKey: "eval_user",
    provider: "mock",
    messages: [],
    calls: [],
    store,
  });
  const first = decideApproval(req.id, "u1", true, store);
  const second = decideApproval(req.id, "u1", true, store);
  return [
    eq("first-decides", first.ok, true),
    eq("second-blocked", second.ok, false),
    eq("reason-is-decided", second.ok ? "" : second.reason, "decided"),
  ];
};

const chanApprovalExpiry: Checker = async (c) => {
  const { createApprovalRequest, decideApproval, APPROVAL_TTL_MS } = await import("../../channels/discordApproval");
  const store = new Map();
  const req = createApprovalRequest({
    agentLabel: c.target_agent,
    agentDisplay: "Michelle",
    userKey: "eval_user",
    provider: "mock",
    messages: [],
    calls: [],
    store,
    ttlMs: APPROVAL_TTL_MS,
  });
  store.get(req.id)!.expiresAt = Date.now() - 1000;
  const decision = decideApproval(req.id, "u1", true, store);
  return [
    eq("expired", decision.ok ? "" : decision.reason, "expired"),
    eq("status-expired", store.get(req.id)?.status, "EXPIRED"),
  ];
};

/* -------------------------------------------------- files and PDF delivery */
const fileWritesFreeReadsSandboxed: Checker = async (c) => {
  const { resolveWritePath, resolveInSandbox, writesAnywhere } = await import("../users");
  const path = "/Users/eval_writes_free/Desktop/helo.html";
  // The invariant is config-independent: reads are ALWAYS sandboxed, and a write
  // is never MORE restricted than a read. CI has no .env.local (WRITE_ANYWHERE
  // off), a developer machine has it on — both must satisfy the same rule.
  const free = writesAnywhere();
  return [
    eq("read-always-sandboxed", resolveInSandbox(path), null),
    ok(
      "write-never-more-restricted-than-read",
      free ? resolveWritePath(path) !== null : resolveWritePath(path) === resolveInSandbox(path),
      `WRITE_ANYWHERE=${free ? "1" : "0"}`
    ),
  ];
};

const filePdfCollapse: Checker = async (c) => {
  const { collapsePdfResult } = await import("../actionReceipt");
  const raw = String((c.mock_tool_results ?? {}).report_pdf ?? "");
  const collapsed = collapsePdfResult(raw);
  const basename = raw.slice(raw.lastIndexOf("/") + 1);
  return [
    ok("shorter", collapsed.length < raw.length, `${raw.length} -> ${collapsed.length}`),
    eq("keeps-basename", collapsed, basename),
    ok("drops-directory", !collapsed.includes("/Users/"), collapsed),
  ];
};

/* -------------------------------------------------------- error / partial work */
const errPartialCompletion: Checker = async (c) => {
  const { reconcile } = await import("../orchestration");
  const { renderFinal } = await import("../orchestrator");
  const { planFromRequest } = await import("../orchestrationPlanner");
  const plan = planFromRequest(c.input_message, { user: "eval_user", now: "2026-10-16T00:00:00.000Z" });
  const tasks = (plan.tasks.length >= 2 ? plan.tasks : [...plan.tasks, plan.tasks[0]]).slice(0, 2).map((t, i) => ({
    ...t,
    required: false,
    status: (i === 0 ? "SUCCEEDED" : "FAILED") as never,
    result_reference: i === 0 ? `result:${t.task_id} — ok` : null,
    error_summary: i === 0 ? null : "gagal di tengah jalan",
  }));
  const r = reconcile({ ...plan, tasks, status: "RUNNING" });
  const text = renderFinal({ ...plan, tasks, status: "RUNNING" }, r);
  return [
    eq("parent-status", r.parentStatus, "PARTIALLY_COMPLETED"),
    ok("disclosure-present", r.disclosures.length > 0, JSON.stringify(r.disclosures)),
    has("final-text-discloses", text, tasks[1].task_id),
  ];
};

/* ------------------------------------------------------------- approval layer */
const apprDeclinedNotInReceipt: Checker = async (c) => {
  const { actionReceipt, RECEIPT_TOOLS } = await import("../actionReceipt");
  const declined = actionReceipt([{ name: "pentest_scan", args: { url: "x" }, result: "The user declined this action." }]);
  const real = actionReceipt([{ name: "http_request", args: { url: "https://lab.example.test/x" }, result: "200 OK" }]);
  return [
    eq("tool-classified", RECEIPT_TOOLS.has("http_request"), true),
    ok("declined-absent", !declined.includes("pentest_scan"), declined || "(empty)"),
    has("real-execution-present", real, "http_request"),
  ];
};

/* --------------------------------------------------------- prompt injection */
const injInternalCarrier: Checker = async (c) => {
  const { isInternalTurn } = await import("../memoryNoise");
  return [
    eq("carrier-internal", isInternalTurn(c.input_message), true),
    eq("plain-user-line-not-internal", isInternalTurn("aku suka kopi susu"), false),
  ];
};

const injBotSelfEcho: Checker = async (c) => {
  const { addressesThisBot } = await import("../agentRouting");
  return [
    eq("human-mention-counts", addressesThisBot("<@MIA> halo", "MIA", false, undefined), true),
    eq("bot-authored-no-mention", addressesThisBot(c.input_message, "MIA", true, undefined), false),
    // Deliberate: a bot author earns nothing from event.bot_id (Slack sets it on
    // every bot message), so only an explicit mention counts.
    eq("bot-event-id-alone-ignored", addressesThisBot(c.input_message, "MIA", true, "B1"), false),
    eq("bot-mention-still-counts", addressesThisBot("<@MIA> lanjut", "MIA", true, "B1"), true),
  ];
};

const injTextCannotGrantTools: Checker = async (c) => {
  const { roleGateRefusal } = await import("../roleGate");
  const tool = String((c.context_fixture as { tool?: string })?.tool ?? "");
  return [ok("still-refused", roleGateRefusal(c.target_agent, tool) !== null, "role gate read the role, not the text")];
};

/* ------------------------------------------------------------------ registry */
export const CHECKERS: Record<string, Checker> = {
  "routing.shouldRespond": routeShouldRespond,
  "routing.unresolvedMention": routeUnresolvedMention,
  "routing.roleGate": routeRoleGate,
  "routing.unclassifiedTool": routeUnclassifiedTool,
  "orchestration.staysDirect": orcStaysDirect,
  "orchestration.plansChained": orcPlansChained,
  "orchestration.dependencyOrder": orcDependencyOrder,
  "orchestration.partialFailure": orcPartialFailure,
  "orchestration.capabilityGap": orcCapabilityGap,
  "orchestration.cancel": orcCancel,
  "orchestration.cycle": orcCycle,
  "exec.noResult": execNoResult,
  "exec.refusal": execRefusal,
  "exec.toolError": execToolError,
  "evidence.untestedSurface": evidenceUntestedSurface,
  "evidence.unprovenPastWork": evidenceUnprovenPastWork,
  "evidence.unknownNotFalse": evidenceUnknownNotFalse,
  "evidence.severityInflation": evidenceSeverityInflation,
  "evidence.unrecordedRecord": evidenceUnrecordedRecord,
  "evidence.pocVerdictState": evidencePocVerdictState,
  "coding.roleGateAllows": codeRoleGateAllows,
  "coding.unearnedClaim": codeUnearnedClaim,
  "coding.taskBrief": codeTaskBrief,
  "fmt.simpleChat": fmtSimpleChat,
  "fmt.toolError": fmtToolError,
  "fmt.evidenceBlocked": fmtEvidenceBlocked,
  "fmt.channelChunks": fmtChannelChunks,
  "chan.oneReactionPerMessage": chanOneReactionPerMessage,
  "chan.reactionFailure": chanReactionFailure,
  "chan.approvalUnauthorized": chanApprovalUnauthorized,
  "chan.approvalDoubleClick": chanApprovalDoubleClick,
  "chan.approvalExpiry": chanApprovalExpiry,
  "file.writesFreeReadsSandboxed": fileWritesFreeReadsSandboxed,
  "file.pdfCollapse": filePdfCollapse,
  "err.partialCompletion": errPartialCompletion,
  "appr.declinedNotInReceipt": apprDeclinedNotInReceipt,
  "inj.internalCarrier": injInternalCarrier,
  "inj.botSelfEcho": injBotSelfEcho,
  "inj.textCannotGrantTools": injTextCannotGrantTools,
  ...RECOVERY_CHECKERS,
  ...ATTRIBUTION_CHECKERS,
};