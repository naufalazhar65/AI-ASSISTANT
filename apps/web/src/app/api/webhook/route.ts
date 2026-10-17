import { NextRequest, NextResponse } from "next/server";
import { runAssistantTurn } from "@/lib/agent";
import { defaultProviderId } from "@/lib/providers";
import { pushToOwner, sendToChannel } from "@/channels/pushTarget";
import { chunkText, DISCORD_MAX } from "@/channels/replyChunk";
import { isAgentLabel } from "@/lib/agentRole";

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
  const { secret, prompt, user, provider, agent, deliver_to: deliverToRaw } = body as {
    secret?: unknown;
    prompt?: unknown;
    user?: unknown;
    provider?: unknown;
    agent?: unknown;
    deliver_to?: unknown;
  };

  // Which trio member this turn belongs to. Without it `applyAgentRole` never
  // runs, so Agnes answered a task addressed to her with Mia's coordinator
  // voice — observed live 2026-10-12: "Agnes, tolong riset …" as the reply to a
  // task the dashboard had assigned TO Agnes.
  const agentLabel = isAgentLabel(agent) ? agent : undefined;

  // Which channel the result must actually reach. `pushToOwner` prefers the
  // most-recently-registered adapter and then falls back through the other
  // registered ones (2026-10-17 — it used to trust that one label alone, so a
  // webhook result died with "no slack owner channel seen"), which means a caller
  // that asked for Discord can still be delivered to Slack. Naming the channel
  // keeps delivery exact and verifiable.
  const deliverTo =
    typeof deliverToRaw === "string" && deliverToRaw.trim() ? deliverToRaw.trim() : "";

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
  const providerId = typeof provider === "string" && provider.trim() ? provider.trim() : process.env.WEBHOOK_PROVIDER || defaultProviderId();

  try {
    const result = await runAssistantTurn({
      messages: [{ role: "user", content: promptStr }],
      provider: providerId,
      user: userKey,
      channel: "text",
      agent: agentLabel,
      // When deliverTo is set this route pushes the reply itself below, so the
      // model must NOT also send_channel -- that would deliver it twice.
      ...(deliverTo ? { systemDelivers: deliverTo } : {}),
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
    const note = `🔔 *Webhook* — ${promptStr}\n${text}`;

    // Deliver to the NAMED channel when asked, otherwise best-effort to the
    // owner's current channel as before. `push_error` is returned so the caller
    // can report WHY delivery failed instead of a bare false.
    let pushed = false;
    let pushError: string | null = null;
    if (deliverTo) {
      try {
        // Discord rejects bodies over 2000 chars ("Invalid Form Body
        // content[BASE_TYPE_MAX_LENGTH]"). A long research answer therefore used
        // to fail at the very last step — after the turn had already succeeded —
        // so split before sending instead.
        for (const part of chunkText(note, DISCORD_MAX)) {
          await sendToChannel(deliverTo, part);
        }
        pushed = true;
      } catch (err) {
        pushError = err instanceof Error ? err.message : String(err);
      }
    } else {
      pushed = await pushToOwner(note).catch(() => false);
      if (!pushed) pushError = "no owner channel could receive the push";
    }

    return NextResponse.json({
      status: "ok",
      text,
      pushed,
      delivered_to: deliverTo || null,
      push_error: pushError,
    });
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
