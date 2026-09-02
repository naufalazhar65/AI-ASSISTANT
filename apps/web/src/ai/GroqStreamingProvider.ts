import {
  AIProvider,
  ConfirmationRequest,
  ConversationMessage,
  ProviderEventListener,
  ProviderEvent,
} from "@voice/ai-provider";

/** Leading marker of a confirmation frame in the /api/llm stream (FR-014). */
const CONFIRM_FRAME_PREFIX = "@@CONFIRM ";

/**
 * GroqStreamingProvider — real ASR/LLM/TTS over the free Groq tier.
 *
 * Pipeline per user turn (PRD §14):
 *   audio → /api/stt (Whisper) → final transcript
 *        → /api/llm (Qwen, SSE) → text_delta stream
 *        → /api/tts (Orpheus) per sentence → audio_delta → AudioPlayer
 *
 * The provider keeps its own conversation history so follow-up questions get
 * context (FR-008). Keys stay server-side (invariant 5) — the client only
 * ever talks to our own /api/* routes.
 *
 * Groq's ASR/TTS are request-based, so transcripts are final-only and TTS is
 * synthesized per sentence. True partial transcripts + streaming TTS arrive
 * with a streaming-capable vendor (PRD Phase 3).
 */
export class GroqStreamingProvider implements AIProvider {
  private listeners = new Set<ProviderEventListener>();
  private messages: ConversationMessage[] = [];
  private generationId = 0;
  private controller: AbortController | null = null;
  private connected = false;
  private pendingTools: ConfirmationRequest[] = [];
  /** User-selected TTS voice (FR-009). Applied per request to /api/tts. */
  private ttsVoice = "hannah";
  /** Optional user-selected LLM model; undefined = route default. */
  private llmModel: string | undefined;

  setTtsSettings(voice: string): void {
    if (this.ttsVoice === voice) return;
    this.ttsVoice = voice;
  }

  setModel(model: string | undefined): void {
    this.llmModel = model ?? undefined;
  }

  private llmProvider: string | undefined;
  setProvider(provider: string | undefined): void {
    this.llmProvider = provider ?? undefined;
  }

  /** Current user identity (from localStorage) for per-user persona isolation. */
  private user: string | undefined;
  setUser(user: string | undefined): void {
    this.user = user ?? undefined;
  }

  connect(): Promise<void> {
    this.connected = true;
    this.emit({ type: "connected" });
    return Promise.resolve();
  }

  disconnect(): void {
    this.connected = false;
    this.generationId += 1;
    this.controller?.abort();
    this.emit({ type: "disconnected" });
  }

async sendAudio(audio: ArrayBuffer): Promise<void> {
    if (!this.connected || audio.byteLength === 0) return;
    const transcript = await this.transcribe(audio);
    if (!transcript.trim()) return;
    this.messages.push({ role: "user", content: transcript });
    this.emit({ type: "final_transcript", transcript });
  }

  /** Live interim transcript (FR-016): snapshots of the growing utterance. */
  sendPartialAudio(audio: ArrayBuffer): void {
    if (!this.connected || audio.byteLength === 0) return;
    void this.transcribe(audio).then((transcript) => {
      if (transcript.trim()) this.emit({ type: "partial_transcript", transcript });
    });
  }

  sendText(text: string): void {
    if (!this.connected || !text.trim()) return;
    void this.runTextTurn(text);
  }

