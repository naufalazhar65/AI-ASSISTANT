# Mia — Fitur Lengkap (2026-09-08)

Semua fitur yang sudah berjalan di production. Update: Vision, habit tracker, wind-down, email inbox, learn-from-correction.

---

## 1. Channels

- **Web** — chat text + voice (mic, STT/TTS), vision upload 📎, multi-session, auth PIN
- **Telegram** — text, voice note, foto, inline confirm, typing indicator
- **Discord** — text, voice note, foto, slash commands, inline confirm, typing indicator
- **PWA Eyes** — HP Android sebagai wajah Mia: mata reaktif (LISTENING/PROCESSING/SPEAKING), TTS dari speaker HP, wake lock — `apps/web/src/app/eyes`
- **Webhook** — `POST /api/webhook` (external trigger automation)

## 2. Otak & Provider

- **OpenCode Go (GLM 5.2)** — default brain, auto-switch ke `deepseek-v4-flash-vision-exp` saat ada gambar
- **Multi-provider** — Groq / opencode local / 9router / openrouter / mock, selectable per channel
- **Voice**: STT Whisper (Groq/9router), TTS Orpheus (Groq) + ElevenLabs siap (`TTS_PROVIDER=elevenlabs`)
- **Tool serialization**: field `risk` tidak dikirim ke LLM (gateway-strict safe)

## 3. Productivity

- **Reminders** — jam Indonesia pintar ("jam 1 siang"=13:00, "jam 8 pas"=nearest), harian + variasi pesan model-authored, `reminders_list` (honest status), push multi-channel
- **Tasks** — add/list/complete/cancel/reschedule, dueAt → auto-reminder
- **Habits** — `habit_log`/`habit_stats`, dedup harian, laporan mingguan di Weekly Insight
- **Wind-down 22:00** — push siap tidur + sleep log otomatis via "mau tidur" (dedup persist)
- **Automations** — jadwal periodik user-defined (`create_automation`), headless auto-deny

## 4. Inteligensi & Memori

- **Codebase QA** — index repo+workspaces → jawab pertanyaan kode dengan file:line (`codebase_search`)
- **Learn from correction** — "salah/koreksi/seharusnya" → `corrections.json` → masuk RAG (silent)
- **Memory RAG** — hybrid BM25+embedding, auto-recall per turn
- **Auto persona memory** — fakta stabil di-capture otomatis (exclude `reminder.*` transien)
- **Memory hygiene** — dedupe/konflik fakta persona, keep-latest
- **Weekly Insight** — Minggu 20:00: mood, task, tema (day-based), habit stats
- **Briefing pagi 07:00** — agenda, reminder hari ini, mood kemarin, holiday
- **Recap malam 21:00** — refleksi harian, junk-free
- **Link intelligence** — link dishare → dirangkum → reading list
- **Context awareness** — app/window aktif Mac (sampling 15s)
- **Learn from correction** — silent, tanpa push

## 5. Monitoring

- **Mac monitors** — batre ≤X%, storage ≥X% → alert 1× per crossing (hysteresis ±5)
- **Web watchlist** — crypto (CoinGecko) & web price (scrape), alert via heartbeat
- **Heartbeat 30m** — task overdue/due-soon + semua monitor
- **Place honesty guard** — status venue tanpa verifikasi → nudge jujur

## 6. Vision & Media

- **Vision** — foto kamera HP (≤10MB) → deskripsi akurat via `image_url` (auto model switch)
- **Voice note** — Telegram/Discord voice → transkrip → balas audio
- **Uploads** — file text tersimpan & terbaca, images di-pair dengan device

## 7. Mac Control

- **Bluetooth** — `blueutil -p [0|1]` on/off/status (FR-014 confirm)
- **Screenshot** — `screencapture` (confirm)
- **Battery/Storage** — pmset + df volume Data (angka jujur)
- **mac_open** — buka URL di browser asli (visible) vs browser_* headless (automation)
- **exec/exec_write** — allowlist, sandbox multi-root, npm test/run (150s)

## 8. Music & Fun

- **Spotify** — play/pause/next/prev/volume, resume intent ("play lagi"), verify playback (honesty), deeplink fallback 30s
- **Mala** — ramalan harian deterministik
- **Game tebak lagu** — dari riwayat Spotify, 3 clue, skor
- **Hari libur** — kalender sipil + catatan SKB

## 9. Travel & Live Data

- **Waze Direct** — `waze_route` Nominatim → Waze `routing-livemap-row` (XML, retry 3×) → OSRM fallback, free, `waze.sh "Monas, Jakarta" "BSD City"`
- **Weather Jakarta** — `weather` wttr.in `?format=j1` + Open-Meteo fallback, free, `weather.sh "BSD City"`
- **Hotel Finder** — `hotel_search` Booking.com Playwright headless `id-ID`, `hotel.sh "Bandung" "400rb"`, 60–150% budget band

## 10. Dev & Safety

- **Git Helper** — `git_status` (auto) + `git_commit` (write, confirm) + `git.sh` / `safe-exec*.sh`
- **SafeExec** — CRITICAL/HIGH/MEDIUM/LOW guard, pending `~/.openclaw/safe-exec/pending/`, audit `safe-exec-audit.log`, `safe_exec_list`, env `SAFE_EXEC_DISABLE` / `OPENCLAW_AGENT_CALL`
- **Self-improving** — `.learnings/` (LRN/ERR/FEAT, Pattern-Key dedup, Recurrence-Count), hooks `bootstrap` + `sweep`, Mia tools `learnings_search`/`learnings_review`, promote `Recurrence>=3` → `AGENTS.md`/`SOUL.md`/`TOOLS.md`

## 11. Email (Gmail, read-only)

- **OAuth** — per-user `gmail.json`, auto-refresh, consent screen
- **Tools** — `gmail_link`/`gmail_list`/`gmail_search`/`gmail_read`, paginated, truncated

## 12. Quality Guards (anti-berisik & anti-bug)

- **Hysteresis monitor ±5** — tidak re-alert saat hover di ambang
- **isTestUserKey** — user test (verify_/probe) tidak pernah push
- **stripToolCallProse** — prose tool call di-strip SEBELUM post-processor
- **ensureMoodReplyQuality** — telegraphic mood/greeting → empati hangat rotasi harian
- **Reminder honesty** — `reminders_list` dulu, jangan karang status
- **fixAddressComma + TIME REFERENCES prompt** — "udah lewat jam bangunmu", adverb sesuai jam
- **Wake lock + dedup persist** — recap/weekly/wind-down tidak dobel setelah restart
- **Heartbeat wiring** — `checkMonitorsAndAlert` sekarang benar-benar dipanggil (bug laten fixed)

## 13. Security (Fase 5 + SafeExec)

- Auth PIN/Bearer, allow-list owner per channel, TOOLS_DENY, SafeExec (CRITICAL/HIGH pending + audit), audit log, rate limit, sandbox exec, backup otomatis, app log per-day
