# Product Requirements Document (PRD)
# Personal AI Assistant (Mia)

**Nama Produk:** Mia — Asisten AI Pribadi
**Versi Dokumen:** 2.0 (revisi besar dari v1.0 "Real-Time Voice AI Assistant")
**Status:** Draft
**Jenis Dokumen:** Product Requirements Document
**Target Platform:** Web (voice + text), Telegram Bot, Discord Bot, (future: channel lain)
**Interaksi Utama:** Multi-channel — chat text real-time, voice conversation, task automation
**Inspirasi Produk:** OpenClaw, Siri, ChatGPT Voice, Gemini Live

---

## 1. Ringkasan Produk ("What & Why")

Mia adalah **Personal AI Assistant** yang menjadi pusat kendali (command center) untuk berbagai aktivitas pribadi pengguna. Berbeda dari versi 1.0 yang berfokus pada voice-first untuk publik, Mia dirancang khusus sebagai asisten pribadi **single-user** yang hidup di berbagai channel komunikasi.

Tujuan utama:

> **"Membangun Personal AI Assistant yang dapat menjadi pusat kendali untuk berbagai aktivitas pribadi, dengan kemampuan berkomunikasi melalui berbagai platform seperti Telegram dan Discord serta dapat menjalankan berbagai task secara otomatis."**

### Perubahan dari v1.0

| Aspek | v1.0 (lama) | v2.0 (baru) |
|---|---|---|
| Audiens | Publik (banyak user) | Personal (single user) |
| Interaksi utama | Voice real-time | Multi-channel (web/voice + bot) |
| Deployment | Multi-tenant/skalabel | Single-instance pribadi (VPS/Docker) |
| Target | Product kepada publik | Asisten pribadi sehari-hari |
| Kunci sukses | Voice realism + latency | Integrasi channel + task execution |
| Auth | Multi-user auth | Identity ringan (auth-lite per user) |

---

## 2. Product Vision

> **"Sebuah asisten AI pribadi yang selalu ada, di channel mana pun kamu berada — mengetik di Telegram, berbicara di web, atau mengobrol di Discord — dan bisa mengerjakan hal-hal untukmu secara otomatis."**

Filosofi OpenClaw: asisten tidak terikat pada satu platform. Ia hadir di channel yang penggunanya pakai, menggunakan memory dan tools yang sama di semua channel, sehingga pengalaman konsisten di mana pun.

---

## 3. Problem Statement

Interaksi dengan AI saat ini terbelah di banyak tempat: chatbot di satu aplikasi, asisten suara di aplikasi lain, reminder di aplikasi lain lagi. Masalahnya:

1. Tidak ada satu asisten yang konsisten di semua tempat.
2. Memory dan konteks hilang setiap ganti platform.
3. Pengguna harus mengulang identitas/preferensi di tiap alat.
4. Automation (reminder, task, notifikasi) tidak terpusat.
5. Tidak bisa berinteraksi dari mana pun pengguna berada (mis. dari ponsel via Telegram).

Tujuan: satu asisten (Mia) dengan satu memory & satu set tools, diakses dari banyak channel.

---

## 4. Product Goals

### 4.1 Primary Goals

- **Multi-channel** — dapat diakses via web (text + voice) dan bot Telegram/Discord.
- **Konsisten** — memory, persona, dan tools sama di semua channel.
- **Bermanfaat sehari-hari** — mampu menjalankan task (reminder, catatan, pencarian, file) sebagai asisten pribadi.
- **Extensible** — arsitektur memungkinkan penambahan channel/platform baru dengan mudah.
- **Reliable** — stabil untuk penggunaan harian single-user.

### 4.2 Secondary Goals

- Voice conversation (sudah dibangun di v1.0) tetap berjalan sebagai salah satu channel.
- Automation & scheduling.
- Notifikasi push (via channel).
- Arah ke multi-agent / specialized agents di fase lanjut.

---

## 5. Non-Goals (bukan fokus sekarang)

Karena ini asisten pribadi (bukan SaaS publik), hal berikut secara eksplisit **tidak** diprioritaskan:

- Multi-tenant SaaS / billing / subscription.
- OAuth kompleks & manajemen ribuan user.
- Analitik produk publik (DAU/WAU, funnel).
- Mobile native app (web cukup; bot menangani mobile).
- Smart home / IoT / computer control (fase jauh di depan).
- Wake word "Hey Mia".
- Skalabilitas horizontal multi-instance (cukup single instance).

---

## 6. Target User

### 6.1 Primary User

Naufal (developer) — pengguna tunggal. Kebutuhan:

