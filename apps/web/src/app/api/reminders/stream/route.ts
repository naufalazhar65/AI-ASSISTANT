// GET /api/reminders/stream — Server-Sent Events push for due reminders.
//
// The client opens this stream (EventSource) and receives one event per
// reminder. Two sources feed it:
//  - on connect, reminders that came due while the tab was closed are replayed
//    immediately.
//  - a shared scheduler (lib/reminders) pushes reminders that come due live.
//
// Event shape: `data: {"id":"…","text":"…"}\n\n` (default message type).
//
// Security: `user` is sanitized server-side (invariant 5); a valid user key is
// required — without one the stream is still opened but receives nothing, since
// reminders are per-user. No secrets are exposed.

import { NextRequest } from "next/server";
import { takeDueReminders, subscribeReminders, Reminder } from "@/lib/reminders";
import { sanitizeUser } from "@/lib/users";
import { checkRateLimit, RateLimitError } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function frame(r: Reminder): string {
  return `data: ${JSON.stringify({ id: r.id, text: r.text })}\n\n`;
}

export async function GET(request: NextRequest) {
  const userKey = sanitizeUser(request.nextUrl.searchParams.get("user") ?? undefined);
  // Rate-limit SSE opens (prevent EventSource loop DoS); reuses turn limiter
  try {
    if (userKey) checkRateLimit(`stream:${userKey}`);
  } catch (e) {
    if (e instanceof RateLimitError) {
      return new Response(e.message, { status: 429, headers: { "Retry-After": String(Math.ceil(e.retryAfterMs / 1000)) } });
    }
    throw e;
  }

  // Replay reminders that came due while the client was closed. We subscribe
  // FIRST so the just-registered listener acks each replay push (the stream is a
  // real delivery target → daily reschedules, one-shot drops); takeDueReminders
  // fans the slots out to this listener, so nothing else is needed. Slots that
  // arrive with no ack stay due marked `missedAt` and replay on a later connect.
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const push: (r: Reminder) => boolean = (r) => {
        try {
          controller.enqueue(encoder.encode(frame(r)));
          return true;
        } catch {
          return false; // stream gone → slot not delivered → stays due for retry
        }
      };
      unsubscribe = subscribeReminders(push);
      if (userKey) takeDueReminders(userKey);
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          /* connection closed */
        }
      }, 20000);
      heartbeat.unref?.();
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      if (unsubscribe) unsubscribe();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}