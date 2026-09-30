/**
 * Tests for the frame-decoding and start-settling contract of
 * {@link GeminiLiveSession}.
 *
 * The bug this file exists to prevent, measured against the real API on
 * 2026-09-30 with the owner's key: **Google sends every Live frame as BINARY**,
 * `setupComplete` included. The client read `String(event.data)`, the browser's
 * default `binaryType` is `"blob"`, so that produced the literal string
 * `"[object Blob]"`, `JSON.parse` threw, and a `catch` written to "keep the
 * session alive" silently swallowed EVERY server frame. The UI sat on
 * "Menyambung..." forever and a full working session looked like a dead API.
 *
 * The second contract is settling: `start()` must never hang, whatever the
 * server does. A WebSocket and `fetch` are stubbed so both are provable
 * in-process; the wire shapes themselves were verified against the live API
 * separately.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GeminiLiveSession, frameText, saveLiveTurnToMemory, type GeminiLiveEvent } from "./geminiLive";

/** Minimal WebSocket stand-in: the session only needs open/message/error/close. */
class FakeSocket {
  static readonly OPEN = 1;
  static last: FakeSocket | null = null;
  static lastUrl = "";

  readyState = FakeSocket.OPEN;
  /** Recorded so a test can assert the client asks for arraybuffer frames. */
  binaryType = "blob";
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    FakeSocket.last = this;
    FakeSocket.lastUrl = url;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.onopen?.();
  }

  /** Deliver a TEXT frame (some gateways still send these). */
  frame(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  /**
   * Deliver a BINARY frame the way Google actually does (measured 2026-09-30):
   * UTF-8 JSON in an ArrayBuffer.
   */
  binaryFrame(payload: unknown): void {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    this.onmessage?.({ data: bytes.buffer });
  }

  /** Deliver a raw `Blob`, i.e. what a client that never set binaryType sees. */
  blobFrame(payload: unknown): void {
    this.onmessage?.({ data: new Blob([JSON.stringify(payload)]) });
  }
}

/** Token route reply, shaped like the real one measured 2026-09-29. */
function tokenReply(overrides: Record<string, unknown> = {}): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      token: "auth_tokens/fake-token-value",
      model: "models/gemini-3.8-live",
      systemInstruction: "You are Mia.",
      ...overrides,
    }),
  } as unknown as Response;
}

describe("GeminiLiveSession.start — the promise always settles", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.last = null;
    FakeSocket.lastUrl = "";
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("settles as ready via the grace path when the server never answers at all", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => tokenReply()));
    const session = new GeminiLiveSession();
    const pending = session.start();

    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.last?.open();
    // Total silence: no setupComplete, no audio, no transcript. The session is
    // live (our frame was written) so the mic should start anyway.
    await vi.advanceTimersByTimeAsync(2_600);

    await expect(pending).resolves.toEqual({ ok: true, via: "grace" });
    expect(session.currentStatus).toBe("ready");
  });

  it("still prefers the documented setupComplete when it does arrive", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => tokenReply()));
    const session = new GeminiLiveSession();
    const pending = session.start();

    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.last?.open();
    FakeSocket.last?.frame({ setupComplete: {} });
    await vi.advanceTimersByTimeAsync(2_600);

    await expect(pending).resolves.toEqual({ ok: true, via: "setup-complete" });
  });

  it("gives up with an error when the socket never opens at all", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => tokenReply()));
    const session = new GeminiLiveSession();
    const pending = session.start();

    await vi.advanceTimersByTimeAsync(15_100);

    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.via).toBe("timeout");
    expect(result.error).toMatch(/did not come up/i);
  });

  it("reports a token-route failure instead of connecting at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: "no key" }) }) as unknown as Response)
    );
    const session = new GeminiLiveSession();
    await expect(session.start()).resolves.toEqual({ ok: false, error: "no key" });
    expect(FakeSocket.last).toBeNull();
  });

  it("sends the resolved owner key as x-mia-user so the server loads the owner's persona", async () => {
    // A stale browser value the alias table does not know: the override must
    // still resolve it to the owner, never send it through (live 2026-09-30:
    // every Live turn spoke as generic Mia — no city, no cat — because the
    // token route fell back to the default persona).
    const fetchMock = vi.fn(async (_url: string, _init?: { headers?: Record<string, string> }) => tokenReply());
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      localStorage: { getItem: () => "s", setItem: () => {} },
    });
    const session = new GeminiLiveSession();
    const pending = session.start();

    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.last?.open();
    FakeSocket.last?.frame({ setupComplete: {} });
    await vi.advanceTimersByTimeAsync(2_600);

    await expect(pending).resolves.toEqual({ ok: true, via: "setup-complete" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0][1];
    expect(init?.headers?.["x-mia-user"]).toBe("naufalazhar652952");
  });
});

