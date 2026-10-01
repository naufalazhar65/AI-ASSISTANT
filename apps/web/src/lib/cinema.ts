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

/**
 * True for unambiguous NOW-SHOWING asks (vs filmography/news/research).
 * Used by `web_search` to redirect to `cinema_showtimes` deterministically:
 * the model kept burning calls on web/news sources for schedule asks
 * (owner 2026-10-01: 5 wasted calls, zero on cinema, then deflection), and
 * in-context precedent beats prompt rules. Kept narrow on purpose —
 * "film terbaru Jason Statham" (filmography) and "sejarah film" must pass
 * through to web search untouched.
 */
export function isShowtimeQuery(query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  const medium = /(film|movie|cinema|bioskop|xxi|cgv|tiket)\b/.test(q);
  if (!medium) return false;
  return /\b(tayang|jadwal|showtimes?|jam tayang|sedang tayang)\b/.test(q) ||
    (/\bbioskop\b/.test(q) && /\b(terbaru|ada apa|sekarang|hari ini|tiket|jam)\b/.test(q));
}

/** City aliases for names the source files under a different slug. */
const CITY_ALIASES: Record<string, string> = {
  tangsel: "tangerang",
  "tangerang selatan": "tangerang",
  // Greater Tangerang areas all filed under "Tangerang"
  serpong: "tangerang",
  "serpong utara": "tangerang",
  bsd: "tangerang",
  "bsd city": "tangerang",
  bintaro: "tangerang",
  ciputat: "tangerang",
  pamulang: "tangerang",
  ciledug: "tangerang",
  karawaci: "tangerang",
  "alam sutera": "tangerang",
  "gading serpong": "tangerang",
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

/**
 * Synopsis off a film detail page (`/film/YYYY/slug/`). The text lives in the
 * `#tr_synf` block after an embedded trailer iframe; everything from
 * "Baca juga :" on is site chrome, not story. Returns "" when absent —
 * callers fall back to schedules-only instead of inventing a plot.
 * Pure — fixture-locked in verify.ts.
 */
export function parseFilmSynopsis(html: string): string {
  const i = html.indexOf('id="tr_synf"');
  if (i < 0) return "";
  let seg = html.slice(i, i + 4000);
  seg = seg.replace(/<iframe.*?<\/iframe>/gs, " ");
  seg = seg.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  const cut = seg.search(/Baca juga :|JADWAL|Trailer (Terbaru|Terbarunya)/i);
  if (cut > 0) seg = seg.slice(0, cut).trim();
  // Tag-stripping leaves the div's own attribute text at the head
  // (`id="tr_synf">`), then the section header — remove both, keep story.
  seg = seg.replace(/^id="tr_synf">\s*/i, "").replace(/^(Trailer & Sinopsis|Sinopsis)\s*/i, "").trim();
  return seg.slice(0, 600);
}

function pageDate(html: string): string {
  // The date sits behind a tag (e.g. "JADWAL HARI INI <span>Senin, 14 September 2026</span>")
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const m = text.match(/JADWAL HARI INI\s*([A-Za-z]+,?\s*\d{1,2}\s+\w+\s+\d{4})/i);
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
    // Fuzzy match (owner 2026-10-01): "Teras Kota" must find "CGV Teraskota".
    // Normalize spaces/punctuation on both sides, and accept token overlap so
    // chain prefixes (CGV/XXI) and spacing variants never cause a miss.
    const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const cinemaTokens = (s: string): string[] =>
      s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !/^(xxi|cgv|cinepolis|cineplex|the|mall|plaza|city|kota|grand|supermal|living|world|icon|walk|aeon|bale|bandara|foodmosphere|batavia|ciputra|paradise|transmart|bintaro|cikupa|karawaci|serpong|cileduks?|kutabumi|maxxbox|village|ecoplaza|alamsutera)$/.test(t));
    const qNorm = norm(cinemaQ);
    const qToks = cinemaTokens(cinemaQ);
    const matches = cinemas.filter((c) => {
      const name = c.name.toLowerCase();
      const nNorm = norm(name);
      if (name.includes(cinemaQ) || nNorm.includes(qNorm) || qNorm.includes(nNorm)) return true;
      const nToks = cinemaTokens(name);
      return qToks.some((t) => nToks.some((n) => n.includes(t) || t.includes(n)));
    });
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
    // Synopsis rides along when a film is named (owner 2026-10-01: "tentang
    // apa?" died in web_search twice). Best-effort: a missing block leaves
    // schedules untouched, never an invented plot.
    let synopsis = "";
    try {
      const filmPage = await getHtml(hit.url);
      const parsed = parseFilmSynopsis(filmPage);
      if (parsed) synopsis = `\nSinopsis: ${parsed}`;
    } catch {
      /* schedules stand on their own */
    }
    return `${hit.title}${hit.genre ? ` (${hit.genre}${hit.duration ? `, ${hit.duration}` : ""})` : ""} di ${city}:\n${body}${synopsis}`.slice(0, MAX_OUT);
  }

  const filtered = genreQ ? films.filter((f) => `${f.genre} ${f.title}`.toLowerCase().includes(genreQ)) : films;
  if (!filtered.length) {
    return `Tidak ada film ${genreQ ? `genre "${q.genre}" ` : ""}yang sedang tayang di ${city}.`;
  }
  // Cinema directory rides along (owner 2026-10-01: "bioskop terdekat dari
  // rumahku" had no dedicated tool, so the answer came from memory).
  // Best-effort and bounded: names only, never a failure.
  let directory = "";
  try {
    const cinemas = await listCinemas(slug);
    const names = [...new Set(cinemas.map((c) => c.name))].slice(0, 10);
    if (names.length) directory = `\nBioskop di ${city}: ${names.join(", ")}`;
  } catch {
    /* films stand on their own */
  }
  return (
    `Film sedang tayang di ${city}${genreQ ? ` (genre ${q.genre})` : ""}:\n` +
    filtered.map((f) => `• ${f.title}${f.genre ? ` — ${f.genre}` : ""}${f.duration ? ` (${f.duration})` : ""}`).join("\n") +
    directory
  ).slice(0, MAX_OUT);
}
