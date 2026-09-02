/**
 * Audio capture (PRD §14 first stage).
 *
 * Owns microphone permission + getUserMedia + capture stream, and records
 * utterances via MediaRecorder. Exposes a small observable surface so the UI
 * can reflect mic state and the provider can be fed one utterance at a time.
 */

export type AudioCaptureState =
  | { status: "idle" }
  | { status: "requesting" }
  | { status: "active"; sampleRate: number }
  | { status: "denied"; message: string }
  | { status: "error"; message: string };

export type AudioCaptureListener = (state: AudioCaptureState) => void;

export class AudioCapture {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private listeners = new Set<AudioCaptureListener>();
  private state: AudioCaptureState = { status: "idle" };

  constructor(private sampleRate = 16000) {}

  get current(): AudioCaptureState {
    return this.state;
  }

  isActive(): boolean {
    return this.stream !== null;
  }

  isRecording(): boolean {
    return this.recorder !== null && this.recorder.state === "recording";
  }

  /** The raw mic stream, for VAD/ASR/transport layers. */
  get mediaStream(): MediaStream | null {
    return this.stream;
  }

  /** Non-null stream or throws — used before any async work is started. */
  getMediaStreamSafe(): MediaStream | null {
    return this.stream;
  }

  async start(): Promise<void> {
    if (this.state.status === "active") return;
    this.setState({ status: "requesting" });

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      this.setState({ status: "active", sampleRate: this.sampleRate });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError") {
        this.setState({ status: "denied", message: "Microphone access is required." });
      } else {
        this.setState({
          status: "error",
          message: err instanceof Error ? err.message : "Microphone unavailable.",
        });
      }
    }
  }

  /**
   * Start recording a user utterance. Call after `start()` has resolved with
   * an "active" state. Produces a WebM/Opus blob via `stopRecording()`.
   */
  startRecording(): void {
    if (!this.stream || this.isRecording()) return;
    this.chunks = [];

    const mimeSupported = MediaRecorder.isTypeSupported("audio/webm");
    this.recorder = new MediaRecorder(
      this.stream,
      mimeSupported ? { mimeType: "audio/webm" } : undefined
    );
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    this.recorder.start(250);
  }

  /**
   * Number of data chunks accumulated so far. Partial transcript snapshots can
   * skip work when nothing new has arrived since the last snapshot.
   */
  get recordedChunkCount(): number {
    return this.chunks.length;
  }

  /** Snapshot of audio recorded so far, or null when nothing is buffered. */
  snapshotRecording(): Blob | null {
    if (!this.chunks.length) return null;
    const type = this.recorder?.mimeType || "audio/webm";
    return new Blob(this.chunks, { type });
  }

  /** Stop recording and return the utterance as a Blob, or null if idle. */
  stopRecording(): Promise<Blob | null> {
    const recorder = this.recorder;
    if (!recorder || recorder.state === "inactive") {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      recorder.onstop = () => {
        this.recorder = null;
        const type = recorder.mimeType || "audio/webm";
        resolve(new Blob(this.chunks, { type }));
      };
      if (recorder.state === "recording") recorder.stop();
      else resolve(null);
    });
  }

  stop(): void {
    this.stopRecording().catch(() => {});
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.setState({ status: "idle" });
  }

  on(fn: AudioCaptureListener): void {
    this.listeners.add(fn);
  }

  off(fn: AudioCaptureListener): void {
    this.listeners.delete(fn);
  }

  private setState(next: AudioCaptureState): void {
    this.state = next;
    for (const fn of this.listeners) fn(next);
  }
}