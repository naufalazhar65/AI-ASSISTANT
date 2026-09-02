"use client";

import { Sparkles } from "lucide-react";
import FloatingParticles from "@/components/FloatingParticles";
import SignInForm, { useAuth } from "@/components/SignInForm";
import AIChatCard from "@/components/ui/ai-chat";
import { VoicePoweredOrb } from "@/components/ui/voice-powered-orb";
import { useVoice } from "@/hooks/useVoice";

const STATE_LABELS: Record<string, string> = {
  IDLE: "Ready",
  LISTENING: "Listening…",
  PROCESSING: "Thinking…",
  SPEAKING: "Speaking…",
  INTERRUPTED: "Interrupted",
  ERROR: "Error",
  RECONNECTING: "Reconnecting…",
};

const STATE_HUES: Record<string, number> = {
  IDLE: 220,
  LISTENING: 140,
  PROCESSING: 35,
  SPEAKING: 200,
  INTERRUPTED: 345,
  ERROR: 0,
  RECONNECTING: 280,
};

export default function Home() {
  const { user, signIn, signOut } = useAuth();

  const {
    state,
    micState,
    transcripts,
    isMicrophoneActive,
    useRealProvider,
    voiceOutput,
    toggleVoiceOutput,
    voice,
    setVoice,
    model,
    setModel,
    provider,
    setProvider,
    providers,
    pendingConfirmation,
    lastError,
    confirmTool,
    denyTool,
    toggleMic,
    sendText,
    interrupt,
  } = useVoice();

  if (!user) {
    return <SignInForm onSignIn={signIn} />;
  }

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-black">
      {/* Animated gradient background */}
      <div className="absolute inset-0 bg-gradient-to-br from-gray-950 via-black to-gray-950 animate-gradient-shift" />

      {/* Floating particles */}
      <FloatingParticles />

      {/* Top glow */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 h-48 w-96 rounded-full bg-primary/5 blur-[120px]" />

      {/* Header - pinned top */}
      <header className="absolute top-0 inset-x-0 z-20 flex w-full items-center justify-between px-4 py-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/5 border border-white/10">
            <Sparkles className="h-4 w-4 text-white/60" />
          </div>
          <h1 className="text-lg font-bold tracking-tight text-white/90">Voice AI</h1>
        </div>

        <div className="flex items-center gap-3">
          {useRealProvider ? (
            <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-medium text-emerald-400">
              live · Groq
            </span>
          ) : (
            <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] font-medium text-white/40">
              mock
            </span>
          )}
          <span className="text-xs text-white/40">Hi, {user}</span>
          <button
            type="button"
            onClick={signOut}
            className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/40 transition-all duration-300 hover:border-white/20 hover:bg-white/10 hover:text-white/60"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Center: chat card fills height between header and bottom */}
      <div className="absolute inset-0 z-10 flex flex-col items-center px-4 pt-16 pb-3">
        <AIChatCard
          className="shadow-2xl"
          messages={transcripts.map((t) => ({
            sender: t.role === "user" ? "user" : "ai",
            text: t.text,
            partial: t.state === "partial",
          }))}
          isTyping={state === "PROCESSING"}
          onSend={(text) => sendText(text)}
          orb={
            <>
              <div className="h-24 w-24">
                <VoicePoweredOrb
                  enableVoiceControl={isMicrophoneActive}
                  hue={STATE_HUES[state]}
                  voiceSensitivity={1.5}
                  className="h-full w-full"
                />
              </div>
              <span className="text-xs font-medium text-white/40">{STATE_LABELS[state]}</span>
            </>
          }
          micActive={isMicrophoneActive}
          onToggleMic={toggleMic}
          isListening={state === "LISTENING"}
          onInterrupt={interrupt}
          showInterrupt={state === "SPEAKING"}
          voiceOutput={voiceOutput}
          onToggleVoiceOutput={toggleVoiceOutput}
          voice={voice}
          onVoiceChange={setVoice}
          model={model}
          onModelChange={setModel}
          provider={provider}
          onProviderChange={setProvider}
          providers={providers}
          confirmation={pendingConfirmation}
          lastError={lastError}
          onConfirm={confirmTool}
          onDeny={denyTool}
        />

        {micState.status === "denied" && (
          <p className="mt-4 text-center text-xs text-rose-400/80">
            Microphone access is required. Enable it in your browser settings.
          </p>
        )}
        {useRealProvider && !isMicrophoneActive && micState.status !== "denied" && (
          <p className="mt-4 max-w-sm text-center text-xs text-white/25">
            Start voice, then just talk. The AI listens and answers by voice.
          </p>
        )}
      </div>
    </main>
  );
}
