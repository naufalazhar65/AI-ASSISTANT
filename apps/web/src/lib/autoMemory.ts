/**
 * Deterministic "lived persona" capture (OpenClaw-style automatic memory).
 *
 * The older design asked the model to _voluntarily_ append a hidden `<persona>`
 * tag to its reply, which models (especially the local OpenCode one) often skip.
 * This module instead runs a dedicated, non-streaming extraction pass after each
 * turn: it asks the model to report any *new* stable fact or style preference it
 * learned about the user, with output normalized to the same `<persona>` tag
 * format, then persists each entry via `upsertPersonaFact`. Because extraction
 * is driven by an explicit prompt (not a "please remember to tag yourself"
 * aside), it is far more reliable and mirrors how OpenClaw stores memory.
 *
 * The pass is error-tolerant and never throws into the caller: if extraction or
 * an upstream call fails, we swallow it so the main answer is unaffected.
 *
 * Server-side only (imports node:fs via persona.ts).
 */

import { upsertPersonaFact } from "./persona";
import { runOpenCodeTurn, OpenCodeChatMessage } from "./opencode";

export type FactEntry = { target: "USER" | "SOUL"; key: string; value: string };

/** Parse one or more `<persona>user.a=X;soul.b=Y</persona>` tags into entries. */
export function parsePersonaTag(text: string): FactEntry[] {
  const entries: FactEntry[] = [];
  const tagRe = /<persona>([^<]*)<\/persona>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text))) {
    const body = m[1];
    for (const part of body.split(";")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const target = trimmed.startsWith("user.") ? "USER" : trimmed.startsWith("soul.") ? "SOUL" : null;
      if (!target) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(target === "USER" ? 5 : 5, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (key && value) entries.push({ target, key, value });
    }
  }
  return entries;
}

const EXTRACT_PROMPT = [
  "You are the memory layer of a voice assistant. Below is a short transcript of ",
  "the user's latest turn and your answer.",
  "Report ONLY stable facts about the user that are NEW (not already known) and ",
  "worth remembering: identity/language/location/preferences, and how I should ",
  "speak (style/tone/honorific such as a greeting name). ",
  "Ignore small talk, transient statements, and anything already shown in the ",
  "persona below.",
  'Reply with a single line in exactly this format: ',
  '<persona>user.name=Naufal;soul.tone=formal</persona>. ',
  "Use 'user.' for facts about the user and 'soul.' for style preferences. ",
  "If there is nothing new, reply with just the word NONE (nothing else).",
].join("");

type ExtractionOpts = {
  url: string;
  apiKey: string;
  defaultModel: string;
  persona: string;
  messages: { role: string; content: string | null }[];
};

/** Non-streaming extraction against any OpenAI-compatible endpoint. */
async function extractFactsOpenAi(opts: ExtractionOpts): Promise<FactEntry[]> {
  const { url, apiKey, defaultModel, persona, messages } = opts;
  const promptParts = [EXTRACT_PROMPT, `Current persona:\n${persona}`];
  const probe = messages
    .filter((m) => m.role === "user" && m.content)
    .slice(-4)
    .map((m) => m.content)
    .join("\n");
  const body = JSON.stringify({
    model: defaultModel,
    messages: [
      { role: "system", content: promptParts.join("\n\n") },
      { role: "user", content: `Transcript:\n${probe}\n\nWhat (if anything) should be remembered?` },
    ],
    stream: false,
    temperature: 0,
  });
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body,
  });
  if (!res.ok) return [];
  const json = (await res.json().catch(() => null)) as {
    choices?: { message?: { content?: string | null } }[];
  } | null;
  const content = json?.choices?.[0]?.message?.content;
  if (!content || content.trim().toUpperCase().startsWith("NONE")) return [];
  return parsePersonaTag(content);
}

async function extractFactsOpenCode(opts: Omit<ExtractionOpts, "url" | "apiKey" | "defaultModel">): Promise<FactEntry[]> {
  const { persona, messages } = opts;
  const promptParts = [EXTRACT_PROMPT, `Current persona:\n${persona}`];
  const probe = messages
    .filter((m) => m.role === "user" && m.content)
    .slice(-4)
    .map((m) => m.content)
    .join("\n");
  const systemPrompt = [
    "Reply to the following memory-extraction request. Follow its output format exactly.",
  ].join("");
  let text = "";
  await runOpenCodeTurn({
    systemPrompt,
    messages: [
      { role: "user", content: promptParts.join("\n\n") + `\n\nTranscript:\n${probe}\n\nWhat (if anything) should be remembered?` },
    ] as OpenCodeChatMessage[],
    signal: new AbortController().signal,
    onDelta: (d) => {
      text += d;
    },
  });
  if (!text || text.trim().toUpperCase().startsWith("NONE")) return [];
  return parsePersonaTag(text);
}

export type CaptureArgs = {
  providerId: string;
  url?: string;
  apiKey?: string;
  defaultModel?: string;
  persona: string;
  messages: { role: string; content: string | null }[];
  rawUser?: unknown;
};

/**
 * Capture and persist any new user facts from this turn. Best effort: every
 * failure is swallowed so memory never breaks an answer. Returns the number of
 * facts persisted (for logging), or 0.
 */
export async function captureFactsFromTurn(args: CaptureArgs): Promise<number> {
  try {
    const hasUserContent = args.messages.some((m) => m.role === "user" && m.content && m.content.trim());
    if (!hasUserContent) return 0;

    let facts: FactEntry[] = [];
    if (args.providerId === "opencode") {
      facts = await extractFactsOpenCode({ persona: args.persona, messages: args.messages });
    } else if (args.url && args.apiKey && args.defaultModel) {
      facts = await extractFactsOpenAi({
        url: args.url,
        apiKey: args.apiKey,
        defaultModel: args.defaultModel,
        persona: args.persona,
        messages: args.messages,
      });
    } else {
      return 0;
    }

    for (const f of facts) {
      upsertPersonaFact(f.target, f.key, f.value, args.rawUser);
    }
    console.log(`[autoMemory] persisted ${facts.length} fact(s):`, facts.map((f) => `${f.target}.${f.key}=${f.value}`).join(", "));
    return facts.length;
  } catch (err) {
    console.warn("[autoMemory] capture skipped:", err instanceof Error ? err.message : String(err));
    return 0;
  }
}
