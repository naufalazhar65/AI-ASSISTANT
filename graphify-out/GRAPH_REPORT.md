# Graph Report - ai-assistant  (2026-09-12)

## Corpus Check
- 148 files · ~143,187 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1497 nodes · 3499 edges · 102 communities (74 shown, 22 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 49 edges (avg confidence: 0.86)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- QA Probe Scripts
- API Route Shells
- Habit Tracking
- Architecture & Memory Concepts
- Web UI Home Page
- Automation Runner
- LLM Auto-Capture Routes
- Codebase Index (BM25)
- Web Search Scraper
- Voice AutoTurn Manager
- Agent Calendar Tools
- API Route (Legacy)
- Groq Streaming Provider
- tsconfig (web)
- Discord Channel
- Reply Chunking
- Audit Log
- Devices API
- Monitors & Alerts
- Audio Capture + Sessions
- Daily Memory
- Morning Briefing
- Web Build Deps
- Summarize API
- Sessions API / Misc
- Root Tooling Deps
- Conversation Manager
- Mock Provider + UI Deps
- Conversation Events
- State Machine Core
- Evening Recap
- Wind Down
- Rolling Summary
- Link Library
- Empty Turn Probe
- Mock Provider Events
- Generic API Route
- Calendar Sync (macOS)
- Monthly Consolidate
- Uploads
- ai-provider Package
- tsconfig (package)
- STT Route
- Legacy API Route Group
- Voice STT Providers
- Mac Context Capture
- Proactive Messages
- Sandbox File Ops
- AIProvider Interface
- tsconfig (mock)
- tsconfig (edge)
- Agent Post-Processing
- Heartbeat Scheduler
- Next Instrumentation
- Spotify Intent
- Mala Generator
- Status Report
- tsconfig (state-machine)
- tsconfig (web/skills)
- Web Package Root
- TTS Route
- Channel Push Targets
- Confirmation Suffixes
- System Prompts
- Browser Automation
- Greeting & Mood Quality
- Mood & Correction Capture
- Backup
- Monitor Intents
- Channel Chat Sessions
- Price Intents
- Reminder Messages
- Audio Player
- Notes Store
- User Persona Facts
- ESLint Config
- Persona Dreams
- Web Layout Shell
- Next Config
- PostCSS
- Login Page
- External Agent Notes
- Hybrid RAG Concepts
- Next Env Types
- clsx Dep
- Discord.js Dep
- Next Dep
- ogl Dep
- Radix Slot Dep
- React Dep
- Tailwind Merge Dep
- Tailwind Animate Dep
- Skills System
- Email Inbox Concept
- Mia Gateway Concept
- Per-User Isolation

## God Nodes (most connected - your core abstractions)
1. `sanitizeUser()` - 95 edges
2. `userDataRoot()` - 65 edges
3. `main()` - 63 edges
4. `runAssistantTurnImpl()` - 50 edges
5. `appRoot()` - 32 edges
6. `GroqStreamingProvider` - 31 edges
7. `ConversationManager` - 28 edges
8. `runAssistantTurn()` - 27 edges
9. `readReminders()` - 27 edges
10. `logInfo()` - 25 edges

## Surprising Connections (you probably didn't know these)
- `AIChatCardProps` --references--> `ConfirmationRequest`  [EXTRACTED]
  apps/web/src/components/ui/ai-chat.tsx → packages/ai-provider/src/index.ts
- `Mia Channels (Web/Telegram/Discord/PWA Eyes/Webhook)` --conceptually_related_to--> `ChannelAdapter Interface`  [INFERRED]
  MIA_FEATURES.md → PRD_Real-Time_Voice_AI_Assistant.md
- `Fase 2 Channel Adapter Architecture` --conceptually_related_to--> `ChannelAdapter Interface`  [INFERRED]
  ROADMAP.md → PRD_Real-Time_Voice_AI_Assistant.md
- `runAssistantTurn (lib/agent.ts)` --conceptually_related_to--> `Core Conversation Layer`  [INFERRED]
  README.md → PRD_Real-Time_Voice_AI_Assistant.md
- `ConversationManager` --references--> `AIProvider`  [EXTRACTED]
  apps/web/src/ai/ConversationManager.ts → packages/ai-provider/src/index.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Channel Adapter Abstraction** — prd_real_time_voice_ai_assistant_channeladapter, prd_real_time_voice_ai_assistant_webadapter, prd_real_time_voice_ai_assistant_telegramadapter, prd_real_time_voice_ai_assistant_discordadapter, agents_md_channeladapter, roadmap_fase2_channel_adapter, readme_channel_adapter_policy, mia_features_channels [INFERRED 0.85]
- **Shared Core Conversation Layer** — prd_real_time_voice_ai_assistant_core_conversation_layer, agents_md_conversationmanager, readme_run_assistant_turn, prd_real_time_voice_ai_assistant_state_machine, agents_md_tool_plugin_registry, prd_real_time_voice_ai_assistant_tool_confirmation [INFERRED 0.85]
- **Security & Trust Boundary** — prd_real_time_voice_ai_assistant_invariant5, prd_real_time_voice_ai_assistant_auth_lite, agents_md_multiworkspace_sandbox, mia_features_tools_list_sandbox_security, roadmap_fase5_security [INFERRED 0.85]

## Communities (102 total, 22 thin omitted)

### Community 0 - "QA Probe Scripts"
Cohesion: 0.07
Nodes (59): main(), tests, main(), dynamic, GET(), runtime, buildReminderList(), scheduleReminderFromIntent() (+51 more)

### Community 1 - "API Route Shells"
Cohesion: 0.06
Nodes (60): dynamic, GET(), runtime, dynamic, GET(), runtime, scheduleSpotifyControlFromIntent(), answerMatches() (+52 more)

### Community 2 - "Habit Tracking"
Cohesion: 0.08
Nodes (44): Habit, HabitLog, habitsPath(), habitStats(), logHabit(), readHabits(), todayStr(), writeHabits() (+36 more)

### Community 3 - "Architecture & Memory Concepts"
Cohesion: 0.05
Nodes (47): CI Verification Pipeline, AIProvider Abstraction, Automatic Persona Memory (captureFactsFromTurn), Channel Adapter Abstraction (AGENTS), Codebase QA Index (BM25), Explicit Conversation State Machine, ConversationManager, AGENTS.md Conventions (+39 more)

### Community 4 - "Web UI Home Page"
Cohesion: 0.07
Nodes (30): Home(), STATE_HUES, FloatingParticles(), mulberry32(), PARTICLE_CONFIGS, SignInForm(), useAuth(), AIChatCard() (+22 more)

### Community 5 - "Automation Runner"
Cohesion: 0.08
Nodes (40): r1, describe(), running, runOne(), startAutomationRunner(), addAutomation(), Automation, AutomationListener (+32 more)

### Community 6 - "LLM Auto-Capture Routes"
Cohesion: 0.08
Nodes (38): POST(), runtime, CaptureArgs, captureFactsFromTurn(), contentToText(), EXTRACT_PROMPT, extractFactsOpenAi(), extractFactsOpenCode() (+30 more)

### Community 7 - "Codebase Index (BM25)"
Cohesion: 0.11
Nodes (37): buildIndexFromRoots(), chunkText(), CodeIndex, currentIndex(), ensureFreshIndex(), GlobalCarrier, indexFile(), indexSummary() (+29 more)

### Community 8 - "Web Search Scraper"
Cohesion: 0.08
Nodes (38): defaultFetchHtml(), assertPublicUrl(), buildGnLangs(), canonicalizeUrl(), cleanSearchQuery(), cleanUrl(), DENY_PATTERNS, DENY_SEGMENTS (+30 more)

### Community 9 - "Voice AutoTurn Manager"
Cohesion: 0.09
Nodes (6): AutoTurnManager, VADMode, AudioCapture, VADCallbacks, VADOptions, VoiceActivityDetector

### Community 10 - "Agent Calendar Tools"
Cohesion: 0.08
Nodes (32): CAL_TITLE_STOP_WORDS, cleanCalendarTitle(), confirmExecuted, ContentPart, extractCalendarTitle(), extractRetryAfterMs(), GREETING_EMPATHY, lastUserContent() (+24 more)

### Community 11 - "API Route (Legacy)"
Cohesion: 0.12
Nodes (26): dynamic, GET(), runtime, dynamic, GET(), runtime, clearGmailToken(), decodeBase64Url() (+18 more)

### Community 12 - "Groq Streaming Provider"
Cohesion: 0.15
Nodes (3): GroqStreamingProvider, stripEmojiForSpeech(), ConfirmationRequest

### Community 13 - "tsconfig (web)"
Cohesion: 0.07
Nodes (26): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+18 more)

