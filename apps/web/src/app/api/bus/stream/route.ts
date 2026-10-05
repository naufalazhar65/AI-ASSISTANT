// GET /api/bus/stream — Server-Sent Events untuk Event Bus formal
// (PRD Pixel Office §7 Fase 1).
//
// Klien (Pixel Office, debug, Discord trio) membuka stream ini dan menerima
// satu frame per event: `data: {id,ts,user,turn,task_id,type,actor,summary,…}`.
// Bus murni display-only: tidak ada ack/consumes — event tetap tersimpan di
// buffer 200 (drop-oldest) dan audit log tetap menjadi history durable.
//
// Query:
// - `user=` kunci user (wajib untuk menerima event; tanpa kunci stream dibuka
//   tapi tidak menerima apa pun — pola yang sama dengan reminders/stream).
// - `since=` cursor seq opsional: replay event yang terlewat lalu lanjut live.
//   Tanpa cursor, ekor 20 event terakhir dikirim sebagai konteks visual.
//
// Security: user disanitasi server-side (invariant 5); payload event tidak
// pernah membawa argumen tool mentah (hanya nama + status + ringkasan).
import { NextRequest } from "next/server";
import { busEventsSince, busTail, subscribeBus } from "@/lib/bus";
import { sanitizeUser } from "@/lib/users";
import { checkRateLimit, RateLimitError } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const userKey = sanitizeUser(request.nextUrl.searchParams.get("user") ?? undefined);
  const sinceRaw = request.nextUrl.searchParams.get("since") ?? "";
  const since = /^\d+$/.test(sinceRaw) ? parseInt(sinceRaw, 10) : -1;
  try {
    if (userKey) checkRateLimit(`bus:${userKey}`);
  } catch (e) {
    if (e instanceof RateLimitError) {
      return new Response(e.message, { status: 429, headers: { "Retry-After": String(Math.ceil(e.retryAfterMs / 1000)) } });
    }
    throw e;
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (e: { id: string }) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          /* stream gone */
        }
      };
      // Replay dulu (cursor atau ekor), BARU subscribe live — urutan ini
      // menjamin tidak ada event yang terlewat di antaranya.
      if (userKey) {
        const replay = since >= 0 ? busEventsSince(since, userKey).events : busTail(20, userKey);
        for (const e of replay) send(e);
      }
      unsubscribe = subscribeBus((e) => {
        if (!userKey || e.user !== userKey) return;
        send(e);
      });
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
