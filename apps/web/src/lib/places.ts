/**
 * Keyless venue search via OpenStreetMap (Nominatim geocode + Overpass API).
 *
 * Why this exists (2026-10-02): keyless web_search is dead for Indonesian
 * venue long-tail — DDG cert expired, Bing HTML/RSS returns junk (WhatsApp
 * contacts, Togel spam) for "kafe tenang Cipete", Mojeek captcha, Yep 403.
 * A relevance gate keeps junk out of answers, but then venue asks stall or
 * refuse. Overpass needs NO API key and returns real mapped venues
 * (name/address/hours). Less complete than Google Places, far better than
 * Bing junk. Both hops carry `mia-assistant/1.0` UA (Nominatim usage policy
 * requires a valid UA; personal-use rate is fine).
 */

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const UA = { "User-Agent": "mia-assistant/1.0 (personal assistant)" };

export type PlaceKind = "cafe" | "restaurant" | "shop" | "both" | "all";

export interface OverpassElement {
  tags?: Record<string, string>;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
}

export interface PlaceResult {
  name: string;
  kind: string;
  address: string;
  hours: string;
  lat: number;
  lon: number;
}

const CAFE_WORDS = new Set([
  "kopi", "kafe", "cafe", "café", "coffee", "ngopi", "kopitan",
  "warkop", "coffeeshop", "coffee shop", "kedai kopi",
]);
const RESTO_WORDS = new Set([
  "makan", "makanan", "resto", "restaurant", "restoran", "warung",
  "sarapan", "kuliner", "food", "depot", "rumah makan", "makan malam",
]);
/**
 * Shop words (2026-10-02): minimarket/supermarket/apotek were unsearchable —
 * categoryFor only knew cafe/restaurant, so "Indomaret Fresh di Pamulang"
 * fell into food-venue search. OSM tags: shop=convenience|supermarket|general,
 * amenity=pharmacy. Brand names (indomaret/alfamart/...) double as name-match
 * tokens; only GENERIC words go to NAME_STOPWORDS below.
 */
const SHOP_WORDS = new Set([
  "indomaret", "alfamart", "alfamidi", "lawson", "familymart", "circle k",
  "minimarket", "mini market", "supermarket", "swalayan", "toko", "market",
  "convenience", "fresh", "apotek", "apotik", "pharmacy", "farmasi",
]);
/** Tokens that are never a venue NAME (areas, filler, verbs). */
const NAME_STOPWORDS = new Set([
  "yang", "dan", "atau", "dengan", "dekat", "sekitar", "area", "daerah",
  "enak", "enaknya", "tenang", "sepi", "bagus", "murah", "indoor",
  "outdoor", "cozy", "santai", "nongkrong", "hangout", "kerja",
  "rekomendasi", "rekomendasikan", "cari", "carikan", "tolong", "dong",
  "kafe", "cafe", "coffee", "kopi", "resto", "makan", "di", "ke", "the", "jakarta",
  "minimarket", "supermarket", "swalayan", "toko", "market", "convenience",
  "fresh", "apotek", "apotik", "pharmacy", "farmasi",
  "selatan", "utara", "timur", "barat", "pusat", "jaksel", "jakut",
  "jaktim", "jakbar", "jakpus",
]);

/** Which OSM amenity family the query asks for. Pure. */
export function categoryFor(query: string): PlaceKind {
  const q = (query || "").toLowerCase();
  const hasCafe = [...CAFE_WORDS].some((w) => q.includes(w));
  const hasResto = [...RESTO_WORDS].some((w) => q.includes(w));
  const hasShop = [...SHOP_WORDS].some((w) => q.includes(w));
  if (hasShop && !hasCafe && !hasResto) return "shop";
  if (hasShop && (hasCafe || hasResto)) return "all";
  if (hasCafe && !hasResto) return "cafe";
  if (hasResto && !hasCafe) return "restaurant";
  return "both";
}

/** Query tokens that look like a specific venue NAME (not category/area). Pure. */
export function nameTokens(query: string): string[] {
  return (query || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !NAME_STOPWORDS.has(w));
}

/** True when the OSM element's name matches the query's name tokens. Pure. */
export function placeNameMatches(osmName: string, tokens: string[]): boolean {
  if (!tokens.length) return true;
  const n = (osmName || "").toLowerCase();
  if (!n) return false;
  return tokens.some((t) => n.includes(t));
}

