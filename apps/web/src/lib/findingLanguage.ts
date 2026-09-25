// findingLanguage.ts — Indonesian-prose detector for finding fields (2026-09-26).
//
// Findings feed the markdown/PDF deliverable, which must be submission-ready
// English for international bug-bounty platforms (owner request). The model is
// told to write English (tool description), but description-following is not a
// guarantee — live 2026-09-26: six findings recorded days earlier were still
// Indonesian, and the report shipped mixed-language. This gate REFUSES a
// predominantly-Indonesian field with an honest, actionable error so the model
// rewrites it. Deliberately conservative: the threshold is high (≥5 distinct
// markers or ≥3 with high density) so real English prose full of quoted
// Indonesian payloads/endpoints (judul, isi, catatan_internal, "Dokumen ini
// bersifat internal…") never false-positives. Pure — tested.

/** Distinctive Indonesian function/content words (word-boundary matched). */
const ID_MARKERS: ReadonlySet<string> = new Set([
  // function words — the strongest signal
  "yang", "dengan", "untuk", "pada", "dapat", "tidak", "juga", "akan",
  "atau", "karena", "bila", "bila", "tanpa", "adalah", "sebagai", "dari",
  "dalam", "tersebut", "sehingga", "seperti", "harus", "bisa", "masih",
  "belum", "serta", "agar", "oleh", "kepada", "saat", "ketika", "jika",
  // content words common in finding prose
  "penyerang", "pengguna", "tanpa", "autentikasi", "berisi", "mengizinkan",
  "memungkinkan", "membaca", "mengeksekusi", "menyimpan", "dikirim",
  "dikembalikan", "digunakan", "dilakukan", "menampilkan", "sebaiknya",
  "gunakan", "tambahkan", "hapus", "lindungi", "verifikasi", "wajibkan",
  "jangan", "tersimpan", "tersembunyi", "rentan", "kebocoran", "kerentanan",
  "temuan", "tabel", "kolom", "siapa", "milik", "cukup", "lebih", "hanya",
]);

/** Highest-precision phrases (appear only in Indonesian prose). */
const ID_PHRASES: readonly string[] = [
  "dapat membaca", "dapat diakses", "dapat menyebabkan", "memungkinkan penyerang",
  "tanpa autentikasi", "tanpa otorisasi", "tidak ada otorisasi", "harus dilakukan",
  "sebaiknya gunakan", "dengan mengirim", "berupa daftar", "dari tabel",
  "yang disimpan", "digunakan untuk", "sehingga penyerang", "akan berjalan",
];

export type IdProse = { indonesian: boolean; markers: number; words: number; density: number };

/**
 * Detect Indonesian prose in a finding field. Requires a STRONG signal:
 * ≥3 distinct phrase hits, or ≥5 distinct word markers, or ≥3 markers with
 * density ≥0.12 (markers / prose words) — quoted Indonesian strings inside
 * otherwise-English evidence rarely reach this. Pure. Tested.
 */
export function idProseStrength(text: string): IdProse {
  const t = (text || "").trim();
  if (!t) return { indonesian: false, markers: 0, words: 0, density: 0 };
  const lower = t.toLowerCase();
  let phraseHits = 0;
  for (const p of ID_PHRASES) if (lower.includes(p)) phraseHits++;
  const words = lower.split(/[^a-z_]+/).filter(Boolean);
  const wordsN = Math.max(1, words.length);
  const hit = new Set<string>();
  for (const w of words) if (ID_MARKERS.has(w)) hit.add(w);
  const markers = hit.size;
  const density = markers / wordsN;
  const indonesian =
    phraseHits >= 3 ||
    markers >= 5 ||
    (markers >= 3 && density >= 0.12);
  return { indonesian, markers, words: words.length, density: Math.round(density * 1000) / 1000 };
}

/** Convenience predicate for the finding_add gate. Pure. */
export function indonesianProseField(value: string): boolean {
  return idProseStrength(value).indonesian;
}
