import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const GROQ_TTS_URL = "https://api.groq.com/openai/v1/audio/speech";
const MODEL = "canopylabs/orpheus-v1-english";

const GROQ_VOICES = ["autumn", "diana", "hannah", "austin", "daniel", "troy"] as const;

/**
 * POST /api/tts — Text-to-speech (PRD FR-006).
 *
 * Body: `{ text, voice? }`. Returns the synthesized WAV audio bytes. The API
 * key stays server-side (invariant 5). Groq TTS is English + Arabic only, and
 * accepts up to 200 characters per request.
 */
export async function POST(request: NextRequest) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "GROQ_API_KEY is not set" }, { status: 500 });
  }

  let body: { text?: string; voice?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const text = (body.text ?? "").trim().slice(0, 200);
  if (!text) {
    return NextResponse.json({ error: "missing text" }, { status: 400 });
  }

  const defaultVoice = process.env.GROQ_VOICE ?? "hannah";
  const voice =
    (GROQ_VOICES as readonly string[]).includes(body.voice ?? "") ? body.voice! : defaultVoice;

  try {
    const res = await fetch(GROQ_TTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        input: text,
        voice,
        response_format: "wav",
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      return NextResponse.json(
        { error: `Groq TTS failed (${res.status}): ${detail}` },
        { status: 502 }
      );
    }

    const audio = await res.arrayBuffer();
    return new Response(audio, { headers: { "Content-Type": "audio/wav" } });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "TTS request failed" },
      { status: 502 }
    );
  }
}