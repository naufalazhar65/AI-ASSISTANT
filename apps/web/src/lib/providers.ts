/**
 * Server-side provider registry (invariant 5).
 *
 * The client only ever sends a `provider` id (+ optional `model`); it never
 * receives or sends endpoints or API keys. This module maps a provider id to
 * its endpoint + key + default model, resolved from server env at request time.
 *
 * NOTE: this module is ALSO imported client-side (Settings UI metadata), so it
 * must stay free of node built-ins. Server-only key sources (e.g. the opencode
 * CLI auth.json fallback) live in agent.ts.
 */

export type ProviderId = "mock" | "groq" | "opencode" | "opencodego" | "9router" | "openrouter";

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
    description: "Native local opencode agent (opencode serve). Requires the server to be running.",
    models: [{ id: "open-code", label: "Auto (server default)" }],
  },
  {
    id: "opencodego",
    label: "OpenCode Go",
    description: "OpenCode Go subscription gateway ($10/mo) — strong models via one key. Requires OPENCODEGO_API_KEY (or the opencode CLI login).",
    models: [
      { id: "glm-5.2", label: "GLM 5.2" },
      { id: "glm-5.3", label: "GLM 5.3" },
      { id: "glm-5.3-flash", label: "GLM 5.3 Flash (hemat)" },
      { id: "glm-5.1", label: "GLM 5.1" },
      { id: "grok-4.6", label: "Grok 4.6" },
      { id: "kimi-k3", label: "Kimi K3" },
      { id: "kimi-k2.7-code", label: "Kimi K2.7 Code" },
      { id: "kimi-k2.6", label: "Kimi K2.6" },
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
      { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
      { id: "deepseek-v4-flash-vision-exp", label: "DeepSeek V4 Flash Vision" },
      { id: "longcat-2.0", label: "LongCat 2.0 (paling hemat)" },
      { id: "mimo-v2.5", label: "MiMo V2.5" },
      { id: "mimo-v2.5-pro", label: "MiMo V2.5 Pro" },
      { id: "hy4-preview", label: "Hy4 preview" },
      { id: "hy3", label: "Hy3" },
      { id: "omen-alpha", label: "Omen Alpha" },
    ],
  },
  {
    id: "9router",
    label: "9Router",
    description: "OpenAI-compatible gateway. Requires LLM_API_KEY.",
    models: [
      { id: "auto", label: "Auto (server default)" },
      { id: "ngoding", label: "ngoding" },
      { id: "open-code", label: "open-code" },
      { id: "gemini/gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite" },
      { id: "gemini/gemini-3.1-flash-lite-preview", label: "Gemini 3.1 Flash Lite" },
      { id: "gemini/gemma-4-31b-it", label: "Gemma 4 31B" },
      { id: "ps/laguna-s-2.1", label: "Laguna S 2.1" },
      { id: "ps/laguna-xs-2.1", label: "Laguna XS 2.1" },
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    description: "OpenAI-compatible model router. Requires OPENROUTER_API_KEY.",
    models: [
      { id: "minimax/minimax-01", label: "MiniMax 01" },
      { id: "minimax/minimax-m3:free", label: "MiniMax M3 (free)" },
      { id: "dots-studio/dots-3-note-preview:free", label: "Dots 3 Note (free)" },
      { id: "deepseek/deepseek-chat", label: "DeepSeek Chat" },
      { id: "anthropic/claude-3.5-sonnet", label: "Claude 3.5 Sonnet" },
      { id: "openai/gpt-4o-mini", label: "GPT-4o Mini" },
      { id: "google/gemini-2.0-flash-001", label: "Gemini 2.0 Flash" },
    ],
  },
];

export function isProviderId(value: string): value is ProviderId {
  return PROVIDER_SPECS.some((p) => p.id === value);
}

/**
 * Server default provider when a request doesn't specify one
 * (env `DEFAULT_AI_PROVIDER`, falls back to "groq"). Server-side only.
 */
export function defaultProviderId(): ProviderId {
  const env = process.env.DEFAULT_AI_PROVIDER;
  return env && isProviderId(env) ? (env as ProviderId) : "groq";
}

/**
 * Client-safe default provider id for the Settings UI. Server env isn't
 * visible to the browser, so this uses the build-time `NEXT_PUBLIC_DEFAULT_AI_PROVIDER`.
 */
export const PUBLIC_DEFAULT_PROVIDER: ProviderId =
  process.env.NEXT_PUBLIC_DEFAULT_AI_PROVIDER && isProviderId(process.env.NEXT_PUBLIC_DEFAULT_AI_PROVIDER)
    ? (process.env.NEXT_PUBLIC_DEFAULT_AI_PROVIDER as ProviderId)
    : "groq";

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
    case "opencodego": {
      // OpenCode Go subscription gateway (OpenAI-compatible). Key from env;
      // the opencode CLI auth.json fallback is applied server-side in agent.ts
      // (this module must stay client-safe — no node built-ins).
      if (!process.env.OPENCODEGO_API_KEY) return null;
      return {
        url: process.env.OPENCODEGO_BASE_URL || "https://opencode.ai/zen/go/v1/chat/completions",
        apiKey: process.env.OPENCODEGO_API_KEY,
        defaultModel: process.env.OPENCODEGO_MODEL || "glm-5.2",
      };
    }
     case "9router":
      if (!process.env.LLM_API_KEY) return null;
      return {
        url: process.env.LLM_API_BASE || "https://api.9router.ai/v1/chat/completions",
        apiKey: process.env.LLM_API_KEY,
        defaultModel: process.env.LLM_MODEL || "",
      };
    case "openrouter":
      if (!process.env.OPENROUTER_API_KEY) return null;
      return {
        url: process.env.OPENROUTER_API_BASE || "https://openrouter.ai/api/v1/chat/completions",
        apiKey: process.env.OPENROUTER_API_KEY,
        defaultModel: process.env.OPENROUTER_MODEL || "dots-studio/dots-3-note-preview:free",
      };
  }
}