"use client";

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, Check, Clock, Copy, Mic, MicOff, Send, Settings, Sparkles, Square, Trash, Type, Volume2, X } from "lucide-react";
import { ConfirmationRequest } from "@voice/ai-provider";
import { cn } from "@/lib/utils";

/**
 * Lightweight markdown renderer for chat bubbles (no third-party markdown dep).
 * Supports the block forms the assistant actually emits: fenced code, headings,
 * unordered/ordered lists, blockquotes, horizontal rules and paragraphs; plus
 * inline emphasis (bold/italic), inline code and links. Everything is rendered
 * as React elements (never dangerouslySetInnerHTML), so it is XSS-safe by
 * construction. It is intentionally not a full CommonMark parser — output is
 * short voice-assistant prose, not documents.
 */
function renderInline(text: string, keyBase: string): ReactNode {
  // Split on inline-code first so we never try to emphasize code contents.
  const codeParts = text.split(/(`[^`]*`)/g);
  const out: ReactNode[] = [];
  codeParts.forEach((seg, idx) => {
    if (seg.startsWith("`") && seg.endsWith("`")) {
      out.push(
        <code
          key={`${keyBase}-c${idx}`}
          className="rounded bg-white/10 px-1 py-0.5 font-mono text-[0.85em] text-cyan-100"
        >
          {seg.slice(1, -1)}
        </code>
      );
      return;
    }
    // Bold + italic + links. Keep it simple and robust: split by inline delimiters.
    const inlineParts = seg.split(/(\*\*[^*]+\*\*|\*[^*\n]+\*|\[[^\]]+\]\([^)\s]+\))/g);
    inlineParts.forEach((part, j) => {
      if (!part) return;
      const bold = part.match(/^\*\*([^*]+)\*\*$/);
      if (bold) {
        out.push(
          <strong key={`${keyBase}-b${idx}-${j}`} className="font-semibold text-white">
            {bold[1]}
          </strong>
        );
        return;
      }
      const italic = part.match(/^\*([^*]+)\*$/);
      if (italic) {
        out.push(
          <em key={`${keyBase}-i${idx}-${j}`} className="italic text-white/85">
            {italic[1]}
          </em>
        );
        return;
      }
      const link = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      if (link) {
        out.push(
          <a
            key={`${keyBase}-l${idx}-${j}`}
            href={link[2]}
            target="_blank"
            rel="noopener noreferrer"
            className="text-cyan-300 underline decoration-cyan-300/40 underline-offset-2 hover:text-cyan-200"
          >
            {link[1]}
          </a>
        );
        return;
      }
      out.push(<Fragment key={`${keyBase}-t${idx}-${j}`}>{part}</Fragment>);
    });
  });
  return out;
}

/** Fenced code block with a copy-to-clipboard button. */
function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable; ignore (button does nothing harmful).
    }
  };
  return (
    <div className="group my-1.5 relative overflow-hidden rounded-lg border border-white/10 bg-black/50">
      <div className="flex items-center justify-between border-b border-white/10 px-2 py-1">
        <span className="text-[9px] uppercase tracking-wide text-white/40">{lang || "code"}</span>
        <button
          type="button"
          onClick={onCopy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-white/40 transition-colors hover:bg-white/10 hover:text-white"
          aria-label="Copy code"
          title="Copy code"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 text-emerald-300" /> copied
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" /> copy
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
        {code}
      </pre>
    </div>
  );
}

function renderContent(text: string): ReactNode {
  // Fenced code blocks are hoisted out first and rendered as <pre>.
  const blocks = text.split(/(```[\s\S]*?```)/g);
  const output: ReactNode[] = [];
  blocks.forEach((block, bi) => {
    if (block.startsWith("```")) {
      const inner = block.slice(3, -3);
      const langMatch = inner.match(/^([^\n]*)\n/);
      const lang = langMatch ? langMatch[1].trim() : "";
      const code = langMatch ? inner.slice(langMatch[0].length) : inner;
      output.push(<CodeBlock key={`pre-${bi}`} lang={lang} code={code} />);
      return;
    }
    // Block-level pass over the remaining prose, line by line.
    const lines = block.split("\n");
    const para: string[] = [];
    let listKind: "ul" | "ol" | null = null;
    const listItems: ReactNode[] = [];
    const flushPara = (key: string) => {
      if (!para.length) return;
      output.push(
        <p key={key} className="my-0.5">
          {renderInline(para.join(" "), key)}
        </p>
      );
      para.length = 0;
    };
    const flushList = (key: string) => {
      if (!listKind) return;
      output.push(
        listKind === "ul" ? (
          <ul key={key} className="my-1 list-disc space-y-0.5 pl-4 marker:text-white/50">
            {listItems}
          </ul>
        ) : (
          <ol key={key} className="my-1 list-decimal space-y-0.5 pl-4 marker:text-white/50">
            {listItems}
          </ol>
        )
      );
      listKind = null;
      listItems.length = 0;
    };
    lines.forEach((line, li) => {
      const key = `${bi}-${li}`;
      const trimmed = line.trim();
      if (!trimmed) {
        flushPara(`p${key}`);
        flushList(`l${key}`);
        return;
      }
      // Horizontal rule ---
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)) {
        flushPara(`p${key}`);
        flushList(`l${key}`);
        output.push(<hr key={`hr${key}`} className="my-2 border-white/10" />);
        return;
      }
      // Heading (# .. ######)
      const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        flushPara(`p${key}`);
        flushList(`l${key}`);
        const level = heading[1].length;
        const size =
          level === 1
            ? "text-[15px] font-bold"
            : level === 2
              ? "text-[13.5px] font-semibold"
              : "text-[12.5px] font-semibold text-white/90";
        output.push(
          <div key={`h${key}`} className={`mt-1.5 ${size}`}>
            {renderInline(heading[2], key)}
          </div>
        );
        return;
      }
      // Blockquote
      if (trimmed.startsWith("> ")) {
        flushPara(`p${key}`);
        flushList(`l${key}`);
        output.push(
          <blockquote
            key={`q${key}`}
            className="my-1 border-l-2 border-white/20 pl-2 italic text-white/70"
          >
            {renderInline(trimmed.replace(/^>\s*/, ""), key)}
          </blockquote>
        );
        return;
      }
      // Unordered list item
      const ul = trimmed.match(/^\s*[-*+]\s+(.*)$/);
      if (ul) {
        if (listKind !== "ul") {
          flushPara(`p${key}`);
          flushList(`l${key}`);
          listKind = "ul";
        }
        listItems.push(
          <li key={`il${key}`}>{renderInline(ul[1], key)}</li>
        );
        return;
      }
      // Ordered list item
      const ol = trimmed.match(/^\s*(\d+)[.)]\s+(.*)$/);
      if (ol) {
        if (listKind !== "ol") {
          flushPara(`p${key}`);
          flushList(`l${key}`);
          listKind = "ol";
        }
        listItems.push(
          <li key={`il${key}`}>{renderInline(ol[2], key)}</li>
        );
        return;
      }
      // Regular prose line — accumulate into a paragraph.
      flushList(`l${key}`);
      para.push(trimmed);
    });
    flushPara(`p${bi}-end`);
    flushList(`l${bi}-end`);
  });
  return output.length ? <Fragment>{output}</Fragment> : text;
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
  sessions?: { id: string; title: string; updatedAt: number; turns: number }[];
  currentSessionId?: string | null;
  onSwitchSession?: (id: string) => void;
  onNewSession?: () => void;
  onDeleteSession?: (id: string) => void;
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
  sessions = [],
  currentSessionId = null,
  onSwitchSession,
  onNewSession,
  onDeleteSession,
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
    <div className={cn("group/card relative h-full w-[min(520px,94vw)] rounded-3xl overflow-hidden p-px", className)}>
      {/* Soft aurora border */}
      <div className="absolute inset-0 rounded-3xl bg-gradient-to-br from-white/25 via-primary/30 to-white/10 transition-opacity duration-500 group-hover/card:opacity-100 opacity-70" />

      {/* Ambient glow ring (calm brand cyan) */}
      <div className="pointer-events-none absolute -inset-px rounded-3xl bg-primary/15 blur-2xl animate-glow-pulse" />

      {/* Inner Card */}
      <div className="relative flex flex-col w-full h-full rounded-[calc(1.5rem-1px)] overflow-hidden glass-strong">
        {/* Inner Animated Background */}
        <motion.div
          className="absolute inset-0 bg-gradient-to-br from-gray-800/70 via-black to-gray-900/70"
          animate={{ backgroundPosition: ["0% 0%", "100% 100%", "0% 0%"] }}
          transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
          style={{ backgroundSize: "200% 200%" }}
        />
        {/* Top sheen */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-white/10 to-transparent" />

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
        <div className="flex items-center justify-between px-4 pt-4 pb-3 relative z-10">
          <div>
            <h2 className="text-lg font-bold leading-tight bg-gradient-to-r from-white via-white to-primary bg-clip-text text-transparent">
              AI Assistant
            </h2>
            <p className="text-[10px] font-medium uppercase tracking-widest text-white/35">Real-time voice</p>
          </div>
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
                      ? "Native local opencode agent — requires `opencode serve` running."
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

        {/* Conversations (multi-session) selector */}
        {(onSwitchSession || onNewSession) && (
          <div className="relative z-10 flex items-center gap-2 px-4 py-2 border-b border-white/10">
            <select
              value={currentSessionId ?? ""}
              onChange={(e) => {
                const id = e.target.value;
                if (id) onSwitchSession?.(id);
              }}
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/50 px-2 py-1.5 text-xs text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-white/40"
              aria-label="Conversations"
            >
              {sessions.filter(Boolean).map((s) => (
                <option key={s.id} value={s.id} className="bg-black text-white">
                  {s.title || "Untitled"} · {s.turns || 0}
                </option>
              ))}
            </select>
            {onNewSession && (
              <button
                type="button"
                onClick={onNewSession}
                title="New conversation"
                aria-label="New conversation"
                className="shrink-0 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white/70 hover:bg-white/15 transition-colors"
              >
                + New
              </button>
            )}
            {onDeleteSession && currentSessionId && (
              <button
                type="button"
                onClick={() => onDeleteSession(currentSessionId)}
                title="Delete this conversation"
                aria-label="Delete this conversation"
                className="shrink-0 rounded-lg border border-white/10 bg-white/5 p-1.5 text-white/40 hover:text-red-400 hover:bg-red-500/10 transition-colors"
              >
                <Trash className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 min-h-0 px-4 py-3 overflow-y-auto scroll-smooth space-y-3 text-sm flex flex-col relative z-10">
          {messages.length === 0 ? (
            <div className="m-auto flex flex-col items-center gap-3 text-center text-white/30">
              <motion.div
                className="flex h-16 w-16 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-primary/70 animate-float"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
              >
                <Sparkles className="h-7 w-7" />
              </motion.div>
              <p className="max-w-[220px] text-sm leading-relaxed">
                Ask anything — type below or tap the mic to talk.
              </p>
            </div>
          ) : (
            messages.map((msg, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 8, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ type: "spring", stiffness: 320, damping: 28, mass: 0.8 }}
                className={cn(
                  "flex w-full",
                  msg.sender === "ai" ? "justify-start items-end gap-2" : "justify-end"
                )}
              >
                {msg.sender === "ai" && (
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary/40 to-primary/10 border border-primary/30">
                    <Sparkles className="h-3 w-3 text-primary/80" />
                  </span>
                )}
                <motion.div
                  className={cn(
                    "px-3 py-2 rounded-2xl max-w-[80%] shadow-md backdrop-blur-md leading-relaxed",
                    msg.partial && "opacity-60",
                    msg.sender === "ai"
                      ? "bg-gradient-to-br from-white/15 via-white/[0.07] to-white/[0.03] border border-white/10 text-white shadow-lg"
                      : "bg-gradient-to-br from-primary/40 to-primary/20 border border-primary/20 text-white"
                  )}
                >
                  {renderContent(msg.text)}
                </motion.div>
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

        {/* Input + mic */}
        <div className="relative z-10 flex flex-col items-center gap-2.5 p-3 border-t border-white/10">
          {onToggleMic && orb && (
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[10px] font-medium",
                isListening
                  ? "border-rose-500/40 bg-rose-500/15 text-rose-300"
                  : "border-white/15 bg-white/5 text-white/45"
              )}
            >
              {isListening && (
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75"></span>
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-rose-400"></span>
                </span>
              )}
              {isListening ? "Listening…" : micActive ? "Tap to stop" : "Tap to talk"}
            </span>
          )}
          {onToggleMic &&
            (orb ? (
              <button
                type="button"
                onClick={onToggleMic}
                title={micActive ? "Stop voice" : "Start voice"}
                aria-label={micActive ? "Stop voice" : "Start voice"}
                aria-pressed={micActive}
                className={cn(
                  "group/mic relative h-16 w-16 cursor-pointer rounded-full transition-all duration-300",
                  micActive
                    ? "shadow-[0_0_40px_-6px] shadow-rose-500/60"
                    : "shadow-[0_0_32px_-8px] shadow-primary/40 hover:scale-105 hover:shadow-[0_0_40px_-6px] hover:shadow-primary/60"
                )}
              >
                {micActive && (
                  <span className="pointer-events-none absolute inset-0 rounded-full animate-ping bg-rose-500/20" />
                )}
                {orb}
              </button>
            ) : (
              <button
                type="button"
                onClick={onToggleMic}
                title={micActive ? "Stop voice" : "Start voice"}
                aria-label={micActive ? "Stop voice" : "Start voice"}
                className={cn(
                  "relative flex h-14 w-14 items-center justify-center rounded-full border transition-all duration-300",
                  micActive
                    ? "border-rose-500/60 bg-gradient-to-br from-rose-500/30 to-rose-600/20 text-rose-300 shadow-[0_0_40px_-8px] shadow-rose-500/60"
                    : "border-white/20 bg-gradient-to-br from-primary/25 to-primary/10 text-white shadow-[0_0_40px_-10px] shadow-primary/40 hover:scale-105 hover:border-white/30"
                )}
              >
                {micActive && (
                  <span className="absolute inset-0 rounded-full animate-ping bg-rose-500/20" />
                )}
                {micActive ? <MicOff className="h-6 w-6" /> : <Mic className="h-6 w-6" />}
              </button>
            ))}

          <div className="flex items-center gap-2 w-full rounded-full glass px-2.5 py-1.5">
            <input
              className="flex-1 bg-transparent px-2 py-1.5 text-sm text-white placeholder:text-white/30 focus:outline-none"
              placeholder="Type a message…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSend()}
              aria-label="Message"
            />
            <button
              type="button"
              onClick={handleSend}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary/60 text-white shadow-lg shadow-primary/30 transition-transform duration-200 hover:scale-105 active:scale-95"
              aria-label="Send"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}