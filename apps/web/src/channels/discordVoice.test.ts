import { describe, expect, it } from "vitest";
import {
  discordPcmToLiveInput,
  int16ToBytes,
  liveAudioToDiscordPcm,
  opusPcmToLiveMono,
} from "./discordVoice";

/**
 * Format bridges between Discord voice (48 kHz stereo Int16 PCM) and the Gemini
 * Live wire (16 kHz mono in, 24 kHz mono out).
 *
 * These are the two places where a silent voice channel would most plausibly
 * come from — a wrong rate, a channel that was never mixed down, or a sample
 * that wrapped instead of clamping — so they are pinned here rather than left
 * to be discovered by ear in a live channel.
 *
 * The assertions deliberately avoid an EXACT output length: the resampler in
 * `pcm.ts` decides whether the last partial frame is kept or dropped, and that
 * detail is not part of this contract. What must hold is the rate band, the
 * channel shape, and the sample values.
 */

function int16(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setInt16(0, n, true);
  return b;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Every Int16 sample of a byte buffer, little-endian. */
function samples(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: number[] = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) out.push(view.getInt16(i, true));
  return out;
}

describe("discordPcmToLiveInput — Discord 48 kHz stereo to Live 16 kHz mono", () => {
  it("mixes to mono: an opposite-phase stereo pair cancels instead of playing loud", () => {
    // Left +1000 / Right -1000 is silent when downmixed. If the channel were
    // copied instead of averaged, this would come out at full scale.
    const frame = concat([int16(1000), int16(-1000)]);
    const input = concat([frame, frame, frame, frame]);
    const out = discordPcmToLiveInput(input);
    expect(samples(out).every((s) => Math.abs(s) <= 2)).toBe(true);
  });

  it("halves the level of a mono-duplicated signal by averaging, not by dropping", () => {
    // Left == Right == 10000 → average 10000 (a pure channel copy would also
    // give 10000, so this asserts we did not silently take only one channel).
    const frame = concat([int16(10000), int16(10000)]);
    const input = concat([frame, frame, frame, frame, frame, frame]);
    const out = discordPcmToLiveInput(input);
    const peak = Math.max(...samples(out).map(Math.abs));
    expect(peak).toBeGreaterThan(9_000);
    expect(peak).toBeLessThanOrEqual(10_000);
  });

  it("lands in the 16 kHz rate band (a third of the 48 kHz frame count)", () => {
    const frames = 480; // one tenth of a second at 48 kHz
    const input = concat(Array.from({ length: frames }, () => concat([int16(0), int16(0)])));
    const outFrames = discordPcmToLiveInput(input).length / 2;
    // 160 frames at 16 kHz. Allow a frame either way for the resampler's
    // last-partial-frame decision; anything else means the rate is wrong.
    expect(outFrames).toBeGreaterThanOrEqual(158);
    expect(outFrames).toBeLessThanOrEqual(162);
  });

  it("keeps silence silent", () => {
    const input = concat(Array.from({ length: 240 }, () => concat([int16(0), int16(0)])));
    expect(samples(discordPcmToLiveInput(input)).every((s) => s === 0)).toBe(true);
  });

  it("clamps instead of wrapping (a full-scale positive stays positive)", () => {
    const input = concat(Array.from({ length: 60 }, () => concat([int16(32_767), int16(32_767)])));
    for (const s of samples(discordPcmToLiveInput(input))) {
      expect(s).toBeGreaterThan(30_000);
      expect(s).toBeLessThanOrEqual(32_767);
    }
  });

  it("returns empty for empty or odd-length input instead of throwing", () => {
    expect(discordPcmToLiveInput(new Uint8Array(0)).length).toBe(0);
    expect(() => discordPcmToLiveInput(new Uint8Array([1, 2, 3]))).not.toThrow();
  });
});

