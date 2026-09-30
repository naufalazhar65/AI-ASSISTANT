import { NextRequest, NextResponse } from "next/server";

import { appendDailyMemory } from "@/lib/dailyMemory";
import { formatLiveMemoryEntry } from "@/lib/liveTools";
import { sanitizeUser } from "@/lib/users";

export const runtime = "nodejs";

/**
 * POST /api/gemini-live/memory — write one completed Live turn into today's
 * daily memory, so the conversation is remembered exactly like a chat turn.
 * Body: `{ heard?, said? }` (per-turn accumulated transcripts). The user comes
 * from the `x-mia-user` header (same contract as the token and tool routes);
 * a missing/invalid user is a 400, never a silent write to `shared` — an
 * anonymous voice turn must not pollute anyone's memory.
 *
 * The entry uses the identical `User:`/`Mia:` shape the chat path writes, so
 * recall (BM25, recap, RAG) needs no Live-specific handling. Best-effort by
 * design: the caller fires and forgets, and failures surface as
 * `{ saved: false }`, never as an exception — losing one turn's note must
 * never break a voice session.
 */
export async function POST(request: NextRequest) {
  const rawUser = request.headers.get("x-mia-user")?.trim() || undefined;
  const userKey = sanitizeUser(rawUser);
  if (!userKey) {
    return NextResponse.json({ error: "missing x-mia-user" }, { status: 400 });
  }
  let body: { heard?: unknown; said?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const entry = formatLiveMemoryEntry(body?.heard, body?.said);
  if (!entry) {
    return NextResponse.json({ saved: false });
  }
  try {
    appendDailyMemory(userKey, entry);
  } catch {
    return NextResponse.json({ error: "could not write memory" }, { status: 502 });
  }
  return NextResponse.json({ saved: true });
}
