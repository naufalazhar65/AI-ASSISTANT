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
import { defaultProviderId } from "./providers";
import { pushToOwner } from "../channels/pushTarget";
import { addCorrection } from "./corrections";
import { appendDailyMemory } from "./dailyMemory";

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
    const prompt =
      "Ini laporan terjadwal (automation). Tugasmu: jawab langsung dari pengetahuanmu, " +
      "atau pakai web_search/calculate kalau butuh data baru. JANGAN pakai tool yang butuh " +
      "persetujuan (fetch_url, create_automation, dsb) — tool itu otomatis ditolak. " +
      `[Scheduled automation] ${automation.prompt}`;
    const result = await runAssistantTurn({
      messages: [{ role: "user", content: prompt }],
      provider: process.env.AUTOMATION_PROVIDER ?? defaultProviderId(),
      user,
      channel: "discord",
      // No human is watching an automation run, so risky tools (save_note,
      // remind_me, fetch_url, ...) must be auto-denied instead of pausing for a
      // confirmation nobody can answer — which previously produced empty replies.
      autoDenyRisky: true,
    });
    const text = (result.text || "").trim() || "Maaf, aku belum bisa menjawab permintaan ini pada jadwal otomatis. Coba minta langsung ya. 🌸";
    const delivered = await pushToOwner(`🌸 ${text}\n\n(ini buat jadwal yang kamu minta: ${automation.prompt})`);
    if (!delivered) {
      console.warn(`[automation] no active channel to deliver "${automation.prompt}"`);
      // Self-correction: remember that delivery failed so next time we ensure Telegram channel
      try {
        addCorrection(`automation "${automation.prompt}" delivery failed (no active channel)`, `automation "${automation.prompt}" must deliver via pushToOwner to Telegram`, user);
        appendDailyMemory(user, `[self-correct] automation "${automation.prompt}" delivery failed — no active channel, will ensure Telegram delivery next time`);
      } catch { /* best-effort */ }
    } else {
      // Successful delivery clears any prior correction? No — keep history for learning
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[automation] failed:", msg);
    try {
      addCorrection(`automation "${automation.prompt}" exec failed: ${msg}`, `automation "${automation.prompt}" should use remind_me or correct tool with delivery`, user);
      appendDailyMemory(user, `[self-correct] automation "${automation.prompt}" exec failed: ${msg} — will use correct tool with delivery next time`);
    } catch { /* best-effort */ }
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
