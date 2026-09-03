# Graph Report - ai-assistant  (2026-09-03)

## Corpus Check
- 78 files · ~51,917 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 767 nodes · 1346 edges · 50 communities (32 shown, 13 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 35 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Community 0
- Community 1
- Community 2
- Community 3
- Community 4
- Community 5
- Community 6
- Community 7
- Community 8
- Community 9
- Community 10
- Community 11
- Community 12
- Community 13
- Community 14
- Community 15
- Community 16
- Community 17
- Community 18
- Community 19
- Community 20
- Community 21
- Community 22
- Community 23
- Community 24
- Community 25
- Community 26
- Community 27
- Community 28
- Community 29
- Community 30
- Community 31
- Community 32
- Community 33
- Community 34
- Community 35
- Community 36
- Community 37
- Community 38
- Community 39
- Community 40
- Community 41
- Community 42
- Community 46
- Community 47

## God Nodes (most connected - your core abstractions)
1. `sanitizeUser()` - 33 edges
2. `GroqStreamingProvider` - 29 edges
3. `ConversationManager` - 27 edges
4. `executeTool()` - 23 edges
5. `runAssistantTurn()` - 22 edges
6. `AudioCapture` - 20 edges
7. `useVoice()` - 20 edges
8. `userDataRoot()` - 20 edges
9. `AIProvider` - 20 edges
10. `MockProvider` - 17 edges

## Surprising Connections (you probably didn't know these)
- `User fact: name=Naufal` --semantically_similar_to--> `Target User: Naufal (developer, Bahasa Indonesia)`  [INFERRED] [semantically similar]
  apps/web/persona/USER.md → PRD_Real-Time_Voice_AI_Assistant.md
- `Avatar visual concepts: anime illustration, long dark wavy hair, glasses, white top, female persona` --semantically_similar_to--> `Mia (assistant name)`  [INFERRED] [semantically similar]
  apps/web/public/mia-avatar.webp → apps/web/persona/IDENTITY.md
- `FR-100 Web Channel` --implements--> `Mia Personal AI Assistant (project)`  [INFERRED]
  PRD_Real-Time_Voice_AI_Assistant.md → AGENTS.md
- `AI-ASSISTANT repository (README)` --references--> `Mia Personal AI Assistant (project)`  [INFERRED]
  README.md → AGENTS.md
- `Fase 0 Foundation (from v1.0)` --conceptually_related_to--> `Mia Personal AI Assistant (project)`  [INFERRED]
  ROADMAP.md → AGENTS.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Mia Persona (IDENTITY + SOUL + DREAMS co-constitute identity)** — apps_web_persona_identity_mia, apps_web_persona_soul_mia, apps_web_persona_dreams_mia [EXTRACTED 0.95]
- **Mia v2.0 Channel Adapter Ecosystem (Web + Telegram + Discord share core)** — prd_channel_adapter_interface, prd_core_conversation_layer, prd_fr_100_web_channel, prd_fr_101_telegram_bot_channel, prd_fr_102_discord_bot_channel, agents_channel_adapter_abstraction [EXTRACTED 0.95]
- **Fase 2 Communication Layer progress (Telegram+Discord+message handling)** — roadmap_fase_2_communication_layer, roadmap_fase_21_channel_adapter, roadmap_fase_22_telegram_bot, roadmap_fase_23_discord_bot, roadmap_fase_24_message_handling [EXTRACTED 0.95]

## Communities (50 total, 13 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.06
Nodes (81): dynamic, GET(), runtime, addAutomation(), readAutomations(), addReminder(), broadcastDue(), ensureTimer() (+73 more)

### Community 1 - "Community 1"
Cohesion: 0.05
Nodes (29): AutoTurnManager, VADMode, TranscriptEntry, AudioCapture, AudioCaptureListener, AudioCaptureState, AudioPlayer, VADCallbacks (+21 more)

### Community 2 - "Community 2"
Cohesion: 0.07
Nodes (49): POST(), runtime, ALLOWED_CHANNEL_IDS, ALLOWED_USER_IDS, ChatState, handleCommand(), handleConfirmation(), isAllowedChannel() (+41 more)

### Community 3 - "Community 3"
Cohesion: 0.07
Nodes (53): POST(), runtime, buildOpenCodeSystemPrompt(), buildSystemPrompt(), currentTimeLine(), discordFormatInstruction(), extractRetryAfterMs(), formatInstructionFor() (+45 more)

### Community 4 - "Community 4"
Cohesion: 0.07
Nodes (29): Home(), STATE_HUES, FloatingParticles(), mulberry32(), PARTICLE_CONFIGS, SignInForm(), useAuth(), AIChatCard() (+21 more)

### Community 5 - "Community 5"
Cohesion: 0.07
Nodes (33): FR-015 Persisted Conversation History, Mia Personal AI Assistant (project), Multi-session / Resumable History, Working value: brevity (ephemeral speech), Working value: match user's language/tone, Working value: listen before lecture, Mia DREAMS (aspirations, working values), Mia Identity (woman, she/her, signature emoji 🌸) (+25 more)

### Community 6 - "Community 6"
Cohesion: 0.06
Nodes (33): @ai-provider/mock, dependencies, @ai-provider/mock, class-variance-authority, clsx, discord.js, framer-motion, grammy (+25 more)

### Community 7 - "Community 7"
Cohesion: 0.07
Nodes (28): devDependencies, autoprefixer, eslint, eslint-config-next, postcss, tailwindcss, @types/node, @types/react (+20 more)

### Community 8 - "Community 8"
Cohesion: 0.11
Nodes (25): pushToOwner(), Sender, describe(), running, runOne(), startAutomationRunner(), Automation, AutomationListener (+17 more)

### Community 9 - "Community 9"
Cohesion: 0.07
Nodes (26): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+18 more)

