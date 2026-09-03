import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const GROQ_STT_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const MODEL = "whisper-large-v3-turbo";

/**
 * POST /api/stt — Speech-to-text (PRD FR-003).
 *
 * Receives a recorded audio blob, forwards it to Groq Whisper, returns JSON:
 * `{ transcript }`. The API key stays server-side (invariant 5).
 */
export async function POST(request: NextRequest) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "GROQ_API_KEY is not set" }, { status: 500 });
  }

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) {
    return NextResponse.json({ error: "empty audio" }, { status: 400 });
  }
  console.log("[stt] receive", bytes.byteLength, "bytes");

  // Preserve the upload's declared format so Groq can decode it. MediaRecorder
  // sends WebM/Opus; other clients may send WAV/MP3. The filename + content
  // type must both match — Groq rejects a mismatched or unnamed audio part.
  const contentType = request.headers.get("content-type") ?? "audio/webm";
  const ext = contentType.includes("wav") ? "wav" : contentType.includes("mp3") ? "mp3" : "webm";

  const upstream = new FormData();
  const blob = new Blob([bytes], { type: contentType });
  upstream.append("file", blob, `recording.${ext}`);
  upstream.append("model", MODEL);

  try {
    const res = await fetch(GROQ_STT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: upstream,
    });

    if (!res.ok) {
      const detail = await res.text();
      return NextResponse.json(
        { error: `Groq STT failed (${res.status}): ${detail}` },
        { status: 502 }
      );
    }

    const data = (await res.json()) as { text?: string };
    return NextResponse.json({ transcript: data.text ?? "" });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "STT request failed" },
      { status: 502 }
    );
  }
}