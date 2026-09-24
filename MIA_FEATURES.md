# Mia — Fitur Lengkap (2026-09-21)

Semua fitur yang sudah berjalan di production. Update: Vision, habit tracker, wind-down, email inbox, learn-from-correction, Security Copilot penuh (Superpower Suite, Exploit Chain, Tier-1 Attack Suite, workflow fuzz, JS deobfuscation, prompt-injection hunt), honesty/delivery guards.

---

## 1. Channels

- **Web** — chat text + voice (mic, STT/TTS), vision upload 📎, multi-session, auth PIN
- **Telegram** — text, voice note, foto, inline confirm, typing indicator
- **Discord** — text, voice note, foto, slash commands, inline confirm, typing indicator
- **PWA Eyes** — HP Android sebagai wajah Mia: mata reaktif (LISTENING/PROCESSING/SPEAKING), TTS dari speaker HP, wake lock — `apps/web/src/app/eyes`
- **Webhook** — `POST /api/webhook` (external trigger automation)

## 2. Otak & Provider

- **OpenCode Go (GLM 5.2)** — full-window brain (semua 324 tool); default pindah ke **9router** sejak 2026-09-21 (kuota Go bulanan habis, reset ~15 hari — lihat §21); auto-switch ke `deepseek-v4-flash-vision-exp` saat ada gambar
- **Multi-provider** — Groq / opencode local / 9router / openrouter / mock, selectable per channel
- **Spotify sleep timer** — `spotify_sleep_timer`: `after_track=true` (matikan setelah lagu ini selesai) / `minutes=N` / `cancel=true`; timer in-process (hilang saat restart) + push ⏹️ saat dieksekusi
- **Persona facts**: kunci kanonik + resolusi konflik (nilai terbaru menang, riwayat di `## Superseded` yang TIDAK di-inject ke prompt) + **rahasia/token ditolak** + cap 80 fakta; tool `persona_show` / `persona_set` (`ingat ini: …`) / `persona_forget` (`lupakan …`)
- **Voice**: STT Whisper (Groq/9router), TTS Orpheus (Groq) + ElevenLabs siap (`TTS_PROVIDER=elevenlabs`) · **TTS Bahasa Indonesia asli** secara lokal di macOS (`say -v Damayanti` → WAV, `ttsLocal.ts`; `TTS_LOCAL_ID=0` untuk mematikan) — otomatis dipakai saat teks terdeteksi Indonesia
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
- **Agent** — `runAgent` loop `freerideChain` on `isProviderRetryable` (429 + upstream 5xx + model pensiun/404) (`300ms` backoff, warn), `parseStreamError` menangkap error in-band (`200 + {"error":…}` / frame `data: {"error":…}`), failover hanya bila attempt itu belum menjalankan tool (`chainMayFailover`) dan belum lewat `30s` (`CHAIN_DEADLINE_MS`) — `9router` tetap weekly-unlimited, OpenRouter key dari `.env.local` (`sk-or-v1-...`)
- **Watcher** `freerideWatcher.ts` — `30s warmup + 60s` tick, tapi probe asli di-throttle `1×/jam` (`shouldProbeNow`) karena probe memakai kuota free-model yang sama dengan turn nyata; `freerideWatcherOnce` memprobe id apa adanya via `probeOpenRouterModel` + `isProbeAliveResponse` (200 + `error` = mati), auto `rotate` — wired `instrumentation-node.ts` bareng `heartbeat`
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
- **Otonomi lab + ATO prover (2026-09-17)** — (A) `policy_set` sekarang berlaku untuk **lab milik owner** (bukan cuma engagement): tool read/write yang terdaftar jalan tanpa konfirmasi berulang HANYA bila semua URL `isOwnLabTarget` (localhost/RFC1918/`PENTEST_LAB_TARGETS`; host demo publik & host engagement tetap manual). Live: 9 tool auto → probe lab tanpa prompt; `policy_set action=reset` untuk mematikan. (B) tool **`ato_prove`**: login dengan kredensial bocor → simpan sesi → buka halaman terlindungi, dengan verdict jujur (TERBUKTI / TANPA SESI / TIDAK MEMBUKA / DITOLAK) dan password selalu dimask. Total tool 277.
- **Pentest hardening (2026-09-17)** — (1) `zap_scan` sekarang jujur & cepat saat Docker tak ada (langsung menyebut padanan native `web_audit`/`security_hunt`/`pentest_scan tool=nuclei`/`cors_audit`/`csp_audit`, bukan gagal setelah timeout); (2) `pentest_scan tool=whatweb` **fallback ke fingerprint native** (`techFingerprint.ts` `detectTech`, dipakai bersama `tech_watch` — satu definisi, `fatal: whatweb` tak lagi jalan buntu); (3) **CVSS v4.0** didukung penuh tanpa dependency: `cvssV4.ts` (MacroVector + severity-distance, data standar di `cvssV4Data.ts`) diverifikasi **0 mismatch vs implementasi referensi pada 3000 vektor acak**, dipakai `cvss_score` (v3.1 & v4.0 lewat `cvssScoreAny`) dan `platform_severity`; (4) 4 playbook orisinal baru: `web-cache-poisoning` (poisoning + deception), `websocket-security` (CSWSH, authz per-pesan), `account-takeover` (reset/OTP/email-change/session), `host-header-injection` (reset-link & cache poisoning, routing bypass). Total playbook 82 (kategori; `security-playbooks/README.md` bukan pack).
- **White-box & playbooks (2026-09-15, adaptasi Strix Apache-2.0)** — `sast_scan` (semgrep `p/default`+`p/secrets` di sandbox) + `security_playbook` (78 pack di 11 kategori: analysis/custom/frameworks/protocols/reconnaissance/technologies/tooling/vulnerabilities/cloud + methodology & scan_modes — mis. counterevidence/severity-calibration/fix-verification, 28 kelas vuln (idor/ssrf/xss/sqli/ssti/xxe/race/…), tooling nmap/nuclei/ffuf/sqlmap/katana/naabu, oauth/graphql, aws/azure/gcp/kubernetes, nextjs/django/fastapi/nestjs, **workflow** application-security-testing / owasp-top-10-testing (2025) / api-security-testing (2023) / whitebox-code-review / fix-and-verify / source-aware-whitebox / scan-modes). Ditambah **browser-transport-tampering** (tamper lewat transport app saat WAF memblokir replay) + **idor-triage** (triage IDOR 2-akun, pisahkan kontrol nyata dari false positive) + tool **tamper_script** (generator skrip Console patch fetch/XHR). Prompt mewajibkan pass **counterevidence → severity-calibration → fix-verification** sebelum `finding_add`/`report`.
- **Audit hardening (2026-09-15)** — cakupan subdomain env `PENTEST_LAB_TARGETS`, `netGuard.assertPublicUrl` bersama (IPv6/metadata), ID temuan anti-tabrakan, `engagement_create` write/confirm, `web_audit` anti-SSRF, metadata endpoint diblok, suite pentest masuk `CORE_TOOL_NAMES` (Groq).
- **Bug-bounty toolkit (2026-09-15)** — `oast_create/poll/stop` (OOB/blind via webhook.site), `http_session` + `http_request session/save_session` (auth), `bola_diff` (BOLA/IDOR dua identitas A/B), `content_discover` (robots/sitemap/JS/path), `param_fuzz` (XSS/SQLi/SSTI/redirect/cmdi per-param), `jwt_attack` (forge/crack), `evidence_capture` (screenshot + raw HTTP), `scope_import` (parse Targets→engagement), `crawl`, `param_discover`, `recon_diff` (aset baru), `recon_screenshot` (visual recon), `js_mine` (endpoint+secret JS), `api_spec`/`graphql_probe`, `request_save`/`request_run`, `platform_severity` (H1/VRT), `cve_intel`, `recon_dnsbrute`, `recon_ports`, `bucket_enum`, `submission_track`, `cors_audit`, `csp_audit`, `http_history`, `race`, `ws_probe`, `browser_eval` (Playwright), DNS-OAST (`oast_dns_create/poll/stop`, interactsh). `recon_subdomains` multi-sumber (crt.sh+certspotter); **scope-watch** heartbeat (`SECURITY_SCOPE_WATCH`) push aset baru. Biner terpasang: searchsploit, semgrep, trivy, gobuster, katana, interactsh-client. RoE-aware: manual + rate-limit default.
- **`security_hunt` (2026-09-15)** — orkestrasi otonom: satu perintah menjalankan header/cookie+CSP+CORS+content discovery+crawl+JS mining (+param discovery `deep=true`) lalu merangkum **LEADS**. Scope-gated + bounded.
- **Cheat-sheet** — `SECURITY.md`. **Total tools 324.**

