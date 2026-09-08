import { NextRequest, NextResponse } from "next/server";
import { exchangeGmailCode } from "@/lib/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code") || "";
  const state = req.nextUrl.searchParams.get("state") || "";
  const error = req.nextUrl.searchParams.get("error") || "";
  if (error) return NextResponse.redirect(new URL("/?gmail=denied", req.url));
  if (!code || !state) return NextResponse.redirect(new URL("/?gmail=error", req.url));
  try {
    await exchangeGmailCode(code, state);
    return NextResponse.redirect(new URL("/?gmail=connected", req.url));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.redirect(new URL(`/?gmail=error:${encodeURIComponent(msg.slice(0, 80))}`, req.url));
  }
}
