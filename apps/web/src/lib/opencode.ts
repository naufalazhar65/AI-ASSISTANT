/**
 * Native OpenCode agent turn (server-side only).
 *
 * OpenCode's local `opencode serve` (default http://127.0.0.1:4096) exposes a
 * proprietary session/agent API, NOT an OpenAI-compatible /v1/chat/completions
 * endpoint. The older provider wiring pointed "opencode" at the voice app's own
 * proxy (localhost:20128) — a circular, broken path. This module talks to the
 * real OpenCode server: it creates a fresh session, posts the conversation as
 * text parts via prompt_async, and streams the assistant's growing text part
 * (from the /event SSE channel) back in deltas. The voice app's own STT/LLM
 * proxy/TTS layers stay untouched — this is a pure server-side transport swap.
 *
 * Keys/endpoints never reach the browser (invariant 5); the server is local and
 * unauthenticated, so no secrets are involved.
 */

export type OpenCodeChatMessage = {
  role: string;
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};

export const OPENCODE_SERVER =
  process.env.OPENCODE_SERVER_BASE || "http://127.0.0.1:4096";

/** Optional default provider/model for the OpenCode session (server default when omitted). */
const DEFAULT_MODEL = process.env.OPENCODE_MODEL; // e.g. "9router/ngoding"
const DEFAULT_PROVIDER = process.env.OPENCODE_PROVIDER; // e.g. "9router"

/**
 * Hard cap on one OpenCode turn (ms). A conversational answer takes a few
 * seconds; if the agent ever stalls (e.g. a tool loop we didn't prevent) we
 * abort its session and error the route rather than hold the client's stream
 * open indefinitely.
 */
const TURN_TIMEOUT_MS = Number(process.env.OPENCODE_TURN_TIMEOUT_MS || 60000);

/**
 * Run one native OpenCode agent turn. Creates a fresh session, sends the
 * conversation, and streams the assistant's text via `onDelta` (each call is the
 * new suffix of accumulated text since the previous call). Resolves with the
 * full assistant text once the turn finishes. Aborts cleanly on `signal`.
 */
