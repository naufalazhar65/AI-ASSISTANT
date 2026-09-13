// freerideWatcher.ts — mandiri watcher 60s (no ~/.openclaw freeride-watcher daemon)
// Probes primary every 60s, auto-rotates fallbacks if rate-limited — companion to heartbeat/automationRunner

import { freerideWatcherOnce } from "./freeride";

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startFreerideWatcher(): void {
  if (timer) return;
  // Run once after 30s warmup, then every 60s
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const res = await freerideWatcherOnce();
      // Only log when rotating/failing to avoid spam
      if (res.includes("failed") || res.includes("rotated")) {
        const { logInfo } = await import("./appLogger");
        logInfo("freeride", res);
      }
    } catch (e) {
      try {
        const { logError } = await import("./appLogger");
        logError("freeride", `watcher error: ${e instanceof Error ? e.message : String(e)}`);
      } catch {}
    } finally {
      running = false;
    }
  };
  setTimeout(run, 30_000);
  timer = setInterval(run, 60_000);
  // Allow process to exit if only this timer remains (not needed for Next dev, but good for tests)
  if (timer && typeof (timer as unknown as { unref?: () => void }).unref === "function") (timer as unknown as { unref: () => void }).unref!();
}

export function stopFreerideWatcher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
