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
- **CUA Native GUI** — `cua.ts` daemon `cua-driver serve` + 10 tools: `cua_doctor`/`cua_list_apps`/`cua_window_state` (read, snapshot WAJIB), `cua_launch`/`cua_click`/`cua_type` (write, AX vs px), `cua_start_session`+`cua_browser_state`/`cua_browser_click`/`cua_browser_type` (typed Chromium per `BROWSER.md`)
- **Self-improving** — `.learnings/` (LRN/ERR/FEAT, Pattern-Key dedup, Recurrence-Count), hooks `bootstrap` + `sweep`, Mia tools `learnings_search`/`learnings_review`, promote `Recurrence>=3` → `AGENTS.md`/`SOUL.md`/`TOOLS.md`

## 11. Health & CUA Fix

- **Health Tracker** — `health` per-user `health.json` (water/sleep, atomic `tmp→rename`, cap 500), `minum 2 gelas`/`mau tidur`/`bangun`/`statistik` → `Tercatat …` + `Hari ini: X gelas`
- **Clawic Memory** — `memory` durable kategoris di `.memory/` (INDEX capped, Keywords/Facts dated+sourced, History, one fact one home, write before reply) — `ingat ini: Alice pindah` → `people/alice-smith.md`
- **CUA Reminder Fix** — `reminderMessage.ts` BODIES `["{text}","Beb, {text}"]` + TAILS `["","Semangat"]` + `· pukul HH:MM` (was double `aku ingetin lagi` + `jangan lupa`)

## 12. Email (Gmail, read-only)

- **OAuth** — per-user `gmail.json`, auto-refresh, consent screen
- **Tools** — `gmail_link`/`gmail_list`/`gmail_search`/`gmail_read`, paginated, truncated

## 13. Quality Guards (anti-berisik & anti-bug)

- **Hysteresis monitor ±5** — tidak re-alert saat hover di ambang
- **isTestUserKey** — user test (verify_/probe) tidak pernah push
- **stripToolCallProse** — prose tool call di-strip SEBELUM post-processor
- **ensureMoodReplyQuality** — telegraphic mood/greeting → empati hangat rotasi harian
- **Reminder honesty** — `reminders_list` dulu, jangan karang status; listener radio-ACK: slot tanpa kanal yang menerima (laptop off) tercatat `missedAt`+`delivered:false` (tidak dibakar) → Mia akui "kelewat"; replay yang telat (`deliveredAt − lastFiredAt` >30m) → "kesampaian TELAT … pas device off" (2026-09-14)
- **fixAddressComma + TIME REFERENCES prompt** — "udah lewat jam bangunmu", adverb sesuai jam
- **Wake lock + dedup persist** — recap/weekly/wind-down tidak dobel setelah restart
- **Heartbeat wiring** — `checkMonitorsAndAlert` sekarang benar-benar dipanggil (bug laten fixed)

## 14. Security (Fase 5 + SafeExec)

- Auth PIN/Bearer, allow-list owner per channel, TOOLS_DENY, SafeExec (CRITICAL/HIGH pending + audit), audit log, rate limit, sandbox exec, backup otomatis, app log per-day

## 15. Knowledge — ByteRover (2026-09-13, maksimal mandiri)

- **CLI** `byterover-cli@3.16.1` `node_modules/.bin/brv`, storage `.brv/context-tree` (VC git terpisah, bukan `~/.openclaw`), provider `9router ngoding` (`openai-compatible localhost:20128/v1` weekly-unlimited)
- **Lib** `byterover.ts` — `brvBin` local-first, `execBrv` 8–60s, `12k` cap, sandbox `resolveInSandbox`, dash-guard, `verifySwarm`
- **Tools 16** — `brv_query` (LLM synthesis), `brv_search` (BM25 1–50, scope, json), `brv_curate` (write, 5 file), `brv_status/vc_status/vc_log/locations/review`, `brv_swarm_query/status/curate`, `brv_review_approve/reject`, `brv_curate_view/query_log_view/summary` — `swarm 2/2` (`byterover`+`local_markdown` persona+memory) RRF, auto-curate hook `autoMemory → brvCurate + approve + vc commit`
- **Seed** 19 commits (persona, core arch, reminders, codebase, health, habits, mood, cua, browser, device, spotify, tasks, plans, winddown, safeExec, dailyMemory, demo) — `brv_search` 85–95% hit

## 16. Summarize Pro + Humanizer (2026-09-13, maksimal mandiri)

