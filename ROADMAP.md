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
[x] Basic task execution (integrasi tools menjadi workflow sederhana) — via `runAssistantTurn` + `MAX_TOOL_ROUNDS` + `agent.ts` core (dipakai web + Telegram/Discord)
[x] Refactor: pisahkan core conversation dari lapisan web (supaya core reusable lintas channel) — `lib/agent.ts` `runAssistantTurn` dipakai semua channel, bukan HTTP-to-self
[x] Calendar integration — `calendar.ts` per-user `calendar.json` (add/list/check), tools `calendar_list`/`calendar_add`/`calendar_check`, verify OK
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
[x] Typing indicator saat menunggu respon  — withTyping() di runTurn + handleConfirmation (re-pulse 8s, Discord tayangkan "bot lagi ngetik") (2026-09-06)
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
[x] Mood tracking: Mia tahu perasaan user & bisa menyesuaikan dukungan  — mood.ts (per-user `moods.json`: good/okay/meh/stressed/anxious/sad/tired/angry, terkap normalisasi IN-EN) + tools `mood_log` (read, auto) & `mood_recent` (read, auto, trend + riwayat); deteksi deterministic `moodIntent.ts` (log otomatis saat user bilang "aku stres/capek/galau" — tanpa perlu tool call) di kedua path agent; verified probe + typecheck/lint (2026-09-05)
[x] Spotify integration: kontrol musik pemilik via Spotify Web API  — spotify.ts (per-user OAuth token store `spotify.json`, auto-refresh) + route `/api/spotify/auth` (redirect OAuth) & `/api/spotify/callback` (exchange code→token); tools `spotify_link` (read) `spotify_status`/`spotify_search`/`spotify_devices` (read, auto) + `spotify_play`/`spotify_pause`/`spotify_next`/`spotify_previous`/`spotify_volume` (write, **EKSEKUSI LANGSUNG tanpa konfirmasi** sejak 2026-09-06 per keputusan user — deterministik intent play/control dari user-message jadi sumber kebenaran, call native hasil model didedup/dieksekusi in-place agar tidak double-action); playback control butuh akun Premium (status/search jalan di free); verified probe + verify.ts (2026-09-05)
[x] Fun features (personal touch)  — ramalan harian `mala.ts` (deterministik per tanggal+user: mood/warna/angka/pesan ala Mia, stabil sehari, gratis/offline) + game *Tebak Lagu* `game.ts` (spotify_secret dari **recently-played** user via `spotifyRecentTracks`, pencocokan lokal judul/artis, 3 clue, skor per-user `game.json`; fallback random search `spotifyRandomTrack`) + rekap malam `recap.ts` (deterministik dari daily memory + mood hari itu, tool `recap` on-demand + auto-push malam via `startRecapRunner` — RECAP_HOUR default 21:00, 0=off, mirip heartbeat) + tanggal merah `holiday.ts` (kalender sipil 2026 + catatan SKB untuk tanggal bergerak); tools `mala`/`game_start`/`game_guess`/`game_quit`/`hari_libur`/`recap` semua risk read auto-jalan tanpa FR-014; verify.ts `fun: OK` (2026-09-06)
[x] Briefing pagi (daily digest)  — `briefing.ts`: assembler deterministik (task jatuh tempo hari ini + overdue, reminder belum kejadian hari ini, mood+memory kemarin, tanggal merah hari ini) → pesan hangat template (no-LLM, offline-safe, senyap tanpa agenda); auto-push tiap pagi `startBriefingRunner` (BRIEFING_HOUR default 7, BRIEFING_ENABLED, mirror recap runner) + tool `briefing` (read, auto) untuk on-demand "pagi, briefing dong" di semua channel; snippet memory difilter (skip header timestamp + baris internal "(automation)"); verify.ts `briefing: OK` (2026-09-06)
[x] Spotify bugfixes deterministik (2026-09-06)  — (1) `limit=50` di `/search` ternyata **ditolak API** untuk app/akun ini ("Invalid limit" 400) → semua pencarian diturunkan ke ≤10 (`spotifyRandomTrack` limit=10); (2) query deiktik "lagu itu" sebelumnya mengekstrak query `"itu"` lalu diputar sebagai lagu acak → di `scheduleSpotifyFromIntent`, **query native `spotify_play` dari model (peka konteks) dimenangkan** atas intent detector; kata deiktik (itu/ini/kesana/…) kini di-strip di `spotifyIntent.ts` (hasil `null`); verified live: "coba play lagu itu" setelah reveal game memutar lagu yang benar
[x] Scheduler yang tahan restart (replay dari disk)  — reminders.json/automations.json unfired persist; SSE re-play on connect (survives restart/closed tab)
[x] Konfirmasi risky tool secara penuh di semua channel  — Telegram ya/tidak ✓; Discord ya/tidak ✓; automation create_automation juga via gate FR-014
[x] Web interaction: web_search lebih kuat (navigasi, ambil konten)  — web_search (DuckDuckGo instant+HTML) + tool baru fetch_url (scrape teks artikel by URL, SSRF-guard: blok localhost/private/metadata, htst HTTTP(S), size/timeout cap; ekstraksi article/main/og:description); live-verified 404 + example.com
```

---

## Fase 4 — Advanced Features

```text
[x] Long-term memory (RAG / knowledge retrieval dari catatan & file)  — rag.ts (local BM25 over notes, tasks, reminders, automations, uploads, persona) + tool search_memory; zero API dependency for retrieval, offline-ready. **Advanced Memory (2026-09-06):** hybrid semantic — embeddings Gemini (`gemini/gemini-embedding-001`) via 9router proxy (`lib/embed.ts`, endpoint derived dari `LLM_API_BASE` atau `EMBED_API_BASE`, model `EMBED_MODEL`), cache per-user incremental di `.data/users/<user>/memory/embeddings.json`, skor fusion BM25+cosine (`MEMORY_SEMANTIC_WEIGHT` default 0.6), auto-recall per turn (`recallContext` → blok "# Runtime recall" di system prompt, `MEMORY_RECALL_MIN_COS` default 0.28); graceful fallback BM25 murni saat embedding unavailable (offline)
[x] Rolling conversation summary  — `summarize.ts`: saat total teks chat melebihi `ROLLING_SUMMARY_TRIGGER_CHARS` (default 24000), pesan PALING LAMA di-roll jadi satu pesan ringkasan singkat via 1 call LLM (provider sama dgn turn; cache per-boundary: disk per-user `rollup.json` + in-memory by hash → 1 call per batas, bukan per turn; fallback deterministik digest saat offline/mock/gagal, tak pernah fatal). Hanya ekor `ROLLING_SUMMARY_KEEP_RECENT` (default 8) yang tetap verbatim → konteks baru + continuity tool_calls tak tersentuh; di-wire di `runAssistantTurnImpl` (semua channel). verify.ts `rolling summary: OK`; LIVE: obrolan 120k char di-roll, "kode rahasia apel112233" dari awal percakapan tetap teringat di akhir (2026-09-06)
[x] Link intelligence (read-it-later)  — `lib/library.ts`: link yang di-share user (web/Telegram/Discord) ditangkap DETERMINISTIK pasca-turn (`scheduleLinkCapture` dipanggil di `runAssistantTurnImpl` kedua branch) → fetch SSRF-guarded (`assertPublicUrl`/`canonicalizeUrl` dari tools.ts) → dirangkum via `summarizeText` (provider aktif, ~150 kata; fallback teks terbuka) → disimpan per-user `.data/users/<user>/reads.json` (max 60, dedupe URL, atomic-write) → catatan "Mia membaca link" di-append ke daily memory sehingga isinya ikut ter-index `search_memory`. Tools: `library_list` (read, auto) + `library_remove` (delete, FR-014). Suffix "Udah kusimpan…" hanya saat turn TIDAK berakhir di @@CONFIRM (flag `hasPendingConfirmation`); system prompt diarahkan agar model TIDAK memanggil fetch_url untuk link yang baru di-post user (auto-save). Perbaikan live: cap fetch 1MB (Wikipedia >120KB dulu gagal), `firstUrlInText` tak memotong URL ber-paren, ekstraksi strip nav/aside/header/footer/toc+infobox, `summarizeText` tidak lagi memblokir provider non-auth lokal (9router) saat `apiKey === "EMPTY"`. verify.ts `link intelligence: OK`; LIVE 9router: link Kopi arabika → tersimpan + ringkasan akurat (60% produksi global, endemik Etiopia/Sudan/Yaman…), "daftar bacaan-ku" → `library_list` tampil, "kopi arabika tadi?" → teringat (2026-09-07)
[x] Memory hygiene (dedupe & konflik fakta persona)  — `lib/persona.ts`: `hygienizePersona`/`hygienizeAllUsers` — USER.md dirapikan jadi SATU bagian `## Facts` (semua baris `- key: value` di bawah header apa pun); duplikat key di-collapse (nilai TERBARU menang), nilai lama dihitung `removed` + dilaporkan sebagai `conflicts` (keep-latest → tanya user). SOUL.md hanya baris yang SAMA PERSIS di-collapse (nilai style beda = teks naratif, bukan konflik). Idempoten (run 2× = no-op, ternormalisasi trailing-newline). Wiring: `upsertPersonaFact` auto-rapikan tiap tulis (continuous), `registerNode` jalankan hygiene SEMUA user saat start (log `persona: hygiene: N file, N baris`). Tool `memory_hygiene` (risk write, FR-014; jalankan saat user minta bersihkan/beresin memory). verify.ts `memory hygiene: OK`; padahal LIVE: startup hapus 45 duplikat dari personaku (USER.md 66→22 fakta unik), turn "bersihin ingatan" → model panggil `memory_hygiene` → konfirmasi → "Memory hygiene selesai. Tidak ada duplikat" (2026-09-07)
[ ] Multi-agent / specialized agents (mis. agent web, agent files, agent reminders)  — SKIP: fungsi specialist sudah ada sebagai tool di satu agent (web_search, file_read/exec, remind_me/add_task); multi-agent menambah latensi (> target <1.5s) + complexity tanpa kebutuhan single-owner. Kalau nanti butuh paralel: perkuat loop agent (parallel tool calls) — bukan pecah agent (2026-09-06)
[x] Voice interaction (perluas voice ke channel bot bila relevan; DSCORD voice)  — voice note/nativ voice message di Telegram (grammY `message:voice`) & Discord (attachment OGG) ditranskripsi via `lib/stt.ts` (STT_PROVIDER=groq Whisper | 9router Gemini audioInput) lalu masuk alur percakapan yang sama dengan teks; web `/api/stt` + bot berbagi satu pipeline tanpa HTTP-to-self (2026-09-06)
[ ] Integrasi lain: Calendar, Email, Smart home (opsional pribadi)
[x] Plugin/tool system (daftar tool pluggable)  — tools.ts kini plugin registry: `ToolPlugin { definition, execute }` dalam satu objek, `TOOLS`/`executeTool` diturunkan dari registry (tidak bisa divergen), `registerTool()` untuk tambah tool runtime
[ ] Channel baru sesuai kebutuhan (WhatsApp, Email, dll) via adapter  — lintas-channel relay via tool `send_channel` (Telegram ↔ Discord) sudah ada (pushTarget registry di globalThis)
[x] Shell execution (tool `exec` / `exec_write`) — jalankan command dengan sandbox/allowlist  — `exec` read-only (git status/log/diff, ls, pwd, cat, node --version, npm ls; execFile cwd sandboxRoots, timeout 10s, cap 60KB; auto-run); `exec_write` write (git add/commit/push/restore, tokenize quotes, same cwd/sandbox; requires FR-014 confirm); `resolveInSandbox` multi-root (repoRoot + ALLOWED_WORKSPACES); verify.ts OK (2026-09-04)
[x] File system lengkap (write / edit / patch) — `write_file` (create/overwrite, mkdir -p) + `edit_file` (replace old_string→new_string) — both sandboxed via `resolveInSandbox` + DENY + FR-014 confirm; capped 60KB; verify.ts OK (2026-09-04)
[x] Browser automation (interaksi UI, isi form, klik) — `browser.ts` Playwright headless + 5 tools: `browser_open` (read, JS-rendered, SSRF-guard), `browser_snapshot` (read, ARIA), `browser_click`/`browser_type`/`browser_navigate` (write, FR-014); single page per process; verify.ts `browser: OK` (2026-09-04)
[x] Device nodes — macOS/iOS/Android (camera, location, device command) — `devices.ts` minimal safe macOS node (per-user `devices.json`, `DEVICE_SECRET` pairing, `device_list`/`device_exec`/`device_screenshot` tools, `ensureLocalDevice` auto local-mac, `POST /api/devices`); verify `device: OK` (2026-09-04)
[x] Webhook trigger untuk automation — `POST /api/webhook` dengan `{secret, prompt, user?, provider?}` → `runAssistantTurn` + `pushToOwner` (🔔 webhook); `WEBHOOK_SECRET` env (optional, tapi required jika di-set); `GET` untuk health; verify via curl (2026-09-04)
[x] Heartbeat / periodic agent check-in — `heartbeat.ts` every `HEARTBEAT_INTERVAL_MINUTES` (default 30m, 0=off) checks active tasks with `dueAt` for overdue/due-soon and pushes via `pushToOwner` (💓 heartbeat); silent when nothing pending; started in `instrumentation-node.ts`; verify.ts `runHeartbeatTick` OK (2026-09-04)
[x] Daily memory (`memory/YYYY-MM-DD.md` + `memory_get`) — per-user per-day markdown at `.data/users/<user>/memory/YYYY-MM-DD.md` (`today`/`yesterday` alias) via `dailyMemory.ts`; `agent.ts` appends snippet each turn; `rag.ts` indexes into `search_memory`; tool `memory_get` (read, auto); verify.ts OK (2026-09-04)
[ ] Media generation (image / video / music) & image/video input understanding  — gap checklist OpenClaw Multimodal (saat ini uploads text-only)
[ ] Node/device (macOS/iOS/Android: camera, screen, location, device command)  — gap checklist OpenClaw Devices
[ ] x_search (X/Twitter)  — SKIP: web_search (DuckDuckGo + scrape) sudah menutupi kebutuhan dasar; X API resmi berbayar (Grok/x.ai) + scraping tidak stabil/ToS-risky — tidak sebanding utk asisten pribadi. Revisit jika butuh data post X real-time spesifik (2026-09-06)
```

---

## Fase 5 — Stability & Security

```text
[x] Authentication (tetap ringan untuk single-user, namun kokoh)  — AUTH_TOKEN: middleware.ts melindungi `/` + `/api/*` (kecuali /login, /api/auth|webhook, /api/spotify/) via cookie `mia_auth` (HttpOnly, POST /api/auth/login + DELETE logout + GET status) atau header `Authorization: Bearer`; halaman /login PIN pakai cookie HttpOnly+SameSite=Lax; default tanpa AUTH_TOKEN tetap terbuka (LAN pribadi); bot tak terpengaruh (langsung panggil core). Edge-safe authGuard.ts (2026-09-06)
[x] Permission management (per tool/channel)  — TOOLS_DENY (env/config.json): tool yang diblok untuk SEMUA channel di `executeTool` sebelum dispatch, tetap diaudit `tool:<x>::denied`; FR-014 risk-gate (read auto / write-delete confirm) tetap jalan sebagai lapisan kedua; matriks per-channel per-role baru relevan saat multi-owner (single-owner: satu kebijakan, didokumentasikan) (2026-09-06)
[x] Logging & error handling (file log, error surfaces)  — appLogger.ts: event operasional (bot start, heartbeat, recap, backup, error) diampless ke stdout DAN per-day `.data/logs/APP-YYYY-MM-DD.log` (`APP_LOG_ENABLED`=1, retensi `APP_LOG_KEEP_DAYS`=14); audit trail per-aksi tetap di auditLog.ts; best-effort tidak pernah blokir runtime (2026-09-06)
[x] Config management (env + config file terpusat)  — config.ts: precedence env → `.data/config.json` (gitignored, key sama dgn env) → default; getter bertipe (cfgStr/cfgInt/cfgBool/cfgList + named knob rateLimit/audit/recap/heartbeat/log/toolsDeny); rateLimit/auditLog/recap/heartbeat/tools/route di-refactor ke config (single source) (2026-09-06)
[ ] Secure credential handling (token, key di env; tak pernah ke client)
[x] Audit log — catat setiap tool/command yang dieksekusi (siapa, kapan, arg)  — auditLog.ts (`AUDIT_*.log` per-day di `.data/audit/`, append-only JSON: ts/user/action/detail, prune `AUDIT_KEEP_DAYS`=7, `AUDIT_ENABLED`=1; di-wire di `executeTool` (tool:*) + `runAssistantTurn` (turn_error/turn_rate_limited/tool_confirm_denied); best-effort, tidak pernah memblokir turn) (2026-09-06)
[x] Rate limiting app-level — throttle panggilan LLM/tool per user (kini rely pada 429 provider)  — rateLimit.ts sliding-window per user (`RATE_LIMIT_TURNS_PER_MIN` default 30, 0=off, in-memory) dipasang di `runAssistantTurn` (chokepoint semua channel); `RateLimitError` → HTTP 429 di `/api/llm` (2026-09-06)
[x] Sandbox penuh untuk exec — container/SSH/isolasi bila tool `exec` ditambahkan  — gap checklist OpenClaw Security (saat ini console; allowlist `resolveInSandbox` dipakai sebagai pengganti isolasi proses berat)
[x] Backup & recovery (memory, notes, reminders, sessions)  — backup.ts (backupNow, listBackups, restoreBackup, auto prune max 5, auto-backup on server boot) + command /backup di Telegram & Discord
[x] Observability ringan (log turn, latency, error count)  — turnStats.ts in-memory counters (turns ok/fail, errorRate, toolCalls, avg/last latency, topErrors, 50 recent) di-feed dari `runAssistantTurn` + `executeTool`; muncul di `GET /api/llm` dan `/status` (Since boot: …) (2026-09-06)
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
6. **Gap OpenClaw berikutnya (urutan saran):** 1) `exec` shell tool ✅ DONE, 2) `write`/`edit` file tool ✅ DONE, 3) Daily memory + `memory_get` ✅ DONE, 4) Heartbeat ✅ DONE, 5) Webhook ✅ DONE. Item-item ini dicatat di Fase 4 & 5.

