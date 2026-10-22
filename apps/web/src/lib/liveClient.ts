/**
 * `liveClient` — the framework-agnostic Gemini Live orchestrator.
 *
 * It owns exactly the three moving parts of a Live session:
 *   1. `GeminiLiveSession` — the WebSocket (browser <-> Google, direct)
 *   2. `PcmCapture`        — raw 16 kHz frames off the mic stream
 *   3. `AudioPlayer`       — playback, reused so barge-in keeps working
 *
 * …plus the loop around them: the barge-in detector, the playout prebuffer,
 * the duck window, the spoken tool confirmation, and the daily-memory
 * write-back.
 *
 * Why a class and not a hook: the console and the office dashboard both need
 * this loop, and the dashboard has no React. A hook cannot be bundled for a
 * vanilla page without dragging React in and re-implementing every rule, so
 * the logic lives here and `useGeminiLive` is a thin adapter over it.
 *
 * The class is deliberately plain: no framework imports, no DOM lookups
 * beyond `localStorage`/`window`, and every external object (session, capture,
 * player, fetch) can be injected — which is what makes it unit-testable.
 */

import { AudioPlayer } from "../audio/AudioPlayer";
import { PcmCapture } from "../audio/PcmCapture";
import {
  GeminiLiveSession,
  saveLiveTurnToMemory,
  type GeminiLiveEvent,
  type GeminiLiveOptions,
  type GeminiLiveStatus,
  type LiveToolCall,
  type LiveToolResult,
  type StartResult,
} from "./geminiLive";
import { resolveBrowserUserKey } from "./identity";
import {
  askFirstInstruction,
  decideLiveToolCalls,
  emptyConfirmState,
  markUserSpoke,
  type LiveConfirmState,
} from "./liveConfirm";
import { liveToolNote } from "./liveToolNote";
import {
  applyFadeOut,
  bytesToBase64,
  createPcmChunker,
  detectLaughter,
  floatTo16BitPcm,
  pcmToWav,
  rmsFloat32,
  LIVE_OUTPUT_SAMPLE_RATE,
  LIVE_PREBUFFER_BYTES,
} from "./pcm";

/* ── injectable seams ─────────────────────────────────────────────── */

/** The part of `GeminiLiveSession` this orchestrator uses. */
export interface LiveSessionLike {
  on(fn: (event: GeminiLiveEvent) => void): () => void;
  start(): Promise<StartResult>;
  sendAudioFrame(pcm: Uint8Array, base64: string): void;
  sendText(text: string): void;
  sendToolResponse(results: LiveToolResult[]): void;
  interrupt(): void;
  setAudioMuted(muted: boolean): void;
  readonly isAudioMuted: boolean;
  stop(): void;
}

/** The part of `PcmCapture` this orchestrator uses. */
export interface LiveCaptureLike {
  onFrame(fn: (frame: Float32Array) => void): () => void;
  start(stream: MediaStream): Promise<void>;
  stop(): void;
}

/** The part of `AudioPlayer` this orchestrator uses. */
export interface LivePlayerLike {
  enqueuePcm(pcm: Uint8Array, sampleRate: number): void;
  stop(): void;
  fadeStop(fadeMs?: number): void;
  setTelephoneVoice(on: boolean): void;
}

export interface LiveClientOptions {
  /** Absolute URL of the token route; relative in the browser. */
  tokenUrl?: string;
  /**
   * `fetch` used for EVERY Mia-web call this client makes (token, tool,
   * memory). The dashboard injects one that carries its bearer token and pins
   * the agent, because its page origin is not Mia's.
   */
  fetchImpl?: typeof fetch;
  /** Headers identifying the speaker; merged AFTER the derived browser ones. */
  userHeader?: Record<string, string>;
  /** Test seam: replace the WebSocket client. */
  createSession?: (opts: GeminiLiveOptions) => LiveSessionLike;
  /** Test seam: replace the mic capture. */
  createCapture?: () => LiveCaptureLike;
  /** Test seam: replace the player. */
  createPlayer?: () => LivePlayerLike;
}

/* ── public state ─────────────────────────────────────────────────── */

