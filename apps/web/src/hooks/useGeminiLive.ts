/**
 * `useGeminiLive` — the duplex voice path.
 *
 * Owns the three pieces of a Live session and nothing else:
 *   1. `GeminiLiveSession`  — the WebSocket (browser <-> Google, direct)
 *   2. `PcmCapture`         — raw 16 kHz frames off the EXISTING mic stream
 *   3. `AudioPlayer`        — playback, reused so barge-in keeps working
 *
 * It is deliberately NOT wired into `useVoice`/`ConversationManager`. That
 * machinery is turn-based: `MediaRecorder` -> Whisper -> LLM -> TTS, with
 * `AutoTurnManager` deciding when an utterance ended. Gemini Live is duplex and
 * does its own turn-taking and barge-in, so routing it through there would mean
 * fighting a VAD that is no longer the source of truth. Two clean paths beat
 * one entangled one; the console switches between them.
 *
 * Degradation is the important part: if the server has no `GEMINI_API_KEY`, or
 * the token route fails, `start()` returns `{ok:false}` with a message and the
 * caller stays on the Groq pipeline. The web app keeps working.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { AudioPlayer } from "@/audio/AudioPlayer";
import { PcmCapture } from "@/audio/PcmCapture";
import {
  GeminiLiveSession,
  type GeminiLiveStatus,
  type LiveToolCall,
  type StartResult,
} from "@/lib/geminiLive";
import { bytesToBase64, floatTo16BitPcm, pcmToWav, LIVE_OUTPUT_SAMPLE_RATE } from "@/lib/pcm";
import { resolveBrowserUserKey } from "@/lib/identity";

/** The browser's resolved key, so tool execution runs as the right person. */
function browserUserHeader(): Record<string, string> {
  try {
    if (typeof window === "undefined") return {};
    return { "x-mia-user": resolveBrowserUserKey(window.localStorage.getItem("voice-ai.user")) };
  } catch {
    return {};
  }
}

export interface UseGeminiLiveResult {
  /** `connecting` while the socket opens, `ready` once the setup frame is written. */
  status: GeminiLiveStatus;
  /** True while Gemini's voice is playing. */
  speaking: boolean;
  /** Live transcript of what the USER said. */
  heard: string;
  /** Live transcript of what GEMINI said. */
  said: string;
  /** Last error, already phrased for a user. Empty when healthy. */
  error: string;
  /**
   * Set when the session is open but the model has produced nothing at all.
   * Distinct from `error` on purpose: the connection is fine, the far side is
   * not answering, and the UI must not spin or claim either.
   */
  stalled: string;
  /** True when a session is open and usable. */
  active: boolean;
  start: (stream: MediaStream | null) => Promise<StartResult>;
  stop: () => void;
  /** Stop Gemini mid-sentence (barge-in). */
  interrupt: () => void;
  /** Send text as if spoken. */
  sendText: (text: string) => void;
}

