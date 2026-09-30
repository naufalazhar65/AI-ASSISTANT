/**
 * Tests for gapless chunk chaining in {@link AudioPlayer}.
 *
 * Two bugs, both measured 2026-09-30/2026-10-01:
 * 1. `pump()` started each chunk only after the previous node's `onended`
 *    fired — a task-boundary hole at every chunk edge (inaudible for
 *    per-sentence TTS, crackle for Live's small frames).
 * 2. The same await-then-schedule shape survived the `nextTime` chaining:
 *    chained times but late scheduling still left a millisecond hole per
 *    0.5 s chunk = constant static over clean audio (raw file clean, Live
 *    kresek, Swift smooth). The fix schedules everything queued UP FRONT and
 *    parks (waker, no polling) while audio plays with nothing new queued.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AudioPlayer } from "./AudioPlayer";

class FakeSource {
  buffer: { duration: number } | null = null;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stopped = false;
  connect(): void {}
  start(when?: number): void {
    this.startedAt = when ?? FakeContext.now;
  }
  stop(): void {
    this.stopped = true;
  }
  end(): void {
    this.onended?.();
  }
}

class FakeBuffer {
  readonly channel: Float32Array;
  readonly duration: number;
  readonly sampleRate: number;
  constructor(frames: number, sampleRate: number) {
    this.channel = new Float32Array(frames);
    this.duration = frames / sampleRate;
    this.sampleRate = sampleRate;
  }
  getChannelData(): Float32Array {
    return this.channel;
  }
}

class FakeContext {
  static now = 0;
  static sources: FakeSource[] = [];
  /** Device rate the player must match (24000 = no resample, 48000 = upsample). */
  static rate = 24_000;
  get currentTime(): number {
    return FakeContext.now;
  }
  get sampleRate(): number {
    return FakeContext.rate;
  }
  get state(): string {
    return "running";
  }
  get destination(): unknown {
    return {};
  }
  async resume(): Promise<void> {}
  async decodeAudioData(_data: ArrayBuffer): Promise<{ duration: number }> {
    // Live PCM frames decode to short buffers; the exact value only matters
    // in that every chunk in this fixture has the SAME duration.
    return { duration: 0.5 };
  }
  createBuffer(_channels: number, frames: number, sampleRate: number): FakeBuffer {
    return new FakeBuffer(frames, sampleRate);
  }
  createBufferSource(): FakeSource {
    const s = new FakeSource();
    FakeContext.sources.push(s);
    return s;
  }
}

