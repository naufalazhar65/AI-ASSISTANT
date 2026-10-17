// Proactive-output sink shared by the bots (Fase 3 Automation + Fase 4 cross-channel).
//
// Each channel adapter registers a send function here at startup under its
// label. Two consumers:
//   - Scheduled-automation results use `pushToOwner` → the owner's most
//     recently-registered active channel (delivered exactly once).
//   - The `send_channel` tool uses `sendToChannel(label, content)` to forward a
//     turn's answer to another registered channel (Telegram ↔ Discord).
//
// IMPORTANT: bots register from `instrumentation-node.ts` while tools dispatch
// from route handlers/bundles — Next compiles these into distinct webpack
// modules, so a module-level singleton would give each a separate `senders`.
// We therefore store the registry on `globalThis` (shared process state so both
// bundles see the same senders), not at module scope.

type Sender = (content: string) => Promise<unknown>;

type PushState = {
  senders: Record<string, Sender>;
  lastRegistered: string | null;
};

const GKEY = "__pushTargetState__";

function state(): PushState {
  const g = globalThis as Record<string, unknown>;
  if (!g[GKEY]) g[GKEY] = { senders: {}, lastRegistered: null };
  return g[GKEY] as PushState;
}

/**
 * Register (or update) this channel label's proactive-output sender.
 * `pushToOwner` delivers to the most recently registered label; cross-channel
 * `sendToChannel` can reach any registered label. Registering replaces only the
 * sender for that label — it no longer bumps other channels out.
 */
export function registerPushTarget(label: string, send: Sender): void {
  const s = state();
  s.senders[label] = send;
  s.lastRegistered = label;
  console.log(`[push] target registered: ${label} (live keys=${Object.keys(s.senders).join(",") || "(none)"})`);
}

/** Labels of all currently registered channels (for the send_channel tool). */
export function listChannels(): string[] {
  return Object.keys(state().senders);
}

/**
 * Deliver a proactive message to the owner's channel: the most recently
 * registered label first, then any other registered label until one accepts it.
 * Returns false when NO channel could take it.
 *
 * The fallback chain matters because "most recently registered" is boot order,
 * not owner activity — live 2026-10-17: `slack-michelle` registered last, so every
 * automation result died with "no slack owner channel seen" and
 * "[automation] no active channel to deliver …", even though Telegram/Discord/Slack
 * were all connected. Each label is tried at most once, and the first success wins
 * so a message is still delivered exactly once.
 */
export async function pushToOwner(content: string): Promise<boolean> {
  const s = state();
  const labels = s.lastRegistered
    ? [s.lastRegistered, ...Object.keys(s.senders).filter((l) => l !== s.lastRegistered)]
    : Object.keys(s.senders);
  for (const label of labels) {
    if (!s.senders[label]) continue;
    if (await deliver(label, content)) return true;
  }
  return false;
}

/**
 * Send a message to a specific channel by label. Returns a human-readable
 * outcome string (used by the send_channel tool), or throws on unknown label.
 */
export async function sendToChannel(label: string, content: string): Promise<string> {
  const s = state();
  const send = s.senders[label];
  if (!send) {
    throw new Error(
      `channel "${label}" is not available. Available: ${listChannels().join(", ") || "(none)"}`
    );
  }
  try {
    await send(content);
    return `Sent to ${label}.`;
  } catch (err) {
    throw new Error(`failed to send to ${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function deliver(label: string, content: string): Promise<boolean> {
  const s = state();
  try {
    await s.senders[label](content);
    return true;
  } catch (err) {
    console.warn(`[push] ${label} push failed:`, err instanceof Error ? err.message : String(err));
    return false;
  }
}