export interface LiveClientState {
  /** `connecting` while the socket opens, `ready` once setup completes. */
  status: GeminiLiveStatus;
  /** True while Gemini's voice is playing. */
  speaking: boolean;
  /** True while the mic is muted (outgoing frames only). */
  muted: boolean;
  /** Live transcript of what the USER said. */
  heard: string;
  /** Live transcript of what GEMINI said. */
  said: string;
  /**
   * Honesty note for the just-finished turn, set only when the server flagged
   * its claims against executed tools. Shown, never spoken. Empty when clean.
   */
  verifyNote: string;
  /** Last error, already phrased for a user. Empty when healthy. */
  error: string;
  /**
   * Set when the session is open but the model produced nothing at all.
   * Distinct from `error`: the connection is fine, the far side is silent.
   */
  stalled: string;
  /** What the model is doing right now ("⏳ mengecek email…"). */
  toolNote: string;
  /** Narrow-band telephone character on the Live output. */
  telephoneVoice: boolean;
}

export type LiveClientListener = (state: LiveClientState) => void;

/* ── constants (moved verbatim from the hook) ──────────────────────── */

/**
 * Client-side barge-in: talking over Gemini often produces no `interrupted`
 * frame from Google at all — the mic hears, subtitles print, but the turn never
 * yields. Energy threshold + consecutive-frame hold, armed shortly after
 * Gemini starts so its own greeting cannot trigger it.
 */
const BARGE_RMS = 0.015;
const BARGE_HOLD_FRAMES = 4;
const BARGE_ARM_MS = 800;
/** Cap: 60 s of 24 kHz mono 16-bit — enough for a diagnosis, never a leak. */
const RAW_CAP_BYTES = 24_000 * 2 * 60;

/** The browser's resolved key, so tool execution runs as the right person. */
export function browserUserHeader(): Record<string, string> {
  try {
    if (typeof window === "undefined") return {};
    return { "x-mia-user": resolveBrowserUserKey(window.localStorage.getItem("voice-ai.user")) };
  } catch {
    return {};
  }
}

export class LiveClient {
  private readonly options: LiveClientOptions;

  private state: LiveClientState = {
    status: "idle",
    speaking: false,
    muted: false,
    heard: "",
    said: "",
    verifyNote: "",
    error: "",
    stalled: "",
    toolNote: "",
    telephoneVoice: true,
  };

  private readonly listeners = new Set<LiveClientListener>();

  // Long-lived objects, not render state: the WebSocket, the audio graph and
  // the player must survive re-renders untouched.
  private session: LiveSessionLike | null = null;
  /** When the current session started (tells stale sessions apart). */
  private startedAt = 0;
  private capture: LiveCaptureLike | null = null;
  private player: LivePlayerLike | null = null;
  /**
   * Playout buffer: Google's PCM frames are small and jittered, so each one
   * played directly is an audible hole whenever a frame is late. The chunker
   * emits fixed ~0.5 s pieces; reset on every stop/interrupt so stale audio
   * can never leak into the next turn.
   */
  private readonly chunker = createPcmChunker();
  /**
   * The turn being spoken right now, mirrored out of state so the write-back
   * always sees the latest text even from stale closures. Reset the moment a
   * save is initiated: the POST is async, and a second flush before it
   * resolves must find nothing, never save twice.
   */
  private turn: { heard: string; said: string; startedAt: number } = { heard: "", said: "", startedAt: 0 };
  /**
   * Pending voice write actions awaiting spoken confirmation. A first-seen
   * write is held here, the model asks aloud, and only a re-call with
   * confirmed:true after the user spoke executes.
   */
  private pending: LiveConfirmState = emptyConfirmState();
  private speaking = false;
  private muted = false;
  private speakingSince = 0;
  private hotStreak = 0;
  /** Last mic frame energy (for the barge snapshot). */
  private bargeRms = 0;
  /** Peak mic energy since Gemini started speaking. */
  private bargePeak = 0;
  /** Recent mic RMS for the laughter detector (ring, ~3.4 s at 85 ms/frame). */
  private laughRms: number[] = [];
  /** A "[tertawa]" tag was already sent this turn (max one per turn). */
  private laughSent = false;
  /**
   * Duck window: while this is in the future, incoming model audio is DROPPED
   * instead of buffered. Refreshed while the user keeps talking (cap 5 s), so
   * sustained speech holds the floor and a cough costs at most one window.
   */
  private duckUntil = 0;
  private duckStart = 0;
  // Raw incoming PCM this session, capped: the noise diagnostic. Never read
  // for playback, only for export.
  private raw: Uint8Array[] = [];
  private rawBytes = 0;
  /**
   * Startup prebuffer for the voice: chunks are held here until
   * LIVE_PREBUFFER_BYTES are ready, then released in order and the rest of the
   * turn streams straight through.
   */
  private prime: Uint8Array[] = [];
  private primed = false;

