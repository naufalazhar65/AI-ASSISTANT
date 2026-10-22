/**
 * `useGeminiLive` — the duplex voice path, as a React adapter.
 *
 * All the session logic lives in `lib/liveClient.ts` (`LiveClient`): the
 * WebSocket, the mic capture, the player, the barge-in detector, the playout
 * prebuffer, the spoken tool confirmation and the memory write-back. This
 * file only mirrors that client's state into React and exposes the same
 * public API it always had — `LiveVoicePanel` and `page.tsx` are untouched.
 *
 * Why the split: the office dashboard needs the same loop and has no React.
 * Keeping the logic here would have meant shipping React to the dashboard or
 * re-implementing every rule there; both were rejected.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { LiveClient, type LiveClientState } from "@/lib/liveClient";
import type { GeminiLiveStatus, StartResult } from "@/lib/geminiLive";

export interface UseGeminiLiveResult {
  /** `connecting` while the socket opens, `ready` once the setup frame is written. */
  status: GeminiLiveStatus;
  /** True while Gemini's voice is playing. */
  speaking: boolean;
  /** Live transcript of what the USER said. */
  heard: string;
  /** Live transcript of what GEMINI said. */
  said: string;
  /**
   * Honesty note for the just-finished turn, set only when the server
   * flagged its claims against executed tools. Shown under the transcript,
   * never spoken. Empty when the last turn was clean.
   */
  verifyNote: string;
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
  /** Narrow-band telephone character on the Live output (owner 2026-10-06). */
  telephoneVoice: boolean;
  /** Flip it live; persisted, so the studio-clean voice is one toggle away. */
  setTelephoneVoice: (on: boolean) => void;
  /**
   * What the model is doing right now ("⏳ mengecek email..."). Set when a
   * tool batch starts, cleared when Mia starts answering. Empty when idle.
   * Exists because a synchronous tool call is minutes-or-seconds of dead air
   * otherwise (owner 2026-10-01: interrupting mid-tool felt impossible with
   * no visible state at all).
   */
  toolNote: string;
  /** Stop Gemini mid-sentence (barge-in). */
  interrupt: () => void;
  /** Send text as if spoken. */
  sendText: (text: string) => void;
}

export function useGeminiLive(): UseGeminiLiveResult {
  const clientRef = useRef<LiveClient | null>(null);
  if (!clientRef.current) clientRef.current = new LiveClient();
  const client = clientRef.current;

  const [state, setState] = useState<LiveClientState>(() => client.getState());

  useEffect(() => client.subscribe(setState), [client]);

  const start = useCallback(
    (stream: MediaStream | null) => client.start(stream),
    [client]
  );
  const stop = useCallback(() => client.stop(), [client]);
  const interrupt = useCallback(() => client.interrupt(), [client]);
  const toggleMute = useCallback(() => client.toggleMute(), [client]);
  const sendText = useCallback((text: string) => client.sendText(text), [client]);
  const setTelephoneVoice = useCallback((on: boolean) => client.setTelephoneVoice(on), [client]);

  // Close the socket on unmount so a navigation never leaves a live session
  // (and a spent token) behind.
  useEffect(() => () => stop(), [stop]);

  // Noise diagnostic console (owner 2026-10-01): no UI, no bundle cost beyond
  // a few lines — open DevTools and run:
  //   __miaLive.stats()        → frames received vs pieces played
  //   __miaLive.downloadRaw()  → saves exactly what Google sent as .wav
  //   __miaLive.playSine()     → 1 s of 440 Hz through the SAME player path
  useEffect(() => client.installDiagnostics(), [client]);

  return {
    status: state.status,
    speaking: state.speaking,
    heard: state.heard,
    said: state.said,
    verifyNote: state.verifyNote,
    error: state.error,
    stalled: state.stalled,
    toolNote: state.toolNote,
    active: state.status === "ready",
    start,
    stop,
    interrupt,
    sendText,
    muted: state.muted,
    toggleMute,
    telephoneVoice: state.telephoneVoice,
    setTelephoneVoice,
  };
}
