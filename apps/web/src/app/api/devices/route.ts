import { NextRequest, NextResponse } from "next/server";
import { pairDevice, listDevices, listDevicesText } from "@/lib/devices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/devices?user=xxx — list devices for a user
export async function GET(req: NextRequest) {
  const user = req.nextUrl.searchParams.get("user") || "";
  const text = listDevicesText(user);
  return NextResponse.json({ devices: listDevices(user), text });
}

// POST /api/devices — pair a new device
// Body: { secret, user, name, platform, capabilities }
// capabilities: array of "screenshot" | "exec" | "location" | "camera"
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const { secret, user, name, platform, capabilities } = body as {
    secret?: unknown;
    user?: unknown;
    name?: unknown;
    platform?: unknown;
    capabilities?: unknown;
  };
  if (typeof user !== "string" || !user.trim()) {
    return NextResponse.json({ error: "user is required" }, { status: 400 });
  }
  try {
    const device = pairDevice(
      user,
      typeof secret === "string" ? secret : "",
      typeof name === "string" ? name : "",
      (typeof platform === "string" ? platform : "macos") as "macos" | "ios" | "android",
      Array.isArray(capabilities) ? (capabilities as ("screenshot" | "exec" | "location" | "camera")[]) : ["screenshot", "exec"]
    );
    return NextResponse.json({ status: "paired", device });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = /invalid secret/.test(msg) ? 401 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}
