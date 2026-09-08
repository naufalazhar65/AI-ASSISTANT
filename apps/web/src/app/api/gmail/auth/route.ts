import { NextRequest, NextResponse } from "next/server";
import { gmailAuthUrl, gmailConfigured } from "@/lib/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!gmailConfigured()) {
    return NextResponse.json({ error: "Gmail is not configured. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET." }, { status: 500 });
  }
  const user = req.nextUrl.searchParams.get("user") || "";
  const url = gmailAuthUrl(user);
  return NextResponse.redirect(url);
}
