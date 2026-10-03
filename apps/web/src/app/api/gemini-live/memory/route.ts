import { NextRequest, NextResponse } from "next/server";

import { appendDailyMemory } from "@/lib/dailyMemory";
import { auditLog } from "@/lib/auditLog";
import { formatLiveMemoryEntry } from "@/lib/liveTools";
import { verifyLiveTurn } from "@/lib/liveVerify";
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
 *
 * Phase 1 Live honesty guard (annotate-only): the turn narration is verified
 * against the Live tool ledger (lib/liveVerify) and the verdict rides along
 * as `verification: { verdict, note, executed }` — old clients ignore the
 * extra field. The memory write itself is untouched; flagged turns are also
 * audit-logged best-effort. Optional body `sinceMs` (turn start epoch ms)
 * scopes the ledger window; without it a 5-minute window applies.
 */
export async function POST(request: NextRequest) {
  const rawUser = request.headers.get("x-mia-user")?.trim() || undefined;
  const userKey = sanitizeUser(rawUser);
  if (!userKey) {
    return NextResponse.json({ error: "missing x-mia-user" }, { status: 400 });
  }
  let body: { heard?: unknown; said?: unknown; sinceMs?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const entry = formatLiveMemoryEntry(body?.heard, body?.said);
  if (!entry) {
    return NextResponse.json({ saved: false });
  }
  const verification = verifyLiveTurn(userKey, body?.said, body?.sinceMs);
  if (verification.verdict === "flagged") {
    try {
      auditLog(userKey, "live-verify-flagged", verification.note.slice(0, 500));
    } catch {
      /* logging is best-effort */
    }
  }
  try {
    appendDailyMemory(userKey, entry);
  } catch {
    return NextResponse.json({ error: "could not write memory" }, { status: 502 });
  }
  return NextResponse.json({ saved: true, verification });
}