describe("GeminiLiveSession — a connected but silent session is named, not spun on", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.last = null;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Start a session and get it to the ready state. */
  async function ready(): Promise<{ session: GeminiLiveSession; events: GeminiLiveEvent[] }> {
    vi.stubGlobal("fetch", vi.fn(async () => tokenReply()));
    const events: GeminiLiveEvent[] = [];
    const session = new GeminiLiveSession();
    session.on((e) => events.push(e));
    const pending = session.start();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.last?.open();
    await vi.advanceTimersByTimeAsync(2_600);
    await pending;
    return { session, events };
  }

  it("emits `stalled` when not one frame comes back", async () => {
    const { events } = await ready();
    expect(events.some((e) => e.type === "stalled")).toBe(false);

    await vi.advanceTimersByTimeAsync(20_100);

    const stalled = events.find((e) => e.type === "stalled");
    expect(stalled).toBeDefined();
    expect((stalled as { message: string }).message).toMatch(/Google/i);
  });

  it("does not emit `stalled` once the model produces anything", async () => {
    const { events } = await ready();
    FakeSocket.last?.frame({ serverContent: { outputTranscription: { text: "halo" } } });
    await vi.advanceTimersByTimeAsync(20_100);

    expect(events.some((e) => e.type === "stalled")).toBe(false);
  });

  it("does not nag a healthy session that simply has not been spoken to yet", async () => {
    // The bug this locks: the handshake alone is proof the server is talking, so
    // a duplex session waiting for the user to speak must stay silent forever.
    const { events } = await ready();
    FakeSocket.last?.binaryFrame({ setupComplete: {} });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(events.some((e) => e.type === "stalled")).toBe(false);
  });

  it("stays silent on the notice after a stop", async () => {
    const { session, events } = await ready();
    session.stop();
    await vi.advanceTimersByTimeAsync(20_100);

    expect(events.some((e) => e.type === "stalled")).toBe(false);
  });
});

describe("frameText — Google sends every Live frame as BINARY (measured 2026-09-30)", () => {
  const payload = { setupComplete: {} };
  const json = JSON.stringify(payload);

  it("passes a text frame through unchanged", () => {
    expect(frameText(json)).toBe(json);
  });

  it("decodes an ArrayBuffer frame, which is what the live API actually sends", () => {
    const bytes = new TextEncoder().encode(json);
    expect(frameText(bytes.buffer)).toBe(json);
  });

  it("decodes an ArrayBufferView (a subarray keeps the right byte range)", () => {
    const padded = new TextEncoder().encode(`xx${json}yy`);
    const view = new Uint8Array(padded.buffer, 2, json.length);
    expect(frameText(view)).toBe(json);
  });

  it("decodes multi-byte UTF-8, not byte-per-character", () => {
    const text = JSON.stringify({ serverContent: { outputTranscription: { text: "halo — baik" } } });
    expect(frameText(new TextEncoder().encode(text).buffer)).toBe(text);
  });

  it("returns empty for a Blob, which cannot be read synchronously", () => {
    // Unreachable once `binaryType` is "arraybuffer", and the old code's real
    // bug was that it fed the Blob to JSON.parse. Never throw, never pretend.
    expect(frameText(new Blob([json]))).toBe("");
  });

  it("returns empty for junk instead of throwing", () => {
    expect(frameText(undefined)).toBe("");
    expect(frameText(null)).toBe("");
    expect(frameText(42)).toBe("");
    expect(frameText({})).toBe("");
    expect(frameText(new ArrayBuffer(0))).toBe("");
  });
});

