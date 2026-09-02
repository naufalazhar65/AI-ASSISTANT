/**
 * Audio playback (PRD §14, FR-006).
 *
 * Decodes TTS WAV chunks and plays them back in arrival order. Supports an
 * interrupt-safe `stop()` that clears the pending queue and the speaker, so a
 * barge-in stops the AI mid-word.
 */
export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private queue: AudioBuffer[] = [];
  private current: { node: AudioBufferSourceNode; token: number } | null = null;
  private playToken = 0;

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
    this.pump();
  }

  /** Clear queue + stop speaking immediately (FR-007). */
  stop(): void {
    this.playToken += 1;
    this.queue = [];
    if (this.current) {
      try {
        this.current.node.stop();
      } catch {
        // Already stopped.
      }
      this.current = null;
    }
  }

  /** Called once when the queued audio has finished playing. */
  onDrained: (() => void) | null = null;
  private pumping = false;

  private async pump(): Promise<void> {
    if (this.pumping || this.queue.length === 0) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const token = this.playToken;
        const buffer = this.queue.shift()!;
        const ctx = this.ensureContext();
        const node = ctx.createBufferSource();
        node.buffer = buffer;
        node.connect(ctx.destination);
        this.current = { node, token };

        const ended = new Promise<void>((resolve) => {
          node.onended = () => resolve();
        });
        node.start();
        await ended;

        if (this.current?.token === token) this.current = null;
        if (this.playToken !== token) return; // Stopped while playing: bail.
      }
      this.onDrained?.();
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