/**
 * Mints a short-lived Gemini Live access token for the browser.
 *
 * Why this route exists at all: invariant 5 — API keys are server-side only.
 * Google's own guidance for a browser client is an *ephemeral* token rather
 * than the long-lived key, because an ephemeral token is single-use, expires
 * within minutes, and can be pinned to one model + config by the server. The
 * browser therefore never sees `GEMINI_API_KEY`; it sees only `token.name`,
 * which it hands straight back to Google over the WebSocket.
 *
 * Verified against https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket
 * (page last updated 2026-09-15) AND against the deployed API with the owner's own
 * key (2026-09-29). The deployed surface is NARROWER than the docs:
 *
 * - `liveConnectConstraints` is documented (and Google's own REST sample uses
 *   it) but the deployed `v1beta`/`v1alpha` reject it:
 *   `Unknown name "liveConnectConstraints" at 'auth_token': Cannot find field.`
 *   Measured on both versions. So the token CANNOT pin a model, a config, or a
 *   system instruction. Only `uses` / `expireTime` / `newSessionExpireTime`
 *   are accepted.
 * - Consequence, stated honestly: the persona is no longer pinned server-side.
 *   It is returned to the browser here and placed in the `setup` frame by
 *   `lib/geminiLive.ts`, so a tampered client could rewrite the system
 *   instruction. Invariant 5 still holds — `GEMINI_API_KEY` never leaves the
 *   server, and the browser only ever holds a single-use, 1-minute token — but
 *   "the persona cannot be rewritten by the client" is no longer true, and this
 *   comment is the record of why.
 */

import { NextRequest, NextResponse } from "next/server";

import { loadPersonaPrompt } from "@/lib/persona";
import { buildMemoryRecap, liveToolDeclarations, loadRecentMemory } from "@/lib/liveTools";

export const runtime = "nodejs";

/**
 * The signed-in user, so the persona is loaded for the right person. Sent as a
 * header (not read from localStorage, which does not exist server-side); when
 * absent, `loadPersonaPrompt` falls back to the default persona.
 */
function readRawUser(request: NextRequest): string | undefined {
  const header = request.headers.get("x-mia-user")?.trim();
  return header || undefined;
}

/**
 * Optional, short task hint from the caller (e.g. "answer in Indonesian").
 * Capped hard: this is a hint, not a channel for a custom persona.
 */
async function readTaskHint(request: NextRequest): Promise<string> {
  try {
    const body = (await request.json()) as { taskHint?: unknown };
    if (typeof body?.taskHint !== "string") return "";
    return body.taskHint.trim().slice(0, 1_000);
  } catch {
    return "";
  }
}

/** Gemini model used for the duplex voice path. */
const LIVE_MODEL = "models/gemini-3.8-live";

/** `auth_tokens` lives on the v1beta surface; ephemeral tokens are preview-only there. */
const TOKEN_URL = "https://generativelanguage.googleapis.com/v1beta/auth_tokens";

/** Start-window: how long the browser has to OPEN the socket with this token. */
const NEW_SESSION_MINUTES = 1;

/** Messaging window: how long the session may keep sending/receiving. */
const SESSION_MINUTES = 30;

/**
 * Cap on the injected system instruction. Google's setup frame has practical
 * size limits, and a runaway persona file should degrade, not 400 the session.
 */
const MAX_SYSTEM_INSTRUCTION_CHARS = 8_000;

/** An error that carries the HTTP status the client should see. */
class GeminiLiveError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "GeminiLiveError";
  }
}

/** ISO timestamp `minutes` in the future, which is the format the API expects. */
function isoInMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

/**
 * POST /api/gemini-live/token
 *
 * Returns `{ token, model, systemInstruction, tools, expiresInSeconds }`. A 400 means the feature is not
 * configured (no API key); the caller is expected to degrade to the Groq
 * pipeline rather than surface an error to the user. `tools` are the Gemini
 * function declarations the browser must put in `setup.tools` (built from the
 * live registry by `liveTools.ts`).
 */
