/**
 * Voice Activity Detection (PRD FR-002).
 *
 * Continuously samples the microphone's live stream and reports speech
 * start / end so the user never needs to press a stop button. Energy-based
 * (root-mean-square threshold) with hysteresis: a short silence to end the
 * turn, and a small trigger wait before starting, to cut background noise.
 */
export interface VADCallbacks {
  onSpeechStart: () => void;
  onSpeechEnd: () => void;
}

export interface VADOptions {
  /** RMS below this (0..1) counts as silence. */
  threshold?: number;
  /** End silence duration in ms before firing onSpeechEnd. */
  endSilenceMs?: number;
  /** Sustained speech duration in ms required to fire onSpeechStart. */
  startHoldMs?: number;
}

export class VoiceActivityDetector {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private sampleBuffer: Float32Array<ArrayBuffer> | null = null;
  private rafId = 0;
  private speaking = false;
  private silentSince = 0;
  private voicedSince = 0;
  private threshold: number;
  private endSilenceMs: number;
  private startHoldMs: number;

  constructor(private stream: MediaStream, private callbacks: VADCallbacks, options: VADOptions = {}) {
    this.ctx = new AudioContext();
    const source = this.ctx.createMediaStreamSource(stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.sampleBuffer = new Float32Array(this.analyser.fftSize);
    source.connect(this.analyser);

    this.threshold = options.threshold ?? 0.02;
    this.endSilenceMs = options.endSilenceMs ?? 900;
    this.startHoldMs = options.startHoldMs ?? 160;
  }

  start(): void {
    this.tick();
  }

  stop(): void {
    cancelAnimationFrame(this.rafId);
    this.ctx?.close();
    this.ctx = null;
    this.analyser = null;
    this.speaking = false;
  }

  private tick(): void {
    if (!this.analyser || !this.sampleBuffer) return;
    this.analyser.getFloatTimeDomainData(this.sampleBuffer);

    let sum = 0;
    for (let i = 0; i < this.sampleBuffer.length; i++) {
      const v = this.sampleBuffer[i];
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.sampleBuffer.length);
    const now = performance.now();
    const voiced = rms >= this.threshold;

    if (voiced) {
      this.silentSince = 0;
      if (!this.speaking) {
        if (!this.voicedSince) this.voicedSince = now;
        if (now - this.voicedSince >= this.startHoldMs) {
          this.speaking = true;
          this.callbacks.onSpeechStart();
        }
      }
    } else {
      this.voicedSince = 0;
      if (this.speaking) {
        if (!this.silentSince) this.silentSince = now;
        if (now - this.silentSince >= this.endSilenceMs) {
          this.speaking = false;
          this.callbacks.onSpeechEnd();
        }
      }
    }

    this.rafId = requestAnimationFrame(() => this.tick());
  }
}