describe("liveAudioToDiscordPcm — Live 24 kHz mono to Discord 48 kHz stereo", () => {
  it("duplicates every sample into both channels so the voice is centred", () => {
    const input = concat([int16(1234), int16(5678), int16(-4321)]);
    const out = samples(liveAudioToDiscordPcm(input));
    for (let i = 0; i + 1 < out.length; i += 2) {
      expect(out[i]).toBe(out[i + 1]);
    }
  });

  it("doubles the sample rate, so each input frame yields more output samples", () => {
    const input = concat(Array.from({ length: 100 }, () => int16(100)));
    const outFrames = liveAudioToDiscordPcm(input).length / 4;
    expect(outFrames).toBeGreaterThan(180);
    expect(outFrames).toBeLessThanOrEqual(200);
  });

  it("keeps silence silent", () => {
    const input = concat(Array.from({ length: 100 }, () => int16(0)));
    expect(samples(liveAudioToDiscordPcm(input)).every((s) => s === 0)).toBe(true);
  });

  it("preserves the signal value through the rate conversion", () => {
    const input = concat(Array.from({ length: 100 }, () => int16(8000)));
    const out = samples(liveAudioToDiscordPcm(input));
    expect(Math.max(...out.map(Math.abs))).toBeGreaterThan(7_500);
  });

  it("returns empty for empty input instead of throwing", () => {
    expect(liveAudioToDiscordPcm(new Uint8Array(0)).length).toBe(0);
  });
});

/**
 * The sample-level decode that feeds the framing layer.
 *
 * Owner 2026-10-06: "model kadang kadang merespon kadang tidak" — the cause was
 * forwarding Discord's ragged Opus packets verbatim as realtimeInput frames, so
 * Gemini's server-side VAD never reliably saw the end of an utterance. The fix
 * is a fixed 320-sample frame, and THAT only works if this layer returns Int16
 * SAMPLES at 16 kHz mono. These tests pin the two properties the framing layer
 * depends on: the rate, and the clamp (a wrapped sample is audible garbage).
 */
describe("opusPcmToLiveMono — decoded 48 kHz stereo Opus to 16 kHz mono samples", () => {
  it("returns Int16 samples at one third of the 48 kHz frame count", () => {
    const frames = 480; // 10 ms at 48 kHz → 160 samples at 16 kHz
    const stereo = concat(Array.from({ length: frames }, () => concat([int16(500), int16(500)])));
    const mono = opusPcmToLiveMono(stereo);
    expect(mono.length).toBeGreaterThanOrEqual(158);
    expect(mono.length).toBeLessThanOrEqual(162);
    expect(mono).toBeInstanceOf(Int16Array);
  });

  it("clamps instead of wrapping, so full-scale stays full-scale positive", () => {
    const stereo = concat(Array.from({ length: 60 }, () => concat([int16(32_767), int16(32_767)])));
    for (const s of opusPcmToLiveMono(stereo)) {
      expect(s).toBeGreaterThan(30_000);
      expect(s).toBeLessThanOrEqual(32_767);
    }
  });

  it("keeps silence silent — the 3-byte DTX packets must not become noise", () => {
    // Discord sends these while the speaker is quiet; if they became audible
    // hiss the model would hear a phantom turn.
    const stereo = concat(Array.from({ length: 240 }, () => concat([int16(0), int16(0)])));
    expect(opusPcmToLiveMono(stereo).every((s) => s === 0)).toBe(true);
  });

  it("returns an empty Int16Array for empty input", () => {
    const out = opusPcmToLiveMono(new Uint8Array(0));
    expect(out.length).toBe(0);
    expect(out).toBeInstanceOf(Int16Array);
  });

  it("round-trips through int16ToBytes as little-endian, which is the wire format", () => {
    const src = Int16Array.from([1, -1, 32_767, -32_768]);
    const bytes = int16ToBytes(src);
    expect(bytes.length).toBe(8);
    expect(new DataView(bytes.buffer).getInt16(2, true)).toBe(-1);
  });
});
