name: browser-transport-tampering
description: Uji IDOR/mass-assignment/parameter saat WAF (Cloudflare) memblokir replay programatik — tamper lewat transport app sendiri (patch fetch/XHR), bukan bypass.

# Browser transport tampering (WAF-aware)

## Kapan dipakai
Target ter-hardening (Cloudflare/WAF) menolak request programatik:
- `curl` → balas halaman `Attention Required! | Cloudflare`
- `fetch()` manual dari Console → `blocked by CORS` atau halaman blocked

Ini **bukan bug** dan **bukan alasan menyerah**. Ini juga **bukan** alasan mencoba bypass (Rotasi IP/TLS fingerprint spoofing, solver challenge) — itu di luar RoE dan bikin laporan dibuang. Solusinya: biarkan **app sendiri** mengirim request-nya (lolos CF), lalu ubah body **in-flight**.

## Prosedur
1. Temukan request target di DevTools → Network (method, URL, body).
2. Buat skrip tamper:
   ```
   tamper_script url_contains=UpdateUserProfile set={"UserId":"999999"}
   tamper_script url_contains=/api/profile add={"IsPremium":true,"accountTypeField":9}
   ```
3. Kirim skrip ke user untuk ditempel di **Console halaman app yang sudah login** → ENTER.
   - **Jangan reload** setelah menempel (patch hilang).
   - Untuk request baru: reload dulu, lalu tempel ulang (cegah patch lama menumpuk — bug nyata 2 patch menimpa satu sama lain).
4. User **menjalankan aksi dari UI** (klik Save) — request dikirim app (lolos CF), body sudah diubah. Console mencetak `PATCHED xhr:` / `PATCHED fetch:`.
5. Baca **Network → request target → Response**. Ambil status + body.

## Membaca hasil
| Observasi | Arti |
|---|---|
| `200` + data/efek milik identitas lain | **IDOR / mass assignment** (temuan) |
| `401/403` saat field identitas diubah | server mengikat identitas ke token → **terkontrol** (tutup lead) |
| error `enc_data`/signature/`*Field` mismatch | body dilindungi MAC/integrity → tak bisa ditamper (tutup lead) |
| `404` untuk id lain | objek disembunyikan / tak ada → verifikasi manual |
| `200` tapi field tambahan tak muncul saat GET ulang | server mengabaikan field tak dikenal → bukan temuan |

## Jebakan
- **Patch menumpuk**: dua skrip patch di Console saling menimpa → hasil menyesatkan. Reload tiap percobaan.
- **Method XHR vs fetch**: app Vue/axios sering pakai XHR; skrip `tamper_script` menangani keduanya.
- **Body ber-`enc_data`**: bila mengubah satu field pun kena 401 tetapi field lain 200, berarti `userId` spesifik divalidasi terhadap token (bukan MAC body) — tetap terkontrol.
- **Bukti**: simpan raw request/response via `evidence_capture` sebelum menyimpulkan.

## Prinsip
Test ini **hanya** untuk akun sendiri / engagement berizin. Jangan mengubah data akun orang lain; kalau IDOR terbukti, gunakan objek milik akun kedua sendiri (A/B) sebagai bukti, bukan data pihak ketiga.
