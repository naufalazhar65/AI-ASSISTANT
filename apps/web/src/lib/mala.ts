// Mia's daily fortune ("ramalan harian") — deterministic fun feature.
//
// A seeded PRNG keyed by (date, user) so the reading is:
//   - stable: the same user sees the SAME fortune all day (it can be re-asked
//     without changing every time), and
//   - varied: it changes every day, no API/LLM cost, works offline and in mock.
//
// Everything is Mia-flavored Indonesian riddle/horoscope-style templates drawn
// from local pools. Zero external calls.

export interface MalaReading {
  date: string;
  mood: string;        // suasana hati hari ini
  color: string;       // warna keberuntungan
  number: number;      // angka keberuntungan 1-99
  streakHint: string;  // pesan soal "nasib hari ini"
  message: string;     // pesan penutup khas Mia
}

const MOODS = [
  "ceria dan mudah senyum",
  "tenang kayak air danau",
  "penasaran — hari yang bagus buat coba hal baru",
  "agak melow, tapi kayaknya bakal membaik",
  "petualang — siap-siap sesuatu yang nggak terduga",
  "seimbang, mau kerja mau santai semua lancar",
  "semangat nggebu-nggebu, jangan ditahan",
  "kalem, cocoknya hari ini santai aja dulu",
] as const;

const COLORS = ["merah", "biru", "hijau", "kuning", "ungu", "pink", "hitam", "putih"] as const;

const STREAK_HINTS = [
  "ada ide bagus yang bakal muncul pas kamu lagi santai",
  "seseorang tiba-tiba ingat kamu — mungkin bales chat yang tadi kamu enggak sempat",
  "angka favorit kamu bakal muncul dua kali hari ini",
  "lagu yang lagi nyangkut di kepala artinya musik adalah obatmu hari ini",
  "hujan atau tidak, bawain jaket — pertahanan diri itu penting 😄",
  "kelincahanmu lagi tinggi, cocok buat nyelesaikan tugas yang kamu tunda",
] as const;

const MESSAGES = [
  "Ingat, ramalan cuma guyonan — tapi kamu emang layak dapat hari yang baik 🌸",
  "Jangan lupa semangatnya dibawa terus, ya. Aku selalu di sini.",
  "Boleh percaya boleh enggak, yang penting air putih dan senyum dikit 🌸",
  "Kalau hari ini berasa berat, inget kamu pernah lewatin yang lebih berat. Sip, kan?",
  "Satu lagi: kamera kucing di internet selalu benerin mood, itu bukan mitos 😄",
] as const;

/** Deterministic 32-bit hash of a string (xmur3-style), just for seeding. */
function hashSeed(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

/** Mulberry32 PRNG — deterministic from a seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

/** Build the seeded reading for a user on a given local date (default today). */
export function buildMala(rawUser?: unknown, date = new Date()): MalaReading {
  const userKey = String(rawUser ?? "shared").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40) || "shared";
  const day = date.toISOString().slice(0, 10);
  const rng = mulberry32(hashSeed(`${day}|${userKey}`));
  return {
    date: day,
    mood: pick(rng, MOODS),
    color: pick(rng, COLORS),
    number: 1 + Math.floor(rng() * 99),
    streakHint: pick(rng, STREAK_HINTS),
    message: pick(rng, MESSAGES),
  };
}

/** Render the reading as a friendly Mia chat line (all platforms, no markdown). */
export function renderMala(rawUser?: unknown, date = new Date()): string {
  const r = buildMala(rawUser, date);
  return (
    `✨ *Ramalan Mia* buat ${r.date} (versi santai, ya~)\n` +
    `Suasana hati: ${r.mood}.\n` +
    `Warna keberuntungan: ${r.color}. Angka: ${r.number}.\n` +
    `Petunjuk: ${r.streakHint}.\n` +
    `${r.message}`
  );
}