# PRD — Pixel Office Trio (Mia / Agnes / Michelle)

**Status:** Draft v0.2 — Architecture Locked, Implementation Ready  
**Repo:** `ai-assistant` (backend + bot), engine minimal milik sendiri

---

## 1. Tujuan

Membangun **Pixel Office 2D** yang dapat dijelajahi, terdiri dari:

- 1 ruangan utama
- 3 avatar AI: **Mia, Agnes, Michelle**
- 3 PC / workstation
- Setiap avatar dapat berjalan ke workstation
- Avatar merepresentasikan pekerjaan yang benar-benar dijalankan oleh backend
- Tool backend asli digunakan untuk eksekusi task
- Hasil task kembali ke chat / voice
- Trio yang sama hadir sebagai 3 bot dalam 1 Discord server baru

### Prinsip utama

Pixel Office adalah **visualisasi dari aktivitas agent yang nyata**, bukan animasi pura-pura.

Contoh:

```text
User
  ↓
Mia
  ↓
Michelle
  ↓
Tool backend
  ↓
Event Bus
  ↓
Pixel Office
```

Jika Michelle terlihat `typing`, harus ada task/tool nyata yang sedang berjalan.

---

## 2. Non-tu­juan (MVP)

MVP **bukan**:

- Tiruan Gather / WorkAdventure penuh
- Banyak ruangan
- Video call
- Voice-call spasial
- Sistem sosial multiplayer penuh
- Autonomous agent tanpa batas
- Agnes + Michelle masuk ke Telegram / Discord lama

Voice tetap melalui **Mia Live** yang sudah ada.

Agnes dan Michelle hanya masuk ke:

- Pixel Office
- Discord server baru

untuk menghindari konflik peran dengan Mia yang sudah berjalan.

---

## 3. Arsitektur

```text
                         USER
                           │
                    VOICE / CHAT / UI
                           │
                           ▼
                          MIA
                   Main Orchestrator
                           │
                    agent_delegated
                      /           \
                     ▼             ▼
                  AGNES         MICHELLE
                Researcher       Coder
                     │             │
                     └──────┬──────┘
                            ▼
                       TOOL LAYER
                            │
                            ▼
                        EVENT BUS
                       /          \
                      ▼            ▼
                PIXEL OFFICE    AUDIT LOG
```

### Konsep agent

| Agen | Peran | Fungsi utama |
|---|---|---|
| Mia | Owner / orchestrator | Memory, routing, conversation, delegation, semua channel lama |
| Agnes | Researcher | Search, research, rangkum, verifikasi |
| Michelle | Coder | File, code, test, debugging |

---

## 4. Pemetaan ke Kode yang Ada

| Lapisan | Status | Implementasi saat ini |
|---|---|---|
| Orchestrator | ADA | `runAssistantTurn` + tool layer di `apps/web/src/lib/agent.ts` |
| Tool declarations | ADA | Live tool declarations sudah dikirim ke setup Gemini Live |
| Event Bus | BELUM FORMAL | Audit log + SSE `mia-state` masih informal |
| Avatar Mia | SEBAGIAN | Chat / voice melalui pipeline Mia |
| Avatar Agnes | BELUM ADA | Akan dibuat |
| Avatar Michelle | BELUM ADA | Akan dibuat |
| Engine / ruangan | BELUM ADA | Engine minimal milik sendiri |
| Workstation / PC | BELUM ADA | 3 station |
| Agent-to-Agent messaging | BELUM ADA | Akan dibuat |
| Task lifecycle | SEBAGIAN | Perlu diformalisasi melalui Event Bus |

Persona Mia saat ini juga sudah memiliki aturan voice seperti backchannel, emotional mirroring, laughter, hold-line untuk tool lambat, dan gaya bahasa santai / Jaksel.

---

## 5. Identitas Agent dan Persona

Semua agent tetap berada di bawah owner yang sama.

```text
OWNER_KEY
   │
   ├── mia
   ├── agnes
   └── michelle
```

Persona dipisahkan:

```text
persona/
└── agents/
    ├── mia.md
    ├── agnes.md
    └── michelle.md
```

### Aturan

- `persona_set` hanya milik Mia.
- Agent tidak boleh mencampur persona / memory agent lain.
- Context dari agent lain hanya diberikan jika memang bagian dari task.
- Semua agent tetap mengetahui siapa owner-nya.

---

## 6. Karakter Trio

### Mia

**Role:** Main assistant / coordinator

Karakter:

- Friendly
- Natural
- Casual
- Conversational
- Sedikit Jaksel
- Voice-first
- Paling dekat dengan owner
- Bertugas melakukan routing dan delegation

Mia menjadi wajah utama sistem.

---

### Agnes