---

## 20. Superpower Suite (2026-09-20)

Lima modul pentest "superpower" yang saling menguatkan, terintegrasi ke `bounty_run` untuk alur one-command penuh:

### 20.1 `targetBrain` — Persistent Target Brain
- **Store:** `.data/users/<user>/target-brain.json` (atomic, cap 40 target × 120 endpoint)
- **Auto-write hooks:** `content_discover` + `js_mine` → `brainRecordEndpoints`, `tech_watch` → `brainRecordTech`, `finding_add` → `brainRecordProof`
- **Tool:** `target_brain` (read/auto) — action `brief` (WAJIB sebelum hunt ulang: TERBUKTI + endpoints + safeTested + catatan), `list`, `forget`, `note`

### 20.2 `retest` — Regression Retest Suite
- **Store:** `.data/users/<user>/retest.json` (cap 120, lastRunAt+lastVerdict per case)
- **Auto-create:** `finding_add` dg arg `retest_url`+`retest_expect`+`retest_status` → case otomatis (`♻️ Retest case otomatis: R-…`)
- **Tools:** `retest_list` (read), `retest_add` (write, confirm), `retest_run` (write, confirm) — verdict 🔴 MASIH RENTAN / 🟢 sudah dipatch / ⚪ error; scope-gated per case URL

