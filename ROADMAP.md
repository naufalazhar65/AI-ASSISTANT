# ROADMAP — Personal AI Assistant (Mia)

Panduan utama pengembangan. Menggantikan roadmap di PRD v1.0 (voice-first → personal multi-platform assistant). Status ditandai dengan checkbox; satu garis = target per fase.

**Legend:** `[x]` selesai · `[ ]` belum · `(sebagian)` berjalan sebagian

---

## Fase 0 — Fondasi yang Sudah Ada (dari v1.0)

Fondasi dari project voice assistant tidak dibuang — menjadi landasan Fase 1–5.

```text
[x] AI Provider abstraction (AIProvider: connect/sendAudio/sendText/interrupt/disconnect)
[x] Explicit conversation state machine (IDLE→LISTENING→PROCESSING→SPEAKING→…)
[x] Web chat text (PromptInput) + hands-free voice (VAD, barge-in)
[x] Conversation context + history (per-user, resumable, multi-session)
[x] Memory/persona otomatis (OpenClaw-style auto-capture ke persona .md)
[x] Tool calling + konfirmasi risky (web_search, calculate, file_read, notes, remind_me)
[x] Reminders / scheduler (per-user, disk store, SSE push web)
[x] Sanitasi user / auth-lite (persona/notes/reminders terisolasi per nama)
[x] Provider selectable (Groq / OpenCode / 9Router / Mock)
[x] Voice: ASR/LLM/TTS pipelines, transcript, multilingual detection
```

**Node penting:** `packages/state-machine`, `packages/ai-provider`, `packages/mock-provider`, `apps/web/src/ai/*`, `apps/web/src/lib/{tools,persona,autoMemory,sessions,reminders,users,opencode}.ts`, `/api/llm` route.

---

## Fase 1 — Core AI Assistant

Memperkuat inti asisten (sudah ~90% dari Fase 0).

```text
[x] AI conversation (multi-provider: Groq/OpenCode/9Router/Mock)
[x] Memory (persona + auto-capture per-user)
[x] Context management (conversation history, multi-session resumable)
[x] Tool/function calling (server-side, risk-gated, confirmation)
[ ] Basic task execution (integrasi tools menjadi workflow sederhana)
[ ] Refactor: pisahkan core conversation dari lapisan web (supaya core reusable lintas channel)
```

**Fokus:** memastikan core dapat dipanggil oleh channel apa pun → siap untuk Fase 2.

---

## Fase 2 — Communication Layer (Channel Integration)

**Target utama project** — menghubungkan Mia ke Telegram dan Discord.

### 2.1 Arsitektur Channel Adapter

```text
[x] Definisikan interface ChannelAdapter (send/receive text, command)  — core reusable via apps/web/src/lib/agent.ts (runAssistantTurn); adapter == fungsi/kelas per channel
[x] Buat Channel Registry (daftar adapter aktif dari config)  — sebagian: Telegram via env TELEGRAM_BOT_TOKEN; registry penuh menyusul
[x] Refactor /api/llm jadi core service yang dapat dipanggil oleh web DAN bot (atau buat service helper)  — apps/web/src/lib/agent.ts, dipakai web route + bot (tanpa HTTP-to-self)
```

### 2.2 Telegram Bot

```text
[x] Setup bot via BotFather, simpan token di env server-side  — @inimiaku_bot, TELEGRAM_BOT_TOKEN (git-ignored .env.local)
[x] Adapter Telegram: terima text message → core → balas  — apps/web/src/channels/telegram.ts (grammY)
[x] Allow-list owner (hanya user ini yang dilayani)  — TELEGRAM_ALLOWED_USERNAME (default naufalazhar65)
[x] Command system (mis. /start, /help, /reset)  — /start /help /reset /provider /model
[x] Per-user conversation session di bot (gunakan sessions server-side)  — in-memory per-chat history (sessions server-side dapat disambungkan nanti)
[x] Multi-message/reply handling (konfirmasi risky tool via balasan)  — "Balas 'ya' / 'tidak'"
[x] Long-polling / webhook (pilih sesuai deployment VPS)  — long-poll in-process dengan Next (single process)
```

