// Waze Direct — free live traffic (no API key, no fetcher).
// Geocode via Nominatim OSM → Waze routing-livemap-row → OSRM fallback.

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const WAZE_ROUTING = "https://routing-livemap-row.waze.com/RoutingManager/routingRequest";
const OSRM_ROUTING = "https://router.project-osrm.org/route/v1/driving";

const UA = "mia-assistant/1.0 (https://github.com/naufalazhar65/AI-ASSISTANT)";

export type Coords = { lat: number; lon: number; display?: string };
export type WazeRoute = { duration_min: number; distance_km: number; name: string; streets: string[] };
export type WazeResult = {
  from: string;
  to: string;
  fromCoords: Coords;
  toCoords: Coords;
  routes: WazeRoute[];
  fastest: WazeRoute | null;
  human: string;
};

function parseLatLon(s: string): Coords | null {
  const m = s.trim().match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Number.isNaN(lat) || Number.isNaN(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

async function geocode(query: string): Promise<Coords> {
  const direct = parseLatLon(query);
  if (direct) return direct;
  const url = `${NOMINATIM}?q=${encodeURIComponent(query)}&format=json&limit=1&addressdetails=0`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`geocode failed ${res.status} for "${query}"`);
  const arr = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
  if (!arr.length) throw new Error(`Cannot get coords for "${query}" — coba alamat lebih spesifik`);
  return { lat: Number(arr[0].lat), lon: Number(arr[0].lon), display: arr[0].display_name };
}

function wazeCoords(c: Coords): string {
  return `x:${c.lon} y:${c.lat}`;
}

// Waze historically returned JSON { alternatives: [...] } but the public
// livemap endpoint now returns XML <Responses><response><result>... — handle both.
// JSON path kept for fallback/future; XML is the current live shape.

function parseWazeJson(data: unknown): WazeRoute[] {
  const routes: WazeRoute[] = [];
  const alts = (data as { alternatives?: unknown[] })?.alternatives;
  if (!Array.isArray(alts)) return routes;
  for (const alt of alts) {
    const response = (alt as { response?: unknown })?.response as { results?: unknown[] } | undefined;
    const results = response?.results;
    if (!Array.isArray(results) || !results.length) continue;
    let totalSec = 0;
    let totalMeters = 0;
    let name = "";
    const streets: string[] = [];
    for (const r of results as Array<Record<string, unknown>>) {
      const sec = typeof r.crossTime === "number" ? r.crossTime : typeof r.crossTimeSeconds === "number" ? r.crossTimeSeconds : 0;
      const len = typeof r.length === "number" ? r.length : 0;
      totalSec += sec;
      totalMeters += len;
      const n = typeof r.street === "string" ? r.street : typeof r.streetName === "string" ? r.streetName : "";
      if (n && !name) name = n;
      if (Array.isArray(r.streetNames)) {
        for (const s of r.streetNames as string[]) if (typeof s === "string" && s) streets.push(s);
      } else if (typeof r.street === "string" && r.street) streets.push(r.street);
    }
    const altName = (alt as Record<string, unknown>).routeName as string | undefined;
    if (!name && altName) name = altName;
    const dur = totalSec > 0 ? Math.round(totalSec / 60) : 0;
    const dist = totalMeters > 0 ? Math.round(totalMeters / 100) / 10 : 0;
    if (dur > 0 || dist > 0) routes.push({ duration_min: dur, distance_km: dist, name: name || `Rute ${routes.length + 1}`, streets: [...new Set(streets)].slice(0, 8) });
  }
  if (!routes.length) {
    const topResults = (data as { response?: { results?: unknown[] } })?.response?.results;
    if (Array.isArray(topResults) && topResults.length) return parseWazeJson({ alternatives: [{ response: { results: topResults } }] });
  }
  return routes;
}

function parseWazeXml(xml: string): WazeRoute[] {
  // <Responses><response>...</response><response>...</response></Responses>
  // Each <response> is one alternative with many <result> segments.
  const routes: WazeRoute[] = [];
  const responseBlocks = [...xml.matchAll(/<response>([\s\S]*?)<\/response>/g)].map((m) => m[1]);
  // Fallback: if no <response>, try top-level <result> as single route
  const blocks = responseBlocks.length ? responseBlocks : xml.includes("<result>") ? [xml] : [];
  for (const block of blocks) {
    let totalSec = 0;
    let totalMeters = 0;
    for (const m of block.matchAll(/<cross_time>(\d+)<\/cross_time>/g)) totalSec += Number(m[1]);
    for (const m of block.matchAll(/<length>(\d+)<\/length>/g)) totalMeters += Number(m[1]);
    const dur = Math.round(totalSec / 60);
    const dist = Math.round(totalMeters / 100) / 10;
    if (dur > 0 || dist > 0) routes.push({ duration_min: dur, distance_km: dist, name: `Rute ${routes.length + 1}`, streets: [] });
  }
  return routes;
}

async function fetchWaze(from: Coords, to: Coords): Promise<WazeRoute[]> {
  const params = new URLSearchParams({
    from: wazeCoords(from),
    to: wazeCoords(to),
    at: "0",
    nPaths: "3",
    options: "AVOID_TRAILS:t",
  });
  const url = `${WAZE_ROUTING}?${params}`;
  // Waze is flaky (Internal Error ~40%) — retry twice before falling back to OSRM
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 700));
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.waze.com/", Accept: "*/*" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`Waze ${res.status}`);
      const text = await res.text();
      if (text.includes("<error>Internal Error</error>")) throw new Error("Waze Internal Error");
      let routes: WazeRoute[] = [];
      const trimmed = text.trim();
      if (trimmed.startsWith("<")) routes = parseWazeXml(text);
      else {
        try {
          routes = parseWazeJson(JSON.parse(text));
        } catch {
          routes = parseWazeXml(text);
        }
      }
      if (!routes.length) throw new Error("Waze returned no routes");
      return routes;
    } catch (e) {
      lastErr = e;
      console.warn(`[waze] attempt ${attempt + 1} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function fetchOsrm(from: Coords, to: Coords): Promise<WazeRoute[]> {
  const coords = `${from.lon},${from.lat};${to.lon},${to.lat}`;
  const url = `${OSRM_ROUTING}/${coords}?overview=false&alternatives=true`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`OSRM ${res.status}`);
  const data = (await res.json()) as { routes?: Array<{ duration: number; distance: number; legs?: Array<{ summary?: string }> }> };
  if (!data.routes?.length) throw new Error("OSRM returned no routes");
  return data.routes.map((r, i) => ({
    duration_min: Math.round(r.duration / 60),
    distance_km: Math.round(r.distance / 100) / 10,
    name: r.legs?.[0]?.summary || `Rute ${i + 1} (OSRM)`,
    streets: [],
  }));
}

export async function getWazeRoute(fromQ: string, toQ: string): Promise<WazeResult> {
  const from = await geocode(fromQ);
  // Small throttle for Nominatim (1 req/s) when both are addresses
  if (!parseLatLon(fromQ) && !parseLatLon(toQ)) await new Promise((r) => setTimeout(r, 1100));
  const to = await geocode(toQ);

  let routes: WazeRoute[] | null = null;
  let source = "waze";
  try {
    routes = await fetchWaze(from, to);
  } catch (e) {
    console.warn(`[waze] Waze failed, falling back to OSRM: ${e instanceof Error ? e.message : String(e)}`);
    try {
      routes = await fetchOsrm(from, to);
      source = "osrm";
    } catch (e2) {
      throw new Error(`Routing failed (Waze+OSRM): ${e2 instanceof Error ? e2.message : String(e2)}`);
    }
  }

  routes.sort((a, b) => a.duration_min - b.duration_min);
  const fastest = routes[0] ?? null;
  const humanParts = [`📍 ${fromQ} -> ${toQ}: ${fastest ? `${fastest.duration_min} menit (${fastest.distance_km} km) via ${fastest.name}` : "no route"}`];
  if (routes.length > 1) humanParts.push(`Alternatif: ${routes.slice(1).map((r) => `${r.duration_min} menit via ${r.name}`).join(" | ")}`);
  if (routes.length >= 2 && fastest) {
    const slowest = routes[routes.length - 1];
    const diff = slowest.duration_min - fastest.duration_min;
    if (diff >= 5) humanParts.push(`⚠️ Macet: +${diff} menit vs rute tercepat (${source === "osrm" ? "estimasi tanpa traffic" : "estimasi"})`);
  } else if (source === "waze" && fastest) {
    // Single Waze route — compare to OSRM free-flow to label macet/lancar
    try {
      const base = await fetchOsrm(from, to);
      const baseMin = base.sort((a, b) => a.duration_min - b.duration_min)[0]?.duration_min ?? 0;
      if (baseMin > 0) {
        const delta = fastest.duration_min - baseMin;
        if (delta >= 10) humanParts.push(`⚠️ Macet: +${delta} menit vs normal (${baseMin} menit tanpa traffic)`);
        else if (delta <= 3) humanParts.push(`Lancar — cuma +${Math.max(0, delta)} menit vs normal`);
      }
    } catch { /* best-effort */ }
  }
  if (source === "osrm") humanParts.push("(fallback OSRM — tanpa traffic live)");

  return {
    from: fromQ,
    to: toQ,
    fromCoords: from,
    toCoords: to,
    routes,
    fastest,
    human: humanParts.join(" | "),
  };
}

export function formatWazeJson(r: WazeResult): string {
  return JSON.stringify({ from: r.from, to: r.to, routes: r.routes, fastest: r.fastest }, null, 2);
}
