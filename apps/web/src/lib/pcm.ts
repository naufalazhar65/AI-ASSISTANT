/**
 * Pure PCM helpers for the Gemini Live duplex voice path.
 *
 * The Gemini Live API speaks RAW 16-bit little-endian PCM: 16 kHz on the way
 * in, 24 kHz on the way out. The rest of the audio stack does not: the capture
 * side produces WebM/Opus via `MediaRecorder` (that is what Whisper wants), and
 * the playback side feeds `AudioContext.decodeAudioData`, which needs a
 * *container* format and rejects headerless PCM.
 *
 * So this module owns the two conversions the Live path needs, and nothing
 * else. It is deliberately dependency-free and side-effect-free so the numerics
 * can be unit-tested without a browser.
 */

/** Gemini Live input sample rate (Hz). */
export const LIVE_INPUT_SAMPLE_RATE = 16_000;

/** Gemini Live output sample rate (Hz). */
export const LIVE_OUTPUT_SAMPLE_RATE = 24_000;

/** Bytes per mono sample: 16-bit little-endian. */
export const BYTES_PER_SAMPLE = 2;

/**
 * Resample mono float samples (the -1..1 range Web Audio uses) to another rate.
 *
 * Linear interpolation is used deliberately: it is a fraction of the cost of a
 * windowed-sinc resampler, and for speech at these bandwidths the audible
 * difference is negligible. The alternative — shipping the browser's raw
 * sample rate and letting the API reject it — is not an option, and dropping
 * samples by decimation would alias badly whenever the device rate is not an
 * exact multiple of 16 kHz (44.1 kHz is the common case).
 *
 * @param input   Mono float samples in -1..1.
 * @param fromRate Source sample rate in Hz.
 * @param toRate   Target sample rate in Hz.
 * @returns A NEW array at the target rate (the input is never mutated).
 */
export function resampleFloat32(
  input: Float32Array,
  fromRate: number,
  toRate: number
): Float32Array {
  if (fromRate === toRate) return new Float32Array(input);
  if (!(fromRate > 0) || !(toRate > 0)) {
    throw new Error(`resampleFloat32: bad rates ${fromRate} -> ${toRate}`);
  }
  const ratio = toRate / fromRate;
  const outLength = Math.max(1, Math.round(input.length * ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    // `pos` advances continuously, so the interpolation is continuous too; the
    // clamped index reads keep the tail frame defined when the ratio rounds up.
    const pos = i / ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = input[Math.min(i0, input.length - 1)] ?? 0;
    const b = input[Math.min(i0 + 1, input.length - 1)] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/**
 * Convert mono float samples (-1..1) to 16-bit little-endian PCM bytes.
 *
 * Samples are clamped rather than wrapped: a float slightly outside -1..1 (very
 * common with Web Audio's gain stages) must clip, not wrap around into noise.
 */
export function floatTo16BitPcm(input: Float32Array): Uint8Array {
  const out = new Uint8Array(input.length * BYTES_PER_SAMPLE);
  const view = new DataView(out.buffer);
  for (let i = 0; i < input.length; i += 1) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * BYTES_PER_SAMPLE, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

/** Convert 16-bit little-endian PCM bytes back to mono float samples (-1..1). */
export function pcm16ToFloat32(bytes: Uint8Array): Float32Array {
  // A trailing odd byte is dropped rather than throwing: a split WS frame can
  // deliver an incomplete sample, and dropping one sample is inaudible while a
  // throw would kill the audio stream.
  const count = Math.floor(bytes.length / BYTES_PER_SAMPLE);
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * BYTES_PER_SAMPLE);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = view.getInt16(i * BYTES_PER_SAMPLE, true) / 0x8000;
  }
  return out;
}

/**
 * RMS energy of mono float samples (0 = silence, ~0.7 = full-scale sine).
 * Pure — the client-side barge-in detector runs this on every mic frame.
 */
export function rmsFloat32(input: Float32Array): number {
  if (!input.length) return 0;
  let sum = 0;
  for (let i = 0; i < input.length; i += 1) {
    const s = input[i];
    sum += s * s;
  }
  return Math.sqrt(sum / input.length);
}

/**
 * Laughter-vs-speech gate for the mic RMS stream (owner 2026-10-01).
 *
 * Laughter is rhythmic: voiced bursts ("ha-ha-ha") at ~3–8 syllables/s with
 * dips between them. Plain loud speech is sustained energy without the dips;
 * a cough is one spike. So: ≥3 upward crossings through HI, each pair
 * separated by a dip below LO, intervals within [120, 400] ms. Conservative
 * on purpose — a missed laugh is invisible, a false "[tertawa]" tag makes
 * Mia comment on laughter that never happened.
 *
 * @param rms      Recent per-frame RMS, oldest-first (one entry per mic frame).
 * @param frameMs  Mic frame period in ms (≈85 for the 4096-sample processor).
 */
export function detectLaughter(rms: number[], frameMs = 85): boolean {
  const HI = 0.06;
  const LO = 0.025;
  const MIN_GAP_MS = 120;
  const MAX_GAP_MS = 400;
  const NEED_BURSTS = 3;
  let bursts = 0;
  let lastBurstAt = -Infinity;
  let dipped = true; // require a dip before the first counted burst
  for (let i = 0; i < rms.length; i += 1) {
    const v = rms[i] ?? 0;
    if (v < LO) {
      dipped = true;
      continue;
    }
    if (v >= HI && dipped) {
      const at = i * frameMs;
      if (bursts === 0 || (at - lastBurstAt >= MIN_GAP_MS && at - lastBurstAt <= MAX_GAP_MS)) {
        bursts += 1;
        lastBurstAt = at;
        if (bursts >= NEED_BURSTS) return true;
      } else if (at - lastBurstAt > MAX_GAP_MS) {
        bursts = 1;
        lastBurstAt = at;
      }
      dipped = false;
    }
  }
  return false;
}

/**
 * Wrap raw 16-bit mono PCM in a 44-byte WAV container.
 *
 * This is what lets the Live path reuse the existing `AudioPlayer` unchanged:
 * `decodeAudioData` needs a container, and `AudioPlayer.stop()` (barge-in) is
 * the behaviour we already depend on. Rebuilding a player just for PCM would
 * duplicate the guard-locked `pump()` and the `onDrained` contract.
 */
export function pcmToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const writeStr = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true); // Chunk size
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, 1, true); // channels = mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true); // byte rate
  view.setUint16(32, BYTES_PER_SAMPLE, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, pcm.length, true);

  const out = new Uint8Array(44 + pcm.length);
  out.set(new Uint8Array(header), 0);
  out.set(pcm, 44);
  return out;
}

