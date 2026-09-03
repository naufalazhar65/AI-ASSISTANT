// Proactive-output sink shared by the bots (Fase 3 Automation).
//
// Proactive output (currently scheduled-automation results) must reach the
// owner's *active* channel without the runner knowing which channel adapter is
// live. Each channel registers a send function here at startup; the automation
// runner calls `pushToOwner` and the most recently-seen active channel wins.
// This keeps the channel-adapter abstraction intact (runner never couples to a
// specific bot) and runs the expensive LLM turn exactly once.

type Sender = (content: string) => Promise<unknown>;

let sender: { label: string; send: Sender } | null = null;

/** Register this channel as a candidate for proactive output delivery. */
export function registerPushTarget(label: string, send: Sender): void {
  sender = { label, send };
  console.log(`[push] proactive output target: ${label}`);
}

/**
 * Deliver a proactive message to the currently-registered channel. Returns
 * false when no channel is available (e.g. neither bot started / no owner seen).
 */
export async function pushToOwner(content: string): Promise<boolean> {
  if (!sender) return false;
  try {
    await sender.send(content);
    return true;
  } catch (err) {
    console.warn(`[push] ${sender.label} push failed:`, err instanceof Error ? err.message : String(err));
    sender = null;
    return false;
  }
}
