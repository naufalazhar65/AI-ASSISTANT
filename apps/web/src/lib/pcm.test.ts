/**
 * Tests for the pure PCM helpers used by the Gemini Live duplex path.
 *
 * These are the numerics that a browser cannot easily prove: resampling ratios,
 * clipping behaviour, and the WAV header that lets raw PCM reuse `AudioPlayer`.
 * A silent break here would surface as "the bot's voice sounds like a chipmunk"
 * or "no audio at all", which is exactly the kind of defect that is invisible
 * to typecheck and to every log.
 */

import { describe, expect, it } from "vitest";

import {
  bytesToBase64,
  base64ToBytes,
  BYTES_PER_SAMPLE,
  createPcmChunker,
  floatTo16BitPcm,
  LIVE_INPUT_SAMPLE_RATE,
  LIVE_OUTPUT_SAMPLE_RATE,
  LIVE_PLAY_CHUNK_BYTES,
  pcm16ToFloat32,
  pcmToWav,
  resampleFloat32,
} from "./pcm";

describe("resampleFloat32", () => {
  it("returns a copy when the rate already matches", () => {
    const input = new Float32Array([0, 0.5, -0.5, 1]);
    const out = resampleFloat32(input, LIVE_INPUT_SAMPLE_RATE, LIVE_INPUT_SAMPLE_RATE);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  it("scales 48 kHz to 16 kHz by exactly one third", () => {
    const input = new Float32Array(48);
    for (let i = 0; i < input.length; i += 1) input[i] = i / 48;
    const out = resampleFloat32(input, 48_000, 16_000);
    expect(out.length).toBe(16);
  });

  it("scales 44.1 kHz to 16 kHz without an off-by-one tail", () => {
    const input = new Float32Array(441).fill(0.25);
    const out = resampleFloat32(input, 44_100, 16_000);
    expect(out.length).toBe(Math.round(441 * (16_000 / 44_100)));
    expect(out.length).toBe(160);
  });

  it("preserves a constant signal (interpolation is exact for flat input)", () => {
    const input = new Float32Array(100).fill(0.5);
    const out = resampleFloat32(input, 48_000, 16_000);
    for (const sample of out) expect(sample).toBeCloseTo(0.5, 6);
  });

  it("preserves a zero signal", () => {
    const out = resampleFloat32(new Float32Array(32), 48_000, 16_000);
    for (const sample of out) expect(sample).toBe(0);
  });

  it("upsamples 16 kHz to 24 kHz (the Live output direction)", () => {
    const input = new Float32Array(16).fill(-0.25);
    const out = resampleFloat32(input, LIVE_INPUT_SAMPLE_RATE, LIVE_OUTPUT_SAMPLE_RATE);
    expect(out.length).toBe(24);
    for (const sample of out) expect(sample).toBeCloseTo(-0.25, 6);
  });

  it("interpolates a ramp rather than dropping samples", () => {
    // Read positions are 0, 0.5, 1.0, 1.5 over input [0, 1]: the midpoint
    // between the two samples appears once, and the final input sample is held
    // for the two positions past it. This is the whole point of interpolating
    // instead of decimating — decimation would emit 0, 1 and drop the ramp.
    const input = new Float32Array([0, 1]);
    const out = resampleFloat32(input, 2, 4);
    expect(Array.from(out)).toEqual([0, 0.5, 1, 1]);
  });

  it("never mutates its input", () => {
    const input = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const snapshot = Array.from(input);
    resampleFloat32(input, 48_000, 16_000);
    expect(Array.from(input)).toEqual(snapshot);
  });

  it("reads the tail safely when the ratio rounds up", () => {
    // 3 -> 2 rounds to 2 output samples, and 2/1.5 = 1.33 means the second
    // sample needs input index 2, which exists; a naive implementation would
    // produce NaN here by reading one past the end.
    const out = resampleFloat32(new Float32Array([0.1, 0.2, 0.3]), 3, 2);
    expect(out.length).toBe(2);
    for (const sample of out) expect(Number.isNaN(sample)).toBe(false);
  });

  it("rejects a non-positive rate instead of returning garbage", () => {
    expect(() => resampleFloat32(new Float32Array(4), 0, 16_000)).toThrow();
    expect(() => resampleFloat32(new Float32Array(4), 48_000, -1)).toThrow();
  });
});

describe("floatTo16BitPcm", () => {
  it("emits 2 bytes per sample", () => {
    expect(floatTo16BitPcm(new Float32Array(10)).length).toBe(10 * BYTES_PER_SAMPLE);
  });

  it("maps 0 to silence", () => {
    const pcm = floatTo16BitPcm(new Float32Array([0]));
    expect(new DataView(pcm.buffer).getInt16(0, true)).toBe(0);
  });

  it("maps full scale to the signed extremes", () => {
    const pcm = floatTo16BitPcm(new Float32Array([1, -1]));
    const view = new DataView(pcm.buffer);
    expect(view.getInt16(0, true)).toBe(32767);
    expect(view.getInt16(2, true)).toBe(-32768);
  });

  it("CLIPS out-of-range samples instead of wrapping them", () => {
    // A wrap turns loud audio into loud noise; a clip is merely loud.
    const pcm = floatTo16BitPcm(new Float32Array([4, -4]));
    const view = new DataView(pcm.buffer);
    expect(view.getInt16(0, true)).toBe(32767);
    expect(view.getInt16(2, true)).toBe(-32768);
  });

  it("writes little-endian regardless of platform", () => {
    const pcm = floatTo16BitPcm(new Float32Array([1]));
    // 32767 little-endian is FF 7F; big-endian would be 7F FF.
    expect(pcm[0]).toBe(0xff);
    expect(pcm[1]).toBe(0x7f);
  });
});

describe("pcm16ToFloat32", () => {
  it("round-trips a signal within quantisation error", () => {
    const original = new Float32Array([0, 0.25, -0.25, 0.5, -0.5]);
    const back = pcm16ToFloat32(floatTo16BitPcm(original));
    expect(back.length).toBe(original.length);
    for (let i = 0; i < original.length; i += 1) {
      expect(back[i]).toBeCloseTo(original[i], 3);
    }
  });

  it("drops a trailing odd byte rather than throwing", () => {
    // A split WebSocket frame can deliver an incomplete sample.
    const odd = new Uint8Array(5);
    expect(pcm16ToFloat32(odd).length).toBe(2);
  });

  it("handles empty input", () => {
    expect(pcm16ToFloat32(new Uint8Array(0)).length).toBe(0);
  });
});

describe("pcmToWav", () => {
  const pcm = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

  it("produces a 44-byte header plus the samples", () => {
    expect(pcmToWav(pcm, LIVE_OUTPUT_SAMPLE_RATE).length).toBe(44 + pcm.length);
  });

  it("writes a RIFF/WAVE container that decodeAudioData can parse", () => {
    const wav = pcmToWav(pcm, LIVE_OUTPUT_SAMPLE_RATE);
    const str = (from: number, len: number) =>
      String.fromCharCode(...wav.subarray(from, from + len));
    expect(str(0, 4)).toBe("RIFF");
    expect(str(8, 4)).toBe("WAVE");
    expect(str(12, 4)).toBe("fmt ");
    expect(str(36, 4)).toBe("data");
  });

  it("declares mono 16-bit PCM at the requested rate", () => {
    const wav = pcmToWav(pcm, LIVE_OUTPUT_SAMPLE_RATE);
    const view = new DataView(wav.buffer);
    expect(view.getUint16(20, true)).toBe(1); // format = PCM
    expect(view.getUint16(22, true)).toBe(1); // channels = mono
    expect(view.getUint32(24, true)).toBe(LIVE_OUTPUT_SAMPLE_RATE);
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
  });

  it("declares sizes that match the bytes actually written", () => {
    const wav = pcmToWav(pcm, LIVE_OUTPUT_SAMPLE_RATE);
    const view = new DataView(wav.buffer);
    expect(view.getUint32(4, true)).toBe(36 + pcm.length); // RIFF size
    expect(view.getUint32(40, true)).toBe(pcm.length); // data size
    expect(view.getUint32(28, true)).toBe(LIVE_OUTPUT_SAMPLE_RATE * BYTES_PER_SAMPLE);
  });

  it("places the samples immediately after the header", () => {
    const wav = pcmToWav(pcm, LIVE_OUTPUT_SAMPLE_RATE);
    expect(Array.from(wav.subarray(44))).toEqual(Array.from(pcm));
  });

  it("handles an empty payload without a negative size", () => {
    const wav = pcmToWav(new Uint8Array(0), LIVE_OUTPUT_SAMPLE_RATE);
    expect(wav.length).toBe(44);
    expect(new DataView(wav.buffer).getUint32(40, true)).toBe(0);
  });
});

describe("base64 helpers", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255, 42]);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });

  it("handles a payload larger than one String.fromCharCode chunk", () => {
    // The chunk boundary is 0x8000; a 16-bit PCM frame at 24 kHz is far below
    // it, but a buffered utterance could exceed it.
    const bytes = new Uint8Array(0x8000 + 17);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 256;
    const back = base64ToBytes(bytesToBase64(bytes));
    expect(back.length).toBe(bytes.length);
    expect(back[bytes.length - 1]).toBe(bytes[bytes.length - 1]);
  });

  it("encodes the empty payload", () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe("");
  });
});

