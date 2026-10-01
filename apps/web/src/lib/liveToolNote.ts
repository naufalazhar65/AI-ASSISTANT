/**
 * Friendly Indonesian verbs for Live tool activity ("⏳ mengecek email...").
 *
 * Client-safe by construction: ZERO imports, so the browser bundle and vitest
 * can both use it. Lives here — not in `liveTools.ts` — because that module
 * imports the server tool registry (`./tools` → `node:fs`), which must never
 * enter the browser build (2026-10-01: importing it from the hook broke
 * `next build` with fsevents.node). `liveTools.ts` re-exports this file.
 */

/** Friendly Indonesian verbs for tool activity, shown while a call runs. */
const LIVE_TOOL_VERBS: Record<string, string> = {
  gmail_list: "mengecek email",
  gmail_read: "membaca email",
  gmail_search: "mencari email",
  gmaps_route: "mengecek rute",
  waze_route: "mengecek rute",
  google_news: "mencari berita",
  web_search: "mencari",
  weather: "mengecek cuaca",
  hotel_search: "mencari hotel",
  cinema_showtimes: "mencari jadwal film",
  spotify_play: "memutar lagu",
  spotify_search: "mencari lagu",
  spotify_status: "mengecek lagu",
  calendar_add: "mencatat jadwal",
  calendar_mac_add: "mencatat jadwal",
  mac_open: "membuka situs",
  add_task: "mencatat tugas",
  complete_task: "menyelesaikan tugas",
  remind_me: "memasang pengingat",
  save_note: "mencatat",
  search_memory: "mengingat-ingat",
  memory_get: "membaca ingatan",
};

/**
 * One-line busy note for a Live tool batch ("⏳ mengecek email...").
 * Unknown names fall back to themselves — a new tool never renders blank.
 * Pure — tested.
 */
export function liveToolNote(names: string[]): string {
  const verbs = names.map((n) => LIVE_TOOL_VERBS[n] ?? n);
  return `⏳ ${verbs.join(" + ")}...`;
}
