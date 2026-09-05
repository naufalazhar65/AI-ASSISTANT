# 🌸 Mia — Personal AI Assistant

Multi-platform OpenClaw-style assistant reachable via **Web (text + voice)**, **Telegram**, and **Discord** sharing one memory, one persona, and one tool set.

## Quick Start

```bash
# 1. Install (monorepo root)
npm install

# 2. Configure — server-side only (never prefix with NEXT_PUBLIC_)
cp apps/web/.env.example apps/web/.env.local
# Edit apps/web/.env.local — minimal:
GROQ_API_KEY=...                          # https://console.groq.com/keys (free, no card)
TELEGRAM_BOT_TOKEN=...                    # BotFather
TELEGRAM_ALLOWED_USERNAME=...             # allow-listed username (without @)
DISCORD_BOT_TOKEN=...                     # Discord Developer Portal
DISCORD_ALLOWED_USER_ID=...               # owner user id (snowflake)
# Optional
OPENROUTER_API_KEY=...                    # https://openrouter.ai/keys
ALLOWED_WORKSPACES=...                   # comma-separated absolute paths the agent may read/exec into (e.g. /Users/me/PROJECT/other-app)
NEXT_PUBLIC_AI_PROVIDER=groq              # mock (default) | groq | openrouter | 9router | opencode

# 3. Run
npm run dev -w @voice/web                 # http://localhost:3000
```

## How It Works

```
Telegram ─┐
Discord  ─┼─► Channel Adapter ─► runAssistantTurn (lib/agent.ts) ─► Provider ─► LLM
Web      ─┘                  ◄─ reply (per-channel formatting) ◄─┘
                             ▲ persona / tools / reminders / tasks / automations / RAG
```

- **Core:** `apps/web/src/lib/agent.ts` — single turn implementation for every channel (`streaming → tools → follow-up → auto-memory → reminder intent → mood log`).
- **Providers:** `apps/web/src/lib/providers.ts` — `groq` / `openrouter` / `9router` / `opencode (local)` / `mock`. Client sends only `{provider, model}`; server resolves keys/endpoints (Invariant 5).
- **Channels:** `apps/web/src/channels/{telegram,discord}.ts` + `pushTarget.ts` sink for proactive pushes.
- **Persistence:** per-user disk store under `apps/web/.data/users/<user>/` — notes, reminders, tasks, uploads, automations, mood log (`moods.json`), Spotify token (`spotify.json`), persona, daily memory (`memory/YYYY-MM-DD.md`).
- **Scheduling:** `lib/reminders.ts` + `lib/automations.ts` (daily / hourly) + `automationRunner.ts` + `heartbeat.ts` (periodic overdue/due-soon check, default 30m) + `POST /api/webhook` (external trigger with `WEBHOOK_SECRET`) — all started in `instrumentation-node.ts`.
- **Channel adapter policy:** Discord DM requires `partials: [Channel, Message]` + `msg.fetch()` on `msg.partial` (first-ever DM would be dropped otherwise).

## Commands

| Command | Where | Purpose |
|---------|-------|---------|
| `/start` `/help` | Telegram, Discord | Intro / help |
| `/reset` | Telegram, Discord | Clear this chat's history |
| `/provider <id>` | Telegram, Discord | Switch provider: `groq` `opencode` `9router` `openrouter` `mock` |
| `/model <id>` | Telegram, Discord | Set model (empty = Auto) |
| `/status` | Telegram, Discord | Time, uptime, provider/model, per-user data counts |
| `/backup` | Telegram, Discord | Create timestamped backup under `.data/backups/` (keeps 5) |

## Tools (available to the assistant)

