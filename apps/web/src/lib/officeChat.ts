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
 * queued (model proposed, not yet run) · running (tool_started fired, the
 * call is in flight) · awaiting_approval (FR-014 pause) · succeeded / failed /
 * timed_out (real tool result) · cancelled (explicit decline) · unknown (a
 * call with NO outcome on record — never "will run", never "succeeded").
 *
 * A card carries THREE separate fields so a diagnostic can never masquerade
 * as a status: `summary` (user-facing one-liner), `result` (short first line
 * of the real output) and `detail` (full sanitized output, diagnostics only).
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

export type ToolCardState =
  /** Proposed, not started yet. */
  | "queued"
  /** Started; no outcome reported yet. */
  | "running"
  /** Waiting for the owner to approve it. */
  | "awaiting_approval"
  | "succeeded"
  | "failed"
  /** Explicitly declined by the owner. */
  | "cancelled"
  /** Started and hit a timeout. */
  | "timed_out"
  /** No outcome on record — NOT the same as "failed", and never "succeeded". */
  | "unknown";

/**
 * One email in the compact inbox summary. Only what the summary shows:
 * subject, sender DISPLAY NAME, the converted time, a short snippet. No
 * bodies, no full addresses.
 */
export interface InboxEmail {
  id: string;
  subject: string;
  from: string;
  /** Already formatted in the app timezone; "" when the provider date was unusable. */
  at: string;
  snippet: string;
}

export interface InboxSummary {
  count: number;
  /** The time window the emails span, as the tool formatted it. */
  range: string;
  emails: InboxEmail[];
}

/**
 * Parse the compact inbox output the gmail tools produce
 * (`email.ts` → `gmailList`). Pure + deterministic: the tool's line format is
 * ours, so the UI can render a real list instead of re-reading prose.
 * Returns null when the text is not an inbox summary.
 */
export function parseInboxSummary(text: string): InboxSummary | null {
  const raw = String(text || "");
  if (!raw.includes("Ringkasan Inbox")) return null;
  const lines = raw.split("\n");
  const header = lines[0] || "";
  const countM = header.match(/Ringkasan Inbox\s+—\s*(\d+)\s+email/);
  const rangeM = header.match(/·\s*(.+)$/);
  const emails: InboxEmail[] = [];
  for (const line of lines.slice(1)) {
    const m = line.match(/^(\d+)\.\s*\[([^\]]+)\]\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*)$/);
    if (!m) continue;
    emails.push({ id: m[2], subject: m[3], from: m[4], at: m[5], snippet: m[6] });
  }
  if (!emails.length && !countM) return null;
  return {
    count: countM ? Number(countM[1]) : emails.length,
    range: rangeM ? rangeM[1].trim() : "",
    emails,
  };
}

export interface ToolCard {
  /** Stable across reloads: the provider's tool_call id. */
  id: string;
  name: string;
  /** Short, redacted "what" for the collapsed card header. */
  args: string;
  state: ToolCardState;
  /**
   * User-facing one-liner. Never contains raw provider diagnostics — those
   * belong in `detail`, behind a disclosure.
   */
  summary: string;
  /**
   * Present when the tool returned an inbox summary (gmail_list/gmail_search)
   * AND the call actually produced a result. The UI renders this as a compact
   * list; the raw text stays in `detail`.
   */
  inbox?: InboxSummary;
  /** Short, sanitized result (first line) shown in the card body. */
  result?: string;
  /** Full sanitized raw output — diagnostics only. */
  detail?: string;
  at?: string;
}

/**
 * THREE different outcomes that used to collapse into one:
 * - "no result recorded" = the model never received an outcome → unknown.
 * - "declined / not selected" = the owner said no → cancelled.
 * - "Error: …" = the tool actually failed (timed_out when it says so).
 * A plain result is success. Anything else must never be called success.
 */
/* Two different placeholders, two different truths:
   - "no result recorded" = the call has NO outcome on record → unknown.
   - "Not executed" / "declined" = a DECISION was taken not to run it → cancelled.
   NO_RESULT is checked first, so the longer "Not executed (no result
   recorded)…" placeholder stays unknown and does not read as a decline. */
const NO_RESULT_RE = /no result recorded/i;
const DECLINED_RE = /declined|not selected|not executed|auto-declined|tidak dijalankan/i;
const TIMEOUT_RE = /timed?\s?out|timeout|etimedout/i;

