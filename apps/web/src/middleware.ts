import { NextRequest, NextResponse } from "next/server";
import { authEnabled, isAuthorized, isPublicPath, bearerFrom } from "@/lib/authGuard";

/** Incremental auth gate. No-op unless AUTH_TOKEN is configured. */
export function middleware(req: NextRequest): NextResponse {
  if (!authEnabled()) return NextResponse.next();
  const { pathname } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();
  const cookie = req.cookies.get("mia_auth")?.value ?? null;
  const bearer = bearerFrom(req.headers.get("authorization"));
  if (isAuthorized(cookie, bearer)) return NextResponse.next();
  if (pathname === "/") return NextResponse.redirect(new URL("/login", req.url));
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

export const config = {
  matcher: ["/", "/api/:path*"],
};