### 20.3 `authMatrix` — Role/Permission Matrix (N-role)
- `auth_matrix endpoints=<list> sessions=<admin,user,guest>` (+ anonymous otomatis) → max 6×6 request
- Output: matriks status/len per sel + temuan `anonymous-access` & `cross-role` (±5% len, status sama)
- Fail-fast missing session; scope-gated per URL

### 20.4 `domTaint` — DOM XSS Taint Analysis (statik)
- Trace SOURCE (`location.*`, `postMessage`, `document.referrer`) → SINK (`innerHTML`, `eval`, `Function`, `document.write`, `insertAdjacentHTML`, jQuery `.html()`, `setAttribute on*`)
- Sanitizer check (window ≤15 baris): `encodeURIComponent`, `DOMPurify`, `textContent`, `escapeHtml`
- Input: `url` (scope-gated; HTML → ≤8 script same-origin) atau `text` (bundle dari `js_mine`)
- Output: `file:line sink ← source via var` + snippet; **statik — WAJIB verifikasi manual sebelum finding_add**

### 20.5 `learning` — Belajar dari Report Disclosed
- `learning_ingest text=…|url=…` → pattern terstruktur (`vulnClass` 18 kelas, `tech`, `endpointStyle`, `trick`, `detection`) → store `.data/users/<user>/learnings-security.json` (cap 200, dedup class+title)
- `learning_query query=<tech> vuln_class=<kelas>` → hint "target seperti ini biasanya kena X via Y" SEBELUM hunt (score = overlap token + boost class match)
- `learnClassify`: jwt di-utamakan di atas auth-bypass; `learnTech` dukungan "nextjs"/"next.js"; dedup unik

---

### Integrasi ke Bounty Run
`bounty_run auto_chain=true auto_evidence=true max_chains=5`:
1. `engagement_create` → `program_score` → worklist ROI
2. `campaign_run` → `suite_hunt` per host (deep=true default)
3. **Auto exploit_chain** per lead high-signal (heuristic: IDOR→bola_diff, auth_bypass→JWT, SSRF→OAST, session_fixation)
4. **Auto browser evidence** (snapshot)
5. `poc_verify` → `finding_add` (draft, high/medium only, +dup_check)
6. `generateReport` + **`reportPdf` otomatis** (scoped ke target) → `📎 <path>`
7. Handoff list → push ke channel

### Gates & Live Test
- **Gates:** typecheck ✅ · lint 0 error · vitest 104/104 ✅ · verify.ts `superpowers OK` `exploit-chain OK` ✅
- **Live test (Discord, Netlify Lab):** 7 findings (2 Critical: SQLi + no-auth admin-data; 3 High: BOLA, header spoof, IDOR PII; 2 Medium: Stored XSS, missing headers) + **PDF scoped ke target** (`report-2026-09-19T17-19-40-437Z.pdf` 157KB)

---

### Files Changed:
- `apps/web/src/lib/targetBrain.ts` (baru) — persistent per-target KB
- `apps/web/src/lib/retest.ts` (baru) — regression suite
- `apps/web/src/lib/authMatrix.ts` (baru) — N-role matrix
- `apps/web/src/lib/domTaint.ts` (baru) — DOM XSS taint
- `apps/web/src/lib/learning.ts` (baru) — disclosed report patterns
- `apps/web/src/lib/bounty.ts` — +3 param (`auto_chain`, `auto_evidence`, `max_chains`) + auto_chain + auto_evidence + `reportPdf`
- `apps/web/src/lib/campaign.ts` — `deep: true` default
- `apps/web/src/lib/tools.ts` — 8 tool def + bounty_run param
- `apps/web/src/lib/agent.ts` — `exploit_chain` ke `HEADLESS_SIDE_EFFECT_TOOLS`
- `apps/web/verify.ts` — assertions updated
- `AGENTS.md` — updated