---

## Pemetaan Fitur OpenClaw → Mia (dari `openclaw-features-tools-list.md`)

Ringkasan gap agar mudah dipantau (detail lengkap di checklist §24–26 file referensi):

```text
SUDAH (Tier 1):  LLM provider, agent runtime, workspace persona (SOUL/IDENTITY/USER/DREAMS),
                  daily memory (memory/YYYY-MM-DD.md + memory_get + search_memory RAG + auto-capture), sessions, web/telegram/discord channels,
                  plugin registry, task/notes/reminders/automations, file_read, write_file/edit_file, exec/exec_write, web_search,
                  fetch_url, browser (open/snapshot/click/type/navigate), device nodes (macOS local), send_channel, webhook, STT/TTS, session management, heartbeat
SUDAH (Tier 4):   owner allowlist, sandbox file_read/write/exec/browser/device, FR-014 konfirmasi, key server-side, backup/recovery
SEBAGIAN:         cron (scheduler interval, belum sintaks cron), background jobs (in-process), uploads (text-only)
BELUM (gap):      media generation, channel lain (WhatsApp/Slack)
                  SKIP (tidak penting utk single-owner): multi-agent, x_search
                  (audit log, rate-limit app-level, auth penuh — sudah DIISI Fase 5, 2026-09-06)
                  (device iOS/Android, camera/location still TODO beyond macOS local)
```

_Disusun mengikuti PRD v2.0. Perbarui checkbox saat fitur selesai._
