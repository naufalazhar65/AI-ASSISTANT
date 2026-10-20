/**
 * Office chat sidebar — pure helpers (no Next, no node built-ins beyond types).
 *
 * The dashboard sidebar renders from ONE source of truth: the persisted
 * conversation (`/api/sessions` → `{messages}`). Tool cards are RECONSTRUCTED
 * from the real assistant `tool_calls` + `tool` result messages, so a reload
 * shows the backend outcome (succeeded/failed/cancelled) rather than a guess.
 * Live bus events refine the same cards while the turn runs.
 *
 * Lifecycle shown here is only what the backend actually reports:
 * queued (model proposed, not yet run) · awaiting_approval (FR-014 pause)
 * · succeeded / failed (real tool result) · cancelled (explicit decline).
 * There is deliberately NO "running" tool state: the bus emits `tool_called`
 * AFTER execution, so claiming "running" would be invented.
 */
import type { ChatMessage } from "./agent";
import { redactSecrets } from "./memoryNoise";

export const OFFICE_AGENTS = ["mia", "agnes", "michelle"] as const;
export type OfficeAgent = (typeof OFFICE_AGENTS)[number];

/** Registered trio only — never a new/unknown agent. */
export function isOfficeAgent(v: unknown): v is OfficeAgent {
  return typeof v === "string" && (OFFICE_AGENTS as readonly string[]).includes(v);
}

/** One conversation per agent per user; stable id so reloads reuse the history. */
export function officeSessionId(agent: OfficeAgent): string {
  return `office-${agent}`;
}

export const MAX_OFFICE_MESSAGES = 40;
export const MAX_OFFICE_TEXT = 8000;
const ROLES = new Set(["system", "user", "assistant", "tool"]);
const MAX_TOOL_ARGS_SUMMARY = 160;

/**
 * Server-side validation of the client history. Only the fields the model
 * contract needs survive; unknown roles and oversized turns are dropped rather
 * than forwarded, so the browser cannot inject structure the agent never sent.
 */
export function sanitizeIncomingMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatMessage[] = [];
  for (const m of raw.slice(-MAX_OFFICE_MESSAGES)) {
    if (!m || typeof m !== "object") continue;
    const msg = m as Record<string, unknown>;
    const role = typeof msg.role === "string" ? msg.role : "";
    if (!ROLES.has(role)) continue;
    const content = typeof msg.content === "string" ? msg.content.slice(0, MAX_OFFICE_TEXT) : null;
    const next: ChatMessage = { role, content };
    if (typeof msg.tool_call_id === "string") next.tool_call_id = msg.tool_call_id;
    if (Array.isArray(msg.tool_calls)) {
      next.tool_calls = msg.tool_calls
        .filter((c): c is NonNullable<ChatMessage["tool_calls"]>[number] => !!c && typeof c === "object")
        .slice(0, 8)
        .map((c) => ({
          id: String(c.id ?? "").slice(0, 64),
          type: "function" as const,
          function: {
            name: String(c.function?.name ?? "").slice(0, 64),
            arguments: String(c.function?.arguments ?? "{}").slice(0, MAX_OFFICE_TEXT),
          },
        }));
      if (!next.tool_calls.length) delete next.tool_calls;
    }
    if (typeof msg.reasoning_content === "string") next.reasoning_content = msg.reasoning_content.slice(0, MAX_OFFICE_TEXT);
    out.push(next);
  }
  return out;
}

export type ToolCardState = "queued" | "awaiting_approval" | "succeeded" | "failed" | "cancelled";

export interface ToolCard {
  /** Stable across reloads: the provider's tool_call id. */
  id: string;
  name: string;
  /** Short, redacted "what" for the collapsed card header. */
  args: string;
  state: ToolCardState;
  /** Sanitized output (never secrets), truncated. */
  output?: string;
  at?: string;
}

/** Placeholder results the agent writes when a call was NOT executed. */
const NOT_EXECUTED_RE = /declined|not selected|not executed|auto-declined|tidak dijalankan/i;