- Mengobrol dengan AI kapan saja (chat text di web / Telegram / Discord).
- Voice conversation untuk kebutuhan hands-free / natural.
- Mengatur reminder, catatan, pencarian web, akses file.
- Mengontrol asisten dari ponsel (Telegram) maupun desktop (web/Discord).

Bahasa interaksi: **Bahasa Indonesia** (santai), disapa "Mas Naufal".

### 6.2 Persona

- Nama: **Mia** (lihat `apps/web/persona/IDENTITY.md`).
- Sifat: ramah, sopan, rajin, menyenangkan.
- Emoji khas: 🌸 (boleh di teks, tidak pernah diucapkan TTS).
- Memory pribadi di `apps/web/persona/*.md` (USER.md, SOUL.md, DREAMS.md) yang di-update otomatis.

---

## 7. Konsep Arsitektur (Core Principle)

~Prinsip yang sama dari v1.0 dipertahankan dan diperluas~

### 7.1 AI Provider Abstraction (invariant)

AI Provider diabstraksikan (`AIProvider`) — UI/audio/channel tidak pernah terikat ke satu provider. Swap provider dengan mengganti instance.

### 7.2 Channel Abstraction (baru)

Diperkenalkan **Channel Adapter** — abstraksi untuk tiap platform:

```text
ChannelAdapter (interface)
├── WebAdapter
├── TelegramAdapter
├── DiscordAdapter
└── (future) WhatsAppAdapter / EmailAdapter / dll
```

Setiap adapter menerima input (text/voice) dari platformnya, meneruskan ke **core Conversation Manager** yang sama, dan mengirim balasan kembali ke platform. **Core tidak tahu platform** — hanya tahu "kami menerima pesan text" / "kirim balasan".

Ini memastikan extensibility: menambah channel = menambah adapter, tanpa menyentuh core.

### 7.3 Core (dipakai bersama semua channel)

```text
┌─────────────────────────────────────────────┐
│                 CHANNELS                     │
│  Web (voice+text)  Telegram  Discord  ...    │
└───────────────┬─────────────────────────────┘
                ▼
        Channel Adapters
                ▼
┌─────────────────────────────────────────────┐
│         CORE CONVERSATION LAYER              │
│  Conversation Manager + State Machine        │
│  Memory / Persona                            │
│  Tools / Tool calling + confirmation         │
│  Reminders / Scheduler                       │
│  AI Provider abstraction (LLM/STT/TTS)       │
└───────────────┬─────────────────────────────┘
                ▼
          Provider (Groq/OpenCode/9Router/Mock)
```

Semua channel berbagi memory/persona/tools yang sama → konsistensi.

---

## 8. Functional Requirements

> Catatan: FR-001 s.d. FR-016 dari v1.0 (voice pipeline, VAD, barge-in, transcript, dll) **tetap berlaku** untuk channel Web/voice dan tidak dihapus. Bagian di bawah menambahkan/menyesuaikan FR untuk arah multi-platform & personal assistant. Pranala silang ke v1.0 ditandai.

### 8.1 Multi-Channel (baru)

**FR-100 — Web Channel** (ada dari v1.0, dipertahankan)
User dapat mengobrol via web (text `PromptInput`) dan mode voice (mic + hands-free VAD).

**FR-101 — Telegram Bot Channel**
User dapat mengobrol dengan Mia melalui bot Telegram pribadi. Pesan text bot diterima, diproses oleh core yang sama, balasan dikirim balik ke chat Telegram.

Autentikasi bot: hanya chat/owner dalam allow-list tertentu yang dilayani (single-user trust boundary).

**FR-102 — Discord Bot Channel**
User dapat mengobrol dengan Mia melalui bot Discord. Mendukung text di channel/DM. (Voice di Discord = fase lanjut, FR-10x nanti.)

**FR-103 — Extensible Channel Registry**
Arsitektur channel berbasis registry/adapter sehingga menambah platform (WhatsApp, Email, dsb) tidak mengubah core. Daftar channel aktif dari config.

### 8.2 Personal Assistant Capabilities (memperluas v1.0 FR-013/FR-014)

**FR-200 — Tool Calling** (dari v1.0 FR-013)
AI dapat memanggil tool server-side (web_search, calculate, file_read, list_notes, save_note, delete_note, remind_me).

**FR-201 — Tool Confirmation / Risky Actions** (v1.0 FR-014)
Tool berisiko (write/delete/transaction/external) memerlukan konfirmasi user sebelum dijalankan. Di web ada banner UI; di Telegram/Discord, konfirmasi berupa prompt balasan (mis. "Balas 'ya' untuk melanjutkan").

