import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * POST /api/gemini-live/tool-ping — diagnostic beacon, nothing more.
 *
 * The browser fires it (no auth, no user header needed) whenever the Live
 * model emits a `tool_call` frame, BEFORE execution. It exists for one
 * failure mode (owner 2026-10-01): the model chatting through the confirm
 * flow without ever emitting a call — invisible otherwise, since an
 * unemitted call never reaches the tool route. Names only, never args.
 * Temporary by design; delete once the emission gap is understood.
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { names?: unknown };
    const names = Array.isArray(body.names) ? body.names.filter((n): n is string => typeof n === "string") : [];
    console.log(`[live-tool-ping] model emitted: ${names.join(", ") || "(none)"}`);
  } catch {
    // Never fail the caller.
  }
  return NextResponse.json({ ok: true });
}
