/**
 * Task-aware output formatter — public surface.
 *
 * `applyOutputFormat` is the single entry point called from the agent's turn
 * wrapper. It classifies, validates, and renders; it never rewrites content and
 * never calls a model.
 *
 * Barrel re-exports everything a caller (or a test) needs, so agent.ts has a
 * single import line and no chance of drifting from the module layout.
 */

export * from "./taskTypes";
export * from "./classify";
export * from "./registry";
export * from "./validate";
export * from "./render";
export * from "./guidance";

import { classifyTask } from "./classify";
import { renderForChannel } from "./render";
import { formatterFor } from "./registry";
import { integrityNote, validateOutput, type ValidationIssue } from "./validate";
import type { Classification, FormatChannel, TaskType } from "./taskTypes";

/** What the caller learns about the formatting decision (observability + tests). */
export interface FormatterOutcome {
  taskType: TaskType;
  template: string;
  basis: Classification["basis"];
  signal: string;
  channel: FormatChannel;
  /** An explicit user format request that overrode the template's structure. */
  explicitFormat?: Classification["explicitFormat"];
  /** True when the channel renderer changed the markdown dialect. */
  rendered: boolean;
  /** Integrity findings on the model's own text, before any rendering. */
  issues: ValidationIssue[];
  /** True when we deliberately kept the original text (safety net). */
  fallback: boolean;
  note: string;
}

export interface ApplyOutputFormatInput {
  text: string;
  askText: string;
  /** Trio member running the turn (`mia` | `agnes` | `michelle`), when known. */
  agent?: string;
  channel?: FormatChannel;
  /** Tool names that really ran, from the collector (never from prose). */
  executedTools?: readonly string[];
  /** True when a tool result this turn was an error/refusal. */
  toolError?: boolean;
}

/**
 * Returns the text to deliver plus what we decided. On ANY doubt the original
 * text is returned unchanged (`fallback: true`), because a formatter that can
 * destroy a good answer is worse than no formatter at all.
 */
export function applyOutputFormat(input: ApplyOutputFormatInput): { text: string; outcome: FormatterOutcome } {
  const channel: FormatChannel = input.channel ?? "chat";
  const original = input.text ?? "";

  let classification: Classification;
  try {
    classification = classifyTask({
      askText: input.askText ?? "",
      agent: input.agent,
      channel,
      executedTools: input.executedTools,
      toolError: input.toolError,
      answer: original,
    });
  } catch {
    return {
      text: original,
      outcome: {
        taskType: "general_chat",
        template: "B",
        basis: "fallback",
        signal: "classify-failed",
        channel,
        rendered: false,
        issues: [],
        fallback: true,
        note: "classification failed — original text kept",
      },
    };
  }

  const spec = formatterFor(classification.taskType);

  let issues: ValidationIssue[] = [];
  try {
    issues = validateOutput({
      text: original,
      taskType: classification.taskType,
      channel,
      executedTools: input.executedTools,
      toolError: input.toolError,
      askText: input.askText,
      explicitFormat: classification.explicitFormat,
    });
  } catch {
    issues = [];
  }

  // Conversation and short answers are NEVER decorated: the brief is explicit
  // that a simple question must stay a simple answer.
  const structural = spec.conciseness === "report" && classification.explicitFormat !== "json";
  if (!structural || !original.trim()) {
    return {
      text: original,
      outcome: {
        taskType: classification.taskType,
        template: spec.template,
        basis: classification.basis,
        signal: classification.signal,
        channel,
        ...(classification.explicitFormat ? { explicitFormat: classification.explicitFormat } : {}),
        rendered: false,
        issues,
        fallback: false,
        note: `conversational shape (${spec.template}) — not decorated`,
      },
    };
  }

  const rendered = renderForChannel(original, channel);
  const dangerous = issues.some((i) => i.code === "empty-answer" || i.code === "success-claimed-on-failure");
  if (dangerous || !rendered.text.trim()) {
    return {
      text: original,
      outcome: {
        taskType: classification.taskType,
        template: spec.template,
        basis: classification.basis,
        signal: classification.signal,
        channel,
        ...(classification.explicitFormat ? { explicitFormat: classification.explicitFormat } : {}),
        rendered: false,
        issues,
        fallback: true,
        note: `kept original: ${issues.map((i) => i.code).join(",") || "empty render"}`,
      },
    };
  }

  // Validation that only records changes nothing. For the two integrity gaps that
  // make a report's claims unverifiable (no sources; no findings section), state
  // the gap in the message itself. The note is a fact about THIS message, never
  // invented content, and it is capped at two clauses.
  const note = integrityNote(issues, classification.taskType, rendered.text);
  const withNote = note ? `${rendered.text}\n\n${note}` : rendered.text;

  return {
    text: withNote,
    outcome: {
      taskType: classification.taskType,
      template: spec.template,
      basis: classification.basis,
      signal: classification.signal,
      channel,
      rendered: rendered.transformed,
      issues,
      fallback: false,
      note: note ? `${rendered.note} + integrity note` : rendered.note,
    },
  };
}