/**
 * Raw PCM microphone capture for the Gemini Live duplex path.
 *
 * Why this exists instead of reusing `AudioCapture`: that class records via
 * `MediaRecorder`, which produces **WebM/Opus** — exactly what Whisper wants
 * and exactly what the Live API cannot accept (it wants headerless 16-bit LE
 * PCM at a fixed 16 kHz). Decoding and re-encoding Opus on every frame would be
 * slow and lossy, so Live gets its own tap on the same `MediaStream`.
 *
 * `ScriptProcessorNode` is deprecated in favour of `AudioWorklet`, and that is
 * a real trade-off worth stating: a worklet needs a separate module file served
 * over HTTP (so it escapes TypeScript and the test runner), whereas a script
 * processor lives in this file, is typechecked, and works in every browser the
 * app already supports. At the frame sizes involved here the difference is not
 * audible, so the maintainable option wins. If the path is ever profiled as a
 * bottleneck, this class is the only thing that needs to change.
 */

import { LIVE_INPUT_SAMPLE_RATE, resampleFloat32 } from "@/lib/pcm";

/** Callback receiving one resampled 16 kHz mono frame. */
export type PcmFrameListener = (frame: Float32Array) => void;

/**
 * ScriptProcessor buffer size. 4096 is ~85 ms at 48 kHz — small enough that
 * barge-in feels instant, large enough to avoid per-frame scheduling overhead.
 */
const BUFFER_SIZE = 4096;

export class PcmCapture {
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private mute: GainNode | null = null;
  private stream: MediaStream | null = null;
  private listeners = new Set<PcmFrameListener>();
  private running = false;

  get isRunning(): boolean {
    return this.running;
  }

  onFrame(fn: PcmFrameListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Start tapping `stream` and emitting 16 kHz mono frames.
   *
   * Takes the app's EXISTING capture stream rather than calling `getUserMedia`
   * again: two open mic consumers on the same device fight, and the orb already
   * analyses this stream for its own reactivity.
   */
  async start(stream: MediaStream): Promise<void> {
    if (this.running) return;

    const Ctor: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      throw new Error("This browser does not expose an AudioContext for microphone capture.");
    }

    this.ctx = new Ctor();
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.stream = stream;
    this.source = this.ctx.createMediaStreamSource(stream);

    // A script processor MUST be connected to a destination to be pulled by the
    // graph. Routing it to a zero-gain node keeps the graph running without
    // playing the mic back through the speakers (which would be feedback).
    this.processor = this.ctx.createScriptProcessor(BUFFER_SIZE, 1, 1);
    this.mute = this.ctx.createGain();
    this.mute.gain.value = 0;

    const inRate = this.ctx.sampleRate;
    this.processor.onaudioprocess = (event) => {
      if (!this.running) return;
      const input = event.inputBuffer.getChannelData(0);
      // `resampleFloat32` returns a copy, so the frame we hand out is not the
      // Web Audio buffer we are about to be given back.
      const frame =
        inRate === LIVE_INPUT_SAMPLE_RATE ? new Float32Array(input) : resampleFloat32(input, inRate, LIVE_INPUT_SAMPLE_RATE);
      for (const fn of this.listeners) {
        try {
          fn(frame);
        } catch {
          // A listener fault must not stop audio capture.
        }
      }
    };

    this.source.connect(this.processor);
    this.processor.connect(this.mute);
    this.mute.connect(this.ctx.destination);
    this.running = true;
  }

  /** Detach and release the audio graph. Safe to call repeatedly. */
  stop(): void {
    this.running = false;
    // Disconnect the tap itself FIRST, otherwise the graph keeps pulling frames
    // while we tear down and `onaudioprocess` can fire after `ctx.close()`.
    try {
      if (this.processor) {
        this.processor.onaudioprocess = null;
        this.processor.disconnect();
      }
      this.processor = null;
      this.source?.disconnect();
      this.source = null;
      this.mute?.disconnect();
      this.mute = null;
    } catch {
      // Already torn down.
    }
    this.stream = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}
