import { NextRequest, NextResponse } from "next/server";
import { runAssistantTurn } from "@/lib/agent";
import { pushToOwner } from "@/channels/pushTarget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/webhook — trigger a prompt via external webhook (e.g. GitHub, n8n, cron).
// Body: { secret?: string, prompt: string, user?: string, provider?: string }
// If WEBHOOK_SECRET is set, the request must include the same secret.
// The prompt is run as a one-off assistant turn and the result is pushed to
// the owner's active channel (if any) and also returned in the response.
export async function POST(req: NextRequest) {
  const expectedSecret = process.env.WEBHOOK_SECRET;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const { secret, prompt, user, provider } = body as {
    secret?: unknown;
    prompt?: unknown;
    user?: unknown;
    provider?: unknown;
  };

  if (expectedSecret) {
    if (typeof secret !== "string" || secret !== expectedSecret) {
      return NextResponse.json({ error: "invalid secret" }, { status: 401 });
    }
  }

  const promptStr = typeof prompt === "string" ? prompt.trim() : "";
  if (!promptStr) {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }
  if (promptStr.length > 2000) {
    return NextResponse.json({ error: "prompt too long (max 2000)" }, { status: 400 });
  }

  const userKey = typeof user === "string" && user.trim() ? user.trim() : process.env.WEBHOOK_USER || "naufal";
  const providerId = typeof provider === "string" && provider.trim() ? provider.trim() : process.env.WEBHOOK_PROVIDER || "groq";

  try {
    const result = await runAssistantTurn({
      messages: [{ role: "user", content: promptStr }],
      provider: providerId,
      user: userKey,
      channel: "text",
    });

    // If the model asked for a risky tool, we can't auto-confirm via webhook — just return the confirmation request
    if (result.needsConfirmation?.length) {
      return NextResponse.json({
        status: "needs_confirmation",
        tool: result.needsConfirmation[0],
        message: "Tool requires confirmation — not auto-executed via webhook",
      });
    }

    const text = result.text || "(no reply)";
    // Best-effort push to owner channel (if any active)
    const pushed = await pushToOwner(`🔔 *Webhook* — ${promptStr}\n${text}`).catch(() => false);

    return NextResponse.json({ status: "ok", text, pushed });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[webhook] failed:", msg);
    // Return 502 for provider/LLM failures so the caller knows to retry
    const isProvider = /LLM failed|rate limit|quota|provider/i.test(msg);
    return NextResponse.json({ error: msg }, { status: isProvider ? 502 : 500 });
  }
}

export async function GET() {
  return NextResponse.json({ status: "ok", usage: "POST /api/webhook with {secret, prompt, user?, provider?}" });
}