### Community 14 - "Discord Channel"
Cohesion: 0.17
Nodes (23): ALLOWED_CHANNEL_IDS, ALLOWED_USER_IDS, ChatState, handleCommand(), handleConfirmation(), isAllowedChannel(), isAllowedMessage(), isAllowedUser() (+15 more)

### Community 15 - "Reply Chunking"
Cohesion: 0.17
Nodes (22): chunkText(), DISCORD_MAX, INTERIM_WAITS, interimWaitText(), TELEGRAM_MAX, ALLOWED_USER_IDS, ALLOWED_USERNAMES, ChatState (+14 more)

### Community 16 - "Audit Log"
Cohesion: 0.17
Nodes (21): GET(), AUDIT_DIR(), auditLog(), day(), prune(), appLogEnabled(), auditEnabled(), auditKeepDays() (+13 more)

### Community 17 - "Devices API"
Cohesion: 0.19
Nodes (21): dynamic, GET(), POST(), runtime, Device, deviceBattery(), deviceCamera(), DeviceCapability (+13 more)

### Community 18 - "Monitors & Alerts"
Cohesion: 0.17
Nodes (22): addMonitor(), checkMonitorsAndAlert(), COINGECKO_ALIASES, cpRun, DEVICE_SUBJECTS, evaluateAlert(), fetchCryptoUsd(), fetchDeviceMetric() (+14 more)