describe("GeminiLiveSession — transcripts accumulate per turn instead of overwriting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.last = null;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function startListening(): Promise<{ session: GeminiLiveSession; events: GeminiLiveEvent[] }> {
    vi.stubGlobal("fetch", vi.fn(async () => tokenReply()));
    const events: GeminiLiveEvent[] = [];
    const session = new GeminiLiveSession();
    session.on((e) => events.push(e));
    const pending = session.start();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.last?.open();
    FakeSocket.last?.frame({ setupComplete: {} });
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    events.length = 0;
    return { session, events };
  }

  function lastOf(events: GeminiLiveEvent[], type: "input_transcript" | "output_transcript"): string {
    const found = events.filter((e) => e.type === type).at(-1) as { text: string } | undefined;
    return found?.text ?? "";
  }

  it("appends chunks so subtitles never look cut off mid-sentence", async () => {
    const { events } = await startListening();
    FakeSocket.last?.frame({ serverContent: { outputTranscription: { text: "Halo," } } });
    FakeSocket.last?.frame({ serverContent: { outputTranscription: { text: "kabar kamu?" } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(lastOf(events, "output_transcript")).toBe("Halo, kabar kamu?");
  });

  it("starts fresh on the next turn but keeps the finished turn readable until then", async () => {
    const { events } = await startListening();
    FakeSocket.last?.frame({ serverContent: { outputTranscription: { text: "Siap." }, turnComplete: true } });
    await vi.advanceTimersByTimeAsync(0);
    expect(lastOf(events, "output_transcript")).toBe("Siap.");
    // No wipe on complete: the words stay until the next turn speaks.
    FakeSocket.last?.frame({ serverContent: { outputTranscription: { text: "Lanjut." } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(lastOf(events, "output_transcript")).toBe("Lanjut.");
  });

  it("accumulates the user's side independently from the model's", async () => {
    const { events } = await startListening();
    FakeSocket.last?.frame({ serverContent: { inputTranscription: { text: "putar" } } });
    FakeSocket.last?.frame({ serverContent: { outputTranscription: { text: "Oke," } } });
    FakeSocket.last?.frame({ serverContent: { inputTranscription: { text: "lagu M2M" } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(lastOf(events, "input_transcript")).toBe("putar lagu M2M");
    expect(lastOf(events, "output_transcript")).toBe("Oke,");
  });

  it("strips the 🌸 flower from Live transcripts (owner 2026-09-30: emoji stutters the voice)", async () => {
    const { events } = await startListening();
    FakeSocket.last?.frame({ serverContent: { outputTranscription: { text: "Halo 🌸" } } });
    FakeSocket.last?.frame({ serverContent: { outputTranscription: { text: "apa kabar? 🌸" } } });
    await vi.advanceTimersByTimeAsync(0);
    const said = lastOf(events, "output_transcript");
    expect(said).not.toContain("🌸");
    expect(said).toContain("Halo");
    expect(said).toContain("apa kabar?");
  });

  it("ignores a flower-only chunk instead of appending a dangling space", async () => {
    const { events } = await startListening();
    FakeSocket.last?.frame({ serverContent: { outputTranscription: { text: "Halo" } } });
    FakeSocket.last?.frame({ serverContent: { outputTranscription: { text: "🌸" } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(lastOf(events, "output_transcript")).toBe("Halo");
  });
});

describe("GeminiLiveSession — a binary handshake and binary audio are actually delivered", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.last = null;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("asks for arraybuffer frames instead of the browser's blob default", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => tokenReply()));
    const session = new GeminiLiveSession();
    const pending = session.start();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.last?.open();

    // The one line whose absence made a working API look dead for hours.
    expect(FakeSocket.last?.binaryType).toBe("arraybuffer");

    await vi.advanceTimersByTimeAsync(2_600);
    await pending;
  });

  it("settles on a BINARY setupComplete rather than falling back to the grace path", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => tokenReply()));
    const session = new GeminiLiveSession();
    const pending = session.start();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.last?.open();
    FakeSocket.last?.binaryFrame({ setupComplete: {} });
    await vi.advanceTimersByTimeAsync(2_600);

    await expect(pending).resolves.toEqual({ ok: true, via: "setup-complete" });
  });

  it("fans out binary audio and transcriptions to the listener", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => tokenReply()));
    const events: GeminiLiveEvent[] = [];
    const session = new GeminiLiveSession();
    session.on((e) => events.push(e));
    const pending = session.start();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.last?.open();
    FakeSocket.last?.binaryFrame({ setupComplete: {} });
    await vi.advanceTimersByTimeAsync(0);

    // base64 of two zero bytes, the shape of a real 24 kHz PCM frame head.
    FakeSocket.last?.binaryFrame({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: "AAA=" } }] },
        inputTranscription: { text: "halo" },
        turnComplete: true,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    await pending;

    const audio = events.find((e) => e.type === "audio") as { pcm: Uint8Array } | undefined;
    expect(audio?.pcm).toBeInstanceOf(Uint8Array);
    expect(audio?.pcm.length).toBe(2);
    expect(events.some((e) => e.type === "input_transcript")).toBe(true);
    expect(events.some((e) => e.type === "speaking")).toBe(true);
  });

  it("ignores a Blob frame without throwing and without settling the start early", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => tokenReply()));
    const session = new GeminiLiveSession();
    const pending = session.start();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.last?.open();
    FakeSocket.last?.blobFrame({ setupComplete: {} });
    await vi.advanceTimersByTimeAsync(2_600);

    // Undecodable, so it must not be mistaken for a handshake.
    await expect(pending).resolves.toEqual({ ok: true, via: "grace" });
  });
});

