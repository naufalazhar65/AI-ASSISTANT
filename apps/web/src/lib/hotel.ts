// Hotel Finder — live via Playwright + Booking.com (no API key)
// Spec: ./hotel.sh "Bandung" "400rb"  -> Booking search, filter, output.

import { wibDay } from "./time";
import { chromium } from "playwright";

export type Hotel = {
  name: string;
  /** Total price for the whole stay (Booking card shows N-night total). */
  price: number;
  /** Estimated per-night price (price / nights). */
  perNight: number;
  rating: string | null;
  stars: number | null;
  distance: string | null;
  link: string;
};

export type Stay = { checkin: string; checkout: string; nights: number };

export type HotelQuery = {
  budget?: number | null;
  checkin?: string;
  checkout?: string;
  adults?: number;
  rooms?: number;
  sort?: "price" | "rating" | "popularity";
  minRating?: number;
  stars?: number;
};

export function parseBudget(s: string | undefined): number | null {
  if (!s) return null;
  const t = s.toLowerCase().replace(/\s+/g, "");
  if (!t) return null;
  // "400rb" "400k" "600rb" "1jt" "1.5jt" "600000"
  const mRb = t.match(/^(\d+(?:[.,]\d+)?)(rb|k)$/);
  if (mRb) return Math.round(Number(mRb[1].replace(",", ".")) * 1000);
  const mJt = t.match(/^(\d+(?:[.,]\d+)?)jt$/);
  if (mJt) return Math.round(Number(mJt[1].replace(",", ".")) * 1_000_000);
  const digits = t.replace(/[^0-9]/g, "");
  if (digits) {
    const n = Number(digits);
    if (!Number.isNaN(n) && n >= 10000) return n;
  }
  return null;
}

function fmtRp(n: number): string {
  return `Rp ${n.toLocaleString("id-ID")}`;
}

