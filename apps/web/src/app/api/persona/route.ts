import { NextRequest, NextResponse } from "next/server";
import { upsertPersonaFact, PersonaTarget } from "@/lib/persona";

export const runtime = "nodejs";

/**
 * POST /api/persona — Persist a stable user fact or style preference to the
 * persona .md files (USER.md / SOUL.md), OpenClaw-style. Body:
 * `{ target: "USER"|"SOUL", key, value }`.
 */
export async function POST(request: NextRequest) {
  let body: { target?: string; key?: string; value?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const target = body.target as PersonaTarget;
  if (target !== "USER" && target !== "SOUL") {
    return NextResponse.json({ error: "target must be USER or SOUL" }, { status: 400 });
  }
  if (!body.key?.trim() || !body.value?.trim()) {
    return NextResponse.json({ error: "missing key or value" }, { status: 400 });
  }

  upsertPersonaFact(target, body.key.trim(), body.value.trim());
  return NextResponse.json({ ok: true });
}