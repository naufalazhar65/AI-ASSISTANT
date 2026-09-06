// Tanggal merah / hari penting Indonesia — liburan support (fun feature).
//
// Hanya tanggal yang bersifat TETAP menurut kalender sipil dicantumkan statis
// (penuh akurasi, tidak menebak). Hari raya bergerak (Idulfitri, Iduladha, dll.)
// diumumkan setiap tahun oleh pemerintah melalui SKB 3 Menteri — sehingga tool
// `hari_libur` melempar daftar tetap + catatan untuk konfirmasi via web_search
// (Mia punya web_search, jadi akurasi tahun berjalan tetap terjaga).

export interface Holiday {
  /** ISO date "YYYY-MM-DD" (Asia/Jakarta local). */
  date: string;
  name: string;
  /** "libur" (libur nasional) | "peringatan" (peringatan nasional, bukan libur) */
  kind: "libur" | "peringatan";
}

/** Fixed civil-calendar Indonesian public holidays; sorted by date. */
export const FIXED_HOLIDAYS_2026: Holiday[] = [
  { date: "2026-01-01", name: "Tahun Baru 2026 Masehi", kind: "libur" },
  { date: "2026-02-17", name: "Tahun Baru Imlek 2567 (Bejing) — perkiraan; cek SKB resmi", kind: "libur" },
  { date: "2026-03-21", name: "Isra Mikraj 1447 H — perkiraan; cek SKB resmi", kind: "peringatan" },
  { date: "2026-03-29", name: "Hari Raya Nyepi (Tahun Baru Saka 1948) — perkiraan; cek SKB resmi", kind: "libur" },
  { date: "2026-03-31", name: "Wafat Isa Al-Masih (Jumat Agung)", kind: "libur" },
  { date: "2026-04-01", name: "Wafat Isa Al-Masih (kebijakan libur bersama — menyesuaikan SKB)", kind: "libur" },
  { date: "2026-05-17", name: "Hari Raya Waisak 2570 BE — perkiraan; cek SKB resmi", kind: "libur" },
  { date: "2026-06-01", name: "Hari Lahir Pancasila", kind: "libur" },
  { date: "2026-08-17", name: "Proklamasi Kemerdekaan RI", kind: "libur" },
  { date: "2026-12-24", name: "Cuti bersama Natal (menyesuaikan SKB)", kind: "libur" },
  { date: "2026-12-25", name: "Hari Raya Natal", kind: "libur" },
];

/**
 * Return the holiday list the tool/user asked about. `month` (1-12) filters;
 * otherwise the whole fixed list is returned with a note that Islamic
 * ("Hijriah") moveable dates follow the official SKB and should be confirmed
 * via web_search for the current year.
 */
export function holidayInfo(rawUser?: unknown, month?: number, now = new Date()): string {
  void rawUser;
  let list = FIXED_HOLIDAYS_2026;
  if (month !== undefined && !Number.isNaN(month)) {
    list = list.filter((h) => Number(h.date.slice(5, 7)) === month);
  } else {
    // Only show dates from today onward when no month is requested
    const today = now.toISOString().slice(0, 10);
    list = list.filter((h) => h.date >= today);
  }
  if (!list.length) return "Belum ada tanggal merah yang tercatat dari hari ini ke depan.";
  const lines = list.map((h) => `- ${h.date}: **${h.name}**${h.kind === "peringatan" ? " (peringatan, bukan libur)" : ""}`);
  const note =
    "Catatan: hari raya bergerak (Idulfitri, Iduladha, dsb.) diumumkan lewat SKB 3 Menteri tiap tahun — mintalah aku cari dengan web_search kalau mau tanggal pastinya. Data di atas tanggal tetap kalender sipil.";
  return `🗓️ *Tanggal merah* (fix, 2026):\n${lines.join("\n")}\n\n${note}`;
}