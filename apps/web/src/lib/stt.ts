import { cfgStr } from "./config";

export const STT_PROVIDERS = ["groq", "9router"] as const;
export type SttProvider = (typeof STT_PROVIDERS)[number];

const GROQ_STT_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3-turbo";

export class SttError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

export function resolveSttProvider(override?: string): SttProvider {
  const p = (override ?? cfgStr("STT_PROVIDER", "groq")) as string;
  return (STT_PROVIDERS as readonly string[]).includes(p) ? (p as SttProvider) : "groq";
}

/** Map a MIME type to the audio format accepted by the 9router/Gemini path. */
function audioFormatFor(contentType: string): string | null {
  const ct = contentType.toLowerCase();
  if (ct.includes("webm")) return "webm";
  if (ct.includes("wav") || ct.includes("pcm")) return "wav";
  if (ct.includes("mpeg") || ct.includes("mp3")) return "mp3";
  if (ct.includes("ogg") || ct.includes("oga") || ct.includes("opus")) return "ogg";
  return null;
}

/** Extract assistant content from an SSE-streamed chat completion body. */
function extractSseText(raw: string): string {
  let out = "";
  for (const line of raw.split(/\r?\n/)) {
    const l = line.trim();
    if (!l.startsWith("data:")) continue;
    const payload = l.slice(5).trim();
    if (payload === "[DONE]") continue;
    try {
      const d = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
      out += d.choices?.[0]?.delta?.content ?? "";
    } catch {
      // skip malformed chunk
    }
  }
  return out;
}

/**
 * Shared speech-to-text (PRD FR-003). Used by the web `/api/stt` route AND the
 * Telegram/Discord bot adapters so voice notes go through the same pipeline
 * with no HTTP-to-self. Provider:
 * - `groq`  — Whisper (`whisper-large-v3-turbo`), needs GROQ_API_KEY. Best quality.
 * - `9router` — Gemini `audioInput` via the OpenAI-compatible router
 *   (LLM_API_BASE + LLM_API_KEY), accepts webm/wav/mp3/ogg, zero Groq quota.
 *
 * Returns the transcript (empty string when nothing was understood).
 * Throws SttError on provider failure; the API key stays server-side.
 */
export async function transcribeAudio(input: {
  bytes: ArrayBuffer | Buffer;
  contentType?: string;
  provider?: SttProvider;
}): Promise<string> {
  const provider = input.provider ?? resolveSttProvider();
  const bytes = input.bytes;
  if (!bytes || bytes.byteLength === 0) {
    throw new SttError("empty audio", 400);
  }
  // Normalize to a Buffer so both arrayBuffer (web route) and Buffer (bots) work.
  const bb = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const buf = Buffer.from(bb.buffer, bb.byteOffset, bb.byteLength);
  const contentType = input.contentType ?? "";

  if (provider === "9router") {
    const apiBase = cfgStr("LLM_API_BASE", "");
    const apiKey = cfgStr("LLM_API_KEY", "");
    if (!apiBase || !apiKey) {
      throw new SttError("9router STT needs LLM_API_BASE and LLM_API_KEY");
    }
    const format = audioFormatFor(contentType);
    if (!format) {
      throw new SttError(`unsupported audio type "${contentType || "unknown"}"; use webm/wav/mp3/ogg`, 400);
    }
    const b64 = buf.toString("base64");
    const model = cfgStr("STT_9ROUTER_MODEL", "gemini/gemini-3.5-flash-lite");
    const reqBody = JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 400,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Transcribe the speech in this audio exactly, in the same language it was spoken. Output ONLY the transcription text and nothing else.",
            },
            { type: "input_audio", input_audio: { data: b64, format } },
          ],
        },
      ],
    });
    const res = await fetch(apiBase, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: reqBody,
    });
    const raw = await res.text();
    if (!res.ok) {
      throw new SttError(`9router STT failed (${res.status}): ${raw.slice(0, 300)}`);
    }
    let transcript = "";
    if (raw.trim().startsWith("data:")) {
      transcript = extractSseText(raw);
    } else {
      try {
        const d = JSON.parse(raw) as { choices?: { message?: { content?: string } }[] };
        transcript = d.choices?.[0]?.message?.content ?? "";
      } catch {
        throw new SttError(`9router STT returned an unparseable body: ${raw.slice(0, 300)}`);
      }
    }
    return transcript.trim();
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new SttError("GROQ_API_KEY is not set", 500);
  }
  // Preserve the upload's declared format so Groq can decode it (WebM from the
  // MediaRecorder, OGG from Telegram voice notes, WAV/MP3 elsewhere).
  const ext = contentType.includes("wav")
    ? "wav"
    : contentType.includes("mp3")
      ? "mp3"
      : contentType.includes("ogg") || contentType.includes("oga") || contentType.includes("opus")
        ? "ogg"
        : "webm";
  const upstream = new FormData();
  const exact = new ArrayBuffer(buf.byteLength);
  new Uint8Array(exact).set(buf);
  upstream.append("file", new Blob([exact], { type: contentType || "audio/webm" }), `recording.${ext}`);
  upstream.append("model", GROQ_MODEL);
  const res = await fetch(GROQ_STT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: upstream,
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new SttError(`Groq STT failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const data = (await res.json()) as { text?: string };
  return (data.text ?? "").trim();
}