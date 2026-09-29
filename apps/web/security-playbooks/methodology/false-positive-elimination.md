# False-Positive Elimination — cara prover membedakan sinyal dari noise

> Tujuan: sebuah "lead" dari tool ini HARUS bernilai waktumu untuk di-poc_verify.
> Semua di sini adalah pola yang sudah hidup di kode Mia — playbook ini menjelaskan
> KENAPA pola itu ada, supaya kamu membaca hasil prover dengan model mental yang
> benar (bukan menghafal output).

## 1. Hukum dasar: selalu ada yang dibandingkan

Tidak ada respons yang "aneh" tanpa pembanding. Setiap prover yang benar membangun
**baseline sebelum request pertama**, dan sinyal didefinisikan RELATIF terhadapnya:

| Pola | Contoh tool | Yang dibandingkan |
|---|---|---|
| Baseline tunggal | nosql_hunt, param_fuzz | body invalid-credential vs body operator |
| Baseline PAIR | param_miner, blind_cmdi | dua baseline → jitter pasangan jadi ambang |
| Kontrol payload-identik | poc_verify | payload tanpa byte berbahaya (id=1;-- - vs id=1) |
| Kontrol anon | idor_enum, cache_decep | respons auth'd vs anon |
| Kontrol status-line | smuggle_probe | statusline PERTAMA (bukan angka di body) |

**Kesalahan klasik:** membandingkan dengan respons "harusnya seperti ini" dari
kepala — bukan dengan respons yang benar-benar dikembalikan server.

## 2. Sinyal didefinisikan sebagai DIFFERENTIAL, bukan kehadiran

- `admin:x` di respons = apa? Tanpa baseline salah-credential, itu tidak menunjuk
  apa pun (error, page, atau echo semuanya menampilkannya).
- Oracle OTP: yang dicari bukan "200" (halaman mana yang tidak 200?) melainkan
  **respons yang BERBEDA dari baseline dalam arah yang baseline tak pernah ambil**.
- BOLA: 200-vs-200 bukan berarti aman — yang menentukan isi/digest, bukan status.
  (poc_verify punya arm khusus untuk same-status BOLA.)

## 3. Normalisasi sebelum diff — apa yang TIDAK boleh dihitung beda

Nilai volatil membuat dua respons identik terlihat berbeda (dan sebaliknya
menyamarkan yang benar-benar beda). Yang dinormalisasi sebelum dibandingkan:
UUID, timestamp 10–13 digit, whitespace (baseline.ts `normalizeBody`); angka → N
untuk oracle OTP (`oracleDigest`); jarak pasangan baseline jadi ambang jitter
(`bodiesDiffer`).

**Baca bedanya, bukan cuma statusnya:** param_miner menolak kandidat yang hanya
mengubah halaman sebesar jitter pasangan; digests dihitung SETELAH normalisasi.

## 4. Pantulan ≠ injeksi: posisi menentukan kelas

Pantulan payload hanyalah pantulan. Yang menaikkan kelasnya:
- Posisi eksekusi (param_fuzz `classifyReflectionContext`): breakout `"><img…`
  yang kembali sebagai markup hidup = exec-context; teks halaman / bentuk
  ter-encode (`javascript%3A`) = info.
- Key context (otp_hunt `findOtpLeak`): kode di bawah key yang user isi =
  explained, bukan leak; leak = key tak terduga / header / bare body.
- Aturan umum XSS: bukti = EKSEKUSI di browser (dom_xss_prove), bukan payload
  yang tersimpan — advisory xssProofAdvisory menegaskan ini di finding_add.

## 5. Perangkap katalog (yang sudah dipagari kode)

| Perangkap | Pagar | Tool |
|---|---|---|
| SPA catch-all | body sama dengan shell / echo decoy / "not found" | bypass403, cache_decep (`isSpaCatchAll`) |
| Echo WAF | respons memantulkan path trik, size ≈ deny | bypass403 (`classifyBypass` arm echo) |
| h2c palsu | angka 101 di BODY vs statusline 101 | smuggle_probe (anchor statusline pertama) |
| Halaman kebetulan "49"/"passwd" | marker WAJIB absen di baseline | ssti_enum, path_traversal |
| SPA-catch-all redirect | redirect internal dihitung unknown, bukan lead | bypass403 |
| Kode OTP di input-echo | key context decides | otp_hunt (`findOtpLeak`) |
| "Tidak ada X" generik | HANYA verdict eksplisit prover yang boleh menulis dead | dedup gate (`recordChainOutcome`) |

## 6. Asimetri kelas: false-negative murah, false-positive mahal

- False lead → satu poc_verify terbuang. Murah.
- False dead / false "aman" → target ditinggalkan, bug terlewat. MAHAL.
Karena itu: dead hanya ditulis dari verdict eksplisit ("TIDAK ADA SINYAL",
NO-DESYNC, no auth-bypass lead); "tidak ada indikasi" generik = tidak dinilai.
Kalau narasi perlu menghitung kelas verdict, pakai tabel kanonik
(`verdictTaxonomy.ts`, 5 kelas) — naik-kelas hanya lewat poc_verify/retest_run.

## 7. Prosedur membaca satu hasil prover

1. Baseline-nya sehat? (bukan network error, bukan status 0)
2. Sinyalnya differential terhadap baseline, atau cuma kehadiran?
3. Apa yang dinormalisasi, dan apa yang tidak?
4. Pantulan ada di posisi eksekusi?
5. Perangkap katalog §5 — mana yang relevan untuk tool ini?
6. Kelas verdict (verdictTaxonomy) → tindakan: lead→poc_verify,
   confirmed→lapor, negative→lanjut, unknown→jangan dibaca aman.

## Anti-pattern

- ❌ "Respons 200, berarti lolos" — 200 pada endpoint deny = SPA catch-all
  sampai dibuktikan body beda.
- ❌ Membandingkan dua respons tanpa normalisasi (UUID/timestamp = noise).
- ❌ Menulis status `dead` dari output generik "tidak ada".
- ❌ Menghapus baseline supaya payload "menang" (gerbang poc_verify menolak
  laporan tanpa kontrol yang sehat — itu gerbang, bukan error).
