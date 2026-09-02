// Multi-session / resumable history (OpenClaw). Server-side per-user store, so
// sessions survive reload and any browser/device.
//
//   GET  /api/sessions?user=<u>          → { sessions: SessionMeta[] }
//   GET  /api/sessions?user=<u>&id=<s>   → { session: Session } | 404
//   POST /api/sessions                   → upsert { user, session_id?, conversation, title? } → { id }
//   DELETE /api/sessions                 → { user, session_id } → { ok }
//
// `user` is sanitized server-side and never used raw (invariant 5).

import { NextRequest } from "next/server";
import { listSessions, loadSession, upsertSession, deleteSession } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const user = request.nextUrl.searchParams.get("user") ?? undefined;
  const id = request.nextUrl.searchParams.get("id") ?? undefined;
  if (id !== undefined) {
    const session = loadSession(user, id);
    if (!session) return new Response("session not found", { status: 404 });
    return Response.json({ session });
  }
  return Response.json({ sessions: listSessions(user) });
}

export async function POST(request: NextRequest) {
  let body: {
    user?: unknown;
    session_id?: unknown;
    conversation?: unknown;
    title?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return new Response("invalid JSON body", { status: 400 });
  }
  if (!body.conversation || typeof body.conversation !== "object") {
    return new Response("conversation is required", { status: 400 });
  }
  const { id } = upsertSession(
    body.user,
    typeof body.session_id === "string" ? body.session_id : null,
    body.conversation as { messages: unknown[]; transcripts: { id: string; role: string; text: string; state: string }[] },
    typeof body.title === "string" ? body.title : undefined
  );
  return Response.json({ id });
}

export async function DELETE(request: NextRequest) {
  let body: { user?: unknown; session_id?: unknown };
  try {
    body = await request.json();
  } catch {
    return new Response("invalid JSON body", { status: 400 });
  }
  if (!body.session_id) return new Response("session_id is required", { status: 400 });
  deleteSession(body.user, body.session_id);
  return Response.json({ ok: true });
}