**FR-202 — Reminders / Scheduler** (dari "Schedulers & reminders" yang sudah dibangun)
User dapat menyetel reminder ("bangunin aku jam 9 pagi"). Scheduler in-process memicu notifikasi ke channel yang aktif (ada SSE web + akan diperluas ke push Telegram/Discord).

**FR-203 — Memory / Persona** (dari "Automatic persona memory" yang sudah dibangun)
Fakta/identitas user secara otomatis di-capture dan disimpan per-user di persona markdown. Konsisten lintas channel.

**FR-204 — Notes & File** (dari "Persistent notes" + "File access tool" yang sudah dibangun)
Catatan persisten per-user; baca file dalam sandbox repo.

**FR-205 — Web Search** (dari v1.0 FR-013)
Tool web_search via DuckDuckGo Instant Answer + HTML scrape fallback.

### 8.3 Automation & Task (arah fase lanjut)

**FR-300 — Task Execution** (fase Personal Assistant Capabilities)
Menjalankan task terprogram: automation yang dapat dijadwalkan/dipicu dari channel.

**FR-301 — Notifications**
Mia dapat mengirim notifikasi proaktif (mis. reminder due) ke channel yang aktif, tidak hanya menunggu user bertanya.

---

## 9. Conversation Model

Sama dengan v1.0, diperluas dengan metadata channel:

```text
Conversation
├── conversation_id
├── user_id           (sanitized, auth-lite per user)
├── channel           (web | telegram | discord | ...)
├── created_at
├── updated_at
├── system_context
└── messages[]
```

Channel direkam supaya session per channel dapat dipertahankan dan disambung lagi.

Message model dipertahankan dari v1.0 (role: system/user/assistant/tool).

---

## 10. State Machine

State machine dari v1.0 (IDLE → LISTENING → PROCESSING → SPEAKING → TURN_END/INTERRUPTED) tetap berlaku untuk channel voice. Untuk channel text (web/telgram/discord), state disederhanakan: PROCESSING → (reply) → IDLE — karena tidak ada audio pipeline. Core Conversation Manager memegang transisi valid yang mustahil invalid.

---

## 11. Technical Architecture

```text
                     CHANNEL LAYER
   ┌─────────────┬───────────────┬───────────────┐
   │ Web (Next)  │  Telegram Bot │  Discord Bot  │
   │ voice+text  │  (long-poll)  │  (gateway)    │
   └──────┬──────┴───────┬───────┴───────┬───────┘
          │              │               │
          ▼              ▼               ▼
   ┌─────────────────────────────────────────┐
   │        CHANNEL ADAPTERS (interface)      │
   └──────────────────┬──────────────────────┘
                      ▼
   ┌─────────────────────────────────────────┐
   │           CORE SERVICE (Node)            │
   │  ConversationManager  StateMachine       │
   │  Memory/Persona  Tools  Reminders        │
   │  AIProvider abstraction                  │
   └──────────────────┬──────────────────────┘
                      ▼
            Provider (Groq/OpenCode/9Router/Mock)
                      │
            ┌─────────┴─────────┐
            ▼                   ▼
         (STT/TTS)            (LLM)
```

### Stack yang sudah dipakai (dari repo existing)

- `apps/web` — Next.js (frontend web + `/api/*` route handlers sebagai server backend).
- `packages/state-machine` — explicit conversation state machine.
- `packages/ai-provider` — `AIProvider` abstraction + event types.
- `packages/mock-provider` — deterministic no-network provider.
- Provider: `GroqStreamingProvider` (Whisper → Qwen SSE → Orpheus TTS), `opencode` native transport (`apps/web/src/lib/opencode.ts`), OpenCode/9Router/Mock.

Channel adapter Telegram/Discord akan diletakkan di lapisan yang sama dengan `/api/*` route handlers (Node runtime) sehingga memakai core yang sama.

---

## 12. Security & Trust Boundary

Wolf pertahanan dari v1.0 tetap dipertahankan & diperluas:

- **Invariant 5** — API keys/endpoint hanya di server; client (web) hanya kirim `{provider, model}`, channel adapter juga hanya untuk chat text ke core.
- **Sanitasi user** — `sanitizeUser()` mencegah path traversal pada persona/notes/reminders (auth-lite).
- **Tool validation server-side** — tool call dicek & risiko (read/write/delete/transaction/external) → read auto-run, sisanya konfirmasi.
- **File sandbox** — `file_read` terbatas pada repo root + deny-list segmen/filename sensitif.
- **Bot trust boundary** — Telegram/Discord hanya melayani owner/allow-list (single-user), bukan publik.
- **Credential handling** — token bot (Telegram/Discord) disimpan di env server-side, tidak pernah ke browser.

---

## 13. Non-Functional Requirements