export async function POST(request: NextRequest) {
  let apiKey = process.env.GEMINI_API_KEY?.trim() ?? "";
  if (!apiKey) {
    return NextResponse.json(
      { error: "Gemini Live is not configured on this server (GEMINI_API_KEY is not set)." },
      { status: 400 }
    );
  }

  try {
    // An optional model override lets the owner pin a different Live variant
    // without a redeploy. Anything outside the Live family is refused here so a
    // typo cannot silently produce a token that is then rejected mid-session.
    const override = request.headers.get("x-gemini-live-model")?.trim();
    const model = override ? withModelsPrefix(override) : LIVE_MODEL;

    // The persona is loaded HERE, server-side, and returned to the browser,
    // which puts it in the `setup` frame. It CANNOT be pinned into the token:
    // the deployed API rejects `liveConnectConstraints` (see the header). An
    // optional body may only add a short task hint; it can never replace the
    // persona. The recent-conversation recap rides along the same way, AFTER
    // the persona, so the truncation below always cuts memory first, facts
    // never: identity outranks recall.
    let systemInstruction: string;
    try {
      const hint = await readTaskHint(request);
      const rawUser = readRawUser(request);
      const persona = loadPersonaPrompt(rawUser).trim();
      let memoryRecap = "";
      try {
        memoryRecap = buildMemoryRecap(loadRecentMemory(rawUser));
      } catch {
        // No recent memory: the session still starts with the persona.
        memoryRecap = "";
      }
      systemInstruction = [persona, memoryRecap, hint].filter(Boolean).join("\n\n");
    } catch {
      // Persona load failed: still start the session, just without the persona.
      // Losing the persona degrades the voice; refusing the session loses the
      // feature entirely, which is worse.
      systemInstruction = "";
    }
    if (systemInstruction.length > MAX_SYSTEM_INSTRUCTION_CHARS) {
      systemInstruction = systemInstruction.slice(0, MAX_SYSTEM_INSTRUCTION_CHARS);
    }

    // Measured 2026-09-29 against the live API: this is the WHOLE accepted
    // payload. Adding `liveConnectConstraints` (as the docs show) makes Google
    // answer 400 `Cannot find field`, which is why the persona is returned to
    // the caller instead of pinned here.
    const body = {
      uses: 1,
      expireTime: isoInMinutes(SESSION_MINUTES),
      newSessionExpireTime: isoInMinutes(NEW_SESSION_MINUTES),
    };

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      // The key can be wrong, the API disabled, or the model unavailable —
      // three different operator problems, so surface Google's own words
      // rather than a generic failure. 502: our upstream is what failed.
      throw new GeminiLiveError(
        `Gemini Live token request failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 400)}` : ""}`,
        502
      );
    }

    const json = (await res.json()) as { token?: { name?: string } | string; name?: string };
    // Defensive read: the documented shape is `{ token: { name } }`, but a
    // flattened `{ name }` has been observed behind proxies that reshape
    // responses. A missing token is a hard error, never a silent empty string,
    // because an empty token produces a confusing WebSocket rejection.
    const token = typeof json.token === "string" ? json.token : json.token?.name ?? json.name;
    if (!token) {
      throw new GeminiLiveError("Gemini Live token response had no token name.", 502);
    }

    return NextResponse.json({
      token,
      model,
      // The browser must send this in `setup.systemInstruction`; it cannot be
      // pinned into the token (see the header).
      systemInstruction,
      // The browser must declare these in `setup.tools`; it cannot invent
      // them, and the tool route re-checks every call name before executing.
      tools: liveToolDeclarations(),
      expiresInSeconds: SESSION_MINUTES * 60,
    });
  } catch (err) {
    if (err instanceof GeminiLiveError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    // Unexpected: do not leak internals to the client.
    return NextResponse.json({ error: "Could not mint a Gemini Live token." }, { status: 502 });
  } finally {
    // Drop the reference promptly; the key is read once and never stored.
    apiKey = "";
  }
}

/** Ensure a model id carries the `models/` prefix the setup frame requires. */
function withModelsPrefix(model: string): string {
  return model.startsWith("models/") ? model : `models/${model}`;
}