/** Query name-tokens minus tokens already covered by the area. Pure. */
export function queryNameTokens(query: string, area: string): string[] {
  const areaToks = new Set(
    (area || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
  );
  return nameTokens(query).filter((t) => !areaToks.has(t));
}

function amenityRe(kind: PlaceKind): string {
  return kind === "cafe"
    ? "^(cafe|ice_cream)$"
    : kind === "restaurant"
      ? "^(restaurant|fast_food|food_court)$"
      : "^(cafe|restaurant|fast_food|ice_cream)$";
}

/**
 * Shop/pharmacy union members (2026-10-02): minimarket & apotek live under
 * the `shop` key (convenience/supermarket/general) and `amenity=pharmacy` —
 * NOT the food amenity family. Pure.
 */
const SHOP_RE = "^(convenience|supermarket|general)$";

function shopNodeFilter(at: string): string {
  return `node${at}["shop"~"${SHOP_RE}"]["name"];node${at}["amenity"="pharmacy"]["name"];`;
}

function shopWayFilter(at: string): string {
  return `way${at}["shop"~"${SHOP_RE}"]["name"];way${at}["amenity"="pharmacy"]["name"];`;
}

function around(lat: number, lon: number, radiusM: number): string {
  const r = Math.max(500, Math.min(20000, Math.round(radiusM)));
  return `(around:${r},${lat},${lon})`;
}

/** Node-only query — cheap; the production path runs this first. Pure. */
export function buildNodeQuery(lat: number, lon: number, radiusM: number, kind: PlaceKind): string {
  const at = around(lat, lon, radiusM);
  if (kind === "shop") return `[out:json][timeout:20];(${shopNodeFilter(at)});out tags 30;`;
  if (kind === "all")
    return `[out:json][timeout:20];(node${at}["amenity"~"${amenityRe("both")}"]["name"];${shopNodeFilter(at)});out tags 30;`;
  return `[out:json][timeout:20];node${around(lat, lon, radiusM)}["amenity"~"${amenityRe(kind)}"]["name"];out tags 30;`;
}

/** Way-only query — expensive under load; backfill path only. Pure. */
export function buildWayQuery(lat: number, lon: number, radiusM: number, kind: PlaceKind): string {
  const at = around(lat, lon, radiusM);
  if (kind === "shop") return `[out:json][timeout:20];(${shopWayFilter(at)});out center tags 30;`;
  if (kind === "all")
    return `[out:json][timeout:20];(way${at}["amenity"~"${amenityRe("both")}"]["name"];${shopWayFilter(at)});out center tags 30;`;
  return `[out:json][timeout:20];way${around(lat, lon, radiusM)}["amenity"~"${amenityRe(kind)}"]["name"];out center tags 30;`;
}

/**
 * Overpass QL: named venues of the wanted amenity family around a point.
 * Combined node+way form (kept for completeness/tests) — production runs
 * node-only first because the combined scan 504s under public-instance load.
 * Pure.
 */
export function buildOverpassQuery(lat: number, lon: number, radiusM: number, kind: PlaceKind): string {
  const at = around(lat, lon, radiusM);
  if (kind === "shop" || kind === "all") {
    const foodFilt =
      kind === "all" ? `node${at}["amenity"~"${amenityRe("both")}"]["name"];way${at}["amenity"~"${amenityRe("both")}"]["name"];` : "";
    return `[out:json][timeout:20];(${foodFilt}${shopNodeFilter(at)}${shopWayFilter(at)});out center tags 30;`;
  }
  const filt = `${around(lat, lon, radiusM)}["amenity"~"${amenityRe(kind)}"]["name"]`;
  return `[out:json][timeout:20];(node${filt};way${filt};);out center tags 30;`;
}

function addressOf(tags: Record<string, string>): string {
  if (tags["addr:full"]) return tags["addr:full"];
  const street = [tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(" ");
  const area = [tags["addr:suburb"], tags["addr:city"], tags["addr:postcode"]].filter(Boolean).join(", ");
  return [street, area].filter(Boolean).join(", ");
}

/**
 * Collect matching venues as rows (uncapped) — the production path counts
 * these to decide whether a way-backfill is worth it. Pure.
 */
export function collectPlaces(
  elements: OverpassElement[],
  query: string,
  area: string = ""
): PlaceResult[] {
  const tokens = queryNameTokens(query, area);
  const rows: PlaceResult[] = [];
  for (const el of elements || []) {
    const tags = el.tags || {};
    const name = (tags.name || "").trim();
    if (!name || !placeNameMatches(name, tokens)) continue;
    rows.push({
      name,
      kind: tags.amenity || tags.shop || "tempat",
      address: addressOf(tags),
      hours: (tags.opening_hours || "").trim(),
      lat: el.lat ?? el.center?.lat ?? 0,
      lon: el.lon ?? el.center?.lon ?? 0,
    });
  }
  return rows;
}

/** Render rows as a plain-text numbered list (no markdown/emoji — the Live
 * voice path speaks this aloud). Empty → "No places found." Pure. */
export function renderPlaces(rows: PlaceResult[], limit: number): string {
  const capped = rows.slice(0, Math.max(1, Math.min(15, limit)));
  if (!capped.length) return "No places found.";
  return capped
    .map((p, i) => {
      const bits = [`${i + 1}. ${p.name} — ${p.kind}`];
      if (p.address) bits.push(p.address);
      const tail = p.hours ? `jam: ${p.hours}` : "jam: tidak tercantum di peta";
      bits.push(tail);
      return bits.join(", ");
    })
    .join("\n");
}

/** Elements → rows → rendered list in one call (kept for callers/tests). Pure. */
export function formatPlaces(
  elements: OverpassElement[],
  query: string,
  limit: number,
  area: string = ""
): string {
  return renderPlaces(collectPlaces(elements, query, area), limit);
}

async function geocodeArea(area: string): Promise<{ lat: number; lon: number } | null> {
  // One retry after a short pause: Nominatim rate-limits bursts (429), and a
  // single transient must not kill a venue ask.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
    try {
      const res = await fetch(`${NOMINATIM_URL}?format=json&limit=1&q=${encodeURIComponent(area)}`, {
        headers: { ...UA, Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const j = (await res.json()) as Array<{ lat?: string; lon?: string }>;
      const lat = parseFloat(j?.[0]?.lat || "");
      const lon = parseFloat(j?.[0]?.lon || "");
      if (!isFinite(lat) || !isFinite(lon)) return null;
      return { lat, lon };
    } catch {
      /* retry once, then give up */
    }
  }
  return null;
}

async function overpassQuery(ql: string): Promise<OverpassElement[] | null> {
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { ...UA, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data: ql }),
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) continue;
      const j = (await res.json()) as { elements?: OverpassElement[] };
      if (Array.isArray(j?.elements)) return j.elements;
    } catch {
      /* try next endpoint */
    }
  }
  return null;
}

