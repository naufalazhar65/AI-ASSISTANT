/**
 * Transport schedules (keyless): intercity TRAIN via Traveloka's server-rendered
 * route page (`__NEXT_DATA__` → schedules[]) and intercity BUS via
 * busonlineticket.co.id's route table.
 *
 * Grounded by design: every value is parsed from a fetched page; a miss or a
 * broken layout returns an honest error, never an invented schedule.
 */
const UA = "Mozilla/5.0 (compatible; MiaTransportBot/1.0; +personal assistant)";
const TIMEOUT_MS = 20_000;
const MAX_HTML = 6_000_000;
const MAX_OUT = 3500;

const CITY_ALIASES: Record<string, string> = {
  jogja: "yogyakarta",
  yogya: "yogyakarta",
  jogjakarta: "yogyakarta",
  "jakarta pusat": "jakarta",
  "jakarta selatan": "jakarta",
  "jakarta barat": "jakarta",
  "jakarta timur": "jakarta",
  "jakarta utara": "jakarta",
};

export function slugify(s: string): string {
  const c = s.trim().toLowerCase();
  return (CITY_ALIASES[c] ?? c).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function getHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "id-ID,id;q=0.9" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`sumber tidak bisa diakses (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_HTML) throw new Error("halaman terlalu besar");
  return buf.toString("utf8");
}

function decode(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ");
}
const strip = (s: string): string => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const hm = (t: { hour: number; minute: number }): string => `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;
const rp = (n: number): string => `Rp ${n.toLocaleString("id-ID")}`;

export type Train = {
  number: string;
  name: string;
  klass: string;
  depart: string;
  arrive: string;
  duration: string;
  fare: number | null;
  from: string;
  to: string;
};

/** Parse Traveloka's `__NEXT_DATA__` schedules[] (pure, unit-testable). */
export function parseTravelokaSchedules(html: string): Train[] {
  const m = html.match(/id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return [];
  let data: unknown;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return [];
  }
  const schedules = (data as { props?: { pageProps?: { automationProps?: { schedules?: unknown[] } } } })
    ?.props?.pageProps?.automationProps?.schedules;
  if (!Array.isArray(schedules)) return [];
  return schedules
    .map((s) => {
      const r = s as Record<string, { hour?: number; minute?: number } & Record<string, unknown>>;
      const dep = r.departureTime as { hour?: number; minute?: number } | undefined;
      const arr = r.arrivalTime as { hour?: number; minute?: number } | undefined;
      const dur = r.durationFmt as { hour?: number; minute?: number } | undefined;
      const fare = r.fareFmt as { amount?: number } | undefined;
      return {
        number: String(r.trainNumber ?? ""),
        name: String(r.trainName ?? ""),
        klass: String(r.seatClass ?? ""),
        depart: dep && typeof dep.hour === "number" ? hm(dep as { hour: number; minute: number }) : "",
        arrive: arr && typeof arr.hour === "number" ? hm(arr as { hour: number; minute: number }) : "",
        duration: dur ? `${dur.hour ?? 0}j ${dur.minute ?? 0}m` : "",
        fare: typeof fare?.amount === "number" ? fare.amount : null,
        from: String(r.originStationLabel ?? ""),
        to: String(r.destinationStationLabel ?? ""),
      };
    })
    .filter((t) => t.name && t.depart);
}

export type Bus = { operator: string; first: string; last: string; trips: string; price: number | null };

/** Parse the busonlineticket route table (pure, unit-testable). */
export function parseBusTable(html: string): Bus[] {
  const out: Bus[] = [];
  for (const rowM of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = rowM[1];
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1].replace(/<script[\s\S]*?<\/script>/gi, ""));
    if (cells.length < 5) continue;
    const cells2 = cells.map(strip);
    if (!/\d{1,2}:\d{2}/.test(cells2[1] ?? "")) continue; // skip header
    const op = cells2[0];
    if (!op) continue;
    const priceCell = cells2[cells2.length - 1] ?? "";
    const digits = priceCell.replace(/[^0-9]/g, "");
    out.push({
      operator: op,
      first: cells2[1] ?? "",
      last: cells2[2] ?? "",
      trips: cells2[3] ?? "",
      price: digits && Number(digits) >= 10000 ? Number(digits) : null,
    });
  }
  return out;
}

export type TrainResult = { from: string; to: string; schedules: Train[]; human: string };
export type BusResult = { from: string; to: string; operators: Bus[]; human: string };

/** Live intercity train schedules Jakarta→Bandung etc. (Traveloka route page). */
export async function trainSearch(from: string, to: string): Promise<TrainResult> {
  const o = from.trim(), d = to.trim();
  if (!o || !d) throw new Error("sebutkan kota asal dan tujuan, mis. 'Jakarta' 'Bandung'");
  const url = `https://www.traveloka.com/id-id/kereta-api/rute/${slugify(o)}.${slugify(d)}`;
  const html = await getHtml(url);
  const schedules = parseTravelokaSchedules(html).sort((a, b) => a.depart.localeCompare(b.depart)).slice(0, 20);
  if (!schedules.length) {
    return { from: o, to: d, schedules: [], human: `Tidak ada jadwal kereta ${o} → ${d} yang bisa kubaca. Cek penulisan kota (mis. 'Jakarta', 'Bandung', 'Yogyakarta') atau buka traveloka/kai.id.` };
  }
  const lines = schedules.map(
    (t) => `• ${t.name}${t.number ? ` (${t.number})` : ""} ${t.klass} — ${t.depart} → ${t.arrive} (${t.duration})${t.fare ? ` · ${rp(t.fare)}` : ""} · ${t.from} → ${t.to}`
  );
  return { from: o, to: d, schedules, human: `🚆 Kereta ${o} → ${d} (${schedules.length} jadwal):\n${lines.join("\n")}`.slice(0, MAX_OUT) };
}

/** Live intercity bus/travel operators Jakarta→Bandung etc. (busonlineticket). */
export async function busSearch(from: string, to: string): Promise<BusResult> {
  const o = from.trim(), d = to.trim();
  if (!o || !d) throw new Error("sebutkan kota asal dan tujuan, mis. 'Jakarta' 'Bandung'");
  const url = `https://www.busonlineticket.co.id/id-id/tiket-bus-${slugify(o)}-ke-${slugify(d)}`;
  const html = await getHtml(url);
  const operators = parseBusTable(html).slice(0, 20);
  if (!operators.length) {
    return { from: o, to: d, operators: [], human: `Tidak ada jadwal bus ${o} → ${d} yang bisa kubaca. Cek penulisan kota atau buka busonlineticket/traveloka.` };
  }
  const lines = operators.map(
    (b) => `• ${b.operator} — ${b.first}–${b.last}${b.trips ? ` (${b.trips} keberangkatan)` : ""}${b.price ? ` · dari ${rp(b.price)}` : ""}`
  );
  return { from: o, to: d, operators, human: `🚌 Bus/travel ${o} → ${d} (${operators.length} operator):\n${lines.join("\n")}\n\n(Sumber: busonlineticket — operator yang bisa dipesan online; bisa belum lengkap, operator seperti Primajasa/Sinar Jaya mungkin tak tercantum.)`.slice(0, MAX_OUT) };
}
