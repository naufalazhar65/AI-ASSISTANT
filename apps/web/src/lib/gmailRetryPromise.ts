// Honesty guard for a Gmail turn that ended in a promise it can never keep.
//
// Measured 2026-10-07, owner channel Discord, 22:53–22:54 WIB: the refresh
// token had been revoked by Google (7-day rule for consent screens still in
// "Testing"). `gmail_list` failed five times, and three of the five replies
// said "nanti aku coba lagi ya" / "nanti pas udah normal langsung aku kabari".
// None of those can come true: the token is dead until the owner
// re-authorizes, so a retry is guaranteed to fail again. The model invented
// the promise because the tool error was raw English and terminal-ness was
// never stated.
//
// This guard is deliberately narrow — it only speaks when BOTH hold:
//   1. this turn actually surfaced a terminal Gmail failure to the model, and
//   2. the reply promises a retry (and does not hand over a relink link).
// Everything else stays silent: a live-account hiccup, an honest refusal, or a
// reply that already carries the link is exactly the behaviour we want.

import { GMAIL_TOKEN_REVOKED } from "./email";

/** "nanti aku coba lagi", "akan kucoba lagi", "nanti aku kabari", "sebentar lagi". */
const RETRY_PROMISE_RE =
  /\b(nanti|ntar|sebentar|lagi)\b[^.!?\n]{0,40}?\b(aku (aku )?(coba|koba|coba lagi)|kucoba|aku coba|try lagi|coba lagi|kabari|cek lagi|baca lagi|perbarui)\b/i;

/** A link the owner can actually click (accounts.google.com auth URL). */
const RELINK_HINT_RE = /accounts\.google\.com\/o\/oauth2|hubungkan (lagi|ulang)|tautan (ini|re)?link|oauth/i;

type ToolResultish = { role?: unknown; content?: unknown };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
      .join("\n");
  return "";
}

/** Did this turn show the model a terminal Gmail failure? */
export function gmailTerminalFailureThisTurn(messages: ReadonlyArray<ToolResultish>): boolean {
  return (messages || []).some((m) => {
    if (m?.role !== "tool") return false;
    const t = textOf(m.content);
    return t.includes(GMAIL_TOKEN_REVOKED) || t.includes("invalid_grant") || t.includes("expired or revoked");
  });
}

/** The retry promise, or "" when the reply makes none. */
export function retryPromiseClause(text: string): string {
  const m = RETRY_PROMISE_RE.exec(text || "");
  return m ? m[0] : "";
}

/**
 * Honest correction when a dead-Gmail turn answers with "I'll try again".
 * Returns "" when there is nothing wrong with the reply.
 */
export function gmailRetryPromiseNote(messages: ReadonlyArray<ToolResultish>, text: string): string {
  if (!gmailTerminalFailureThisTurn(messages)) return "";
  const promise = retryPromiseClause(text || "");
  if (!promise) return "";
  // Already honest: the reply points at the relink step, so it is not
  // promising a retry it cannot keep.
  if (RELINK_HINT_RE.test(text || "")) return "";
  return (
    ` (Catatan jujur: akses Gmail-nya sudah dicabut Google, jadi "${promise}" tidak akan pernah berhasil. ` +
    `Yang perlu Mas Naufal lakukan cuma sekali: buka link relink yang aku kirim di atas, lalu bilang "cek email" lagi.)`
  );
}