### 2.3 Discord Bot

```text
[x] Setup bot di Discord Developer Portal, simpan token di env  — DISCORD_BOT_TOKEN (git-ignored .env.local); serverExternalPackages di next.config.js
[x] Adapter Discord: terima text di DM/channel allow-list → core → balas  — apps/web/src/channels/discord.ts (discord.js/WebSocket gateway)
[x] Command system (slash commands)  — prefix "/" (start/help/reset/provider/model)
[x] Per-user conversation session  — in-memory per-channel history; user key dari discord username
[x] Konfirmasi risky tool via Discord  — "Balas ya / tidak" (sama pola Telegram)
```

### 2.4 Message Handling & Command System

```text
[ ] Normalisasi input dari tiap channel ke format core (text user)
[ ] Normalisasi output dari core ke tiap channel (text/format)
[ ] Unified command parser (prefix per channel)
[ ] Lintas-channel history opsional (sama session / terpisah)
```

---

## Fase 3 — Personal Assistant Capabilities

Mia benar-benar berguna sebagai asisten pribadi.

```text
[ ] Automation: task terprogram / workflow yang dijadwalkan atau dipicu dari channel
[ ] File handling: kirim/terima file (via Telegram/Discord) → file_read/file_ref tool
[ ] Web interaction: web_search lebih kuat (navigasi, ambil konten)
[ ] Notifications: reminder/notif proaktif push ke channel aktif (Telegram/Discord)
[ ] Scheduling/task management: daftar task, reschedule, cancel via chat
[ ] Scheduler yang tahan restart (replay dari disk)
[ ] Konfirmasi risky tool secara penuh di semua channel
```

---

## Fase 4 — Advanced Features

```text
[ ] Long-term memory (RAG / knowledge retrieval dari catatan & file)
[ ] Multi-agent / specialized agents (mis. agent web, agent files, agent reminders)
[ ] Voice interaction (perluas voice ke channel bot bila relevan; DSCORD voice)
[ ] Integrasi lain: Calendar, Email, Smart home (opsional pribadi)
[ ] Plugin/tool system (daftar tool pluggable)
[ ] Channel baru sesuai kebutuhan (WhatsApp, Email, dll) via adapter
```

---

## Fase 5 — Stability & Security

```text
[ ] Authentication (tetap ringan untuk single-user, namun kokoh)
[ ] Permission management (per tool/channel)
[ ] Logging & error handling (file log, error surfaces)
[ ] Config management (env + config file terpusat)
[ ] Secure credential handling (token, key di env; tak pernah ke client)
[ ] Backup & recovery (memory, notes, reminders, sessions)
[ ] Observability ringan (log turn, latency, error count)
```

---

## Kriteria Selesai MVP (v2.0)

MVP personal assistant dianggap berfungsi bila:

```text
[ ] Web chat + voice berfungsi (sudah)
[ ] Telegram Bot berfungsi (chat text dari ponsel)  — @inimiaku_bot
[x] Discord Bot berfungsi (chat text)  — adapter + lifecycle siap; butuh token + allow-list untuk aktif
[ ] Memory konsisten lintas channel (fakta di web → teringat di Telegram)
[ ] Reminder bisa disetel & dipicu (setidaknya di web; ideal via semua channel)
[ ] Tool risky memerlukan konfirmasi di semua channel
[ ] Menambah channel baru tidak mengubah core
```

---

## Prioritas Kerja (urutan terdekat)

1. **Fase 2.1/2.2 — Telegram Bot** (channel ponsel paling bermanfaat & mudah).  — DONE
2. **Fase 2.3 — Discord Bot** — DONE (adapter siap; aktifkan dgn token + allow-list).
3. **Fase 3 — Automation + Notification** (reminder push ke channel).  — aktifkan Discord push; scheduler tahan-restart.
4. **Fase 3/5 — Konfirmasi + logging** untuk kenyamanan pribadi.

---

_Disusun mengikuti PRD v2.0. Perbarui checkbox saat fitur selesai._
