# Mia — Features & Tools Reference

Dokumen referensi ringkas mengenai fitur, tools, dan komponen utama Mia sebagai **Personal AI Assistant / Agent Runtime**.

> Catatan: daftar ini disusun berdasarkan dokumentasi Mia yang dibahas dalam percakapan. Nama tool dan cakupan capability dapat berubah mengikuti versi Mia, plugin, dan konfigurasi deployment.

---

## 1. Core Architecture

Mia dapat dipahami sebagai kombinasi:

- AI Model / LLM
- Agent Runtime
- Gateway
- Workspace
- Memory
- Tools
- Skills
- Plugins
- Sessions
- Channels
- Automation
- Nodes / Devices
- Security / Sandboxing

Konsep sederhananya:

```text
                         Mia
                            │
          ┌─────────────────┼─────────────────┐
          │                 │                 │
          ▼                 ▼                 ▼
     Agent Runtime        Gateway          Workspace
          │                                   │
          ├── Tools                           ├── AGENTS.md
          ├── Skills                          ├── SOUL.md
          ├── Memory                          ├── USER.md
          ├── Sessions                        ├── IDENTITY.md
          └── Sub-agents                      ├── MEMORY.md
                                              └── memory/

          ┌─────────────────┼─────────────────┐
          ▼                 ▼                 ▼
       Channels         Automation         Devices
     Telegram             Cron              macOS
     Discord              Heartbeat         iOS
     WhatsApp             Webhook           Android
     Slack
```

---

# 2. Messaging / Channels

Mia dapat bertindak sebagai gateway untuk berbagai channel komunikasi.

## Channel yang didukung / dapat diintegrasikan

- Telegram
- Discord
- WhatsApp
- Slack
- Signal
- iMessage
- Microsoft Teams
- Google Chat
- Matrix
- Zalo
- WebChat
- Channel lain melalui plugin

## Capability umum

- Direct message
- Group chat
- Mention-based activation
- Allowlist
- Pairing
- Session per conversation / context
- Mengirim pesan dari agent
- Mengarahkan hasil automation ke channel tertentu

Contoh arsitektur:

```text
Telegram ─┐
Discord  ─┤
WhatsApp ─┼──► Mia Gateway ──► Agent
Slack    ─┤
WebChat  ─┘
```

---

# 3. Workspace

Workspace merupakan home / working directory utama bagi agent.

Workspace dapat berisi context, instructions, identity, user information, dan memory.

## File penting

```text
workspace/
├── AGENTS.md
├── SOUL.md
├── USER.md
├── IDENTITY.md
├── BOOT.md
├── HEARTBEAT.md
├── MEMORY.md
└── memory/
    ├── YYYY-MM-DD.md
    └── ...
```

## Fungsi file

### AGENTS.md

Instruction dan aturan operasional agent.

### SOUL.md

Persona, karakter, prinsip, atau gaya perilaku agent.

### USER.md

Informasi/context mengenai user yang dibutuhkan agent.

### IDENTITY.md

Identitas agent.

### BOOT.md

Instruksi yang dapat dijalankan pada proses startup/bootstrap tertentu.

### HEARTBEAT.md

Instruksi terkait heartbeat / periodic activity.

### MEMORY.md

Long-term memory yang dipelihara dalam workspace.

### memory/

Kumpulan memory berbasis tanggal atau file memory lainnya.

---

# 4. Memory

Memory merupakan bagian penting dari Personal AI Assistant.

## Tools

- `memory_search`
- `memory_get`

## Tujuan

- Mencari informasi dari memory
- Mengambil memory yang relevan
- Menyediakan context dari interaksi sebelumnya
- Membantu agent mempertahankan informasi antar-session

Konsep:

```text
User
  │
  ▼
Agent
  │
  ├── Current Context
  ├── Workspace
  └── Memory Search
          │
          ▼
     Relevant Memory
```

---

# 5. File System Tools

Tools untuk membaca dan memodifikasi filesystem.

## Tools umum

- `read`
- `write`
- `edit`
- `apply_patch`

## Use case

- Membaca source code
- Membuat file
- Mengubah file
- Memperbaiki konfigurasi
- Mengedit project
- Menghasilkan output / dokumentasi

Contoh:

```text
"Baca package.json"
"Perbaiki auth.ts"
"Buat README.md"
"Tambahkan endpoint baru"
```

---

# 6. Shell / Runtime / Command Execution

Mia dapat menjalankan command atau proses pada environment yang diizinkan.

## Tools / capability

- `exec`
- `process`
- Runtime / terminal execution
- Background process handling

## Contoh use case

