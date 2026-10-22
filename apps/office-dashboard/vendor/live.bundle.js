"use strict";
var MiaLive = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // apps/web/src/lib/liveBrowserEntry.ts
  var liveBrowserEntry_exports = {};
  __export(liveBrowserEntry_exports, {
    LiveClient: () => LiveClient,
    browserUserHeader: () => browserUserHeader
  });

  // apps/web/src/lib/pcm.ts
  var LIVE_INPUT_SAMPLE_RATE = 16e3;
  var LIVE_OUTPUT_SAMPLE_RATE = 24e3;
  var BYTES_PER_SAMPLE = 2;
  function resampleFloat32(input, fromRate, toRate) {
    if (fromRate === toRate) return new Float32Array(input);
    if (!(fromRate > 0) || !(toRate > 0)) {
      throw new Error(`resampleFloat32: bad rates ${fromRate} -> ${toRate}`);
    }
    const ratio = toRate / fromRate;
    const outLength = Math.max(1, Math.round(input.length * ratio));
    const out = new Float32Array(outLength);
    for (let i = 0; i < outLength; i += 1) {
      const pos = i / ratio;
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const a = input[Math.min(i0, input.length - 1)] ?? 0;
      const b = input[Math.min(i0 + 1, input.length - 1)] ?? a;
      out[i] = a + (b - a) * frac;
    }
    return out;
  }
  function floatTo16BitPcm(input) {
    const out = new Uint8Array(input.length * BYTES_PER_SAMPLE);
    const view = new DataView(out.buffer);
    for (let i = 0; i < input.length; i += 1) {
      const s = Math.max(-1, Math.min(1, input[i]));
      view.setInt16(i * BYTES_PER_SAMPLE, s < 0 ? s * 32768 : s * 32767, true);
    }
    return out;
  }
  function rmsFloat32(input) {
    if (!input.length) return 0;
    let sum = 0;
    for (let i = 0; i < input.length; i += 1) {
      const s = input[i];
      sum += s * s;
    }
    return Math.sqrt(sum / input.length);
  }
  function detectLaughter(rms, frameMs = 85) {
    const HI = 0.06;
    const LO = 0.025;
    const MIN_GAP_MS = 120;
    const MAX_GAP_MS = 400;
    const NEED_BURSTS = 3;
    let bursts = 0;
    let lastBurstAt = -Infinity;
    let dipped = true;
    for (let i = 0; i < rms.length; i += 1) {
      const v = rms[i] ?? 0;
      if (v < LO) {
        dipped = true;
        continue;
      }
      if (v >= HI && dipped) {
        const at = i * frameMs;
        if (bursts === 0 || at - lastBurstAt >= MIN_GAP_MS && at - lastBurstAt <= MAX_GAP_MS) {
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
  function pcmToWav(pcm, sampleRate) {
    const header = new ArrayBuffer(44);
    const view = new DataView(header);
    const writeStr = (offset, text) => {
      for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
    };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + pcm.length, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true);
    view.setUint16(32, BYTES_PER_SAMPLE, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, pcm.length, true);
    const out = new Uint8Array(44 + pcm.length);
    out.set(new Uint8Array(header), 0);
    out.set(pcm, 44);
    return out;
  }
  function applyFadeOut(pcm, sampleRate = 24e3, ms = 15) {
    const out = new Uint8Array(pcm);
    const frames = Math.floor(out.length / 2);
    const fadeFrames = Math.min(frames, Math.max(1, Math.round(sampleRate * ms / 1e3)));
    const view = new DataView(out.buffer);
    for (let i = 0; i < fadeFrames; i += 1) {
      const idx = frames - fadeFrames + i;
      const gain = 1 - (i + 1) / (fadeFrames + 1);
      const s = view.getInt16(idx * 2, true);
      view.setInt16(idx * 2, Math.round(s * gain), true);
    }
    return out;
  }
  function bytesToBase64(bytes) {
    let binary = "";
    const CHUNK = 32768;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }
  var LIVE_PLAY_CHUNK_BYTES = 24e3;
  var LIVE_PREBUFFER_BYTES = LIVE_PLAY_CHUNK_BYTES * 2;
  function createPcmChunker(bytesPerChunk = LIVE_PLAY_CHUNK_BYTES) {
    let buf = new Uint8Array(0);
    const take = (n) => {
      const head = buf.slice(0, n);
      const rest = new Uint8Array(buf.length - n);
      rest.set(buf.subarray(n));
      buf = rest;
      return head;
    };
    return {
      push: (pcm) => {
        if (!pcm.length) return [];
        const grown = new Uint8Array(buf.length + pcm.length);
        grown.set(buf, 0);
        grown.set(pcm, buf.length);
        buf = grown;
        const out = [];
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
      buffered: () => buf.length
    };
  }

  // apps/web/src/audio/AudioPlayer.ts
  var AudioPlayer = class {
    constructor() {
      this.ctx = null;
      this.queue = [];
      this.current = null;
      this.playToken = 0;
      /**
       * End time of the last scheduled chunk. Consecutive chunks are chained
       * back-to-back on this cursor instead of starting each one after the
       * previous node's `onended` fires: that await crosses a JS task boundary,
       * leaving a scheduling gap between every two chunks. For per-sentence TTS
       * the gap is an inaudible pause; for Live's many small PCM frames it is
       * crackle (measured 2026-09-30 against a native AVAudioPlayerNode path,
       * which chains buffers gaplessly). Reset on `stop()`.
       */
      this.nextTime = 0;
      /** Called once when the queued audio has finished playing. */
      this.onDrained = null;
      this.pumping = false;
      /**
       * Buffers scheduled but not yet ended. Lets the loop park while audio is
       * still playing with nothing new queued (network jitter), instead of
       * exiting and losing the chain.
       */
      this.pending = 0;
      /**
       * Every scheduled-but-unended node with its gain. `fadeStop` glides ALL of
       * them out at once — fading only the last-scheduled node would let earlier
       * ones keep playing stale audio for up to a full chunk.
       */
      this.live = /* @__PURE__ */ new Set();
      /** Resolves the parked loop when a chunk lands, all audio ends, or stop(). */
      this.wake = null;
      /**
       * Telephone character (owner 2026-10-06: "jangan terlalu jernih" — make it
       * sound like a phone call, not a studio mic). OFF in the constructor sense:
       * the flag is read from a persisted preference so the smooth 2026-10-01
       * playback is one toggle away, never a rewrite.
       */
      this.telephone = false;
      /** Lazily built per-context output bus (see `outputBus`). */
      this.bus = null;
    }
    /** Feed a WAV/raw audio chunk. Playback starts automatically if idle. */
    async enqueue(data) {
      const ctx = this.ensureContext();
      let buffer;
      try {
        buffer = await ctx.decodeAudioData(data);
      } catch {
        return;
      }
      this.queue.push(buffer);
      this.wake?.();
      void this.pump();
    }
    /**
     * Feed raw 16-bit LE mono PCM, synchronously.
     *
     * This is the Live voice path (owner 2026-10-01: "patah-patah ada jedanya",
     * Chrome macOS — while the native Swift build is smooth). `enqueue` above
     * awaits `decodeAudioData` per chunk: that async hop lands the buffer in the
     * queue tens of milliseconds late, and under network jitter the `pump()` loop
     * then finds an empty queue at a chunk boundary — an audible hole. Building
     * the `AudioBuffer` directly from the samples is synchronous, so a chunk is
     * scheduled the same task it arrives in and the `nextTime` chain never
     * starves. A trailing odd byte is dropped (one sample is inaudible; a throw
     * would kill the stream — same contract as `pcm16ToFloat32`).
     */
    enqueuePcm(pcm, sampleRate) {
      const frames = Math.floor(pcm.length / 2);
      if (!frames) return;
      const ctx = this.ensureContext();
      const view = new DataView(pcm.buffer, pcm.byteOffset, frames * 2);
      const raw = new Float32Array(frames);
      for (let i = 0; i < frames; i += 1) {
        raw[i] = view.getInt16(i * 2, true) / 32768;
      }
      const data = ctx.sampleRate === sampleRate ? raw : resampleFloat32(raw, sampleRate, ctx.sampleRate);
      const buffer = ctx.createBuffer(1, data.length, ctx.sampleRate);
      buffer.getChannelData(0).set(data);
      this.queue.push(buffer);
      this.wake?.();
      void this.pump();
    }
    /** Clear queue + stop speaking immediately (FR-007). */
    stop() {
      this.playToken += 1;
      this.queue = [];
      this.nextTime = 0;
      this.pending = 0;
      for (const h of [...this.live]) {
        try {
          h.node.stop();
        } catch {
        }
      }
      this.live.clear();
      this.current = null;
      this.wake?.();
    }
    /**
     * Stop speaking with a quick fade-out instead of a hard cut (owner
     * 2026-10-01: every barge-in should glide like GPT realtime).
     *
     * EVERY scheduled node ramps to zero over `fadeMs` and stops just past the
     * ramp — no timers, so the pump loop observes it through the normal
     * `onended` path. The next turn chains from `now`, so it overlaps the
     * fading tails: a crossfade, not a hole. Queue is dropped at once (stale
     * audio must never play); only live nodes glide out.
     */
    fadeStop(fadeMs = 180) {
      this.playToken += 1;
      this.queue = [];
      this.nextTime = 0;
      this.pending = 0;
      const ctx = this.ctx;
      const targets = [...this.live];
      this.live.clear();
      this.current = null;
      if (!ctx || !targets.length) return;
      const t = ctx.currentTime;
      for (const h of targets) {
        try {
          h.gain.gain.cancelScheduledValues(t);
          h.gain.gain.setValueAtTime(h.gain.gain.value, t);
          h.gain.gain.linearRampToValueAtTime(0, t + fadeMs / 1e3);
          h.node.stop(t + fadeMs / 1e3 + 0.02);
        } catch {
          try {
            h.node.stop();
          } catch {
          }
        }
      }
      this.wake?.();
    }
    /**
     * Turn the narrow-band telephone voice on or off. Safe at any time: the bus
     * is rebuilt on the next chunk, and chunks already scheduled keep playing
     * through the graph they were connected to (no click — the fade paths are
     * untouched).
     */
    setTelephoneVoice(on) {
      const next = !!on;
      if (this.telephone === next) return;
      this.telephone = next;
      this.bus = null;
    }
    /** True when the narrow-band telephone chain is active. */
    telephoneVoice() {
      return this.telephone;
    }
    /**
     * The node every chunk's gain connects to: `ctx.destination` normally, or a
     * persistent telephone bus when enabled.
     *
     * A real phone call is band-limited to roughly 300-3400 Hz and heavily
     * compressed — that combination, not "noise", is what the ear reads as
     * "on the phone". So: high-pass to drop rumble, low-pass to drop the airy
     * top end, an aggressive compressor for the closeness, then a small makeup
     * gain because band-passing throws away energy and the voice would
     * otherwise sound quiet.
     *
     * Built defensively: a context that refuses any factory (or a stubbed test
     * double) skips that stage, and a chain with fewer than two real stages is
     * bypassed entirely rather than half-applied.
     */
    outputBus(ctx) {
      if (!this.telephone) return ctx.destination;
      if (this.bus && this.bus.ctx === ctx) return this.bus.input;
      const input = ctx.createGain();
      let tail = input;
      let stages = 0;
      const chain = (node) => {
        if (!node) return;
        try {
          tail.connect(node);
          tail = node;
          stages += 1;
        } catch {
        }
      };
      const make = (factory) => {
        if (typeof factory !== "function") return null;
        try {
          return factory.call(ctx);
        } catch {
          return null;
        }
      };
      const hp = make(ctx.createBiquadFilter?.bind(ctx));
      if (hp) {
        hp.type = "highpass";
        hp.frequency.value = 300;
        hp.Q.value = 0.7;
        chain(hp);
      }
      const lp = make(ctx.createBiquadFilter?.bind(ctx));
      if (lp) {
        lp.type = "lowpass";
        lp.frequency.value = 3400;
        lp.Q.value = 0.9;
        chain(lp);
      }
      const comp = make(ctx.createDynamicsCompressor?.bind(ctx));
      if (comp) {
        comp.threshold.value = -30;
        comp.knee.value = 10;
        comp.ratio.value = 12;
        comp.attack.value = 2e-3;
        comp.release.value = 0.12;
        chain(comp);
      }
      if (stages < 2) {
        try {
          input.disconnect();
        } catch {
        }
        return ctx.destination;
      }
      const makeup = ctx.createGain();
      makeup.gain.value = 1.6;
      chain(makeup);
      try {
        tail.connect(ctx.destination);
      } catch {
        return ctx.destination;
      }
      this.bus = { ctx, input };
      return input;
    }
    async pump() {
      if (this.pumping) return;
      this.pumping = true;
      try {
        const token = this.playToken;
        for (; ; ) {
          while (this.queue.length > 0) {
            if (this.playToken !== token) return;
            const buffer = this.queue.shift();
            const ctx = this.ensureContext();
            const node = ctx.createBufferSource();
            node.buffer = buffer;
            const gain = ctx.createGain();
            gain.gain.value = 1;
            node.connect(gain);
            gain.connect(this.outputBus(ctx));
            this.current = { node, gain, token };
            const handle = { node, gain };
            this.live.add(handle);
            const startAt = Math.max(ctx.currentTime, this.nextTime);
            node.start(startAt);
            this.nextTime = startAt + buffer.duration;
            this.pending += 1;
            node.onended = () => {
              this.live.delete(handle);
              if (this.pending > 0) this.pending -= 1;
              if (this.current?.node === node) this.current = null;
              if (this.playToken === token && this.pending === 0 && this.queue.length === 0) {
                this.onDrained?.();
              }
              this.wake?.();
            };
          }
          if (this.pending === 0) return;
          if (this.playToken !== token) return;
          await new Promise((resolve) => {
            this.wake = resolve;
          });
          this.wake = null;
        }
      } finally {
        this.pumping = false;
      }
    }
    ensureContext() {
      if (!this.ctx) {
        this.ctx = new AudioContext();
      }
      if (this.ctx.state === "suspended") {
        void this.ctx.resume();
      }
      return this.ctx;
    }
  };

  // apps/web/src/audio/PcmCapture.ts
  var BUFFER_SIZE = 4096;
  var PcmCapture = class {
    constructor() {
      this.ctx = null;
      this.source = null;
      this.processor = null;
      this.mute = null;
      this.stream = null;
      this.listeners = /* @__PURE__ */ new Set();
      this.running = false;
    }
    get isRunning() {
      return this.running;
    }
    onFrame(fn) {
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
    async start(stream) {
      if (this.running) return;
      const Ctor = window.AudioContext ?? window.webkitAudioContext;
      if (!Ctor) {
        throw new Error("This browser does not expose an AudioContext for microphone capture.");
      }
      this.ctx = new Ctor();
      if (this.ctx.state === "suspended") await this.ctx.resume();
      this.stream = stream;
      this.source = this.ctx.createMediaStreamSource(stream);
      this.processor = this.ctx.createScriptProcessor(BUFFER_SIZE, 1, 1);
      this.mute = this.ctx.createGain();
      this.mute.gain.value = 0;
      const inRate = this.ctx.sampleRate;
      this.processor.onaudioprocess = (event) => {
        if (!this.running) return;
        const input = event.inputBuffer.getChannelData(0);
        const frame = inRate === LIVE_INPUT_SAMPLE_RATE ? new Float32Array(input) : resampleFloat32(input, inRate, LIVE_INPUT_SAMPLE_RATE);
        for (const fn of this.listeners) {
          try {
            fn(frame);
          } catch {
          }
        }
      };
      this.source.connect(this.processor);
      this.processor.connect(this.mute);
      this.mute.connect(this.ctx.destination);
      this.running = true;
    }
    /** Detach and release the audio graph. Safe to call repeatedly. */
    stop() {
      this.running = false;
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
      }
      this.stream = null;
      void this.ctx?.close().catch(() => void 0);
      this.ctx = null;
    }
  };

  // apps/web/src/lib/identity.ts
  var OWNER_KEY = "naufalazhar652952";
  var OWNER_ALIASES = {
    Zigen: OWNER_KEY,
    naufalazhar65: OWNER_KEY,
    naufal: OWNER_KEY
  };
  function validateUserKey(user) {
    if (typeof user !== "string") return null;
    const trimmed = user.trim();
    if (!trimmed || trimmed.length > 60) return null;
    if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return null;
    if (trimmed === "." || trimmed === "..") return null;
    return trimmed;
  }
  function resolveBrowserUserKey(stored) {
    const key = validateUserKey(stored);
    if (key && key !== OWNER_KEY && !OWNER_ALIASES[key]) {
    }
    return OWNER_KEY;
  }

  // apps/web/src/lib/geminiLive.ts
  var LIVE_WS_BASE = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";
  function stripLiveFlower(text) {
    return text.replace(/🌸\uFE0F?/g, "").replace(/[ \t]{2,}/g, " ");
  }
  var SETTLE_GRACE_MS = 2500;
  var START_TIMEOUT_MS = 15e3;
  var FIRST_FRAME_WATCHDOG_MS = 2e4;
  function frameText(data) {
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
    if (ArrayBuffer.isView(data)) {
      const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      return new TextDecoder().decode(view);
    }
    return "";
  }
  var GeminiLiveSession = class {
    constructor(options = {}) {
      this.options = options;
      this.ws = null;
      this.listeners = /* @__PURE__ */ new Set();
      this.status = "idle";
      this.closing = false;
      this.model = "";
      /**
       * Mic mute for the session. While set, `sendAudioFrame` drops frames instead
       * of sending them: the socket stays open and the server hears silence, so a
       * mute never ends the conversation. This exists because the UI presents the
       * mic button as mute (MicOff icon while live) — and an earlier version of
       * this code actually STOPPED the session there, which is exactly the bug the
       * owner reported ("tekan mic malah mengakhiri obrolan").
       */
      this.audioMuted = false;
      /** Bounded grace after the setup frame, so `start()` always settles. */
      this.settleTimer = null;
      /** Hard ceiling on `start()`, so a dead socket can never hang the UI. */
      this.startTimer = null;
      /** Fires when a ready session has produced nothing at all. */
      this.stallTimer = null;
      /** Server frames seen this session; the watchdog only fires while this is 0. */
      this.frameCount = 0;
      /**
       * Per-turn transcript buffers. Transcription events carry INCREMENTAL chunks,
       * so the lib accumulates them here and always emits the whole turn so far —
       * overwriting per event is what made subtitles look "cut off mid-sentence".
       * Reset when a new turn starts after a `turnComplete`, never mid-turn.
       */
      this.inputBuf = "";
      this.outputBuf = "";
      this.turnClosed = false;
      /**
       * Wall-clock stamps of the SERVER's own voice-activity transitions.
       *
       * These are the ground truth for latency work. They split a turn into
       * "how long until the server decided I had stopped talking" (our hop: mic →
       * frames → server VAD) and "how long the model then took to answer"
       * (its hop). Without them a slow turn is unattributable, because the
       * client only ever sees audio arrive and cannot tell which half was slow.
       *
       * Read only by `discordVoice.ts`'s single per-turn latency line.
       */
      this.lastActivityStartAt = 0;
      this.lastActivityEndAt = 0;
    }
    get currentStatus() {
      return this.status;
    }
    on(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }
    /**
     * Mint a token, open the socket, and complete the `setup` handshake.
     *
     * Never throws: a failure is reported through the returned result AND an
     * `error` event, because the caller's job is to fall back to the Groq
     * pipeline, not to handle an exception.
     */
    async start() {
      if (this.ws) return { ok: true };
      this.closing = false;
      this.setStatus("connecting");
      let token;
      let model;
      let serverInstruction;
      let serverTools;
      let serverVoice;
      try {
        let userHeader = {};
        try {
          if (typeof window !== "undefined") {
            userHeader = { "x-mia-user": resolveBrowserUserKey(window.localStorage.getItem("voice-ai.user")) };
          }
        } catch {
        }
        const headers = { ...userHeader, ...this.options.userHeader || {} };
        const tokenUrl = this.options.tokenUrl || "/api/gemini-live/token";
        const doFetch = this.options.fetchImpl || fetch;
        const res = await doFetch(tokenUrl, { method: "POST", headers });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.token) {
          const message = json.error ?? `Gemini Live is unavailable (HTTP ${res.status}).`;
          this.emit({ type: "error", message });
          this.setStatus("error", message);
          return { ok: false, error: message };
        }
        token = json.token;
        model = json.model ?? "models/gemini-3.8-live";
        serverInstruction = json.systemInstruction ?? this.options.systemInstruction ?? "";
        serverTools = (Array.isArray(json.tools) ? json.tools : null) ?? this.options.tools ?? [];
        serverVoice = (typeof json.voice === "string" && json.voice.trim() ? json.voice.trim() : "") || this.options.voiceName || "";
      } catch (err) {
        const message = `Could not reach the Gemini Live token route: ${err instanceof Error ? err.message : String(err)}`;
        this.emit({ type: "error", message });
        this.setStatus("error", message);
        return { ok: false, error: message };
      }
      this.model = model;
      this.frameCount = 0;
      return new Promise((resolve) => {
        let settled = false;
        const clearTimers = () => {
          if (this.settleTimer) clearTimeout(this.settleTimer);
          if (this.startTimer) clearTimeout(this.startTimer);
          this.settleTimer = null;
          this.startTimer = null;
        };
        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimers();
          resolve(result);
        };
        this.startTimer = setTimeout(() => {
          const message = "The Gemini Live connection did not come up within 15 seconds (this is Google's side, not your microphone).";
          this.emit({ type: "error", message });
          this.setStatus("error", message);
          finish({ ok: false, error: message, via: "timeout" });
        }, START_TIMEOUT_MS);
        let socket;
        try {
          socket = new WebSocket(`${LIVE_WS_BASE}?access_token=${encodeURIComponent(token)}`);
        } catch (err) {
          const message = `Could not open the Gemini Live socket: ${err instanceof Error ? err.message : String(err)}`;
          this.emit({ type: "error", message });
          this.setStatus("error", message);
          finish({ ok: false, error: message });
          return;
        }
        this.ws = socket;
        socket.binaryType = "arraybuffer";
        socket.onopen = () => {
          this.send({
            setup: {
              model: this.model,
              // MEASURED against the live API 2026-09-29: `responseModalities` is
              // NOT a top-level `setup` field — the socket closes with
              // `Unknown name "responseModalities" at 'setup'`. Inside
              // `generationConfig` it is accepted. The docs show it at the top
              // level; the deployed API is narrower than the docs.
              generationConfig: {
                responseModalities: ["AUDIO"],
                // Prebuilt voice (docs: Live shares the TTS voice pool, e.g.
                // "Leda"). Inside generationConfig — the deployed API rejects
                // top-level fields it does not know (measured with
                // responseModalities), so this stays next to the field that is
                // proven accepted. Omitted when unset: a voiceless setup is the
                // old behavior, byte for byte.
                ...serverVoice ? {
                  speechConfig: {
                    voiceConfig: { prebuiltVoiceConfig: { voiceName: serverVoice } }
                  }
                } : {}
              },
              // `sessionResumption` is accepted as a top-level field (measured),
              // and lets the browser reconnect with the same token after a drop.
              sessionResumption: {},
              // Affective dialog NOT enabled: `enableAffectiveDialog: true` was
              // tried 2026-10-01 and every session died on mic-press with "The
              // Gemini Live session ended" — the Constrained endpoint
              // (ephemeral-token variant) rejects it even though the docs list
              // it for the full endpoint. Same class as the top-level
              // `responseModalities` rejection. Laughter/tone stays prompt-only.
              // Do NOT re-add without a live session-start proof.
              // Let the user finish thinking: the server ends their turn after
              // this much silence. 800 ms (owner 2026-10-06: voice latency) —
              // was 1200 ms, which alone added ~0.4 s to EVERY reply on top of
              // model TTFT + audio render. Below ~700 ms breathing pauses start
              // getting cut mid-sentence, so 800 is the floor, not a waypoint.
              // If the deployed API ever rejects this field, delete it — the
              // session must never fail to start over a tuning knob.
              realtimeInputConfig: {
                automaticActivityDetection: { silenceDurationMs: 800 }
              },
              ...serverInstruction ? { systemInstruction: { parts: [{ text: serverInstruction }] } } : {},
              // MEASURED against the live API 2026-09-30: `tools` is accepted as
              // a TOP-LEVEL `setup` field (unlike `responseModalities`, which the
              // socket rejects there). Each entry wraps Gemini function
              // declarations; a model call arrives as top-level `toolCall` and
              // MUST be answered, or the synchronous call hangs the turn.
              ...serverTools.length ? { tools: [{ functionDeclarations: serverTools }] } : {},
              ...this.options.enableInputTranscription !== false ? { inputAudioTranscription: {} } : {},
              ...this.options.enableOutputTranscription !== false ? { outputAudioTranscription: {} } : {}
            }
          });
          this.settleTimer = setTimeout(() => {
            if (settled) return;
            this.setStatus("ready");
            this.armStallWatchdog();
            finish({ ok: true, via: "grace" });
          }, SETTLE_GRACE_MS);
        };
        socket.onmessage = (event) => {
          const raw = frameText(event.data);
          if (raw) this.handleMessage(raw, finish);
        };
        socket.onerror = () => {
          if (this.closing) return;
          const message = "The Gemini Live connection failed.";
          this.clearWatchdogs();
          this.emit({ type: "error", message });
          this.setStatus("error", message);
          finish({ ok: false, error: message });
        };
        socket.onclose = () => {
          this.ws = null;
          this.clearWatchdogs();
          if (this.closing) {
            this.setStatus("closed");
            return;
          }
          this.setStatus("closed", "The Gemini Live session ended.");
        };
      });
    }
    /** Send one 16 kHz PCM frame. Silently ignored when not connected. */
    sendAudioFrame(pcm, base64) {
      if (this.audioMuted) return;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.send({
        realtimeInput: {
          audio: { data: base64, mimeType: "audio/pcm;rate=16000" }
        }
      });
      void pcm;
    }
    /** Inject text as if the user had said it. */
    sendText(text) {
      if (!text.trim()) return;
      this.send({ realtimeInput: { text } });
    }
    /**
     * Answer the model's tool calls. One entry per call, in any order — but
     * EVERY call must be answered, even when execution failed: Live tool calls
     * are synchronous and the model stays silent until each one has a result.
     * Results SHOULD already be strings; anything else is JSON-encoded.
     */
    sendToolResponse(results) {
      if (!results.length) return;
      this.send({
        toolResponse: {
          functionResponses: results.map((r) => ({
            id: r.id,
            name: r.name,
            response: { result: r.result }
          }))
        }
      });
    }
    /**
     * Stop Gemini mid-sentence — locally.
     *
     * Deliberately sends NOTHING over the socket: `{interrupt: true}` is not a
     * valid `BidiGenerateContentClientMessage` field, and the deployed API
     * closes the session on unknown top-level fields (owner 2026-10-01: every
     * local barge-in ended with "The Gemini Live session ended"). Interruption
     * is achieved by silencing locally (the caller fades/drops) while the mic
     * keeps streaming — the server yields to sustained user speech on its own
     * VAD, or the duck-hold covers it. The emits below keep UI/orb/memory
     * consistent, and clear the local player like before.
     */
    interrupt() {
      this.emit({ type: "interrupted" });
      this.emit({ type: "speaking", speaking: false });
    }
    /**
     * Mute or unmute the mic WITHOUT touching the session. Muting drops
     * outgoing frames (the server hears silence); the socket, the token and
     * the conversation all survive it.
     */
    setAudioMuted(muted) {
      this.audioMuted = muted;
    }
    /** Whether outgoing audio is currently dropped. */
    get isAudioMuted() {
      return this.audioMuted;
    }
    /** Close the socket. Safe to call repeatedly. */
    stop() {
      this.closing = true;
      this.clearWatchdogs();
      try {
        this.ws?.close();
      } catch {
      }
      this.ws = null;
      this.setStatus("closed");
    }
    /** Drop every pending timer so a stopped session can never fire a notice. */
    clearWatchdogs() {
      if (this.settleTimer) clearTimeout(this.settleTimer);
      if (this.startTimer) clearTimeout(this.startTimer);
      if (this.stallTimer) clearTimeout(this.stallTimer);
      this.settleTimer = null;
      this.startTimer = null;
      this.stallTimer = null;
    }
    send(payload) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.send(JSON.stringify(payload));
    }
    /** Parse one server frame and fan it out. Never throws. */
    handleMessage(raw, finish) {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      this.noteFrame();
      if (msg.setupComplete) {
        if (this.settleTimer) clearTimeout(this.settleTimer);
        this.settleTimer = null;
        this.setStatus("ready");
        this.armStallWatchdog();
        finish({ ok: true, via: "setup-complete" });
        return;
      }
      if (msg.error) {
        const detail = msg.error?.message ?? "Gemini Live reported an error.";
        this.emit({ type: "error", message: detail });
        this.setStatus("error", detail);
        return;
      }
      if (msg.interrupted) {
        this.emit({ type: "interrupted" });
        this.emit({ type: "speaking", speaking: false });
        return;
      }
      const toolCall = msg.toolCall;
      if (Array.isArray(toolCall?.functionCalls)) {
        const calls = [];
        for (const [index, fc] of toolCall.functionCalls.entries()) {
          if (!fc || typeof fc.name !== "string" || !fc.name) continue;
          let args = {};
          if (fc.args && typeof fc.args === "object" && !Array.isArray(fc.args)) {
            args = fc.args;
          }
          calls.push({
            id: typeof fc.id === "string" && fc.id ? fc.id : `live-${index}`,
            name: fc.name,
            args
          });
        }
        if (calls.length) this.emit({ type: "tool_call", calls });
        return;
      }
      const serverContent = msg.serverContent;
      const activity = msg.voiceActivity;
      if (activity?.type === "ACTIVITY_START") this.lastActivityStartAt = Date.now();
      else if (activity?.type === "ACTIVITY_END") this.lastActivityEndAt = Date.now();
      if (globalThis.__miaLiveTrace) {
        console.log(
          `[gemini-live] frame keys=${Object.keys(msg).join(",")} serverContent=${JSON.stringify({
            hasModelTurn: !!serverContent?.modelTurn,
            parts: serverContent?.modelTurn?.parts?.length ?? 0,
            in: serverContent?.inputTranscription?.text?.slice(0, 60),
            out: serverContent?.outputTranscription?.text?.slice(0, 60),
            turnComplete: serverContent?.turnComplete
          })} voiceActivity=${JSON.stringify(msg.voiceActivity)} speechStart=${msg.speechStart ?? "-"}`
        );
      }
      if (!serverContent) return;
      if (typeof serverContent.inputTranscription?.text === "string") {
        this.emit({
          type: "input_transcript",
          text: this.appendTranscript("input", serverContent.inputTranscription.text),
          final: false
        });
      }
      if (typeof serverContent.outputTranscription?.text === "string") {
        this.emit({
          type: "output_transcript",
          text: this.appendTranscript("output", serverContent.outputTranscription.text),
          final: false
        });
      }
      let sawAudio = false;
      for (const part of serverContent.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) {
          sawAudio = true;
          this.emit({ type: "audio", pcm: this.decode(part.inlineData.data) });
        } else if (part.text) {
          this.emit({ type: "text", text: part.text });
        }
      }
      if (sawAudio) this.emit({ type: "speaking", speaking: true });
      if (serverContent.turnComplete) {
        this.turnClosed = true;
        this.emit({ type: "speaking", speaking: false });
      }
    }
    /**
     * Append one incremental transcription chunk to the current turn's buffer
     * and return the whole turn so far. A new turn after a `turnComplete`
     * starts empty; chunks join with a space only when neither side supplies
     * one, so words never glue together and never double-space.
     */
    appendTranscript(side, chunk) {
      if (this.turnClosed) {
        this.inputBuf = "";
        this.outputBuf = "";
        this.turnClosed = false;
      }
      const clean = stripLiveFlower(chunk);
      if (!clean.trim()) return side === "input" ? this.inputBuf : this.outputBuf;
      const buf = side === "input" ? this.inputBuf : this.outputBuf;
      const next = !buf ? clean : /[\s(>"'\-–—]$/.test(buf) || /^[\s.,!?;:)"'\-–—]/.test(clean) ? buf + clean : `${buf} ${clean}`;
      if (side === "input") this.inputBuf = next;
      else this.outputBuf = next;
      return next;
    }
    /** base64 -> bytes, tolerant of a malformed frame. */
    decode(data) {
      try {
        const binary = atob(data);
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
        return out;
      } catch {
        return new Uint8Array(0);
      }
    }
    setStatus(status, detail) {
      this.status = status;
      this.emit({ type: "status", status, detail });
    }
    /**
     * Count a decoded server frame and disarm the "no frames yet" notice.
     *
     * The handshake counts too: `setupComplete` is proof the server is talking, so
     * counting it is what stops the notice from firing on a healthy session that
     * simply has not been spoken to yet.
     */
    noteFrame() {
      this.frameCount += 1;
      if (this.stallTimer) {
        clearTimeout(this.stallTimer);
        this.stallTimer = null;
      }
    }
    /**
     * Announce a session that received no frame at all, without killing it.
     *
     * Emitted as its own event rather than an `error` on purpose: the socket is
     * still open, so a red failure the user has to dismiss would be a lie about
     * the state. Armed ONLY while `frameCount === 0` — see {@link FIRST_FRAME_WATCHDOG_MS}
     * for why a longer silence is not evidence of anything.
     */
    armStallWatchdog() {
      if (this.stallTimer) clearTimeout(this.stallTimer);
      this.stallTimer = null;
      if (this.frameCount > 0 || this.closing) return;
      this.stallTimer = setTimeout(() => {
        this.stallTimer = null;
        if (this.frameCount > 0 || this.closing) return;
        this.emit({
          type: "stalled",
          message: "Sudah tersambung, tapi belum ada balasan apa pun dari Google. Kalau kamu memang belum bicara, itu normal \u2014 kalau sudah bicara dan tetap sunyi, tutup lalu buka Live lagi, atau pakai mode Groq."
        });
      }, FIRST_FRAME_WATCHDOG_MS);
    }
    emit(event) {
      for (const fn of this.listeners) {
        try {
          fn(event);
        } catch {
        }
      }
    }
  };
  function parseLiveVerification(json) {
    if (typeof json !== "object" || json === null) return void 0;
    const v = json.verification;
    if (typeof v !== "object" || v === null) return void 0;
    const r = v;
    if (r.verdict !== "clean" && r.verdict !== "flagged") return void 0;
    return {
      verdict: r.verdict,
      note: typeof r.note === "string" ? r.note : "",
      executed: Array.isArray(r.executed) ? r.executed.filter((e) => typeof e === "string") : []
    };
  }
  async function saveLiveTurnToMemory(heard, said, userHeader, fetchImpl = fetch, opts = {}) {
    const done = (saved, v) => {
      try {
        opts.onVerification?.(v);
      } catch {
      }
      return saved;
    };
    if (!heard.trim() && !said.trim()) return done(false, void 0);
    try {
      const body = {
        heard: heard.slice(0, 2e3),
        said: said.slice(0, 2e3)
      };
      if (typeof opts.sinceMs === "number" && Number.isFinite(opts.sinceMs)) {
        body.sinceMs = opts.sinceMs;
      }
      const res = await fetchImpl("/api/gemini-live/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...userHeader },
        body: JSON.stringify(body)
      });
      if (!res.ok) return done(false, void 0);
      const json = await res.json().catch(() => ({}));
      return done(json.saved === true, parseLiveVerification(json));
    } catch {
      return done(false, void 0);
    }
  }

  // apps/web/src/lib/liveConfirm.ts
  var LIVE_WRITE_TOOLS = [
    "remind_me",
    "edit_reminder",
    "cancel_reminder",
    "save_note",
    "add_task",
    "complete_task",
    "calendar_add",
    "calendar_mac_add"
  ];
  var PENDING_TTL_MS = 3 * 6e4;
  var AFFIRM_RE = /\b(ya|iyaa?|boleh|oke|ok|setuju|lanjut(kan)?|baik|siap|tentu)\b/i;
  var REFUSE_RE = /\b(jangan|tidak|nggak|enggak|gak|batal|nanti|tunda|ganti|berhenti|stop)\b/i;
  function isAffirmation(heard) {
    if (!heard || !heard.trim()) return false;
    if (REFUSE_RE.test(heard)) return false;
    return AFFIRM_RE.test(heard);
  }
  function emptyConfirmState() {
    return { pending: [] };
  }
  function pendingArgsKey(args) {
    const { confirmed: _drop, ...rest } = args;
    void _drop;
    const keys = Object.keys(rest).sort();
    return keys.map((k) => `${k}=${JSON.stringify(rest[k])}`).join("&");
  }
  function prune(state, now) {
    return { pending: state.pending.filter((p) => now - p.askedAt < PENDING_TTL_MS) };
  }
  function markUserSpoke(state, now = Date.now()) {
    const pruned = prune(state, now);
    return { pending: pruned.pending.map((p) => ({ ...p, userSpokeSinceAsk: true })) };
  }
  function decideLiveToolCalls(state, calls, heard = "", now = Date.now()) {
    const pruned = prune(state, now);
    const pending = [...pruned.pending];
    const execute = [];
    const ask = [];
    for (const call of calls) {
      if (!LIVE_WRITE_TOOLS.includes(call.name)) {
        execute.push(call);
        continue;
      }
      const key = pendingArgsKey(call.args ?? {});
      const idx = pending.findIndex((p) => p.name === call.name && p.argsKey === key);
      const existing = idx >= 0 ? pending[idx] : void 0;
      const confirmedFlag = (call.args ?? {}).confirmed === true;
      const affirmed = existing?.userSpokeSinceAsk && isAffirmation(heard);
      if (existing && existing.userSpokeSinceAsk && (confirmedFlag || affirmed)) {
        pending.splice(idx, 1);
        execute.push(call);
      } else {
        const entry = {
          name: call.name,
          argsKey: key,
          args: call.args ?? {},
          askedAt: now,
          userSpokeSinceAsk: existing?.userSpokeSinceAsk ?? false
        };
        if (idx >= 0) pending[idx] = entry;
        else pending.push(entry);
        ask.push(call);
      }
    }
    return { execute, ask, state: { pending } };
  }
  function describeWriteCall(call) {
    const args = call.args ?? {};
    if (call.name === "remind_me") {
      const text = typeof args.text === "string" ? args.text.slice(0, 120) : "pengingat";
      const when = typeof args.when === "string" ? args.when : "jadwal yang kamu sebut";
      return `mengingetin '${text}' ${when}`;
    }
    if (call.name === "save_note") {
      const content = typeof args.content === "string" ? args.content.slice(0, 120) : "catatan";
      return `mencatat '${content}'`;
    }
    if (call.name === "add_task") {
      const text = typeof args.text === "string" ? args.text.slice(0, 120) : "tugas";
      return `menambahkan tugas '${text}'`;
    }
    if (call.name === "complete_task") {
      const what = typeof args.match === "string" ? `'${args.match.slice(0, 120)}'` : typeof args.number === "string" ? `nomor ${args.number}` : "tugas";
      return `menandai selesai ${what}`;
    }
    if (call.name === "calendar_add") {
      const title = typeof args.title === "string" ? args.title.slice(0, 120) : "acara";
      return `menjadwalkan '${title}'`;
    }
    if (call.name === "calendar_mac_add") {
      const title = typeof args.title === "string" ? args.title.slice(0, 120) : "acara";
      return `menjadwalkan '${title}' di aplikasi Kalender Mac`;
    }
    return `menjalankan ${call.name}`;
  }
  function askFirstInstruction(call) {
    const what = describeWriteCall(call);
    return `PERLU KONFIRMASI LISAN: tanyakan dulu ke user dengan suara, persis maksudnya: "Mau aku ${what}, ya?" \u2014 JANGAN klaim sudah dikerjakan. Kalau user menjawab ya/iya/boleh/oke: PANGGIL LAGI tool ini dengan confirmed:true \u2014 jangan menjawab dengan kata-kata. Kalau user menolak atau ganti topik, jangan panggil lagi. ATURAN KERAS: katakan "sudah dikerjakan/sudah ditambahkan" HANYA SETELAH tool mengembalikan hasil sukses \u2014 tidak pernah sebelumnya, tidak pernah sebagai pengganti panggilan.`;
  }

  // apps/web/src/lib/liveToolNote.ts
  var LIVE_TOOL_VERBS = {
    gmail_list: "mengecek email",
    gmail_read: "membaca email",
    gmail_search: "mencari email",
    gmaps_route: "mengecek rute",
    waze_route: "mengecek rute",
    google_news: "mencari berita",
    web_search: "mencari",
    weather: "mengecek cuaca",
    hotel_search: "mencari hotel",
    places_search: "mencari tempat",
    cinema_showtimes: "mencari jadwal film",
    spotify_play: "memutar lagu",
    spotify_search: "mencari lagu",
    spotify_status: "mengecek lagu",
    calendar_add: "mencatat jadwal",
    calendar_mac_add: "mencatat jadwal",
    mac_open: "membuka situs",
    add_task: "mencatat tugas",
    complete_task: "menyelesaikan tugas",
    remind_me: "memasang pengingat",
    edit_reminder: "mengubah pengingat",
    cancel_reminder: "menghapus pengingat",
    save_note: "mencatat",
    search_memory: "mengingat-ingat",
    memory_get: "membaca ingatan"
  };
  function liveToolNote(names) {
    const verbs = names.map((n) => LIVE_TOOL_VERBS[n] ?? n);
    return `\u23F3 ${verbs.join(" + ")}...`;
  }

  // apps/web/src/lib/liveClient.ts
  var BARGE_RMS = 0.015;
  var BARGE_HOLD_FRAMES = 4;
  var BARGE_ARM_MS = 800;
  var RAW_CAP_BYTES = 24e3 * 2 * 60;
  function browserUserHeader() {
    try {
      if (typeof window === "undefined") return {};
      return { "x-mia-user": resolveBrowserUserKey(window.localStorage.getItem("voice-ai.user")) };
    } catch {
      return {};
    }
  }
  var LiveClient = class {
    constructor(options = {}) {
      this.state = {
        status: "idle",
        speaking: false,
        muted: false,
        heard: "",
        said: "",
        verifyNote: "",
        error: "",
        stalled: "",
        toolNote: "",
        telephoneVoice: true
      };
      this.listeners = /* @__PURE__ */ new Set();
      // Long-lived objects, not render state: the WebSocket, the audio graph and
      // the player must survive re-renders untouched.
      this.session = null;
      /** When the current session started (tells stale sessions apart). */
      this.startedAt = 0;
      this.capture = null;
      this.player = null;
      /**
       * Playout buffer: Google's PCM frames are small and jittered, so each one
       * played directly is an audible hole whenever a frame is late. The chunker
       * emits fixed ~0.5 s pieces; reset on every stop/interrupt so stale audio
       * can never leak into the next turn.
       */
      this.chunker = createPcmChunker();
      /**
       * The turn being spoken right now, mirrored out of state so the write-back
       * always sees the latest text even from stale closures. Reset the moment a
       * save is initiated: the POST is async, and a second flush before it
       * resolves must find nothing, never save twice.
       */
      this.turn = { heard: "", said: "", startedAt: 0 };
      /**
       * Pending voice write actions awaiting spoken confirmation. A first-seen
       * write is held here, the model asks aloud, and only a re-call with
       * confirmed:true after the user spoke executes.
       */
      this.pending = emptyConfirmState();
      this.speaking = false;
      this.muted = false;
      this.speakingSince = 0;
      this.hotStreak = 0;
      /** Last mic frame energy (for the barge snapshot). */
      this.bargeRms = 0;
      /** Peak mic energy since Gemini started speaking. */
      this.bargePeak = 0;
      /** Recent mic RMS for the laughter detector (ring, ~3.4 s at 85 ms/frame). */
      this.laughRms = [];
      /** A "[tertawa]" tag was already sent this turn (max one per turn). */
      this.laughSent = false;
      /**
       * Duck window: while this is in the future, incoming model audio is DROPPED
       * instead of buffered. Refreshed while the user keeps talking (cap 5 s), so
       * sustained speech holds the floor and a cough costs at most one window.
       */
      this.duckUntil = 0;
      this.duckStart = 0;
      // Raw incoming PCM this session, capped: the noise diagnostic. Never read
      // for playback, only for export.
      this.raw = [];
      this.rawBytes = 0;
      /**
       * Startup prebuffer for the voice: chunks are held here until
       * LIVE_PREBUFFER_BYTES are ready, then released in order and the rest of the
       * turn streams straight through.
       */
      this.prime = [];
      this.primed = false;
      this.options = options;
      this.state.telephoneVoice = this.readTelephonePref();
    }
    /* ── state plumbing ──────────────────────────────────────────────── */
    getState() {
      return this.state;
    }
    /** Subscribe to state changes. The listener fires immediately with the
     *  current state, so a late subscriber is never stale. */
    subscribe(fn) {
      this.listeners.add(fn);
      fn(this.state);
      return () => {
        this.listeners.delete(fn);
      };
    }
    patch(next) {
      this.state = { ...this.state, ...next };
      for (const fn of this.listeners) {
        try {
          fn(this.state);
        } catch {
        }
      }
    }
    get fetchImpl() {
      return this.options.fetchImpl ?? fetch;
    }
    get userHeader() {
      return { ...browserUserHeader(), ...this.options.userHeader ?? {} };
    }
    /* ── memory write-back ───────────────────────────────────────────── */
    /**
     * Write the current turn into today's daily memory (fire-and-forget) and
     * clear it first, so overlapping end-of-turn signals can never double-save.
     * Safe to call from any turn boundary: stop, interrupt, or turn end.
     */
    flushTurnMemory() {
      const turn = this.turn;
      this.turn = { heard: "", said: "", startedAt: 0 };
      this.patch({ verifyNote: "" });
      if (!turn.heard.trim() && !turn.said.trim()) return;
      void saveLiveTurnToMemory(turn.heard, turn.said, this.userHeader, this.fetchImpl, {
        sinceMs: turn.startedAt > 0 ? turn.startedAt : void 0,
        onVerification: (v) => {
          if (v && v.verdict === "flagged" && v.note) this.patch({ verifyNote: v.note });
        }
      });
    }
    /* ── player helpers ──────────────────────────────────────────────── */
    /**
     * Persisted telephone-voice preference. Missing key = ON; anything but
     * "0"/"false" keeps it on. Guarded because storage can throw (private
     * mode, blocked cookies).
     */
    readTelephonePref() {
      try {
        const raw = window.localStorage.getItem("mia.live.telephone");
        return !(raw === "0" || raw === "false");
      } catch {
        return true;
      }
    }
    ensurePlayer() {
      if (!this.player) {
        const p = this.options.createPlayer ? this.options.createPlayer() : new AudioPlayer();
        p.setTelephoneVoice(this.readTelephonePref());
        this.player = p;
      }
      return this.player;
    }
    /** Feed one playout piece straight into the gapless schedule. */
    playPiece(piece) {
      if (piece.length) this.ensurePlayer().enqueuePcm(piece, LIVE_OUTPUT_SAMPLE_RATE);
    }
    /** Release everything the prebuffer is holding (turn end), then re-arm it. */
    releasePrime() {
      for (const p of this.prime) this.playPiece(p);
      this.prime = [];
      this.primed = false;
    }
    /** Drop the prebuffer without playing it (interrupt/stop). */
    dropPrime() {
      this.prime = [];
      this.primed = false;
    }
    /* ── lifecycle ───────────────────────────────────────────────────── */
    stop() {
      this.flushTurnMemory();
      this.capture?.stop();
      this.capture = null;
      this.session?.stop();
      this.session = null;
      this.player?.stop();
      this.chunker.reset();
      this.dropPrime();
      this.duckUntil = 0;
      this.duckStart = 0;
      this.pending = emptyConfirmState();
      this.patch({ speaking: false, muted: false, toolNote: "", status: "idle" });
    }
    async start(stream) {
      if (!stream) {
        const message = "The microphone is not available yet.";
        this.patch({ error: message });
        return { ok: false, error: message };
      }
      this.raw = [];
      this.rawBytes = 0;
      this.stop();
      this.patch({ error: "", stalled: "", heard: "", said: "" });
      const sessionOptions = {
        ...this.options.tokenUrl ? { tokenUrl: this.options.tokenUrl } : {},
        ...this.options.userHeader ? { userHeader: this.options.userHeader } : {},
        fetchImpl: this.fetchImpl
      };
      const session = this.options.createSession ? this.options.createSession(sessionOptions) : new GeminiLiveSession(sessionOptions);
      this.session = session;
      session.on((event) => this.handleEvent(event, session));
      const result = await session.start();
      if (!result.ok) {
        this.capture = null;
        this.session = null;
        this.patch({ status: "error" });
        return result;
      }
      this.startedAt = Date.now();
      const capture = this.options.createCapture ? this.options.createCapture() : new PcmCapture();
      this.capture = capture;
      capture.onFrame((frame) => this.handleFrame(frame, session));
      try {
        await capture.start(stream);
      } catch (err) {
        session.stop();
        this.session = null;
        const message = `Could not start microphone capture: ${err instanceof Error ? err.message : String(err)}`;
        this.patch({ error: message, status: "error" });
        return { ok: false, error: message };
      }
      return { ok: true };
    }
    /** Stop Gemini mid-sentence (barge-in). */
    interrupt() {
      try {
        console.debug("[mia-live] interrupt() called");
      } catch {
      }
      this.session?.interrupt();
      const p = this.player;
      if (p && typeof p.fadeStop === "function") p.fadeStop(300);
      else p?.stop();
      this.patch({ speaking: false });
    }
    /**
     * Mute/unmute the mic. Only the outgoing frames stop — the session, the
     * token and the conversation are untouched, so muting can never end the
     * call. No-op without an open session.
     */
    toggleMute() {
      const session = this.session;
      if (!session || this.state.status !== "ready") return;
      const next = !session.isAudioMuted;
      session.setAudioMuted(next);
      this.muted = next;
      this.patch({ muted: next });
    }
    /** Send text as if spoken. */
    sendText(text) {
      this.session?.sendText(text);
    }
    /**
     * Telephone voice (narrow band + heavy compression). Mirrors the player's
     * flag so a UI toggle can show the current state, and persists the choice so
     * it survives a reload.
     */
    setTelephoneVoice(on) {
      const next = !!on;
      this.player?.setTelephoneVoice(next);
      try {
        window.localStorage.setItem("mia.live.telephone", next ? "1" : "0");
      } catch {
      }
      this.patch({ telephoneVoice: next });
    }
    /* ── session events ──────────────────────────────────────────────── */
    handleEvent(event, session) {
      switch (event.type) {
        case "status":
          this.patch({
            status: event.status,
            ...event.detail ? { error: event.detail } : {}
          });
          break;
        case "error":
          this.patch({ error: event.message });
          break;
        case "stalled":
          this.patch({ stalled: event.message });
          break;
        case "speaking":
          this.patch({ speaking: event.speaking });
          if (event.speaking && !this.speaking) {
            this.speakingSince = Date.now();
            this.bargePeak = 0;
            this.hotStreak = 0;
            this.laughSent = false;
          }
          this.speaking = event.speaking;
          if (!event.speaking) this.hotStreak = 0;
          else this.patch({ toolNote: "" });
          this.patch({ stalled: "" });
          if (!event.speaking) {
            this.releasePrime();
            const tail = this.chunker.flush();
            if (tail && tail.length) this.playPiece(applyFadeOut(tail, LIVE_OUTPUT_SAMPLE_RATE));
            this.flushTurnMemory();
          }
          break;
        case "input_transcript":
          if (this.turn.startedAt === 0) this.turn.startedAt = Date.now();
          this.turn.heard = event.text;
          this.patch({ heard: event.text, stalled: "" });
          this.pending = markUserSpoke(this.pending);
          break;
        case "output_transcript":
          if (this.turn.startedAt === 0) this.turn.startedAt = Date.now();
          this.turn.said = event.text;
          this.patch({ said: event.text, stalled: "" });
          break;
        case "audio": {
          if (!event.pcm.length) return;
          this.patch({ stalled: "" });
          if (this.rawBytes < RAW_CAP_BYTES) {
            this.raw.push(event.pcm);
            this.rawBytes += event.pcm.length;
          }
          if (Date.now() < this.duckUntil) return;
          for (const piece of this.chunker.push(event.pcm)) {
            if (this.primed) {
              this.playPiece(piece);
              continue;
            }
            this.prime.push(piece);
            const held = this.prime.reduce((n, p) => n + p.length, 0);
            if (held >= LIVE_PREBUFFER_BYTES) {
              this.primed = true;
              for (const p of this.prime) this.playPiece(p);
              this.prime = [];
            }
          }
          break;
        }
        case "interrupted": {
          console.debug("[mia-live] interrupted frame from Google");
          const pl = this.player;
          if (pl && typeof pl.fadeStop === "function") pl.fadeStop(300);
          else pl?.stop();
          this.chunker.reset();
          this.dropPrime();
          this.duckUntil = 0;
          this.duckStart = 0;
          this.flushTurnMemory();
          this.patch({ speaking: false });
          break;
        }
        case "tool_call": {
          this.patch({ toolNote: liveToolNote(event.calls.map((c) => c.name)) });
          try {
            void this.fetchImpl("/api/gemini-live/tool-ping", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ names: event.calls.map((c) => c.name) })
            }).catch(() => void 0);
          } catch {
          }
          const decision = decideLiveToolCalls(this.pending, event.calls, this.turn.heard);
          this.pending = decision.state;
          if (decision.ask.length) {
            session.sendToolResponse(
              decision.ask.map((c) => ({ id: c.id, name: c.name, result: askFirstInstruction(c) }))
            );
          }
          if (decision.execute.length) void this.runToolCalls(session, decision.execute);
          break;
        }
        case "text":
          break;
      }
    }
    /* ── mic frames ──────────────────────────────────────────────────── */
    handleFrame(frame, session) {
      const pcm = floatTo16BitPcm(frame);
      session.sendAudioFrame(pcm, bytesToBase64(pcm));
      const rms = rmsFloat32(frame);
      this.bargeRms = rms;
      if (rms > this.bargePeak) this.bargePeak = rms;
      this.laughRms.push(rms);
      if (this.laughRms.length > 40) this.laughRms.shift();
      if (!this.muted && this.session && !this.laughSent && detectLaughter(this.laughRms)) {
        this.laughSent = true;
        try {
          this.session.sendText("[tertawa]");
        } catch {
        }
      }
      if (!this.speaking || this.muted || !this.session) {
        this.hotStreak = 0;
        return;
      }
      if (Date.now() - this.speakingSince < BARGE_ARM_MS || rms < BARGE_RMS) {
        this.hotStreak = 0;
        return;
      }
      if (rms >= BARGE_RMS) this.hotStreak = Math.min(this.hotStreak + 1, BARGE_HOLD_FRAMES);
      else this.hotStreak = Math.max(this.hotStreak - 1, 0);
      if (this.hotStreak < BARGE_HOLD_FRAMES) return;
      this.hotStreak = 0;
      const nowHold = Date.now();
      const fresh = nowHold >= this.duckUntil;
      if (fresh) {
        this.duckStart = nowHold;
        try {
          console.debug("[mia-live] local barge-in: holding floor");
        } catch {
        }
      }
      this.duckUntil = Math.min(nowHold + 2500, this.duckStart + 5e3);
      try {
        this.session.interrupt();
      } catch {
      }
      try {
        const pl = this.player;
        if (pl && typeof pl.fadeStop === "function") pl.fadeStop(300);
        else pl?.stop();
      } catch {
      }
      this.chunker.reset();
      this.flushTurnMemory();
      this.speaking = false;
      this.patch({ speaking: false });
    }
    /* ── tool execution ──────────────────────────────────────────────── */
    /**
     * Execute Live tool calls server-side and answer the model — ALWAYS, even on
     * failure. Live calls are synchronous (the model is silent until every call
     * has a result), so a missing answer hangs the conversation, while an
     * `Error: ...` answer lets the model speak honestly about what happened.
     */
    async runToolCalls(session, calls) {
      const answer = (results2) => {
        try {
          session.sendToolResponse(results2);
        } catch {
        }
      };
      let results;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3e4);
        try {
          const res = await this.fetchImpl("/api/gemini-live/tool", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...this.userHeader },
            body: JSON.stringify({
              calls: calls.map((c) => ({ id: c.id, name: c.name, args: c.args }))
            }),
            signal: controller.signal
          });
          const json = await res.json().catch(() => ({}));
          if (!res.ok || !Array.isArray(json.results)) {
            throw new Error(typeof json.error === "string" ? json.error : `tool route HTTP ${res.status}`);
          }
          results = calls.map((c, index) => {
            const r = json.results?.[index];
            return {
              id: c.id,
              name: c.name,
              result: typeof r?.result === "string" ? r.result : "Error: no result from tool route."
            };
          });
        } finally {
          clearTimeout(timeout);
        }
      } catch (err) {
        const message = err instanceof Error && err.name === "AbortError" ? "Error: the tool took too long (30s) and was stopped." : `Error: could not reach the tool route (${err instanceof Error ? err.message : String(err)}).`;
        results = calls.map((c) => ({ id: c.id, name: c.name, result: message }));
      }
      answer(results);
    }
    /* ── diagnostics ─────────────────────────────────────────────────── */
    /**
     * Noise diagnostic console: no UI, no bundle cost beyond a few lines — open
     * DevTools and run:
     *   __miaLive.stats()        → frames received vs pieces played
     *   __miaLive.downloadRaw()  → saves exactly what Google sent as .wav
     *   __miaLive.playSine()     → 1 s of 440 Hz through the SAME player path
     *
     * Returns a cleanup that removes it again.
     */
    installDiagnostics(target) {
      const w = target ?? (typeof window !== "undefined" ? window : void 0);
      if (!w) return () => void 0;
      w.__miaLive = {
        // Bump when the Live client changes: lets support verify the tab runs
        // fresh code. Print __miaLive.version in the console.
        version: "2026-10-21-dashboard",
        // Wall-clock ISO of the live session start. Compare against deploy times
        // to prove a test ran on fresh instructions, not a stale session.
        startedAt: () => this.startedAt ? new Date(this.startedAt).toISOString() : "(no session yet)",
        stats: () => ({ rawFrames: this.raw.length, rawBytes: this.rawBytes }),
        // Barge snapshot: print WHILE talking over Gemini.
        barge: () => ({
          speaking: this.speaking,
          muted: this.muted,
          streak: this.hotStreak,
          lastRms: Number(this.bargeRms.toFixed(4)),
          peakRms: Number(this.bargePeak.toFixed(4)),
          duckUntilInMs: Math.max(0, this.duckUntil - Date.now())
        }),
        downloadRaw: () => {
          const total = this.rawBytes;
          if (!total) return "no audio received yet";
          const flat = new Uint8Array(total);
          let at = 0;
          for (const part of this.raw) {
            flat.set(part, at);
            at += part.length;
          }
          const wav = pcmToWav(flat, LIVE_OUTPUT_SAMPLE_RATE);
          const url = URL.createObjectURL(new Blob([wav.buffer], { type: "audio/wav" }));
          const a = document.createElement("a");
          a.href = url;
          a.download = "mia-live-raw.wav";
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1e4);
          return `saved ${total} bytes`;
        },
        playSine: () => {
          const frames = LIVE_OUTPUT_SAMPLE_RATE;
          const pcm = new Uint8Array(frames * 2);
          const view = new DataView(pcm.buffer);
          for (let i = 0; i < frames; i += 1) {
            view.setInt16(i * 2, Math.round(Math.sin(i / frames * Math.PI * 2 * 440) * 32767), true);
          }
          this.ensurePlayer().enqueuePcm(pcm, LIVE_OUTPUT_SAMPLE_RATE);
          return "playing 440 Hz for 1 s";
        }
      };
      return () => {
        if (w.__miaLive) delete w.__miaLive;
      };
    }
  };
  return __toCommonJS(liveBrowserEntry_exports);
})();
