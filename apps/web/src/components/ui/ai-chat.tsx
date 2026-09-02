"use client";

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, Check, Clock, Mic, MicOff, Send, Settings, Square, Type, Volume2, X } from "lucide-react";
import { ConfirmationRequest } from "@voice/ai-provider";
import { cn } from "@/lib/utils";

/**
 * Lightweight renderer for FR-012 (code input): splits text on fenced code
 * blocks (```lang ... ```) and renders code as a styled <pre>, keeping the
 * rest as inline text. No dependency on a full markdown/Prism pipeline.
 */
function renderContent(text: string): ReactNode {
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts.map((part, i) => {
    if (!part.startsWith("```")) return <Fragment key={i}>{part}</Fragment>;
    const inner = part.slice(3, -3);
    const langMatch = inner.match(/^([^\n]*)\n/);
    const lang = langMatch ? langMatch[1].trim() : "";
    const code = langMatch ? inner.slice(langMatch[0].length) : inner;
    return (
      <pre
        key={i}
        className="my-1.5 overflow-x-auto rounded-lg border border-white/10 bg-black/50 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words"
      >
        {lang && <span className="mb-1 block text-[9px] uppercase tracking-wide text-white/40">{lang}</span>}
        {code}
      </pre>
    );
  });
}

export interface AIChatMessage {
  sender: "ai" | "user";
  text: string;
  partial?: boolean;
}

interface AIChatCardProps {
  className?: string;
  messages: AIChatMessage[];
  isTyping?: boolean;
  onSend: (text: string) => void;
  orb?: React.ReactNode;
  micActive?: boolean;
  onToggleMic?: () => void;
  isListening?: boolean;
  onInterrupt?: () => void;
  showInterrupt?: boolean;
  voiceOutput?: boolean;
  onToggleVoiceOutput?: () => void;
  voice?: string;
  onVoiceChange?: (voice: string) => void;
  model?: string | undefined;
  onModelChange?: (model: string | undefined) => void;
  provider?: string;
  lastError?: string | null;
  onProviderChange?: (provider: string) => void;
  providers?: { id: string; label: string; models: string[] }[];
  confirmation?: ConfirmationRequest[] | null;
  onConfirm?: (callId: string) => void;
  onDeny?: (callId: string) => void;
  reminders?: string[];
  onDismissReminder?: (index: number) => void;
}

export const TTS_VOICES = ["autumn", "diana", "hannah", "austin", "daniel", "troy"] as const;

// Deterministic PRNG so SSR HTML and client hydration agree.
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CARD_PARTICLES = Array.from({ length: 12 }, (_, i) => {
  const rnd = mulberry32(7 + i);
  return {
    left: rnd() * 100,
    x: [rnd() * 160 - 80, rnd() * 160 - 80],
    duration: 5 + rnd() * 3,
    delay: i * 0.5,
  };
});

