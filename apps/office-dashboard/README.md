# AI Office Dashboard (Mia / Agnes / Michelle)

Dashboard operasional (mission control) untuk trio Mia. Menampilkan **aktivitas nyata**
(bukan simulasi): ruang kerja 3D, status agent, task board, kalender jadwal, usage dari audit
log, sesi agent, memory per agent, browser file read-only, log real-time, dan kesehatan
semua sumber data.

Backend: **Node.js tanpa dependensi eksternal** (hanya module bawaan).
Frontend: **satu file** `index.html` (HTML + CSS + JS inline, tanpa framework).
Three.js **r128 di-vendor lokal** di `vendor/three.min.js` — tidak ada CDN saat runtime.

## Menjalankan

```bash
node apps/office-dashboard/server.js           # default http://127.0.0.1:3001
PORT=3101 node apps/office-dashboard/server.js # ganti port
```

Server hanya listen di `127.0.0.1` (loopback). Tidak ada `--host` atau bind publik.

## Autentikasi

Dashboard memakai **mekanisme yang sudah ada** di Mia (`apps/web/src/lib/authGuard.ts`):
satu token, dua cara-presentasi — cookie `mia_auth` atau header `Authorization: Bearer <token>`.

Sumber token (berurutan prioritas):

1. env `DASHBOARD_TOKEN`
2. `AUTH_TOKEN` di `apps/web/.env.local` (sama dengan yang dipakai Mia)

Kalau tidak ada token sama sekali, auth **nonaktif** dan dashboard tetap lokal saja.
Token tidak pernah ditampilkan di response, UI, maupun log.

> **Blocker:** `AUTH_TOKEN` belum di-set di `apps/web/.env.local`, jadi auth sedang
> nonaktif. Tunnel publik **TIDAK** boleh diaktifkan sebelum itu diperbaiki —
> dan `watchdog.sh` memang menolak membuka tunnel selama auth nonaktif.

## API

| Method | Path | Auth | Keterangan |
|---|---|---|---|
| GET | `/api/health` | tidak | liveness check (dipakai watchdog) |
| GET | `/api/state` | ya | seluruh data dashboard + `version`, `activity[]`, `sources[]` |
| GET | `/api/usage?period=24h\|7d\|30d` | ya | event/turn/tool-call dari audit log (lihat `definitions`) |
| GET | `/api/memory?agent=mia\|agnes\|michelle` | ya | file persona + memory harian agent, read-only |
| GET | `/api/files?root=web\|dashboard&path=…` | ya | browser file read-only dengan deny-list |
| GET | `/api/bus/stream?since=` | ya | proxy SSE Event Bus Mia |
| POST | `/api/gemini-live/{token,tool,memory,tool-ping}?agent=mia\|agnes\|michelle` | ya | proxy Gemini Live ke Mia; **identitas di-pin server-side** (`x-mia-user` dari tabel agent, `x-mia-agent` dari `?agent=`), browser tidak pernah menentukan user |
| POST | `/api/queue` | ya | `{prompt, agent}` → 201, agent wajib `mia\|agnes\|michelle` |
| POST | `/api/dispatch` | ya | `{paused: true\|false}` → menulis `data/dispatch.json` |

### Live di dalam panel chat

Panel chat punya **tombol mikrofon di sebelah tombol kirim** (kirim = ikon, bukan
teks "Kirim"). Mikrofon membuka sesi Gemini Live untuk agent yang sedang aktif
di panel — satu pemilih, satu percakapan.

- Klien Live (`vendor/live.bundle.js`) adalah hasil build dari `apps/web`
  (`npm run build:dashboard-live`), jadi loop-nya **satu** dengan aplikasi web —
  tidak ada salinan kedua yang bisa melenceng.
- `live.mjs` hanya transport: pedir mikrofon, kirim bearer dashboard, sebut
  agent (`?agent=`). Identitas tidak pernah diklaim di browser.
- Strip live (status + transkrip) terpisah dari riwayat chat dan tersembunyi
  saat idle — tidak ada panel kedua yangclaim "live".
- Batasan API Live (audio harus lewat `realtimeInput`, `responseModalities` di
  dalam `generationConfig`, jeda senyap > `silenceDurationMs`) tetap berlaku.

Semuanya di-validasi: prompt non-kosong & ≤4000 karakter, agent harus dikenal,
`paused` harus boolean, body dibatasi 64 KB, tidak ada shell yang dijalankan dari input HTTP.

