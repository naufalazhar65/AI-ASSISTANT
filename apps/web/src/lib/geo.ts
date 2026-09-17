// Shared place-label resolution: extracting "lat,lon" from prose and mapping the
// user's own home nickname to the saved persona coordinates.
//
// WHY this module exists: `weather.ts` and `waze.ts` each geocoded the RAW label,
// so an ambiguous nickname ("Lake Home") silently resolved to a different place
// worldwide (live: weather reported 25°C/80% for another region while the real
// Serpong was 31°C/52%) and a prompt carrying coordinates in prose failed
// outright. One implementation keeps both tools honest.

/** Generic words that must NOT be enough to match the saved home label on their
 *  own (a bare "home"/"kota" would otherwise hijack unrelated queries). */
const HOME_GENERIC = ["home", "rumah", "jalan", "kota", "city", "selatan", "utara", "timur", "barat", "indonesia"];

/**
 * Extract a "lat,lon" pair from ANYWHERE in the text. An automation prompt often
 * carries the coordinates in prose ("… Serpong (koordinat -6.378806,106.712563)")
 * which an anchored parser rejects. The lookarounds stop a longer number from
 * matching partially ("2026, 17" must NOT yield 26,17). Pure — unit-tested.
 */
export function parseLatLonAnywhere(s: string): { lat: number; lon: number } | null {
  const m = (s || "").match(/(?<![\d.])(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)(?![\d.])/);
  if (!m) return null;
  const lat = Number(m[1]), lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

/**
 * Resolve an alias of the user's OWN home ("Lake Home") to the saved
 * `home_coords` persona fact. Returns null when there is no alias match.
 */
export function homeCoordsFor(query: string, rawUser?: unknown): { lat: number; lon: number } | null {
  if (rawUser === undefined) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getPersonaFact } = require("./persona") as typeof import("./persona");
    const coords = parseLatLonAnywhere(String(getPersonaFact(rawUser, "home_coords") ?? ""));
    if (!coords) return null;
    const label = String(getPersonaFact(rawUser, "home") ?? "").toLowerCase().trim();
    if (!label) return null;
    const q = (query || "").toLowerCase();
    if (q.includes(label)) return coords;
    // Only the segment before the first comma is the user's nickname ("Lake
    // Home"); the remaining parts are the address ("Serpong, Tangerang
    // Selatan"), so asking for "Tangerang" must NOT be answered with home coords.
    const alias = label.split(",")[0].trim();
    const words = alias.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4 && !HOME_GENERIC.includes(w));
    if (!words.length) return null;
    return words.some((w) => q.includes(w)) ? coords : null;
  } catch {
    return null;
  }
}

/** Explicit coordinates for a label, from the label itself or the home alias. */
export function resolveExplicitCoords(query: string, rawUser?: unknown): { lat: number; lon: number } | null {
  return parseLatLonAnywhere(query) ?? homeCoordsFor(query, rawUser);
}
