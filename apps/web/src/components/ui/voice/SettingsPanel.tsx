"use client";

import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatProviderOption } from "./types";

/** Voice names offered by the current text-to-speech provider. */
export const TTS_VOICES = ["autumn", "diana", "hannah", "austin", "daniel", "troy"] as const;

interface SettingsPanelProps {
  voice: string;
  onVoiceChange: (voice: string) => void;
  provider: string;
  onProviderChange: (provider: string) => void;
  providers: ChatProviderOption[];
  model: string | undefined;
  onModelChange: (model: string | undefined) => void;
  onClose: () => void;
}

/** Small pill button that reads as selected when it is the current value. */
function ChoicePill({
  label,
  selected,
  onClick,
  title,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "rounded-full border px-2 py-1 text-[10px] font-medium transition-colors",
        selected
          ? "border-white/40 bg-white/20 text-white"
          : "border-white/10 text-white/50 hover:border-white/20 hover:text-white/80"
      )}
      aria-pressed={selected}
    >
      {label}
    </button>
  );
}

/**
 * Provider / model / voice configuration, rendered as a popover.
 *
 * Sizing note: the card has an `overflow-hidden` ancestor to clip its rounded
 * corners, which also clips any child that grows past the card's edge. This
 * panel therefore caps its own height and scrolls internally, so every control
 * stays reachable on a short viewport instead of being cut off with no way to
 * scroll to it.
 */
export function SettingsPanel({
  voice,
  onVoiceChange,
  provider,
  onProviderChange,
  providers,
  model,
  onModelChange,
  onClose,
}: SettingsPanelProps) {
  const providerModels = providers.find((p) => p.id === provider)?.models ?? [];

  return (
    <div className="absolute right-3 top-14 z-20 w-72 max-h-[min(26rem,70vh)] overflow-y-auto overscroll-contain rounded-xl border border-white/10 bg-black/95 backdrop-blur-xl p-4 shadow-2xl">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-white">Settings</h3>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded-md text-white/50 hover:bg-white/10 hover:text-white transition-colors"
          aria-label="Close settings"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="space-y-4">
        <section className="space-y-2">
          <p className="text-[10px] font-medium uppercase tracking-wide text-white/40">Voice</p>
          <div className="flex flex-wrap gap-1.5">
            {TTS_VOICES.map((v) => (
              <ChoicePill
                key={v}
                label={v}
                selected={v === voice}
                onClick={() => onVoiceChange(v)}
              />
            ))}
          </div>
        </section>

        {providers.length > 0 && (
          <section className="space-y-2">
            <p className="text-[10px] font-medium uppercase tracking-wide text-white/40">
              Provider
            </p>
            <div className="flex flex-wrap gap-1.5">
              {providers.map((p) => (
                <ChoicePill
                  key={p.id}
                  label={p.label}
                  selected={provider === p.id}
                  onClick={() => onProviderChange(p.id)}
                />
              ))}
            </div>
            <p className="text-[10px] leading-relaxed text-white/35">
              {provider === "opencode"
                ? "Native local opencode agent — requires `opencode serve` running."
                : "Endpoints and API keys stay server-side."}
            </p>
          </section>
        )}

        <section className="space-y-2">
          <p className="text-[10px] font-medium uppercase tracking-wide text-white/40">Model</p>
          <div className="flex flex-wrap gap-1.5">
            <ChoicePill
              label="Auto"
              selected={!model}
              onClick={() => onModelChange(undefined)}
            />
            {providerModels.map((m) => (
              <ChoicePill
                key={m}
                label={m.split("/").pop() ?? m}
                title={m}
                selected={model === m}
                onClick={() => onModelChange(m)}
              />
            ))}
          </div>
          <input
            type="text"
            value={model ?? ""}
            onChange={(e) => onModelChange(e.target.value.trim() || undefined)}
            placeholder="Custom model id"
            aria-label="Custom model id"
            className="w-full rounded-lg border border-white/10 bg-black/50 px-2 py-1.5 text-xs text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-white/40"
          />
          <p className="text-[10px] text-white/30">Auto lets the provider choose its default.</p>
        </section>
      </div>
    </div>
  );
}
