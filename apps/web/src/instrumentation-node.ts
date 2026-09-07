/**
 * Node-only instrumentation. Imported (not baked in) by `./instrumentation.ts`
 * when NEXT_RUNTIME === "nodejs", so webpack never bundles the node:fs
 * assistant core for the edge runtime (see docs: importing runtime-specific
 * code).
 */
export async function registerNode(): Promise<void> {
  const { logInfo, logError } = await import("@/lib/appLogger");
  try {
    const { isValidTelegramConfig, startTelegramBot } = await import("@/channels/telegram");
    if (isValidTelegramConfig()) {
      await startTelegramBot();
    } else {
      logInfo("telegram", "not configured — skipping bot start");
    }
  } catch (err) {
    logError("telegram", `failed to start bot: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const { isValidDiscordConfig, startDiscordBot } = await import("@/channels/discord");
    if (isValidDiscordConfig()) {
      await startDiscordBot();
    } else {
      logInfo("discord", "not configured — skipping bot start");
    }
  } catch (err) {
    logError("discord", `failed to start bot: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const { startAutomationRunner } = await import("@/lib/automationRunner");
    startAutomationRunner();
  } catch (err) {
    logError("automation", `failed to start runner: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const { startHeartbeat } = await import("@/lib/heartbeat");
    startHeartbeat();
  } catch (err) {
    logError("heartbeat", `failed to start: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const { startRecapRunner } = await import("@/lib/recap");
    startRecapRunner();
  } catch (err) {
    logError("recap", `failed to start: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const { startBriefingRunner } = await import("@/lib/briefing");
    startBriefingRunner();
  } catch (err) {
    logError("briefing", `failed to start: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const { startContextSampler } = await import("@/lib/context");
    startContextSampler();
  } catch (err) {
    logError("context", `failed to start: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const { backupNow } = await import("@/lib/backup");
    const dest = backupNow();
    logInfo("backup", `auto backup created at ${dest}`);
  } catch (err) {
    logError("backup", `failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
