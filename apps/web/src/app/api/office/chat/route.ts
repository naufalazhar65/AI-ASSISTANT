// Office chat sidebar backend (real, not a mock).
//
//   GET  /api/office/chat?agent=mia|agnes|michelle&user=<u>
//        → { agent, session_id, messages }  (history from the EXISTING
//          /api/sessions store — no second persistence layer)
//
//   POST /api/office/chat { agent?, user?, messages, confirm_calls? }
//        → NDJSON stream: `start` → `bus` (live tool lifecycle for THIS turn)
//          → `confirm` (real FR-014 pause) → `message` (final text + server
//          messages) | `error`. The turn itself is `runAssistantTurn` — the
//          same core Discord/Slack/web use, with `agent` selecting the trio
//          member. No tool ever runs in the browser.
//
// Auth: the shared middleware already gates /api/* with AUTH_TOKEN (cookie or
// Bearer); the dashboard proxies with `Authorization: Bearer` like the bus.

import { NextRequest } from "next/server";
import { runAssistantTurn, type ChatMessage } from "@/lib/agent";
import type { ToolCall } from "@/lib/tools";
import { loadSession, upsertSession } from "@/lib/sessions";
import { tzLabel, userTimeZone } from "@/lib/time";
import { sanitizeUser } from "@/lib/users";
import { agentTurnUserKey } from "@/lib/identity";
import { subscribeBus, type BusEvent } from "@/lib/bus";
import { isOfficeAgent, officeSessionId, sanitizeIncomingMessages, toolCardsFromMessages, type OfficeAgent } from "@/lib/officeChat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_CONFIRM_CALLS = 8;

function confirmCallsFrom(raw: unknown): { call: ToolCall; allow: boolean }[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: { call: ToolCall; allow: boolean }[] = [];
  for (const d of raw.slice(0, MAX_CONFIRM_CALLS)) {
    const call = (d as { call?: ToolCall })?.call;
    if (!call || typeof call.name !== "string") continue;
    out.push({ call, allow: (d as { allow?: unknown }).allow === true });
  }
  return out.length ? out : undefined;
}

export async function GET(request: NextRequest) {
  const agentParam = request.nextUrl.searchParams.get("agent");
  const agent: OfficeAgent = isOfficeAgent(agentParam) ? agentParam : "mia";
  const user = request.nextUrl.searchParams.get("user") ?? undefined;
  const session = loadSession(user, officeSessionId(agent));
  const messages = Array.isArray(session?.conversation?.messages)
    ? (session.conversation.messages as ChatMessage[])
    : [];
  return Response.json({
    agent,
    session_id: officeSessionId(agent),
    messages,
    // Real send times, aligned with `messages`. A message whose time is
    // unknown stays null — the UI then shows no time rather than a lie.
    stamps: Array.isArray(session?.conversation?.stamps) ? session.conversation.stamps : [],
    // The app's real timezone config — the dashboard renders every timestamp
    // (message AND email) in it. It is never hardcoded in the browser.
    tz: userTimeZone(),
    tz_label: tzLabel(),
    // Cards are derived server-side from the SAME messages, so the browser has
    // one source of truth and no duplicated lifecycle logic.
    cards: toolCardsFromMessages(messages),
  });
}