/**
 * Search real mapped venues near an area. Keyless (Nominatim + Overpass).
 * Returns a numbered plain-text list, or "No places found." when the area
 * won't geocode / Overpass is down / nothing mapped — the agent treats that
 * as unverified and answers from knowledge with an honest label.
 */
export async function placesSearch(args: {
  query: string;
  area: string;
  radiusM?: number;
  limit?: number;
}): Promise<string> {
  const query = (args.query || "").trim().slice(0, 120);
  const area = (args.area || "").trim().slice(0, 120);
  if (!query || !area) return "Error: query dan area wajib diisi";
  const geo = await geocodeArea(area);
  if (!geo) return "No places found.";
  const kind = categoryFor(query);
  const limit = Math.max(1, Math.min(15, args.limit ?? 8));
  const radiusM = args.radiusM ?? 3000;
  // Nodes first: the combined node+way scan 504s under public-instance load
  // (measured 2026-10-02: combined 504, nodes-only 200 in 2s). Ways are only
  // backfilled when the node rows run short of the requested limit.
  let nodeEls = await overpassQuery(buildNodeQuery(geo.lat, geo.lon, radiusM, kind));
  // Public Overpass instances flake under load (measured 2026-10-02: all
  // endpoints timing out, then recovering minutes later) — retry ONCE on hard
  // failure (null) only. A successful-but-empty answer already gets its second
  // chance via the way-backfill below; re-hitting it just burns up to 50s
  // (2 endpoints x 25s timeout) for nothing, proven live 2026-10-02.
  if (nodeEls === null) {
    await new Promise((r) => setTimeout(r, 1500));
    const retry = await overpassQuery(buildNodeQuery(geo.lat, geo.lon, radiusM, kind));
    if (retry) nodeEls = retry;
  }
  const els = nodeEls ?? [];
  if (nodeEls === null || collectPlaces(els, query, area).length < limit) {
    const wayEls = await overpassQuery(buildWayQuery(geo.lat, geo.lon, radiusM, kind));
    if (wayEls) els.push(...wayEls);
  }
  return formatPlaces(els, query, limit, area);
}
