"use client";

import { motion } from "framer-motion";
import { AlertTriangle, Check, X } from "lucide-react";
import type { ConfirmationRequest } from "@voice/ai-provider";

interface ConfirmBarProps {
  calls: ConfirmationRequest[] | null;
  onConfirm: (callId: string) => void;
  onDeny: (callId: string) => void;
}

/**
 * Tool-approval prompt, pinned directly above the composer.
 *
 * Deliberately NOT rendered inside the scrolling transcript: a risky action is
 * BLOCKED until answered, so letting the prompt scroll away with history would
 * hide the only control the user can act on.
 */
export function ConfirmBar({ calls, onConfirm, onDeny }: ConfirmBarProps) {
  if (!calls || calls.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 px-3 pb-1">
      {calls.map((call) => (
        <motion.div
          key={call.id}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 w-full"
        >
          <div className="flex items-center gap-2 text-amber-300">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span className="text-xs font-semibold">
              {calls.length > 1 ? "Confirm actions" : "Confirm action"}
            </span>
          </div>
          <p className="text-xs text-white/80 break-words">
            Allow{" "}
            {calls.length > 1 ? (
              <span className="font-semibold text-white">
                {calls.length} actions ({calls.map((c) => c.name).join(", ")})
              </span>
            ) : (
              <span className="font-semibold text-white">{call.name}</span>
            )}
            ?
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => calls.forEach((c) => onConfirm(c.id))}
              className="flex items-center gap-1 rounded-lg bg-emerald-500/20 px-3 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-500/30 transition-colors"
            >
              <Check className="w-3.5 h-3.5" />
              {calls.length > 1 ? "Allow all" : "Yes"}
            </button>
            <button
              type="button"
              onClick={() => calls.forEach((c) => onDeny(c.id))}
              className="flex items-center gap-1 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium text-white/70 hover:bg-white/20 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
              No
            </button>
          </div>
        </motion.div>
      ))}
    </div>
  );
}
