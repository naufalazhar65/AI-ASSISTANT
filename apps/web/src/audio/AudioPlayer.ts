/**
 * Audio playback (PRD §14, FR-006).
 *
 * Decodes TTS WAV chunks and plays them back in arrival order. Supports an
 * interrupt-safe `stop()` that clears the pending queue and the speaker, so a
 * barge-in stops the AI mid-word.
 */
import { resampleFloat32 } from "@/lib/pcm";

export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private queue: AudioBuffer[] = [];
  private current: { node: AudioBufferSourceNode; token: number } | null = null;
  private playToken = 0;
  /**
   * End time of the last scheduled chunk. Consecutive chunks are chained
   * back-to-back on this cursor instead of starting each one after the
   * previous node's `onended` fires: that await crosses a JS task boundary,
   * leaving a scheduling gap between every two chunks. For per-sentence TTS
   * the gap is an inaudible pause; for Live's many small PCM frames it is
   * crackle (measured 2026-09-30 against a native AVAudioPlayerNode path,
   * which chains buffers gaplessly). Reset on `stop()`.
   */
  private nextTime = 0;

  /** Feed a WAV/raw audio chunk. Playback starts automatically if idle. */
  async enqueue(data: ArrayBuffer): Promise<void> {
    const ctx = this.ensureContext();
    let buffer: AudioBuffer;
    try {
      buffer = await ctx.decodeAudioData(data);
    } catch {
      return; // Non-decodable chunk: skip, keep talking.
    }

    this.queue.push(buffer);
    this.wake?.();
    void this.pump();
  }

  /**
   * Feed raw 16-bit LE mono PCM, synchronously.
   *
   * This is the Live voice path (owner 2026-10-01: "patah-patah ada jedanya",
   * Chrome macOS — while the native Swift build is smooth). `enqueue` above
   * awaits `decodeAudioData` per chunk: that async hop lands the buffer in the
   * queue tens of milliseconds late, and under network jitter the `pump()` loop
   * then finds an empty queue at a chunk boundary — an audible hole. Building
   * the `AudioBuffer` directly from the samples is synchronous, so a chunk is
   * scheduled the same task it arrives in and the `nextTime` chain never
   * starves. A trailing odd byte is dropped (one sample is inaudible; a throw
   * would kill the stream — same contract as `pcm16ToFloat32`).
   */
  enqueuePcm(pcm: Uint8Array, sampleRate: number): void {
    const frames = Math.floor(pcm.length / 2);
    if (!frames) return;
    const ctx = this.ensureContext();
    const view = new DataView(pcm.buffer, pcm.byteOffset, frames * 2);
    const raw = new Float32Array(frames);
    for (let i = 0; i < frames; i += 1) {
      raw[i] = view.getInt16(i * 2, true) / 0x8000;
    }
    // Match the device rate (owner 2026-10-01: thin residual static after the
    // schedule-ahead fix). A 24 kHz buffer on a 48 kHz context makes Chrome
    // resample EVERY chunk from a fresh state, so each 0.5 s boundary carries
    // a micro-click. Resampling once here — with the same linear interpolator
    // the capture side already trusts for speech — removes the per-chunk
    // resampler reset entirely. Skipped when the rates already match.
    const data = ctx.sampleRate === sampleRate ? raw : resampleFloat32(raw, sampleRate, ctx.sampleRate);
    const buffer = ctx.createBuffer(1, data.length, ctx.sampleRate);
    buffer.getChannelData(0).set(data);
    this.queue.push(buffer);
    this.wake?.();
    void this.pump();
  }

  /** Clear queue + stop speaking immediately (FR-007). */
  stop(): void {
    this.playToken += 1;
    this.queue = [];
    this.nextTime = 0;
    this.pending = 0;
    if (this.current) {
      try {
        this.current.node.stop();
      } catch {
        // Already stopped.
      }
      this.current = null;
    }
    // Unpark a parked pump so it can observe the new token and bail.
    this.wake?.();
  }

  /** Called once when the queued audio has finished playing. */
  onDrained: (() => void) | null = null;
  private pumping = false;
  /**
   * Buffers scheduled but not yet ended. Lets the loop park while audio is
   * still playing with nothing new queued (network jitter), instead of
   * exiting and losing the chain.
   */
  private pending = 0;
  /** Resolves the parked loop when a chunk lands, all audio ends, or stop(). */
  private wake: (() => void) | null = null;

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      const token = this.playToken;
      for (;;) {
        // Schedule EVERYTHING queued, immediately — never after an `ended`
        // await. The old loop awaited each chunk's end before scheduling the
        // next: that hop crosses a task boundary, so every chunk boundary had
        // a millisecond hole. At 0.5 s Live chunks that is 2 clicks/second of
        // constant static over clean audio (owner 2026-10-01: raw file clean,
        // Live playback kresek, Swift smooth). Schedule-ahead is what makes a
        // native scheduleBuffer chain gapless, and the same shape here.
        while (this.queue.length > 0) {
          if (this.playToken !== token) return; // Stopped: bail.
          const buffer = this.queue.shift()!;
          const ctx = this.ensureContext();
          const node = ctx.createBufferSource();
          node.buffer = buffer;
          node.connect(ctx.destination);
          this.current = { node, token };

          // Chain the start time so chunks play gaplessly (see `nextTime`).
          // A stale cursor (long idle, clock jump) self-heals via Math.max.
          const startAt = Math.max(ctx.currentTime, this.nextTime);
          node.start(startAt);
          this.nextTime = startAt + buffer.duration;
          this.pending += 1;
          node.onended = () => {
            if (this.pending > 0) this.pending -= 1;
            if (this.current?.node === node) this.current = null;
            if (this.playToken === token && this.pending === 0 && this.queue.length === 0) {
              this.onDrained?.();
            }
            // A new chunk may have landed while this one played, or
            // everything may be done: either way the parked loop re-checks.
            this.wake?.();
          };
        }
        if (this.pending === 0) return; // Drained (onDrained fired above).
        if (this.playToken !== token) return; // Stopped while playing: bail.
        // Playing but nothing queued: park until a chunk lands, all audio
        // ends, or stop(). No polling — the waker resolves this await.
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        this.wake = null;
      }
    } finally {
      this.pumping = false;
    }
  }
  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
    }
    if (this.ctx.state === "suspended") {
      void this.ctx.resume();
    }
    return this.ctx;
  }
}