export default function AIChatCard({
  className,
  messages,
  isTyping = false,
  onSend,
  orb,
  micActive = false,
  onToggleMic,
  isListening = false,
  onInterrupt,
  showInterrupt = false,
  voiceOutput = true,
  onToggleVoiceOutput,
  voice = "hannah",
  onVoiceChange,
  model,
  onModelChange,
  provider = "groq",
  onProviderChange,
  providers = [],
  confirmation,
  lastError = null,
  onConfirm,
  onDeny,
  reminders = [],
  onDismissReminder,
}: AIChatCardProps) {
  const [input, setInput] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, isTyping]);

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    onSend(text);
    setInput("");
  };

  return (
    <div className={cn("relative h-full w-[min(520px,94vw)] rounded-2xl overflow-hidden p-[2px]", className)}>
      {/* Animated Outer Border */}
      <motion.div
        className="absolute inset-0 rounded-2xl border-2 border-white/20"
        animate={{ rotate: [0, 360] }}
        transition={{ duration: 25, repeat: Infinity, ease: "linear" }}
      />

      {/* Inner Card */}
      <div className="relative flex flex-col w-full h-full rounded-xl border border-white/10 overflow-hidden bg-black/90 backdrop-blur-xl">
        {/* Inner Animated Background */}
        <motion.div
          className="absolute inset-0 bg-gradient-to-br from-gray-800 via-black to-gray-900"
          animate={{ backgroundPosition: ["0% 0%", "100% 100%", "0% 0%"] }}
          transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
          style={{ backgroundSize: "200% 200%" }}
        />

        {/* Floating Particles */}
        {CARD_PARTICLES.map((p, i) => (
          <motion.div
            key={i}
            className="absolute w-1 h-1 rounded-full bg-white/10"
            animate={{
              y: ["0%", "-140%"],
              x: p.x,
              opacity: [0, 1, 0],
            }}
            transition={{
              duration: p.duration,
              repeat: Infinity,
              delay: p.delay,
              ease: "easeInOut",
            }}
            style={{ left: `${p.left}%`, bottom: "-10%" }}
          />
        ))}

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 relative z-10">
          <h2 className="text-lg font-semibold text-white">AI Assistant</h2>
          <div className="flex items-center gap-2">
            {onToggleVoiceOutput && (
              <div className="flex items-center rounded-lg bg-white/10 p-0.5" role="group" aria-label="Output mode">
                <button
                  type="button"
                  onClick={() => onToggleVoiceOutput()}
                  className={cn(
                    "flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium transition-colors",
                    voiceOutput ? "bg-white/20 text-white" : "text-white/50 hover:text-white/70"
                  )}
                  aria-pressed={voiceOutput}
                >
                  <Volume2 className="w-3 h-3" />
                  Voice
                </button>
                <button
                  type="button"
                  onClick={() => onToggleVoiceOutput()}
                  className={cn(
                    "flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium transition-colors",
                    !voiceOutput ? "bg-white/20 text-white" : "text-white/50 hover:text-white/70"
                  )}
                  aria-pressed={!voiceOutput}
                >
                  <Type className="w-3 h-3" />
                  Text
                </button>
              </div>
            )}
            {showInterrupt && onInterrupt && (
              <button
                type="button"
                onClick={onInterrupt}
                className="p-1.5 rounded-lg bg-white/10 text-amber-300 hover:bg-white/20 transition-colors"
                aria-label="Interrupt AI"
              >
                <Square className="w-3.5 h-3.5" />
              </button>
            )}
            {onToggleMic && (
              <button
                type="button"
                onClick={onToggleMic}
                className={cn(
                  "p-1.5 rounded-lg transition-colors",
                  micActive
                    ? "bg-rose-500/15 text-rose-300 hover:bg-rose-500/25"
                    : "bg-white/10 text-white/60 hover:bg-white/20"
                )}
                aria-label={micActive ? "Stop voice" : "Start voice"}
              >
                {micActive ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
              </button>
            )}
            {isListening && (
              <span className="flex items-center gap-1.5 rounded-full border border-rose-500/40 bg-rose-500/15 px-2.5 py-1 text-[10px] font-medium text-rose-300">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75"></span>
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-400"></span>
                </span>
                Listening…
              </span>
            )}
            {onVoiceChange && (
              <button
                type="button"
                onClick={() => setSettingsOpen((o) => !o)}
                className={cn(
                  "p-1.5 rounded-lg bg-white/10 text-white/60 hover:bg-white/20 transition-colors",
                  settingsOpen && "bg-white/20 text-white"
                )}
                aria-label="Settings"
                aria-expanded={settingsOpen}
              >
                <Settings className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Orb */}
        {orb && (
          <div className="relative z-10 flex flex-col items-center gap-1 px-4 py-4 border-b border-white/10">
            {orb}
          </div>
        )}

        {/* Settings panel (FR-009) — extensible for provider/model config. */}
        {settingsOpen && onVoiceChange && (
          <div className="absolute right-3 top-14 z-20 w-64 rounded-xl border border-white/10 bg-black/95 backdrop-blur-xl p-4 shadow-2xl">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-white">Settings</h3>
              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                className="p-1 rounded-md text-white/50 hover:bg-white/10 hover:text-white transition-colors"
                aria-label="Close settings"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="space-y-4">
              <div className="space-y-2">
                <p className="text-[10px] font-medium uppercase tracking-wide text-white/40">Voice</p>
                <div className="flex flex-wrap gap-1.5">
                  {TTS_VOICES.map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => onVoiceChange(v)}
                      className={cn(
                        "rounded-full border px-2 py-1 text-[10px] font-medium capitalize transition-colors",
                        v === voice
                          ? "border-white/40 bg-white/20 text-white"
                          : "border-white/10 text-white/50 hover:border-white/20 hover:text-white/80"
                      )}
                      aria-pressed={v === voice}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>

              {onProviderChange && providers.length > 0 && (
                <div className="space-y-2">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-white/40">Provider</p>
                  <div className="flex flex-wrap gap-1.5">
                    {providers.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => onProviderChange(p.id)}
                        className={cn(
                          "rounded-full border px-2 py-1 text-[10px] font-medium transition-colors",
                          provider === p.id
                            ? "border-white/40 bg-white/20 text-white"
                            : "border-white/10 text-white/50 hover:border-white/20 hover:text-white/80"
                        )}
                        aria-pressed={provider === p.id}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-white/35">
                    {providers.find((p) => p.id === provider)?.id === "opencode"
                      ? "Requires the local opencode proxy to be running."
                      : "Endpoints & API keys stay server-side (invariant 5)."}
                  </p>
                </div>
              )}

              {onModelChange && (
                <div className="space-y-2">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-white/40">Model</p>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => onModelChange(undefined)}
                      className={cn(
                        "rounded-full border px-2 py-1 text-[10px] font-medium transition-colors",
                        !model
                          ? "border-white/40 bg-white/20 text-white"
                          : "border-white/10 text-white/50 hover:border-white/20 hover:text-white/80"
                      )}
                      aria-pressed={!model}
                    >
                      Auto
                    </button>
                    {(providers.find((p) => p.id === provider)?.models ?? []).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => onModelChange(m)}
                        className={cn(
                          "rounded-full border px-2 py-1 text-[10px] font-medium transition-colors",
                          model === m
                            ? "border-white/40 bg-white/20 text-white"
                            : "border-white/10 text-white/50 hover:border-white/20 hover:text-white/80"
                        )}
                        aria-pressed={model === m}
                      >
                        {m.split("/").pop()}
                      </button>
                    ))}
                  </div>
                  <input
                    type="text"
                    value={model ?? ""}
                    onChange={(e) => onModelChange(e.target.value.trim() || undefined)}
                    placeholder="Custom model id…"
                    className="w-full rounded-lg border border-white/10 bg-black/50 px-2 py-1.5 text-xs text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-white/40"
                  />
                </div>
              )}
            </div>
          </div>
        )}

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 px-4 py-3 overflow-y-auto scroll-smooth space-y-3 text-sm flex flex-col relative z-10">
          {messages.length === 0 ? (
            <p className="m-auto text-white/30 text-center max-w-[200px]">
              Ask anything — type below or use the mic.
            </p>
          ) : (
            messages.map((msg, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 6, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ type: "spring", stiffness: 320, damping: 28, mass: 0.8 }}
                className={cn(
                  "px-3 py-2 rounded-xl max-w-[80%] shadow-md backdrop-blur-md",
                  msg.partial && "opacity-60",
msg.sender === "ai"
                      ? "bg-gradient-to-br from-white/15 via-white/[0.07] to-white/[0.03] border border-white/10 text-white self-start shadow-lg"
                      : "bg-white/30 text-white font-semibold self-end"
                )}
              >
                {renderContent(msg.text)}
              </motion.div>
            ))
          )}

          {/* Tool confirmation (FR-014): risky actions pause for user approval */}
          {confirmation && confirmation.map((call) => (
            <motion.div
              key={call.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex flex-col gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 self-center w-full"
            >
              <div className="flex items-center gap-2 text-amber-300">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span className="text-xs font-semibold">Confirm action</span>
              </div>
              <p className="text-xs text-white/80 break-words">
                Allow <span className="font-semibold text-white">{call.name}</span>?
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onConfirm?.(call.id)}
                  className="flex items-center gap-1 rounded-lg bg-emerald-500/20 px-3 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-500/30 transition-colors"
                >
                  <Check className="w-3.5 h-3.5" />
                  Yes
                </button>
                <button
                  type="button"
                  onClick={() => onDeny?.(call.id)}
                  className="flex items-center gap-1 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium text-white/70 hover:bg-white/20 transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                  No
                </button>
              </div>
            </motion.div>
          ))}

          {lastError && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex items-start gap-2 rounded-xl border border-red-500/40 bg-red-500/10 p-3 self-center w-full"
              role="alert"
            >
              <AlertTriangle className="w-4 h-4 shrink-0 text-red-400 mt-0.5" />
              <div className="min-w-0">
                <p className="text-xs font-semibold text-red-300">Failed</p>
                <p className="text-xs text-white/80 break-words mt-0.5">{lastError}</p>
              </div>
            </motion.div>
          )}

          {reminders.map((r, i) => (
            <motion.div
              key={`reminder-${i}`}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 self-center w-full"
              role="alert"
            >
              <Clock className="w-4 h-4 shrink-0 text-amber-400 mt-0.5" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-amber-300">Reminder</p>
                <p className="text-xs text-white/90 break-words mt-0.5">{r}</p>
              </div>
              <button
                type="button"
                onClick={() => onDismissReminder?.(i)}
                className="shrink-0 rounded-md p-1 text-white/50 hover:text-white/90 hover:bg-white/10 transition-colors"
                aria-label="Dismiss reminder"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </motion.div>
          ))}

          {/* AI Typing Indicator */}
          {isTyping && (
            <motion.div
              className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl max-w-[30%] bg-gradient-to-br from-white/15 via-white/[0.07] to-white/[0.03] border border-white/10 self-start shadow-lg"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25 }}
            >
              <span className="animate-typing-dot inline-block w-2 h-2 rounded-full bg-white/80"></span>
              <span className="animate-typing-dot inline-block w-2 h-2 rounded-full bg-white/80"></span>
              <span className="animate-typing-dot inline-block w-2 h-2 rounded-full bg-white/80"></span>
            </motion.div>
          )}
        </div>

        {/* Input */}
        <div className="flex items-center gap-2 p-3 border-t border-white/10 relative z-10">
          <input
            className="flex-1 px-3 py-2 text-sm bg-black/50 rounded-lg border border-white/10 text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-white/50"
            placeholder="Type a message..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
          />
          <button
            type="button"
            onClick={handleSend}
            className="p-2 rounded-lg bg-white/10 hover:bg-white/20 transition-colors"
            aria-label="Send"
          >
            <Send className="w-4 h-4 text-white" />
          </button>
        </div>
      </div>
    </div>
  );
}