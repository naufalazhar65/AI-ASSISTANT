"use client";

import FloatingParticles from "@/components/FloatingParticles";
import { LiveVoicePanel } from "@/components/ui/voice/LiveVoicePanel";
import { useVoice } from "@/hooks/useVoice";

/**
 * Web surface: LIVE VOICE ONLY.
 *
 * The owner runs text conversations on Discord and Telegram, and the duplex
 * voice session (Gemini Live: speech-to-speech with persona, memory and tool
 * calling) is the only pipeline the browser drives. The old Groq turn-based
 * console (record -> ASR -> LLM -> TTS, provider dropdown included) was
 * removed 2026-09-30: one pipeline, no mode switch, nothing to misconfigure.
 * `useVoice` is still used, but only as the shared-mic owner (the stream the
 * orb visualises and the Live session taps) — never as a conversation
 * pipeline.
 */
export default function Home() {
  const { micState, mediaStream, ensureMic, releaseMic } = useVoice();

  return (
    <main className="relative h-dvh w-full flex flex-col overflow-hidden bg-black safe-top safe-bottom">
      {/* Animated gradient background */}
      <div className="absolute inset-0 bg-gradient-to-br from-gray-950 via-black to-gray-950 animate-gradient-shift" aria-hidden />

      {/* Floating particles */}
      <FloatingParticles />

      {/* Top glow */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 h-48 w-96 rounded-full bg-primary/5 blur-[120px]" aria-hidden />

      {/* Voice console fills the whole viewport (header removed 2026-09-30:
          single owner, Live-only — nothing left to navigate, brand or show) */}
      <div className="relative z-10 flex-1 min-h-0">
        <LiveVoicePanel
          mediaStream={mediaStream}
          micDenied={micState.status === "denied"}
          onEnsureMic={ensureMic}
          onReleaseMic={releaseMic}
        />
      </div>
    </main>
  );
}
