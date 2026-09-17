// Time formatting invariants. Lives in lib (not channels) because both the
// agent (lib) and the channel adapters need the same 24-hour WIB clock — the
// old per-site `toLocaleTimeString([])` fell back to the 12-hour locale default
// and reminders went out as "· pukul 06:00 AM".

/**
 * 24-hour "HH:MM" in Asia/Jakarta, pinned to the zone (never the server's).
 * Pure (Intl) — unit-tested.
 */
export function clockLabel(at: Date | number): string {
  const d = at instanceof Date ? at : new Date(at);
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  } catch {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
}

/**
 * "YYYY-MM-DD" in Asia/Jakarta — the app's canonical day key, never the server's
 * zone. Replaces five private copies; the old ones built "yesterday" with
 * `setDate(getDate()-1)` in SERVER-local time, so a non-WIB host read the wrong
 * day's moods/memory near midnight.
 */
export function wibDay(at: Date | number = Date.now()): string {
  const d = at instanceof Date ? at : new Date(at);
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** The WIB day before `at` — exact because Jakarta has no DST. */
export function wibDayBefore(at: Date | number = Date.now()): string {
  const ms = at instanceof Date ? at.getTime() : at;
  return wibDay(ms - 86_400_000);
}

/** Jakarta is UTC+7 all year (no DST), so a WIB wall clock maps to a fixed epoch. */
const WIB_OFFSET_MS = 7 * 3600_000;

/**
 * The next epoch whose ASIA/JAKARTA wall clock is `hour`:`minute`, strictly after
 * `after`. A daily schedule ("setiap hari jam 7") must fire at 07:00 WIB — the old
 * `new Date(y, m, d, hour, minute)` used the SERVER's zone. Pure — unit-tested.
 */
export function wibDailyNext(hour: number, minute: number, after: number = Date.now()): number {
  const h = Math.max(0, Math.min(23, Math.floor(hour)));
  const m = Math.max(0, Math.min(59, Math.floor(minute)));
  const [y, mo, d] = wibDay(after).split("-").map(Number);
  let t = Date.UTC(y, (mo || 1) - 1, d || 1, h, m) - WIB_OFFSET_MS;
  if (t <= after) t += 86_400_000;
  return t;
}

/**
 * A stable integer index for a WIB calendar day — for daily ROTATION seeds
 * (fetch/empathy/mala variants). `Math.floor(Date.now()/86400000)` rotated at
 * 07:00 WIB (UTC midnight) instead of midnight WIB. Pure — unit-tested.
 */
export function wibDayIndex(at: Date | number = Date.now()): number {
  return Math.floor(Date.parse(`${wibDay(at)}T00:00:00Z`) / 86_400_000);
}
