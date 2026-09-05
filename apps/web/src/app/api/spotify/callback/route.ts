import { NextRequest, NextResponse } from "next/server";
import { exchangeSpotifyCode } from "@/lib/spotify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/spotify/callback?code=...&state=<user> — OAuth callback.
// Exchanges the code for a refresh token, stores it per-user, then redirects
// back to the web UI. The `state` (set by /api/spotify/auth) is the sanitized
// user key.
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code") || "";
  const error = req.nextUrl.searchParams.get("error") || "";
  const state = req.nextUrl.searchParams.get("state") || "";
  const origin = req.nextUrl.origin;
  if (error) {
    return NextResponse.redirect(`${origin}/?spotify=denied`);
  }
  if (!code || !state) {
    return NextResponse.redirect(`${origin}/?spotify=error`);
  }
  try {
    await exchangeSpotifyCode(code, state);
    return NextResponse.redirect(`${origin}/?spotify=connected`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Spotify auth failed";
    return NextResponse.redirect(`${origin}/?spotify=error:${encodeURIComponent(msg)}`);
  }
}