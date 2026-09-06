import { cfgStr } from "./config";

const GROQ_TTS_URL = "https://api.groq.com/openai/v1/audio/speech";

// FR-010: Groq Orpheus ships language-specific models. English is the default
// fallback; Arabic (Saudi) is available as a secondary model. A text is
// auto-routed to Arabic when its script is Arabic, otherwise the English model
// speaks it (Indonesian and other languages fall back to English pronunciation).
const MODEL_EN = "canopylabs/orpheus-v1-english";
const MODEL_AR = "canopylabs/orpheus-arabic-saudi";

const GROQ_VOICES_EN = ["autumn", "diana", "hannah", "austin", "daniel", "troy"] as const;
const GROQ_VOICES_AR = ["abdullah", "fahad", "sultan", "lulwa", "noura", "aisha"] as const;

const ARABIC_DEFAULT_VOICE = "lulwa";
/** Orpheus only ever returns WAV; cap input to stay inside the model limits. */
const MAX_INPUT_CHARS = 4000;

export class TtsError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

/** Heuristic language detector (FR-010): Arabic script ⇢ Arabic model, else English. */
export function detectTtsModel(text: string): { model: string; voices: readonly string[] } {
  // Arabic Unicode block covers U+0600–U+06FF (plus extensions).
  if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text)) {
    return { model: MODEL_AR, voices: GROQ_VOICES_AR };
  }
  return { model: MODEL_EN, voices: GROQ_VOICES_EN };
}

/**
 * Shared text-to-speech (PRD FR-006, FR-010). Used by the web `/api/tts` route
 * AND the Telegram/Discord bot adapters so voice replies go through one
 * pipeline with no HTTP-to-self. Returns a WAV buffer (Orpheus only outputs
 * WAV). Language auto-detected: Arabic script → Saudi Arabic model, else the
 * English Orpheus (the fallback that also reads Indonesian/English). Throws
 * TtsError on provider failure; the API key stays server-side.
 */
export async function synthesizeSpeech(input: { text: string; voice?: string }): Promise<Buffer> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new TtsError("GROQ_API_KEY is not set", 500);
  }
  const text = (input.text ?? "").trim().slice(0, MAX_INPUT_CHARS);
  if (!text) {
    throw new TtsError("missing text", 400);
  }

  const { model, voices } = detectTtsModel(text);
  const defaultVoice =
    model === MODEL_AR
      ? cfgStr("GROQ_VOICE_AR", ARABIC_DEFAULT_VOICE)
      : cfgStr("GROQ_VOICE", "hannah");
  const voice = (voices as readonly string[]).includes(input.voice ?? "")
    ? input.voice!
    : defaultVoice;

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
    throw new TtsError(`Groq TTS failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}