  constructor(options: LiveClientOptions = {}) {
    this.options = options;
    this.state.telephoneVoice = this.readTelephonePref();
  }

  /* ── state plumbing ──────────────────────────────────────────────── */

  getState(): LiveClientState {
    return this.state;
  }

  /** Subscribe to state changes. The listener fires immediately with the
   *  current state, so a late subscriber is never stale. */
  subscribe(fn: LiveClientListener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private patch(next: Partial<LiveClientState>): void {
    this.state = { ...this.state, ...next };
    for (const fn of this.listeners) {
      try {
        fn(this.state);
      } catch {
        /* a listener fault must not break the session */
      }
    }
  }

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  private get userHeader(): Record<string, string> {
    return { ...browserUserHeader(), ...(this.options.userHeader ?? {}) };
  }

  /* ── memory write-back ───────────────────────────────────────────── */

  /**
   * Write the current turn into today's daily memory (fire-and-forget) and
   * clear it first, so overlapping end-of-turn signals can never double-save.
   * Safe to call from any turn boundary: stop, interrupt, or turn end.
   */
  private flushTurnMemory(): void {
    const turn = this.turn;
    this.turn = { heard: "", said: "", startedAt: 0 };
    this.patch({ verifyNote: "" });
    if (!turn.heard.trim() && !turn.said.trim()) return;
    void saveLiveTurnToMemory(turn.heard, turn.said, this.userHeader, this.fetchImpl, {
      sinceMs: turn.startedAt > 0 ? turn.startedAt : undefined,
      onVerification: (v) => {
        if (v && v.verdict === "flagged" && v.note) this.patch({ verifyNote: v.note });
      },
    });
  }

  /* ── player helpers ──────────────────────────────────────────────── */

  /**
   * Persisted telephone-voice preference. Missing key = ON; anything but
   * "0"/"false" keeps it on. Guarded because storage can throw (private
   * mode, blocked cookies).
   */
  private readTelephonePref(): boolean {
    try {
      const raw = window.localStorage.getItem("mia.live.telephone");
      return !(raw === "0" || raw === "false");
    } catch {
      return true;
    }
  }

  private ensurePlayer(): LivePlayerLike {
    if (!this.player) {
      const p = this.options.createPlayer ? this.options.createPlayer() : new AudioPlayer();
      // Telephone voice, on by default ("jangan terlalu jernih" — a 300-3400 Hz
      // band plus heavy compression reads as a phone call). Persisted so the
      // studio-clean playback is one toggle away.
      p.setTelephoneVoice(this.readTelephonePref());
      this.player = p;
    }
    return this.player;
  }

  /** Feed one playout piece straight into the gapless schedule. */
  private playPiece(piece: Uint8Array): void {
    if (piece.length) this.ensurePlayer().enqueuePcm(piece, LIVE_OUTPUT_SAMPLE_RATE);
  }

  /** Release everything the prebuffer is holding (turn end), then re-arm it. */
  private releasePrime(): void {
    for (const p of this.prime) this.playPiece(p);
    this.prime = [];
    this.primed = false;
  }

  /** Drop the prebuffer without playing it (interrupt/stop). */
  private dropPrime(): void {
    this.prime = [];
    this.primed = false;
  }

  /* ── lifecycle ───────────────────────────────────────────────────── */

  stop(): void {
    // A close mid-turn must not lose what was just said: flush first, while
    // the turn is still intact. Idempotent — a second call finds it empty.
    this.flushTurnMemory();
    this.capture?.stop();
    this.capture = null;
    this.session?.stop();
    this.session = null;
    // Drop anything still queued so a stopped session cannot keep talking.
    this.player?.stop();
    this.chunker.reset();
    this.dropPrime();
    this.duckUntil = 0;
    this.duckStart = 0;
    // NOTE: the raw diagnostic buffer is deliberately NOT cleared here —
    // `downloadRaw()` is meant to run AFTER a call ends. It resets on the
    // next start() instead.
    // A new session must never inherit an old spoken question: a stale
    // pending could authorize a turn the user never agreed to.
    this.pending = emptyConfirmState();
    this.patch({ speaking: false, muted: false, toolNote: "", status: "idle" });
  }

  async start(stream: MediaStream | null): Promise<StartResult> {
    if (!stream) {
      const message = "The microphone is not available yet.";
      this.patch({ error: message });
      return { ok: false, error: message };
    }
    // A second start without a stop would leave an orphaned socket burning a
    // single-use token, so always tear down first. The raw diagnostic buffer
    // belongs to the NEW session from here on.
    this.raw = [];
    this.rawBytes = 0;
    this.stop();
    this.patch({ error: "", stalled: "", heard: "", said: "" });

    const sessionOptions: GeminiLiveOptions = {
      ...(this.options.tokenUrl ? { tokenUrl: this.options.tokenUrl } : {}),
      ...(this.options.userHeader ? { userHeader: this.options.userHeader } : {}),
      fetchImpl: this.fetchImpl,
    };
    const session = this.options.createSession
      ? this.options.createSession(sessionOptions)
      : new GeminiLiveSession(sessionOptions);
    this.session = session;

    session.on((event) => this.handleEvent(event, session));

    const result = await session.start();
    if (!result.ok) {
      // A failed start must not leave a half-open capture or session behind.
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
      // The socket is open but we cannot hear anything: better to close it
      // than to sit there appearing connected while mute.
      session.stop();
      this.session = null;
      const message = `Could not start microphone capture: ${
        err instanceof Error ? err.message : String(err)
      }`;
      this.patch({ error: message, status: "error" });
      return { ok: false, error: message };
    }

    return { ok: true };
  }

  /** Stop Gemini mid-sentence (barge-in). */
  interrupt(): void {
    try {
      // eslint-disable-next-line no-console
      console.debug("[mia-live] interrupt() called");
    } catch {
      /* console unavailable */
    }
    this.session?.interrupt();
    // Glide out, don't chop: the tail should fade, not click to silence.
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
  toggleMute(): void {
    const session = this.session;
    if (!session || this.state.status !== "ready") return;
    // The session is the source of truth (never a side effect inside a state
    // updater — StrictMode double-invokes those).
    const next = !session.isAudioMuted;
    session.setAudioMuted(next);
    this.muted = next;
    this.patch({ muted: next });
  }

  /** Send text as if spoken. */
  sendText(text: string): void {
    this.session?.sendText(text);
  }

  /**
   * Telephone voice (narrow band + heavy compression). Mirrors the player's
   * flag so a UI toggle can show the current state, and persists the choice so
   * it survives a reload.
   */
  setTelephoneVoice(on: boolean): void {
    const next = !!on;
    this.player?.setTelephoneVoice(next);
    try {
      window.localStorage.setItem("mia.live.telephone", next ? "1" : "0");
    } catch {
      /* storage blocked — the in-memory flag still applies */
    }
    this.patch({ telephoneVoice: next });
  }

  /* ── session events ──────────────────────────────────────────────── */

  private handleEvent(event: GeminiLiveEvent, session: LiveSessionLike): void {
    switch (event.type) {
      case "status":
        this.patch({
          status: event.status,
          ...(event.detail ? { error: event.detail } : {}),
        });
        break;
      case "error":
        this.patch({ error: event.message });
        break;
      case "stalled":
        // Not an error: the session is still open. It is the notice that keeps
        // a silent Google from looking like a stuck UI.
        this.patch({ stalled: event.message });
        break;
      case "speaking":
        this.patch({ speaking: event.speaking });
        // Arm the timestamp on the FALSE→TRUE transition only. `speaking:true`
        // fires on EVERY audio frame, so stamping unconditionally keeps
        // `now - armedAt < BARGE_ARM_MS` true forever and the barge-in can
        // never arm. Same for the duck refs: a fresh turn starts clean.
        if (event.speaking && !this.speaking) {
          this.speakingSince = Date.now();
          this.bargePeak = 0;
          this.hotStreak = 0;
          // New turn = new window for one laugh tag.
          this.laughSent = false;
        }
        this.speaking = event.speaking;
        if (!event.speaking) this.hotStreak = 0;
        else this.patch({ toolNote: "" });
        // The model is producing something, so the silence notice is stale.
        this.patch({ stalled: "" });
        if (!event.speaking) {
          // Turn end: play the short tail the chunker is still holding so the
          // last syllable is not cut, together with anything the prebuffer
          // held (a short turn never reached the threshold).
          this.releasePrime();
          const tail = this.chunker.flush();
          // Fade the tail: it is the last sound of the turn, and stopping dead
          // on a non-zero sample is an end-click.
          if (tail && tail.length) this.playPiece(applyFadeOut(tail, LIVE_OUTPUT_SAMPLE_RATE));
          // And remember the turn: without this, Live conversations vanish the
          // moment the socket closes and chat memory never learns them.
          this.flushTurnMemory();
        }
        break;
      case "input_transcript":
        if (this.turn.startedAt === 0) this.turn.startedAt = Date.now();
        this.turn.heard = event.text;
        this.patch({ heard: event.text, stalled: "" });
        // Any user speech may be the answer to a pending spoken question.
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
        // Keep a copy of the wire bytes for the noise diagnostic (capped).
        if (this.rawBytes < RAW_CAP_BYTES) {
          this.raw.push(event.pcm);
          this.rawBytes += event.pcm.length;
        }
        // Floor held after a local barge-in: the model often keeps generating
        // despite the interrupt, so its audio is dropped here instead of
        // rebutting the speakers mid-sentence. Transcripts and tool calls
        // still flow — only playout is held.
        if (Date.now() < this.duckUntil) return;
        // Through the playout buffer, never straight to the player: one WAV
        // per jittered network frame is what made the voice stutter. PCM goes
        // in synchronously and the first ~1 s of each turn is prebuffered.
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
        // eslint-disable-next-line no-console
        console.debug("[mia-live] interrupted frame from Google");
        const pl = this.player;
        if (pl && typeof pl.fadeStop === "function") pl.fadeStop(300);
        else pl?.stop();
        this.chunker.reset();
        this.dropPrime();
        this.duckUntil = 0;
        this.duckStart = 0;
        // A cut-off turn is still a turn: save the partial exchange before it
        // is lost. Idempotent with the speaking:false flush below.
        this.flushTurnMemory();
        this.patch({ speaking: false });
        break;
      }
      case "tool_call": {
        this.patch({ toolNote: liveToolNote(event.calls.map((c) => c.name)) });
        // Diagnostic beacon: the model sometimes chats through the whole
        // confirm flow without emitting a single call, which is invisible
        // server-side (no POST ever arrives). This fire-and-forget line makes
        // emissions observable; the names only, never args (privacy).
        try {
          void this.fetchImpl("/api/gemini-live/tool-ping", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ names: event.calls.map((c) => c.name) }),
          }).catch(() => undefined);
        } catch {
          /* diagnostic only */
        }
        // Voice write actions never execute on first sight: reads run now,
        // writes are held until the spoken loop completes (model asks aloud ->
        // user answers -> re-call with confirmed:true). Never awaited; each
        // answer is delivered through `sendToolResponse` as it becomes ready.
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
        // Plain-text turns are outside this phase's scope (voice only), so
        // surface nothing rather than half-render a code block as speech.
        break;
    }
  }

  /* ── mic frames ──────────────────────────────────────────────────── */

  private handleFrame(frame: Float32Array, session: LiveSessionLike): void {
    const pcm = floatTo16BitPcm(frame);
    session.sendAudioFrame(pcm, bytesToBase64(pcm));
    const rms = rmsFloat32(frame);
    this.bargeRms = rms;
    if (rms > this.bargePeak) this.bargePeak = rms;
    // Laughter tag: rhythmic bursts ("ha-ha-ha") become a "[tertawa]" context
    // marker the model reads — the only prosody channel this endpoint allows.
    // Max once per turn; the voice rule tells the model what it means. Never
    // throws into the audio path.
    this.laughRms.push(rms);
    if (this.laughRms.length > 40) this.laughRms.shift();
    if (!this.muted && this.session && !this.laughSent && detectLaughter(this.laughRms)) {
      this.laughSent = true;
      try {
        this.session.sendText("[tertawa]");
      } catch {
        /* a dead socket needs no tag */
      }
    }
    // Client-side barge-in: hot mic energy while Gemini is audible cuts it off
    // locally instead of waiting for Google's `interrupted` frame (which
    // often never comes). Same actions as the `interrupted` event — all
    // idempotent — so whichever fires first wins.
    if (!this.speaking || this.muted || !this.session) {
      this.hotStreak = 0;
      return;
    }
    if (Date.now() - this.speakingSince < BARGE_ARM_MS || rms < BARGE_RMS) {
      this.hotStreak = 0;
      return;
    }
    // Leaky bucket, not a hard reset: syllable gaps (1-2 cold frames) must not
    // erase a hot run. Hot frames add, cold frames drain one at a time;
    // sustained speech still trips it within ~0.5 s, while room noise never
    // accumulates.
    if (rms >= BARGE_RMS) this.hotStreak = Math.min(this.hotStreak + 1, BARGE_HOLD_FRAMES);
    else this.hotStreak = Math.max(this.hotStreak - 1, 0);
    if (this.hotStreak < BARGE_HOLD_FRAMES) return;
    this.hotStreak = 0;
    // Hold the floor: drop everything Google keeps sending while the user
    // talks. Refreshed per hot frame, cap 5 s from the first trigger so a
    // stuck mic cannot mute Gemini forever.
    const nowHold = Date.now();
    const fresh = nowHold >= this.duckUntil;
    if (fresh) {
      this.duckStart = nowHold;
      try {
        // eslint-disable-next-line no-console
        console.debug("[mia-live] local barge-in: holding floor");
      } catch {
        /* console unavailable */
      }
    }
    this.duckUntil = Math.min(nowHold + 2500, this.duckStart + 5000);
    try {
      this.session.interrupt();
    } catch {
      /* a dead socket needs no interrupt */
    }
    try {
      const pl = this.player;
      if (pl && typeof pl.fadeStop === "function") pl.fadeStop(300);
      else pl?.stop();
    } catch {
      /* player already torn down */
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
  private async runToolCalls(
    session: LiveSessionLike,
    calls: LiveToolCall[]
  ): Promise<void> {
    const answer = (results: LiveToolResult[]) => {
      try {
        session.sendToolResponse(results);
      } catch {
        // A dead socket needs no answer.
      }
    };
    let results: LiveToolResult[];
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const res = await this.fetchImpl("/api/gemini-live/tool", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...this.userHeader },
          body: JSON.stringify({
            calls: calls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
          }),
          signal: controller.signal,
        });
        const json = (await res.json().catch(() => ({}))) as {
          results?: Array<{ id?: unknown; name?: unknown; result?: unknown }>;
          error?: string;
        };
        if (!res.ok || !Array.isArray(json.results)) {
          throw new Error(typeof json.error === "string" ? json.error : `tool route HTTP ${res.status}`);
        }
        results = calls.map((c, index) => {
          const r = json.results?.[index];
          return {
            id: c.id,
            name: c.name,
            result: typeof r?.result === "string" ? r.result : "Error: no result from tool route.",
          };
        });
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      const message =
        err instanceof Error && err.name === "AbortError"
          ? "Error: the tool took too long (30s) and was stopped."
          : `Error: could not reach the tool route (${err instanceof Error ? err.message : String(err)}).`;
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
  installDiagnostics(target?: unknown): () => void {
    const w = (target ?? (typeof window !== "undefined" ? window : undefined)) as
      | { __miaLive?: unknown }
      | undefined;
    if (!w) return () => undefined;
    w.__miaLive = {
      // Bump when the Live client changes: lets support verify the tab runs
      // fresh code. Print __miaLive.version in the console.
      version: "2026-10-21-dashboard",
      // Wall-clock ISO of the live session start. Compare against deploy times
      // to prove a test ran on fresh instructions, not a stale session.
      startedAt: () => (this.startedAt ? new Date(this.startedAt).toISOString() : "(no session yet)"),
      stats: () => ({ rawFrames: this.raw.length, rawBytes: this.rawBytes }),
      // Barge snapshot: print WHILE talking over Gemini.
      barge: () => ({
        speaking: this.speaking,
        muted: this.muted,
        streak: this.hotStreak,
        lastRms: Number(this.bargeRms.toFixed(4)),
        peakRms: Number(this.bargePeak.toFixed(4)),
        duckUntilInMs: Math.max(0, this.duckUntil - Date.now()),
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
        const url = URL.createObjectURL(new Blob([wav.buffer as ArrayBuffer], { type: "audio/wav" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = "mia-live-raw.wav";
        // Attached before click: some Chrome profiles ignore clicks on
        // detached anchors, which silently produces "saved N bytes" with no
        // file in Downloads.
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        return `saved ${total} bytes`;
      },
      playSine: () => {
        const frames = LIVE_OUTPUT_SAMPLE_RATE;
        const pcm = new Uint8Array(frames * 2);
        const view = new DataView(pcm.buffer);
        for (let i = 0; i < frames; i += 1) {
          view.setInt16(i * 2, Math.round(Math.sin((i / frames) * Math.PI * 2 * 440) * 0x7fff), true);
        }
        this.ensurePlayer().enqueuePcm(pcm, LIVE_OUTPUT_SAMPLE_RATE);
        return "playing 440 Hz for 1 s";
      },
    };
    return () => {
      if (w.__miaLive) delete w.__miaLive;
    };
  }
}
