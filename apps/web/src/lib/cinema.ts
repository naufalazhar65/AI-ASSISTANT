/**
 * Cinema showtimes + ticket prices for Indonesia, grounded in a live source
 * (jadwalnonton.com — aggregates XXI/CGV/Cinépolis/etc.). Read-only, no key.
 *
 * Design: never invent a showtime. Every answer is parsed from a fetched page,
 * and any failure/miss returns an honest message listing what IS available so
 * the model can correct itself instead of hallucinating.
 */
const BASE = "https://jadwalnonton.com";
const UA = "Mozilla/5.0 (compatible; MiaCinemaBot/1.0; +personal assistant)";
const TIMEOUT_MS = 15_000;
const MAX_HTML = 3_000_000;
const MAX_OUT = 3500;

/** City aliases for names the source files under a different slug. */
const CITY_ALIASES: Record<string, string> = {
  tangsel: "tangerang",
  "tangerang selatan": "tangerang",
  jogja: "yogyakarta",
  yogya: "yogyakarta",
  jogjakarta: "yogyakarta",
};

export function citySlug(city: string): string {
  const c = city.trim().toLowerCase();
  const a = CITY_ALIASES[c] ?? c;
  return a.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number(d)));
}

function clean(s: string): string {
  return decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

async function getHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`sumber jadwal tidak bisa diakses (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_HTML) throw new Error("halaman jadwal terlalu besar");
  return buf.toString("utf8");
}

export type Showtime = { format: string; price: string; times: string[] };
export type CinemaRef = { name: string; url: string };
export type FilmRef = { title: string; url: string; genre: string; duration: string };
export type FilmSchedule = { title: string; meta: string; rating: string; shows: Showtime[] };
export type FilmAtCinema = { cinema: string; url: string; shows: Showtime[] };

/** Cinemas in a city (source paginates ~10/page — follow up to 3 pages). */
export async function listCinemas(slug: string): Promise<CinemaRef[]> {
  const out: CinemaRef[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= 3; page++) {
    const url = `${BASE}/bioskop/di-${slug}/${page > 1 ? `?page=${page}` : ""}`;
    let html: string;
    try {
      html = await getHtml(url);
    } catch {
      break;
    }
    const re = /<a href="(https:\/\/jadwalnonton\.com\/bioskop\/di-[^"]+\/[^"]+\.html)">[\s\S]*?<span class="judul">([^<]+)<\/span>/g;
    let m: RegExpExecArray | null;
    let added = 0;
    while ((m = re.exec(html))) {
      const u = m[1];
      if (seen.has(u)) continue;
      seen.add(u);
      out.push({ name: decode(m[2]).trim(), url: u });
      added++;
    }
    if (added === 0) break;
  }
  return out;
}

/** Films currently showing in a city (title + genre + duration + film URL). */
export function parseNowPlaying(html: string): FilmRef[] {
  const out: FilmRef[] = [];
  const re = /<h2><a href="(https:\/\/jadwalnonton\.com\/film\/[^"]+)"[^>]*>([^<]+)<\/a><\/h2>\s*<span class="moket">([^<]*)<\/span>(?:\s*<span class="moket">([^<]*)<\/span>)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out.push({
      url: m[1],
      title: decode(m[2]).trim(),
      genre: clean(m[3]),
      duration: m[4] ? clean(m[4]) : "",
    });
  }
  return out;
}

/** Schedule for one cinema: film blocks with format/price/time groups. */
export function parseCinemaPage(html: string): FilmSchedule[] {
  const out: FilmSchedule[] = [];
  for (const b of html.split('<div class="item">').slice(1)) {
    const t = b.match(/<h2><a [^>]*>([^<]+)<\/a>/);
    if (!t) continue;
    const meta = b.match(/<p>([^<]*?Menit[^<]*?)<\/p>/);
    const rating = b.match(/class="right rating[^"]*"[^>]*>([^<]+)</);
    const shows: Showtime[] = [];
    const sre = /<span class="showgroup"[^>]*>([^<]+)<\/span>\s*<span class="htm"><i class="icon-ticket"><\/i>Tiket Rp\.?\s*([0-9.]+)<\/span>\s*<ul[^>]*>([\s\S]*?)<\/ul>/g;
    let m: RegExpExecArray | null;
    while ((m = sre.exec(b))) {
      shows.push({
        format: decode(m[1]).trim(),
        price: m[2],
        times: [...m[3].matchAll(/<li[^>]*>(\d{1,2}:\d{2})<\/li>/g)].map((x) => x[1]),
      });
    }
    out.push({ title: decode(t[1]).trim(), meta: meta ? clean(meta[1]) : "", rating: rating ? rating[1].trim() : "", shows });
  }
  return out;
}

/** Every cinema in a city showing one film (film-by-city page). */
export function parseFilmCityPage(html: string): FilmAtCinema[] {
  const out: FilmAtCinema[] = [];
  for (const b of html.split('<div class="item" data-key="').slice(1)) {
    const name = b.match(/<h2><a href="([^"]+)"[^>]*>([^<]+)<\/a>/);
    if (!name) continue;
    const shows: Showtime[] = [];
    const gre = /<b class="htm"[^>]*>([^<]+)<\/b>\s*<span class="htm">Tiket Rp\.?\s*([0-9.]+)<\/span>[\s\S]*?<ul>([\s\S]*?)<\/ul>/g;
    let m: RegExpExecArray | null;
    while ((m = gre.exec(b))) {
      shows.push({
        format: decode(m[1]).trim(),
        price: m[2],
        times: [...m[3].matchAll(/<li[^>]*>(\d{1,2}:\d{2})<\/li>/g)].map((x) => x[1]),
      });
    }
    out.push({ url: name[1], cinema: decode(name[2]).trim(), shows });
  }
  return out;
}

function pageDate(html: string): string {
  const m = html.match(/JADWAL HARI INI\s*([A-Za-z]+,?\s*\d{1,2}\s+\w+\s+\d{4})/i);
  return m ? m[1].trim() : "";
}

const money = (p: string): string => `Rp ${p}`;

export type CinemaQuery = { city: string; cinema?: string; film?: string; genre?: string };

/**
 * Grounded showtimes lookup. Modes:
 *  - cinema set  → that cinema's schedule (optionally filtered by `film`)
 *  - film set    → every cinema in the city showing that film
 *  - neither     → films now playing in the city (optionally filtered by `genre`)
 */
export async function cinemaShowtimes(q: CinemaQuery): Promise<string> {
  const city = (q.city || "").trim();
  if (!city) throw new Error("sebutkan kota, mis. 'Tangerang' atau 'Tangsel'");
  const slug = citySlug(city);
  const cinemaQ = (q.cinema || "").trim().toLowerCase();
  const filmQ = (q.film || "").trim().toLowerCase();
  const genreQ = (q.genre || "").trim().toLowerCase();

  if (cinemaQ) {
    const cinemas = await listCinemas(slug);
    if (!cinemas.length) throw new Error(`tidak ada bioskop ditemukan untuk kota "${city}"`);
    const matches = cinemas.filter((c) => c.name.toLowerCase().includes(cinemaQ));
    if (!matches.length) {
      return `Bioskop "${q.cinema}" tidak ada di ${city}. Pilihan: ${cinemas.map((c) => c.name).join(", ").slice(0, 1400)}`;
    }
    const exact = matches.find((c) => c.name.toLowerCase() === cinemaQ);
    if (!exact && matches.length > 1) {
      return `Ada ${matches.length} bioskop cocok "${q.cinema}": ${matches.map((c) => c.name).join(", ")} — sebutkan lebih spesifik.`;
    }
    const chosen = exact ?? matches[0];
    const html = await getHtml(chosen.url);
    const date = pageDate(html);
    let films = parseCinemaPage(html);
    if (filmQ) films = films.filter((f) => f.title.toLowerCase().includes(filmQ));
    if (!films.length) {
      return `Tidak ada film ${filmQ ? `"${q.film}" ` : ""}yang tayang di ${chosen.name}${date ? ` (${date})` : ""}.`;
    }
    const body = films
      .map(
        (f) =>
          `• ${f.title}${f.rating ? ` [${f.rating}]` : ""}${f.meta ? ` — ${f.meta}` : ""}\n  ` +
          f.shows.map((s) => `${s.format} ${money(s.price)}: ${s.times.join(", ")}`).join("\n  ")
      )
      .join("\n");
    return `${chosen.name}${date ? ` — ${date}` : ""}\n${body}`.slice(0, MAX_OUT);
  }

  const np = await getHtml(`${BASE}/now-playing/in-${slug}/`);
  const films = parseNowPlaying(np);

  if (filmQ) {
    const hit = films.find((f) => f.title.toLowerCase().includes(filmQ));
    if (!hit) {
      return `Film "${q.film}" tidak sedang tayang di ${city}. Yang tayang: ${films.map((f) => f.title).join(", ").slice(0, 1400)}`;
    }
    const fc = await getHtml(`${hit.url.replace(/\/$/, "")}/di-${slug}/`);
    const rows = parseFilmCityPage(fc).filter((r) => r.shows.some((s) => s.times.length));
    if (!rows.length) return `Belum ada jadwal tayang "${hit.title}" di ${city}.`;
    const body = rows
      .map((r) => `• ${r.cinema}\n  ` + r.shows.map((s) => `${s.format} ${money(s.price)}: ${s.times.join(", ")}`).join("\n  "))
      .join("\n");
    return `${hit.title}${hit.genre ? ` (${hit.genre}${hit.duration ? `, ${hit.duration}` : ""})` : ""} di ${city}:\n${body}`.slice(0, MAX_OUT);
  }

  const filtered = genreQ ? films.filter((f) => `${f.genre} ${f.title}`.toLowerCase().includes(genreQ)) : films;
  if (!filtered.length) {
    return `Tidak ada film ${genreQ ? `genre "${q.genre}" ` : ""}yang sedang tayang di ${city}.`;
  }
  return (
    `Film sedang tayang di ${city}${genreQ ? ` (genre ${q.genre})` : ""}:\n` +
    filtered.map((f) => `• ${f.title}${f.genre ? ` — ${f.genre}` : ""}${f.duration ? ` (${f.duration})` : ""}`).join("\n")
  ).slice(0, MAX_OUT);
}