| Tool | Risk | Purpose |
|------|------|---------|
| `web_search` | read | DuckDuckGo Instant + HTML scrape (titles/URLs/snippets) |
| `fetch_url` | read | Fetch public page text (SSRF-guarded, article extraction; GitHub blob→raw) |
| `calculate` | read | Safe arithmetic parser (no eval) |
| `file_read` | read | Sandboxed file/dir read (repo root + any `ALLOWED_WORKSPACES`) |
| `write_file` / `edit_file` | write | Create/overwrite or patch a file (sandboxed, parent dirs auto-created, confirmation) |
| `exec` | read | Read-only shell allowlist (git status/log/diff, ls, pwd, cat, node --version, npm ls) with optional `cwd` into an allowed workspace; mutating cmd rejected |
| `exec_write` | write | Write shell (git add/commit/push) with confirmation, same `cwd` support |
| `list_uploads` / `read_upload` | read | Files uploaded via Telegram/Discord |
| `search_memory` | read | Local BM25 over notes/tasks/reminders/automations/uploads/persona + daily memory |
| `memory_get` | read | Retrieve daily memory log for a date (`YYYY-MM-DD`, `today`, `yesterday`) |
| `browser_open` / `browser_snapshot` | read | Headless browser (Playwright) — open URL (JS-rendered) / snapshot ARIA tree |
| `browser_click` / `browser_type` / `browser_navigate` | write | Click/type/navigate in browser (confirmation) |
| `device_list` | read | List paired devices |
| `device_exec` / `device_screenshot` / `device_location` / `device_camera` / `device_battery` | read/write | Device node ops (exec/screenshot/location/camera/battery, pairing via `device_pair`) |
| `device_pair` | write | Pair new device (ios/android/macos) |
| `calendar_list` / `calendar_check` | read | List events / check availability |
| `calendar_add` | write | Add calendar event (confirmation) |
| `spotify_link` | read | Return Spotify authorization link (one-time connect, opens in browser) |
| `spotify_status` / `spotify_search` / `spotify_devices` | read | Now playing / search tracks / list playback devices |
| `spotify_play` / `spotify_pause` / `spotify_next` / `spotify_previous` / `spotify_volume` | write | Control Spotify playback (confirmation; requires Spotify Premium) |
| `save_note` / `list_notes` / `delete_note` | write/delete | Quick persistent notes (50 / 80 KB cap, atomic disk write) |
| `add_task` `list_tasks` `complete_task` `cancel_task` `reschedule_task` | write | Task list |
| `remind_me` | write | Schedule a reminder (ISO-8601 with offset; stale clock rebased) |
| `create_automation` | write | Recurring `prompt` on schedule (`setiap pagi jam 8` / `setiap 2 jam`) |
| `mood_log` | read | Record current mood (great/good/okay/meh/stressed/anxious/sad/tired/angry, Indonesian accepted & normalized) |
| `mood_recent` | read | Show mood history / trend ("gimana mood-ku belakangan ini?") |
| `send_channel` | read* | Relay a message to another registered channel (Telegram ↔ Discord, sends immediately, no confirmation) |

Read-only tools auto-execute. Write/delete/transaction/external tools pause for inline `ya`/`tidak` confirmation (FR-014).

## Voice (Web)

Hands-free voice via the same core: browser mic → energy VAD → Whisper ASR → LLM → Orpheus TTS per sentence. Barge-in in `SPEAKING` (higher VAD threshold + hold) triggers `interrupt()` (generationId + AbortController). First AI audio target < 1.5s.

## Project Layout

```
apps/web                  Next.js app (UI, hooks, audio, persona, /api/* proxies)
  src/ai                  ConversationManager, GroqStreamingProvider, VAD helpers
  src/lib                 tools, agent, providers, persona, autoMemory, sessions,
                          reminders, tasks, uploads, automations, mood, rag,
                          status, backup, ...
  src/channels            telegram.ts, discord.ts, pushTarget.ts
  persona/                IDENTITY.md, SOUL.md, USER.md, DREAMS.md (template)
packages/state-machine    Conversation state machine (invalid transitions impossible)
packages/ai-provider      AIProvider abstraction + event types
packages/mock-provider    Deterministic no-network provider for QA
```

## Scripts

```bash
npm install                              # install all workspaces
npm run dev -w @voice/web                # dev server
npm run typecheck                        # all workspaces
npm run lint
npm run build
npm test                                 # vitest (state-machine tests)
npx tsx apps/web/verify.ts               # offline core proofs (tsx, no framework)
npx tsx packages/state-machine/verify.ts
```

## Operations

- **Deploy:** single process (`next start` + in-process bots + scheduler). Two config dirs: `.env.local` holds keys; `.data/` holds user state — back up both. Multi-instance needs an external queue for the scheduler.
- **Diagnostics:** `/tmp/mia-dev.log` in dev; bot gateway warnings/errors surface via stdout. `/status` in any channel shows live state.
- **Automation delivery:** scheduled automations push to the owner's last-seen channel; stays unfired until a channel is seen after restart.
- **Error surfaces:** `assistantError.ts` classifies `rate_limit`/`quota` (429/402) into clear user messages in web banner + Telegram/Discord.

## Docs

- `PRD_Real-Time_Voice_AI_Assistant.md` — requirements & architecture (v2.0).
- `ROADMAP.md` — phase-by-phase guide and status.
- `AGENTS.md` — conventions, invariants, gotchas.

## License

Private personal project. See repository license if added.