```bash
npm install
npm test
npm run build
git status
git diff
pytest
docker ps
```

Ini memungkinkan agent bertindak sebagai coding / system assistant, bukan sekadar menjawab pertanyaan.

---

# 7. Browser Automation

Mia memiliki browser tool untuk berinteraksi dengan browser session.

## Capability

- Membuka halaman web
- Mengambil snapshot UI
- Memilih / menginteraksikan elemen
- Mengisi form
- Navigasi
- Menggunakan tab/session browser
- Mengambil informasi dari halaman
- Melakukan workflow web automation

## Contoh use case

```text
"Buka dashboard"
"Login"
"Cari data"
"Isi form"
"Download report"
"Ambil informasi dari halaman"
```

Browser automation berbeda dengan web search karena agent dapat berinteraksi dengan UI browser.

---

# 8. Web Search & Web Fetching

Mia dapat menggunakan web untuk mencari dan mengambil informasi.

## Tools / capability

- `web_search`
- `web_fetch`
- `x_search`

## Contoh provider / integration

- Brave
- DuckDuckGo
- Exa
- Firecrawl
- Gemini
- Grok
- Kimi
- MiniMax
- Perplexity
- SearXNG
- Tavily
- Ollama Web Search
- Provider lain melalui konfigurasi / plugin

## Use case

- Research
- Mencari dokumentasi
- Mencari berita
- Mengambil isi halaman
- Mencari posting / informasi dari X

---

# 9. Sessions

Mia memiliki sistem session untuk mengelola context percakapan dan pekerjaan agent.

## Tools / capability

- `sessions_list`
- `sessions_history`
- `sessions_search`
- `sessions_send`
- `sessions_spawn`
- `sessions_yield`
- `session_status`

## Use case

- Melihat session aktif
- Membaca history
- Mencari session
- Mengirim pesan ke session lain
- Membuat session untuk pekerjaan terpisah
- Menunggu / melanjutkan pekerjaan

Contoh:

```text
Telegram DM       ──► Session A
Discord channel   ──► Session B
Research task     ──► Session C
```

---

# 10. Multi-Agent / Sub-Agent

Mia dapat melakukan delegation dan orchestration antar agent.

## Capability / tools

- `agents_list`
- `sessions_spawn`
- `agents_wait`
- Session orchestration
- Sub-agent execution

## Contoh arsitektur

```text
                    Main Agent
                        │
         ┌──────────────┼──────────────┐
         ▼              ▼              ▼
   Research Agent   Coding Agent    QA Agent
```

## Use case

- Research dipisahkan dari coding
- Agent khusus QA
- Parallel task execution
- Delegation pekerjaan kompleks

---

# 11. Automation

Mia mendukung pekerjaan otomatis dan periodik.

## Capability

- Cron
- Heartbeat
- Webhook-triggered execution
- Scheduled task

## Contoh

```text
07:00
  │
  ▼
Agent menjalankan task
  │
  ├── Ambil berita
  ├── Buat ringkasan
  └── Kirim ke Telegram
```

Atau:

```text
18:00
  │
  ▼
Cek deployment
  │
  ▼
Generate report
  │
  ▼
Send message
```

---

# 12. Cron

Cron memungkinkan task dijalankan berdasarkan schedule.

## Use case

- Daily summary
- Reminder
- Scheduled research
- Health check
- Report generation
- Maintenance task
- Periodic agent job

Cron dapat digunakan untuk pekerjaan deterministik dan juga workflow yang melibatkan agent sesuai konfigurasi.

---

# 13. Heartbeat

Heartbeat memungkinkan agent menjalankan pemeriksaan atau activity secara periodik.

Contoh:

```text
Heartbeat
   │
   ├── Check reminder
   ├── Check pending task
   ├── Check system state
   └── Notify user when needed
```

Heartbeat berbeda dari cron karena sifatnya lebih dekat ke periodic agent awareness / check-in daripada sekadar jadwal command.

---

# 14. Messaging Tool

Selain menerima message dari channel, agent juga dapat mengirim pesan melalui channel yang tersedia.

## Use case

- Mengirim hasil task
- Mengirim reminder
- Mengirim alert
- Mengirim hasil automation
- Mengirim status deployment
- Mengirim report

Contoh:

```text
Automation complete
       │
       ▼
Telegram / Discord / Slack
```

---

# 15. Media & Multimodal

Mia dapat bekerja dengan beberapa jenis media, tergantung model/provider/plugin yang digunakan.

## Media

- Image
- Audio
- Video
- Documents

## Capability

- Image input
- Voice / audio input
- Video input
- Document handling
- Voice-note transcription
- Text-to-speech
- Image generation
- Music generation
- Video generation

