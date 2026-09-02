"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ConversationManager, TranscriptEntry } from "@/ai/ConversationManager";
import { GroqStreamingProvider } from "@/ai/GroqStreamingProvider";
import { AutoTurnManager } from "@/ai/AutoTurnManager";
import { AudioCapture, AudioCaptureState } from "@/audio/AudioCapture";
import { AudioPlayer } from "@/audio/AudioPlayer";
import { AIProvider, ConfirmationRequest, ProviderEvent } from "@voice/ai-provider";
import { State } from "@voice/state-machine";
import { MockProvider } from "@ai-provider/mock";
import { PUBLIC_PROVIDERS, ProviderId } from "@/lib/providers";

export interface UseVoiceResult {
  state: State;
  micState: AudioCaptureState;
  transcripts: TranscriptEntry[];
  isMicrophoneActive: boolean;
  isRecording: boolean;
  useRealProvider: boolean;
  voiceOutput: boolean;
  toggleVoiceOutput: () => void;
  voice: string;
  setVoice: (voice: string) => void;
  model: string | undefined;
  setModel: (model: string | undefined) => void;
  provider: string;
  setProvider: (provider: string) => void;
  providers: { id: string; label: string; models: string[] }[];
  pendingConfirmation: ConfirmationRequest[] | null;
  lastError: string | null;
  confirmTool: (callId: string) => void;
  denyTool: (callId: string) => void;
  start: () => Promise<void>;
  stop: () => void;
  toggleMic: () => Promise<void>;
  sendText: (text: string) => void;
  interrupt: () => void;
}

type SerializedConversation = ReturnType<ConversationManager["serialize"]>;

const HISTORY_KEY_PREFIX = "voice-ai.history";
const SETTINGS_KEY = "voice-ai.settings";

interface PersistedSettings {
  provider?: string;
  model?: string;
  voice?: string;
}

function loadSettings(): PersistedSettings | null {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedSettings;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function saveSettings(settings: PersistedSettings): void {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Best-effort: storage failures must not break the conversation.
  }
}

function historyUser(): string | null {
  try {
    return window.localStorage.getItem("voice-ai.user");
  } catch {
    return null;
  }
}