  /** Resolve a tool call paused for user confirmation (FR-014). */
  confirmTool(callId: string, allow: boolean): void {
    const call = this.pendingTools.find((c) => c.id === callId);
    if (!call) return;
    this.pendingTools = [];
    if (!this.connected || !this.messages.length) return;
    // Append the assistant's tool_calls so the route's tool-result message
    // resolves against the right context (OpenAI tool-calling contract).
    this.messages.push({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        },
      ],
    });
    void this.generateAndSpeakAfterConfirmation(call, allow);
  }

  interrupt(): void {
    // Abort old work; nothing from this generation may reach the UI (FR-007).
    this.generationId += 1;
    this.controller?.abort();
    this.controller = null;
    this.emit({ type: "interrupted" });
  }

  on(fn: ProviderEventListener): void {
    this.listeners.add(fn);
  }

  off(fn: ProviderEventListener): void {
    this.listeners.delete(fn);
  }

  private async runTextTurn(text: string): Promise<void> {
    this.messages.push({ role: "user", content: text });
    this.emit({ type: "final_transcript", transcript: text });
    await this.generateAndSpeak();
  }

  private async transcribe(audio: ArrayBuffer): Promise<string> {
    // Send raw bytes as the body (not FormData): some browser extensions
    // structuredClone-ify window.fetch bodies and FormData is not cloneable.
    const res = await fetch("/api/stt", {
      method: "POST",
      headers: { "Content-Type": "audio/webm" },
      body: new Blob([audio], { type: "audio/webm" }),
    });
    if (!res.ok) {
      const { error } = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(error ?? `STT failed (${res.status})`);
    }
    const { transcript } = (await res.json()) as { transcript?: string };
    return transcript ?? "";
  }

  private async generateAndSpeak(): Promise<void> {
    await this.streamAssistantReply({ messages: this.messages, confirm_call: undefined });
  }

  /** Resolve a risky tool call after user confirmation (FR-014). */
  private async generateAndSpeakAfterConfirmation(call: ConfirmationRequest, allow: boolean): Promise<void> {
    // The assistant's tool_calls are already in this.messages (added by
    // confirmTool); the route consumes confirm_call to resolve them.
    await this.streamAssistantReply({
      messages: this.messages,
      confirm_call: { id: call.id, name: call.name, arguments: call.arguments, allow },
    });
  }

  /**
   * Streams one LLM turn, TTS'ing text per sentence and updating the assistant
   * context. A risky-tool turn yields a `@@CONFIRM` frame instead of text: that
   * is surfaced to the UI and never spoken.
   */
  private async streamAssistantReply(opts: {
    messages: ConversationMessage[];
    confirm_call?: ConfirmationRequest & { allow: boolean };
  }): Promise<void> {
    const generation = this.generationId;
    const controller = new AbortController();
    this.controller = controller;

    const emitIfCurrent = (event: ProviderEvent): boolean => {
      if (this.generationId !== generation) return false;
      this.emit(event);
      return true;
    };

    let streamed = "";
    try {
      const body: Record<string, unknown> = { messages: opts.messages };
      // The route's confirm_call contract is { call: ToolCall; allow }. The
      // caller hands us { id, name, arguments, allow }; wrap it so the route
      // receives the shape it declares (and stops misreading undefined.call).
      if (opts.confirm_call) {
        const { allow, id, name, arguments: args } = opts.confirm_call;
        body.confirm_call = { call: { id, name, arguments: args }, allow };
      }
      if (this.llmProvider) body.provider = this.llmProvider;
      if (this.llmModel) body.model = this.llmModel;
      if (this.user) body.user = this.user;
      const res = await fetch("/api/llm", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`LLM failed (${res.status})`);
      if (!res.body) throw new Error("LLM returned no body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const delta = decoder.decode(value, { stream: true });
        streamed += delta;

        // A risky-tool turn emits a single @@CONFIRM frame (FR-014) — never TTS.
        if (streamed.trimStart().startsWith(CONFIRM_FRAME_PREFIX)) {
          continue;
        }

        pending += delta;
        if (!emitIfCurrent({ type: "text_delta", text: delta })) return;

        // Flush a sentence to TTS as soon as one is complete (FR-006).
        const boundary = this.firstSentenceEnd(pending);
        if ((boundary >= 0 && pending.length >= 45) || pending.length >= 160) {
          const sentence = boundary >= 0 ? pending.slice(0, boundary + 1) : pending;
          pending = boundary >= 0 ? pending.slice(boundary + 1) : "";
          await this.speak(sentence, generation, controller.signal);
        }
      }

      // Confirmation turn: hand the pending calls to the UI, don't complete.
      if (streamed.trimStart().startsWith(CONFIRM_FRAME_PREFIX)) {
        const raw = streamed.trimStart().slice(CONFIRM_FRAME_PREFIX.length).trim();
        const parsed = JSON.parse(raw) as ConfirmationRequest[];
        if (Array.isArray(parsed) && parsed.length) {
          this.pendingTools = parsed;
          emitIfCurrent({ type: "tool_confirmation_required", calls: parsed });
          return;
        }
      }

      if (pending.trim()) {
        await this.speak(pending, generation, controller.signal);
      }

      // Signal completion so the state machine can move to SPEAKING.
      const { cleanText, writes } = this.extractPersona(streamed);
      this.messages.push({ role: "assistant", content: cleanText });
      if (writes.length && !controller.signal.aborted) {
        void this.persistPersona(writes).catch(() => {});
      }
      emitIfCurrent({ type: "text_complete", text: cleanText });
      emitIfCurrent({ type: "audio_complete" });
    } catch (err) {
      if (controller.signal.aborted) return; // interrupt is not an error
      if (this.generationId !== generation) return;
      this.emit({
        type: "error",
        message: err instanceof Error ? err.message : "Assistant failed",
      });
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  /**
   * Splits any trailing `<persona>` tag off the reply so it is never spoken.
   * Tag format: `<persona>user.<key>=<value>;soul.<key>=<value></persona>`.
   * `user.*` facts go to USER.md, `soul.*` preferences to SOUL.md via the
   * /api/persona route (persistent, OpenClaw-style "lived" persona).
   */
  private extractPersona(text: string): { cleanText: string; writes: { target: "USER" | "SOUL"; key: string; value: string }[] } {
    const match = text.match(/<persona>([^<]*)<\/persona>/s);
    if (!match) return { cleanText: text, writes: [] };
    const cleanText = text.slice(0, match.index).trimEnd();
    const writes: { target: "USER" | "SOUL"; key: string; value: string }[] = [];
    for (const entry of match[1].split(";")) {
      const m = entry.trim().match(/^(user|soul)\.([^=]+)=(.+)$/s);
      if (!m) continue;
      writes.push({
        target: m[1] === "user" ? "USER" : "SOUL",
        key: m[2].trim(),
        value: m[3].trim(),
      });
    }
    return { cleanText, writes };
  }

  private async persistPersona(
    writes: { target: "USER" | "SOUL"; key: string; value: string }[]
  ): Promise<void> {
    await Promise.all(
      writes.map((w) =>
        fetch("/api/persona", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            target: w.target,
            key: w.key,
            value: w.value,
            ...(this.user ? { user: this.user } : {}),
          }),
        })
      )
    );
  }

  private firstSentenceEnd(text: string): number {
    const match = text.match(/[.!?…:"\n]/);
    return match ? match.index! : -1;
  }

  /**
   * Synthesize one sentence to speech (FR-006). TTS is best-effort: if Groq
   * rejects the request (429 rate limit, 502, …) or the network hiccups we
   * silently skip the audio for this sentence rather than failing the whole
   * turn — the assistant still finishes visibly as text. Voice output is a
   * supplement; a throttled/live speaker must not surface raw fetch errors.
   */
  private async speak(sentence: string, generation: number, signal: AbortSignal): Promise<void> {
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: sentence, voice: this.ttsVoice }),
      });
      if (!res.ok) return; // 429/5xx: skip audio, keep streaming text
      const audio = await res.arrayBuffer();
      if (this.generationId !== generation || audio.byteLength === 0) return;
      this.emit({ type: "audio_delta", audio: new Uint8Array(audio), sampleRate: 0 });
    } catch {
      // abort (interrupt) and transient failures are not user-facing errors.
    }
  }

  private emit(event: ProviderEvent): void {
    for (const fn of this.listeners) fn(event);
  }
}