- **Summarize Pro** `summarizePro.ts` — 20 fitur `quick/tldr/bullets/eli5/takeaways/action_items/executive/meeting/email/thread/chapter/progressive` + smart + language + length + template — lokal `.data/summarize-pro/` (100 history, stats/gamification `Word Warrior`), deterministik + `9router` fallback, `30k` cap, `compare` short bug fixed
- **Tools 6** — `summarize` (15 format), `summarize_history/saved/stats/template/default` — bridge `summarize → brv_curate`
- **Humanizer** `humanizer.ts` — 24 Wikipedia patterns + soul (uniform/no I/no mixed) — `Additional→Also`, `—`→`,`, `**bold**` strip, inject `I keep thinking…` — `.data/humanizer/` 100 cap, `9router` polish, tools `humanize/history/stats`
- **Browser-use** `browserUse.ts` — `browser-use 0.13.10` daemon `~50ms` (`new_tab/state/click_at_xy/input/js`), `14` tools `doctor/open/state/click/input/type/keys/screenshot/get/eval/scroll/tab/wait/close` — SSRF/dash guard, fallback ke Playwright `browser_open` kalau RD off

## 17. FreeRide — Free Model Fallback (2026-09-13, maksimal mandiri)

- **Lib** `freeride.ts` — fetch `openrouter.ai/api/v1/models` free `pricing 0`, ranking `qwen/nemotron/deepseek/context_length`, cache 6h `.data/freeride/cache.json`, config `.data/freeride/config.json` `primary + 5 fallbacks` (`openrouter/free` first), atomic, `15s` timeout
- **Agent** — `runAgent` loop `freerideChain` on `429/rate_limit/quota` (`300ms` backoff, warn), `freerideGetConfig` — `9router` tetap weekly-unlimited, OpenRouter key dari `.env.local` (`sk-or-v1-...`)
- **Watcher** `freerideWatcher.ts` — `30s warmup + 60s` `freerideWatcherOnce` probe `openrouter` `8s`, auto `rotate` — wired `instrumentation-node.ts` bareng `heartbeat`
- **Tools 7** — `freeride_status/list` (read), `freeride_auto/switch/refresh/rotate/watcher` (write/read) — total `199` tools, no collision

## 18. Auto-Update Mia (2026-09-14, mandiri daily self-update)

- **Lib** `autoUpdater.ts` — siklus penuh: cek worktree dirty → `git pull --ff-only` → `npm install` → gates `typecheck`+`test`(+`verify`) → push ringkasan `pushToOwner` (Telegram+Discord) → restart server otomatis. State atomic `.data/auto-updater/state.json` (riwayat cap 10, lock anti-double-run, dedup sekali/hari via `lastRunDate` Asia/Jakarta). Mandiri total, nol `.openclaw`/Clawdbot.
- **Scheduler** `startAutoUpdater()` — wired `instrumentation-node.ts` bareng `heartbeat`/`freerideWatcher`; cek tiap `AUTO_UPDATE_TICK_MIN` (5m) + sekali 90s setelah boot (bisa remediate kalau server mulai lewat jam window). Restart tertunda 8s via detached `bash` (definisi path konstan, aman; skip di test/verify).
- **Tools 2** — `auto_update_status` (read, auto — jadwal + last run + hasil gates + riwayat), `auto_update` (write, confirm — "update mia dong" → jalankan sekarang). Confirm-split & tool list prompt disinkron di `agent.ts` (semua channel lewat `buildSystemPrompt` tunggal).
- **Knobs env** (`.env.example`) — `AUTO_UPDATE_ENABLED/HOUR(4)/GRACE_MIN(120)/TICK_MIN(5)/REMOTE(origin)/BRANCH(main)/NPM(1)/VERIFY(1)/RESTART(1)/DELIVER(1)/TIMEOUT_MS(600000)`. Gate merah → update ditolak + saran `git reset --hard <before>`; worktree kotor → di-skip aman.

## 19. Cybersecurity / Ethical-Hacker (2026-09-14, mandiri, LEGAL/authorized)