**Total tools: 324** · **CORE 128** (jendela Groq; 9router membawa 64 chain analisis) · **85 playbook** · **vitest 595**

---

## 21. Security Copilot — lanjutan (2026-09-19 → 2026-09-23)

Semua menambang di atas §19/§20; total naik ke **309 tool** (2026-09-23), CORE tetap **128**, playbook **84**, vitest **395**.

### 21.1 Exploit Chain Builder (2026-09-19)
- **`exploit_chain`** (write/confirm, CORE, scope-gated) — satu konfirmasi untuk rantai serangan umum; `chain="auto"` memilih + menjalankan ≤5 chain dari intel brain + sesi (ranking jujur, skip beralasan); support **batch koma-terpisah** (`chain="idor,ssrf,race"` → semua dijalankan berurutan, token tak dikenal ditandai `⛔ TIDAK DIJALANKAN` jujur). Chain: `idor` (bola_diff A/B → BOLA/IDOR), `auth_bypass` (JWT alg:none/tamper), `ssrf` (param → OAST), `session_fixation` (login pre/post → session id), + wrapper Tier-1 (`race`, `graphql`, `xxe`, `open_redirect`, `cache_poison`) = **9 chain**.
- Guard narasi `chainRunClaimSuffix`: reply yang mengklaim sukses padahal output `exploit_chain` menunjukkan 0 chain jalan → catatan jujur ditambahkan.

### 21.2 Tier-1 Attack Suite (2026-09-20, 8 tool aktif)
- **`race_attack`** (PRO `race`): N paralel ≤30 + NONCE unik per request → bukti duplicate-creation; `raceClassify` pure-tested.
- **`graphql_hunt`** (PRO `graphql_probe`): introspection → field-suggestion mining → alias ganda → JSON-array batching → depth probe; batch+depth KANDIDAT (tidak di-exploit, bukan DoS).
- **`cache_poison_prover`**: matriks header host (X-Forwarded-Host/X-Host/X-Original-URL/X-Rewrite-URL/X-Forwarded-Scheme/Port) + fat-GET via POST+`X-HTTP-Method-Override` + param refleksi; `cacheProbeSignals` (x-cache/age/cf-cache-status) → pantulan+cacheable = STRONG.
- **`xxe_chain`**: auto-OAST → 4 payload (file-read `/etc/passwd` inline, OOB entity, param-entity, PHP filter); `xxeSignals` passwd-leak TERBACA/parser aktif.
- **`open_redirect_chain`**: 19 param × bypass, ≤40 request, break per param; `redirectVerdict` host-based (echo query-string ≠ redirect).
- **`ws_hunt`** (PRO `ws_probe`): handshake RAW node:http (tanpa Origin / Origin evil / Origin target) → `cswshVerdict` (evil 101 + control 101 = Origin tidak divalidasi); opsi `tab` via CDP (cookie asli di browser, secret tak pernah ke LLM).
- **`github_osint`** (read/auto, OSINT publik): grep.app code dorks per domain + GitHub commit-history secret scan (key sudah rotate tapi masih di history); nilai rahasia SELALU disensur.
- **`har_import`** (read/auto): tempel HAR DevTools → dedup ×N, param union, cookie ∪ Set-Cookie, Authorization (nilai dimask) → `save_session=<nama>` siap pakai `bola_diff`/`auth_matrix`/`http_request`.
- CORE: `race_attack`/`graphql_hunt`/`github_osint`/`har_import` DI DALAM chain analisis (ikut jendela 9router-64); `cache_poison_prover`/`xxe_chain`/`open_redirect_chain`/`ws_hunt` ekor CORE (Groq 128 / opencodego penuh).

### 21.3 Business-logic fuzz (2026-09-20)
- **`workflow_fuzz`** (write/confirm, CORE) — fuzzer state-transition di atas primitif flow: happy-path flow ≥2 langkah (login→cart→checkout→refund), mutasi **skip/repeat/reorder/value** (qty -1/0/99999, amount negatif, currency XXX, coupon reuse), bounded ≤14; `classifyMutation` pure-tested (double-processing/missing-state-validation/info/ditolak); sinyal → `poc_verify` → `finding_add` (CWE-840/841).

