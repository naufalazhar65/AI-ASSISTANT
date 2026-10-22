/**
 * `liveClient` — the framework-agnostic Live orchestrator.
 *
 * These tests cover the loop the dashboard depends on, with every external
 * object injected (session, capture, player, fetch). The rules under test are
 * the ones that are easy to break while moving code: the spoken-confirmation
 * gate for write tools, the memory write-back, and the guarantee that EVERY
 * tool call is answered (an unanswered Live call hangs the conversation).
 */
import { describe, expect, it, vi } from "vitest";
import {
  LiveClient,
  type LiveCaptureLike,
  type LivePlayerLike,
  type LiveSessionLike,
} from "./liveClient";
import type { GeminiLiveEvent, LiveToolCall, LiveToolResult } from "./geminiLive";

function fakeSession() {
  const listeners: Array<(e: GeminiLiveEvent) => void> = [];
  const sent: LiveToolResult[][] = [];
  const texts: string[] = [];
  const session: LiveSessionLike = {
    on(fn) {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    start: async () => {
      // The real session announces its own status; the client only mirrors it.
      listeners.forEach((fn) => fn({ type: "status", status: "connecting" }));
      return { ok: true };
    },
    sendAudioFrame: () => undefined,
    sendText: (t) => texts.push(t),
    sendToolResponse: (r) => sent.push(r),
    interrupt: () => undefined,
    setAudioMuted: () => undefined,
    isAudioMuted: false,
    stop: () => undefined,
  };
  return {
    session,
    sent,
    texts,
    emit: (e: GeminiLiveEvent) => listeners.forEach((fn) => fn(e)),
  };
}

/** The tool route — NOT the tool-ping beacon, which shares the prefix. */
const toolRoute = (calls: Array<{ url: string; body: unknown }>) =>
  calls.filter((x) => x.url.endsWith("/api/gemini-live/tool"));

function fakeCapture() {
  let frameCb: ((f: Float32Array) => void) | null = null;
  const capture: LiveCaptureLike = {
    onFrame(fn) {
      frameCb = fn;
      return () => {
        frameCb = null;
      };
    },
    start: async () => undefined,
    stop: () => undefined,
  };
  return {
    capture,
    push: (f: Float32Array) => frameCb?.(f),
  };
}

function fakePlayer() {
  const played: Uint8Array[] = [];
  const player: LivePlayerLike = {
    enqueuePcm: (pcm) => played.push(pcm),
    stop: () => undefined,
    fadeStop: () => undefined,
    setTelephoneVoice: () => undefined,
  };
  return { player, played };
}

function okFetch(calls: Array<{ url: string; body: unknown }>) {
  return (async (url: string, init?: RequestInit) => {
    let body: unknown = undefined;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = undefined;
    }
    calls.push({ url: String(url), body });
    if (String(url).includes("/api/gemini-live/tool")) {
      const arr = (body as { calls?: Array<{ id: string; name: string }> })?.calls ?? [];
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: arr.map((c) => ({ id: c.id, name: c.name, result: "ok" })) }),
      } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({ saved: true }) } as unknown as Response;
  }) as unknown as typeof fetch;
}

const stream = {} as MediaStream;

