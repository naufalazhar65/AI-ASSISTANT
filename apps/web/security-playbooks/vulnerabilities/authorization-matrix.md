name: authorization-matrix
description: Uji otorisasi menyeluruh antar banyak role sekaligus (bukan hanya A/B) — deteksi akses lintas-role dan anonymous-access secara sistematis.
category: vulnerabilities

# Authorization Matrix Testing (Multi-Role)

IDOR/BOLA klasik diuji dengan 2 akun. Aplikasi nyata punya 4–6 role
(admin, editor, user, guest, api-service, …) dan celah sering muncul PADA
KOMBINASI yang tidak diuji: editor bisa baca resource admin? guest bisa POST?
anonymous bisa akses endpoint "internal"?

## Metode

1. Kumpulkan sesi per role (akun uji, BUKAN user nyata):
   - `http_session action=set name=admin cookie="sid=..."` (dan user, guest, ...)
   - Urutan privilege: simpan dari yang tertinggi ke terendah.
2. Pilih endpoint representatif per objek sensitif:
   - READ objek milik user lain (`/api/orders/9821`)
   - WRITE/cross-tenant (`/api/users/9821/role`)
   - Endpoint administratif (`/api/admin/...`)
3. Jalankan matriks penuh (Mia: `auth_matrix`):
   - sessions=<admin,user,guest> (urutan = privilege menurun)
   - endpoints=<daftar URL/path> — anonymous otomatis ditambahkan.
4. Interpretasi:
   - anonymous ✅ di endpoint ber-role → **anonymous access** (biasanya high).
   - role rendah ✅ + respons SAMA dengan role tinggi → **cross-role access**
     (BOLA horizontal/vertikal; verifikasi body benar-benar berisi data objek,
     bukan pesan error generik ber-status 200).
   - Semua ⛔ kecuali admin → endpoint terlindungi dengan benar (catat aman).
5. Setiap kandidat: `poc_verify` (determinisme + baseline) → `finding_add`
   (OWASP A01 Broken Access Control; CWE-862 missing authorization /
   CWE-639 authorization bypass on user's own object id).

## Jebakan

- Respons 200 berisi halaman login/SPA-shell BUKAN akses — cek body/marker.
- Cache/proxy bisa membalas 200 tanpa otorisasi — ulangi dengan header cache-buster.
- Role bisa punya beberapa sumber identitas (header X-Role vs token claim) —
  uji keduanya, termasuk kombinasi token user + header role admin
  (mass-assignment otorisasi).

## Peta Tool Mia

- `http_session` — simpan sesi per role.
- `auth_matrix` — iterasi semua pasangan + anonymous.
- `bola_diff` — perbandingan dua sesi (kasus sederhana).
- `poc_verify` — bukti deterministik sebelum finding_add.
- `hunt_log` — catat endpoint mana yang sudah dimatrikskan.
