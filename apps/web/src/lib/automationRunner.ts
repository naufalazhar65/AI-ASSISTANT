// Scheduled-automation runner (Fase 3). Server-side only, started once in
// instrumentation-node.ts.
//
// For each due automation we run ONE assistant turn in the background (never
// blocking the request path) and push the resulting text to the owner's active
// channel via the shared push-target sink. Because the turn can take seconds,
// runs are guarded so overlapping triggers for the same automation don't pile
// up, and failures are logged without stopping later runs.

import { subscribeAutomations, Automation } from "./automations";
import { runAssistantTurn } from "./agent";
import { pushToOwner } from "../channels/pushTarget";

const running = new Set<string>();

function describe(a: Automation): string {
  const s = a.schedule;
  if (s.type === "hourly") return `setiap ${s.everyHours} jam`;
  return `pukul ${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")}`;
}

async function runOne(automation: Automation, user: string): Promise<void> {
  if (running.has(automation.id)) return;
  running.add(automation.id);
  try {
    const result = await runAssistantTurn({
      messages: [{ role: "user", content: `[Scheduled automation] ${automation.prompt}` }],
      provider: process.env.AUTOMATION_PROVIDER ?? "groq",
      user,
      channel: "discord",
    });
    const text = (result.text || "").trim() || `(tidak ada jawaban untuk " ${automation.prompt}")`;
    const delivered = await pushToOwner(`🌸 *Automation* — ${automation.prompt}\n${text}`);
    if (!delivered) {
      console.warn(`[automation] no active channel to deliver "${automation.prompt}"`);
    }
  } catch (err) {
    console.error("[automation] failed:", err instanceof Error ? err.message : String(err));
  } finally {
    running.delete(automation.id);
  }
}

/** Start the automation runner. Idempotent. */
export function startAutomationRunner(): void {
  subscribeAutomations(({ automation, user }) => {
    console.log(`[automation] due "${automation.prompt}" (${describe(automation)}) for ${user}`);
    void runOne(automation, user);
  });
}