describe("liveClient", () => {
  it("starts a session and a capture, and reports the ready state", async () => {
    const s = fakeSession();
    const c = fakeCapture();
    const p = fakePlayer();
    const client = new LiveClient({
      createSession: () => s.session,
      createCapture: () => c.capture,
      createPlayer: () => p.player,
      fetchImpl: okFetch([]),
    });
    const states: string[] = [];
    client.subscribe((st) => states.push(st.status));

    const res = await client.start(stream);
    expect(res.ok).toBe(true);
    // The client mirrors the session's own status; the fake announces
    // "connecting", so the client is in that state right after start.
    expect(client.getState().status).toBe("connecting");
    expect(states).toContain("connecting");
  });

  it("refuses to start without a microphone", async () => {
    const client = new LiveClient({ fetchImpl: okFetch([]) });
    const res = await client.start(null);
    expect(res.ok).toBe(false);
    expect(client.getState().error).toMatch(/microphone/i);
  });

  it("executes a read tool immediately and answers the model", async () => {
    const s = fakeSession();
    const c = fakeCapture();
    const p = fakePlayer();
    const calls: Array<{ url: string; body: unknown }> = [];
    const client = new LiveClient({
      createSession: () => s.session,
      createCapture: () => c.capture,
      createPlayer: () => p.player,
      fetchImpl: okFetch(calls),
    });
    await client.start(stream);

    const toolCall: LiveToolCall = { id: "c1", name: "web_search", args: { query: "cuaca" } };
    s.emit({ type: "tool_call", calls: [toolCall] });
    await vi.waitFor(() => expect(s.sent.length).toBe(1));
    expect(s.sent[0][0]).toMatchObject({ id: "c1", name: "web_search", result: "ok" });
    expect(toolRoute(calls).length).toBe(1);
  });

  it("holds a write tool until the user speaks an affirmation, then executes it", async () => {
    const s = fakeSession();
    const c = fakeCapture();
    const p = fakePlayer();
    const calls: Array<{ url: string; body: unknown }> = [];
    const client = new LiveClient({
      createSession: () => s.session,
      createCapture: () => c.capture,
      createPlayer: () => p.player,
      fetchImpl: okFetch(calls),
    });
    await client.start(stream);

    const write: LiveToolCall = { id: "w1", name: "save_note", args: { content: "catatan" } };
    // First sighting: the model is told to ASK, and NOTHING is executed.
    s.emit({ type: "tool_call", calls: [write] });
    await vi.waitFor(() => expect(s.sent.length).toBe(1));
    expect(s.sent[0][0].result).toMatch(/KONFIRMASI/i);
    expect(toolRoute(calls).length).toBe(0);

    // The user answers "ya" — the transcript marks that the user spoke.
    s.emit({ type: "input_transcript", text: "ya", final: true });
    s.emit({ type: "tool_call", calls: [write] });
    await vi.waitFor(() => expect(s.sent.length).toBe(2));
    expect(toolRoute(calls).length).toBe(1);
  });

  it("writes the finished turn into the daily memory", async () => {
    const s = fakeSession();
    const c = fakeCapture();
    const p = fakePlayer();
    const calls: Array<{ url: string; body: unknown }> = [];
    const client = new LiveClient({
      createSession: () => s.session,
      createCapture: () => c.capture,
      createPlayer: () => p.player,
      fetchImpl: okFetch(calls),
    });
    await client.start(stream);

    s.emit({ type: "input_transcript", text: "halo", final: true });
    s.emit({ type: "output_transcript", text: "hai", final: true });
    s.emit({ type: "speaking", speaking: false });
    await vi.waitFor(() => expect(calls.some((x) => x.url.includes("/api/gemini-live/memory"))).toBe(true));
    const mem = calls.find((x) => x.url.includes("/api/gemini-live/memory"))!;
    expect(mem.body).toMatchObject({ heard: "halo", said: "hai" });
  });

  it("answers a tool call even when the tool route fails", async () => {
    const s = fakeSession();
    const c = fakeCapture();
    const p = fakePlayer();
    const client = new LiveClient({
      createSession: () => s.session,
      createCapture: () => c.capture,
      createPlayer: () => p.player,
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    });
    await client.start(stream);

    s.emit({ type: "tool_call", calls: [{ id: "c1", name: "web_search", args: {} }] });
    await vi.waitFor(() => expect(s.sent.length).toBe(1));
    expect(s.sent[0][0].result).toMatch(/^Error:/);
  });

  it("stop() clears the pending confirmation so a stale question cannot authorize", async () => {
    const s = fakeSession();
    const c = fakeCapture();
    const p = fakePlayer();
    const calls: Array<{ url: string; body: unknown }> = [];
    const client = new LiveClient({
      createSession: () => s.session,
      createCapture: () => c.capture,
      createPlayer: () => p.player,
      fetchImpl: okFetch(calls),
    });
    await client.start(stream);

    const write: LiveToolCall = { id: "w1", name: "save_note", args: { content: "x" } };
    s.emit({ type: "tool_call", calls: [write] });
    await vi.waitFor(() => expect(s.sent.length).toBe(1));

    client.stop();
    // The user speaks and the model re-issues — after a stop, that must NOT
    // execute the write.
    s.emit({ type: "input_transcript", text: "ya", final: true });
    s.emit({ type: "tool_call", calls: [write] });
    await new Promise((r) => setTimeout(r, 10));
    expect(toolRoute(calls).length).toBe(0);
  });
});
