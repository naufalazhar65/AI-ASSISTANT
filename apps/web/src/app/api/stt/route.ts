import { NextRequest, NextResponse } from "next/server";
import { SttError, transcribeAudio, resolveSttProvider } from "../../../lib/stt";

export const runtime = "nodejs";

const VALID_PROVIDERS = ["groq", "9router"];

/**
 * POST /api/stt — Speech-to-text (PRD FR-003). Thin HTTP wrapper around the
 * shared `transcribeAudio` core (`lib/stt.ts`) so the web live-voice path and
 * the bot adapters share one pipeline. Provider via `STT_PROVIDER`
 * env/config (default `groq`) or a per-request `?provider=` override.
 */
export async function POST(request: NextRequest) {
  const providerParam = request.nextUrl.searchParams.get("provider");
  if (providerParam && !VALID_PROVIDERS.includes(providerParam)) {
    return NextResponse.json(
      { error: `invalid provider "${providerParam}" (valid: ${VALID_PROVIDERS.join(", ")})` },
      { status: 400 }
    );
  }
  const provider = resolveSttProvider(providerParam ?? undefined);
  const bytes = await request.arrayBuffer();
  const contentType = request.headers.get("content-type") ?? "";

  try {
    const transcript = await transcribeAudio({ bytes, contentType, provider });
    console.log("[stt] done", provider, bytes.byteLength, "bytes");
    return NextResponse.json({ transcript });
  } catch (err) {
    if (err instanceof SttError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "STT request failed" },
      { status: 502 }
    );
  }
}