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
  saveLiveTurnToMemory,
  type GeminiLiveStatus,
  type LiveToolCall,
  type StartResult,
} from "@/lib/geminiLive";
import { applyFadeOut, bytesToBase64, createPcmChunker, floatTo16BitPcm, pcmToWav, LIVE_OUTPUT_SAMPLE_RATE, LIVE_PREBUFFER_BYTES } from "@/lib/pcm";
import { resolveBrowserUserKey } from "@/lib/identity";
import {
  askFirstInstruction,
  decideLiveToolCalls,
  emptyConfirmState,
  markUserSpoke,
  type LiveConfirmState,
} from "@/lib/liveConfirm";

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
  /**
   * True while the mic is muted. Muting drops outgoing frames only — the
   * session, the token and the conversation survive it. Ending the session
   * is still `stop()`; the two must never be the same button action (the
   * owner reported mute ending the call, because it used to be).
   */
  muted: boolean;
  /** Mute/unmute the mic. No-op when no session is open. */
  toggleMute: () => void;
  /** Stop Gemini mid-sentence (barge-in). */
  interrupt: () => void;
  /** Send text as if spoken. */
  sendText: (text: string) => void;
}

export function useGeminiLive(): UseGeminiLiveResult {
  const [status, setStatus] = useState<GeminiLiveStatus>("idle");
  const [speaking, setSpeaking] = useState(false);
  const [muted, setMuted] = useState(false);
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
  // Playout buffer: Google's PCM frames are small and jittered, so each one
  // played directly is an audible hole whenever a frame is late. The chunker
  // emits fixed ~0.5 s pieces; reset on every stop/interrupt so stale audio
  // can never leak into the next turn.
  const chunkerRef = useRef(createPcmChunker());
  // The turn being spoken right now, mirrored out of render state so the
  // write-back below always sees the latest text even from stale closures.
  // Reset the moment a save is initiated: the POST is async, and a second
  // flush before it resolves must find nothing, never save twice.
  const turnRef = useRef({ heard: "", said: "" });
  // Pending voice write actions awaiting spoken confirmation (gap #2,
  // extended 2026-10-01 to task/calendar writes). A first-seen write is held
  // here, the model asks aloud, and
  // only a re-call with confirmed:true after the user spoke executes.
  const pendingRef = useRef<LiveConfirmState>(emptyConfirmState());
  // Raw incoming PCM this session, capped: the noise diagnostic (owner
  // 2026-10-01 — "seperti noise", voice intelligible, Swift build smooth).
  // `downloadRaw` below writes exactly what Google sent, so a clean file
  // proves the noise is born in the web player and a noisy file proves it is
  // upstream (network/model). Never read for playback, only for export.
  const rawRef = useRef<Uint8Array[]>([]);
  const rawBytesRef = useRef(0);
  /** Cap: 60 s of 24 kHz mono 16-bit — enough for a diagnosis, never a leak. */
  const RAW_CAP_BYTES = 24_000 * 2 * 60;

  /**
   * Write the current turn into today's daily memory (fire-and-forget) and
   * clear it first, so overlapping end-of-turn signals can never double-save.
   * Safe to call from any turn boundary: stop, interrupt, or turn end.
   */
  const flushTurnMemory = useCallback(() => {
    const turn = turnRef.current;
    turnRef.current = { heard: "", said: "" };
    if (!turn.heard.trim() && !turn.said.trim()) return;
    void saveLiveTurnToMemory(turn.heard, turn.said, browserUserHeader());
  }, []);

  const ensurePlayer = useCallback((): AudioPlayer => {
    if (!playerRef.current) playerRef.current = new AudioPlayer();
    return playerRef.current;
  }, []);

  // Startup prebuffer for the voice (owner 2026-10-01: gaps between chunks).
  // Chunks are held here until LIVE_PREBUFFER_BYTES are ready, then released
  // in order and the rest of the turn streams straight through. Emptied (not
  // played) on interrupt/stop; released on turn end so a short turn still
  // plays. Re-armed every turn so each turn gets the same jitter headroom.
  // (Declared after ensurePlayer: playPiece feeds the player directly.)
  const primeRef = useRef<Uint8Array[]>([]);
  const primedRef = useRef(false);

  /** Feed one playout piece straight into the gapless schedule. */
  const playPiece = useCallback(
    (piece: Uint8Array) => {
      if (piece.length) ensurePlayer().enqueuePcm(piece, LIVE_OUTPUT_SAMPLE_RATE);
    },
    [ensurePlayer]
  );

  /**
   * Release everything the prebuffer is holding (turn end), then re-arm it so
   * the next turn starts with a full jitter buffer instead of playing its
   * first frame immediately into network jitter.
   */
  const releasePrime = useCallback(() => {
    for (const p of primeRef.current) playPiece(p);
    primeRef.current = [];
    primedRef.current = false;
  }, [playPiece]);

  /** Drop the prebuffer without playing it (interrupt/stop: stale audio must never play). */
  const dropPrime = useCallback(() => {
    primeRef.current = [];
    primedRef.current = false;
  }, []);

  const stop = useCallback(() => {
    // A close mid-turn must not lose what was just said: flush first, while
    // the turn is still intact. Idempotent — a second call finds it empty.
    flushTurnMemory();
    captureRef.current?.stop();
    captureRef.current = null;
    sessionRef.current?.stop();
    sessionRef.current = null;
    // Drop anything still queued so a stopped session cannot keep talking.
    playerRef.current?.stop();
    chunkerRef.current.reset();
    dropPrime();
    // NOTE: rawRef is deliberately NOT cleared here — downloadRaw() is meant
    // to run AFTER a call ends (owner 2026-10-01 ran it post-call and got
    // "no audio received yet"). It resets on the next start() instead.
    // A new session must never inherit an old spoken question: a stale
    // pending could authorize a turn the user never agreed to.
    pendingRef.current = emptyConfirmState();
    setSpeaking(false);
    setMuted(false);
    setStatus("idle");
  }, [flushTurnMemory, dropPrime]);

  const start = useCallback(
    async (stream: MediaStream | null): Promise<StartResult> => {
      if (!stream) {
        const message = "The microphone is not available yet.";
        setError(message);
        return { ok: false, error: message };
      }
      // A second start without a stop would leave an orphaned socket burning a
      // single-use token, so always tear down first. The raw diagnostic buffer
      // belongs to the NEW session from here on.
      rawRef.current = [];
      rawBytesRef.current = 0;
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
            if (!event.speaking) {
              // Turn end: play the short tail the chunker is still holding so
              // the last syllable is not cut, together with anything the
              // prebuffer held (a short turn never reached the threshold).
              // Empty unless audio arrived.
              releasePrime();
              const tail = chunkerRef.current.flush();
              // Fade the tail: it is the last sound of the turn, and stopping
              // dead on a non-zero sample is an end-click (owner 2026-10-01).
              if (tail && tail.length) playPiece(applyFadeOut(tail, LIVE_OUTPUT_SAMPLE_RATE));
              // And remember the turn: without this, Live conversations vanish
              // the moment the socket closes and chat memory never learns them.
              flushTurnMemory();
            }
            break;
          case "input_transcript":
            turnRef.current.heard = event.text;
            setHeard(event.text);
            setStalled("");
            // Any user speech may be the answer to a pending spoken question.
            pendingRef.current = markUserSpoke(pendingRef.current);
            break;
          case "output_transcript":
            turnRef.current.said = event.text;
            setSaid(event.text);
            setStalled("");
            break;
          case "audio": {
            if (!event.pcm.length) return;
            setStalled("");
            // Keep a copy of the wire bytes for the noise diagnostic (capped;
            // see rawRef). This is the ground truth if the voice sounds wrong.
            if (rawBytesRef.current < RAW_CAP_BYTES) {
              rawRef.current.push(event.pcm);
              rawBytesRef.current += event.pcm.length;
            }
            // Through the playout buffer, never straight to the player: one
            // WAV per jittered network frame is what made the voice stutter.
            // PCM goes in synchronously (no decodeAudioData hop) and the first
            // ~1 s of each turn is prebuffered, so playback starts with a full
            // jitter buffer instead of racing the network frame-by-frame.
            for (const piece of chunkerRef.current.push(event.pcm)) {
              if (primedRef.current) {
                playPiece(piece);
                continue;
              }
              primeRef.current.push(piece);
              const held = primeRef.current.reduce((n, p) => n + p.length, 0);
              if (held >= LIVE_PREBUFFER_BYTES) {
                primedRef.current = true;
                for (const p of primeRef.current) playPiece(p);
                primeRef.current = [];
              }
            }
            break;
          }
          case "interrupted":
            playerRef.current?.stop();
            chunkerRef.current.reset();
            dropPrime();
            // A cut-off turn is still a turn: save the partial exchange before
            // it is lost. Idempotent with the speaking:false flush below.
            flushTurnMemory();
            setSpeaking(false);
            break;
          case "tool_call": {
            // Diagnostic beacon (owner 2026-10-01): the model sometimes chats
            // through the whole confirm flow without emitting a single call,
            // which is invisible server-side (no POST ever arrives). This
            // fire-and-forget line makes emissions observable; the names only,
            // never args (privacy).
            try {
              void fetch("/api/gemini-live/tool-ping", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ names: event.calls.map((c) => c.name) }),
              }).catch(() => undefined);
            } catch {
              /* diagnostic only */
            }
            // Voice write actions (gap #2, FR-014) never execute on first
            // sight: reads run now, writes are held until the spoken loop
            // completes (model asks aloud -> user answers -> re-call with
            // confirmed:true). Never awaited; each answer is delivered
            // through `sendToolResponse` as it becomes ready.
            const decision = decideLiveToolCalls(pendingRef.current, event.calls, turnRef.current.heard);
            pendingRef.current = decision.state;
            if (decision.ask.length) {
              session.sendToolResponse(
                decision.ask.map((c) => ({ id: c.id, name: c.name, result: askFirstInstruction(c) }))
              );
            }
            if (decision.execute.length) void runLiveToolCalls(session, decision.execute);
            break;
          }
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
    [ensurePlayer, stop, playPiece, releasePrime, dropPrime, flushTurnMemory]
  );

  const interrupt = useCallback(() => {
    sessionRef.current?.interrupt();
    playerRef.current?.stop();
    setSpeaking(false);
  }, []);

  /**
   * Mute/unmute the mic. Only the outgoing frames stop — the session, the
   * token and the conversation are untouched, so muting can never end the
   * call. No-op without an open session.
   */
  const toggleMute = useCallback(() => {
    const session = sessionRef.current;
    if (!session || status !== "ready") return;
    // The session is the source of truth (never a side effect inside a state
    // updater — StrictMode double-invokes those).
    const next = !session.isAudioMuted;
    session.setAudioMuted(next);
    setMuted(next);
  }, [status]);

  const sendText = useCallback((text: string) => {
    sessionRef.current?.sendText(text);
  }, []);

  // Close the socket on unmount so a navigation never leaves a live session
  // (and a spent token) behind.
  useEffect(() => () => stop(), [stop]);

  // Noise diagnostic console (owner 2026-10-01): no UI, no bundle cost beyond
  // a few lines — open DevTools and run:
  //   __miaLive.stats()        → frames received vs pieces played
  //   __miaLive.downloadRaw()  → saves exactly what Google sent as .wav
  //                              (clean file = web player guilty,
  //                               noisy file = upstream guilty)
  //   __miaLive.playSine()     → 1 s of 440 Hz through the SAME player path
  //                              (clean sine = player innocent)
  useEffect(() => {
    const w = window as unknown as { __miaLive?: unknown };
    w.__miaLive = {
      stats: () => ({ rawFrames: rawRef.current.length, rawBytes: rawBytesRef.current }),
      downloadRaw: () => {
        const total = rawBytesRef.current;
        if (!total) return "no audio received yet";
        const flat = new Uint8Array(total);
        let at = 0;
        for (const part of rawRef.current) {
          flat.set(part, at);
          at += part.length;
        }
        const wav = pcmToWav(flat, LIVE_OUTPUT_SAMPLE_RATE);
        const url = URL.createObjectURL(new Blob([wav.buffer as ArrayBuffer], { type: "audio/wav" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = "mia-live-raw.wav";
        // Attached before click: some Chrome profiles ignore clicks on
        // detached anchors, which silently produces "saved N bytes" with no
        // file in Downloads (owner 2026-10-01).
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        return `saved ${total} bytes`;
      },
      playSine: () => {
        const frames = LIVE_OUTPUT_SAMPLE_RATE;
        const pcm = new Uint8Array(frames * 2);
        const view = new DataView(pcm.buffer);
        for (let i = 0; i < frames; i += 1) {
          view.setInt16(i * 2, Math.round(Math.sin((i / frames) * Math.PI * 2 * 440) * 0x7fff), true);
        }
        ensurePlayer().enqueuePcm(pcm, LIVE_OUTPUT_SAMPLE_RATE);
        return "playing 440 Hz for 1 s";
      },
    };
    return () => {
      if (w.__miaLive) delete w.__miaLive;
    };
  }, [ensurePlayer]);

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
    muted,
    toggleMute,
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
