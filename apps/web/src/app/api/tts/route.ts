import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const GROQ_TTS_URL = "https://api.groq.com/openai/v1/audio/speech";

// FR-010: Groq Orpheus ships language-specific models. English is the default
// fallback; Arabic (Saudi) is available as a secondary model. A sentence is
// auto-routed to Arabic when its script is Arabic, otherwise the English model
// speaks it (Indonesian and other languages fall back to English pronunciation).
const MODEL_EN = "canopylabs/orpheus-v1-english";
const MODEL_AR = "canopylabs/orpheus-arabic-saudi";

const GROQ_VOICES_EN = ["autumn", "diana", "hannah", "austin", "daniel", "troy"] as const;
const GROQ_VOICES_AR = ["abdullah", "fahad", "sultan", "lulwa", "noura", "aisha"] as const;

const ARABIC_DEFAULT_VOICE = "lulwa";

/** Heuristic language detector (FR-010): Arabic script ⇢ Arabic model, else English. */
function detectModel(text: string): { model: string; voices: readonly string[] } {
  // Arabic Unicode block covers U+0600–U+06FF (plus extensions).
  if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text)) {
    return { model: MODEL_AR, voices: GROQ_VOICES_AR };
  }
  return { model: MODEL_EN, voices: GROQ_VOICES_EN };
}

/**
 * POST /api/tts — Text-to-speech (PRD FR-006, FR-010).
 *
 * Body: `{ text, voice? }`. Returns the synthesized WAV audio bytes. The API
 * key stays server-side (invariant 5). Language is auto-detected per sentence:
 * Arabic script → the Saudi Arabic Orpheus model; everything else → English
 * Orpheus (the fallback that also reads Indonesian, English, etc.).
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

  const { model, voices } = detectModel(text);

  const defaultVoice =
    model === MODEL_AR ? process.env.GROQ_VOICE_AR ?? ARABIC_DEFAULT_VOICE : process.env.GROQ_VOICE ?? "hannah";
  const voice = (voices as readonly string[]).includes(body.voice ?? "") ? body.voice! : defaultVoice;

  try {
    const res = await fetch(GROQ_TTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
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