**Role:** Research agent

Karakter:

- Calm
- Analytical
- Detail-oriented
- Suka research
- Fokus pada fakta dan sumber
- Lebih tenang daripada Mia

Tugas utama:

```text
search
research
compare
summarize
verify
```

---

### Michelle

**Role:** Coding agent

Karakter:

- Technical
- Direct
- Energetic
- Problem solver
- Fokus pada implementasi dan debugging

Tugas utama:

```text
read files
edit files
run tests
debug
inspect logs
```

Karakter tidak boleh menjadi sekadar copy-paste Mia dengan nama berbeda.

---

## 7. Engine Pixel Office

Lokasi + stack: `apps/pixel-office/` — aplikasi web ringan mandiri (TypeScript + Canvas, tanpa framework), terpisah dari `apps/web`, berkomunikasi dengan backend hanya via SSE/REST.

MVP:

- 1 ruangan
- Tile-based map
- JSON map format milik sendiri
- Floor layer
- Wall / collision layer
- 3 workstation:
  - `pc-1`
  - `pc-2`
  - `pc-3`

### Avatar state machine

Gunakan state berikut:

```text
idle
thinking
walking
working
reading
typing
waiting
success
error
```

Contoh visual:

```text
Mia       → 💬 talking
Agnes     → 📖 reading
Michelle  → 💻 typing
```

Animasi harus mencerminkan state nyata.

---

## 8. Pathfinding

Gunakan:

**A\* pathfinding pada grid tile**

Karena ruang MVP kecil:

- Tidak membutuhkan optimasi berat
- Fokus pada deterministik
- Collision harus konsisten
- Target workstation harus memiliki titik berhenti yang jelas

Contoh:

```text
Spawn
  ↓
A* path
  ↓
Workstation
  ↓
Facing direction
  ↓
Work state
```

---

## 9. Task Lifecycle

Semua pekerjaan agent menggunakan `task_id` sebagai identitas utama.

Format `task_id`: `task_` + 4 digit zero-padded yang naik berurutan per owner (contoh: `task_0091`). ID dibuat server-side saat `task_created`, unik per owner; `parent_task_id` merujuk `task_id` induk, atau `null` bila tidak ada.

Lifecycle dasar:

```text
task_created
    ↓
agent_delegated
    ↓
task_assigned
    ↓
task_started
    ↓
tool_called
    ↓
[file_read / file_written]
    ↓
waiting_input (opsional)
    ↓
task_done
```

Kondisi error:

```text
task_started
    ↓
tool_called
    ↓
task_failed
```

Task juga dapat dibatalkan:

```text
task_started
    ↓
task_cancelled
```

---

## 10. Event Bus

Event Bus adalah **sumber event realtime**.

Audit log adalah **storage / history**, bukan Event Bus itu sendiri.

Arsitektur:

```text
                  Agent / Tool
                       │
                       ▼
                   EVENT BUS
                  /         \
                 ▼           ▼
             SSE Stream   Audit Log
                 │
                 ▼
            Pixel Office
```

Dengan pemisahan ini, event visual dapat berkembang tanpa memaksa seluruh event menjadi audit record.

---

## 11. Event Envelope

Gunakan envelope tunggal.

Tool arguments harus di-redact.

```json
{
  "id": "evt_0182",
  "ts": "2026-10-04T01:00:00.000Z",
  "user": "owner",
  "turn": "turn_44",
  "task_id": "task_0091",
  "parent_task_id": null,
  "type": "tool_called",
  "actor": "michelle",
  "agent": "michelle",
  "station": "pc-2",
  "summary": "Menjalankan test login",
  "data": {}
}
```

### Field utama

| Field | Fungsi |
|---|---|
| `id` | ID event unik |
| `ts` | Timestamp |
| `user` | Owner / tenant |
| `turn` | Percakapan yang menghasilkan event |
| `task_id` | Identitas task |
| `parent_task_id` | Hubungan dengan task induk |
| `type` | Jenis event |
| `actor` | Agent pelaksana aksi, yaitu sumber event (wajib diisi) |
| `agent` | Agent target event; sama dengan `actor` untuk aksi sendiri, berbeda untuk delegasi/assignment (contoh: `actor: mia`, `agent: michelle` saat Mia mendelegasikan) |
| `station` | PC / workstation |
| `summary` | Ringkasan aman untuk UI |
| `data` | Data tambahan yang sudah disanitasi |

---

## 12. Jenis Event

Event MVP minimum:

```text
task_created
agent_delegated
task_assigned
task_started
tool_called
file_read
file_written
waiting_input
task_done
task_failed
task_cancelled
```

### Arti singkat

`task_created`  
Task baru dibuat.

`agent_delegated`  
Mia mendelegasikan task kepada agent lain.

