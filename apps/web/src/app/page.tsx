"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import FloatingParticles from "@/components/FloatingParticles";
import SignInForm, { useAuth } from "@/components/SignInForm";
import { VoiceConsole } from "@/components/ui/voice/VoiceConsole";
import { LiveVoicePanel } from "@/components/ui/voice/LiveVoicePanel";
import { useVoice } from "@/hooks/useVoice";
import { OWNER_LABEL } from "@/lib/identity";

/**
 * Web surface: VOICE ONLY.
 *
 * The owner runs text conversations on Discord and Telegram, so the browser app
 * deliberately exposes no transcript, no composer and no session switcher. What
 * is left is the orb, the mic control, and the two controls the pipeline cannot
 * run without: tool approval (a risky call blocks the turn until answered) and
 * provider settings.
 */
export default function Home() {
  const { user, signIn, signOut } = useAuth();

  // Which voice pipeline the console is driving. Defaults to the long-standing
  // Groq turn-based path, so the app behaves exactly as before until the owner
  // explicitly opts into the duplex session.
  const [voiceMode, setVoiceMode] = useState<"groq" | "live">("groq");

  const {
    state,
    micState,
    isMicrophoneActive,
    mediaStream,
    ensureMic,
    releaseMic,
    useRealProvider,
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
    reminders,
    dismissReminder,
    toggleMic,
    interrupt,
  } = useVoice();

  if (!user) {
    return <SignInForm onSignIn={signIn} />;
  }

  return (
    <main className="relative h-dvh w-full flex flex-col overflow-hidden bg-black safe-top safe-bottom">
      {/* Animated gradient background */}
      <div className="absolute inset-0 bg-gradient-to-br from-gray-950 via-black to-gray-950 animate-gradient-shift" aria-hidden />

      {/* Floating particles */}
      <FloatingParticles />

      {/* Top glow */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 h-48 w-96 rounded-full bg-primary/5 blur-[120px]" aria-hidden />

      {/* Header - pinned top */}
      <header className="relative z-20 flex w-full items-center justify-between px-4 py-3 shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/5 border border-white/10">
            <Sparkles className="h-4 w-4 text-white/60" />
          </div>
          <h1 className="text-lg font-bold tracking-tight text-white/90">Mia</h1>
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
          <span className="text-xs text-white/40">Hi, {OWNER_LABEL}</span>
          <button
            type="button"
            onClick={signOut}
            className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/40 transition-all duration-300 hover:border-white/20 hover:bg-white/10 hover:text-white/60"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Voice console fills the remaining space */}
      <div className="relative z-10 flex-1 min-h-0">
        {/* Two pipelines, one switch. "Groq" is the turn-based pipeline that
            has always run (record -> ASR -> LLM -> TTS); "Live" is Gemini's
            duplex speech-to-speech session. They share the mic stream and the
            orb, and nothing else. */}
        <div className="absolute right-3 top-3 z-20 flex rounded-full border border-white/10 bg-white/5 p-1 text-xs">
          {(["groq", "live"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setVoiceMode(mode)}
              className={
                mode === voiceMode
                  ? "rounded-full bg-white/15 px-3 py-1 font-medium text-white"
                  : "rounded-full px-3 py-1 text-white/50 transition-colors hover:text-white/80"
              }
            >
              {mode === "groq" ? "Groq" : "Live"}
            </button>
          ))}
        </div>

        {voiceMode === "live" ? (
          <LiveVoicePanel
            mediaStream={mediaStream}
            micDenied={micState.status === "denied"}
            onEnsureMic={ensureMic}
            onReleaseMic={releaseMic}
          />
        ) : (
          <VoiceConsole
            state={state}
            micActive={isMicrophoneActive}
            mediaStream={mediaStream}
            onToggleMic={toggleMic}
            onInterrupt={interrupt}
            confirmation={pendingConfirmation}
            onConfirm={confirmTool}
            onDeny={denyTool}
            provider={provider}
            onProviderChange={setProvider}
            providers={providers}
            model={model}
            onModelChange={setModel}
            voice={voice}
            onVoiceChange={setVoice}
            lastError={lastError}
            reminders={reminders}
            onDismissReminder={dismissReminder}
            micDenied={micState.status === "denied"}
          />
        )}
      </div>
    </main>
  );
}