describe("createPcmChunker — fixed-size playout pieces for jittered frames", () => {
  const seq = (n: number, start = 0): Uint8Array => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) out[i] = (start + i) % 256;
    return out;
  };

  it("emits nothing until a full chunk is buffered", () => {
    const chunker = createPcmChunker(100);
    expect(chunker.push(seq(30))).toEqual([]);
    expect(chunker.push(seq(40, 30))).toEqual([]);
    expect(chunker.buffered()).toBe(70);
  });

  it("emits exact-size chunks in order across many small pushes", () => {
    const chunker = createPcmChunker(100);
    const got: Uint8Array[] = [];
    for (let i = 0; i < 7; i += 1) got.push(...chunker.push(seq(40, i * 40)));
    expect(got).toHaveLength(2);
    expect(got[0].length).toBe(100);
    expect(got[1].length).toBe(100);
    // Byte order preserved end to end across chunk boundaries.
    expect(got[0][0]).toBe(0);
    expect(got[0][99]).toBe(99);
    expect(got[1][0]).toBe(100);
    expect(chunker.buffered()).toBe(80);
  });

  it("flush returns the short tail and then nothing", () => {
    const chunker = createPcmChunker(100);
    chunker.push(seq(250));
    const tail = chunker.flush();
    expect(tail?.length).toBe(50);
    expect(tail?.[0]).toBe(200);
    expect(chunker.flush()).toBeNull();
    expect(chunker.buffered()).toBe(0);
  });

  it("reset drops stale audio so an interrupt never leaks into the next turn", () => {
    const chunker = createPcmChunker(100);
    chunker.push(seq(90));
    chunker.reset();
    expect(chunker.buffered()).toBe(0);
    expect(chunker.flush()).toBeNull();
    expect(chunker.push(seq(100))).toHaveLength(1);
  });

  it("the default chunk is half a second of 24 kHz mono 16-bit audio", () => {
    expect(LIVE_PLAY_CHUNK_BYTES).toBe(24_000);
  });
});
