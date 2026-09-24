<!--
Mia original (bukan adaptasi Strix) — lahir dari audit "a fool with a tool is
still a fool" (2026-09-24): mekanisme prover bisa jujur, tapi narasi model di
ATAS output-nya adalah mata rantai terlemah. Playbook ini mengajarkan CARA
MEMBACA hasil tool — kenapa output demikian, apa yang sistem di baliknya
lakukan, dan kapan sebuah klaim layak naik kelas. Knowledge pack only.
-->
# PLAYBOOK: Reading Prover Results (why behind the output)

> Pepatah lapangan: **"A fool with a tool is still a fool."**
> Perintah yang benar pada tool yang benar masih bisa menghasilkan kesimpulan
> yang salah — jika kamu tidak paham KENAPA tool memberi output itu, dan apa
> yang sistem di belakangnya lakukan sebelum angka itu sampai ke matamu.
>
> Aturan Mia: **bukti = audit log + artefak di disk, BUKAN prosa.** Narasi
> (milikmu sendiri maupun model) bukan bukti.

## 0. Peta verdict: 5 kelas, bukan 2

Semua prover Mia (`poc_verify`, `exploit_chain`, `smuggle_probe`, `cache_decep`,
`nosql_hunt`, `bypass403`, `race_attack`, `graphql_hunt`, `dom_xss_prove`,
`xxe_chain`, `blind_ssrf`, ...) menulis dalam SALAH SATU dari lima kelas ini.
Sebelum membaca isi, kenali kelasnya:

| Kelas | Bentuk khas | Arti sistematis | Boleh finding_add? |
|-------|-------------|-----------------|--------------------|
| **LEAD / SINYAL** | "kandidat", "🟡", "indikator" | Perilaku server BERBEDA dari baseline — penyebabnya BELUM dibuktikan rentan | ❌ belum |
| **CONFIRMED/PROVEN** | "✅ PROVEN", replay deterministik | Signature rentan terulang N× deterministik (sha/status/body match) | ✅ |
| **NEGATIF SAH** | "nihil", "tidak ada sinyal" | Kontrol jalan, target benar-benar tidak rentan pada surface itu | — |
| **TAK DIKETAHUI** | "error", "timeout", "skip", "⛔ tidak dijalankan" | Probe TIDAK SAMPAI menjawab pertanyaan — bukan jawaban "tidak" | ❌ |
| **FALSE-POSITIVE TRAP** | 2xx tapi body sama, echo payload, SPA catch-all | Tool SENDIRI menolak sinyalnya karena tahu itu ilusi | ❌ |

**Kesalahan membaca paling umum:** memperlakukan kelas 4 sebagai kelas 3
("tidak ada temuan" ≠ "tidak ada sinyal"; timeout ≠ aman), dan kelas 1 sebagai
kelas 2 ("kandidat" ≠ "terkonfirmasi").

## 1. Kenapa baseline dulu, kenapa verdictmu dihitung TERHADAP baseline

Hampir semua prover Mia menembak baseline dulu (kredensial salah, request
polos, permintaan tanpa payload). Itu bukan pemborosan — verdict-mu selalu
berbentuk **"respons X BERBEDA dari respons baseline"**, jadi kualitas
kesimpulanmu = kualitas baseline-mu:

- `nosql_hunt`: operator `$ne` dianggap auth-bypass HANYA karena baseline
  kredensial salah memberi 401/403. Kalau endpoint itu memang menyapa siapa
  saja (200 polos), `$ne` yang "berhasil" bermakna nol.
- `race_attack`: N request 200 dianggap duplikasi HANYA karena outcome-nya
  campur dan final state membuktikan pembuatan ganda. Semua-200 di server
  statis = catch-all, bukan race.
- `poc_verify`: deterministic verdict dihitung dari **fingerprints N replay**
  (status + digest body). Angka "3/3" berarti "sistem memberi respons yang
  sama 3× saat kondisi yang sama" — inilah yang membedakan bukti dari
  kebetulan jaringan.

**Cara membaca yang benar:** tanyakan selalu — "dibanding apa?" Kalau kamu tak
bisa menjawab pertanyaan itu dari output, kamu belum paham hasilnya.

## 2. Sistem di balik output: apa yang SEBENARNYA terjadi

Tiga contoh di mana output permukaan menipis dan sistem di baliknya tebal:

**(a) OOB callback (xxe_chain / blind_ssrf / oast).** Callback masuk = sebuah
RESOLVER DNS di suatu tempat memproses hostname canary kamu — artinya ada kode
server-side yang me-resolve entity/URL/ host KAMU. Payload tak kunjung masuk
bisa berarti: (1) target tak mem-parse sama sekali, (2) egress DNS diblokir,
(3) fetch gagal SEBELUM DNS ("Failed to parse URL" pada callback scheme-less —
Node menolak URL tanpa scheme sebelum satu query DNS pun keluar). Ketiganya
tampil sama di tool; hanya log server/diagnostic yang membedakan. Callback juga
butuh **poll-cycle interactsh ≈ 5 detik** — "tidak ada interaksi" 2 detik
setelah tembak adalah pengukuran yang belum selesai, bukan jawaban.

