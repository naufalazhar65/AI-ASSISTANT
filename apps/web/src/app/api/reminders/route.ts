// GET/POST/DELETE /api/reminders — CRUD for per-user reminders (native clients).
//
// - GET ?user= → { reminders: Reminder[] }
// - POST { text, at, repeat?, user? } → { reminder } (at = epoch ms)
// - DELETE ?user=&q= → { removed: n } (substring match on text)
//
// `user` resolves from `x-mia-user` header, then `?user=`, then body.user —
// the same precedence the Live tool route uses. All users sanitized
// server-side (invariant 5). No secrets exposed.

import { NextRequest, NextResponse } from "next/server";
import { addReminder, deleteReminders, readReminders } from "@/lib/reminders";
import { sanitizeUser } from "@/lib/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function resolveUser(request: NextRequest, bodyUser?: unknown): string | null {
  return (
    sanitizeUser(request.headers.get("x-mia-user") ?? undefined) ||
    sanitizeUser(request.nextUrl.searchParams.get("user") ?? undefined) ||
    sanitizeUser(bodyUser)
  );
}

export async function GET(request: NextRequest) {
  const user = resolveUser(request);
  if (!user) return NextResponse.json({ error: "user required" }, { status: 400 });
  return NextResponse.json({ reminders: readReminders(user) });
}

export async function POST(request: NextRequest) {
  let body: { text?: unknown; at?: unknown; repeat?: unknown; user?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const user = resolveUser(request, body.user);
  if (!user) return NextResponse.json({ error: "user required" }, { status: 400 });
  if (typeof body.text !== "string" || !body.text.trim()) {
    return NextResponse.json({ error: "text required" }, { status: 400 });
  }
  const atMs = typeof body.at === "number" ? body.at : Date.parse(String(body.at ?? ""));
  if (!Number.isFinite(atMs)) {
    return NextResponse.json({ error: "at (epoch ms) required" }, { status: 400 });
  }
  try {
    const reminder = addReminder(body.text, atMs, user, {
      repeat: body.repeat === "daily" ? "daily" : undefined,
    });
    return NextResponse.json({ reminder });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "add failed" }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  const user = resolveUser(request);
  const q = request.nextUrl.searchParams.get("q") ?? "";
  if (!user) return NextResponse.json({ error: "user required" }, { status: 400 });
  if (!q.trim()) return NextResponse.json({ error: "q required" }, { status: 400 });
  return NextResponse.json({ removed: deleteReminders(user, q) });
}
