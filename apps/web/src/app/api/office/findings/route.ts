import { NextResponse } from "next/server";
import { readFindings } from "@/lib/security";
import { reportCardsFromFindings } from "@/lib/officeChat";
import { resolveOwnerScopedKey } from "@/lib/identity";

export const dynamic = "force-dynamic";

/**
 * Security findings for the office dashboard (DESIGN.md §14).
 *
 * Auth: the shared middleware already gates /api/* with AUTH_TOKEN (cookie or
 * Bearer); the dashboard proxies with `Authorization: Bearer` like the bus.
 *
 * The owner is pinned server-side: the browser never chooses whose findings it
 * reads, and every agent alias (.agnes/.michelle/Zigen) folds into the same
 * owner-scoped store.
 */
export async function GET(): Promise<NextResponse> {
  const key = resolveOwnerScopedKey(process.env.OFFICE_OWNER_USER || "naufalazhar652952");
  const findings = readFindings(key ?? undefined);
  return NextResponse.json({ cards: reportCardsFromFindings(findings) });
}
