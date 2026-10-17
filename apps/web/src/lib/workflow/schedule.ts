/**
 * Schedule math — pure, no clock, no I/O.
 *
 * Timezone: `Asia/Jakarta` (default, +07:00, no DST) plus fixed offsets
 * `UTC+HH:MM` / `UTC-HH:MM`. Zones that observe DST are pinned to the offset
 * captured when the schedule is created — deliberate, documented limitation
 * (the repo only schedules in Asia/Jakarta; a DST zone needs a tz database).
 * Occurrences are derived from the schedule, never accumulated, so a missed
 * slot cannot shift later ones (no drift).
 */

import type { WorkflowSchedule } from "./types";

const WIB_OFFSET_MS = 7 * 3600_000;

export interface ZoneInfo {
  label: string;
  offsetMinutes: number;
}

/** Resolve a supported timezone to a fixed offset. Unknown zones are rejected. */
export function zoneInfo(timezone: string): ZoneInfo | null {
  const tz = String(timezone || "").trim();
  if (!tz) return null;
  if (tz === "Asia/Jakarta" || tz === "Asia/Makassar" || tz === "Asia/Jayapura") {
    // Papua (WIT / +09:00) is a real Indonesian zone; keep it explicit rather
    // than silently assuming WIB.
    const offsetMinutes = tz === "Asia/Jayapura" ? 9 * 60 : tz === "Asia/Makassar" ? 8 * 60 : 7 * 60;
    return { label: tz, offsetMinutes };
  }
  const m = /^utc([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(tz);
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const hours = Number(m[2]);
  const minutes = Number(m[3] || 0);
  if (hours > 14 || minutes > 59) return null;
  return { label: tz, offsetMinutes: sign * (hours * 60 + minutes) };
}

export function defaultTimezone(): string {
  return process.env.WORKFLOW_TZ?.trim() || "Asia/Jakarta";
}

function zoneOffsetMs(timezone: string): number {
  return (zoneInfo(timezone)?.offsetMinutes ?? 7 * 60) * 60_000;
}

function isClock(hour: unknown, minute: unknown): boolean {
  return (
    typeof hour === "number" &&
    Number.isInteger(hour) &&
    hour >= 0 &&
    hour <= 23 &&
    typeof minute === "number" &&
    Number.isInteger(minute) &&
    minute >= 0 &&
    minute <= 59
  );
}

export interface ScheduleValidation {
  ok: boolean;
  errors: string[];
}

/** Reject impossible schedules before they are saved (never silently coerce). */
export function validateSchedule(schedule: WorkflowSchedule, timezone: string): ScheduleValidation {
  const errors: string[] = [];
  if (!schedule || typeof schedule !== "object") return { ok: false, errors: ["schedule kosong"] };
  if (!zoneInfo(timezone)) errors.push(`timezone tidak didukung: ${timezone} (pakai Asia/Jakarta atau UTC+HH:MM)`);
  switch (schedule.kind) {
    case "runonce": {
      const t = schedule.at ? Date.parse(schedule.at) : NaN;
      if (!Number.isFinite(t)) errors.push("runonce butuh `at` ISO yang valid");
      break;
    }
    case "interval":
      if (!Number.isInteger(schedule.every_minutes) || (schedule.every_minutes ?? 0) < 1)
        errors.push("interval butuh every_minutes >= 1");
      break;
    case "daily":
      if (!isClock(schedule.hour, schedule.minute)) errors.push("daily butuh hour 0-23 dan minute 0-59");
      break;
    case "weekly":
      if (!isClock(schedule.hour, schedule.minute)) errors.push("weekly butuh hour 0-23 dan minute 0-59");
      if (!Number.isInteger(schedule.day_of_week) || (schedule.day_of_week ?? -1) < 0 || (schedule.day_of_week ?? 9) > 6)
        errors.push("weekly butuh day_of_week 0-6");
      break;
    case "monthly":
      if (!isClock(schedule.hour, schedule.minute)) errors.push("monthly butuh hour 0-23 dan minute 0-59");
      if (!Number.isInteger(schedule.day) || (schedule.day ?? 0) < 1 || (schedule.day ?? 99) > 28)
        errors.push("monthly butuh day 1-28 (hari 29+ dilewati agar semua bulan punya slot)");
      break;
    default:
      errors.push(`schedule kind tidak dikenal: ${String((schedule as { kind?: unknown }).kind)}`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Next occurrence strictly after `after` (epoch ms), or null when the
 * schedule is exhausted (one-time run already in the past).
 */
export function nextOccurrence(
  schedule: WorkflowSchedule,
  timezone: string,
  after: number
): number | null {
  const offset = zoneOffsetMs(timezone);
  switch (schedule.kind) {
    case "runonce": {
      const t = schedule.at ? Date.parse(schedule.at) : NaN;
      if (!Number.isFinite(t) || t <= after) return null;
      return t;
    }
    case "interval": {
      const step = Math.max(1, Math.floor(schedule.every_minutes ?? 1)) * 60_000;
      // Anchored on the schedule instant (or the epoch), never on `after`, so
      // polling cannot make occurrences drift later every tick.
      const anchor = schedule.at && Number.isFinite(Date.parse(schedule.at)) ? Date.parse(schedule.at) : 0;
      const first = anchor > after ? anchor : anchor + Math.ceil((after - anchor + 1) / step) * step;
      return first > after ? first : after + step;
    }
    default: {
      const hour = Number(schedule.hour ?? 0);
      const minute = Number(schedule.minute ?? 0);
      const local = after + offset;
      const d = new Date(local);
      const y = d.getUTCFullYear();
      const mo = d.getUTCMonth();
      const dom = d.getUTCDate();
      const dow = d.getUTCDay();
      const at = (yy: number, mm: number, dd: number): number =>
        Date.UTC(yy, mm, dd, hour, minute, 0, 0) - offset;
      if (schedule.kind === "daily") {
        let t = at(y, mo, dom);
        if (t <= after) t = at(y, mo, dom + 1);
        return t;
      }
      if (schedule.kind === "weekly") {
        const want = Number(schedule.day_of_week ?? 0);
        const delta = (want - dow + 7) % 7;
        let t = at(y, mo, dom + delta);
        if (t <= after) t = at(y, mo, dom + delta + 7);
        return t;
      }
      // monthly: day clamped to 1-28 (validated), so plain arithmetic is safe.
      const day = Math.min(28, Math.max(1, Number(schedule.day ?? 1)));
      if (dom < day) return at(y, mo, day);
      const nextMonth = mo + 1 >= 12 ? at(y + 1, 0, day) : at(y, mo + 1, day);
      return nextMonth;
    }
  }
}

/** Human label — never fabricated dates, only what the schedule really says. */
export function describeSchedule(schedule: WorkflowSchedule): string {
  const hhmm = `${String(schedule.hour ?? 0).padStart(2, "0")}:${String(schedule.minute ?? 0).padStart(2, "0")}`;
  switch (schedule.kind) {
    case "runonce":
      return `sekali pada ${schedule.at ?? "(tanpa waktu)"}`;
    case "interval":
      return `setiap ${Math.max(1, Number(schedule.every_minutes ?? 1))} menit`;
    case "daily":
      return `setiap hari ${hhmm}`;
    case "weekly": {
      const days = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
      return `setiap ${days[Number(schedule.day_of_week ?? 0)]} ${hhmm}`;
    }
    case "monthly":
      return `setiap tanggal ${Math.min(28, Math.max(1, Number(schedule.day ?? 1)))} ${hhmm}`;
    default:
      return "jadwal tidak dikenal";
  }
}

/** Stable occurrence key — the idempotency anchor across restarts and polls. */
export function slotKey(workflowId: string, occurrenceAtMs: number): string {
  // workflow_id already starts with `wf-`; prefixing again produced `wf-wf-…`
  // that every caller then had to substring around (audit 2026-10-16).
  return `${workflowId}-${new Date(occurrenceAtMs).toISOString()}`;
}