### Community 19 - "Audio Capture + Sessions"
Cohesion: 0.16
Nodes (19): AudioCaptureListener, AudioCaptureState, apiDeleteSession(), apiListSessions(), apiLoadSession(), apiUpsertSession(), historyUser(), loadHistory() (+11 more)

### Community 20 - "Daily Memory"
Cohesion: 0.23
Nodes (15): schedulePlaceCheckFromIntent(), appendDailyMemory(), dailyMemoryPath(), listDailyMemories(), loadDailyMemoryPrompt(), memoryDir(), readDailyMemory(), todayStr() (+7 more)

### Community 21 - "Morning Briefing"
Cohesion: 0.20
Nodes (17): buildMorningBriefing(), greetingFor(), holidayToday(), localDayJkt(), localHourJkt(), pickFrom(), runBriefingTick(), saveBriefingDay() (+9 more)

### Community 22 - "Web Build Deps"
Cohesion: 0.11
Nodes (19): devDependencies, autoprefixer, eslint, eslint-config-next, postcss, tailwindcss, @types/node, @types/react (+11 more)

### Community 23 - "Summarize API"
Cohesion: 0.27
Nodes (17): DELETE(), dynamic, GET(), POST(), runtime, deleteSession(), indexPath(), listSessions() (+9 more)

### Community 24 - "Sessions API / Misc"
Cohesion: 0.15
Nodes (15): dynamic, POST(), runtime, summarizeWithLlm(), defaultProviderId(), isProviderId(), PROVIDER_SPECS, ProviderId (+7 more)

### Community 25 - "Root Tooling Deps"
Cohesion: 0.11
Nodes (18): dependencies, playwright, devDependencies, vitest, name, private, scripts, build (+10 more)

### Community 27 - "Mock Provider + UI Deps"
Cohesion: 0.12
Nodes (17): @ai-provider/mock, dependencies, @ai-provider/mock, class-variance-authority, framer-motion, grammy, lucide-react, react-dom (+9 more)

### Community 28 - "Conversation Events"
Cohesion: 0.17
Nodes (9): ConversationEvent, ConversationListener, nextId(), TranscriptEntry, ConversationMessage, MessageRole, ProviderEvent, SendResult (+1 more)

### Community 29 - "State Machine Core"
Cohesion: 0.15
Nodes (9): ConversationStateMachine, State, STATES, Transition, TRANSITIONS, cycle, ILLEGAL, LEGAL (+1 more)

### Community 30 - "Evening Recap"
Cohesion: 0.24
Nodes (15): recapHour(), allUserKeys(), buildEveningRecap(), cleanSnippets(), isJunkLine(), lastRecapDay, localDay(), pickFrom() (+7 more)

### Community 31 - "Wind Down"
Cohesion: 0.23
Nodes (14): logInfo(), jakartaDay(), jakartaHour(), lastFired, logSleep(), readLast(), runWindDownTick(), saveLast() (+6 more)

