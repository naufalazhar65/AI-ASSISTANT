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
import { findPublicProvider, PUBLIC_PROVIDERS, ProviderId, PUBLIC_DEFAULT_PROVIDER } from "@/lib/providers";
import { SessionMeta } from "@/lib/sessions";

export interface UseVoiceResult {
  state: State;
  micState: AudioCaptureState;
  transcripts: TranscriptEntry[];
  isMicrophoneActive: boolean;
  isRecording: boolean;
  mediaStream: MediaStream | null;
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
  reminders: string[];
  dismissReminder: (index: number) => void;
  sessions: SessionMeta[];
  currentSessionId: string | null;
  switchSession: (id: string) => Promise<void>;
  newSession: () => void;
  deleteSession: (id: string) => Promise<void>;
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

/**
 * Reconcile a persisted model with the active provider's allowed models.
 * A model that doesn't belong to the current provider (e.g. a stale "open-code"
 * saved while on OpenCode, then used with Groq) would make the Groq route 404
 * and leave the typing bubble stuck forever. Returning undefined (Auto) when
 * the model is not valid for the provider prevents that by construction, using
 * the same PUBLIC_PROVIDERS list the Settings dropdown reads.
 */
function reconcileModel(provider: string, model: string | undefined): string | undefined {
  if (model == null) return undefined;
  const spec = findPublicProvider(provider);
  if (!spec) return undefined;
  return spec.models.includes(model) ? model : undefined;
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

// --- Multi-session (server-side, per-user) API helpers ---

async function apiListSessions(user: string): Promise<SessionMeta[]> {
  const res = await fetch(`/api/sessions?user=${encodeURIComponent(user)}`);
  if (!res.ok) return [];
  const data = (await res.json()) as { sessions?: SessionMeta[] };
  return Array.isArray(data.sessions) ? data.sessions : [];
}

async function apiLoadSession(user: string, id: string): Promise<SerializedConversation | null> {
  const res = await fetch(`/api/sessions?user=${encodeURIComponent(user)}&id=${encodeURIComponent(id)}`);
  if (!res.ok) return null;
  const data = (await res.json()) as { session?: { conversation?: SerializedConversation } };
  return data.session?.conversation ?? null;
}

async function apiUpsertSession(
  user: string,
  sessionId: string | null,
  conversation: SerializedConversation,
  title?: string
): Promise<string | null> {
  const res = await fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user, session_id: sessionId, conversation, title }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { id?: string };
  return typeof data.id === "string" ? data.id : null;
}

async function apiDeleteSession(user: string, id: string): Promise<void> {
  await fetch("/api/sessions", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user, session_id: id }),
  });
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
  const [provider, setProviderState] = useState<string>(() => loadSettings()?.provider ?? PUBLIC_DEFAULT_PROVIDER);
  const [model, setModelState] = useState<string | undefined>(() => {
    const s = loadSettings();
    // Only keep a persisted model if it is valid for the persisted provider
    // (stale models from another provider would make the LLM route 404).
    return reconcileModel(s?.provider ?? PUBLIC_DEFAULT_PROVIDER, s?.model);
  });
  const [lastError, setLastError] = useState<string | null>(null);
  const voiceOutputRef = useRef(true);
  const hadAudioRef = useRef(false);
  const [reminders, setReminders] = useState<string[]>([]);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const currentSessionIdRef = useRef<string | null>(null);

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
    const reconciled = reconcileModel(provider, model);
    saveSettings({ provider, model: reconciled, voice });
    const p = providerRef.current;
    if (p instanceof GroqStreamingProvider) {
      p.setProvider(provider);
      p.setModel(reconciled);
      p.setTtsSettings(voice);
      p.setUser(historyUser() ?? undefined);
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

  // Load the user's saved multi-sessions on mount, restoring the most recent
  // one so they resume where they left off (OpenClaw multi-session).
  useEffect(() => {
    const user = historyUser();
    if (!user) return;
    void (async () => {
      const list = await apiListSessions(user);
      setSessions(list);
      const latest = list[0];
      if (latest) {
        const conv = await apiLoadSession(user, latest.id);
        setCurrentSessionId(latest.id);
        if (conv && conv.transcripts.some((t) => t.state === "final")) {
          manager.restoreHistory(conv.transcripts);
          setTranscripts(manager.history);
        }
      }
    })();
  }, [manager]);

  // Connect the provider eagerly on mount so typed chat works immediately,
  // independently of the microphone (FR-011 text fallback). This does not
  // enter LISTENING; mic capture later reuses the connected provider.
  useEffect(() => {
    void manager.connect();
  }, [manager]);

  // Scheduler & reminders (OpenClaw): open an SSE stream that pushes due
  // reminders for this user, including any that came due while the tab was
  // closed (the server replays them on connect). Cap the visible queue so a
  // flood of overdue reminders cannot grow unbounded.
  useEffect(() => {
    const user = historyUser();
    if (!user) return;
    const es = new EventSource(`/api/reminders/stream?user=${encodeURIComponent(user)}`);
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as { id?: string; text?: string };
        if (typeof data.text === "string" && data.text.trim()) {
          setReminders((prev) => [...prev, data.text!.trim()].slice(-5));
        }
      } catch {
        /* ignore malformed frames */
      }
    };
    return () => es.close();
  }, []);

  const dismissReminder = useCallback((index: number) => {
    setReminders((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // --- Multi-session management ---

  // Persist the current conversation to whichever session is active. Safe to
  // call on every transcript event; upsert is cheap and idempotent.
  const autosave = useCallback(
    async (sessionId: string | null): Promise<string | null> => {
      const user = historyUser();
      if (!user) return sessionId;
      const saved = await apiUpsertSession(user, sessionId, manager.serialize());
      if (saved && saved !== sessionId) setCurrentSessionId(saved);
      return saved;
    },
    [manager]
  );

  const refreshSessions = useCallback(async () => {
    const user = historyUser();
    if (!user) return;
    setSessions(await apiListSessions(user));
  }, []);

  const switchSession = useCallback(
    async (id: string) => {
      const user = historyUser();
      if (!user) return;
      // Persist the outgoing session first, then load the incoming one.
      await autosave(currentSessionId);
      const conversation = await apiLoadSession(user, id);
      setCurrentSessionId(id);
      if (conversation) manager.restoreHistory(conversation.transcripts);
      setTranscripts(manager.history);
      await refreshSessions();
    },
    [currentSessionId, autosave, manager, refreshSessions]
  );

  const newSession = useCallback(() => {
    void autosave(currentSessionId);
    manager.restoreHistory([]);
    setTranscripts([]);
    setCurrentSessionId(null);
    void refreshSessions();
  }, [autosave, currentSessionId, manager, refreshSessions]);

  const deleteSession = useCallback(
    async (id: string) => {
      const user = historyUser();
      if (!user) return;
      await apiDeleteSession(user, id);
      if (currentSessionId === id) {
        manager.restoreHistory([]);
        setTranscripts([]);
        setCurrentSessionId(null);
      }
      await refreshSessions();
    },
    [currentSessionId, manager, refreshSessions]
  );

  // Autosave the active session after a turn advances (debounced), so a reload
  // between turns leaves nothing unsaved. `autosave` is cheap + idempotent.
  // A brand-new chat (currentSessionId === null) is autosaved once it has real
  // content, which creates its session server-side (multi-session resume).
  useEffect(() => {
    const user = historyUser();
    const hasContent = transcripts.some((t) => t.state === "final");
    if (!user) return;
    if (currentSessionId === null && !hasContent) return;
    const t = setTimeout(() => {
      void autosave(currentSessionId);
    }, 1500);
    return () => clearTimeout(t);
  }, [currentSessionId, autosave, transcripts]);

  const start = useCallback(async () => {
    await capture.start();
    if (capture.isActive()) {
      await manager.start();
      autoTurn.start();
    }
  }, [capture, manager, autoTurn]);

  const stop = useCallback(async () => {
    autoTurn.stop();
    await capture.stop();
    player.stop();
  }, [autoTurn, capture, player]);

  const toggleMic = useCallback(async () => {
    const active = micState.status === "active";
    if (active) {
      autoTurn.stop();
      await capture.stop();
      player.stop();
    } else {
      await start();
    }
  }, [micState.status, capture, autoTurn, player, start]);

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
  const mediaStream = isMicrophoneActive ? capture.mediaStream : null;

  return {
    state,
    micState,
    transcripts,
    isMicrophoneActive,
    isRecording,
    mediaStream,
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
    reminders,
    dismissReminder,
    sessions,
    currentSessionId,
    switchSession,
    newSession,
    deleteSession,
    start,
    stop,
    toggleMic,
    sendText,
    interrupt,
  };
}