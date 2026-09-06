import { NextRequest, NextResponse } from "next/server";
import { authEnabled, authToken, isAuthorized } from "@/lib/authGuard";

export const dynamic = "force-dynamic";

const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!authEnabled()) {
    return NextResponse.json({ error: "auth not configured" }, { status: 400 });
  }
  const body = await req.json().catch(() => null);
  const pin = typeof body?.pin === "string" ? body.pin : "";
  if (!pin || pin !== authToken()) {
    return NextResponse.json({ error: "invalid pin" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set("mia_auth", authToken()!, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE,
  });
  return res;
}

export async function DELETE(): Promise<NextResponse> {
  const res = NextResponse.json({ ok: true });
  res.cookies.set("mia_auth", "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  return res;
}

export function GET(req: NextRequest): NextResponse {
  const cookie = req.cookies.get("mia_auth")?.value ?? null;
  const bearer = req.headers.get("authorization");
  return NextResponse.json({
    enabled: authEnabled(),
    authed: isAuthorized(cookie, bearer?.startsWith("Bearer ") ? bearer.slice(7) : undefined),
  });
}