### Community 32 - "Rolling Summary"
Cohesion: 0.21
Nodes (15): rollingSummaryEnabled(), rollingSummaryKeepRecent(), rollingSummaryTriggerChars(), buildSummarizedMessages(), cacheFile(), ChatLikeMessage, deterministicDigest(), memCache (+7 more)

### Community 33 - "Link Library"
Cohesion: 0.23
Nodes (15): addLibraryEntry(), captureLinkFromMessage(), CaptureLinkOptions, extractTitleAndText(), FetchHtml, firstUrlInText(), LIBRARY_SUMMARY_MAX, LibraryEntry (+7 more)

### Community 34 - "Empty Turn Probe"
Cohesion: 0.16
Nodes (12): main(), POST(), runtime, ChatMessage, CONFIRM_FRAME_PREFIX, runAssistantTurn(), fixAddressComma(), recordToolCall() (+4 more)

### Community 36 - "Generic API Route"
Cohesion: 0.29
Nodes (11): dynamic, GET(), POST(), authEnabled(), authToken(), bearerFrom(), isAuthorized(), isPublicPath() (+3 more)

### Community 37 - "Calendar Sync (macOS)"
Cohesion: 0.22
Nodes (9): addCalEvent(), CalEvent, calPath(), checkCalAvailability(), deleteCalEvent(), listCalEvents(), listCalText(), readCalendar() (+1 more)

### Community 38 - "Monthly Consolidate"
Cohesion: 0.27
Nodes (14): ConsolidatedMonth, consolidateUser(), DayEntry, eligibleMonths(), listSummariesForUser(), markedPath(), memoryDir(), readMarked() (+6 more)

### Community 39 - "Uploads"
Cohesion: 0.25
Nodes (14): IMAGE_EXTENSIONS, IMAGE_MIME_PREFIXES, isImageFile(), isTextFile(), metaPath(), readIndex(), readUpload(), safeFilename() (+6 more)

### Community 40 - "ai-provider Package"
Cohesion: 0.14
Nodes (13): dependencies, @voice/ai-provider, devDependencies, typescript, typescript, @voice/ai-provider, main, name (+5 more)

### Community 41 - "tsconfig (package)"
Cohesion: 0.14
Nodes (13): compilerOptions, esModuleInterop, lib, module, moduleResolution, noEmit, skipLibCheck, strict (+5 more)

### Community 42 - "STT Route"
Cohesion: 0.23
Nodes (11): dynamic, GET(), runtime, lastBriefingDay, listSkills(), loadSkills(), searchSkillsText(), SkillInfo (+3 more)

### Community 43 - "Legacy API Route Group"
Cohesion: 0.29
Nodes (10): dynamic, POST(), runtime, broadcastMiaState(), carrier(), getMiaState(), getMiaText(), getSet() (+2 more)

### Community 44 - "Voice STT Providers"
Cohesion: 0.27
Nodes (10): POST(), runtime, VALID_PROVIDERS, audioFormatFor(), extractSseText(), resolveSttProvider(), STT_PROVIDERS, SttError (+2 more)

### Community 45 - "Mac Context Capture"
Cohesion: 0.29
Nodes (11): contextSampleSeconds(), ActiveContext, activeFromOsascript(), currentContextTextFresh(), getCurrentContext(), lastFile(), parseActiveOutput(), readLast() (+3 more)

### Community 46 - "Proactive Messages"
Cohesion: 0.32
Nodes (11): buildProactiveMessage(), localDayStr(), NEGATIVE, pickFrom(), proactivePushForUser(), readState(), runProactiveNudge(), signatureOf() (+3 more)

### Community 47 - "Sandbox File Ops"
Cohesion: 0.24
Nodes (12): atomicWrite(), execSafe(), execWriteSafe(), fileEdit(), fileRead(), fileWrite(), tokenizeCommand(), allowedWorkspaces() (+4 more)

### Community 49 - "tsconfig (mock)"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, lib, module, moduleResolution, noEmit, skipLibCheck, strict (+4 more)

### Community 50 - "tsconfig (edge)"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, lib, module, moduleResolution, noEmit, skipLibCheck, strict (+4 more)

### Community 51 - "Agent Post-Processing"
Cohesion: 0.20
Nodes (11): appendTurnResult(), confirmCacheKey(), isChoppyReply(), isInternalUserTurn(), isTelegraphicReply(), memoryRecallBlock(), monitorAddAlreadyHandled(), polishReplyWithProvider() (+3 more)