## Contoh capability/tool

- `image`
- `image_generate`
- `music_generate`
- `video_generate`
- `tts`

---

# 16. Nodes / Devices

Mia dapat berinteraksi dengan device yang dipasangkan / tersedia melalui node system.

## Platform

- macOS
- iOS
- Android

## Capability tertentu

Tergantung platform dan permission, node dapat menyediakan capability seperti:

- Device commands
- Camera
- Screen recording
- Location
- Voice
- Chat / messaging

Konsep:

```text
              Mia Gateway
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
       Mac          iPhone      Android
```

---

# 17. Gateway

Gateway merupakan lapisan yang menghubungkan agent, sessions, channels, nodes, dan capability lainnya.

Konsep sederhana:

```text
Clients / Channels
        │
        ▼
     Gateway
        │
        ▼
      Agent
        │
   ┌────┼────┐
   ▼    ▼    ▼
 Tools Memory Sessions
```

---

# 18. Skills

Skills bukan sekadar tool baru.

Skill biasanya berisi instruction dan workflow yang menjelaskan **bagaimana agent menggunakan kemampuan tertentu**.

## Konsep

```text
Tool  = kemampuan melakukan aksi
Skill = instruksi / workflow menggunakan aksi
Agent = pengambil keputusan
```

Contoh:

```text
Tool:
browser

Skill:
Browser automation workflow
```

Skill dapat berupa paket instruksi yang digunakan agent untuk task tertentu.

---

# 19. Plugins

Plugin digunakan untuk memperluas kemampuan Mia.

Plugin dapat menambahkan:

- Tools
- Skills
- Channels
- Model providers
- Voice integration
- Media generation
- Web search provider
- Web fetching
- Hooks
- Runtime capabilities

## Sumber / cara instalasi

- ClawHub
- npm
- Git
- Local directory
- Archive

Konsep:

```text
Mia Core
     │
     ├── Plugin A → Telegram
     ├── Plugin B → Search Provider
     ├── Plugin C → New Tool
     └── Plugin D → New Skill
```

---

# 20. Security

Karena agent dapat melakukan aksi nyata, security merupakan bagian penting.

Capability yang perlu diamankan antara lain:

- Shell execution
- Filesystem access
- Browser automation
- Network access
- Messaging
- Device access
- Credentials

Mia menyediakan mekanisme allow / deny tool dan sandboxing sesuai deployment dan konfigurasi.

---

# 21. Sandboxing

Sandbox digunakan untuk membatasi environment agent.

Konfigurasi dapat berkaitan dengan:

- Workspace access
- Network access
- Filesystem access
- Resource limits
- Capability restrictions
- Container / isolated execution

Backend sandbox dapat menggunakan mekanisme seperti Docker, SSH, atau OpenShell tergantung setup yang digunakan.

Penting:

> Workspace sendiri bukan otomatis security sandbox.

---

# 22. Tool Groups

Tools dapat dikelompokkan berdasarkan fungsi.

Contoh group:

```text
group:runtime
group:fs
group:web
group:sessions
group:memory
group:messaging
group:nodes
group:automation
```

Ini berguna untuk mengontrol capability yang dapat digunakan agent.

---

# 23. Tool Classification

Secara praktis, tools Mia dapat dikelompokkan seperti berikut:

| Group | Contoh |
|---|---|
| Runtime | `exec`, `process` |
| Filesystem | `read`, `write`, `edit`, `apply_patch` |
| Web | `web_search`, `web_fetch`, `x_search`, `browser` |
| Memory | `memory_search`, `memory_get` |
| Sessions | `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn` |
| Messaging | Channel / message tools |
| Automation | Cron, heartbeat, webhook |
| Agents | Agent / sub-agent orchestration |
| Nodes | Device / node operations |
| Media | Image, audio, video, TTS / generation |

---

# 24. Personal AI Assistant Capability Map

Jika targetnya adalah membangun Personal AI Assistant seperti Mia, capability yang paling penting dapat diprioritaskan seperti ini.

## Tier 1 — Core MVP

- LLM integration
- Agent runtime
- Workspace
- Memory
- Filesystem tools
- Shell / exec
- Telegram
- Discord
- Session management

## Tier 2 — Highly Useful

- Web search
- Web fetch
- Browser automation
- Cron
- Heartbeat
- Skills
- Plugin system
- Background jobs

## Tier 3 — Advanced

- Multi-agent
- Sub-agent delegation
- Device nodes
- macOS integration
- iOS integration
- Android integration
- Voice
- Image / video / audio capabilities

## Tier 4 — Security / Production

