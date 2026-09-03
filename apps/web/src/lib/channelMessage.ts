// Unified channel message & command utilities (Fase 2.4).
//
// Abstracts incoming messages and command routing across Telegram, Discord,
// and future channels into a single normalized structure so command handling
// (/help, /reset, /provider, /model, /status) is shared instead of duplicated.

import { Channel } from "./agent";
import { ToolCall } from "./tools";
import { backupNow } from "./backup";

export interface NormalizedMessage {
  /** Sanitized user key for per-user persona/memory isolation. */
  userKey: string;
  /** Cleaned text content of the message. */
  text: string;
  /** Channel identifier. */
  channel: Channel;
  /** Unique chat/channel ID for session management. */
  chatId: string;
}

export type ChatSessionState = {
  provider: string;
  model?: string;
  history: { role: "user" | "assistant" | "tool"; content: string; tool_call_id?: string }[];
  pending: { messages: { role: "user" | "assistant" | "tool"; content: string; tool_call_id?: string }[]; call: ToolCall } | null;
};

export const HELP_TEXT = [
  "Hi! Aku Mia, asisten pribadimu. 🌸",
  "",
  "Command:",
  "  `/start` — mulai",
  "  `/help` — bantuan ini",
  "  `/reset` — hapus riwayat percakapan ini",
  "  `/provider` — lihat provider AI",
  "  `/provider <id>` — ganti provider (groq | opencode | 9router | openrouter | mock)",
  "  `/model <id>` — set model (default Auto)",
  "  `/status` — status sistem (waktu, uptime, provider, data)",
  "  `/backup` — backup data user ke .data/backups/<ts>/",
  "",
  "Kamu bisa minta aku menyetel reminder, menyimpan catatan, mencari di web, membaca file/link, atau menghitung.",
].join("\n");

export const VALID_PROVIDERS = ["groq", "opencode", "9router", "openrouter", "mock"];

/**
 * Handle a unified command. Returns { handled: true, replyText } if the text
 * is a known command, or { handled: false } if normal chat should proceed.
 */
export function handleUnifiedCommand(state: ChatSessionState, text: string): { handled: boolean; replyText?: string } {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const lower = (cmd || "").toLowerCase();

  switch (lower) {
    case "/start":
    case "/help":
      return { handled: true, replyText: HELP_TEXT };
    case "/reset":
      state.history = [];
      state.pending = null;
      return { handled: true, replyText: "Riwayat percakapan sudah direset." };
    case "/provider": {
      const next = rest.join(" ").trim();
      if (next) {
        const p = next.toLowerCase();
        if (VALID_PROVIDERS.includes(p)) {
          state.provider = p;
          state.history = [];
          state.pending = null;
          return { handled: true, replyText: `Provider diganti ke **${state.provider}**.` };
        }
        return { handled: true, replyText: `Provider tidak dikenal. Pilih: \`${VALID_PROVIDERS.join(" | ")}\`.` };
      }
      return { handled: true, replyText: `Provider saat ini: **${state.provider}**${state.model ? ` (model: \`${state.model}\`)` : ""}` };
    }
    case "/model": {
      const next = rest.join(" ").trim();
      state.model = next || undefined;
      return { handled: true, replyText: next ? `Model diset: \`${next}\`` : "Model direset ke default provider." };
    }
    case "/backup": {
      const result = backupNow();
      return { handled: true, replyText: `Backup dibuat di \`${result}\`.` };
    }
    default:
      if (lower.startsWith("/")) {
        return { handled: true, replyText: "Command tidak dikenal. Ketik /help." };
      }
      return { handled: false };
  }
}