## Sumber data (jujur, tanpa angka karangan)

| Field | Sumber nyata |
|---|---|
| `agents[]` | audit log Mia `apps/web/.data/audit/AUDIT-*.log` — status diturunkan dari event terbaru, bukan flag buatan. `basis` di API menampilkan sumber, jendela waktu, dan umur event terakhir. |
| `tasks[]` | `data/tasks.jsonl` (turn nyata dicerminkan dari audit) |
| `queue[]` | `data/queue.jsonl` |
| `dispatch_paused` | `data/dispatch.json` |
| `system`, `vps.disk` | `os.*` + `/bin/df` (argv tetap, tanpa shell) |
| `vps.tunnel` | `PUBLIC_URL.txt` + **HTTP check langsung** dengan timeout 5 s (bukan "proses hidup") |
| `vps.watchdog` | baris terakhir `watchdog-history.jsonl` |
| `schedules` | `OFFICE_SCHEDULE_DIRS` (default `~/workspace/cron.d`) — file `.md` ber-frontmatter |

Nilai yang tidak bisa dibaca dikembalikan sebagai `available:false` + catatan, bukan nol/tebakan.

## Browser file & memory — batas aman

`/api/files` hanya membaca, dan hanya dari dua root yang diizinkan: `apps/web` dan
`apps/office-dashboard`. Guard berlapis:

- path absolut, `..`, dan symlink keluar root ditolak (`realpath` kedua sisi dibandingkan).
- deny-list per segmen path **dan** per entri: `.git`, `node_modules`, `.next`, `dist`,
  `build`, `coverage`, venv/cache, **`graphify-out`**, dan **`.data`** (berisi
  `gmail.json` / `spotify.json` / `http-sessions.json` / `policy.json` yang menyimpan token).
- nama file yang memuat `token|secret|password|passwd|credential|auth` ditolak;
  ekstensi `.env*`, `.pem`, `.key`, `.crt`, `.p12`, `.pfx`, `.db`, `.sqlite*`, `.log` ditolak;
  dotfile ditolak.
- isi file di-`redact()` sebelum dikirim dan dipotong 256 KB.
- `/api/memory` hanya membaca `apps/web/.data/users/<user>/` milik agent yang diminta
  (`persona/*.md`, 14 memory harian terbaru, `corrections.md`, `.self-improving/`), read-only.

### Reminder Mia (store yang sama dengan yang dia pakai di chat)

`/api/state` juga membawa `reminders`, dibaca **langsung** dari
`apps/web/.data/users/<user>/reminders.json` untuk ketiga agent
(`naufalazhar652952`, `.agnes`, `.michelle`) — store yang sama dengan yang
ditulis `remind_me` dari Discord/Telegram/web, plus `reminders-fired.json`
untuk bukti pengiriman terakhir (beserta keterlambatan). Semua teks di-redact.

Bentuknya:

```jsonc
{
  "available": true,          // ada store di disk?
  "stores": [{ "agent": "mia", "name": "Mia", "user": "naufalazhar652952" }],
  "pending": 2,               // reminder belum fired
  "next": { "at_iso": "...", "text": "...", "agent_name": "Mia" },
  "items": [{ "agent", "agent_name", "user", "text", "notes", "at", "at_iso", "in_s", "repeat", "variants" }],
  "fired": [{ "text", "at_iso", "delivered_at", "late_s" }]
}
```

Catatan jujur: reminder yang sudah **fired** dihapus oleh Mia sendiri dari
store (satu-shot) atau dijadwal ulang +24 jam (`daily`), jadi yang tampil di
dashboard hanya yang benar-benar masih terjadwal + 8 pengiriman terakhir.

## Antarmuka (10 view, hash routing)

`office` (3D + HUD Crew) · `agents` · `board` · `calendar` · `usage` ·
`activity` · `logs` · `memory` · `files` · `settings`. URL memakai hash (`#/usage`), tombol
refresh memuat ulang sumber yang sedang aktif, dan tema terang/gelap tersimpan di
`localStorage`. Everything yang tidak terbaca ditampilkan `Not available`.

### Design system

Tema **hangat** (krem + aksen jingga) adalah bawaan; `data-theme="dark"` = varian
malam yang hangat. Token, tipografi, radius, dan aturan komponen ada di
[`DESIGN.md`](DESIGN.md) + [`design-tokens.json`](design-tokens.json); CSS-nya
sendiri ada di `<style>` `index.html` (dan `chat.css` untuk panel chat).
Jingga hanya untuk aksi utama dan state terpilih — tidak untuk dekorasi. Adegan
3D memakai warna naturalnya sendiri; palet aplikasi tidak didorong ke dalam scene.

