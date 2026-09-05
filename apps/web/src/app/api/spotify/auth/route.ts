import { NextRequest, NextResponse } from "next/server";
import { spotifyAuthUrl, spotifyConfigured } from "@/lib/spotify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/spotify/auth?user=xxx → 302 redirect to Spotify's authorization page.
// `state` carries the sanitized user key so the callback knows whose store to
// write the token into. Keys/state never leave the server (invariant 5).
export async function GET(req: NextRequest) {
  if (!spotifyConfigured()) {
    return NextResponse.json({ error: "Spotify is not configured (set SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET)" }, { status: 500 });
  }
  const user = req.nextUrl.searchParams.get("user") || "";
  const url = spotifyAuthUrl(user);
  return NextResponse.redirect(url);
}