export async function runOpenCodeTurn(opts: {
  systemPrompt: string;
  messages: OpenCodeChatMessage[];
  onDelta: (delta: string) => void;
  signal: AbortSignal;
}): Promise<string> {
  const { systemPrompt, messages, onDelta, signal } = opts;
  const base = OPENCODE_SERVER.replace(/\/$/, "");

  // 1. Create a fresh session.
  const created = await fetch(`${base}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({ title: "voice-assistant" }),
  });
  if (!created.ok) throw new Error(`OpenCode session create failed (${created.status})`);
  const { id: sessionID } = (await created.json()) as { id: string };

  // Watchdog (function scope so cleanup can clear it): if the turn takes too
  // long (agent stall, tool loop, hung model) abort the OpenCode session so the
  // route can error instead of holding the client's stream open.
  let watchdog: ReturnType<typeof setTimeout> | undefined;

  try {
    // 2. Subscribe to the project event stream BEFORE prompting so we never miss
    //    the assistant text part. The server emits `server.connected` first.
    const eventRes = await fetch(`${base}/event`, { signal });
    if (!eventRes.ok || !eventRes.body) {
      throw new Error(`OpenCode event stream failed (${eventRes.status})`);
    }
    const eventReader = eventRes.body.getReader();
    const decoder = new TextDecoder();
    let sseBuf = "";

    // Build the prompt parts: a system part carrying the assistant's persona,
    // then one text part per conversation message as prior context.
    const parts: { type: "text"; text: string }[] = [
      { type: "text", text: systemPrompt },
    ];
    for (const m of messages) {
      if (m.role === "user" && typeof m.content === "string" && m.content.trim()) {
        parts.push({ type: "text", text: m.content });
      } else if (m.role === "assistant" && typeof m.content === "string" && m.content.trim()) {
        parts.push({ type: "text", text: `[Previously said by you: ${m.content}]` });
      }
    }

    // 3. Fire the async prompt (204 immediately; progress arrives via /event).
    const promptBody: Record<string, unknown> = { parts };
    if (DEFAULT_PROVIDER && DEFAULT_MODEL) {
      promptBody.model = { providerID: DEFAULT_PROVIDER, modelID: DEFAULT_MODEL };
    }
    const promptRes = await fetch(`${base}/session/${sessionID}/prompt_async`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify(promptBody),
    });
    if (!promptRes.ok) {
      const detail = await promptRes.text().catch(() => "");
      throw new Error(`OpenCode prompt failed (${promptRes.status}): ${detail}`);
    }

    // 4. Read the SSE stream, diff the assistant's text part, emit deltas.
    //    We only stream text belonging to the assistant's reply message: the
    //    prompt's own text parts (system + conversation) also arrive as
    //    `message.part.updated` and would otherwise be mistaken for the answer.
    //    The assistant reply is identified deterministically: its role is
    //    "assistant" (it has a parentID pointing back at the user message) and
    //    its text grows in place across `message.part.updated` events.
    let done = false;
    let assistantMessageID: string | null = null;
    let accumulated = "";
    let finalText = "";

    // Watchdog: if the turn takes too long (agent stall, tool loop, hung model),
    // abort the OpenCode session so the route can error instead of hanging.
    watchdog = setTimeout(
      () => {
        fetch(`${base}/session/${sessionID}/abort`, { method: "POST", signal }).catch(() => {});
      },
      TURN_TIMEOUT_MS,
    );

    // Auto-respond to any tool-permission prompt so a voice turn never blocks on
    // a confirmation-with-no-UI. Read-only lookups (web_search, filesystem read)
    // are auto-ALLOWED; anything that could modify the system (bash, write, edit,
    // delete) is auto-DENIED. The assistant's own server-side tools still go
    // through FR-014.
    const autoRespondPermission = (permission: unknown) => {
      const p = permission as {
        permissionID?: string;
        id?: string;
        tool?: string;
        permission?: { tool?: string };
      };
      const id = p?.permissionID || p?.id;
      if (!id) return;
      const toolName = p?.tool || p?.permission?.tool || "";
      const plain = toolName.toLowerCase();
      const readOnly =
        plain.includes("web_search") ||
        plain.includes("search") ||
        plain.includes("file_read") ||
        plain.includes("read") ||
        plain.includes("browser");
      const response = readOnly ? "allow" : "deny";
      if (response === "deny") {
        // Log for debugging which tool got blocked.
        // eslint-disable-next-line no-console
        if (process.env.OPENCODE_DEBUG) console.log(`[opencode] auto-${response} tool=${toolName}`);
      }
      const replyUrl = `${base}/session/${sessionID}/permissions/${id}`;
      fetch(replyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({ response }),
      }).catch(() => {});
    };

    const handleEvent = (data: string) => {
      let parsed: {
        type: string;
        properties?: {
          sessionID?: string;
          id?: string;
          permission?: unknown;
          part?: { type?: string; text?: string; messageID?: string };
          info?: { id?: string; role?: string; parentID?: string; finish?: string };
        };
      };
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      const props = parsed.properties ?? {};

      if (parsed.type === "permission.updated") {
        autoRespondPermission(props.permission ?? props.id ?? "");
        return;
      }

      if (parsed.type === "message.updated") {
        const info = props.info ?? {};
        if (info.role === "assistant" && info.id && info.parentID) {
          assistantMessageID = info.id;
        }
        if (info.role === "assistant" && info.finish === "stop") {
          done = true;
        }
      } else if (parsed.type === "message.part.updated" && props.part?.type === "text") {
        if (props.sessionID && props.sessionID !== sessionID) return;
        const part = props.part;
        const mid = part.messageID ?? "";
        // Skip prompt (user) parts; only stream the assistant reply's text.
        if (assistantMessageID && mid === assistantMessageID) {
          const text = part.text ?? "";
          if (text.length > accumulated.length) {
            const delta = text.slice(accumulated.length);
            accumulated = text;
            finalText = text;
            if (delta && !signal.aborted) onDelta(delta);
          } else if (text.length > 0) {
            finalText = text;
          }
        }
      }
    };

    for (;;) {
      const { done: readerDone, value } = await eventReader.read();
      if (readerDone) break;
      sseBuf += decoder.decode(value, { stream: true });
      let nlIdx;
      while ((nlIdx = sseBuf.indexOf("\n")) !== -1) {
        const line = sseBuf.slice(0, nlIdx).trim();
        sseBuf = sseBuf.slice(nlIdx + 1);
        if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          if (payload) handleEvent(payload);
        }
      }
      if (done) break;
      if (signal.aborted) break;
    }
    eventReader.cancel().catch(() => {});
    if (watchdog) clearTimeout(watchdog);
    return finalText || accumulated;
  } finally {
    // Best-effort cleanup: deleting the temp session avoids session bloat.
    if (watchdog) clearTimeout(watchdog);
    fetch(`${base}/session/${sessionID}`, { method: "DELETE", signal }).catch(() => {});
  }
}
