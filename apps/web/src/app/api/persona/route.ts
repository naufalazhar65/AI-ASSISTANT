import { NextRequest, NextResponse } from "next/server";
import { upsertPersonaFact, personaFactsText, forgetPersonaFact, PersonaTarget } from "@/lib/persona";

export const runtime = "nodejs";

function requestUser(request: NextRequest, bodyUser?: unknown): string | undefined {
  return request.headers.get("x-mia-user")?.trim() || new URL(request.url).searchParams.get("user") || (typeof bodyUser === "string" ? bodyUser : undefined) || undefined;
}

/** GET /api/persona?user= — list stored facts (memory-unification read path). */
export async function GET(request: NextRequest) {
  return NextResponse.json({ facts: personaFactsText(requestUser(request)) });
}

/** DELETE /api/persona?user=&q= — forget facts matching a query. */
export async function DELETE(request: NextRequest) {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  return NextResponse.json({ result: forgetPersonaFact(requestUser(request), q) });
}

/**
 * POST /api/persona — Persist a stable user fact or style preference to this
 * user's persona .md files (USER.md / SOUL.md), OpenClaw-style. Body:
 * `{ target: "USER"|"SOUL", key, value, user? }`. The optional `user` keys the
 * per-user persona folder; when omitted, the shared template is used.
 */
export async function POST(request: NextRequest) {
  let body: { target?: string; key?: string; value?: string; user?: unknown };
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

  upsertPersonaFact(target, body.key.trim(), body.value.trim(), requestUser(request, body.user));
  return NextResponse.json({ ok: true });
}