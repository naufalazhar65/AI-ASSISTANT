/**
 * Node-only instrumentation. Imported (not baked in) by `./instrumentation.ts`
 * when NEXT_RUNTIME === "nodejs", so webpack never bundles the node:fs
 * assistant core for the edge runtime (see docs: importing runtime-specific
 * code).
 */
export async function registerNode(): Promise<void> {
  try {
    const { isValidTelegramConfig, startTelegramBot } = await import("@/channels/telegram");
    if (isValidTelegramConfig()) {
      await startTelegramBot();
    } else {
      console.log("[telegram] not configured — skipping bot start");
    }
  } catch (err) {
    console.error("[telegram] failed to start bot:", err instanceof Error ? err.message : String(err));
  }
  try {
    const { isValidDiscordConfig, startDiscordBot } = await import("@/channels/discord");
    if (isValidDiscordConfig()) {
      await startDiscordBot();
    } else {
      console.log("[discord] not configured — skipping bot start");
    }
  } catch (err) {
    console.error("[discord] failed to start bot:", err instanceof Error ? err.message : String(err));
  }
}