Layout: header tipis (breadcrumb, dot sinkronisasi, status Event Bus, tema, refresh,
pause dispatch), **rail kiri kolapsibel** (tombol `☰`; state tersimpan, tooltip di
setiap item icon-only), **dock panel kanan** di view Office (ringkasan crew + detail
agent, tombol `Panel`, state tersimpan), dan **panel chat** di kanan (terbuka di
layar lebar, menjadi drawer di bawah 900 px). Strip status di panggung menampilkan
crew/antre/berjalan/gagal dan jadwal berikutnya, semuanya dari `/api/state`.
Konten view non-3D dibatasi lebar 1180 px dan dipusatkan; panggung 3D, dock, dan
chat tetap memenuhi lebar penuh. Membuka/menutup chat **tidak** membuat ulang
renderer Three.js.


## Setiap angka punya satu rumah

Audit 2026-10-14 menghapus salinan yang tumpang tindih: tab HUD `Stats` (load/memori/
disk/RSS) dan tab HUD `Activity` (daftar sesi) adalah salinan dari view `Activity`,
metrik mesin kini hanya di **Pengaturan**, `Activity` hanya berisi sesi audit, dan
kartu Token/Estimasi biaya dihapus karena tidak ada sumber billing yang mengukurnya
(dashboard lebih baik kosong daripada mengarang angka). Kalau menambah metrik baru,
taruh di satu view saja.

## Ledger

`data/tasks.jsonl` — **append-only**, satu event JSON per baris:

```json
{"ts":"2026-10-10T10:46:48.036Z","task_id":"task-q-abc123","agent":"mia","subagent":null,"title":"…","status":"started","detail":"…"}
```

`status` yang dipakai: `started` | `progress` | `done` | `failed`.
`agent` **wajib** salah satu dari `mia` / `agnes` / `michelle`.
Event menggandakan `task_id` yang sama; status terkini = event terakhir per `task_id`.

Cara append event nyata dari luar (mis. dari cron/skill lain):

```bash
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '{"ts":"%s","task_id":"task-x1","agent":"michelle","subagent":null,"title":"Jalankan test","status":"done","detail":"42 test hijau"}\n' "$now" \
  >> apps/office-dashboard/data/tasks.jsonl
```

Baris JSON rusak **tidak** membuat API mati — dihitung di `integrity.*_broken_lines`.

## Dispatch nyata

Item queue yang `queued` diambil `dispatchLoop` (tiap 3 detik, dilewati saat `paused`)
lalu dikirim **sungguhan** ke `POST http://127.0.0.1:3000/api/llm` dengan `user` per-agent
(`naufalazhar652952`, `.agnes`, `.michelle`). Balasan Mia yang asli disimpan sebagai event
`done`. Kalau gagal, event `failed` berisi error aslinya — tidak dikarang jadi sukses.

## Tunnel & watchdog

`watchdog.sh` (opsional, tiap 5 menit lewat cron):

```bash
*/5 * * * * PORT=3101 /path/ke/apps/office-dashboard/watchdog.sh >> /tmp/office-dashboard-watchdog.log 2>&1
```

Urutannya: cek `/api/health` → cek auth → cek `bore` → kalau ada URL, **live-check HTTP 200** →
bila mati, restart tunnel lalu tulis `PUBLIC_URL.txt` yang baru. Setiap run append satu baris
jujur ke `watchdog-history.jsonl`. Tidak ada credential di script maupun history.

**Blocker saat ini:** `bore` tidak terpasang di mesin ini, jadi tidak ada tunnel publik.
`PUBLIC_URL.txt` sengaja dibiarkan kosong — tidak ada URL yang bisa dibagikan.

## Blocker di mesin ini (2026-10-10)

- `~/workspace` tidak ada → jadwal tampil sebagai *Not configured* (parser tetap ada & teruji lewat fixture).
- `bore` tidak terpasang → tunnel tidak aktif.
- `AUTH_TOKEN` belum di-set → auth nonaktif; ini prasyarat sebelum tunnel boleh dibuka.
- Port 3001 dipakai proses project lain (`ruang`) → saat pengujian dipakai `PORT=3101`.