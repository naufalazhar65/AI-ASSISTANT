// The head of a message window must be sendable.
//
// Every channel trims history before sending it (a cap on messages, a rolling
// summary, a client-side window). The trim can land in the MIDDLE of a tool
// round, so the window may start with an assistant message that proposes a
// tool — with no user turn before it.
//
// The upstream gateway rejects exactly that shape with 400 "Please ensure
// that function call turn comes immediately after a user turn or after a
// function response turn." — and the rejection POISONS THE KEY: every later
// request (even a plain one) fails with the same 400 for the next ~30
// seconds. Measured 2026-10-21 by probing the gateway directly, one shape per
// process with the cooldown settled in between:
//
//   user-head                → 200 OK
//   assistant-text-head      → 200 OK
//   tool-result-head         → 200 OK
//   assistant-with-toolcalls → 400  ← the only rejected shape
//
// The same probe with a system prompt in front gave the same verdict, so the
// system prompt does not make the shape acceptable.
//
// So the head is trimmed until it can be sent. What is dropped was context the
// model no longer needs anyway, and dropping it is better than a dead turn —
// and better than a dead KEY for the next half minute.
//
// This module is pure and has no imports on purpose: the agent (every
// channel), the rolling summary and the office chat route all use it, and a
// helper that all of them depend on must not depend on any of them.

export interface WindowMessage {
  role?: string;
  tool_calls?: unknown[];
}

/**
 * True when the message can start a request. A user turn always can. An
 * assistant turn can only when it proposes no tool — a function-call turn
 * needs a user turn (or a function response) right before it, and at the head
 * of the window there is none.
 */
export function isSafeWindowHead(message: WindowMessage | undefined): boolean {
  if (!message) return false;
  if (message.role === "user") return true;
  return message.role === "assistant" && !(message.tool_calls?.length ?? 0);
}

/**
 * Drop the leading messages until the window starts with something the
 * gateway accepts.
 *
 * A function-call turn is dropped together with the tool results that answer
 * it: keeping the results without their declaration would leave an orphan
 * tool message, which strict OpenAI-compatible gateways reject with
 * "Messages with role 'tool' must be a response to a preceding message with
 * 'tool_calls'". A leading tool result whose declaration was already trimmed
 * away is an orphan for the same reason and goes too.
 */
export function trimToSafeWindowHead<T extends WindowMessage>(messages: T[]): T[] {
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (isSafeWindowHead(m)) break;
    if (m?.role === "assistant") {
      // A function-call turn: drop it and the tool results that answer it.
      i += 1;
      while (i < messages.length && messages[i]?.role === "tool") i += 1;
      continue;
    }
    // An orphan tool result (its declaring assistant was trimmed away).
    i += 1;
  }
  return i === 0 ? messages : messages.slice(i);
}
