"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  Bell,
  Mic,
  MicOff,
  Settings2,
  Square,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { VoicePoweredOrb } from "@/components/ui/voice-powered-orb";
import { ConfirmBar } from "./ConfirmBar";
import { SettingsPanel } from "./SettingsPanel";
import type { ChatProviderOption } from "./types";
import type { ConfirmationRequest } from "@voice/ai-provider";

/**
 * Orb hue per state. Kept as data so the console, the orb and any future
 * surface read the same mapping instead of each inventing its own colour.
 */
const STATE_HUES: Record<string, number> = {
  IDLE: 220,
  LISTENING: 140,
  PROCESSING: 35,
  SPEAKING: 200,
  INTERRUPTED: 345,
  ERROR: 0,
  RECONNECTING: 280,
};

/** One short line of status under the orb, per state. */
const STATE_LABELS: Record<string, string> = {
  IDLE: "Siap dengerin",
  LISTENING: "Mendengerin...",
  PROCESSING: "Mikir...",
  SPEAKING: "Bicara...",
  TURN_END: "Siap dengerin",
  INTERRUPTED: "Kamu potong aku",
  ERROR: "Ada kendala",
  RECONNECTING: "Menyambung ulang...",
};

/** Tailwind text colour per state, so the status line matches the orb. */
const STATE_TEXT: Record<string, string> = {
  IDLE: "text-white/40",
  LISTENING: "text-emerald-400/90",
  PROCESSING: "text-amber-400/90",
  SPEAKING: "text-sky-400/90",
  TURN_END: "text-white/40",
  INTERRUPTED: "text-rose-400/90",
  ERROR: "text-rose-400/90",
  RECONNECTING: "text-violet-400/90",
};

interface VoiceConsoleProps {
  /** Current conversation state, used for the orb hue and the status line. */
  state: string;
  /** True while the hands-free capture loop owns the microphone. */
  micActive: boolean;
  /** The app's single capture stream, handed to the orb so it never opens a second grab. */
  mediaStream: MediaStream | null;
  onToggleMic: () => void;
  onInterrupt: () => void;

  /** Risky tool calls awaiting approval. The pipeline is blocked until answered. */
  confirmation: ConfirmationRequest[] | null;
  onConfirm: (callId: string) => void;
  onDeny: (callId: string) => void;

  /** Provider / model / TTS voice. */
  provider: string;
  onProviderChange: (p: string) => void;
  providers: ChatProviderOption[];
  model: string | undefined;
  onModelChange: (m: string | undefined) => void;
  voice: string;
  onVoiceChange: (v: string) => void;

  /** Last provider error, if any. */
  lastError: string | null;
  /** Due reminders pushed by the scheduler. */
  reminders: string[];
  onDismissReminder: (i: number) => void;
  /** `denied` means the browser refused microphone access. */
  micDenied: boolean;
}

/**
 * The web app is voice-only: an orb, a mic control, and the two affordances the
 * pipeline cannot work without (tool approval and provider settings). There is
 * deliberately no transcript, no composer and no session switcher — the owner
 * runs text on Discord and Telegram, where the transcript belongs.
 *
 * The approval bar is NOT chat and cannot be removed: a risky tool call blocks
 * the turn until the user answers, and the web pipeline has no spoken-reply
 * path for that (only the Discord and Telegram adapters parse "ya"/"tidak"), so
 * deleting the bar would deadlock the assistant with no way out.
 */