export async function POST(request: NextRequest) {
  let body: {
    agent?: unknown;
    user?: unknown;
    messages?: unknown;
    confirm_calls?: unknown;
    /** Per-message send time, aligned with `messages` (epoch ms, null = unknown). */
    stamps?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return new Response("invalid JSON body", { status: 400 });
  }
  const agent: OfficeAgent = isOfficeAgent(body.agent) ? body.agent : "mia";
  // The dashboard proxy pins the owner user; a direct caller without one lands in
  // the shared bucket (same default as the other /api routes) — never "undefined",
  // which would make the bus filter below match everything.
  const user = sanitizeUser(body.user) || "shared";
  // TWO keys on purpose. `user` is OWNER scope: the conversation session, the
  // bus filter anchor and every store stay shared with the owner. `turnUser` is
  // PERSONA scope: Agnes and Michelle must read their OWN IDENTITY/SOUL, not
  // Mia's — passing the owner key for all three made every tab answer as the PM
  // (measured 2026-10-19: `agent:agnes` replied "PM dari trio kita").
  const turnUser = agentTurnUserKey(user, agent);
  const messages = sanitizeIncomingMessages(body.messages);
  if (!messages.length) return new Response("messages is required", { status: 400 });
  // The browser's own stamps are the authority for what it already sent: the
  // server keeps them, and only fills a time for a message nobody timed.
  const incomingStamps: (number | null)[] = Array.isArray(body.stamps)
    ? body.stamps.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null))
    : [];
  const confirm_calls = confirmCallsFrom(body.confirm_calls);
  const sessionId = officeSessionId(agent);
  // The previous session's stamps, so history the browser re-sends keeps the
  // time it was actually sent (the browser's own stamps win over these).
  const prevStamps: (number | null)[] = (() => {
    const prev = loadSession(user, sessionId);
    return Array.isArray(prev?.conversation?.stamps) ? prev.conversation.stamps : [];
  })();

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let turnId: string | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (frame: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
        } catch {
          /* client gone — the turn keeps running server-side */
        }
      };
      send({ type: "start", agent, session_id: sessionId });

      // Live tool lifecycle for THIS turn only. Correlation rule: the first
      // event of a runAssistantTurn call is always `task_created` (bus docs),
      // so that event pins the turn id; everything after must match it. Events
      // from other channels of the same user can therefore never leak in.
      unsubscribe = subscribeBus((ev: BusEvent) => {
        if (ev.user !== turnUser) return;
        if (turnId === null) {
          if (ev.type !== "task_created") return;
          turnId = ev.turn;
        }
        if (ev.turn !== turnId) return;
        send({ type: "bus", event: ev });
      });

      void (async () => {
        try {
          const result = await runAssistantTurn({
            messages,
            user: turnUser,
            agent,
            channel: "text",
            ...(confirm_calls ? { confirm_calls } : {}),
          });
          // `runAssistantTurn` returns the BUFFERED text; a no-tool turn does not carry an
          // assistant message in `messages`. Append it here so the sidebar (and the
          // persisted history) always contain the reply the user actually saw. Skipped
          // on a confirmation pause: there the last message is the assistant turn that
          // proposed the tool calls, which the tool cards already render.
          const base = result.messages ?? messages;
          const last = base[base.length - 1];
          const hasAssistantText =
            !!last && last.role === "assistant" && !last.tool_calls && typeof last.content === "string" && last.content === (result.text ?? "");
          const nextMessages: ChatMessage[] =
            result.needsConfirmation?.length || hasAssistantText
              ? base
              : [...base, { role: "assistant", content: result.text ?? "" }];
          // One stamp per PERSISTED message, aligned with `nextMessages`: the
          // browser's own value where it has one, the previous session's value
          // for history it re-sent, and THIS turn's time for everything the
          // agent just produced.
          const now = Date.now();
          const stamps: (number | null)[] = nextMessages.map((_m, i) => {
            if (i < messages.length) return incomingStamps[i] ?? prevStamps[i] ?? null;
            return now;
          });
          try {
            upsertSession(user, sessionId, { messages: nextMessages, transcripts: [], stamps }, `${agent} — office chat`);
          } catch {
            /* history is best-effort; the turn itself already succeeded */
          }
          if (result.needsConfirmation?.length) {
            send({
              type: "confirm",
              calls: result.needsConfirmation,
              messages: nextMessages,
              stamps,
              cards: toolCardsFromMessages(nextMessages, { pendingIds: result.needsConfirmation.map((c) => c.id), final: false }),
            });
          } else {
            send({
              type: "message",
              text: result.text ?? "",
              messages: nextMessages,
              stamps,
              cards: toolCardsFromMessages(nextMessages),
            });
          }
        } catch (err) {
          send({ type: "error", message: err instanceof Error ? err.message : String(err) });
        } finally {
          try {
            unsubscribe?.();
          } catch {
            /* ignore */
          }
          unsubscribe = null;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      })();
    },
    cancel() {
      try {
        unsubscribe?.();
      } catch {
        /* ignore */
      }
      unsubscribe = null;
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}