function loadHistory(user: string): SerializedConversation | null {
  try {
    const raw = window.localStorage.getItem(`${HISTORY_KEY_PREFIX}.${user}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SerializedConversation;
    return Array.isArray(parsed.transcripts) ? parsed : null;
  } catch {
    return null;
  }
}

function saveHistory(user: string, conversation: SerializedConversation): void {
  try {
    window.localStorage.setItem(`${HISTORY_KEY_PREFIX}.${user}`, JSON.stringify(conversation));
  } catch {
    // Persistence is best-effort: a full/unavailable storage must not break the conversation.
  }
}

export function useVoice(): UseVoiceResult {
  const managerRef = useRef<ConversationManager | null>(null);
  const captureRef = useRef<AudioCapture | null>(null);
  const playerRef = useRef<AudioPlayer | null>(null);
  const autoTurnRef = useRef<AutoTurnManager | null>(null);

  const [state, setState] = useState<State>("IDLE");
  const [micState, setMicState] = useState<AudioCaptureState>({ status: "idle" });
  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([]);
  const [voiceOutput, setVoiceOutput] = useState(true);
  const [pendingConfirmation, setPendingConfirmation] = useState<ConfirmationRequest[] | null>(null);
  const [voice, setVoiceState] = useState<string>(() => loadSettings()?.voice ?? "hannah");
  const [model, setModelState] = useState<string | undefined>(() => loadSettings()?.model);
  const [provider, setProviderState] = useState<string>(() => loadSettings()?.provider ?? "groq");
  const [lastError, setLastError] = useState<string | null>(null);
  const voiceOutputRef = useRef(true);
  const hadAudioRef = useRef(false);

  const toggleVoiceOutput = useCallback(() => {
    setVoiceOutput((prev) => {
      voiceOutputRef.current = !prev;
      return !prev;
    });
  }, []);

  const providerRef = useRef<AIProvider | null>(null);
  if (!providerRef.current) {
    providerRef.current =
      process.env.NEXT_PUBLIC_AI_PROVIDER === "groq" ? new GroqStreamingProvider() : new MockProvider();
  }
  const providerInstance = providerRef.current;

  const setVoice = useCallback(
    (v: string) => {
      setVoiceState(v);
      const p = providerRef.current;
      if (p instanceof GroqStreamingProvider) p.setTtsSettings(v);
    },
    []
  );

  const setModel = useCallback((m: string | undefined) => {
    setModelState(m);
    const p = providerRef.current;
    if (p instanceof GroqStreamingProvider) p.setModel(m);
  }, []);

  const setProvider = useCallback((id: string) => {
    setProviderState(id);
    const p = providerRef.current;
    if (p instanceof GroqStreamingProvider) p.setProvider(id);
    // Model is provider-specific; reset to its default when switching.
    setModelState(undefined);
    if (p instanceof GroqStreamingProvider) p.setModel(undefined);
  }, []);

  // Persist settings and sync the hydrated values onto the provider instance.
  useEffect(() => {
    saveSettings({ provider, model, voice });
    const p = providerRef.current;
    if (p instanceof GroqStreamingProvider) {
      p.setProvider(provider);
      p.setModel(model);
      p.setTtsSettings(voice);
    }
  }, [provider, model, voice]);

  if (!managerRef.current) managerRef.current = new ConversationManager([providerInstance]);
  if (!captureRef.current) captureRef.current = new AudioCapture();
  if (!playerRef.current) {
    playerRef.current = new AudioPlayer();
    playerRef.current.onDrained = () => managerRef.current?.finishTurn();
  }
  if (!autoTurnRef.current) {
    autoTurnRef.current = new AutoTurnManager(
      captureRef.current,
      (blob) => {
        void (async () => {
          const buffer = await blob.arrayBuffer();
          managerRef.current?.sendAudio(buffer);
        })();
      },
      (blob) => {
        void (async () => {
          const buffer = await blob.arrayBuffer();
          managerRef.current?.sendPartialAudio(buffer);
        })();
      },
      () => managerRef.current?.interrupt()
    );
  }
  const manager = managerRef.current;
  const capture = captureRef.current;
  const player = playerRef.current;
  const autoTurn = autoTurnRef.current;

  // Keep provider state transitions driving the VAD loop.
  const onProvider = useCallback(
    (event: ProviderEvent) => {
      if (event.type === "final_transcript") {
        hadAudioRef.current = false; // Start of a new turn.
      } else if (event.type === "error") {
        setLastError(event.message ?? "Assistant failed");
      } else if (event.type === "text_delta") {
        // Any streaming text clears a previous error so stale failures don't linger.
        setLastError(null);
      } else if (event.type === "audio_delta") {
        // In text-to-text mode, ignore AI audio entirely: the assistant's
        // answer is shown on screen only.
        if (!voiceOutputRef.current) return;
        hadAudioRef.current = true;
        void player.enqueue(event.audio.slice().buffer);
      } else if (event.type === "interrupted") {
        hadAudioRef.current = false;
        player.stop();
      } else if (event.type === "audio_complete") {
        // Text-only replies (or text-to-text mode) produce no played audio:
        // end the turn immediately. When audio exists, onDrained -> finishTurn
        // after playback finishes.
        if (!hadAudioRef.current) managerRef.current?.finishTurn();
      }
    },
    [player]
  );

  useEffect(() => {
    const onConv = (event: { type: string; state?: State; entry?: TranscriptEntry; calls?: ConfirmationRequest[] }) => {
      if (event.type === "state") {
        setState(event.state!);
        // Listen only when we're actually listening: prevents the assistant
        // from hearing its own voice (echo/feedback doubling).
        if (event.state === "LISTENING") autoTurn.start();
        else if (event.state === "SPEAKING") autoTurn.armBargeIn();
        else if (event.state === "PROCESSING" || event.state === "INTERRUPTED") autoTurn.stop();
      }
      if (event.type === "transcript") {
        setTranscripts(manager.history);
        const user = historyUser();
        if (user) saveHistory(user, manager.serialize());
      }
      if (event.type === "tool_confirmation") {
        setPendingConfirmation(event.calls ?? null);
      }
    };
    const onMic = (s: AudioCaptureState) => {
      setMicState(s);
      if (s.status === "idle" || s.status === "denied" || s.status === "error") autoTurn.stop();
    };

    manager.on(onConv);
    capture.on(onMic);
    providerInstance.on(onProvider);
    return () => {
      manager.off(onConv);
      capture.off(onMic);
      providerInstance.off(onProvider);
    };
  }, [manager, capture, providerInstance, autoTurn, onProvider]);

  useEffect(() => {
    const user = historyUser();
    const saved = user ? loadHistory(user) : null;
    if (saved && saved.transcripts.some((t) => t.state === "final")) {
      manager.restoreHistory(saved.transcripts);
    }
  }, [manager]);

  // Connect the provider eagerly on mount so typed chat works immediately,
  // independently of the microphone (FR-011 text fallback). This does not
  // enter LISTENING; mic capture later reuses the connected provider.
  useEffect(() => {
    void manager.connect();
  }, [manager]);

  const start = useCallback(async () => {
    await capture.start();
    if (capture.isActive()) {
      await manager.start();
      autoTurn.start();
    }
  }, [capture, manager, autoTurn]);

  const stop = useCallback(() => {
    autoTurn.stop();
    capture.stop();
    player.stop();
  }, [autoTurn, capture, player]);

  const toggleMic = useCallback(async () => {
    if (capture.isActive()) {
      autoTurn.stop();
      capture.stop();
      player.stop();
    } else {
      await start();
    }
  }, [capture, autoTurn, player, start]);

  const sendText = useCallback(
    (text: string) => {
      manager.sendText(text);
    },
    [manager]
  );

  const interrupt = useCallback(() => {
    manager.interrupt();
  }, [manager]);

  const confirmTool = useCallback(
    (callId: string) => {
      setPendingConfirmation(null);
      manager.confirmTool(callId, true);
    },
    [manager]
  );

  const denyTool = useCallback(
    (callId: string) => {
      setPendingConfirmation(null);
      manager.confirmTool(callId, false);
    },
    [manager]
  );

  const isMicrophoneActive = micState.status === "active";
  const isRecording = micState.status === "active" && state !== "IDLE";

  return {
    state,
    micState,
    transcripts,
    isMicrophoneActive,
    isRecording,
    useRealProvider: process.env.NEXT_PUBLIC_AI_PROVIDER === "groq",
    voiceOutput,
    toggleVoiceOutput,
    voice,
    setVoice,
    model,
    setModel,
    provider,
    setProvider,
    providers: PUBLIC_PROVIDERS,
    pendingConfirmation,
    lastError,
    confirmTool,
    denyTool,
    start,
    stop,
    toggleMic,
    sendText,
    interrupt,
  };
}