describe("AudioPlayer — consecutive chunks play gaplessly", () => {
  beforeEach(() => {
    FakeContext.now = 0;
    FakeContext.sources = [];
    vi.stubGlobal("AudioContext", FakeContext as unknown as typeof AudioContext);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function flush(times = 20): Promise<void> {
    for (let i = 0; i < times; i += 1) await Promise.resolve();
  }

  it("schedules every queued chunk up front, chained back-to-back", async () => {
    const player = new AudioPlayer();
    void player.enqueue(new ArrayBuffer(8));
    void player.enqueue(new ArrayBuffer(8));
    void player.enqueue(new ArrayBuffer(8));
    await flush();

    // Schedule-ahead (owner 2026-10-01: awaiting each `ended` before
    // scheduling the next left a hole at every boundary = constant static).
    // All three exist before the first one ends.
    expect(FakeContext.sources).toHaveLength(3);
    expect(FakeContext.sources[0]?.startedAt).toBe(0);
    expect(FakeContext.sources[1]?.startedAt).toBe(0.5);
    expect(FakeContext.sources[2]?.startedAt).toBe(1);
  });

  it("fires onDrained only after the last chunk ends", async () => {
    const player = new AudioPlayer();
    let drained = 0;
    player.onDrained = () => {
      drained += 1;
    };
    void player.enqueue(new ArrayBuffer(8));
    await flush();
    expect(drained).toBe(0);
    FakeContext.sources[0]?.end();
    await flush();
    expect(drained).toBe(1);
  });

  it("parks while audio plays with nothing queued, then schedules late arrivals", async () => {
    const player = new AudioPlayer();
    void player.enqueue(new ArrayBuffer(8));
    await flush();
    expect(FakeContext.sources).toHaveLength(1);
    // A late chunk lands mid-play: the parked loop wakes and chains it.
    FakeContext.now = 0.2;
    void player.enqueue(new ArrayBuffer(8));
    await flush();
    expect(FakeContext.sources).toHaveLength(2);
    expect(FakeContext.sources[1]?.startedAt).toBe(0.5);
    FakeContext.sources[0]?.end();
    FakeContext.sources[1]?.end();
    await flush();
  });

  it("stop() resets the chain so later audio starts at now, not a stale cursor", async () => {
    const player = new AudioPlayer();
    void player.enqueue(new ArrayBuffer(8));
    await flush();
    expect(FakeContext.sources[0]?.startedAt).toBe(0);

    player.stop();
    // Real browsers fire `onended` on stop(): unpark the loop the same way so
    // it can observe the new token and bail, leaving `pumping` false.
    FakeContext.sources[0]?.end();
    await flush();
    FakeContext.now = 10;
    void player.enqueue(new ArrayBuffer(8));
    await flush();
    expect(FakeContext.sources).toHaveLength(2);
    expect(FakeContext.sources[1]?.startedAt).toBe(10);
  });
});

describe("AudioPlayer.enqueuePcm — sync PCM path for Live voice (owner 2026-10-01)", () => {
  beforeEach(() => {
    FakeContext.now = 0;
    FakeContext.sources = [];
    vi.stubGlobal("AudioContext", FakeContext as unknown as typeof AudioContext);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function flush(times = 20): Promise<void> {
    for (let i = 0; i < times; i += 1) await Promise.resolve();
  }

  it("converts int16 samples synchronously and chains the next chunk gaplessly", async () => {
    const player = new AudioPlayer();
    // 4 frames: silence, max+, min-, half+.
    const pcm = new Uint8Array([0x00, 0x00, 0xff, 0x7f, 0x00, 0x80, 0x00, 0x40]);
    player.enqueuePcm(pcm, 24_000);
    player.enqueuePcm(pcm, 24_000);
    await flush();

    // Schedule-ahead: both exist before either ends, chained on the cursor.
    expect(FakeContext.sources).toHaveLength(2);
    expect(FakeContext.sources[0]?.startedAt).toBe(0);
    const channel = (FakeContext.sources[0]?.buffer as unknown as FakeBuffer).channel;
    expect(channel[0]).toBe(0);
    expect(channel[1]).toBeCloseTo(1, 4);
    expect(channel[2]).toBe(-1);
    expect(channel[3]).toBeCloseTo(0.5, 4);

    // 4 frames at 24 kHz — chained on the cursor, no decode hop in between.
    expect(FakeContext.sources[1]?.startedAt).toBeCloseTo(4 / 24_000, 9);
  });

  it("drops empty and sub-sample input instead of scheduling silence", async () => {
    const player = new AudioPlayer();
    player.enqueuePcm(new Uint8Array(0), 24_000);
    player.enqueuePcm(new Uint8Array([0x01]), 24_000);
    await flush();
    expect(FakeContext.sources).toHaveLength(0);
  });

  it("upsamples to the device rate so Chrome never resamples per chunk", async () => {
    FakeContext.rate = 48_000;
    try {
      const player = new AudioPlayer();
      // 4 frames at 24 kHz → 8 frames at 48 kHz, same duration.
      const pcm = new Uint8Array([0x00, 0x00, 0xff, 0x7f, 0x00, 0x80, 0x00, 0x40]);
      player.enqueuePcm(pcm, 24_000);
      await flush();
      expect(FakeContext.sources).toHaveLength(1);
      const buf = FakeContext.sources[0]?.buffer as unknown as FakeBuffer;
      expect(buf.sampleRate).toBe(48_000);
      expect(buf.channel.length).toBe(8);
      expect(buf.duration).toBeCloseTo(4 / 24_000, 9);
    } finally {
      FakeContext.rate = 24_000;
    }
  });
});
