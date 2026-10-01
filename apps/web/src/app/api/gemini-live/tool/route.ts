import { NextRequest, NextResponse } from "next/server";

import { executeTool } from "@/lib/tools";
import { auditLog } from "@/lib/auditLog";
import { LIVE_WRITE_TOOLS, isLiveToolName } from "@/lib/liveTools";
import { sanitizeUser } from "@/lib/users";

export const runtime = "nodejs";

/**
 * POST /api/gemini-live/tool — execute Gemini Live function calls server-side.
 *
 * The browser's Live session speaks to Google directly, so when the model
 * invokes a declared tool the browser POSTs here and this route runs the real
 * implementation. Body: `{ calls: [{ id?, name, args? }] }`. The user is read
 * from the `x-mia-user` header (same contract as the token route); without it
 * the owner's store cannot be reached, so per-user tools answer honestly
 * instead of executing against the wrong person.
 *
 * Every call name is re-checked against `LIVE_TOOL_NAMES`: a declaration in
 * `setup` without a matching allowlist entry here executes nothing, so a
 * tampered client cannot reach the other 300+ tools by naming them.
 *
 * Results are truncated: a tool dump must fit back into a voice turn, and an
 * unbounded result would stall the synchronous Live call even longer.
 */
const RESULT_MAX_CHARS = 2_000;

interface LiveToolCall {
  id?: unknown;
  name?: unknown;
  args?: unknown;
}

export async function POST(request: NextRequest) {
  let body: { calls?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body || !Array.isArray(body.calls)) {
    return NextResponse.json({ error: "body.calls must be an array" }, { status: 400 });
  }

  const rawUser = request.headers.get("x-mia-user")?.trim() || undefined;
  const userKey = sanitizeUser(rawUser);
  const results = [];
  for (const [index, raw] of (body.calls as LiveToolCall[]).entries()) {
    const call = (raw ?? {}) as LiveToolCall;
    const id = typeof call.id === "string" && call.id ? call.id : `live-${index}`;
    const name = typeof call.name === "string" ? call.name : "";
    if (!isLiveToolName(name)) {
      // No-trace refusals are undebuggable (owner 2026-10-01: a confirm re-call
      // without the flag vanishes here while the model claims success). Log the
      // decision best-effort — never let logging break the route.
      try {
        auditLog(rawUser ?? userKey ?? undefined, `tool:${name || "(missing)"}::live-refused-unknown`, "");
      } catch {
        /* logging is best-effort */
      }
      results.push({ id, name, result: `Error: tool "${name || "(missing)"}" is not available in voice mode.` });
      continue;
    }
    // Voice write actions (gap #2, FR-014): the spoken-confirmation loop lives
    // in the client (`liveConfirm.ts`), and this route enforces its outcome
    // statelessly — a write call without `confirmed: true` executes nothing,
    // so skipping the client still cannot produce an unconsented side effect.
    const argsObj = (call.args && typeof call.args === "object" && !Array.isArray(call.args)
      ? call.args
      : {}) as Record<string, unknown>;
    if ((LIVE_WRITE_TOOLS as readonly string[]).includes(name) && argsObj.confirmed !== true) {
      try {
        auditLog(rawUser ?? userKey ?? undefined, `tool:${name}::live-refused-unconfirmed`, "");
      } catch {
        /* logging is best-effort */
      }
      results.push({
        id,
        name,
        result:
          `Error: '${name}' butuh konfirmasi lisan dulu (FR-014). ` +
          `Tanyakan ke user dengan suara dan panggil lagi dengan confirmed:true ` +
          `hanya kalau user menjawab ya/iya/boleh/oke.`,
      });
      continue;
    }
    let argsJson = "{}";
    try {
      argsJson = JSON.stringify(call.args ?? {});
    } catch {
      argsJson = "{}";
    }
    try {
      const out = await executeTool({ id, name, arguments: argsJson }, rawUser ?? userKey ?? undefined);
      results.push({ id, name, result: (out ?? "").slice(0, RESULT_MAX_CHARS) });
    } catch (err) {
      results.push({
        id,
        name,
        result: `Error: ${err instanceof Error ? err.message.slice(0, 200) : "tool execution failed"}`,
      });
    }
  }
  return NextResponse.json({ results });
}
