import { AIProvider, ConfirmationRequest, ProviderEvent, ConversationMessage } from "@voice/ai-provider";
import { ConversationStateMachine, Event as StateEvent, State } from "@voice/state-machine";

/**
 * ConversationManager — the single place where turn logic lives.
 *
 * Owns the state machine and forwards provider events into it. UI and audio
 * layers communicate only via this manager, never with the provider directly.
 * This is what guarantees the state machine stays correct and providers stay
 * swappable (PRD invariants #1 and #2).
 */

export interface TranscriptEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
  state: "partial" | "final";
}

export type ConversationListener = (event: ConversationEvent) => void;

export type ConversationEvent =
  | { type: "state"; state: State }
  | { type: "transcript"; entry: TranscriptEntry }
  | { type: "message"; message: ConversationMessage }
  | { type: "tool_confirmation"; calls: ConfirmationRequest[] }
  | { type: "error"; message: string };

let sequence = 0;
const nextId = (prefix: string): string => `${prefix}_${Date.now()}_${++sequence}`;

export class ConversationManager {
  private machine: ConversationStateMachine;
  private providers: AIProvider[];
  private messages: ConversationMessage[] = [];
  private maxMessages = 20; // 10 turns max for context window
  private turnAudioComplete = false;

  /** Move from SPEAKING to LISTENING once the current reply has played out. */
  finishTurn(): void {
    if (!this.turnAudioComplete) return;
    this.turnAudioComplete = false;
    this.emitMachine("TURN_END");
  }
  private transcripts: TranscriptEntry[] = [];
  private activeUserEntry: TranscriptEntry | null = null;
  private activeAssistantEntry: TranscriptEntry | null = null;
  private interrupted = false;
  private listeners = new Set<ConversationListener>();

  constructor(providers: AIProvider[], messages: ConversationMessage[] = []) {
    this.providers = providers;
    this.messages = messages;
    this.machine = new ConversationStateMachine();

    for (const provider of providers) {
      provider.on((event) => this.handleProviderEvent(provider, event));
    }
  }

  get currentState(): State {
    return this.machine.current;
  }

  get history(): TranscriptEntry[] {
    return [...this.transcripts];
  }

  /** Serializable view of the conversation (FR-015 continue + persist). */
  serialize(): { messages: ConversationMessage[]; transcripts: TranscriptEntry[] } {
    return {
      messages: [...this.messages],
      transcripts: this.transcripts.map((t) => ({ ...t })),
    };
  }

  /**
   * Restores a persisted conversation so context + transcript survive reload
   * (FR-015 "continue conversation"). Re-derives the bounded LLM context from
   * the final transcripts.
   */
  restoreHistory(transcripts: TranscriptEntry[]): void {
    const finals = transcripts.filter((t) => t.state === "final");
    this.transcripts = finals.map((t) => ({ ...t }));
    this.messages = finals
      .map((t) => ({ role: t.role, content: t.text }))
      .slice(-this.maxMessages);
    this.emit({ type: "transcript", entry: finals[finals.length - 1] ?? { id: "seed", role: "user", text: "", state: "final" } });
  }

  on(fn: ConversationListener): void {
    this.listeners.add(fn);
  }

  off(fn: ConversationListener): void {
    this.listeners.delete(fn);
  }

  /** User pressed the mic button (FR-001). */
  async start(): Promise<void> {
    this.emitMachine("START");
    for (const provider of this.providers) {
      await provider.connect();
    }
  }

  /**
   * Connect providers without entering LISTENING (used on mount so typed chat
   * works immediately, FR-011). Idempotent: connecting an already-connected
   * provider is a no-op.
   */
  async connect(): Promise<void> {
    for (const provider of this.providers) {
      await provider.connect();
    }
  }

  /** User submitted a typed message (FR-011 text fallback). */
  sendText(text: string): void {
    if (!text.trim() || this.machine.current === "PROCESSING") return;
    for (const provider of this.providers) {
      provider.sendText(text);
    }
  }

  /** A chunk of mic audio arrived; forward to providers async-current (PRD §32). */
  sendAudio(audio: ArrayBuffer): void {
    for (const provider of this.providers) {
      provider.sendAudio(audio);
    }
  }

  /** Interim mic audio for live partial transcript while still speaking (FR-016). */
  sendPartialAudio(audio: ArrayBuffer): void {
    for (const provider of this.providers) {
      provider.sendPartialAudio?.(audio);
    }
  }

