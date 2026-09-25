// turnGate.ts — SATU PEMILIK keputusan "apakah gilitan ini list-ask, test-ask,
// atau sekadar prosa?" untuk SEMUA consumer: userAskedForList (anti verbatim
// hijack) dan endpointTriageNote (anti klaim-pengujian-tanpa-bukti).
//
// Akar bug live 2026-09-25 10:31: kedua consumer punya salinan logika yang
// BERBEDA dari definisi kata-kuncinya sendiri.
//   • `userAskedForList` sudah di-strip URL-nya dan punya carve-out `pentest`
//     → benar (tetap false untuk ask "full pentest … /cek-nik").
//   • `endpointTriageNote` masih mencocokkan EXPLICIT_LIST_RE ke TEKS MENTAH
//     → "cek" di dalam URL `/cek-nik` match \bcek\b (hyphen = word boundary),
//     dan ENDPOINT_TEST_VERBS-nya tidak punya `pentest` → carve-off gagal →
//     guard return "" di baris PALING ATAS → klaim "pengujian menyeluruh sudah
//     selesai" dengan NOL probe lolos tanpa catatan jujur.
// Satu fix di userAskedForList saja tidak cukup karena tidak ada satu owner.
//
// Aturan yang ditegakkan di sini (berlaku untuk semua consumer):
//   1. URL BUKAN prosa — kata di dalam path/host tidak pernah dihitung sebagai
//      intent ("cek" pada /cek-nik bukan "cek" sebagai list-verb).
//   2. Satu daftar test-verb — `pentest`, `uji`, `cek`, `tes`, `scan`, … zijn
//      sinonim; divergence dua regex (ENDPOINT_TEST_VERBS vs inline) = bug laten.
//   3. List-ask eksplisit TIDAK bisa mengalahkan test-ask; sebaliknya juga.
/**
 * Strip absolute URLs so intent matching only ever sees PROSE. A verb-shaped
 * path segment ("/cek-nik") is part of an address, not an instruction.
 * Exported for the display/consolidation helpers that need the same rule.
 */
export function stripUrlsForProse(raw: string): string {
  return String(raw || "").replace(/https?:\/\/\S+/gi, " ").trim();
}

/** "Does this read as asking to enumerate/show things?" (broad, question-ish). */
export const LIST_ASK_RE =
  /\b(apa(?:\s+aja|\s+saja)?|daftar|list|cek|lihat|tampilkan|tunjuk(?:kan)?|show|berapa|gimana|bagaimana|status|reminder|pengingat|tugas|task|todo|catatan|note|jadwal|agenda|calendar|file|upload|dokumen|plan|rencana|automation|otomatis|skill|kemampuan|email|gmail|inbox|berita|news|hotel|film|bioskop|kereta|bus|mood|memory|memori)\b/i;

/** Verba yang/actions — "tampilkan … lalu tambahkan" is a write, not a read. */
export const SET_VERB_RE =
  /\b(tambah|tambahin|bikin|buat|set|pasang|jadwalin|ingetin|ingatkan|inget|ingat|schedule|add|simpan|catat|hapus|batal|cancel|ganti|ubah|move|pindah|matiin|matikan)\b/i;

/** Unambiguous list imperatives only ("apa aja", "daftar", "lihat", …). */
export const EXPLICIT_LIST_RE =
  /\b(apa(?:\s+aja|\s+saja)?|daftar|list|lihat|cek|tampilkan|tunjuk(?:kan)?|show)\b/i;

/**
 * The ONE test-verb vocabulary. Every synonym that means "actually exercise the
 * target" belongs here — a test ask must never be downgraded to a list read.
 * Includes `pentest` (the word the live 10:31 ask used) and `cek`/`tes`/
 * `test` which were present in the older inline copy but missing from
 * ENDPOINT_TEST_VERBS.
 */
export const ENDPOINT_TEST_VERB_RE =
  /\b(rentan|uji|ujilah|tes|test|testing|vulnerable|vuln|scan|scanning|periksa|audit|pentest|hack|hacking|bobol|serang|exploit|exploitasi)\b/i;

/** Path-ish tokens ("/login", "/api/cek-nik", absolute URLs survive upstream). */
export function hasPathToken(text: string): boolean {
  return (text.match(/(?:\/[A-Za-z0-9_.\-~%]+)+/g) || []).some(
    (p) => p.length > 1 && /\/[A-Za-z0-9]/i.test(p)
  );
}

/**
 * The user wants the target EXERCISED (a probe), not merely listed.
 *
 * Path evidence is read from the RAW text (a test target is very often an
 * absolute URL — "uji https://host/api/x" — so stripping first would delete the
 * only path evidence, live 2026-09-25 10:31), while the VERB is matched against
 * URL-stripped prose so a verb-shaped path segment ("/cek-nik") can never fake
 * an instruction in either direction.
 */
export function isEndpointTestAsk(raw: string): boolean {
  if (!hasPathToken(String(raw || ""))) return false;
  return ENDPOINT_TEST_VERB_RE.test(stripUrlsForProse(raw));
}

/**
 * The user genuinely wants a list/status output. Shared shape for both
 * consumers so a fix in one cannot drift from the other.
 *
 * @param opts.askGate when true, an endpoint-test ask returns false FIRST
 *        (a test ask is never a list ask, even if it also says "cek").
 */
export function isListAsk(raw: string, opts: { askGate?: boolean } = {}): boolean {
  const text = stripUrlsForProse(raw);
  if (!text) return false;
  if (opts.askGate && isEndpointTestAsk(raw)) return false;
  if (!LIST_ASK_RE.test(text)) return false;
  if (SET_VERB_RE.test(text) && !EXPLICIT_LIST_RE.test(text)) return false;
  return true;
}