export function useGeminiLive(): UseGeminiLiveResult {
  const [status, setStatus] = useState<GeminiLiveStatus>("idle");
  const [speaking, setSpeaking] = useState(false);
  const [heard, setHeard] = useState("");
  const [said, setSaid] = useState("");
  const [error, setError] = useState("");
  /**
   * Notice that the session is connected but the model has produced nothing.
   * Kept apart from `error` because the session is still open and audio may
   * still arrive — a red error would misdescribe a healthy connection.
   */
  const [stalled, setStalled] = useState("");

  // Everything below is a long-lived object, not render state: the WebSocket,
  // the audio graph, and the player must survive re-renders untouched.
  const sessionRef = useRef<GeminiLiveSession | null>(null);
  const captureRef = useRef<PcmCapture | null>(null);
  const playerRef = useRef<AudioPlayer | null>(null);

  const ensurePlayer = useCallback((): AudioPlayer => {
    if (!playerRef.current) playerRef.current = new AudioPlayer();
    return playerRef.current;
  }, []);

  const stop = useCallback(() => {
    captureRef.current?.stop();
    captureRef.current = null;
    sessionRef.current?.stop();
    sessionRef.current = null;
    // Drop anything still queued so a stopped session cannot keep talking.
    playerRef.current?.stop();
    setSpeaking(false);
    setStatus("idle");
  }, []);

  const start = useCallback(
    async (stream: MediaStream | null): Promise<StartResult> => {
      if (!stream) {
        const message = "The microphone is not available yet.";
        setError(message);
        return { ok: false, error: message };
      }
      // A second start without a stop would leave an orphaned socket burning a
      // single-use token, so always tear down first.
      stop();
      setError("");
      setStalled("");
      setHeard("");
      setSaid("");

      const session = new GeminiLiveSession();
      sessionRef.current = session;
      session.on((event) => {
        switch (event.type) {
          case "status":
            setStatus(event.status);
            if (event.detail) setError(event.detail);
            break;
          case "error":
            setError(event.message);
            break;
          case "stalled":
            // Not an error: the session is still open. It is the notice that
            // keeps a silent Google from looking like a stuck UI.
            setStalled(event.message);
            break;
          case "speaking":
            setSpeaking(event.speaking);
            // The model is producing something, so the silence notice is stale.
            setStalled("");
            break;
          case "input_transcript":
            setHeard(event.text);
            setStalled("");
            break;
          case "output_transcript":
            setSaid(event.text);
            setStalled("");
            break;
          case "audio": {
            if (!event.pcm.length) return;
            setStalled("");
            // Live sends headerless 24 kHz PCM; AudioPlayer needs a container.
            const wav = pcmToWav(event.pcm, LIVE_OUTPUT_SAMPLE_RATE);
            void ensurePlayer().enqueue(wav.buffer.slice(0) as ArrayBuffer);
            break;
          }
          case "interrupted":
            playerRef.current?.stop();
            setSpeaking(false);
            break;
          case "tool_call":
            // Never awaited: the session stays usable while tools run, and the
            // answer is delivered through `sendToolResponse` when ready.
            void runLiveToolCalls(session, event.calls);
            break;
          case "text":
            // Plain-text turns are outside this phase's scope (voice only), so
            // surface nothing rather than half-render a code block as speech.
            break;
        }
      });

      const result = await session.start();
      if (!result.ok) {
        // A failed start must not leave a half-open capture or session behind.
        captureRef.current = null;
        sessionRef.current = null;
        setStatus("error");
        return result;
      }

      const capture = new PcmCapture();
      captureRef.current = capture;
      capture.onFrame((frame) => {
        const pcm = floatTo16BitPcm(frame);
        session.sendAudioFrame(pcm, bytesToBase64(pcm));
      });
      try {
        await capture.start(stream);
      } catch (err) {
        // The socket is open but we cannot hear anything: better to close it
        // than to sit there appearing connected while mute.
        session.stop();
        sessionRef.current = null;
        const message = `Could not start microphone capture: ${
          err instanceof Error ? err.message : String(err)
        }`;
        setError(message);
        setStatus("error");
        return { ok: false, error: message };
      }

      return { ok: true };
    },
    [ensurePlayer, stop]
  );

  const interrupt = useCallback(() => {
    sessionRef.current?.interrupt();
    playerRef.current?.stop();
    setSpeaking(false);
  }, []);

  const sendText = useCallback((text: string) => {
    sessionRef.current?.sendText(text);
  }, []);

  // Close the socket on unmount so a navigation never leaves a live session
  // (and a spent token) behind.
  useEffect(() => () => stop(), [stop]);

  return {
    status,
    speaking,
    heard,
    said,
    error,
    stalled,
    active: status === "ready",
    start,
    stop,
    interrupt,
    sendText,
  };
}

/**
 * Execute Live tool calls server-side and answer the model — ALWAYS, even on
 * failure. Live calls are synchronous (the model is silent until every call
 * has a result), so a missing answer hangs the conversation, while an
 * `Error: ...` answer lets the model speak honestly about what happened.
 * Module-level (not a hook) so it stays callable from the session listener.
 */
async function runLiveToolCalls(session: GeminiLiveSession, calls: LiveToolCall[]): Promise<void> {
  const answer = (results: Array<{ id: string; name: string; result: string }>) => {
    try {
      session.sendToolResponse(results);
    } catch {
      // A dead socket needs no answer.
    }
  };
  let results: Array<{ id: string; name: string; result: string }>;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch("/api/gemini-live/tool", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...browserUserHeader() },
        body: JSON.stringify({
          calls: calls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
        }),
        signal: controller.signal,
      });
      const json = (await res.json().catch(() => ({}))) as {
        results?: Array<{ id?: unknown; name?: unknown; result?: unknown }>;
        error?: string;
      };
      if (!res.ok || !Array.isArray(json.results)) {
        throw new Error(typeof json.error === "string" ? json.error : `tool route HTTP ${res.status}`);
      }
      results = calls.map((c, index) => {
        const r = json.results?.[index];
        return {
          id: c.id,
          name: c.name,
          result: typeof r?.result === "string" ? r.result : "Error: no result from tool route.",
        };
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    const message = err instanceof Error && err.name === "AbortError"
      ? "Error: the tool took too long (30s) and was stopped."
      : `Error: could not reach the tool route (${err instanceof Error ? err.message : String(err)}).`;
    results = calls.map((c) => ({ id: c.id, name: c.name, result: message }));
  }
  answer(results);
}
