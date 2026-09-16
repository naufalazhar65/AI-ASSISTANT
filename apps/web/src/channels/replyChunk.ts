export const DISCORD_MAX = 2000;
export const TELEGRAM_MAX = 4096;

/** Short interim "waiting" lines shown right after a risky-tool confirmation
 *  ("balas ya") before the follow-up turn runs — varied so repeated confirms
 *  don't echo the same sentence every time. */
const INTERIM_WAITS = [
  "Oke, sebentar ya…",
  "Bentar, lagi kuproses…",
  "Siap, tungguin dulu ya…",
  "Oke, nggak lama kok…",
  "Oke-oke, dikerjain dulu ya…",
  "Bentar, kupastikan dulu ini aman ya…",
];

export function interimWaitText(): string {
  return INTERIM_WAITS[Math.floor(Math.random() * INTERIM_WAITS.length)] ?? "Oke, sebentar ya…";
}

/**
 * Last-line defense for the send boundary: some providers leak raw tool-call
 * markup into the reply text (`<invoke name="fetch_url">…`), and a model can even
 * splice it mid-sentence. The agent strips this before returning, but any path
 * that bypasses that strip must still never show tags to the user — so every
 * chunk sent to a channel is scrubbed here too.
 */
export function scrubToolMarkup(text: string): string {
  let t = text ?? "";
  // Closed blocks first (multiline), then any unclosed fragment to end-of-line.
  t = t
    .replace(/<invoke\b[\s\S]*?<\/invoke>/gi, " ")
    .replace(/<tool_call\b[\s\S]*?<\/tool_call>/gi, " ")
    .replace(/<tool_use\b[\s\S]*?<\/tool_use>/gi, " ")
    .replace(/<function_calls\b[\s\S]*?<\/function_calls>/gi, " ")
    .replace(/<invoke\b[^>\n]*>?/gi, " ")
    .replace(/<tool_call\b[^>\n]*>?/gi, " ");
  // Stray tags / partial fragments.
  t = t.replace(/<\/?(?:invoke|parameter|tool_call|tool_use|tool_result|function_calls|antml:[a-z_]+)\b[^>]*>/gi, " ");
  t = t.replace(/\s{2,}/g, " ");
  // Drop leading/trailing connective junk left by removals (", , . sementara").
  t = t.replace(/^[\s,.;:]+/, "").replace(/[\s,]+$/, "").trim();
  return t;
}

/** Split long replies into channel-safe chunks on newline boundaries when possible. */
export function chunkText(text: string, max: number): string[] {
  const safe = scrubToolMarkup(text ?? "");
  if (safe.length <= max) return [safe];
  const out: string[] = [];
  let remaining = safe;
  while (remaining.length > max) {
    let cut = remaining.lastIndexOf("\n", max);
    if (cut < 1) cut = max;
    out.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).replace(/^\n+/, "");
  }
  if (remaining) out.push(remaining);
  return out;
}

type PendingAction = { name: string; arguments?: string };

/**
 * Human description of each risky action awaiting approval. A single action
 * reads exactly as before (no index); several are numbered so the user can pick.
 * `bold` is the channel's bold marker (** for Discord, * for Telegram).
 */
function listPendingActions(calls: PendingAction[], bold: string): string {
  return calls
    .map((c, i) => {
      let args = "";
      try {
        args = JSON.stringify(JSON.parse(c.arguments || "{}"));
      } catch {
        /* ignore malformed args */
      }
      return `${calls.length > 1 ? `${i + 1}. ` : ""}${bold}${c.name}${bold}${args ? ` — \`${args}\`` : ""}`;
    })
    .join("\n");
}

/** Confirmation prompt for one or several pending risky actions. */
export function pendingConfirmPrompt(calls: PendingAction[], bold = "**"): string {
  const body = listPendingActions(calls, bold);
  return calls.length > 1
    ? `Mia ingin melakukan ${calls.length} aksi berikut:\n${body}\nBalas \`ya\` untuk semua, \`ya 1,3\` untuk memilih sebagian, atau \`tidak\` untuk membatalkan.`
    : `Mia ingin melakukan aksi berikut: ${body}\nBalas \`ya\` untuk lanjut, atau \`tidak\` untuk membatalkan.`;
}

/**
 * Parse a yes/no/selective reply against N pending actions. Returns one boolean
 * per action, or null when the reply isn't understood (caller re-prompts so a
 * stray message never silently approves or drops a risky action).
 */
export function parseConfirmReply(text: string, count: number): boolean[] | null {
  const t = (text ?? "").trim();
  if (/^(tidak|no|n|gak|nggak|skip|cancel|batal)$/i.test(t)) {
    return Array.from({ length: count }, () => false);
  }
  if (/^(ya|yes|y|setuju|lanjut|ok|oke)$/i.test(t)) {
    return Array.from({ length: count }, () => true);
  }
  const sel = /^(?:ya|yes|ok|oke)\s+([\d,\s]+)$/i.exec(t);
  if (sel) {
    const picked = new Set(
      (sel[1].match(/\d+/g) || [])
        .map((n) => Number(n) - 1)
        .filter((i) => i >= 0 && i < count)
    );
    if (picked.size === 0) return null;
    return Array.from({ length: count }, (_, i) => picked.has(i));
  }
  return null;
}