### Community 52 - "Heartbeat Scheduler"
Cohesion: 0.30
Nodes (10): allUserKeys(), heartbeatMinutes(), allUserKeys(), heartbeatIntervalMs(), runHeartbeatTick(), startHeartbeat(), tick(), allUserKeys() (+2 more)

### Community 53 - "Next Instrumentation"
Cohesion: 0.35
Nodes (8): registerNode(), register(), day(), LOG_DIR(), logError(), prune(), write(), appLogKeepDays()

### Community 54 - "Spotify Intent"
Cohesion: 0.20
Nodes (10): appendSpotifyError(), scheduleSpotifyFromIntent(), spotifyPlaySuffix(), spotifyResumeSuffix(), detectSpotifyControl(), detectSpotifyIntent(), detectSpotifyResume(), SpotifyControl (+2 more)

### Community 55 - "Mala Generator"
Cohesion: 0.25
Nodes (10): buildMala(), COLORS, hashSeed(), MalaReading, MESSAGES, MOODS, mulberry32(), pick() (+2 more)

### Community 56 - "Status Report"
Cohesion: 0.31
Nodes (10): bootTime, buildStatusReport(), countTasks(), fmtClock(), fmtUptime(), noteCount(), padUploadSummary(), StatusInput (+2 more)

### Community 57 - "tsconfig (state-machine)"
Cohesion: 0.18
Nodes (10): devDependencies, typescript, typescript, main, name, private, scripts, typecheck (+2 more)

### Community 58 - "tsconfig (web/skills)"
Cohesion: 0.18
Nodes (10): devDependencies, typescript, typescript, main, name, private, scripts, typecheck (+2 more)

### Community 59 - "Web Package Root"
Cohesion: 0.20
Nodes (9): name, private, scripts, build, dev, lint, start, typecheck (+1 more)

### Community 60 - "TTS Route"
Cohesion: 0.31
Nodes (7): POST(), runtime, detectTtsModel(), GROQ_VOICES_AR, GROQ_VOICES_EN, synthesizeSpeech(), TtsError

### Community 61 - "Channel Push Targets"
Cohesion: 0.36
Nodes (9): deliver(), listChannels(), PushState, pushToOwner(), IMPORTANT: bots register from `instrumentation-node.ts` while tools dispatch, registerPushTarget(), Sender, sendToChannel() (+1 more)

### Community 62 - "Confirmation Suffixes"
Cohesion: 0.20
Nodes (9): appendDeleteSuffix(), confirmSuffixFor(), monitorAddSuffix(), reminderAddSuffix(), reminderMoveSuffix(), scheduleMonitorFromIntent(), dayRotated(), linkSavedSuffix() (+1 more)

### Community 63 - "System Prompts"
Cohesion: 0.25
Nodes (9): buildOpenCodeSystemPrompt(), buildSystemPrompt(), currentTimeLine(), discordFormatInstruction(), formatInstructionFor(), openCodeSystemPromptParts(), textFormatInstruction(), userTimezone() (+1 more)

### Community 64 - "Browser Automation"
Cohesion: 0.36
Nodes (6): browserClick(), browserNavigate(), browserOpen(), browserSnapshot(), browserType(), ensurePage()

### Community 65 - "Greeting & Mood Quality"
Cohesion: 0.29
Nodes (8): collapseRepeat(), detectGreetingTurn(), ensureMoodReplyQuality(), isColdGreetingReply(), isStructuredReply(), isThanksTurn(), reflowStructuredReply(), rewriteGenericTelegraphic()

### Community 66 - "Mood & Correction Capture"
Cohesion: 0.25
Nodes (7): ensurePlanFromIntent(), extractTopicFromContext(), logCorrection(), logMoodFromMessages(), messageText(), planCreateSuffix(), detectCorrection()

### Community 67 - "Backup"
Cohesion: 0.61
Nodes (7): backupNow(), BACKUPS_DIR(), DATA_DIR(), listBackups(), pruneOld(), restoreBackup(), walk()

### Community 68 - "Monitor Intents"
Cohesion: 0.43
Nodes (7): detectMonitorIntent(), detectMonitorIntents(), hasMonitorIntent(), labelFor(), MonitorIntent, parseThreshold(), toNumber()

### Community 69 - "Channel Chat Sessions"
Cohesion: 0.33
Nodes (6): Channel, ChatSessionState, HELP_TEXT, NormalizedMessage, VALID_PROVIDERS, ToolCall