/** Local (not UTC) YYYY-MM-DD — avoids the WIB day-off bug of toISOString(). */
function localISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return localISO(d);
}
function isValidISO(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T12:00:00`).getTime());
}

/** Resolve check-in/check-out (default: today → tomorrow). Throws on bad dates. */
export function resolveStay(checkin?: string, checkout?: string): Stay {
  const today = wibDay();
  if (checkin && !isValidISO(checkin)) throw new Error(`tanggal check-in tidak valid: "${checkin}" — pakai format YYYY-MM-DD`);
  if (checkout && !isValidISO(checkout)) throw new Error(`tanggal check-out tidak valid: "${checkout}" — pakai format YYYY-MM-DD`);
  const ci = checkin || today;
  let co = checkout || addDays(ci, 1);
  if (co <= ci) co = addDays(ci, 1);
  const nights = Math.max(1, Math.round((new Date(`${co}T12:00:00`).getTime() - new Date(`${ci}T12:00:00`).getTime()) / 86_400_000));
  return { checkin: ci, checkout: co, nights };
}

/** Booking review-score text → "9,3" / "10" (fixes the integer-score bug). */
export function parseScore(txt: string): string | null {
  const m = txt.match(/Skor\s*(\d+(?:[.,]\d+)?)/);
  if (m) return m[1].replace(".", ",");
  const m2 = txt.match(/(\d+(?:[.,]\d+)?)/);
  return m2 ? m2[1].replace(".", ",") : null;
}

type CacheEntry = { at: number; value: Awaited<ReturnType<typeof fetchHotels>> };
const CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10 * 60_000;

export async function getHotels(location: string, budgetStr?: string, opts: HotelQuery = {}): Promise<{
  location: string;
  budget: number | null;
  checkin: string;
  checkout: string;
  nights: number;
  hotels: Hotel[];
  human: string;
}> {
  const loc = location.trim().replace(/\s+/g, " ").slice(0, 80);
  if (!loc) throw new Error("location wajib diisi");
  const budget = opts.budget ?? parseBudget(budgetStr);
  const stay = resolveStay(opts.checkin, opts.checkout);
  const adults = Math.min(10, Math.max(1, Math.round(opts.adults || 1)));
  const rooms = Math.min(5, Math.max(1, Math.round(opts.rooms || 1)));
  const order = opts.sort === "rating" ? "bayesian_review_score" : opts.sort === "price" ? "price" : "popularity";

  const cacheKey = `${loc}|${stay.checkin}|${stay.checkout}|${adults}|${rooms}|${order}`;
  const cached = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }

  const value = await fetchHotels(loc, budget, stay, adults, rooms, order, opts);
  CACHE.set(cacheKey, { at: Date.now(), value });
  if (CACHE.size > 40) {
    const now = Date.now();
    for (const [k, v] of CACHE) if (now - v.at >= CACHE_TTL_MS) CACHE.delete(k);
  }
  return value;
}

async function fetchHotels(
  loc: string,
  budget: number | null,
  stay: Stay,
  adults: number,
  rooms: number,
  order: string,
  opts: HotelQuery
): Promise<{ location: string; budget: number | null; checkin: string; checkout: string; nights: number; hotels: Hotel[]; human: string }> {
  const { checkin, checkout, nights } = stay;
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      locale: "id-ID",
      extraHTTPHeaders: { "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8" },
    });
    const page = await ctx.newPage();
    const url = `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(loc)}&checkin=${checkin}&checkout=${checkout}&group_adults=${adults}&no_rooms=${rooms}&order=${order}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    try {
      const btn = page.locator('button:has-text("Accept"), button:has-text("Terima"), button#onetrust-accept-btn-handler').first();
      if (await btn.isVisible({ timeout: 3000 })) await btn.click({ timeout: 3000 });
    } catch {}
    let gotCards = true;
    try {
      await page.waitForSelector('div[data-testid="property-card"]', { timeout: 12000 });
    } catch {
      gotCards = false;
    }
    // Unknown destinations make Booking redirect to the homepage (index.*),
    // which is a "no results" case, NOT a bot-check.
    const finalUrl = page.url();
    const redirectedHome = !/searchresults/.test(finalUrl);

    const raw = await page.$$eval('div[data-testid="property-card"]', (cards) =>
      cards.map((card) => {
        const el = card as HTMLElement;
        const priceText = (el.querySelector('[data-testid="price-and-discounted-price"]')?.textContent || "").trim();
        const scoreText = (el.querySelector('[data-testid="review-score"]')?.textContent || "").trim();
        const linkEl = el.querySelector('a[data-testid="title-link"], a[href*="/hotel/"]');
        let link = (linkEl as HTMLAnchorElement)?.href || "";
        if (link && !link.startsWith("http")) link = `https://www.booking.com${link}`;
        try {
          const u = new URL(link);
          const m = u.pathname.match(/\/hotel\/[^/]+\/[^.]+\.html/);
          if (m) link = `https://www.booking.com${m[0]}`;
          else if (u.pathname.includes("/hotel/")) link = `https://www.booking.com${u.pathname.split("?")[0]}`;
        } catch {}
        return {
          name: (el.querySelector('[data-testid="title"]')?.textContent || "").trim(),
          priceText,
          scoreText,
          distance: (el.querySelector('[data-testid="distance"]')?.textContent || "").trim(),
          starSpans: el.querySelectorAll('[data-testid="rating-stars"] span, [data-testid="rating-squares"] span').length,
          link,
        };
      })
    );

    let hotels: Hotel[] = raw
      .map((x) => {
        const digits = (x.priceText || "").replace(/[^0-9]/g, "");
        const price = digits ? Number(digits) : 0;
        const stars = x.starSpans ? Math.round(x.starSpans / 2) : null;
        return {
          name: x.name,
          price,
          perNight: nights > 0 ? Math.round(price / nights) : price,
          rating: parseScore(x.scoreText),
          stars: stars && stars >= 1 && stars <= 5 ? stars : null,
          distance: x.distance || null,
          link: x.link,
        };
      })
      .filter((h) => h.name && h.price > 0 && h.link);

    if (opts.minRating) hotels = hotels.filter((h) => Number((h.rating || "0").replace(",", ".")) >= Number(opts.minRating));
    if (opts.stars) hotels = hotels.filter((h) => (h.stars ?? 0) >= Number(opts.stars));

    // Budget filter compares PER-NIGHT (budget is a per-night mental model).
    let bandNote = "";
    if (budget !== null) {
      const low = Math.round(budget * 0.6);
      const high = Math.round(budget * 1.5);
      const inBand = hotels.filter((h) => h.perNight >= low && h.perNight <= high);
      if (inBand.length) hotels = inBand;
      else bandNote = ` (di luar band ${fmtRp(low)}–${fmtRp(high)}/malam — ini terdekat)`;
    }

    const sort = opts.sort ?? "price";
    if (sort === "rating") hotels.sort((a, b) => Number((b.rating || "0").replace(",", ".")) - Number((a.rating || "0").replace(",", ".")));
    else if (sort === "price") hotels.sort((a, b) => a.perNight - b.perNight);
    const top = hotels.slice(0, 8);

    const when = nights > 1 ? `${checkin} → ${checkout} (${nights} malam)` : `${checkin} → ${checkout}`;
    const header = `📅 ${when}${budget ? `, budget ~${fmtRp(budget)}/malam` : ""}${adults > 1 || rooms > 1 ? ` · ${adults} tamu, ${rooms} kamar` : ""}:`;

    if (!top.length) {
      if (!gotCards && !redirectedHome) {
        const body = await page.content().catch(() => "");
        // Only a real interstitial counts (the word "captcha" appears in the
        // homepage/scripts, so it must NOT be a marker).
        if (/unusual traffic|verify you are human|press and hold|tekan & tahan|\/sorry\b|challenge-platform/i.test(body)) {
          throw new Error("Booking bot-check — coba lagi beberapa menit");
        }
      }
      const reason = redirectedHome ? `destinasi "${loc}" tidak dikenali Booking` : `tidak ada hasil untuk "${loc}"`;
      const human = `${header}\n⚠️ ${reason}${budget ? ` di budget ~${fmtRp(budget)}/malam` : ""} — coba lokasi/tanggal/budget lain atau cek booking.com manual.`;
      return { location: loc, budget, checkin, checkout, nights, hotels: [], human };
    }
    const lines = top.map((h) => {
      const inBudget = budget === null ? true : h.perNight <= budget;
      const emoji = inBudget ? "💚" : "💙";
      const ratingStr = h.rating ? ` (Skor ${h.rating})` : "";
      const starStr = h.stars ? ` ${"★".repeat(h.stars)}` : "";
      const dist = h.distance ? ` · ${h.distance}` : "";
      const total = nights > 1 ? ` (total ${fmtRp(h.price)} / ${nights} mlm)` : "";
      return `${emoji} ${h.name}${starStr} — ${fmtRp(h.perNight)}/malam${total}${ratingStr}${dist} — ${h.link}`;
    });
    const human = `${header}${bandNote}\n${lines.join("\n")}`;
    return { location: loc, budget, checkin, checkout, nights, hotels: top, human };
  } finally {
    await browser.close().catch(() => {});
  }
}