- **Latency** — target v1.0 tetap: first audio <1.5s untuk voice. Untuk text bot, target TTFT <~2s.
- **Reliability** — single instance; background scheduler in-process (reminder). Catatan: lama akan bertahan selama instance hidup; untuk restart, uses disk store.
- **Cost** — asisten pribadi, budget kecil. Gunakan free tier Groq + local OpenCode bila memungkinkan.
- **Observability** — logging error/state cukup (tidak butuh analytics publik).

---

## 14. MVP Scope (Baru)

### 14.1 Must Have

```text
✅ Web chat text (ada)
✅ Web voice conversation (ada)
✅ Conversation context & history (ada)
✅ Memory/persona otomatis (ada)
✅ Tool calling + confirmation (ada)
✅ Reminders/Scheduler (ada, di web)
✅ Telegram Bot chat text          (BARU)
✅ Discord Bot chat text           (BARU)
✅ Sanitasi user / auth-lite       (ada)
✅ Server-side keys                (ada)
```

### 14.2 Nice to Have

```text
🟡 Notifikasi reminder ke Telegram/Discord (push)
🟡 Konfirmasi risky tool via bot (balas 'ya')
🟡 Per-konversasi di bot memakai session server-side
🟡 Voice di Discord
```

### 14.3 Future

```text
🔵 Task automation terprogram
🔵 Multi-agent / specialized agents
🔵 Long-term memory (RAG)
🔵 Channel baru (WhatsApp, Email)
🔵 Plugin/tool system
🔵 Auth penuh, permission management, logging/audit
```

---

## 15. User Stories (baru)

- **US-100** — Sebagai Mas Naufal, aku bisa kirim pesan via Telegram dan Mia membalas dengan memory yang sama seperti di web.
- **US-101** — Sebagai Mas Naufal, aku bisa kirim pesan via Discord DM dan mendapat balasan.
- **US-102** — Sebagai Mas Naufal, aku bisa bilang "bangunin aku jam 7" dan Mia benar-benar menyetelnya lalu mengingatkanku.
- **US-103** — Sebagai Mas Naufal, bila Mia mau menghapus catatanku, dia minta konfirmasi dulu (bisa lewat Telegram).
- **US-104** — Sebagai Mas Naufal, menambah platform baru tidak mengubah cara core bekerja.

---

## 16. Acceptance Criteria

**AC-100 — Telegram Chat**
```text
GIVEN bot Telegram dikonfigurasi dengan token owner
WHEN user mengirim pesan text ke bot
THEN pesan dip roses oleh core yang sama dengan web
AND balasan Mia terkirim kembali sebagai chat text
```

**AC-101 — Discord Chat**
```text
GIVEN bot Discord dikonfigurasi
WHEN user mengirim pesan di DM/channel allow-list
THEN Mia membalas dengan core yang sama
```

**AC-102 — Memory Konsisten**
```text
GIVEN user menyebutkan fakta (mis. "nama kucingku Milo") di web
WHEN user bertanya hal terkait di Telegram
THEN Mia masih ingat fakta tersebut (memory per-user dibagikan)
```

**AC-103 — Reminder via Bot**
```text
GIVEN user menyetel reminder di Telegram
WHEN waktu tiba dan bot aktif
THEN bot mengirim notifikasi reminder
AND reminder ditandai fired (tidak dobel)
```

**AC-104 — Tool Confirmation via Bot**
```text
GIVEN Mia meminta tool berisiko di Telegram
WHEN user membalas 'ya'
THEN tool dijalankan
AND hasil dikirim balik
```

**AC-105 — Extensibility**
```text
GIVEN ada 2 channel (telegram, discord)
WHEN developer menambahkan channel ketiga via adapter baru
THEN core tidak berubah
```

---

## 17. Risks

| ID | Risiko | Mitigasi |
|---|---|---|
| R-100 | Scheduler in-process hilang saat restart | Simpan reminder di disk; replay saat start |
| R-101 | Bot terpapar publik (spam/abuse) | Allow-list owner saja, non-publik |
| R-102 | Token bot bocor | Simpan di env server, tak pernah ke client |
| R-103 | Latency bot tinggi (OpenCode/9router down) | Fallback ke Groq (cepat); monitoring port |
| R-104 | Cost (LLM pribadi) | Free tier + local provider + cache |
| R-105 | Tool salah eksekusi via bot | Risk gate + konfirmasi eksplisit |

---

## 18. Document Status

**Status:** Draft
**Versi:** 2.0
**Referensi:** `ROADMAP.md` (panduan fase pengembangan utama)
**History:** v2.0 merupakan revisi besar dari `PRD_Real-Time_Voice_AI_Assistant.md` v1.0 (voice-first → personal multi-platform assistant).