### Community 70 - "Price Intents"
Cohesion: 0.29
Nodes (6): fmtPriceLocal(), schedulePriceFromIntent(), cryptoSubject(), detectPriceIntent(), PRICE_RE, PriceIntent

### Community 71 - "Reminder Messages"
Cohesion: 0.43
Nodes (6): BODIES, dropYa(), hasFinalYa(), pick(), reminderMessage(), TAILS

### Community 73 - "Notes Store"
Cohesion: 0.47
Nodes (6): deleteNote(), listNotes(), notesPath(), readNotes(), saveNote(), writeNotes()

### Community 74 - "User Persona Facts"
Cohesion: 0.40
Nodes (5): User fact: city=Jakarta, User fact: language=id (Indonesian), User fact: name=Naufal, User fact: plan=free, USER.md (stable user facts)

### Community 75 - "ESLint Config"
Cohesion: 0.50
Nodes (3): extends, next/core-web-vitals, next/typescript

### Community 76 - "Persona Dreams"
Cohesion: 0.50
Nodes (4): Working value: brevity (ephemeral speech), Working value: match user's language/tone, Working value: listen before lecture, Mia DREAMS (aspirations, working values)

### Community 81 - "External Agent Notes"
Cohesion: 1.00
Nodes (3): Hermes Agent, Recommended Hybrid Architecture (OpenClaw + Hermes), OpenClaw

## Knowledge Gaps
- **381 isolated node(s):** `next/core-web-vitals`, `next/typescript`, `tests`, `r1`, `path` (+376 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 471 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **22 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `main()` connect `Daily Memory` to `QA Probe Scripts`, `API Route Shells`, `Habit Tracking`, `Automation Runner`, `LLM Auto-Capture Routes`, `Codebase Index (BM25)`, `Web Search Scraper`, `Agent Calendar Tools`, `Audit Log`, `Monitors & Alerts`, `Morning Briefing`, `Sessions API / Misc`, `Conversation Manager`, `Evening Recap`, `Wind Down`, `Rolling Summary`, `Link Library`, `Mock Provider Events`, `Generic API Route`, `Monthly Consolidate`, `STT Route`, `Mac Context Capture`, `Proactive Messages`, `Sandbox File Ops`, `Heartbeat Scheduler`, `Next Instrumentation`, `Spotify Intent`, `Mala Generator`, `Monitor Intents`, `Price Intents`?**
  _High betweenness centrality (0.058) - this node is a cross-community bridge._
- **Why does `sanitizeUser()` connect `QA Probe Scripts` to `API Route Shells`, `Habit Tracking`, `Automation Runner`, `LLM Auto-Capture Routes`, `Codebase Index (BM25)`, `Web Search Scraper`, `Audit Log`, `Devices API`, `Monitors & Alerts`, `Daily Memory`, `Summarize API`, `Rolling Summary`, `Link Library`, `Calendar Sync (macOS)`, `Monthly Consolidate`, `Uploads`, `Sandbox File Ops`, `Heartbeat Scheduler`, `Status Report`?**
  _High betweenness centrality (0.050) - this node is a cross-community bridge._
- **Why does `userDataRoot()` connect `Daily Memory` to `QA Probe Scripts`, `API Route Shells`, `Habit Tracking`, `Automation Runner`, `LLM Auto-Capture Routes`, `Codebase Index (BM25)`, `Web Search Scraper`, `API Route (Legacy)`, `Devices API`, `Monitors & Alerts`, `Morning Briefing`, `Summarize API`, `Evening Recap`, `Wind Down`, `Rolling Summary`, `Link Library`, `Calendar Sync (macOS)`, `Monthly Consolidate`, `Uploads`, `STT Route`, `Proactive Messages`, `Sandbox File Ops`, `Heartbeat Scheduler`, `Status Report`?**
  _High betweenness centrality (0.045) - this node is a cross-community bridge._
- **Are the 5 inferred relationships involving `main()` (e.g. with `.finishTurn()` and `.interrupt()`) actually correct?**
  _`main()` has 5 INFERRED edges - model-reasoned connections that need verification._
- **What connects `next/core-web-vitals`, `next/typescript`, `tests` to the rest of the system?**
  _381 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `QA Probe Scripts` be split into smaller, more focused modules?**
  _Cohesion score 0.06559356136820925 - nodes in this community are weakly interconnected._
- **Should `API Route Shells` be split into smaller, more focused modules?**
  _Cohesion score 0.0625 - nodes in this community are weakly interconnected._