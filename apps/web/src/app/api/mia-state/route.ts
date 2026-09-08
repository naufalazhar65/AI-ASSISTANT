import { NextRequest } from "next/server";
import { broadcastMiaState, getMiaState, subscribeMiaState } from "@/lib/miaState";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { state, text } = (await req.json()) as { state?: string; text?: string };
    if (state && typeof state === "string") broadcastMiaState(state, text);
  } catch {}
  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
}

export async function GET(req: NextRequest) {
  const stream = new ReadableStream({
    start(controller) {
      const send = (state: string, text?: string) => {
        controller.enqueue(`data: ${JSON.stringify({ state, text: text || undefined })}\n\n`);
      };
      send(getMiaState(), getMiaText());
      const unsub = subscribeMiaState(send);
      req.signal.addEventListener("abort", () => {
        unsub();
        controller.close();
      });
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
