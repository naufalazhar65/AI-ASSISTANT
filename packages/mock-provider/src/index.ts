import {
  AIProvider,
  ConversationMessage,
  ProviderEventListener,
  ProviderEvent,
} from "@voice/ai-provider";

/**
 * MockProvider — deterministic, no API keys, no network (PRD §35).
 *
 * Used for QA and automated testing without a real model. Turns user turns
 * into canned responses, emitting the same streaming event sequence a real
 * provider would: partial transcript -> final transcript -> text deltas ->
 * text complete.
 */
export class MockProvider implements AIProvider {
  private listeners = new Set<ProviderEventListener>();
  private turnIndex = 0;
  private connected = false;
  private generationId = 0;
  private completions: string[] = [
    "Halo! Saya asisten suara Anda. Silakan bicara, apa yang bisa saya bantu?",
    "Saya mendengar Anda. Ini adalah respons simulasi. Nanti akan diganti oleh provider AI sungguhan.",
    "Interrupt bekerja. Anda bisa menyela kapan saja.",
  ];

  connect(): Promise<void> {
    this.connected = true;
    this.emit({ type: "connected" });
    return Promise.resolve();
  }

  disconnect(): void {
    this.connected = false;
    this.emit({ type: "disconnected" });
  }

  sendAudio(_audio: ArrayBuffer): void {
    // No real ASR in mock mode: simulate a canned user turn.
    this.simulateUserTurn();
  }

  sendText(text: string): void {
    // Text fallback (PRD FR-011): treat typed text as a normal user turn.
    if (!text.trim()) return;
    this.emit({ type: "final_transcript", transcript: text });
    this.simulateAssistantTurn();
  }

  interrupt(): void {
    // Abort the current generation so old streaming never reaches the UI
    // after a barge-in (PRD FR-007 / invariant 3).
    this.generationId += 1;
    this.emit({ type: "interrupted" });
  }

  on(fn: ProviderEventListener): void {
    this.listeners.add(fn);
  }

  off(fn: ProviderEventListener): void {
    this.listeners.delete(fn);
  }

  setCompletions(completions: string[]): void {
    this.completions = completions;
  }

  private simulateUserTurn(): void {
    const partial = "Anda sedang berbicara...";
    this.emit({ type: "partial_transcript", transcript: partial });
    this.emit({ type: "final_transcript", transcript: partial });
    this.simulateAssistantTurn();
  }

  private simulateAssistantTurn(): void {
    const text = this.completions[this.turnIndex % this.completions.length];
    this.turnIndex += 1;
    const generation = this.generationId;

    // Stream text in chunks to mimic a real LLM (PRD FR-005).
    let emitted = 0;
    const chunk = 6;
    const interval = setInterval(() => {
      // If interrupted (generation bumped) or disconnected, drop this stream.
      if (!this.connected || this.generationId !== generation) {
        clearInterval(interval);
        return;
      }
      const next = text.slice(emitted, emitted + chunk);
      emitted += chunk;
      if (next) {
        this.emit({ type: "text_delta", text: next });
      }
      if (emitted >= text.length) {
        clearInterval(interval);
        this.emit({ type: "text_complete", text });
        this.emit({ type: "audio_complete" });
      }
    }, 40);
  }

  private emit(event: ProviderEvent): void {
    for (const fn of this.listeners) {
      fn(event);
    }
  }
}