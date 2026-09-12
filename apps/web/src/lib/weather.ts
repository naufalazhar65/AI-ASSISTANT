// Weather Jakarta — free wttr.in + Open-Meteo (no key), Nominatim geocode.

const UA = "mia-assistant/1.0 (https://github.com/naufalazhar65/AI-ASSISTANT)";

export type WeatherResult = {
  location: string;
  lat: number;
  lon: number;
  temp_c: number;
  desc: string;
  humidity: number | null;
  wind_kmh: number | null;
  time: string | null;
  code: number | null;
  source: "wttr" | "open-meteo";
  human: string;
};

function parseLatLon(s: string): { lat: number; lon: number } | null {
  const m = s.trim().match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lat = Number(m[1]), lon = Number(m[2]);
  if (Number.isNaN(lat) || Number.isNaN(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

async function geocode(query: string): Promise<{ lat: number; lon: number; display: string }> {
  const direct = parseLatLon(query);
  if (direct) return { ...direct, display: query };
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`geocode ${res.status} for "${query}"`);
  const arr = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
  if (!arr.length) throw new Error(`Cannot get coords for "${query}" — coba "BSD City, Tangerang"`);
  return { lat: Number(arr[0].lat), lon: Number(arr[0].lon), display: arr[0].display_name };
}

const WMO: Record<number, string> = {
  0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
  45: "fog", 48: "depositing rime fog", 51: "light drizzle", 53: "moderate drizzle", 55: "dense drizzle",
  61: "slight rain", 63: "moderate rain", 65: "heavy rain", 71: "slight snow", 73: "moderate snow", 75: "heavy snow",
  80: "slight showers", 81: "moderate showers", 82: "violent showers", 95: "thunderstorm", 96: "thunderstorm slight hail", 99: "thunderstorm heavy hail",
};

async function fetchWttr(location: string): Promise<WeatherResult | null> {
  try {
    const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1`;
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { current_condition?: Array<{ temp_C: string; weatherDesc: Array<{ value: string }>; humidity: string; windspeedKmph: string; observation_time: string; weatherCode: string }> };
    const cur = data.current_condition?.[0];
    if (!cur) return null;
    const temp = Number(cur.temp_C);
    if (Number.isNaN(temp)) return null;
    const desc = cur.weatherDesc?.[0]?.value ?? "";
    const code = Number(cur.weatherCode);
    return {
      location,
      lat: NaN, lon: NaN,
      temp_c: temp,
      desc: desc || (WMO[code] ?? ""),
      humidity: cur.humidity ? Number(cur.humidity) : null,
      wind_kmh: cur.windspeedKmph ? Number(cur.windspeedKmph) : null,
      time: cur.observation_time ?? null,
      code: Number.isNaN(code) ? null : code,
      source: "wttr",
      human: "",
    };
  } catch { return null; }
}

async function fetchOpenMeteo(lat: number, lon: number, location: string): Promise<WeatherResult> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&timezone=Asia%2FJakarta`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const data = (await res.json()) as { current?: { temperature_2m: number; relative_humidity_2m: number; wind_speed_10m: number; weather_code: number; time: string } };
  const cur = data.current;
  if (!cur) throw new Error("Open-Meteo no current");
  const code = cur.weather_code;
  return {
    location,
    lat, lon,
    temp_c: Math.round(cur.temperature_2m * 10) / 10,
    desc: WMO[code] ?? `code ${code}`,
    humidity: cur.relative_humidity_2m ?? null,
    wind_kmh: cur.wind_speed_10m ?? null,
    time: cur.time ?? null,
    code,
    source: "open-meteo",
    human: "",
  };
}

function humanize(r: WeatherResult): string {
  const parts = [`📍 ${r.location}: ${r.temp_c}°C ${r.desc}`];
  if (r.humidity !== null) parts.push(`humidity ${r.humidity}%`);
  if (r.wind_kmh !== null) parts.push(`wind ${r.wind_kmh} km/h`);
  const line = parts.join(", ");
  const meta = r.time ? `🕐 ${r.time} Asia/Jakarta` : "";
  const code = r.code !== null ? `code ${r.code} (${r.desc})` : "";
  return [line, [meta, code].filter(Boolean).join(" | ")].filter(Boolean).join("\n");
}

export async function getWeather(locationQuery: string): Promise<WeatherResult> {
  const geo = await geocode(locationQuery);
  // Prefer wttr.in by name (fast, no geocode needed) — then Open-Meteo with coords
  const wttr = await fetchWttr(locationQuery);
  if (wttr) {
    wttr.lat = geo.lat; wttr.lon = geo.lon;
    // Use geo display for accuracy but keep queried label for human
    wttr.human = humanize(wttr);
    return wttr;
  }
  const om = await fetchOpenMeteo(geo.lat, geo.lon, locationQuery);
  om.human = humanize(om);
  return om;
}
