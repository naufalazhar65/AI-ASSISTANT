/**
 * Server-side provider registry (invariant 5).
 *
 * The client only ever sends a `provider` id (+ optional `model`); it never
 * receives or sends endpoints or API keys. This module maps a provider id to
 * its endpoint + key + default model, resolved from server env at request time.
 */

export type ProviderId = "mock" | "groq" | "opencode" | "9router";

export interface ProviderSpec {
  id: ProviderId;
  /** Public metadata shown in the Settings UI (safe to expose). */
  label: string;
  description: string;
  /** Public model suggestions for the Settings UI (safe to expose). */
  models: { id: string; label: string }[];
}

export const PROVIDER_SPECS: ProviderSpec[] = [
  {
    id: "mock",
    label: "Mock",
    description: "No network — canned reply for UI/token-free testing.",
    models: [{ id: "mock", label: "Mock" }],
  },
  {
    id: "groq",
    label: "Groq",
    description: "Free tier. Requires GROQ_API_KEY.",
    models: [
      { id: "qwen/qwen3.8-27b", label: "Qwen 3.8" },
      { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B" },
      { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B" },
    ],
  },
  {
    id: "opencode",
    label: "OpenCode (local)",
    description: "Free via the local opencode proxy. Requires the proxy to be running.",
    models: [{ id: "open-code", label: "OpenCode base" }],
  },
  {
    id: "9router",
    label: "9Router",
    description: "OpenAI-compatible gateway. Requires LLM_API_KEY.",
    models: [{ id: "auto", label: "Auto (dashboard default)" }],
  },
];

export function isProviderId(value: string): value is ProviderId {
  return PROVIDER_SPECS.some((p) => p.id === value);
}

/**
 * Client-safe provider metadata for the Settings UI. Excludes endpoints/keys
 * and the env-reading `resolveProvider` so this never ships server secrets.
 */
export const PUBLIC_PROVIDERS: { id: ProviderId; label: string; models: string[] }[] =
  PROVIDER_SPECS.map((p) => ({ id: p.id, label: p.label, models: p.models.map((m) => m.id) }));

export function findPublicProvider(id: string): { id: ProviderId; label: string; models: string[] } | undefined {
  return PUBLIC_PROVIDERS.find((p) => p.id === id);
}

/**
 * Resolve endpoint + key + default model for a provider from server env.
 * Returns null when the provider is not configured.
 */
export function resolveProvider(
  provider: ProviderId
): { url: string; apiKey: string; defaultModel: string } | null {
  switch (provider) {
    case "mock":
      // Mock never makes network calls; the route short-circuits on this id.
      return null;
    case "groq":
      if (!process.env.GROQ_API_KEY) return null;
      return {
        url: "https://api.groq.com/openai/v1/chat/completions",
        apiKey: process.env.GROQ_API_KEY,
        defaultModel: process.env.GROQ_LLM_MODEL || "qwen/qwen3.8-27b",
      };
    case "opencode":
      // The local opencode proxy: no external key needed (the proxy holds it).
      return {
        url: process.env.OPENCODE_LLM_BASE || "http://localhost:20128/v1/chat/completions",
        apiKey: process.env.OPENCODE_LLM_KEY || "EMPTY",
        defaultModel: process.env.OPENCODE_LLM_MODEL || "open-code",
      };
    case "9router":
      if (!process.env.LLM_API_KEY) return null;
      return {
        url: process.env.LLM_API_BASE || "https://api.9router.ai/v1/chat/completions",
        apiKey: process.env.LLM_API_KEY,
        defaultModel: process.env.LLM_MODEL || "",
      };
  }
}