/**
 * Fade the tail of raw 16-bit LE mono PCM to silence over the last `ms`.
 *
 * Why (owner 2026-10-01): a turn's last chunk stops dead on a non-zero sample
 * and the instant drop to silence is an audible end-click ("noise di akhir
 * suara"). Ramping the final milliseconds to zero removes it; the head of the
 * chunk is untouched so only the very end changes. Returns a copy.
 */
export function applyFadeOut(pcm: Uint8Array, sampleRate: number = 24_000, ms: number = 15): Uint8Array {
  const out = new Uint8Array(pcm);
  const frames = Math.floor(out.length / 2);
  const fadeFrames = Math.min(frames, Math.max(1, Math.round((sampleRate * ms) / 1000)));
  const view = new DataView(out.buffer);
  for (let i = 0; i < fadeFrames; i += 1) {
    const idx = frames - fadeFrames + i;
    const gain = 1 - (i + 1) / (fadeFrames + 1);
    const s = view.getInt16(idx * 2, true);
    view.setInt16(idx * 2, Math.round(s * gain), true);
  }
  return out;
}

/** Encode raw PCM bytes as base64 (no `Buffer` — this runs in the browser). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked so a large frame cannot blow the argument limit of `fromCharCode`.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Decode base64 to raw bytes. */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Fixed-size playout chunk for Live voice: 0.5 s of 24 kHz mono 16-bit PCM.
 *
 * Why this exists (2026-09-30): chaining chunk starts (`nextTime` in
 * `AudioPlayer`) removed the per-chunk scheduling gap, but the voice still
 * stuttered "like a broken cassette". The remaining cause is upstream of the
 * player: Google's PCM frames are small and arrive with network jitter, so
 * playing each frame as its own WAV means every late frame is an audible
 * hole. Buffering ~0.5 s of audio and emitting fixed-size chunks trades a
 * half-second of latency for continuous sound — the standard playout-buffer
 * tradeoff, and the right one while choppiness is the complaint.
 */
export const LIVE_PLAY_CHUNK_BYTES = 24_000;

/**
 * Startup prebuffer for Live voice: playback of a turn starts only after this
 * many bytes are held (owner 2026-10-01 — gaps between chunks on Chrome macOS).
 * Two 0.5 s chunks = ~1 s of latency traded for a full second of jitter
 * headroom, the same tradeoff a native player makes. A turn shorter than this
 * still plays: the turn-end flush releases whatever is held.
 */
export const LIVE_PREBUFFER_BYTES = LIVE_PLAY_CHUNK_BYTES * 2;

export interface PcmChunker {
  /** Append bytes; returns every full chunk that is now ready, in order. */
  push: (pcm: Uint8Array) => Uint8Array[];
  /** Emit the leftover tail (possibly short), or null when empty. */
  flush: () => Uint8Array | null;
  /** Drop everything buffered (interrupt/stop: stale audio must never play). */
  reset: () => void;
  /** Bytes currently held. */
  readonly buffered: () => number;
}

/** Accumulate raw PCM and emit fixed-size chunks. Pure logic, no timers. */
export function createPcmChunker(bytesPerChunk: number = LIVE_PLAY_CHUNK_BYTES): PcmChunker {
  let buf = new Uint8Array(0);
  const take = (n: number): Uint8Array => {
    const head = buf.slice(0, n);
    const rest = new Uint8Array(buf.length - n);
    rest.set(buf.subarray(n));
    buf = rest;
    return head;
  };
  return {
    push: (pcm: Uint8Array) => {
      if (!pcm.length) return [];
      const grown = new Uint8Array(buf.length + pcm.length);
      grown.set(buf, 0);
      grown.set(pcm, buf.length);
      buf = grown;
      const out: Uint8Array[] = [];
      while (buf.length >= bytesPerChunk) out.push(take(bytesPerChunk));
      return out;
    },
    flush: () => {
      if (!buf.length) return null;
      return take(buf.length);
    },
    reset: () => {
      buf = new Uint8Array(0);
    },
    buffered: () => buf.length,
  };
}