export function VoiceConsole({
  state,
  micActive,
  mediaStream,
  onToggleMic,
  onInterrupt,
  confirmation,
  onConfirm,
  onDeny,
  provider,
  onProviderChange,
  providers,
  model,
  onModelChange,
  voice,
  onVoiceChange,
  lastError,
  reminders,
  onDismissReminder,
  micDenied,
}: VoiceConsoleProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const speaking = state === "SPEAKING";
  const label = STATE_LABELS[state] ?? STATE_LABELS.IDLE;

  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center gap-8 px-4">
      {/* Orb + status */}
      <div className="flex flex-col items-center gap-5">
        <motion.div
          initial={{ opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ type: "spring", stiffness: 220, damping: 26 }}
          className="relative h-[min(58vmin,22rem)] w-[min(58vmin,22rem)]"
        >
          <VoicePoweredOrb
            enableVoiceControl={micActive}
            stream={mediaStream}
            hue={STATE_HUES[state]}
            voiceSensitivity={1.5}
            className="h-full w-full"
          />
        </motion.div>

        <div className="flex h-6 items-center gap-2" aria-live="polite">
          {state === "LISTENING" && (
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" aria-hidden />
          )}
          <span className={cn("text-sm font-medium", STATE_TEXT[state] ?? STATE_TEXT.IDLE)}>{label}</span>
        </div>
      </div>

      {/* Mic + interrupt */}
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={onToggleMic}
          disabled={micDenied}
          aria-label={micActive ? "Stop microphone" : "Start microphone"}
          className={cn(
            "flex h-20 w-20 items-center justify-center rounded-full border transition-all duration-300 disabled:opacity-40",
            micActive
              ? "border-rose-400/40 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25"
              : "border-emerald-400/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
          )}
        >
          {micActive ? <MicOff className="h-8 w-8" /> : <Mic className="h-8 w-8" />}
        </button>

        {speaking && (
          <button
            type="button"
            onClick={onInterrupt}
            aria-label="Interrupt Mia"
            className="flex h-12 w-12 items-center justify-center rounded-full border border-white/15 bg-white/5 text-white/70 transition-all duration-300 hover:bg-white/10 hover:text-white"
          >
            <Square className="h-5 w-5" />
          </button>
        )}
      </div>

      {/* Blocking tool approval */}
      <div className="w-full max-w-md">
        <ConfirmBar calls={confirmation} onConfirm={onConfirm} onDeny={onDeny} />
      </div>

      {/* Reminders + errors */}
      <div className="flex w-full max-w-md flex-col gap-2">
        {reminders.map((r, i) => (
          <div
            key={`${i}-${r}`}
            className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100/90"
          >
            <Bell className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
            <span className="flex-1 break-words">{r}</span>
            <button
              type="button"
              onClick={() => onDismissReminder(i)}
              aria-label="Dismiss reminder"
              className="text-amber-200/50 transition-colors hover:text-amber-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}

        {lastError && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-100/90"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-300" />
            <span className="break-words">{lastError}</span>
          </div>
        )}

        {micDenied && (
          <p className="text-center text-xs text-rose-400/80">
            Microphone access is required. Enable it in your browser settings.
          </p>
        )}
        {!micDenied && !micActive && !lastError && reminders.length === 0 && (
          <p className="text-center text-xs text-white/25">
            Tekan mic, lalu ngobrol. Aku dengerin dan jawab dengan suara.
          </p>
        )}
      </div>

      {/* Settings: the only way to change brain / TTS voice without a chat box */}
      <div className="absolute right-0 top-0">
        <button
          type="button"
          onClick={() => setSettingsOpen((v) => !v)}
          aria-label="Settings"
          aria-expanded={settingsOpen}
          className="rounded-full border border-white/10 bg-white/5 p-2 text-white/50 transition-all duration-300 hover:border-white/20 hover:bg-white/10 hover:text-white/80"
        >
          <Settings2 className="h-4 w-4" />
        </button>

        {settingsOpen && (
          <div className="absolute right-0 top-11 z-30 w-72 max-h-[min(26rem,70vh)] overflow-y-auto overscroll-contain rounded-2xl border border-white/10 bg-gray-950/95 p-3 shadow-2xl backdrop-blur-xl">
            <SettingsPanel
              voice={voice}
              onVoiceChange={onVoiceChange}
              provider={provider}
              onProviderChange={onProviderChange}
              providers={providers}
              model={model}
              onModelChange={onModelChange}
              onClose={() => setSettingsOpen(false)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
