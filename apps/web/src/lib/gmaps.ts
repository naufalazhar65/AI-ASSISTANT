/**
 * Google Maps live routing via headless Chromium (keyless, no API key).
 *
 * Why this exists (owner 2026-10-01): Waze's routing endpoint hard-blocks
 * server-side fetches (HTTP 403 even with browser cookies+headers), so every
 * `waze_route` call silently degraded to the OSRM static estimate — and the
 * one live check that mattered (Serpong→Bandung) was 40 minutes off because
 * of it. The Maps directions page renders fine in headless Chromium with no
 * bot-check (measured 2026-10-01: "2 jam 47 mnt, 176 km, Rute tercepat saat
 * ini sesuai kondisi lalu lintas").
 *
 * Own browser per call — NEVER the `browser.ts` singleton. A route check must
 * not hijack the page a `browser_*` automation is driving. Bounded ~50 s;
 * the model waits in silence while this runs (same contract as hotel_search),
 * so it stays a `read` tool that auto-executes.
 */

import { chromium } from "playwright";

export interface GmapsRoute {
  /** e.g. "2 jam 47 mnt" — spoken as-is. */
  duration: string;
  /** e.g. "176 km" ("" when the page did not show one). */
  distance: string;
  /** Road summary without the "lewat " prefix ("" when absent). */
  via: string;
}

export interface GmapsResult {
  /** Numbered list for verbatim delivery (VERBATIM_LIST, like hotel_search). */
  human: string;
  routes: GmapsRoute[];
  /** True when the page carries the live-traffic label. */
  live: boolean;
}

/** "Rute tercepat saat ini sesuai kondisi lalu lintas" — the live signal. */
export const GMAPS_LIVE_MARKER = "sesuai kondisi lalu lintas";

/** A line that is ONLY a full duration: "2 jam 47 mnt", "45 mnt". */
const DURATION_RE = /^(\d+\s*jam\s*\d+\s*m(?:nt|enit|in)?|\d+\s*m(?:nt|enit|in)?)$/i;

/** "176 km" / "1.240 km". */
const DISTANCE_RE = /^[\d.,]+\s*km$/i;

/** Lines without a single letter/digit are icon glyphs, not content. */
function isContentLine(line: string): boolean {
  return /[A-Za-z0-9]/.test(line);
}

/**
 * Parse route cards out of the directions page text. Pure — the live page is
 * only fetched in `getGmapsRoute`, so every shape here is unit-testable.
 * A card = duration line, then the next distance line, then the next
 * "lewat ..." line; anything else in between is ignored. Caps at 3 routes.
 */
export function parseGmapsDirections(bodyText: string): GmapsRoute[] {
  const lines = bodyText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && isContentLine(l));
  const out: GmapsRoute[] = [];
  for (let i = 0; i < lines.length && out.length < 3; i += 1) {
    if (!DURATION_RE.test(lines[i])) continue;
    const duration = lines[i];
    let distance = "";
    let via = "";
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j += 1) {
      if (!distance && DISTANCE_RE.test(lines[j])) {
        distance = lines[j];
        continue;
      }
      const lewat = /^lewat\s+(.+)$/i.exec(lines[j]);
      if (lewat) {
        via = lewat[1].trim();
        break;
      }
    }
    out.push({ duration, distance, via });
  }
  return out;
}

/** Directions URL for two free-text places (same shape the site itself uses). */
export function gmapsDirUrl(from: string, to: string): string {
  return `https://www.google.com/maps/dir/${encodeURIComponent(from)}/${encodeURIComponent(to)}`;
}

/**
 * Load the directions page and parse the route cards. Throws an honest error
 * (bot-check, consent wall, no routes) instead of an empty list — an empty
 * list would read as "no road exists".
 */
export async function getGmapsRoute(from: string, to: string): Promise<GmapsResult> {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ locale: "id-ID" });
    await page.goto(gmapsDirUrl(from, to), { timeout: 40_000, waitUntil: "domcontentloaded" });
    await page.waitForTimeout(9_000);
    const text = await page.innerText("body");
    const routes = parseGmapsDirections(text);
    if (!routes.length) {
      throw new Error("Google Maps tidak menampilkan rute (kemungkinan bot-check/consent)");
    }
    const live = text.includes(GMAPS_LIVE_MARKER);
    const lines = routes.map(
      (r, i) => `${i + 1}. ${r.duration}${r.distance ? ` — ${r.distance}` : ""}${r.via ? ` — via ${r.via}` : ""}`
    );
    const human =
      `Rute ${from} → ${to} (live Google Maps${live ? " — sesuai kondisi lalu lintas" : ""}):\n` +
      lines.join("\n");
    return { human, routes, live };
  } finally {
    await browser.close().catch(() => undefined);
  }
}
