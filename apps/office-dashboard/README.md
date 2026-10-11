# AI Office Dashboard (Mia / Agnes / Michelle)

Dashboard operasional untuk trio Mia. Menampilkan **aktivitas nyata** (bukan simulasi),
ruang kerja 3D, antrean task, metrik sistem, status VPS, jadwal, token, dan log real-time.

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
| GET | `/api/state` | ya | seluruh data dashboard |
| POST | `/api/queue` | ya | `{prompt, agent}` → 201, agent wajib `mia|agnes|michelle` |
| POST | `/api/dispatch` | ya | `{paused: true|false}` → menulis `data/dispatch.json` |

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
| `tokens` | hanya jika `OFFICE_TOKEN_STATUS_URL` diset, selain itu `Not configured` |

Nilai yang tidak bisa dibaca dikembalikan sebagai `available:false` + catatan, bukan nol/tebakan.

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