  /** User barged in while AI was speaking (FR-007). */
  interrupt(): void {
    this.interrupted = true;
    // Move out of SPEAKING first, then abort the provider so its "interrupted"
    // event arrives when RESUME/LISTENING is already legal.
    this.emitMachine("INTERRUPT");
    for (const provider of this.providers) {
      provider.interrupt();
    }
  }

  /**
   * Resolve a risky tool call that paused for user confirmation (FR-014).
   * `allow` true runs it; false declines it.
   */
  confirmTool(callId: string, allow: boolean): void {
    for (const provider of this.providers) {
      provider.confirmTool?.(callId, allow);
    }
  }

  private handleProviderEvent(provider: AIProvider, event: ProviderEvent): void {
    switch (event.type) {
      case "connected":
        if (this.machine.current === "LISTENING") break;
        // If still IDLE, the user's audio might arrive before connect resolves.
        break;

      case "partial_transcript":
        if (this.machine.current !== "LISTENING") break;
        if (this.activeUserEntry?.state === "final") this.activeUserEntry = null;
        if (!this.activeUserEntry) {
          this.activeUserEntry = {
            id: nextId("msg"),
            role: "user",
            text: "",
            state: "partial",
          };
          this.transcripts.push(this.activeUserEntry);
          this.emit({ type: "transcript", entry: this.activeUserEntry });
        }
        this.activeUserEntry.text = event.transcript;
        this.emit({ type: "transcript", entry: this.activeUserEntry });
        this.emitMachine("SPEECH_STARTED");
        break;

      case "final_transcript":
        this.interrupted = false;
        this.turnAudioComplete = false;
        if (!this.activeUserEntry) {
          this.activeUserEntry = { id: nextId("msg"), role: "user", text: event.transcript, state: "final" };
          this.transcripts.push(this.activeUserEntry);
        }
        this.activeUserEntry.text = event.transcript;
        this.activeUserEntry.state = "final";
        this.emit({ type: "transcript", entry: this.activeUserEntry });
        this.pushMessage({ role: "user", content: event.transcript });
        this.emitMachine("SPEECH_ENDED");
        break;

      case "text_delta":
        // Drop stale generation that slipped past the abort (invariant 3).
        if (this.interrupted) break;
        if (!this.activeAssistantEntry) {
          this.activeAssistantEntry = {
            id: nextId("msg"),
            role: "assistant",
            text: "",
            state: "partial",
          };
          this.transcripts.push(this.activeAssistantEntry);
        }
        this.activeAssistantEntry.text += event.text;
        this.emit({ type: "transcript", entry: this.activeAssistantEntry });
        break;

      case "text_complete":
        if (this.interrupted) {
          this.activeAssistantEntry = null;
          this.interrupted = false;
          this.emitMachine("RESUME");
          break;
        }
        if (!this.activeAssistantEntry) break;
        this.activeAssistantEntry.text = event.text;
        this.activeAssistantEntry.state = "final";
        this.emit({ type: "transcript", entry: this.activeAssistantEntry });
        this.pushMessage({ role: "assistant", content: event.text });
        this.activeAssistantEntry = null;
        this.activeUserEntry = null;
        this.emitMachine("RESPONSE_READY");
        break;

      case "audio_complete":
        // All audio for this turn was handed to the player. The turn ends only
        // when playback has actually drained (finishTurn is called by the UI),
        // so long answers never re-open LISTENING while still speaking.
        this.turnAudioComplete = true;
        break;

      case "tool_confirmation_required":
        // Stay in PROCESSING while we await the user's confirm/deny (FR-014);
        // the UI surfaces the pending calls and replies via confirmTool().
        this.emit({ type: "tool_confirmation", calls: event.calls });
        break;

      case "interrupted":
        // Provider aborted the current generation. Discard any partial
        // assistant output and go back to listening (PRD §10, FR-007).
        this.activeAssistantEntry = null;
        this.emitMachine("RESUME");
        break;

      case "error":
        this.emit({ type: "error", message: event.message });
        this.emitMachine("ERROR");
        break;
    }
  }

  private emitMachine(event: StateEvent): void {
    const next = this.machine.transition(event);
    if (next) this.emit({ type: "state", state: next });
  }

  private emit(event: ConversationEvent): void {
    for (const fn of this.listeners) fn(event);
  }

  private pushMessage(message: ConversationMessage): void {
    this.messages.push(message);
    // Keep the context window bounded (PRD FR-008 / latency budget).
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(-this.maxMessages);
    }
  }
}