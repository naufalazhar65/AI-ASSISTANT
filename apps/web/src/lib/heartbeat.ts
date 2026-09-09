// Heartbeat — periodic agent check-in (Fase 4, gap OpenClaw Tier 2).
// Different from cron/automation (which runs a user-defined prompt on a schedule)
// and from reminders (which fire at an exact time). Heartbeat is the agent's
// own periodic awareness: every N minutes it checks for overdue/due-soon tasks
// and nudges the owner if something needs attention. Silent when nothing is pending.

import { readdirSync, existsSync } from "node:fs";
import { userDataRoot, isTestUserKey, canonicalUserKey } from "./users";
import { readTasks } from "./tasks";
import { pushToOwner } from "../channels/pushTarget";
import { heartbeatMinutes } from "./config";
import { logInfo, logError } from "./appLogger";

let timer: NodeJS.Timeout | null = null;
let started = false;

function heartbeatIntervalMs(): number {
  const n = heartbeatMinutes();
  if (n > 0) return n * 60 * 1000;
  return 0; // disabled
}

function allUserKeys(): string[] {
  const root = userDataRoot();
  if (!existsSync(root)) return [];
  try {
    const raw = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((n) => /^[A-Za-z0-9._-]+$/.test(n) && !isTestUserKey(n));
    const seen = new Set<string>();
    const out: string[] = [];
    for (const k of raw) {
      const c = canonicalUserKey(k) || k;
      if (!seen.has(c)) { seen.add(c); out.push(c); }
    }
    return out;
  } catch {
    return [];
  }
}

async function tick(): Promise<void> {
  const now = Date.now();
  const soonThreshold = now + 60 * 60 * 1000; // due within next hour
  for (const user of allUserKeys()) {
    try {
      // Task alerts (existing heartbeat duty).
      const tasks = readTasks(user);
      const active = tasks.filter((t) => t.status === "active" && typeof t.dueAt === "number");
      const overdue = active.filter((t) => t.dueAt! < now);
      const dueSoon = active.filter((t) => t.dueAt! >= now && t.dueAt! <= soonThreshold);
      let taskMsg: string | null = null;
      if (overdue.length || dueSoon.length) {
        const lines: string[] = [];
        if (overdue.length) {
          lines.push(`⚠️ *Ketinggalan* (${overdue.length}) — ayo sikat beb:`);
          for (const t of overdue.slice(0, 5)) {
            const ago = Math.round((now - t.dueAt!) / 60000);
            const agoTxt = ago < 60 ? `${ago}m lewat` : `${Math.floor(ago/60)}j ${ago%60}m lewat`;
            lines.push(`• ${t.text} — ${agoTxt} ⏰ yuk selesaikan`);
          }
        }
        if (dueSoon.length) {
          lines.push(`⏰ *Segera* (${dueSoon.length}) — siap-siap:`);
          for (const t of dueSoon.slice(0, 5)) {
            const mins = Math.round((t.dueAt! - now) / 60000);
            lines.push(`• ${t.text} — ${mins}m lagi 🌸`);
          }
        }
        taskMsg = `💓 *Heartbeat Mia* — cek tugas\n${lines.join("\n")}`;
      }

      // Watchlist + Mac health monitors (crypto/web/device thresholds). This is
      // the ONLY place checkMonitorsAndAlert runs — without it the watchlist
      // never alerted (long-standing wiring gap, fixed 2026-09-07).
      let monitorMsg: string | null = null;
      const { checkMonitorsAndAlert } = await import("./monitor");
      const alerts = await checkMonitorsAndAlert(user);
      if (alerts.length) {
        monitorMsg = `👁️ *Monitor*\n${alerts.map((a) => `• ${a}`).join("\n")}`;
      }

      if (taskMsg) {
        const delivered = await pushToOwner(taskMsg);
        if (delivered) logInfo("heartbeat", `notified ${user}: ${overdue.length} overdue, ${dueSoon.length} due soon`);
        else logInfo("heartbeat", `no channel for ${user}, skipped`);
      }
      if (monitorMsg) {
        const delivered = await pushToOwner(monitorMsg);
        if (delivered) logInfo("heartbeat", `monitor alert for ${user}`);
        else logInfo("heartbeat", `no channel for ${user} (monitor), skipped`);
      }
      if (!taskMsg && !monitorMsg) continue;
    } catch (e) {
      logError("heartbeat", `check failed for ${user}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Intelligence passes riding the heartbeat loop (all guarded/deduped:
  // proactive = once/day + no signal → silent; consolidation = once per past
  // month + marker file). Both best-effort; failures never break the tick.
  try {
    const { runProactiveNudge } = await import("./proactive");
    await runProactiveNudge();
  } catch (e) {
    logError("proactive", `pass failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const { runConsolidationForAllUsers } = await import("./consolidate");
    await runConsolidationForAllUsers();
  } catch (e) {
    logError("consolidate", `pass failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Start the heartbeat loop. Idempotent — safe to call twice (Next may invoke twice). */
export function startHeartbeat(): void {
  if (started) return;
  started = true;
  const interval = heartbeatIntervalMs();
  if (!interval) {
    logInfo("heartbeat", "disabled (HEARTBEAT_INTERVAL_MINUTES=0)");
    return;
  }
  logInfo("heartbeat", `starting — every ${Math.round(interval / 60000)}m`);
  // Run once a short time after boot, then on interval
  setTimeout(() => void tick(), 60 * 1000);
  timer = setInterval(() => void tick(), interval);
  // Do not keep the process alive just for heartbeat in tests
  if (timer && typeof timer.unref === "function") timer.unref();
}

/** For tests: run one tick immediately and return. */
export async function runHeartbeatTick(): Promise<void> {
  await tick();
}

export function stopHeartbeat(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}