### Community 10 - "Community 10"
Cohesion: 0.16
Nodes (3): GroqStreamingProvider, AIChatCardProps, ConfirmationRequest

### Community 11 - "Community 11"
Cohesion: 0.17
Nodes (4): ConversationManager, nextId(), delay(), main()

### Community 12 - "Community 12"
Cohesion: 0.13
Nodes (12): ConversationEvent, ConversationListener, ConversationStateMachine, Event, State, STATES, Transition, TRANSITIONS (+4 more)

### Community 13 - "Community 13"
Cohesion: 0.23
Nodes (19): DELETE(), dynamic, GET(), POST(), runtime, deleteSession(), indexPath(), listSessions() (+11 more)

### Community 14 - "Community 14"
Cohesion: 0.12
Nodes (15): devDependencies, vitest, name, private, scripts, build, dev, lint (+7 more)

### Community 15 - "Community 15"
Cohesion: 0.19
Nodes (7): stripEmojiForSpeech(), ConversationMessage, MessageRole, ProviderEvent, ProviderEventListener, SendResult, ToolDefinition

### Community 16 - "Community 16"
Cohesion: 0.14
Nodes (13): dependencies, @voice/ai-provider, devDependencies, typescript, typescript, @voice/ai-provider, main, name (+5 more)

### Community 17 - "Community 17"
Cohesion: 0.14
Nodes (13): compilerOptions, esModuleInterop, lib, module, moduleResolution, noEmit, skipLibCheck, strict (+5 more)

### Community 18 - "Community 18"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, lib, module, moduleResolution, noEmit, skipLibCheck, strict (+4 more)

### Community 19 - "Community 19"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, lib, module, moduleResolution, noEmit, skipLibCheck, strict (+4 more)

### Community 21 - "Community 21"
Cohesion: 0.18
Nodes (10): devDependencies, typescript, typescript, main, name, private, scripts, typecheck (+2 more)

### Community 22 - "Community 22"
Cohesion: 0.18
Nodes (10): devDependencies, typescript, typescript, main, name, private, scripts, typecheck (+2 more)

### Community 24 - "Community 24"
Cohesion: 0.29
Nodes (7): Reminder Intent Parser (Indonesian+English), Reminders / Scheduler (per-user, disk, SSE), FR-202 Reminders / Scheduler, FR-300 Task Execution, FR-301 Notifications, Fase 3 Personal Assistant Capabilities, Fase 4 Advanced Features (RAG, multi-agent, voice, plugins)

### Community 25 - "Community 25"
Cohesion: 0.33
Nodes (6): AI Provider Abstraction invariant, Groq TTS best-effort fallback, OpenCode native session/agent API streaming, OPS Gotcha: opencode proxy hang, Core Conversation Layer, Fase 1 Core AI Assistant

### Community 26 - "Community 26"
Cohesion: 0.33
Nodes (6): Channel Adapter Abstraction, Channel Adapter Interface (Web/Telegram/Discord/...), FR-103 Extensible Channel Registry, Fase 2.1 Channel Adapter Architecture, Fase 2.4 Message Handling & Command System, Fase 2 Communication Layer (Channel Integration)

### Community 27 - "Community 27"
Cohesion: 0.40
Nodes (5): detectModel(), GROQ_VOICES_AR, GROQ_VOICES_EN, POST(), runtime

### Community 28 - "Community 28"
Cohesion: 0.40
Nodes (5): Conversation State Machine (IDLE→LISTENING→PROCESSING→SPEAKING), FR-007 Voice Barge-in, FR-016 Partial Transcript, MVP Latency Budget (<1.5s first audio), Voice State Machine (IDLE→LISTENING→PROCESSING→SPEAKING)

### Community 29 - "Community 29"
Cohesion: 0.40
Nodes (5): file_read Tool (read-only sandbox), Invariant 5: server-side API keys only, Per-user Isolation (auth-lite), Security & Trust Boundary (invariant 5, sanitizeUser, file sandbox), Fase 5 Stability & Security

### Community 30 - "Community 30"
Cohesion: 0.50
Nodes (3): extends, next/core-web-vitals, next/typescript

### Community 32 - "Community 32"
Cohesion: 0.67
Nodes (3): Discord DM partials gotcha, FR-102 Discord Bot Channel, Fase 2.3 Discord Bot

### Community 33 - "Community 33"
Cohesion: 0.67
Nodes (3): FR-013 Tool Calling + Web Search, FR-200 Tool Calling, FR-205 Web Search

### Community 34 - "Community 34"
Cohesion: 1.00
Nodes (3): Telegram Bot Channel (@inimiaku_bot), FR-101 Telegram Bot Channel, Fase 2.2 Telegram Bot

## Knowledge Gaps
- **251 isolated node(s):** `next/core-web-vitals`, `next/typescript`, `path`, `nextConfig`, `name` (+246 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 317 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **13 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `sanitizeUser()` connect `Community 0` to `Community 8`, `Community 3`, `Community 13`?**
  _High betweenness centrality (0.042) - this node is a cross-community bridge._
- **Why does `findPublicProvider()` connect `Community 1` to `Community 3`?**
  _High betweenness centrality (0.033) - this node is a cross-community bridge._
- **Why does `GroqStreamingProvider` connect `Community 10` to `Community 1`, `Community 20`, `Community 15`?**
  _High betweenness centrality (0.032) - this node is a cross-community bridge._
- **What connects `next/core-web-vitals`, `next/typescript`, `path` to the rest of the system?**
  _251 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.05694586312563841 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.051577152600170505 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.06954997077732321 - nodes in this community are weakly interconnected._