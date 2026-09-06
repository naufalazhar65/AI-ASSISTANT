import { NextRequest, NextResponse } from "next/server";
import { TtsError, synthesizeSpeech } from "../../../lib/tts";

export const runtime = "nodejs";

/**
 * POST /api/tts — Text-to-speech (PRD FR-006, FR-010). Thin HTTP wrapper around
 * the shared `synthesizeSpeech` core (`lib/tts.ts`) so the web live-voice path
 * and the bot adapters share one pipeline. Body: `{ text, voice? }`. Returns
 * the synthesized WAV audio bytes; the key stays server-side.
 */
export async function POST(request: NextRequest) {
  let body: { text?: string; voice?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    const audio = await synthesizeSpeech({ text: body.text ?? "", voice: body.voice });
    return new Response(new Uint8Array(audio), { headers: { "Content-Type": "audio/wav" } });
  } catch (err) {
    if (err instanceof TtsError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "TTS request failed" },
      { status: 502 }
    );
  }
}