### 21.4 Recon sadar-obfuscasi (2026-09-21)
- **`js_deobfuscate`** (read/auto, scope-gated) — eval-free deobfuscation: string-array webpack/obfuscator.io (Pass A/B/C), concat multi-baris terlipat (foldConcats 8 pass), **source-map restore** (`sourcesContent` dari inline/`.map` dengan atribusi file); bounded (≤900KB, ≤8 pass, array ≤2000, map sources ≤120). CORE samping `js_mine`; prompt JS RECON: js_mine sedikit endpoint dari bundle besar/minified → WAJIB `js_deobfuscate` sesudah.

### 21.5 LLM prompt-injection hunt (2026-09-21)
- **`prompt_injection_hunt`** (write/confirm, CORE) — probe LLM/agent endpoint terhadap prompt injection (delimiter confusion, indirect injection, role override) dengan payload terukur; sinyal jujur → bukan klaim eksploit.

### 21.6 LLM red-team + MCP audit (2026-09-22)

- **`llm_hunt`** (write/confirm, CORE — melengkapi `prompt_injection_hunt`): probe endpoint LLM/agent dengan **5 kelas DEEP red-team**, auto-petakan ke **OWASP LLM Top 10 2025**:
  - **jailbreak** → LLM01: DAN/UnGPT/VOID/role-pivot ("ignore all instructions"); sinyal = marker game-on direspons ATAU refusal hilang vs baseline.
  - **rag** → LLM01+04+08: injeksi INDIRECT via "retrieved context" (konten retrieval dipercaya tapi tidak tepercaya); sinyal = token `RAG_OBEY_<canary>` ditaati (**STRONG deterministik**).
  - **agency** → LLM06+11: model diminta aksi kuat (send_email/delete_user/transfer_funds/exec) tanpa konfirmasi; sinyal = marker approval di-echo ATAU tool-call JSON menamai tool kuat.
  - **exfil** → LLM02+05: CANARY (fake secret) disemai di prompt; sinyal = canary muncul di respons (**STRONG**) ATAU beacon OAST (`callback` → `oast_poll`).
  - **pii** → LLM02: seed NIK/email/phone; sinyal = nilai seed di-echo (**STRONG**).
  - Semua **baseline-controlled** (marker yang sudah ada di respons benign = bukan sinyal), **trivial-echo suppressed** (`trivialEcho`), bounded ≤40 request (concurrency 4), GET (param) / POST (`body_field`), seed deterministik `llmCanaryFromSeed`.
- **`mcp_hunt`** (write/confirm, CORE): audit **server Model Context Protocol** (JSON-RPC 2.0 HTTP / SSE legacy) = **surface SUPPLY-CHAIN** (tool output & resource content dikonsumsi LLM):
  1. `initialize` (2025-06-18) di kandidat (`mcpCandidates`: root, `/mcp`, `/sse`), fallback SSE legacy;
  2. `tools/list`+`resources/list`+`prompts/list` — sinyal **anon-access** saat tanpa session/auth;
  3. **sensitive-tool exposure** (`mcpSensitiveTool`: exec/shell/delete/transfer/admin/secret…) — HANYA dilist, tak pernah dipanggil;
  4. **arg injection** ≤2 tool NON-sensitif berparameter string — marker echo = input→output tanpa sanitasi (hasil akan dikonsumsi LLM), callback OAST opsional;
  5. **resource scan** ≤2 teks — `scanTextSecrets` (nilai REDACTED) + `mcpInstrSignals` (ignore-previous/system_reminder/<system>) → LLM01/08/11 via konten resource.
  - Sinyal → `poc_verify` → `finding_add` (OWASP LLM01/02/03/04/05/06/08/11). File: `llmHunt.ts`/`mcpHunt.ts` (helper pure + 47 tes).
