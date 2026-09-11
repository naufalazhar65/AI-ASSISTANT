import { NextResponse } from "next/server";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { appRoot } from "@/lib/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/health — liveness + dependency reachability (no secrets leaked).
// Checks: .data writable, provider key present (presence only).
export async function GET() {
  const checks: Record<string, string> = {};
  let ok = true;

  // .data writable
  try {
    const dir = join(appRoot(), ".data");
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, ".health_probe");
    writeFileSync(probe, String(Date.now()));
    unlinkSync(probe);
    checks.data = "ok";
  } catch (e) {
    ok = false;
    checks.data = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }

  // provider key presence (no value logged)
  const hasGroq = !!process.env.GROQ_API_KEY;
  const hasGo = !!process.env.OPENCODEGO_API_KEY;
  const hasRouter = !!process.env.LLM_API_KEY;
  checks.provider = hasGroq || hasGo || hasRouter ? "ok" : "no key configured";
  if (checks.provider !== "ok") ok = false;

  // auth mode (informational)
  checks.auth = process.env.AUTH_TOKEN ? "enabled" : "open (set AUTH_TOKEN for public)";

  return NextResponse.json({ ok, checks }, { status: ok ? 200 : 503 });
}