- **Lib** `security.ts` — postur macOS (`security_scan`), secret scan redacted (`secret_scan`), HIBP k-anonymity (`breach_check`), TLS (`tls_check`/`tlsExpiryDays`), web/domain audit (`web_audit`/`domain_audit`), dependency CVE via **OSV** (`dep_audit` + fixed-version, `verify_patch`), findings store (`finding_*`), **CVSS v3.1** (`cvss_score`), hardening plan, PDF render (Playwright), `sqlmap_scan`/`zap_scan`, lab lifecycle (`lab_status/start/fetch`), `pentest_resources`.
- **Scope/guard** — `targetAllowed()` = lab/RFC1918/`PENTEST_LAB_TARGETS`/**Engagement aktif**/2 host publik yang mengizinkan; publik lain **DITOLAK**. `engagement.ts` = otorisasi klien (client/authorization/scope/window/out-of-scope) + tools `engagement_create/list/close`.
- **Monitoring** `securityWatch.ts` (heartbeat) — alert **port listening baru**, **sertifikat hampir kedaluwarsa** (`SECURITY_CERT_DOMAINS/_DAYS`), **engagement berakhir <24 jam**.
- **Lab latihan no-Docker** `labs/pentest/vuln-node/server.js` — SQLi, Reflected/Stored XSS, IDOR, Open redirect, Path traversal, SSRF, JWT alg=none, CSRF, Broken access control, Default creds, Exposed backup (cmd-injection opt-in `VULN_ALLOW_CMDI=1`). Docker lab opsional (`docker-compose.yml`: Juice Shop/DVWA/WebGoat/bWAPP).
- **Findings & report** — `finding_add/list/resolve/export` (CSV/JSON/**SARIF**), `hardening_plan`/`hardening_pdf`, `report_generate/save/pdf` (header engagement + klien + izin + scope), urut **CVSS** + rata-rata.
- **Recon suite (2026-09-15, keyless)** — `recon.ts`: `recon_subdomains` (CT crt.sh + hackertarget fallback), `recon_params` (arsip publik OTX/urlscan/Wayback, tandai param menarik), `recon_takeover` (kandidat CNAME takeover), `recon_httpx` (probe host hidup aktif, scope-gated), `recon_list` (cache per-user `.data/users/<user>/recon.json`).
- **White-box & playbooks (2026-09-15, adaptasi Strix Apache-2.0)** — `sast_scan` (semgrep `p/default`+`p/secrets` di sandbox) + `security_playbook` (78 pack di 11 kategori: analysis/custom/frameworks/protocols/reconnaissance/technologies/tooling/vulnerabilities/cloud + methodology & scan_modes — mis. counterevidence/severity-calibration/fix-verification, 28 kelas vuln (idor/ssrf/xss/sqli/ssti/xxe/race/…), tooling nmap/nuclei/ffuf/sqlmap/katana/naabu, oauth/graphql, aws/azure/gcp/kubernetes, nextjs/django/fastapi/nestjs, **workflow** application-security-testing / owasp-top-10-testing (2025) / api-security-testing (2023) / whitebox-code-review / fix-and-verify / source-aware-whitebox / scan-modes). Ditambah **browser-transport-tampering** (tamper lewat transport app saat WAF memblokir replay) + **idor-triage** (triage IDOR 2-akun, pisahkan kontrol nyata dari false positive) + tool **tamper_script** (generator skrip Console patch fetch/XHR). Prompt mewajibkan pass **counterevidence → severity-calibration → fix-verification** sebelum `finding_add`/`report`.
- **Audit hardening (2026-09-15)** — cakupan subdomain env `PENTEST_LAB_TARGETS`, `netGuard.assertPublicUrl` bersama (IPv6/metadata), ID temuan anti-tabrakan, `engagement_create` write/confirm, `web_audit` anti-SSRF, metadata endpoint diblok, suite pentest masuk `CORE_TOOL_NAMES` (Groq).
- **Bug-bounty toolkit (2026-09-15)** — `oast_create/poll/stop` (OOB/blind via webhook.site), `http_session` + `http_request session/save_session` (auth), `bola_diff` (BOLA/IDOR dua identitas A/B), `content_discover` (robots/sitemap/JS/path), `param_fuzz` (XSS/SQLi/SSTI/redirect/cmdi per-param), `jwt_attack` (forge/crack), `evidence_capture` (screenshot + raw HTTP), `scope_import` (parse Targets→engagement), `crawl`, `param_discover`, `recon_diff` (aset baru), `recon_screenshot` (visual recon), `js_mine` (endpoint+secret JS), `api_spec`/`graphql_probe`, `request_save`/`request_run`, `platform_severity` (H1/VRT), `cve_intel`, `recon_dnsbrute`, `recon_ports`, `bucket_enum`, `submission_track`, `cors_audit`, `csp_audit`, `http_history`, `race`, `ws_probe`, `browser_eval` (Playwright), DNS-OAST (`oast_dns_create/poll/stop`, interactsh). `recon_subdomains` multi-sumber (crt.sh+certspotter); **scope-watch** heartbeat (`SECURITY_SCOPE_WATCH`) push aset baru. Biner terpasang: searchsploit, semgrep, trivy, gobuster, katana, interactsh-client. RoE-aware: manual + rate-limit default.
- **`security_hunt` (2026-09-15)** — orkestrasi otonom: satu perintah menjalankan header/cookie+CSP+CORS+content discovery+crawl+JS mining (+param discovery `deep=true`) lalu merangkum **LEADS**. Scope-gated + bounded.
- **Cheat-sheet** — `SECURITY.md`. **Total tools 255.**
