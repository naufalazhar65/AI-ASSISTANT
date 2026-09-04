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
[x] Provider selectable (Groq / OpenCode / 9Router / OpenRouter / Mock)  — OpenRouter (openai-compatible) + MiniMax model, live test via /provider di Discord
[x] Voice: ASR/LLM/TTS pipelines, transcript, multilingual detection
```

 **Node penting:** `packages/state-machine`, `packages/ai-provider`, `packages/mock-provider`, `apps/web/src/ai/*`, `apps/web/src/lib/{tools,persona,autoMemory,sessions,reminders,tasks,uploads,automations,automationRunner,status,assistantError,reminderIntent,reminderMessage,channelMessage,rag,backup,users,opencode}.ts`, `apps/web/src/channels/{telegram,discord,pushTarget}.ts`, `/api/llm` route, `instrumentation-node.ts`.

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
[x] Adapter Discord: terima text di DM/channel allow-list → core → balas  — apps/web/src/channels/discord.ts (discord.js/WebSocket gateway); DM butuh partials:[Channel,Message] + prefetch (fix "DM tidak merespon", 2026-09-03)
[x] Command system (slash commands)  — prefix "/" (start/help/reset/provider/model)
[x] Per-user conversation session  — in-memory per-channel history; user key dari discord username
[x] Konfirmasi risky tool via Discord  — "Balas ya / tidak" (sama pola Telegram)
```

### 2.4 Message Handling & Command System

```text
[x] Normalisasi input dari tiap channel ke format core (text user)  — `lib/channelMessage.ts`: NormalizedMessage {userKey, text, channel, chatId}; tiap adapter tinggal memetakan ctx/msg ke shape ini
[x] Normalisasi output dari core ke tiap channel (text/format)  — `replyMia` di Telegram/Discord masing-masing handle markdown/format channel; replyText dikembalikan dari command handler ter-unified
[x] Unified command parser (prefix per channel)  — `lib/channelMessage.ts` `handleUnifiedCommand(state, text)`; /start /help /reset /provider /model dipusatkan di sini, /status tetap di channel (perlu user+historyLen)
[x] Lintas-channel history opsional (sama session / terpisah)  — tiap channel punya `state.history` terpisah; sessions server-side `.data/users/<user>/sessions` shared via runAssistantTurn (fase 1.x)
```

---

## Fase 3 — Personal Assistant Capabilities

Mia benar-benar berguna sebagai asisten pribadi.

```text
[x] Automation: task terprogram / workflow yang dijadwalkan atau dipicu dari channel  — automations.ts (disk store + scheduler: daily/hourly) + automationRunner.ts (satu runAssistantTurn per due, push ke channel aktif) + tool create_automation (FR-014 confirm); pushTarget.ts sink bersama Telegram/Discord (live-verified: lapor cuaca tiap 12 jam)
[x] File handling: kirim/terima file (via Telegram/Discord) → file_read/file_ref tool  — uploads.ts (per-user disk store, dedup, text/image detection) + Telegram document/photo + Discord attachments; tools list_uploads + read_upload; file otomatis tersimpan (SISTEM), model dilarang save_note ulang
[x] Rate-limit / quota resilience  — runOneCompletion retry sekali saat 429 (honor Retry-After); runAssistantTurn balas graceful jika tool sudah jalan tapi follow-up gagal; assistantError.ts klasifikasi rate_limit/quota/provider/other + pesan jelas di web banner, Telegram, Discord (mis. "kuota token habis") + /api/llm status 429/402
[x] /status command (Telegram & Discord)  — status.ts buildStatusReport: waktu (Asia/Jakarta + UTC), uptime server, provider/model, history, data per-user (tasks/reminders/automations/notes/uploads); hanya data nyata yang ditampilkan (tanpa angka token/cost palsu)
[x] Notifications: reminder/notif proaktif push ke channel aktif (Telegram/Discord)  — pushTarget Telegram + pushTargetChannel Discord + reminderMessage ala Mia (live-verified)
[x] Scheduling/task management: daftar task, reschedule, cancel via chat  — tasks.ts + tools (add/list/complete/cancel/reschedule_task), insertion-order numbering
[x] Scheduler yang tahan restart (replay dari disk)  — reminders.json/automations.json unfired persist; SSE re-play on connect (survives restart/closed tab)
[x] Konfirmasi risky tool secara penuh di semua channel  — Telegram ya/tidak ✓; Discord ya/tidak ✓; automation create_automation juga via gate FR-014
[x] Web interaction: web_search lebih kuat (navigasi, ambil konten)  — web_search (DuckDuckGo instant+HTML) + tool baru fetch_url (scrape teks artikel by URL, SSRF-guard: blok localhost/private/metadata, htst HTTTP(S), size/timeout cap; ekstraksi article/main/og:description); live-verified 404 + example.com
```

---

## Fase 4 — Advanced Features

```text
[x] Long-term memory (RAG / knowledge retrieval dari catatan & file)  — rag.ts (local BM25 over notes, tasks, reminders, automations, uploads, persona) + tool search_memory; zero API dependency for retrieval, offline-ready
[ ] Multi-agent / specialized agents (mis. agent web, agent files, agent reminders)
[ ] Voice interaction (perluas voice ke channel bot bila relevan; DSCORD voice)
[ ] Integrasi lain: Calendar, Email, Smart home (opsional pribadi)
[x] Plugin/tool system (daftar tool pluggable)  — tools.ts kini plugin registry: `ToolPlugin { definition, execute }` dalam satu objek, `TOOLS`/`executeTool` diturunkan dari registry (tidak bisa divergen), `registerTool()` untuk tambah tool runtime
[ ] Channel baru sesuai kebutuhan (WhatsApp, Email, dll) via adapter  — lintas-channel relay via tool `send_channel` (Telegram ↔ Discord) sudah ada (pushTarget registry di globalThis)
```

---

## Fase 5 — Stability & Security

```text
[ ] Authentication (tetap ringan untuk single-user, namun kokoh)
[ ] Permission management (per tool/channel)
[ ] Logging & error handling (file log, error surfaces)
[ ] Config management (env + config file terpusat)
[ ] Secure credential handling (token, key di env; tak pernah ke client)
[x] Backup & recovery (memory, notes, reminders, sessions)  — backup.ts (backupNow, listBackups, restoreBackup, auto prune max 5, auto-backup on server boot) + command /backup di Telegram & Discord
[ ] Observability ringan (log turn, latency, error count)
```

---

## Kriteria Selesai MVP (v2.0)

MVP personal assistant dianggap berfungsi bila:

```text
[ ] Web chat + voice berfungsi (sudah)
[ ] Telegram Bot berfungsi (chat text dari ponsel)  — @inimiaku_bot
[x] Discord Bot berfungsi (chat text)  — adapter + lifecycle + DM partials fix (2026-09-03); live-verified DM & guild
[x] Memory konsisten lintas channel (fakta di web → teringat di Telegram/Discord)  — persona/notes/reminders per-user disk store dibagi semua channel via runAssistantTurn
[ ] Reminder bisa disetel & dipicu (setidaknya di web; ideal via semua channel)
[ ] Tool risky memerlukan konfirmasi di semua channel
[ ] Menambah channel baru tidak mengubah core
```

---

## Prioritas Kerja (urutan terdekat)

1. **Fase 2.1/2.2 — Telegram Bot** (channel ponsel paling bermanfaat & mudah).  — DONE
2. **Fase 2.3 — Discord Bot** — DONE (adapter + DM partials fix; live-verified DM & guild).
3. **Fase 2.4 — Message Handling & Command System** — DONE (unified command parser + normalisasi input/output di lib/channelMessage.ts; wiring Telegram & Discord; live test /provider yang berhasil ganti model).
4. **Fase 3 — Personal Assistant Capabilities** — DONE (notif push, task management, scheduler tahan-restart, uploads, read_upload, scheduled automations, rate-limit resilience, quota alert, /status, web interaction incl. fetch_url). Fase 3 SELESAI.
5. **Fase 3/5 — Konfirmasi + logging** untuk kenyamanan pribadi.

---

_Disusun mengikuti PRD v2.0. Perbarui checkbox saat fitur selesai._