- Sandboxing
- Tool allowlist / denylist
- Authentication
- Credential management
- Audit logging
- Rate limiting
- Permission controls
- Resource limits

---

# 25. Recommended Architecture for a Personal AI Assistant

Untuk project Personal AI Assistant yang ingin meniru bagian paling berguna dari Mia tanpa langsung membangun semuanya, struktur berikut sudah sangat kuat:

```text
                         Personal AI Assistant
                                  │
                         ┌────────┴────────┐
                         ▼                 ▼
                    Agent Runtime       Gateway
                         │                 │
       ┌─────────────────┼──────────────┐  │
       │                 │              │  │
       ▼                 ▼              ▼  ▼
    Memory            Workspace        Tools Channels
       │                 │              │      │
       │                 │              ├─ Exec ├─ Telegram
       │                 │              ├─ FS   └─ Discord
       │                 │              ├─ Web
       │                 │              └─ Browser
       │                 │
       ├─ MEMORY.md     ├─ AGENTS.md
       └─ memory/       ├─ SOUL.md
                        ├─ USER.md
                        └─ IDENTITY.md

                         │
                         ▼
                    Automation
                    ├─ Cron
                    └─ Heartbeat
```

---

# 26. Mia Feature Checklist

Gunakan checklist berikut sebagai acuan implementasi.

## Core

- [ ] LLM provider
- [ ] Agent runtime
- [ ] Gateway
- [ ] Configuration system
- [ ] Session system

## Workspace & Memory

- [ ] Workspace
- [ ] AGENTS.md
- [ ] SOUL.md
- [ ] USER.md
- [ ] IDENTITY.md
- [ ] MEMORY.md
- [ ] Daily memory
- [ ] Memory search
- [ ] Memory retrieval

## Tools

- [ ] Read file
- [ ] Write file
- [ ] Edit file
- [ ] Patch file
- [ ] Shell execution
- [ ] Process management
- [ ] Web search
- [ ] Web fetch
- [ ] Browser automation
- [ ] Messaging

## Channels

- [ ] Telegram
- [ ] Discord
- [ ] WhatsApp
- [ ] Slack
- [ ] WebChat
- [ ] Additional channels via plugins

## Automation

- [ ] Cron
- [ ] Heartbeat
- [ ] Webhook
- [ ] Background jobs

## Agent Orchestration

- [ ] Multiple sessions
- [ ] Sub-agent
- [ ] Agent delegation
- [ ] Agent-to-agent communication
- [ ] Agent status / waiting

## Extensibility

- [ ] Skills
- [ ] Plugin system
- [ ] Custom tools
- [ ] Custom channels
- [ ] Custom model providers

## Multimodal

- [ ] Image input
- [ ] Audio input
- [ ] Video input
- [ ] Document handling
- [ ] Speech-to-text
- [ ] Text-to-speech
- [ ] Image generation
- [ ] Video generation

## Devices

- [ ] macOS node
- [ ] iOS node
- [ ] Android node
- [ ] Camera
- [ ] Screen capture
- [ ] Location
- [ ] Device commands

## Security

- [ ] Authentication
- [ ] Authorization
- [ ] Tool allowlist
- [ ] Tool denylist
- [ ] Sandbox
- [ ] Filesystem isolation
- [ ] Network restrictions
- [ ] Credential protection
- [ ] Audit log
- [ ] Resource limits

---

# 27. Simplified Mental Model

Cara paling mudah memahami Mia:

```text
LLM
 │
 │  berpikir / mengambil keputusan
 ▼
Agent Runtime
 │
 ├── Memory      → mengingat
 ├── Workspace   → mengetahui context & instructions
 ├── Tools       → melakukan aksi
 ├── Skills      → mengetahui workflow
 ├── Sessions    → mengelola percakapan / task
 ├── Channels    → berkomunikasi dengan user
 ├── Automation  → bekerja tanpa harus dipicu manual
 ├── Nodes       → berinteraksi dengan device
 └── Plugins     → memperluas kemampuan
```

Dengan model ini, Mia lebih tepat dipandang sebagai **platform untuk Personal AI Agent** daripada sekadar chatbot.

---

# 28. Referensi Dokumentasi

Dokumentasi resmi Mia:

- Agent Workspace: https://docs.mia.ai/concepts/agent-workspace.md
- Tools: https://docs.mia.ai/tools
- Features: https://docs.mia.ai/concepts/features
- Gateway / Tool Configuration: https://docs.mia.ai/id/gateway/config-tools
- Browser: https://docs.mia.ai/id/tools/browser
- Cron: https://docs.mia.ai/id/cli/cron

