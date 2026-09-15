# 🌸 Mia — Personal AI Assistant

> **One brain, many faces.** Web (text + voice) · Telegram · Discord — one memory, one persona, one toolset.

[![Next.js](https://img.shields.io/badge/Next.js-15-black?style=flat-square&logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org)
[![Tools](https://img.shields.io/badge/tools-246-ff69b4?style=flat-square)](./apps/web/src/lib/tools.ts)
[![License](https://img.shields.io/badge/license-private-lightgrey?style=flat-square)](#license)

---

## ✨ What is Mia?

Mia (*she/her* 🌸) is a **Mia-style** personal assistant — warm, proactive, and always there.  
Voice-first foundation (Whisper + Orpheus) **plus** multi-platform chat, automation, and long-term memory.

| Channel | Capabilities |
|---------|--------------|
| **Web** | Text + voice (VAD, barge-in), vision 📎, multi-session, auth PIN |
| **Telegram** | Text, voice note, photo, inline `ya/tidak`, typing indicator |
| **Discord** | Text, voice note, photo, slash commands, typing indicator |
| **API** | `POST /api/llm` + webhook `POST /api/webhook` |

---

## 🚀 Quick Start

```bash
# 1. Install (monorepo)
npm install

# 2. Configure — server-side only (never NEXT_PUBLIC_ for secrets)
cp apps/web/.env.example apps/web/.env.local
# Edit apps/web/.env.local — minimal:
GROQ_API_KEY=...                          # https://console.groq.com/keys (free)
TELEGRAM_BOT_TOKEN=...                    # @BotFather
TELEGRAM_ALLOWED_USERNAME=...             # without @
DISCORD_BOT_TOKEN=...                    # Discord Developer Portal
DISCORD_ALLOWED_USER_ID=...              # owner snowflake
# Optional — free & weekly-unlimited
OPENROUTER_API_KEY=...                   # https://openrouter.ai/keys
LLM_API_KEY=... LLM_API_BASE=http://localhost:20128/v1  # 9router local proxy
ALLOWED_WORKSPACES=/Users/me/PROJECT/other-app  # comma-separated
NEXT_PUBLIC_AI_PROVIDER=9router           # mock | groq | openrouter | 9router | opencode | opencodego

# 3. Run
npm run dev -w @voice/web                 # http://localhost:3000
npm run typecheck && npm test && npx tsx apps/web/verify.ts
```

> **Voice:** browser mic → VAD → Whisper ASR → LLM → Orpheus TTS per sentence — barge-in <200ms, first audio <1.5s.

---

## 🧠 Architecture

```mermaid
flowchart LR
  TG[Telegram] --> A[Channel Adapter]
  DC[Discord] --> A
  WEB[Web] --> A
  A --> C[runAssistantTurn<br/>lib/agent.ts]
  C --> P[Provider<br/>groq / 9router / openrouter / opencodego / mock]
  P --> LLM
  C <--> M[(Memory & Tools<br/>persona / .brv / .data / RAG)]
  LLM --> C
  C --> R[Reply<br/>per-channel formatting]
  R --> TG & DC & WEB
```

- **Core:** `lib/agent.ts` — single turn (`stream → tools → follow-up → auto-memory → reminder → mood`) for **every** channel.
- **Provider:** `lib/providers.ts` — client sends `{provider, model}` only; server resolves keys (Invariant 5). `9router` local `localhost:20128/v1` = weekly-unlimited; `groq` = STT/TTS; `openrouter` = free fallback; `opencodego` = default brain (OpenCode Go, model `deepseek-v4.1-flash` via `OPENCODEGO_MODEL`).
- **Adapter:** `channels/{telegram,discord}.ts` + `pushTarget.ts` (proactive pushes). Discord DM needs `partials:[Channel,Message]` + `msg.fetch()`.
- **State:** `packages/state-machine` — `IDLE → LISTENING → PROCESSING → SPEAKING → TURN_END/INTERRUPTED` (invalid transitions impossible).

---

## 🛠️ Tools — 246 total

| Category | Tools | Notes |
|----------|-------|-------|
| **Web** | `web_search`, `research`, `google_news`, `fetch_url` | DuckDuckGo + Bing fallback, Google News RSS dedup, SSRF-guarded |
| **Code** | `file_read`, `write_file`, `edit_file`, `codebase_search`, `codebase_refresh` | Sandboxed multi-root `resolveInSandbox`, `ALLOWED_WORKSPACES` |
| **Shell** | `exec` (read), `exec_write` (write) | Allowlist `git/ls/pwd/cat/node/npm/df/ps/pgrep/netstat/ifconfig/arp/dig/whois/lsof(-i)…` + SafeExec guard |
| **Memory** | `save_note`, `list_notes`, `delete_note`, `search_memory`, `memory_get` | Per-user `notes.json`, BM25 + embedding, `dailyMemory` |
| **Knowledge** | `brv_query`, `brv_search`, `brv_curate`, `brv_status`, `brv_vc_status/log`, `brv_swarm_query/status`, `brv_review*`, `brv_locations` | **ByteRover** `.brv` 19 commits, `2/2` swarm (`byterover`+`local_markdown`), `9router` |
| **Summarize** | `summarize` (20 formats), `summarize_history/saved/stats/template/default` | **Summarize Pro** `quick/tldr/bullets/eli5/meeting/email/compare` + `.data/summarize-pro/` |
| **Humanize** | `humanize`, `humanize_history/stats` | **Humanizer** 24 Wikipedia patterns + soul, `.data/humanizer/` |
| **Browser** | `browser_open/snapshot/click/type/navigate` | Playwright headless `1280x800` |
| **Browser-use** | `browser_use_doctor/open/state/click/input/type/keys/screenshot/get/eval/scroll/tab/wait/close` | **Browser-use** daemon `~50ms`, indices, persistent |
| **CUA** | `cua_doctor/list_apps/window_state`, `cua_launch/click/type`, `cua_browser_*` | Native GUI `cua-driver serve`, typed Chromium |
| **Device** | `device_list/pair/exec/screenshot/location/camera/battery` | Per-user `devices.json`, `blueutil -p` |
| **Calendar** | `calendar_list/check/add` + `calendar_mac_*` | AppleScript sync |
| **Mood/Health** | `mood_log/recent`, `health` (`water/sleep/wake/stats`), `habit_log/stats` | Per-user JSON, `moods.json` |
| **Productivity** | `add_task/list/complete/cancel/reschedule`, `remind_me`, `reminders_list`, `create_automation` | Daily/heartbeat, `reminders_list` natural anti-kaku |
| **Planning** | `plan_create/add_step/update_step/list/get` | Internal board vs user tasks |
| **Travel** | `waze_route`, `weather`, `hotel_search` | Waze Direct + wttr.in + Booking.com (free, no key) |
| **Media** | `spotify_*` (8), `mala`, `game_*`, `hari_libur`, `recap`, `weekly_insight` | Premium for playback, deterministic mala |
| **Ops** | `git_status/commit`, `safe_exec_list`, `evolver_status/review`, `freeride_status/list/auto/switch/refresh/rotate/watcher`, `learnings_*`, `send_channel` | SafeExec, freeride fallback chain `429→next`, watcher `60s` |

| **Security — posture** | `security_scan`, `secret_scan`, `breach_check`, `tls_check` | macOS posture, leaked-secret scan (redacted), HIBP k-anonymity, TLS |
| **Security — recon (attack surface)** | `recon_subdomains`, `recon_httpx`, `recon_params`, `recon_takeover`, `recon_list` | passive CT/archive OSINT + scoped active live-host probe; per-user cache |
| **Security — audit** | `web_audit`, `domain_audit`, `exec dig/whois` | headers/cookies, SPF/DMARC/DKIM/CAA |
| **Security — scan (authorized)** | `pentest_scan`, `sqlmap_scan`, `zap_scan`, `http_request` | nmap/nuclei/nikto/ffuf/sqlmap/ZAP + raw HTTP — lab/engagement/permitted only |
| **Security — SAST** | `sast_scan` | semgrep `p/default`+`p/secrets` on a sandbox dir (white-box) |
| **Security — analysis** | `password_strength`, `hash_identify`, `jwt_inspect`, `ioc_extract`, `cvss_score` | CVSS v3.1 base score |
| **Security — deps** | `dep_audit`, `verify_patch`, `trivy_scan` | CVE via OSV/trivy + fixed-version/patch check |
| **Security — findings** | `finding_add/list/resolve/export`, `hardening_plan`, `report_generate/save/pdf`, `hardening_pdf` | CVSS/OWASP/CWE, CSV/JSON/**SARIF**, MD/PDF |
| **Security — lab & engagement** | `lab_status/start/fetch`, `engagement_create/list/close`, `pentest_resources` | `labs/pentest` (no-Docker vuln-node), client authorization + scope guard |
| **Security — hunt (otonom)** | `security_hunt` | 1 perintah = header/cookie + CSP + CORS + content discovery + crawl + JS mining + param discovery → **LEADS** (scope-gated, bounded) |
| **Security — playbooks** | `security_playbook` | 77 knowledge packs (adapted from Strix, Apache-2.0): per-class vuln (ssrf/idor/xss/sqli/ssti/xxe/race/…), tooling, cloud, frameworks, protocols, analysis, **workflow** (AppSec / OWASP Top 10:2025 / API Top 10:2023 / whitebox / fix-and-verify / scan-modes) |
| **Security — bug bounty** | `scope_import`, `recon_diff/screenshot/dnsbrute/ports`, `crawl`, `content_discover`, `js_mine`, `api_spec`, `graphql_probe`, `bucket_enum`, `cve_intel`, `param_discover`, `param_fuzz`, `cors_audit`, `csp_audit`, `oast_create/poll/stop`, `oast_dns_create/poll/stop`, `http_session`, `bola_diff`, `request_save/run`, `http_history`, `jwt_attack`, `evidence_capture`, `platform_severity`, `submission_track`, `race`, `ws_probe` | Scope parsing, new-asset diff, visual recon, DNS brute + port check, crawler, JS/API/GraphQL surface, cloud-bucket enum, CVE intel, hidden-param discovery, param fuzzing, CORS/CSP audit, OOB/blind proof, multi-identity authz, request collections + HTTP history, JWT forge/crack, H1/VRT severity, evidence, submission tracker |
| **Self-Update** | `auto_update_status`, `auto_update` | **Auto-Update Mia** mandiri: daily 04:00 WIB `git pull --ff-only` + `npm install` + gates `typecheck/test/verify` + push ringkasan + restart; `auto_update` = konfirmasi |

> **Risk:** `read` = auto-run, `write/delete` = inline `ya/tidak` (FR-014) — except `spotify_play` (immediate).

---

---

## 🔐 Cybersecurity (Ethical-Hacker)

Mia can act as a **defensive / authorized** security assistant. Full guide +
scope rules + examples: **[SECURITY.md](./SECURITY.md)**.

- **Own system:** `security_scan` · `secret_scan` · `tls_check` · `domain_audit` · `web_audit` · `dep_audit` · `verify_patch` · `sast_scan`
- **Recon / attack surface:** `recon_subdomains` (CT crt.sh) · `recon_params` (OTX/urlscan/Wayback) · `recon_takeover` (CNAME fingerprints) · `recon_httpx` (active, scoped)
- **Authorized scans:** `pentest_scan` (nmap/nuclei/nikto/ffuf) · `sqlmap_scan` · `zap_scan` · `http_request`
- **Findings → report:** `finding_add` (CVSS/OWASP/CWE) → `hardening_plan` → `report_pdf` / `finding_export` (CSV/JSON/SARIF)
- **Methodology:** `security_playbook` (counterevidence / severity-calibration / fix-verification / per-class packs, adapted from Strix)
- **Bug bounty:** `oast_create`/`oast_poll` (blind/OOB proof) · `http_session` + `bola_diff` (two-identity BOLA/IDOR) · `content_discover` (robots/sitemap/JS/paths)
- **Practice lab (no Docker):** `lab_start` → `http://127.0.0.1:4010` (SQLi/XSS/IDOR/SSRF/JWT/CSRF/…)
- **Client pentest:** `engagement_create` (authorization + scope) → only in-scope hosts are scannable

> Only test what you own or are **authorized** for; public third-party sites are out of scope.

## 💾 Persistence

```
apps/web/.data/users/<user>/   # per-user: notes, reminders, tasks, moods, spotify, memory/YYYY-MM-DD.md
.data/freeride/                # freeride cache + primary/fallbacks
.data/auto-updater/            # daily self-update state (last run, history, lock)
.data/summarize-pro/           # history/saved/templates + stats
.data/humanizer/               # history/settings 24-pattern
.brv/context-tree/              # ByteRover 19 commits (VC git, not main)
.memory/                       # Clawic Memory durable (INDEX capped)
.learnings/ + .self-improving/ # LRN/ERR/FEAT + watcher
```

Global `.data/` is gitignored + backed up (`POST /backup`, keeps 5).

---

## ⏰ Scheduling

- `reminders.ts` — one-shot + `daily` (merge + `+24h` reschedule, variant rotation)
- `automations.ts` — `create_automation` (`setiap pagi jam 8`)
- `heartbeat.ts` `30m` — overdue/due-soon + monitor `battery ≤ / storage ≥`
- `freerideWatcher.ts` `60s` — probe `openrouter` primary, auto `rotate` on `429`
- `autoUpdater.ts` daily `04:00` WIB — self-update `git pull` + `npm install` + gates + push + restart
- `webhook` `POST /api/webhook` (`WEBHOOK_SECRET`)

All started in `instrumentation-node.ts`.

---

## 📁 Project Layout

```
apps/web              Next.js 15 (UI, hooks, audio, persona, /api/*)
  src/ai              ConversationManager, GroqStreamingProvider, VAD
  src/lib             tools, agent, providers, persona, autoMemory, byterover, summarizePro, humanizer, freeride, autoUpdater, ...
  src/channels        telegram.ts, discord.ts, pushTarget.ts
  persona/            IDENTITY.md, SOUL.md, USER.md, DREAMS.md
packages/state-machine  Explicit state machine
packages/ai-provider    AIProvider abstraction
packages/mock-provider  Deterministic mock
```

---

## 📜 Scripts

```bash
npm install
npm run dev -w @voice/web        # http://localhost:3000
npm run typecheck
npm run lint
npm run build
npm test                         # vitest 9 tests
npx tsx apps/web/verify.ts       # 40+ offline proofs (tsx)
npx tsx packages/state-machine/verify.ts
```

---

## 🔧 Operations

- **Deploy:** single process `next start` + in-process bots + scheduler. Back up `.env.local` + `.data/`.
- **Health:** `GET /api/health` → `ok:true`, `/status` per channel, `freeride_status` / `browser_use_doctor`.
- **Rate limit:** `RATE_LIMIT_TURNS_PER_MIN` (default 30) → `429`; `freeride` auto-retries next free model.
- **Auth:** `AUTH_TOKEN` → web PIN `/login` + `Bearer`; `TOOLS_DENY` to disable tools.
- **Logs:** `.data/logs/APP-*.log` + `.data/audit/AUDIT-*.log` + `/tmp/mia-dev.log` (dev).

---

## 📚 Docs

- `PRD_Real-Time_Voice_AI_Assistant.md` — requirements & architecture v2.0
- `ROADMAP.md` — phases & status
- `AGENTS.md` — invariants, gotchas, conventions
- `MIA_FEATURES.md` — full feature list

## License

Private personal project.

---

*Built with 🌸 — Mia is a woman, she/her, always.*