export function toolResultState(text: string): "succeeded" | "failed" | "cancelled" | "timed_out" | "unknown" {
  const t = String(text ?? "").trim();
  if (NO_RESULT_RE.test(t)) return "unknown";
  if (DECLINED_RE.test(t)) return "cancelled";
  if (/^error:/i.test(t)) return TIMEOUT_RE.test(t) ? "timed_out" : "failed";
  return "succeeded";
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
  /**
   * Tool call ids the owner explicitly declined (from bus `task_cancelled`).
   * Call ids, NOT tool names: a name matches every call of that tool in every
   * turn, so a decline in turn 1 used to mark turn 5's call cancelled.
   */
  cancelledIds?: string[];
  /**
   * Is the turn over? A call with no result record once the turn ended is
   * `unknown` — never `succeeded` and never "will run".
   */
  final?: boolean;
}

/** First meaningful line of a tool result, sanitized. */
function firstLine(text: string, max = 200): string {
  const clean = sanitizeToolOutput(text, 1200);
  const line = clean.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.trim().length > max ? `${line.trim().slice(0, max)}…` : line.trim();
}

/**
 * Rebuild tool cards from the persisted conversation (server truth).
 * Correlation is by the provider's tool_call id — never by tool name.
 * A call is `queued` until its real result message arrives; `pendingIds`
 * upgrades it to `awaiting_approval` (the backend is genuinely paused).
 */
export function toolCardsFromMessages(messages: ChatMessage[], opts: ToolCardOptions = {}): ToolCard[] {
  const pending = new Set(opts.pendingIds ?? []);
  const cancelled = new Set(opts.cancelledIds ?? []);
  const final = opts.final !== false;
  const cards = new Map<string, ToolCard>();
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) {
        const id = c.id || `${c.function?.name ?? "tool"}#${cards.size}`;
        const name = c.function?.name ?? "tool";
        const state: ToolCardState = pending.has(id) ? "awaiting_approval" : "queued";
        cards.set(id, {
          id,
          name,
          args: summarizeToolArgs(c.function?.arguments),
          state,
          summary: toolStateLabel(state),
        });
      }
      continue;
    }
    if (m.role === "tool" && typeof m.tool_call_id === "string") {
      const card = cards.get(m.tool_call_id);
      if (!card) continue;
      const text = typeof m.content === "string" ? m.content : "";
      const state = cancelled.has(card.id) ? "cancelled" : toolResultState(text);
      card.state = state;
      card.summary = toolStateLabel(state);
      // The raw provider text is a DIAGNOSTIC. It goes to `detail` (collapsed);
      // the card body only shows the short, human-readable first line.
      card.detail = sanitizeToolOutput(text);
      card.result = state === "unknown" || state === "cancelled" ? undefined : firstLine(text);
      // An inbox result is only attached to a card that PRODUCED it: a
      // cancelled or result-less call must never show someone else's emails.
      if (state === "succeeded" && (card.name === "gmail_list" || card.name === "gmail_search")) {
        const inbox = parseInboxSummary(text);
        if (inbox) card.inbox = inbox;
      }
    }
  }
  // An explicit decline reported by the bus may land before the refusal result
  // message exists, so apply it last. A call that already produced a real
  // result keeps that outcome.
  for (const card of cards.values()) {
    if (cancelled.has(card.id) && card.state !== "succeeded") {
      card.state = "cancelled";
      card.summary = toolStateLabel("cancelled");
      card.result = undefined;
    }
  }
  // A call that was proposed but never produced a result has NO outcome on
  // record. Once the turn is over that is `unknown` — not `queued` (which
  // promises it will run) and never `succeeded`.
  for (const card of cards.values()) {
    if (card.state === "queued" && final && !pending.has(card.id)) {
      card.state = "unknown";
      card.summary = toolStateLabel("unknown");
    }
  }
  return [...cards.values()];
}

/** Human label for a lifecycle state (Indonesian, UI copy). */
export function toolStateLabel(state: ToolCardState): string {
  switch (state) {
    case "queued":
      return "Menunggu dijalankan";
    case "running":
      return "Sedang berjalan";
    case "awaiting_approval":
      return "Menunggu persetujuanmu";
    case "succeeded":
      return "Selesai";
    case "failed":
      return "Gagal";
    case "cancelled":
      return "Dibatalkan";
    case "timed_out":
      return "Berhenti — timeout";
    case "unknown":
      return "Status akhir tidak diketahui";
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