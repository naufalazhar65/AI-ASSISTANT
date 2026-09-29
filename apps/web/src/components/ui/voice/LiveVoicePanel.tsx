/**
 * `LiveVoicePanel` — the Gemini Live (duplex) voice surface.
 *
 * This is a SIBLING of `VoiceConsole`, not a mode inside it, and that is
 * deliberate. `VoiceConsole` is bound to `useVoice`, which is bound to
 * `ConversationManager` + `AutoTurnManager` + the Groq pipeline; Live runs its
 * own socket and its own audio graph and does its own turn-taking. Folding one
 * into the other would couple two state machines that share nothing, and a bug
 * in the new path would then break the working pipeline.
 *
 * The orb is REUSED (it already accepts the app's shared `MediaStream`) so the
 * two surfaces look and behave alike; only the surrounding controls differ.
 */

import { useState } from "react";
import { motion } from "framer-motion";
import { Mic, MicOff, Square, Loader2 } from "lucide-react";

import { useGeminiLive } from "@/hooks/useGeminiLive";
import { VoicePoweredOrb } from "@/components/ui/voice-powered-orb";
import { cn } from "@/lib/utils";

interface LiveVoicePanelProps {
  /** The app's single shared capture stream, or null before the mic starts. */
  mediaStream: MediaStream | null;
  /** True when the OS denied the microphone. */
  micDenied: boolean;
  /**
   * Open the shared mic WITHOUT starting the Groq pipeline. Live mode has to
   * own this itself: a user who switches straight to Live never pressed the
   * Groq mic button, so no stream would exist yet.
   */
  onEnsureMic: () => Promise<MediaStream | null>;
  /** Close the mic when Live stops. */
  onReleaseMic: () => Promise<void>;
}

const HUE = 200;

export function LiveVoicePanel({
  mediaStream,
  micDenied,
  onEnsureMic,
  onReleaseMic,
}: LiveVoicePanelProps) {
  const live = useGeminiLive();
  const [starting, setStarting] = useState(false);

  const toggle = async () => {
    if (live.active) {
      live.stop();
      await onReleaseMic();
      return;
    }
    setStarting(true);
    try {
      const stream = mediaStream ?? (await onEnsureMic());
      // A failure here is reported through `live.error`, not thrown: the
      // console simply stays on the Groq pipeline.
      const result = await live.start(stream);
      if (!result.ok && !mediaStream) {
        // We opened the mic ourselves and the session never came up. Leaving
        // it open would strand the mic indicator with nothing behind it, so
        // hand it straight back.
        await onReleaseMic();
      }
    } finally {
      setStarting(false);
    }
  };

  const on = live.active;
  const busy = starting || live.status === "connecting";

  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center gap-8 px-4">
      <div className="flex flex-col items-center gap-5">
        <motion.div
          initial={{ opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ type: "spring", stiffness: 220, damping: 26 }}
          className="relative h-[min(58vmin,22rem)] w-[min(58vmin,22rem)]"
        >
          <VoicePoweredOrb
            enableVoiceControl={on}
            stream={mediaStream}
            hue={live.speaking ? 140 : HUE}
            voiceSensitivity={1.5}
            className="h-full w-full"
          />
        </motion.div>

        <div className="flex h-6 items-center gap-2" aria-live="polite">
          {busy && !live.stalled && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-300" aria-hidden />
          )}
          <span className={cn("text-sm font-medium", on ? "text-emerald-300" : "text-white/55")}>
            {busy && !live.stalled
              ? "Menyambung..."
              : live.stalled
                ? "Tersambung, tapi belum ada suara"
                : on
                  ? live.speaking
                    ? "Bicara..."
                    : "Dengerin..."
                  : "Belum nyambung"}
          </span>
        </div>
      </div>

      {/* The connected-but-silent case gets its own line: it is neither a
          connection failure nor a working session, and the spinner could only
          ever describe one of the two. */}
      {live.stalled && (
        <p
          role="status"
          className="max-w-sm text-center text-xs leading-relaxed text-amber-300/90"
        >
          {live.stalled}
        </p>
      )}

      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => void toggle()}
          disabled={micDenied || busy}
          aria-label={on ? "Stop Gemini Live" : "Start Gemini Live"}
          className={cn(
            "flex h-20 w-20 items-center justify-center rounded-full border transition-all duration-300 disabled:opacity-40",
            on
              ? "border-rose-400/40 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25"
              : "border-emerald-400/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
          )}
        >
          {on ? <MicOff className="h-8 w-8" /> : <Mic className="h-8 w-8" />}
        </button>

        {live.speaking && (
          <button
            type="button"
            onClick={live.interrupt}
            aria-label="Interrupt Mia"
            className="flex h-12 w-12 items-center justify-center rounded-full border border-white/15 bg-white/5 text-white/70 transition-all duration-300 hover:bg-white/10 hover:text-white"
          >
            <Square className="h-5 w-5" />
          </button>
        )}
      </div>

      {/* Transcripts: the only text in this surface, and the only way to see
          that Live is really hearing and answering. */}
      <div className="flex w-full max-w-md flex-col gap-2 text-center">
        {live.error && (
          <p role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-100/90">
            {live.error}
          </p>
        )}
        {live.heard && (
          <p className="break-words text-xs text-white/45">kamu: {live.heard}</p>
        )}
        {live.said && <p className="break-words text-sm text-white/75">{live.said}</p>}
        {micDenied && (
          <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100/90">
            Mikrofon ditolak browser, jadi mode live belum bisa nyambung.
          </p>
        )}
        {!on && !live.error && !micDenied && (
          <p className="text-xs text-white/35">
            Tekan mic buat nyambung voice real-time. Butuh GEMINI_API_KEY di server.
          </p>
        )}
      </div>
    </div>
  );
}
