// Heartbeat — periodic agent check-in (Fase 4, gap OpenClaw Tier 2).
// Different from cron/automation (which runs a user-defined prompt on a schedule)
// and from reminders (which fire at an exact time). Heartbeat is the agent's
// own periodic awareness: every N minutes it checks for overdue/due-soon tasks
// and nudges the owner if something needs attention. Silent when nothing is pending.

import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { userDataRoot } from "./users";
import { readTasks } from "./tasks";
import { pushToOwner } from "../channels/pushTarget";

let timer: NodeJS.Timeout | null = null;
let started = false;

function heartbeatIntervalMs(): number {
  const raw = process.env.HEARTBEAT_INTERVAL_MINUTES;
  if (raw !== undefined) {
    const n = Number(raw);
    if (!Number.isNaN(n) && n > 0) return n * 60 * 1000;
    if (n === 0) return 0; // disabled
  }
  return 30 * 60 * 1000; // default 30m
}

function allUserKeys(): string[] {
  const root = userDataRoot();
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((n) => /^[A-Za-z0-9._-]+$/.test(n));
  } catch {
    return [];
  }
}

async function tick(): Promise<void> {
  const now = Date.now();
  const soonThreshold = now + 60 * 60 * 1000; // due within next hour
  for (const user of allUserKeys()) {
    try {
      const tasks = readTasks(user);
      const active = tasks.filter((t) => t.status === "active" && typeof t.dueAt === "number");
      if (!active.length) continue;
      const overdue = active.filter((t) => t.dueAt! < now);
      const dueSoon = active.filter((t) => t.dueAt! >= now && t.dueAt! <= soonThreshold);
      if (!overdue.length && !dueSoon.length) continue;

      const lines: string[] = [];
      if (overdue.length) {
        lines.push(`⚠️ *Overdue* (${overdue.length}):`);
        for (const t of overdue.slice(0, 5)) {
          const ago = Math.round((now - t.dueAt!) / 60000);
          lines.push(`• ${t.text} — lewat ${ago}m`);
        }
      }
      if (dueSoon.length) {
        lines.push(`⏰ *Due soon* (${dueSoon.length}):`);
        for (const t of dueSoon.slice(0, 5)) {
          const mins = Math.round((t.dueAt! - now) / 60000);
          lines.push(`• ${t.text} — dalam ${mins}m`);
        }
      }
      const msg = `💓 *Heartbeat* — cek tugas\n${lines.join("\n")}`;
      const delivered = await pushToOwner(msg);
      if (delivered) console.log(`[heartbeat] notified ${user}: ${overdue.length} overdue, ${dueSoon.length} due soon`);
      else console.log(`[heartbeat] no channel for ${user}, skipped`);
    } catch (e) {
      console.warn(`[heartbeat] check failed for ${user}:`, e instanceof Error ? e.message : String(e));
    }
  }
}

/** Start the heartbeat loop. Idempotent — safe to call twice (Next may invoke twice). */
export function startHeartbeat(): void {
  if (started) return;
  started = true;
  const interval = heartbeatIntervalMs();
  if (!interval) {
    console.log("[heartbeat] disabled (HEARTBEAT_INTERVAL_MINUTES=0)");
    return;
  }
  console.log(`[heartbeat] starting — every ${Math.round(interval / 60000)}m`);
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