**(a) Smuggling (smuggle_probe).** "CONFIRMED" berarti sistem front-end dan
back-end MENGHITUNG BATAS REQUEST BERBEDA (CL vs TE) — request ke-(n+1) kamu
menempel ke request orang lain. Verdict REJECTED (400/501) = parser-nya tegas,
BUNYI keamanan yang baik. Classify-nya count-based dan anchor ke **status-line
pertama** — jangan baca "101" di body `Content-Length: 101` sebagai switch
protokol.

**(c) Cache deception (cache_decep) vs cache poisoning.** Deception = halaman
TERPROTEKSI tersimpan di URL PUBLIK yang cacheable (kamu curi konten korban
via re-fetch anonim); poisoning = KONTEN DITANAM di cache untuk korban lain.
Re-fetch anonim yang mengembalikan body SAMA dengan authed + `x-cache: HIT` =
lead. Body SPA catch-all yang sama untuk semua URL = tool MENOLAK lead-nya —
itu kelas 5, baca sebagai negatif, bukan "gagal scan".

## 3. Hukum naik-kelas: klaim hanya mengikuti bukti terberat di turn ini

- Sinyal → kandidat → temuan: naik kelas WAJIB lewat **`poc_verify`** (replay
  deterministik) atau **`retest_run`** (signature rentan masih cocok).
  `finding_add` tanpa keduanya diberi ⚠️ warning, bukan ditolak — warning itu
  TAGIHAN yang harus kamu bayar sebelum report.
- **Verdict inflation = kebohongan tersendiri.** Menarasikan "terkonfirmasi"
  di atas output "kandidat" bukanlah kegugupan — guard `verdictInflationSuffix`
  di agent.ts menyalak untuk ini. Kalau narasimu butuh kata
  "terkonfirmasi/terbukti/Proven" dan turn ini TIDAK menjalankan poc_verify/
  retest_run, tulis ulang narasimu, bukan verdictnya.
- **Negasi terbalik:** "SINYAL nihil ≠ aman" (blind_ssrf) dan "2xx + body sama
  = SPA catch-all, BUKAN bypass" (bypass403). Kelas negatif yang jujur tetap
  negatif; jangan mengubahnya jadi reassurance.
- **Sesi/otorisasi gagal bukan temuan.** IDOR tanpa kontrol anon, auth-bypass
  tanpa kontrol no-token — Mia menurunkannya ke INFO secara otomatis. Kamu
  harus bisa menyebut kontrolnya; kalau tidak, naikkan dulu kontrolnya, bukan
  temuannya.

## 4. Prosedur membaca satu output prover (urut, jangan lompat)

1. **Kelas dulu, isi kemudian.** Temukan baris verdict terkuat, petakan ke
   tabel §0. Baris itu yang menentukan apa yang BOLEH kamu katakan.
2. **Tanya "dibanding apa?"** Cari baseline/kontrol di output. Tidak ada
   baseline = sinyal tak bisa dinilai; jalankan ulang atau pindah.
3. **Pisahkan pengukuran dari jawaban.** Timeout, poll-cycle, rate-limit 429,
   jaringan 000 — semua itu pengukuran yang gagal (kelas 4), bukan target yang
   aman (kelas 3).
4. **Cek trap kelas 5.** Body sama, echo payload, redirect eksternal, status di
   body — tool sudah menolaknya; jangan angkat kembali dari sampah.
5. **Naik kelas dengan mekanisme, bukan keyakinan.** poc_verify → (opsional)
   oast/bola_diff sebagai korelasi → baru finding_add dengan retest case.
6. **Tulis narasi pada kelas yang sama dengan bukti.** Kalau bukti = sinyal,
   narasimu = sinyal. Kalau buktimu = audit log kosong, jangan ada kata
   "sudah aku jalankan".

## 5. Tool Mia ↔ kelas verdict (ringkas)

| Tool | Kelas positifnya | Kelas negatifnya | Naik kelas lewat |
|------|------------------|------------------|------------------|
| poc_verify | STABIL 3/3 | assertion belum/TIDAK-stabil | (sudah puncak) |
| exploit_chain | per-chain "N langkah dijalankan" | ⛔ TIDAK DIJALANKAN / skip jujur | poc_verify |
| cache_decep | LEAD decoy HIT | SPA catch-all ditolak | poc_verify + re-fetch |
| nosql_hunt | LEAD auth-bypass | error fingerprint = info | poc_verify |
| race_attack | duplicate-creation sinyal | catch-all = false positive | poc_verify |
| smuggle_probe | CONFIRMED desync | REJECTED = parser tegas | (sudah puncak) |
| dom_xss_prove | PROVEN handler jalan | INJECTED_ONLY → JANGAN add | (sudah puncak) |
| blind_ssrf / xxe_chain | OOB callback ter-atribusi | nihil ≠ aman (egress/poll) | poc_verify |
| graphql_hunt | kandidat (batching/depth) | rejected/limit | uji dampak manual |
| bypass403 | LEAD body beda | same-body catch-all | poc_verify |

## 6. Anti-pattern ringkas

- ❌ Menghafal perintah, lalu menempelkan output utuh sebagai kesimpulan.
- ❌ "Tidak ada output" dilaporkan "target aman".
- ❌ Naik-verdict di kalimat terakhir report tanpa poc/retest.
- ❌ Membaca angka di body (Content-Length: 101) sebagai status protokol.
- ❌ Callback scheme-less dianggap "DNS bermasalah" padahal fetch menolak URL
  sebelum DNS.
- ❌ Klaim eksekusi tanpa audit log — kalau narasi dan audit bertentangan,
  audit yang menang.
