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
  stoppedAt: number | null = null;
  stopped = false;
  connect(_dest?: unknown): void {}
  start(when?: number): void {
    this.startedAt = when ?? FakeContext.now;
  }
  stop(when?: number): void {
    this.stopped = true;
    this.stoppedAt = when ?? FakeContext.now;
  }
  end(): void {
    this.onended?.();
  }
}

class FakeGainParam {
  value = 1;
  events: Array<{ type: string; at?: number; value?: number }> = [];
  cancelScheduledValues(at: number): void {
    this.events.push({ type: "cancel", at });
  }
  setValueAtTime(value: number, at: number): void {
    this.value = value;
    this.events.push({ type: "set", at, value });
  }
  linearRampToValueAtTime(value: number, at: number): void {
    this.events.push({ type: "ramp", at, value });
  }
}

class FakeGain {
  readonly gain = new FakeGainParam();
  connect(_dest?: unknown): void {}
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
  createGain(): FakeGain {
    return new FakeGain();
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

  it("fadeStop glides the audible node out instead of chopping it", async () => {
    const player = new AudioPlayer();
    void player.enqueue(new ArrayBuffer(8));
    void player.enqueue(new ArrayBuffer(8));
    await flush();
    expect(FakeContext.sources).toHaveLength(2);

    FakeContext.now = 0.1;
    player.fadeStop();
    await flush();

    // Every scheduled node ramps to zero over ~180 ms and stops just past
    // it — no hard cut, no click, no stale tail leaking through.
    for (const s of FakeContext.sources) {
      expect(s.stoppedAt).toBeCloseTo(0.1 + 0.18 + 0.02, 9);
    }
    // Queued-but-unplayed audio never sounds.
    expect(FakeContext.sources).toHaveLength(2);
    // A new turn starts at now against silence, overlapping the fading tail.
    FakeContext.now = 0.15;
    void player.enqueue(new ArrayBuffer(8));
    await flush();
    expect(FakeContext.sources).toHaveLength(3);
    expect(FakeContext.sources[2]?.startedAt).toBe(0.15);
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

/**
 * Telephone voice (owner 2026-10-06: "bisa ga output suaranya dibuat seperti
 * kita sedang menelpon orang, jadi jangan terlalu jernih").
 *
 * A phone call is band-limited (~300-3400 Hz) and heavily compressed — that
 * combination is what the ear reads as "on the phone", so the chain is
 * high-pass -> low-pass -> compressor -> makeup gain, routed through ONE
 * persistent per-context bus instead of `ctx.destination`.
 */
describe("AudioPlayer — telephone voice bus (owner 2026-10-06)", () => {
  const DEST = { name: "destination" };

  class Rec {
    connections: unknown[] = [];
    params: Record<string, { value: number }> = {};
    // Optional on purpose: the tests pick stages with an `in` check
    // (`"type" in n`), so an initialised field would make every node look like
    // a band stage.
    type?: string;
    frequency?: { value: number };
    Q?: { value: number };
    gain?: { value: number };
    threshold?: { value: number };
    ratio?: { value: number };
    knee?: { value: number };
    attack?: { value: number };
    release?: { value: number };
    param(v: number): { value: number } {
      const p = { value: v };
      this.params.value = p;
      return p;
    }
    connect(dest: unknown): void {
      this.connections.push(dest);
    }
  }

  class RichContext {
    static now = 0;
    static created: Rec[] = [];
    get currentTime(): number {
      return RichContext.now;
    }
    get sampleRate(): number {
      return 24_000;
    }
    get state(): string {
      return "running";
    }
    get destination(): unknown {
      return DEST;
    }
    async resume(): Promise<void> {}
    createBuffer(_c: number, frames: number): { getChannelData(): Float32Array; duration: number } {
      return { getChannelData: () => new Float32Array(frames), duration: 0.5 };
    }
    createGain(): Rec {
      const n = new Rec();
      n.gain = n.param(1);
      RichContext.created.push(n);
      return n;
    }
    createBufferSource(): { buffer: unknown; start(): void; stop(): void; onended: (() => void) | null; connect(d: unknown): void } {
      return {
        buffer: null,
        start: () => {},
        stop: () => {},
        onended: null,
        connect: (d: unknown) => void d,
      };
    }
    createBiquadFilter(): Rec {
      const n = new Rec();
      n.type = "";
      n.frequency = n.param(0);
      n.Q = n.param(1);
      RichContext.created.push(n);
      return n;
    }
    createDynamicsCompressor(): Rec {
      const n = new Rec();
      n.threshold = n.param(0);
      n.knee = n.param(0);
      n.ratio = n.param(1);
      n.attack = n.param(0);
      n.release = n.param(0);
      RichContext.created.push(n);
      return n;
    }
  }

  beforeEach(() => {
    RichContext.now = 0;
    RichContext.created = [];
    vi.stubGlobal("AudioContext", RichContext as unknown as typeof AudioContext);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("routes chunks through a band-limited, compressed bus when enabled", async () => {
    const player = new AudioPlayer();
    player.setTelephoneVoice(true);
    expect(player.telephoneVoice()).toBe(true);
    player.enqueuePcm(new Uint8Array(2400), 24_000);
    await new Promise((r) => setTimeout(r, 5));

    const biquads = RichContext.created.filter((n) => "type" in n) as (Rec & { type: string; frequency: { value: number } })[];
    const hp = biquads.find((b) => b.type === "highpass");
    const lp = biquads.find((b) => b.type === "lowpass");
    expect(hp?.frequency.value).toBe(300);
    expect(lp?.frequency.value).toBe(3400);
    const comp = RichContext.created.find((n) => "threshold" in n) as Rec & { threshold: { value: number }; ratio: { value: number } };
    expect(comp.threshold.value).toBe(-30);
    expect(comp.ratio.value).toBe(12);
    // Makeup gain: band-passing throws away energy, so the voice must not
    // come out quiet.
    const gains = RichContext.created.filter((n) => "gain" in n) as (Rec & { gain: { value: number } })[];
    expect(gains.some((g) => g.gain.value > 1.2)).toBe(true);
    // The chain must terminate at the speakers.
    const last = RichContext.created[RichContext.created.length - 1]!;
    expect(last.connections).toContain(DEST);
  });

  it("connects straight to the destination when disabled (studio-clean)", async () => {
    const player = new AudioPlayer();
    expect(player.telephoneVoice()).toBe(false);
    player.enqueuePcm(new Uint8Array(2400), 24_000);
    await new Promise((r) => setTimeout(r, 5));
    expect(RichContext.created.some((n) => "type" in n)).toBe(false);
    expect(RichContext.created.some((n) => "threshold" in n)).toBe(false);
  });

  it("bypasses the bus when the context cannot build the chain", async () => {
    // A bare context (no biquad / compressor factories) must still PLAY, not
    // throw and not half-filter: fewer than two real stages = no telephone.
    class BareContext {
      static now = 0;
      get currentTime(): number {
        return 0;
      }
      get sampleRate(): number {
        return 24_000;
      }
      get state(): string {
        return "running";
      }
      get destination(): unknown {
        return DEST;
      }
      async resume(): Promise<void> {}
      createBuffer(_c: number, frames: number): { getChannelData(): Float32Array; duration: number } {
        return { getChannelData: () => new Float32Array(frames), duration: 0.5 };
      }
      createGain(): Rec {
        const n = new Rec();
        n.gain = n.param(1);
        return n;
      }
      createBufferSource(): {
        buffer: unknown;
        start(): void;
        stop(): void;
        onended: (() => void) | null;
        connect(dest: unknown): void;
      } {
        return { buffer: null, start: () => {}, stop: () => {}, onended: null, connect: (d: unknown) => void d };
      }
    }
    vi.stubGlobal("AudioContext", BareContext as unknown as typeof AudioContext);
    const player = new AudioPlayer();
    player.setTelephoneVoice(true);
    expect(() => player.enqueuePcm(new Uint8Array(2400), 24_000)).not.toThrow();
    await new Promise((r) => setTimeout(r, 5));
    expect(player.telephoneVoice()).toBe(true);
  });

  it("reuses one bus across chunks instead of rebuilding per chunk", async () => {
    const player = new AudioPlayer();
    player.setTelephoneVoice(true);
    player.enqueuePcm(new Uint8Array(2400), 24_000);
    player.enqueuePcm(new Uint8Array(2400), 24_000);
    await new Promise((r) => setTimeout(r, 5));
    // Two chunks must not mean two high-pass filters.
    const hp = RichContext.created.filter((n) => (n as { type?: string }).type === "highpass");
    expect(hp.length).toBe(1);
  });
});