`task_assigned`  
Task diarahkan ke agent dan workstation.

`task_started`  
Agent mulai mengerjakan task.

`tool_called`  
Tool dieksekusi.

`file_read`  
Agent membaca file.

`file_written`  
Agent membuat / mengubah file.

`waiting_input`  
Agent membutuhkan confirmation / input owner.

`task_done`  
Task berhasil selesai.

`task_failed`  
Tool / task gagal.

`task_cancelled`  
Task dibatalkan.

---

## 13. Agent-to-Agent Communication

Mia dapat mendelegasikan task ke Agnes atau Michelle.

Contoh:

```json
{
  "from": "mia",
  "to": "michelle",
  "type": "task",
  "task_id": "task_123",
  "message": "Cek failing test authentication."
}
```

Flow:

```text
Owner
  ↓
Mia
  ↓
agent_delegated
  ↓
Michelle
  ↓
Tool Layer
  ↓
task_done
  ↓
Michelle → Mia
  ↓
Mia → Owner
```

Untuk MVP, komunikasi agent-to-agent berupa **structured task message**, bukan percakapan bebas tanpa batas.

---

## 14. Alur Avatar → PC

Contoh task:

> "Buatkan test untuk login."

Flow:

```text
1. User mengirim perintah
2. Mia memproses task
3. Mia memilih Michelle
4. agent_delegated
5. task_assigned{actor:"michelle", station:"pc-2"}
6. Michelle berjalan menuju pc-2
7. Avatar berubah menjadi working / typing
8. Tool backend asli dieksekusi
9. Event tool_called / file_read / file_written dipancarkan
10. Jika perlu confirmation → waiting_input
11. Task selesai → task_done
12. Michelle kembali idle / success
13. Hasil nyata kembali ke Mia
14. Mia menyampaikan hasil ke owner
```

---

## 15. Aturan "No Fake Work"

Pixel Office tidak boleh memalsukan pekerjaan.

Tidak boleh:

```text
Avatar typing selama 5 detik
        ↓
Tidak ada tool nyata
```

Yang benar:

```text
Tool mulai
   ↓
working / typing
   ↓
Tool selesai
   ↓
success / idle
```

Durasi visual mengikuti aktivitas aktual sebisa mungkin.

Jika task memakan waktu lama, avatar tetap berada pada state yang relevan.

---

## 16. Waiting / Confirmation

Jika agent membutuhkan approval:

```text
working
  ↓
waiting
  ↓
waiting_input event
```

UI dapat menampilkan:

```text
Michelle is waiting for your confirmation.
```

Setelah owner menyetujui:

```text
waiting
  ↓
working
  ↓
task_done
```

Konfirmasi tetap terisolasi per agent.

---

## 17. Discord Trio

Gunakan **1 guild / server baru** dengan 3 bot:

```text
Mia
Agnes
Michelle
```

Satu proses Next dapat menggunakan factory:

```text
createDiscordBot(agentConfig)
```

Setiap agent mempunyai:

- token sendiri
- allow-list sendiri
- provider / model config
- session state sendiri
- pending confirmation sendiri
- label push sendiri

Label push:

```text
discord-mia
discord-agnes
discord-michelle
```

---

## 18. Discord Routing

MVP mendukung salah satu atau kombinasi:

### Mention-based

```text
@Mia ...
@Agnes ...
@Michelle ...
```

### Channel-based

```text
#mia
#agnes
#michelle
```

Dedupe harus menggunakan kombinasi:

```text
agent + message_id
```

Tujuannya mencegah satu pesan menghasilkan triple-reply.

---

## 19. Discord Confirmation

Confirmation harus per-agent.

```text
Mia pending ≠ Agnes pending ≠ Michelle pending
```

Jangan mencampur state confirmation antar bot.

Rollout:

```text
Mia
  ↓
Agnes
  ↓
Michelle
```

Setiap agent memiliki gate sebelum diaktifkan.

---

## 20. Memory

Setiap agent memiliki namespace memory sendiri:

```text
memory/
├── mia/
├── agnes/
└── michelle/
```

Context dapat diberikan lintas-agent jika memang diperlukan oleh task.

Contoh:

```text
Mia Memory
    ↓
Task Context
    ↓
Michelle
```

Bukan:

```text
Semua agent
    ↓
Satu memory global tanpa namespace
```

Tujuannya mencegah context / personality leakage.

---

## 21. Transport

MVP menggunakan:

```text
GET /api/bus/stream
```

atau reuse endpoint existing bila memang sesuai.

Untuk resync:

```text
GET /api/bus/since
```

### Requirements

- SSE realtime
- buffer terbatas
- drop-oldest
- resync support
- auth mengikuti `authGuard`
- event ordering berdasarkan `id` / sequence

