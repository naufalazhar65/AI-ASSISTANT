name: idor-triage
description: Triage IDOR/BOLA efisien di app ber-autentikasi — temukan endpoint ber-ID, uji 2 akun, pisahkan kontrol nyata dari false positive sebelum finding_add.

# IDOR triage (praktis)

Tujuan: memisahkan **IDOR nyata** dari *hardening* dan false positive, cepat, dengan risiko minimal. Lakukan hanya pada akun sendiri / target berizin (scope + RoE).

## 0. Siapkan dua identitas
Dua akun milikmu (A dan B) di app yang sama. Untuk API, catat cara auth (cookie vs Bearer) dan header khusus (`client_id`, `enc_data`, `timestamp`).

## 1. Cari endpoint ber-ID
Di DevTools → Network (Fetch/XHR), setelah menjalankan fitur ber-data (profil, saved items, health profile, pesan):
- Prioritaskan **GET** dengan ID di **URL** (`/api/x/123`, `?id=`, GUID) → bisa diuji lewat **address bar**, tanpa alat.
- POST/PUT dengan ID/userId di **body** → butuh `tamper_script` (atau proxy).

## 2. Uji (B mengakses objek A)
- GET ber-ID: login B → tempel URL ber-ID milik A di address bar.
- Body ber-userId: `tamper_script url_contains=<endpoint> set={"UserId":"<id-A>"}` → aksi dari UI.

## 3. Interpretasi (jangan inflate)
| Hasil | Kesimpulan |
|---|---|
| B dapat **200 + data A** | **IDOR/BOLA** → lanjutkan ke finding |
| B **401/403** | otorisasi ditegakkan → **terkontrol**, tutup |
| B 404 (A 200) | objek mungkin disembunyikan; **verifikasi manual** (bisa jadi bukan bug) |
| A & B **200 identik** | sinyal kuat BOLA → pastikan objek memang milik A |
| error integrity (`enc_data`/signature) | body terikat → tak bisa ditamper, tutup |

### userId-in-body vs token binding
Kalau mengubah `userId` di body → **401**, cek kontrol: ubah field **bukan-identitas** (mis. `FirstName`) dengan userId tetap.
- Field lain **200** → server spesifik memvalidasi `userId` == token → **terkontrol** (bukan IDOR).
- Field lain ikut **401** → body di-MAC (`enc_data`) → **tak bisa ditamper** (bukan IDOR).
Keduanya **bukan temuan**.

## 4. Mass assignment
- Ambil **nama field asli** dari respons **GET** (mis. `accountTypeField`, `userTypeField`, `emailVerifiedField`, `accountStatusField`) — DTO update sering beda penamaan.
- Kirim ulang dengan field privilege (`tamper_script ... add={...}`), lalu **GET ulang**.
- Field muncul dengan nilai yang kita kirim → **mass assignment** (temuan). Tidak muncul → diabaikan.

## 5. Sebelum finding_add (wajib)
- Pass **counterevidence**: kontrol apa yang bisa mencegah? (binding token, MAC body, scope check, RLS)
- **Severity-calibration**: IDOR baca data sendiri-lain = Medium/High tergantung sensitivitas; jangan naikkan tanpa bukti dampak (data apa bocor/berubah).
- **Bukti**: raw request/response akun A & B (`evidence_capture`), langkah repro deterministik ≥2×.
- Kategori OWASP 2025: **A01 Broken Access Control**; CWE-639 (IDOR) / CWE-566.

## Anti-pola (jangan dilaporkan)
- Cookie tracking tanpa `HttpOnly` (hanya cookie **sesi** yang relevan).
- CORS `*` tanpa `Access-Control-Allow-Credentials`.
- Reflection di `__NEXT_DATA__`/JSON (bukan XSS) dan catch-all rewrite.
- `500` tanpa stack trace/dampak.
