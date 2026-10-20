// Time formatting invariants. Lives in lib (not channels) because both the
// agent (lib) and the channel adapters need the same 24-hour WIB clock — the
// old per-site `toLocaleTimeString([])` fell back to the 12-hour locale default
// and reminders went out as "· pukul 06:00 AM".

/**
 * Full Asia/Jakarta wall-clock parts for APIs that need fields, not strings
 * (AppleScript calendar/reminders decompose a Date; decomposing in server
 * time shifts the event on any non-WIB host — audit 2026-09-23).
 * Pure (Intl).
 */
export function wibParts(at: Date | number): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const d = at instanceof Date ? at : new Date(at);
  const parts: Record<string, number> = {};
  try {
    for (const p of new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Jakarta", year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric", hour12: false,
    }).formatToParts(d)) {
      if (p.type !== "literal") parts[p.type] = Number(p.value);
    }
  } catch {
    return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds() };
  }
  return { y: parts.year, mo: parts.month, d: parts.day, h: parts.hour === 24 ? 0 : parts.hour, mi: parts.minute, s: parts.second };
}

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

/**
 * The USER's configured timezone — the app has one, it is not hardcoded.
 * `MIA_USER_TIMEZONE` (e.g. "Asia/Jakarta"); defaults to Asia/Jakarta.
 */
export function userTimeZone(): string {
  const raw = String(process.env.MIA_USER_TIMEZONE || "").trim();
  return raw || "Asia/Jakarta";
}

/**
 * Short label for a timezone. Indonesian zones get their real abbreviation
 * (WIB/WITA/WIT); anything else shows the zone id itself. A label is never
 * invented: the abbreviation is only used for the zone it actually belongs to.
 */
export function tzLabel(zone: string = userTimeZone()): string {
  switch (zone) {
    case "Asia/Jakarta":
      return "WIB";
    case "Asia/Makassar":
      return "WITA";
    case "Asia/Jayapura":
      return "WIT";
    default:
      return zone;
  }
}

/**
 * "20 Okt 2026, 14.45 WIB" — built from formatToParts so the output is the
 * same on every ICU build (id-ID's own time separator varies).
 * An unparseable/missing date yields "" — a date is never invented.
 */
export function dateTimeLabel(
  at: Date | number | string | null | undefined,
  zone: string = userTimeZone(),
  label?: string,
): string {
  if (at === null || at === undefined || at === "") return "";
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  try {
    const parts = new Intl.DateTimeFormat("id-ID", {
      timeZone: zone, day: "numeric", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(d);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    const month = get("month");
    const day = get("day");
    const year = get("year");
    const hour = get("hour") === "24" ? "00" : get("hour");
    const minute = get("minute");
    if (!day || !month || !year || !hour || !minute) return "";
    const lbl = label === undefined ? tzLabel(zone) : label;
    return `${day} ${month} ${year}, ${hour}.${minute}${lbl ? ` ${lbl}` : ""}`;
  } catch {
    return "";
  }
}

/**
 * Same as dateTimeLabel but without the zone label — for a range where the
 * label is written once ("20 Okt 2026, 14.05 – 14.45 WIB").
 */
export function dateTimeShort(at: Date | number | string | null | undefined, zone: string = userTimeZone()): string {
  const full = dateTimeLabel(at, zone, "");
  return full ? full.replace(/\s+[A-Z]{2,4}$/, "") : "";
}