- **CORE rebalance in-place** (agent.ts posisi #44/#45): `security_scan`/`secret_scan` demote → `llm_hunt`/`mcp_hunt` — jendela 9router-64 & CORE 128 tidak bergeser; keduanya masuk `HEADLESS_SIDE_EFFECT_TOOLS` + `PERSONAL_LIST_TOOLS` + SYSTEM_PROMPT (blok DEEP LLM red-team + mcp_hunt).

### 21.7 Honesty & delivery guards (2026-09-21)
- **Delivery guard** (agent.ts choke point): tool yang TIDAK ada di jendela provider (`toolsForUrl`) dijawab placeholder jujur "not available on this provider (tool budget)" + daftar pengganti; `toolCalls2` di-reassign ke subset ter-delivery → mustahil eksekusi di luar janji delivery. **TOOL BUDGET hint**: prompt menyisipkan daftar tool tak ter-delivery (khusus provider capped) + mandat "langsung kerjakan dengan tool yang tersedia" + **PENGECUALIAN PDF** (user minta PDF → sistem buat otomatis via `tryDeliverReportPdf`, dilarang bilang "tidak aktif").
- **`toolRunClaimSuffix`** (honesty guard klaim eksekusi): reply yang mengklaim tool jalan tanpa bukti deklarasi `tool_calls` / hasil placeholder (`Not selected`/`Not executed`/`Auto-declined`) → catatan jujur ditambahkan (cap 3 tool); `TOOL_CLAIM_EXEMPT` = tool deterministik (remind_me, plan_create, monitor_add, spotify_*, report_*, mood_log). 11 unit lock.
- **`pdfDeliverableSuffix`** diperluas (fabrikasi murni: kutip `report-*.pdf` tanpa tool report → note "tidak ada file PDF-nya").
- **`metaProse.ts`**: deteksi prosa stage-direction ("Beri tahu Mas Naufal …") → koreksi hangat deterministik; hint: bicara LANGSUNG, PDF bukan pengganti pengujian.
- **CORE invariant runtime**: verify.ts mengunci CORE=128 unik ter-resolve + jendela 9router-64 membawa chain analisis (workflow_fuzz/race_attack/graphql_hunt/prompt_injection_hunt/http_request/poc_verify/finding_add) — silent-shrink tidak bisa lolos gates lagi.

### 21.8 Chain composer + exploit artifact + session wizard (2026-09-22 → 2026-09-23)
- **`vuln_compose`** (write/confirm, CORE) — komposer chain lintas-kelas: ≥2 temuan PROVEN satu host → relasi output-A → input-B deterministik (endpoint/param/token/object-id) → replay tiap hop via `pocVerify` → verdict TERBUKTI PENUH (temuan komposit critical) / PUTUS DI HOP n / TAK TERSAMBUNG.
- **`exploit_build`** (write/confirm, CORE) — artefak exploit standalone NYATA di disk (node/python/curl: nonce di-seed, replay 3× + asserts, exit 0=VULNERABLE); "tidak dibuat" bila tak proven/luar scope — tanpa file.
- **`auth_setup`** (write/confirm, CORE slot 80 tukar `tamper_script`) — wizard sesi uji: login ≤4 akun via `atoProve` → `session_a/b` siap untuk `exploit_chain`/`bola_diff`/`auth_matrix`; password masked, scope + headless-guarded.
- **`composeBuildClaimSuffix`** (honesty guard): path artefak fabrikasi / inversi verdict PUTUS-"terbukti"/"tidak dibuat"-"sudah kubuat" → catatan jujur (7 unit lock).
- **Audit post-19-Sep** (2 critical: IDOR per-hop scope + auth_bypass tanpa kontrol; 11 high: secret-evidence, inflasi sinyal→info `ⓘ`, SSRF ingest, digest/digest-default, risk write, confirm re-gate; 12 medium) + round budget dinamis (`PENTEST_MAX_ROUNDS=10` khusus pentest), `sanitizeHttpUrl`, `proofWarning`, link-capture gate `isPentestAsk`, fallback resumable, bounty coverage-note.

### Gates & catatan (2026-09-21 → 2026-09-23)
- **Gates (2026-09-23):** typecheck 0 · lint 0 errors · vitest **395/395** · verify.ts EXIT=0 (blok: audit-fix IDOR scope/auth-control/risk/openrouter/SSRF, auth_setup wizard live, Kohona link-gate + fallback resumable, bounty coverage/wildcard) · restart tmux sehat (health ok, `logged in as`=1, 0×409).
- **Gates (2026-09-22):** typecheck 0 · lint 38 baseline · vitest **291/291** (16 file; +47 `llmHunt`/`mcpHunt`) · verify.ts EXIT=0 (blok live mock LLM leaky + mock MCP server; **tool registry integrity (300 tools)** + CORE invariant 128 + window 9router dikunci) · restart tmux sehat (health ok, `logged in as`=1, 0×409).
- **Gates (2026-09-21):** typecheck 0 · lint 38 baseline · vitest **244/244** · verify.ts EXIT=0 · restart tmux sehat (health ok, 1 instance, 0×409).
- **Brain:** opencodego kuota bulanan HABIS (429, reset ~15 hari) → default `9router` (64-tool, chain analisis penuh). Groq free 413 ITPM (payload 37.9k vs limit 7k) = resi lama; pentest penuh butuh opencodego reset / groq paid / 9router chain-analisis.

### 21.9 CSRF prover (2026-09-23)
- **`csrf_prove`** (write/confirm, CORE slot `domain_audit`): parse form state-changing + field token + posture SameSite → replay aksi TANPA token memakai session → diterima = kandidat (PoC HTML standalone ke evidence, file nyata) / ditolak = terkontrol. Verdict: PROVEN / TOKEN-ENFORCED / NO-FORMS. Scope-gated, bounded (≤8 form × 3 request).

### 21.10 Exposure scanner + mass-assignment prover (2026-09-23)
- **`exposure_hunt`** (write/confirm, CORE slot `oast_stop`): sapu 24 path predictable (`.git/HEAD`, `.env`, backup, VCS metadata, API docs) GET-only pada satu origin — 200+marker = LEAD, 401/403 = info, 404 = diam; nilai secret TIDAK pernah ditampilkan (keys only). Scope-gated, konkurensi 4.
- **`mass_assignment`** (write/confirm, CORE slot `csp_audit`): injeksi 7 field privileged (role/admin/verified/user_id/…) ke POST/PUT/PATCH + diff vs baseline sesi yang sama (echo baru / outcome berubah); opsional `verify_url` konfirmasi persistensi (TERKONFIRMASI PERSISTEN vs refleksi sesaat). Verdict: kandidat/terkontrol/diabaikan. Scope-gated, bounded.
- **`xss_hunt`** (write/confirm, CORE slot `request_save`): marker inert per titik injeksi (param+form) → klasifikasi konteks (html/atribut/script/comment) → 1 breakout confirmer + beacon script-src OAST; refleksi tanpa breakout = kandidat lemah (jujur). Scope-gated, bounded.
- **`upload_fuzz`** (write/confirm, CORE slot `sast_scan`): 8 vektor bypass upload benign (double-ext/.phtml/.php5/case/mime-confusion/polyglot/traversal/SVG, marker inert — tanpa webshell/.htaccess) + GET verifikasi marker utuh; LEAD / UNVERIFIED / REJECTED. Scope-gated.

### 21.11 Tier S/A trio: idor_enum + host_header_hunt + recon_full (2026-09-23)
- **`idor_enum`** (write/confirm, CORE slot `calculate` → 9router-64): enum ID 1..20 dua sesi + kontrol anon (publik = info); guard 30 request/stop-5-hit; output angka dampak ("4/4 ID").
- **`host_header_hunt`** (write/confirm, CORE slot `cors_audit`, groq-only): 8 header × canary + reset-poisoning (link evil di respons); honest per-vektor.
- **`recon_full`** (write/confirm, CORE slot `codebase_search` → 9router-64): pipeline 6 tahap satu konfirmasi (subdomains→httpx→params→tech→exposure→content), bounded + gagal tak menggugurkan; hemat 3-5 round.

### 21.14 bypass403 + otp_probe + proto_pollute (2026-09-23)
- **`bypass403`** (write/confirm, CORE, groq-only): matriks bypass akses-ditolak — baseline DULU (URL harus memang 403/401), lalu trik klasik fetch-sendable (double slash, %2e, /..;/, trailing . dan ;, parent re-entry %2f) + header (X-Original-URL/X-Rewrite-URL, loopback IP, X-Host) + verb override (POST/HEAD/PATCH, X-HTTP-Method-Override) + _method body + Host localhost. Verdict host-based: 2xx + body BEDA dari halaman deny = LEAD; SPA catch-all yang body-nya SAMA TIDAK dihitung; echo path-trik dibuang (CWE-862/863). Bounded 20 attempt. Gotcha: fetch menormalkan dot-segments (/./ dan /../) — varian ekivalen yang benar-benar sampai ke server yang dipakai.
- **`otp_probe`** (write/confirm, CORE, groq-only): OTP/2FA rate-limit & oracle prover — 1 baseline + N kode SALAH (bounded ≤15, BUKAN brute; kode salah deterministik menghindari cache per-value) → no-rate-limit (tanpa 429/423/throttle-copy; 401 = deny normal, BUKAN sinyal throttle) / oracle pesan (invalid vs expired, normalisasi angka) / success-like (2xx beda dari baseline tanpa copy throttle) / entropy code-space dari `samples` kode milik user sendiri (6 digit ≈ 19.9 bit = feasible tanpa rate-limit; 4 digit = LEMAH; duplikat di sample kecil = rotasi lemah). CWE-307/330.
- **`proto_pollute`** (write/confirm, CORE, groq-only): prototype pollution 2 permukaan — SERVER: __proto__/constructor.prototype via query (bracket + dot) + JSON body (body dibangun sebagai STRING literal — JSON.stringify({__proto__:…}) MENGHILANGKAN key karena object literal men-set prototype) → STRONG bila marker muncul di respons, WEAK bila error menyebut __proto__ atau 500 baru; cek PERSISTEN via re-fetch bersih (pollution lintas-request). CLIENT: source (location/postMessage) → sink (JSON.parse/merge/assign) di inline+script src JS halaman (CWE-1321). Bounded 5 payload.
- **Demote CORE 128 (2026-09-23):** `param_discover`/`tech_watch`/`engagement_close` keluar dari CORE (0 referensi backtick di prompt; param_fuzz + pentest_scan menutup perannya) — masih terdaftar penuh di opencodego. CORE tetap 128 unik; jendela Groq membawa 3 tool baru; 9router-64 tetap membawa chain analisis (3 baru groq-only by design); HINT_UNDELIVERED +3.
- **Verify:** matriks pure ×3 (41 tes unit baru), live bypass lead vs same-body catch-all vs echo, otp no-rate-limit/throttle/oracle + entropy, PP STRONG marker, dispatch executeTool. Gotcha ops: verify WAJIB dijalankan dari repo root (`npx tsx apps/web/verify.ts`) — blok legacy menulis store via path relatif; store user verify (verify_vulncompose dkk) yang berisi port server lama membuat replay compose "GAGAL replay" palsu — bersihkan user verify sebelum run.

### 21.13 teamcity_check — deteksi CVE-2026-63077 tanpa exploit (2026-09-23)
- **`teamcity_check`** (read/auto, CORE slot `reschedule_task` — redundan via cancel+add; groq-only): fingerprint versi TeamCity (`/login.html` → marker → `YYYY.M.P`) vs garis patch **2025.11.7 / 2026.1.3** → RENTAN (CVE-2026-63077, CVSS 9.8, CWE-502, CISA KEV) / AMAN / TAK DIKETAHUI / bukan-TeamCity. Version-match = bukti finding_add (tak perlu replay — replay = exploit). Scope-gated, ≤2 fetch. Garis keras repo: rantai RCE full (register agent + HSQLDB SCRIPT → JSP) DITOLAK permanen sebagai tool (weaponisasi CVE yang dieksploitasi aktif).
- **Intel:** playbook `vulnerabilities/teamcity-cve-2026-63077.md` (prosedur manual http_request untuk provider capped + tabel versi + DILARANG) + pola learning owner terkurasi (`learning_query tech=teamcity`). Catatan: ingest URL mentah Rapid7 menghasilkan nav-junk (tech "aws") — pola harus dikurasi manual pasca-ingest.

### 21.12 smuggle_probe + dom_xss_prove (2026-09-23)
- **`smuggle_probe`** (write/confirm, CORE slot `edit_file`, groq-only): HTTP request smuggling CL.TE/TE.CL/TE-obfuscation via RAW socket (fetch tak bisa emit byte CL+TE ambigu) — probe berisi hidden request canary utuh + victim request; canary terjawab dalam ≤2 respons = DESYNC TERKONFIRMASI (CWE-444), canary + ≥3 respons = SIGNAL (pipelining konsisten juga begitu), 400/501 = REJECTED (parser tegas), nihil = NO-DESYNC. Scope-gated, bounded ≤3 mode × ~4s.
- **`dom_xss_prove`** (write/confirm, CORE slot `exec_write`, groq-only): bukti dinamis DOM-XSS di Chromium headless (own browser) — payload ganda JS+HTML per sumber hash/search/postMessage (synthetic cross-origin MessageEvent)/window.name (set pre-navigasi)/referrer (predecessor same-origin) → PROVEN bila handler jalan, INJECTED_ONLY bila HTML masuk tanpa eksekusi (cek CSP), NOT_CONFIRMED bila nihil. Melengkapi `dom_taint` yang statik. Scope-gated, bounded ≤5 sumber. Gotcha: Chromium meng-encode `<>`/spasi di fragment+query saat transit — sink hash yang provable = yang decode; sink search via URLSearchParams (auto-decode); `page.evaluate(string, arg)` mengabaikan arg (wajib function form).
