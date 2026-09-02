"use client";

import { AudioCapture } from "@/audio/AudioCapture";
import { VoiceActivityDetector } from "@/audio/VoiceActivityDetector";

/**
 * AutoTurnManager — gated hands-free loop (PRD FR-002, FR-007).
 *
 * Runs VAD on the live mic in two modes:
 *  - "listen" (only when the conversation is in LISTENING): user speech starts
 *    a recording; on sustained silence the utterance is sent to the provider.
 *  - "barge" (only when AI is SPEAKING): hears the user speaking over the
 *    speakers and triggers a voice interrupt (FR-007). Relies on the mic's
 *    echoCancellation plus a higher energy threshold to avoid hearing itself.
 *
 * While the AI is processing the loop is stopped so the assistant can never
 * hear itself (no echo/feedback). The manual Interrupt button also works.
 */
type VADMode = "idle" | "listen" | "barge";

export class AutoTurnManager {
  private mode: VADMode = "idle";
  private vad: VoiceActivityDetector | null = null;
  private lastSpeechEndAt = 0;
  private cooldownMs = 1000;
  private partialTimer: ReturnType<typeof setInterval> | null = null;
  private lastPartialChunks = 0;

  constructor(
    private capture: AudioCapture,
    private onUtterance: (blob: Blob) => void,
    private onPartialAudio?: (blob: Blob) => void,
    private onBargeIn?: () => void
  ) {}

  /** Listen for a full utterance (call when entering LISTENING). */
  start(): void {
    if (this.mode === "listen") return;
    this.stopVAD();
    this.mode = "listen";
    this.startVAD("listen");
  }

  /** Voice-triggered barge-in: hear the user over AI audio (FR-007). */
  armBargeIn(): void {
    if (this.mode === "barge") return;
    this.stopVAD();
    this.mode = "barge";
    this.lastSpeechEndAt = 0; // Let an immediate barge-in be heard.
    this.startVAD("barge");
  }

  /** Disable listening (call when leaving LISTENING/SPEAKING/PROCESSING). */
  stop(): void {
    if (this.mode === "idle") return;
    this.mode = "idle";
    this.stopPartialSnapshots();
    this.stopVAD();
    void this.capture.stopRecording(); // Discard any partial utterance.
  }

  private stopVAD(): void {
    this.vad?.stop();
    this.vad = null;
  }

  private startVAD(style: VADMode): void {
    const stream = this.capture.mediaStream;
    if (!stream) return;
    // In "barge" mode a higher threshold + longer hold distinguishes the user
    // speaking over the speakers from blips of the assistant's own audio.
    const options = style === "barge" ? { threshold: 0.03, startHoldMs: 260, endSilenceMs: 500 } : {};
    this.vad = new VoiceActivityDetector(
      stream,
      {
        onSpeechStart: () => {
          if (Date.now() - this.lastSpeechEndAt < this.cooldownMs) return;
          if (this.mode === "barge") {
            this.onBargeIn?.();
            return;
          }
          this.capture.startRecording();
          this.startPartialSnapshots();
        },
        onSpeechEnd: () => {
          this.lastSpeechEndAt = Date.now();
          if (this.mode === "barge") return;
          this.stopPartialSnapshots();
          void this.finalizeUtterance();
        },
      },
      options
    );
    this.vad.start();
  }

  private async finalizeUtterance(): Promise<void> {
    const blob = await this.capture.stopRecording();
    if (blob && blob.size > 0) {
      this.onUtterance(blob);
    }
  }

  /**
   * While the user is mid-utterance, periodically transcribe the audio
   * buffered so far into a live partial transcript (FR-016). Groq STT is
   * request-based, so this approximates streaming via short snapshots.
   */
  private startPartialSnapshots(): void {
    const onPartial = this.onPartialAudio;
    if (!onPartial) return;
    this.stopPartialSnapshots();
    this.lastPartialChunks = this.capture.recordedChunkCount;
    this.partialTimer = setInterval(() => {
      const count = this.capture.recordedChunkCount;
      if (count > this.lastPartialChunks && this.capture.isRecording()) {
        this.lastPartialChunks = count;
        const blob = this.capture.snapshotRecording();
        if (blob) onPartial(blob);
      }
    }, PARTIAL_INTERVAL_MS);
  }

  private stopPartialSnapshots(): void {
    if (this.partialTimer) {
      clearInterval(this.partialTimer);
      this.partialTimer = null;
    }
  }
}

const PARTIAL_INTERVAL_MS = 1200;