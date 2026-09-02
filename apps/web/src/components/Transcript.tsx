"use client";

import { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Bot, User } from "lucide-react";
import { TranscriptEntry } from "@/ai/ConversationManager";

export default function Transcript({ entries }: { entries: TranscriptEntry[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  if (entries.length === 0) {
    return (
      <div
        ref={scrollRef}
        className="flex h-full w-full items-center justify-center"
      >
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-center gap-3 text-center"
        >
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white/5 border border-white/10">
            <Bot className="h-6 w-6 text-white/40" />
          </div>
          <p className="text-sm text-white/40">
            What can I help you with?
            <br />
            <span className="text-white/25">Press the mic and talk, or type below.</span>
          </p>
        </motion.div>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="h-full w-full overflow-y-auto py-2"
    >
      <div className="flex flex-col gap-3">
        <AnimatePresence initial={false}>
          {entries.map((entry) => (
            <motion.div
              key={entry.id}
              initial={{ opacity: 0, y: 12, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.3, ease: "easeOut" }}
              className={`flex items-end gap-2 ${
                entry.role === "user" ? "flex-row-reverse" : "flex-row"
              }`}
            >
              {/* Avatar */}
              <div
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border ${
                  entry.role === "user"
                    ? "border-blue-500/30 bg-blue-500/10"
                    : "border-white/10 bg-white/5"
                }`}
              >
                {entry.role === "user" ? (
                  <User className="h-3.5 w-3.5 text-blue-400" />
                ) : (
                  <Bot className="h-3.5 w-3.5 text-white/50" />
                )}
              </div>

              {/* Bubble */}
              <div
                className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed backdrop-blur-md ${
                  entry.role === "user"
                    ? "rounded-br-md border border-blue-500/20 bg-blue-500/15 text-blue-50"
                    : "rounded-bl-md border border-white/10 bg-white/5 text-white/80"
                } ${entry.state === "partial" ? "opacity-60" : ""}`}
              >
                {entry.text}
                {entry.state === "partial" && (
                  <span className="ml-0.5 inline-block w-1.5 h-4 bg-white/60 rounded-sm animate-pulse align-text-bottom" />
                )}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
