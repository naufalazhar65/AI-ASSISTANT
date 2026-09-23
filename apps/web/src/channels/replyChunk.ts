import { redactArgsForDisplay } from "../lib/args";
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
// Single definition lives in lib/time (shared with the agent's lib-side code).
export { clockLabel } from "../lib/time";

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
  // Collapse runs of SPACES/TABS only — never newlines. The old `\s{2,}` also
  // ate a blank line between list items, so a numbered reply ("1. …\n\n2. …")
  // reached Discord as ONE paragraph with inline numbers.
  t = t.replace(/[ \t]{2,}/g, " ");
  t = t.replace(/[ \t]+\n/g, "\n");
  t = t.replace(/\n{3,}/g, "\n\n");
  // Drop leading/trailing connective junk left by removals (", , . sementara").
  t = t.replace(/^[\s,.;:]+/, "").replace(/[\s,]+$/, "").trim();
  return t;
}

/**
 * Re-open/close ``` fences across split chunks so each chunk renders as valid
 * markdown (a fence cut in half makes Discord/Telegram show raw backticks).
 */
function balanceFences(chunks: string[]): string[] {
  const out: string[] = [];
  let openLang: string | null = null;
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    // Compute the fence state over the chunk's OWN lines first (the prefix we
    // add below must not be counted as a closing fence).
    let open: boolean = openLang !== null;
    let lang: string = openLang ?? "";
    for (const line of chunks[i].split("\n")) {
      const m = /^\s*```(\S*)\s*$/.exec(line);
      if (!m) continue;
      if (!open) {
        open = true;
        lang = m[1] || "";
      } else {
        open = false;
        lang = "";
      }
    }
    let body = (openLang !== null ? `\`\`\`${openLang}\n` : "") + chunks[i];
    if (open && !isLast) body += "\n```";
    out.push(body);
    openLang = open && !isLast ? lang : null;
  }
  return out;
}

/** Split by lines so a ``` fence token is never cut in half; a single line
 *  longer than max breaks at the last space (word boundary, no mid-word cut)
 *  and only hard-splits when the line has no spaces (URLs, JSON blobs). */
function splitByLines(text: string, max: number): string[] {
  const out: string[] = [];
  const pushLongLine = (line: string) => {
    let rest = line;
    while (rest.length > max) {
      let cut = max;
      const sp = rest.lastIndexOf(" ", max);
      if (sp > max * 0.4) cut = sp;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^ +/, "");
      if (!rest) break;
    }
    if (rest) out.push(rest);
  };
  let cur = "";
  for (const line of text.split("\n")) {
    if (line.length > max) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      pushLongLine(line);
      continue;
    }
    if (cur && cur.length + 1 + line.length > max) {
      out.push(cur);
      cur = line;
    } else {
      cur = cur ? `${cur}\n${line}` : line;
    }
  }
  if (cur) out.push(cur);
  return out;
}


/**
 * Mask the local home directory in outbound text ("/Users/name/x" -> "~/x").
 * Tool output/errors often carry absolute paths; they are not secrets but do
 * expose the local username in chats. Pure-ish (uses $HOME). Unit-tested.
 */
export function scrubHomePath(text: string, home = typeof process !== "undefined" ? process.env?.HOME : undefined): string {
  const h = (home || "").replace(/\/$/, "");
  if (!h) return text;
  return text.split(h).join("~");
}

/** Split long replies into channel-safe chunks; code fences stay balanced. */
export function chunkText(text: string, max: number): string[] {
  const safe = scrubHomePath(scrubToolMarkup(text ?? ""));
  if (safe.length <= max) return [safe];
  return balanceFences(splitByLines(safe, max));
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
        args = redactArgsForDisplay(c.arguments || "{}");
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
/** Shown when a turn produced no text at all (a bare "…" looked broken). */
export const EMPTY_REPLY_FALLBACK = "Hmm, jawabannya kepotong — coba tanya lagi ya 🌸";
/** Shown when a slash-command produced no text. */
export const COMMAND_EMPTY_FALLBACK = "Oke beb 🌸";