export function toolResultState(text: string): "succeeded" | "failed" | "cancelled" {
  const t = String(text ?? "").trim();
  if (NOT_EXECUTED_RE.test(t)) return "cancelled";
  return /^error:/i.test(t) ? "failed" : "succeeded";
}

/** Redacted + truncated tool output for the UI. */
export function sanitizeToolOutput(text: string, max = 800): string {
  const clean = redactSecrets(String(text ?? "")).trim();
  return clean.length > max ? `${clean.slice(0, max)}… (dipotong)` : clean;
}

/** One-line summary of the tool arguments; never raw secrets. */
export function summarizeToolArgs(argsJson: unknown): string {
  const raw = typeof argsJson === "string" ? argsJson : JSON.stringify(argsJson ?? {});
  let parsed: Record<string, unknown> | null = null;
  try {
    const p = JSON.parse(raw);
    if (p && typeof p === "object" && !Array.isArray(p)) parsed = p as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  if (!parsed) return sanitizeToolOutput(raw, MAX_TOOL_ARGS_SUMMARY);
  const pick = ["url", "target", "host", "path", "file", "query", "id", "name", "domain", "message", "action"];
  const parts: string[] = [];
  for (const k of pick) {
    const v = parsed[k];
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${k}=${sanitizeToolOutput(String(v), 60)}`);
    if (parts.join(" ").length >= MAX_TOOL_ARGS_SUMMARY) break;
  }
  if (!parts.length) {
    const first = Object.entries(parsed)[0];
    if (first) parts.push(`${first[0]}=${sanitizeToolOutput(String(first[1]), 60)}`);
  }
  return sanitizeToolOutput(parts.join(" ") || "—", MAX_TOOL_ARGS_SUMMARY);
}

export interface ToolCardOptions {
  /** Tool call ids currently paused for approval (from `confirm`). */
  pendingIds?: string[];
  /** Tool name explicitly declined by the user (from bus `task_cancelled`). */
  cancelledNames?: string[];
}

/**
 * Rebuild tool cards from the persisted conversation (server truth).
 * A call is `queued` until its real result message arrives; `pendingIds`
 * upgrades it to `awaiting_approval` (the backend is genuinely paused).
 */
export function toolCardsFromMessages(messages: ChatMessage[], opts: ToolCardOptions = {}): ToolCard[] {
  const pending = new Set(opts.pendingIds ?? []);
  const cancelled = new Set(opts.cancelledNames ?? []);
  const cards = new Map<string, ToolCard>();
  const byName = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) {
        const id = c.id || `${c.function?.name ?? "tool"}#${cards.size}`;
        const name = c.function?.name ?? "tool";
        const state: ToolCardState = pending.has(id) ? "awaiting_approval" : "queued";
        cards.set(id, { id, name, args: summarizeToolArgs(c.function?.arguments), state });
        byName.set(name, id);
      }
      continue;
    }
    if (m.role === "tool" && typeof m.tool_call_id === "string") {
      const card = cards.get(m.tool_call_id);
      if (!card) continue;
      const text = typeof m.content === "string" ? m.content : "";
      card.state = cancelled.has(card.name) ? "cancelled" : toolResultState(text);
      if (card.state === "cancelled") card.output = "Ditolak user — tool tidak dijalankan.";
      card.output = sanitizeToolOutput(text);
    }
  }
  // An explicit decline is reported by the bus (`task_cancelled`) and may land
  // before the refusal result message exists, so apply it last. A call that
  // already produced a real result keeps that outcome.
  for (const card of cards.values()) {
    if (cancelled.has(card.name) && card.state !== "succeeded") card.state = "cancelled";
  }
  return [...cards.values()];
}

/** Human label for a lifecycle state (Indonesian, UI copy). */
export function toolStateLabel(state: ToolCardState): string {
  switch (state) {
    case "queued":
      return "Menunggu dijalankan";
    case "awaiting_approval":
      return "Menunggu persetujuan";
    case "succeeded":
      return "Selesai";
    case "failed":
      return "Gagal";
    case "cancelled":
      return "Dibatalkan";
  }
}

/** Parse one NDJSON line from the chat stream; null when incomplete/unparsable. */
export function parseNdjsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const v = JSON.parse(trimmed);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}