Pixel Office harus dapat melakukan reconnect tanpa kehilangan state permanen.

---

## 22. Security

### Server-side secrets

API key / bot token tetap server-side.

Browser tidak boleh menerima long-lived provider secret.

Gemini Live pada implementasi saat ini menggunakan ephemeral token untuk browser; `GEMINI_API_KEY` tetap berada di server.

### Event sanitization

Jangan memasukkan ke Event Bus:

- API key
- token
- password
- credential
- raw secret
- tool arguments sensitif
- data pribadi yang tidak diperlukan

Tool arguments harus di-redact sebelum dipancarkan ke UI / audit layer.

---

## 23. MVP Phases + Gates

### Fase 1 — Formal Event Bus

Implementasi:

- Event envelope
- `task_created`
- `agent_delegated`
- `task_assigned`
- `task_started`
- `tool_called`
- `task_done`
- SSE stream

### Gate

Satu turn nyata menghasilkan event yang dapat dilihat melalui:

```bash
curl /api/bus/stream
```

Target minimal:

```text
task_started
tool_called
task_done
```

---

### Fase 2 — File + Confirmation

Tambahkan:

```text
file_read
file_written
waiting_input
task_failed
task_cancelled
```

### Gate

- File nyata menghasilkan event file
- Confirmation nyata muncul sebagai `waiting_input`
- Tool failure menghasilkan `task_failed`

---

### Fase 3 — Pixel Office MVP

Implementasi:

- 1 ruangan
- 3 avatar
- 3 PC
- collision
- A* pathfinding
- avatar state machine
- event-driven animation

### Gate

```text
Chat command
   ↓
agent selection
   ↓
avatar berjalan
   ↓
avatar bekerja
   ↓
tool asli berjalan
   ↓
event realtime
   ↓
task selesai
   ↓
hasil kembali ke chat
```

---

### Fase 4 — Discord Trio

Rollout bertahap:

```text
Mia
 ↓
Agnes
 ↓
Michelle
```

### Gate

- 3 bot dapat reply sesuai identitas
- Tidak ada cross-talk
- Confirmation tidak tercampur
- Dedupe bekerja

---

## 24. Definition of Done — MVP

MVP dianggap selesai ketika seluruh kondisi berikut terpenuhi:

### Architecture

- Event Bus formal aktif
- Audit Log terpisah secara konsep dari Event Bus
- Task memiliki `task_id`
- Delegation memiliki `parent_task_id` bila relevan

### Agents

- Mia aktif sebagai coordinator
- Agnes aktif sebagai research agent
- Michelle aktif sebagai coding agent
- Persona masing-masing terisolasi

### Pixel Office

- 1 ruangan
- 3 avatar
- 3 PC
- Collision
- A*
- State machine
- Event-driven animation

### Task execution

- Tool asli benar-benar dijalankan
- Tidak ada fake work animation
- Success / error / waiting dapat divisualisasikan

### Voice / Chat

- Mia tetap menjadi interface utama owner
- Voice realtime tetap memakai pipeline Mia yang sudah ada
- Tool calling tetap melalui backend

### Discord

- 3 bot berada pada server baru
- Routing dan dedupe berfungsi
- Confirmation terisolasi per agent

---

## 25. Keputusan Terbuka

Keputusan yang masih dapat ditentukan owner:

1. Reuse `/api/mia-state` atau membuat `/api/bus/stream` baru.
2. Detail payload `tool_called`: nama saja atau + ringkasan hasil.
3. Discord DM: `allow`, `owner-only`, atau `deny`.
4. Apakah workstation fixed per agent atau pool bebas.
5. Viewer: single-user atau multi-viewer.
6. Gerakan avatar otomatis berdasarkan task atau dapat diberi perintah eksplisit.
7. Apakah avatar kembali ke workstation default setelah task selesai.
8. Apakah agent dapat mendelegasikan task ke agent lain, atau hanya Mia yang boleh melakukan delegation pada MVP.

---

## 26. Prinsip Produk

Pixel Office bukan sekadar dekorasi.

Ia adalah **visual layer untuk sistem multi-agent Mia**.

Prinsip desain:

```text
ONE OWNER
    ↓
ONE MAIN ASSISTANT — MIA
    ↓
SPECIALIZED AGENTS
    ├── AGNES — RESEARCH
    └── MICHELLE — CODING
    ↓
REAL TOOLS
    ↓
REAL EVENTS
    ↓
REAL VISUAL STATE
```

Mia tetap menjadi pusat pengalaman owner.

Agnes dan Michelle adalah coworker AI yang dapat menerima pekerjaan nyata, menjalankan tool nyata, dan mengembalikan hasil nyata.
