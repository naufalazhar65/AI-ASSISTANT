// Hotel Finder — live via Playwright + Booking.com (no API key)
// Spec: ./hotel.sh "Bandung" "400rb"  -> Booking search, filter, output.

import { chromium } from "playwright";

export type Hotel = { name: string; price: number; rating: string | null; link: string };

function parseBudget(s: string | undefined): number | null {
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

function todayTomorrow(): { checkin: string; checkout: string } {
  const d = new Date();
  const toISO = (x: Date) => x.toISOString().slice(0, 10);
  const tomorrow = new Date(d);
  tomorrow.setDate(d.getDate() + 1);
  return { checkin: toISO(d), checkout: toISO(tomorrow) };
}

export async function getHotels(location: string, budgetStr?: string): Promise<{ location: string; budget: number | null; checkin: string; checkout: string; hotels: Hotel[]; human: string }> {
  const loc = location.trim();
  if (!loc) throw new Error("location wajib diisi");
  const budget = parseBudget(budgetStr);
  const { checkin, checkout } = todayTomorrow();

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      locale: "id-ID",
      extraHTTPHeaders: { "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8" },
    });
    const page = await ctx.newPage();
    const url = `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(loc)}&checkin=${checkin}&checkout=${checkout}&group_adults=1&no_rooms=1&order=popularity`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    // Dismiss cookie banner if present (best-effort)
    try {
      const btn = page.locator('button:has-text("Accept"), button:has-text("Terima"), button#onetrust-accept-btn-handler').first();
      if (await btn.isVisible({ timeout: 3000 })) await btn.click({ timeout: 3000 });
    } catch {}
    try { await page.waitForSelector('div[data-testid="property-card"]', { timeout: 12000 }); } catch {
      const body = await page.content();
      if (body.includes("bot") || body.includes("captcha") || body.includes("unusual traffic")) {
        throw new Error("Booking bot-check — coba lagi beberapa menit");
      }
      // No cards but page loaded — treat as no results
    }

    const raw: Hotel[] = await page.$$eval('div[data-testid="property-card"]', (cards) =>
      cards.map((card) => {
        const el = card as HTMLElement;
        const nameEl = el.querySelector('[data-testid="title"]');
        const name = (nameEl?.textContent || "").trim();
        const priceEl = el.querySelector('[data-testid="price-and-discounted-price"]');
        const priceText = (priceEl?.textContent || "").trim();
        // also fallback to any element with Rp
        const priceMatch = priceText.match(/Rp\s*([\d.,]+)/);
        // rating: [data-testid="review-score"] or similar
        const ratingEl = el.querySelector('[data-testid="review-score"]');
        let rating: string | null = null;
        if (ratingEl) {
          const txt = (ratingEl.textContent || "").trim();
          const m = txt.match(/(\d+[.,]\d+)/);
          rating = m ? m[1].replace(".", ",") : txt.split("\n")[0].trim().slice(0, 10);
        }
        const linkEl = el.querySelector('a[data-testid="title-link"], a[data-testid="property-card-desktop-single-image"], a[href*="/hotel/"]');
        let link = (linkEl as HTMLAnchorElement)?.href || "";
        // normalize to booking.com/hotel/... link
        if (link && !link.startsWith("http")) link = `https://www.booking.com${link}`;
        // strip to hotel slug
        try {
          const u = new URL(link);
          const m = u.pathname.match(/\/hotel\/[^/]+\/[^.]+\.html/);
          if (m) link = `https://www.booking.com${m[0]}`;
          else if (u.pathname.includes("/hotel/")) link = `https://www.booking.com${u.pathname.split("?")[0]}`;
        } catch {}
        return { name, priceText, rating, link };
      }).map((x: { name: string; priceText: string; rating: string | null; link: string }) => {
        const digits = (x.priceText || "").replace(/[^0-9]/g, "");
        const price = digits ? Number(digits) : 0;
        return { name: x.name, price, rating: x.rating, link: x.link };
      })
    );

    // Filter and sort
    let filtered = raw.filter((h) => h.name && h.price >= 200000 && h.link);
    if (budget !== null) {
      const low = Math.round(budget * 0.6);
      const high = Math.round(budget * 1.5);
      filtered = filtered.filter((h) => h.price >= low && h.price <= high);
    }
    filtered.sort((a, b) => a.price - b.price);
    const top = filtered.slice(0, 6);

    // Human output
    const header = `📅 ${checkin} → ${checkout}${budget ? `, budget ${fmtRp(budget)}` : ""}:`;
    if (!top.length) {
      const human = `${header}\n⚠️ Tidak ada hasil untuk "${loc}"${budget ? ` di budget ${fmtRp(budget)}` : ""} — coba lokasi/budget lain atau cek booking.com manual.`;
      return { location: loc, budget, checkin, checkout, hotels: [], human };
    }
    const lines = top.map((h) => {
      const inBudget = budget === null ? true : h.price <= budget;
      const emoji = inBudget ? "💚" : "💙";
      const ratingStr = h.rating ? ` (Skor ${h.rating})` : "";
      return `${emoji} ${h.name} — ${fmtRp(h.price)}${ratingStr} — ${h.link}`;
    });
    const human = `${header}\n${lines.join("\n")}`;
    return { location: loc, budget, checkin, checkout, hotels: top, human };
  } finally {
    await browser.close().catch(() => {});
  }
}
