/**
 * AI Provider abstraction (PRD §12, §35).
 *
 * UI and audio layers must NEVER couple to a specific provider. Everything a
 * real-time voice assistant needs from any vendor (Realtime API, Deepgram +
 * GPT + ElevenLabs, a local mock, ...) is expressed through this interface.
 */

/** Role of a message in conversation context (PRD §7.2). */
export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ConversationMessage {
  role: MessageRole;
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Result of sending audio/text into the provider. */
export type SendResult =
  | { type: "partial"; transcript: string }
  | { type: "final"; transcript: string }
  | { type: "response"; text: string }
  | { type: "tool_call"; tool: string; arguments: Record<string, unknown> }
  | { type: "error"; message: string };

/** A tool call proposed by the model that needs user confirmation (FR-014). */
export interface ConfirmationRequest {
  id: string;
  name: string;
  arguments: string;
}

/** Incoming provider events, consumed by the UI/audio layer. */
export type ProviderEvent =
  | { type: "connected" }
  | { type: "disconnected" }
  | { type: "partial_transcript"; transcript: string }
  | { type: "final_transcript"; transcript: string }
  | { type: "text_delta"; text: string }
  | { type: "text_complete"; text: string }
  | { type: "audio_delta"; audio: Uint8Array; sampleRate: number }
  | { type: "audio_complete" }
  | { type: "interrupted" }
  | { type: "tool_confirmation_required"; calls: ConfirmationRequest[] }
  | { type: "error"; message: string };

export type ProviderEventListener = (event: ProviderEvent) => void;

/**
 * A real-time conversation provider.
 *
 * Implementations: RealtimeProvider (vendor WebRTC/WS), StreamingProvider
 * (separate ASR+LLM+TTS), MockProvider (deterministic, for testing — PRD §35).
 */
export interface AIProvider {
  connect(): Promise<void>;
  sendAudio(audio: ArrayBuffer): void;
  /** Optional: interim transcription of in-progress utterances (FR-016). */
  sendPartialAudio?(audio: ArrayBuffer): void;
  sendText(text: string): void;
  /**
   * Optional: resolve a tool call paused for user confirmation (FR-014).
   * `allow` true runs the tool; false declines it. Only meaningful after a
   * `tool_confirmation_required` event.
   */
  confirmTool?(callId: string, allow: boolean): void;
  /** Abort current generation/playback (PRD FR-007). */
  interrupt(): void;
  disconnect(): void;
  on(event: ProviderEventListener): void;
  off(event: ProviderEventListener): void;
}

/**
 * A provider that can be driven fully from the client (no real vendor).
 * Must match `AIProvider` events so tests never depend on a live model.
 */
export interface MockProviderLike extends AIProvider {
  setCompletions(completions: string[]): void;
}