describe("GeminiLiveSession — tool calling (Phase B)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.last = null;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function startReady(tools?: Array<{ name: string; description: string }>): Promise<GeminiLiveSession> {
    vi.stubGlobal("fetch", vi.fn(async () => tokenReply(tools ? { tools } : {})));
    const session = new GeminiLiveSession();
    const pending = session.start();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.last?.open();
    FakeSocket.last?.frame({ setupComplete: {} });
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    return session;
  }

  it("declares the server's tools in setup and nothing when it sent none", async () => {
    await startReady([{ name: "spotify_play", description: "Play a song." }]);
    const setup = JSON.parse(FakeSocket.last?.sent[0] ?? "{}") as {
      setup?: { tools?: Array<{ functionDeclarations?: unknown[] }> };
    };
    expect(setup.setup?.tools?.[0]?.functionDeclarations).toHaveLength(1);

    FakeSocket.last = null;
    await startReady();
    // Narrowing note: the assignment above narrows the static to `null`, so
    // read it back through a fresh binding instead of `FakeSocket.last?.`.
    const bareSent = (FakeSocket.last as unknown as FakeSocket | null)?.sent[0] ?? "{}";
    const bare = JSON.parse(bareSent) as {
      setup?: Record<string, unknown>;
    };
    expect(bare.setup && "tools" in bare.setup).toBe(false);
  });

  it("fans out a top-level toolCall frame and drops malformed entries", async () => {
    const session = await startReady();
    const events: GeminiLiveEvent[] = [];
    session.on((e) => events.push(e));

    FakeSocket.last?.frame({
      toolCall: {
        functionCalls: [
          { name: "spotify_play", args: { query: "M2M" }, id: "call_1" },
          { name: "", args: {} },
          { args: { query: "x" } },
          { name: "spotify_status", args: null, id: "" },
        ],
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    const toolEvents = events.filter((e) => e.type === "tool_call");
    expect(toolEvents).toHaveLength(1);
    const calls = (toolEvents[0] as { calls: Array<{ id: string; name: string; args: unknown }> }).calls;
    expect(calls).toEqual([
      { id: "call_1", name: "spotify_play", args: { query: "M2M" } },
      { id: "live-3", name: "spotify_status", args: {} },
    ]);
  });

  it("stays silent on a toolCall frame with no usable calls", async () => {
    const session = await startReady();
    const events: GeminiLiveEvent[] = [];
    session.on((e) => events.push(e));

    FakeSocket.last?.frame({ toolCall: { functionCalls: [{ name: "", args: {} }] } });
    FakeSocket.last?.frame({ toolCall: {} });
    await vi.advanceTimersByTimeAsync(0);

    expect(events.filter((e) => e.type === "tool_call")).toHaveLength(0);
  });

  it("answers with toolResponse.functionResponses, one entry per call", async () => {
    const session = await startReady();
    session.sendToolResponse([
      { id: "call_1", name: "spotify_play", result: "(Sudah kuputar: M2M)" },
      { id: "call_2", name: "spotify_status", result: "Error: not connected" },
    ]);

    const last = JSON.parse(FakeSocket.last?.sent.at(-1) ?? "{}");
    expect(last).toEqual({
      toolResponse: {
        functionResponses: [
          { id: "call_1", name: "spotify_play", response: { result: "(Sudah kuputar: M2M)" } },
          { id: "call_2", name: "spotify_status", response: { result: "Error: not connected" } },
        ],
      },
    });
  });

  it("sends nothing for an empty result list", async () => {
    const session = await startReady();
    const sent = FakeSocket.last?.sent;
    const before = sent?.length ?? 0;
    session.sendToolResponse([]);
    expect(sent?.length ?? 0).toBe(before);
  });

  it("drops outgoing audio while muted but keeps the session alive", async () => {
    const session = await startReady();
    expect(session.isAudioMuted).toBe(false);

    const framesBefore = FakeSocket.last?.sent.length ?? 0;
    session.sendAudioFrame(new Uint8Array([1, 2, 3, 4]), "AQIDBA==");
    expect((FakeSocket.last?.sent.length ?? 0)).toBe(framesBefore + 1);

    // Muting drops frames instead of ending anything: the socket stays open
    // and no close/error may be emitted for a mute.
    session.setAudioMuted(true);
    expect(session.isAudioMuted).toBe(true);
    session.sendAudioFrame(new Uint8Array([5, 6, 7, 8]), "BQYHCA==");
    expect(FakeSocket.last?.sent.length).toBe(framesBefore + 1);
    expect(session.currentStatus).toBe("ready");

    session.setAudioMuted(false);
    session.sendAudioFrame(new Uint8Array([9]), "CQ==");
    expect(FakeSocket.last?.sent.length).toBe(framesBefore + 2);
  });

  it("sends the resolved owner key as x-mia-user so the server loads the owner's persona", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: { headers?: Record<string, string> }) => tokenReply());
    vi.stubGlobal("fetch", fetchMock);
    // A stale browser value the alias table does not know: the override must
    // still resolve it to the owner, never send it through.
    vi.stubGlobal("window", {
      localStorage: { getItem: () => "s", setItem: () => {} },
    });
    const session = new GeminiLiveSession();
    const pending = session.start();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.last?.open();
    FakeSocket.last?.frame({ setupComplete: {} });
    await vi.advanceTimersByTimeAsync(2_600);
    await expect(pending).resolves.toEqual({ ok: true, via: "setup-complete" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
    expect(init?.headers?.["x-mia-user"]).toBe("naufalazhar652952");
  });
});

describe("saveLiveTurnToMemory — fire-and-forget write-back, never throws", () => {
  const post = (body: unknown, user = "naufalazhar652952") =>
    vi.fn(async () => ({ ok: true, json: async () => ({}) }) as unknown as Response);

  it("POSTs heard/said with the user header for a real turn", async () => {
    const fetchMock = post({});
    await saveLiveTurnToMemory("halo beb", "halo juga", { "x-mia-user": "naufalazhar652952" }, fetchMock);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers?: Record<string, string>; body?: string }];
    expect(url).toBe("/api/gemini-live/memory");
    expect(init.headers?.["x-mia-user"]).toBe("naufalazhar652952");
    expect(JSON.parse(init.body ?? "{}")).toEqual({ heard: "halo beb", said: "halo juga" });
  });

  it("skips the network entirely on an empty turn", async () => {
    const fetchMock = post({});
    await saveLiveTurnToMemory("   ", "", { "x-mia-user": "naufalazhar652952" }, fetchMock);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws when the network fails", async () => {
    const failing = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(
      saveLiveTurnToMemory("halo", "hai", { "x-mia-user": "naufalazhar652952" }, failing as unknown as typeof fetch)
    ).resolves.toBe(false);
  });
});
