# Graph Report - ai-assistant  (2026-09-14)

## Corpus Check
- 156 files · ~150,513 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1731 nodes · 4163 edges · 112 communities (83 shown, 24 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 12 edges (avg confidence: 0.81)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- LLM Request Pipeline
- Spotify Auth
- Mock AI Provider
- Runtime Bootstrap
- ByteRover Search
- Summarize Pro
- Tool Registry & Notes
- Persona & Auto Memory
- Codebase Index & RAG
- Agent Turn Core
- Assistant Chat UI
- Habits & Weekly Insight
- Automations & Reminders
- Gmail Integration
- Discord Channel
- TSConfig Dependencies
- Voice Turn Manager
- Conversation State Machine
- Webhook & LLM Route
- Telegram Channel
- Device Control
- Reply Polishing
- Heartbeat & Health
- Voice Hook & Providers
- Monitors & Alerts
- Conversation Manager
- Morning Briefing
- Humanizer
- Web Dev Dependencies
- Multi-Session Store
- Rolling Summary
- Reminder Store & Delivery
- Browser-Use Automation
- Proactive Nudges
- Mock Package
- Spotify Intents
- Reading Library
- Link Capture
- CUA Native GUI
- Auth Middleware
- Calendar
- Monthly Consolidation
- Plans
- Uploads
- Reminder Confirm Wording
- Clawic Memory
- Mock Package Config
- Mock TSConfig
- Mia State API
- STT API
- Reply Collapse
- Recap Config
- Health Tracker
- Provider Resolver
- Waze Routing
- AI Provider Config
- State Machine Config
- Reminder SSE Stream
- Learning Log
- Reminder Scheduling
- Mala AI
- AI Provider Package
- State Machine Package
- Web Package Config
- Auto-Turn Manager
- TTS API
- Landing Page
- Mood Tracking
- Headless Browser
- Weather
- Daily Memory
- Monitor Intents
- Cross-Channel Agent
- Reminder Wording
- Audio Capture
- Audio Player
- Correction Tracking
- Hotel Search
- Turn Stats
- Persona Facts
- Reminder Variants
- ESLint Config
- Persona Dreams
- Persona Identity
- App Layout
- Place Check Intent
- Waze CLI
- Next Config
- PostCSS Config
- Login Page
- Gitignore
- Hotel CLI
- Next Env Types
- Dep: clsx
- Dep: discord.js
- Dep: next
- Dep: ogl
- Dep: radix-slot
- Dep: react
- Dep: tailwind-merge
- Dep: tailwind-animate
- SafeExec CLI
- SafeExec Approve
- SafeExec List
- SafeExec Reject
- Weather CLI
- Skills Sample

## God Nodes (most connected - your core abstractions)
1. `sanitizeUser()` - 97 edges
2. `userDataRoot()` - 67 edges
3. `main()` - 66 edges
4. `runAssistantTurnImpl()` - 52 edges
5. `appRoot()` - 38 edges
6. `GroqStreamingProvider` - 31 edges
7. `logInfo()` - 30 edges
8. `ConversationManager` - 28 edges
9. `runAutoUpdate()` - 24 edges
10. `execBrv()` - 23 edges

## Surprising Connections (you probably didn't know these)
- `ConversationManager` --references--> `AIProvider`  [EXTRACTED]
  apps/web/src/ai/ConversationManager.ts → packages/ai-provider/src/index.ts
- `ConversationManager` --references--> `ConversationStateMachine`  [EXTRACTED]
  apps/web/src/ai/ConversationManager.ts → packages/state-machine/src/index.ts
- `GroqStreamingProvider` --references--> `ConversationMessage`  [EXTRACTED]
  apps/web/src/ai/GroqStreamingProvider.ts → packages/ai-provider/src/index.ts
- `AIChatCardProps` --references--> `ConfirmationRequest`  [EXTRACTED]
  apps/web/src/components/ui/ai-chat.tsx → packages/ai-provider/src/index.ts
- `UseVoiceResult` --references--> `ConfirmationRequest`  [EXTRACTED]
  apps/web/src/hooks/useVoice.ts → packages/ai-provider/src/index.ts

## Import Cycles
- None detected.

## Communities (112 total, 24 thin omitted)

### Community 0 - "LLM Request Pipeline"
Cohesion: 0.06
Nodes (75): GET(), runtime, CONFIRM_FRAME_PREFIX, day(), LOG_DIR(), logError(), logInfo(), prune() (+67 more)

### Community 1 - "Spotify Auth"
Cohesion: 0.06
Nodes (60): dynamic, GET(), runtime, dynamic, GET(), runtime, answerMatches(), artistLastTokens() (+52 more)

### Community 2 - "Mock AI Provider"
Cohesion: 0.06
Nodes (12): GroqStreamingProvider, stripEmojiForSpeech(), AIChatCardProps, AIProvider, ConfirmationRequest, MessageRole, MockProviderLike, ProviderEvent (+4 more)

### Community 3 - "Runtime Bootstrap"
Cohesion: 0.06
Nodes (52): registerNode(), register(), backupNow(), BACKUPS_DIR(), DATA_DIR(), listBackups(), pruneOld(), restoreBackup() (+44 more)

### Community 4 - "ByteRover Search"
Cohesion: 0.08
Nodes (53): brvBin(), brvCurate(), brvCurateView(), brvCwd(), brvLocations(), brvProvidersList(), brvQuery(), brvQueryLogSummary() (+45 more)

### Community 5 - "Summarize Pro"
Cohesion: 0.09
Nodes (52): atomicWrite(), countWords(), createTemplate(), defaultSettings(), detectFormat(), ensureDir(), getSavedSummaries(), getStats() (+44 more)

### Community 6 - "Tool Registry & Notes"
Cohesion: 0.07
Nodes (44): atomicWrite(), buildGnLangs(), cleanSearchQuery(), cleanUrl(), deleteNote(), DENY_PATTERNS, DENY_SEGMENTS, EXEC_ALLOWLIST (+36 more)

### Community 7 - "Persona & Auto Memory"
Cohesion: 0.08
Nodes (38): POST(), runtime, CaptureArgs, captureFactsFromTurn(), contentToText(), EXTRACT_PROMPT, extractFactsOpenAi(), extractFactsOpenCode() (+30 more)

### Community 8 - "Codebase Index & RAG"
Cohesion: 0.11
Nodes (38): buildIndexFromRoots(), chunkText(), CodeIndex, currentIndex(), ensureFreshIndex(), GlobalCarrier, indexFile(), indexSummary() (+30 more)

### Community 9 - "Agent Turn Core"
Cohesion: 0.07
Nodes (38): buildOpenCodeSystemPrompt(), buildSystemPrompt(), CAL_TITLE_STOP_WORDS, cleanCalendarTitle(), confirmExecuted, ContentPart, currentTimeLine(), discordFormatInstruction() (+30 more)

### Community 10 - "Assistant Chat UI"
Cohesion: 0.08
Nodes (22): AIChatCard(), AIChatMessage, CARD_PARTICLES, Attachment, AttachmentGalleryModal(), AttachmentThumb(), ModelIcon(), PromptInput (+14 more)

### Community 11 - "Habits & Weekly Insight"
Cohesion: 0.11
Nodes (32): Habit, HabitLog, habitsPath(), habitStats(), logHabit(), readHabits(), todayStr(), writeHabits() (+24 more)

### Community 12 - "Automations & Reminders"
Cohesion: 0.13
Nodes (28): addAutomation(), AutomationListener, AutomationSchedule, automationsPath(), broadcastDue(), describeSchedule(), ensureTimer(), listAutomationsText() (+20 more)

### Community 13 - "Gmail Integration"
Cohesion: 0.12
Nodes (26): dynamic, GET(), runtime, dynamic, GET(), runtime, clearGmailToken(), decodeBase64Url() (+18 more)

### Community 14 - "Discord Channel"
Cohesion: 0.15
Nodes (24): ALLOWED_CHANNEL_IDS, ALLOWED_USER_IDS, ChatState, handleCommand(), handleConfirmation(), isAllowedChannel(), isAllowedMessage(), isAllowedUser() (+16 more)

### Community 15 - "TSConfig Dependencies"
Cohesion: 0.07
Nodes (26): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+18 more)

### Community 17 - "Conversation State Machine"
Cohesion: 0.11
Nodes (14): ConversationEvent, ConversationListener, nextId(), TranscriptEntry, ConversationStateMachine, Event, State, STATES (+6 more)

### Community 18 - "Webhook & LLM Route"
Cohesion: 0.14
Nodes (21): POST(), dynamic, POST(), runtime, deliver(), listChannels(), PushState, pushToOwner() (+13 more)

### Community 19 - "Telegram Channel"
Cohesion: 0.16
Nodes (22): TELEGRAM_MAX, ALLOWED_USER_IDS, ALLOWED_USERNAMES, ChatState, handleConfirmation(), isAllowedUser(), isMarkdownEntityError(), pushTarget() (+14 more)

### Community 20 - "Device Control"
Cohesion: 0.19
Nodes (21): dynamic, GET(), POST(), runtime, Device, deviceBattery(), deviceCamera(), DeviceCapability (+13 more)

### Community 21 - "Reply Polishing"
Cohesion: 0.11
Nodes (22): appendTurnResult(), confirmCacheKey(), extractRetryAfterMs(), isChoppyReply(), isInternalUserTurn(), isTelegraphicReply(), lastUserContent(), memoryRecallBlock() (+14 more)

### Community 22 - "Heartbeat & Health"
Cohesion: 0.19
Nodes (18): dynamic, GET(), runtime, allUserKeys(), lastBriefingDay, allUserKeys(), heartbeatIntervalMs(), runHeartbeatTick() (+10 more)

### Community 23 - "Voice Hook & Providers"
Cohesion: 0.16
Nodes (20): apiDeleteSession(), apiListSessions(), apiLoadSession(), apiUpsertSession(), historyUser(), loadHistory(), loadSettings(), PersistedSettings (+12 more)

### Community 24 - "Monitors & Alerts"
Cohesion: 0.18
Nodes (21): checkMonitorsAndAlert(), COINGECKO_ALIASES, cpRun, DEVICE_SUBJECTS, evaluateAlert(), fetchCryptoUsd(), fetchDeviceMetric(), fetchPrice() (+13 more)

### Community 26 - "Morning Briefing"
Cohesion: 0.20
Nodes (17): buildMorningBriefing(), greetingFor(), holidayToday(), localDayJkt(), localHourJkt(), pickFrom(), runBriefingTick(), saveBriefingDay() (+9 more)

### Community 27 - "Humanizer"
Cohesion: 0.18
Nodes (19): atomicWrite(), countWords(), detectPatterns(), deterministicHumanize(), DIR, ensureDir(), getHumanizerHistory(), getHumanizerStats() (+11 more)

### Community 28 - "Web Dev Dependencies"
Cohesion: 0.11
Nodes (19): devDependencies, autoprefixer, eslint, eslint-config-next, postcss, tailwindcss, @types/node, @types/react (+11 more)

### Community 29 - "Multi-Session Store"
Cohesion: 0.27
Nodes (17): DELETE(), dynamic, GET(), POST(), runtime, deleteSession(), indexPath(), listSessions() (+9 more)

### Community 30 - "Rolling Summary"
Cohesion: 0.18
Nodes (17): rollingSummaryEnabled(), rollingSummaryKeepRecent(), rollingSummaryTriggerChars(), ensureOpenCodeGoKey(), buildSummarizedMessages(), cacheFile(), ChatLikeMessage, deterministicDigest() (+9 more)

### Community 31 - "Reminder Store & Delivery"
Cohesion: 0.25
Nodes (18): attachVariants(), broadcastDue(), deleteReminders(), deleteRemindersAtTime(), ensureTimer(), listeners, listUsersWithReminders(), moveReminder() (+10 more)

### Community 32 - "Browser-Use Automation"
Cohesion: 0.23
Nodes (17): assertPublicUrl(), buClick(), buClose(), buDoctor(), buEval(), buGet(), buInput(), buKeys() (+9 more)

### Community 33 - "Proactive Nudges"
Cohesion: 0.23
Nodes (16): proactiveEnabled(), proactiveHourEnd(), proactiveHourStart(), buildProactiveMessage(), isWakingHour(), localDayStr(), localHourJkt(), NEGATIVE (+8 more)

### Community 34 - "Mock Package"
Cohesion: 0.12
Nodes (17): @ai-provider/mock, dependencies, @ai-provider/mock, class-variance-authority, framer-motion, grammy, lucide-react, react-dom (+9 more)

### Community 35 - "Spotify Intents"
Cohesion: 0.13
Nodes (16): appendSpotifyError(), confirmSuffixFor(), playedLabel(), scheduleSpotifyControlFromIntent(), scheduleSpotifyFromIntent(), spotifyPlaySuffix(), spotifyResumeSuffix(), spotifySetVolume() (+8 more)

### Community 36 - "Reading Library"
Cohesion: 0.18
Nodes (16): CaptureLinkOptions, defaultFetchHtml(), extractTitleAndText(), FetchHtml, LIBRARY_SUMMARY_MAX, LibraryEntry, LINK_SAVED_LINES, linkSavedSuffix() (+8 more)

### Community 37 - "Link Capture"
Cohesion: 0.22
Nodes (13): addLibraryEntry(), captureLinkFromMessage(), firstUrlInText(), scheduleLinkCapture(), PRICE_RE, PriceIntent, readLastRecapDay(), recapStateFile() (+5 more)

### Community 38 - "CUA Native GUI"
Cohesion: 0.33
Nodes (15): cuaBrowserClick(), cuaBrowserNavigate(), cuaBrowserType(), cuaClick(), cuaClickXY(), cuaDoctor(), cuaGetBrowserState(), cuaLaunch() (+7 more)

### Community 39 - "Auth Middleware"
Cohesion: 0.29
Nodes (11): dynamic, GET(), POST(), authEnabled(), authToken(), bearerFrom(), isAuthorized(), isPublicPath() (+3 more)

### Community 40 - "Calendar"
Cohesion: 0.22
Nodes (9): addCalEvent(), CalEvent, calPath(), checkCalAvailability(), deleteCalEvent(), listCalEvents(), listCalText(), readCalendar() (+1 more)

### Community 41 - "Monthly Consolidation"
Cohesion: 0.27
Nodes (14): ConsolidatedMonth, consolidateUser(), DayEntry, eligibleMonths(), listSummariesForUser(), markedPath(), memoryDir(), readMarked() (+6 more)

### Community 42 - "Plans"
Cohesion: 0.27
Nodes (13): addPlanStep(), createPlan(), listPlanFiles(), listPlansText(), Plan, planPath(), plansDir(), PlanStep (+5 more)

### Community 43 - "Uploads"
Cohesion: 0.25
Nodes (14): IMAGE_EXTENSIONS, IMAGE_MIME_PREFIXES, isImageFile(), isTextFile(), metaPath(), readIndex(), readUpload(), safeFilename() (+6 more)

### Community 44 - "Reminder Confirm Wording"
Cohesion: 0.20
Nodes (13): appendDeleteSuffix(), buildReminderList(), ensurePlanFromIntent(), extractTopicFromContext(), messageText(), monitorAddSuffix(), planCreateSuffix(), reminderAddSuffix() (+5 more)

### Community 45 - "Clawic Memory"
Cohesion: 0.34
Nodes (13): cfgPath(), ensureRoot(), forget(), indexPath(), isSecret(), memoryStats(), memRoot(), recall() (+5 more)

### Community 46 - "Mock Package Config"
Cohesion: 0.14
Nodes (13): dependencies, @voice/ai-provider, devDependencies, typescript, typescript, @voice/ai-provider, main, name (+5 more)

### Community 47 - "Mock TSConfig"
Cohesion: 0.14
Nodes (13): compilerOptions, esModuleInterop, lib, module, moduleResolution, noEmit, skipLibCheck, strict (+5 more)

### Community 48 - "Mia State API"
Cohesion: 0.29
Nodes (10): dynamic, POST(), runtime, broadcastMiaState(), carrier(), getMiaState(), getMiaText(), getSet() (+2 more)

### Community 49 - "STT API"
Cohesion: 0.27
Nodes (10): POST(), runtime, VALID_PROVIDERS, audioFormatFor(), extractSseText(), resolveSttProvider(), STT_PROVIDERS, SttError (+2 more)

### Community 50 - "Reply Collapse"
Cohesion: 0.18
Nodes (12): collapseRepeat(), detectGreetingTurn(), ensureMoodReplyQuality(), isColdGreetingReply(), isStructuredReply(), isThanksTurn(), logMoodFromMessages(), reflowStructuredReply() (+4 more)

### Community 51 - "Recap Config"
Cohesion: 0.31
Nodes (11): recapHour(), buildEveningRecap(), cleanSnippets(), isJunkLine(), lastRecapDay, localDay(), pickFrom(), runRecapTick() (+3 more)

### Community 52 - "Health Tracker"
Cohesion: 0.32
Nodes (12): addSleep(), addWake(), addWater(), HealthData, healthDeleteLast(), healthStats(), healthUpdateLast(), pathFor() (+4 more)

### Community 53 - "Provider Resolver"
Cohesion: 0.27
Nodes (12): isProviderId(), resolveProvider(), bootTime, buildStatusReport(), countTasks(), fmtClock(), fmtUptime(), noteCount() (+4 more)

### Community 54 - "Waze Routing"
Cohesion: 0.26
Nodes (11): Coords, fetchOsrm(), fetchWaze(), geocode(), getWazeRoute(), parseLatLon(), parseWazeJson(), parseWazeXml() (+3 more)

### Community 55 - "AI Provider Config"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, lib, module, moduleResolution, noEmit, skipLibCheck, strict (+4 more)

### Community 56 - "State Machine Config"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, lib, module, moduleResolution, noEmit, skipLibCheck, strict (+4 more)

### Community 57 - "Reminder SSE Stream"
Cohesion: 0.24
Nodes (8): dynamic, GET(), runtime, checkRateLimit(), hits, limitPerMinute(), RateLimitError, Reminder

### Community 58 - "Learning Log"
Cohesion: 0.38
Nodes (11): logCorrection(), append(), ensureDir(), learningsDir(), listLearnings(), logError(), logFeatureRequest(), logLearning() (+3 more)

### Community 59 - "Reminder Scheduling"
Cohesion: 0.36
Nodes (11): addReminder(), addTask(), indexOfNumber(), listTasks(), readTasks(), rescheduleTask(), setTaskStatus(), Task (+3 more)

### Community 60 - "Mala AI"
Cohesion: 0.25
Nodes (10): buildMala(), COLORS, hashSeed(), MalaReading, MESSAGES, MOODS, mulberry32(), pick() (+2 more)

### Community 61 - "AI Provider Package"
Cohesion: 0.18
Nodes (10): devDependencies, typescript, typescript, main, name, private, scripts, typecheck (+2 more)

### Community 62 - "State Machine Package"
Cohesion: 0.18
Nodes (10): devDependencies, typescript, typescript, main, name, private, scripts, typecheck (+2 more)

### Community 63 - "Web Package Config"
Cohesion: 0.20
Nodes (9): name, private, scripts, build, dev, lint, start, typecheck (+1 more)

### Community 64 - "Auto-Turn Manager"
Cohesion: 0.24
Nodes (4): VADMode, VADCallbacks, VADOptions, VoiceActivityDetector

### Community 65 - "TTS API"
Cohesion: 0.31
Nodes (7): POST(), runtime, detectTtsModel(), GROQ_VOICES_AR, GROQ_VOICES_EN, synthesizeSpeech(), TtsError

### Community 66 - "Landing Page"
Cohesion: 0.36
Nodes (7): Home(), STATE_HUES, FloatingParticles(), mulberry32(), PARTICLE_CONFIGS, SignInForm(), useAuth()

### Community 67 - "Mood Tracking"
Cohesion: 0.36
Nodes (9): addMood(), listMoods(), Mood, MOOD_VALUES, moodsPath(), moodTrend(), normalizeMood(), readMoods() (+1 more)

### Community 68 - "Headless Browser"
Cohesion: 0.36
Nodes (6): browserClick(), browserNavigate(), browserOpen(), browserSnapshot(), browserType(), ensurePage()

### Community 69 - "Weather"
Cohesion: 0.36
Nodes (8): fetchOpenMeteo(), fetchWttr(), geocode(), getWeather(), humanize(), parseLatLon(), WeatherResult, WMO

### Community 70 - "Daily Memory"
Cohesion: 0.54
Nodes (7): appendDailyMemory(), dailyMemoryPath(), listDailyMemories(), loadDailyMemoryPrompt(), memoryDir(), readDailyMemory(), todayStr()

### Community 71 - "Monitor Intents"
Cohesion: 0.43
Nodes (7): detectMonitorIntent(), detectMonitorIntents(), hasMonitorIntent(), labelFor(), MonitorIntent, parseThreshold(), toNumber()

### Community 72 - "Cross-Channel Agent"
Cohesion: 0.33
Nodes (6): Channel, ChatSessionState, HELP_TEXT, NormalizedMessage, VALID_PROVIDERS, ToolCall

### Community 73 - "Reminder Wording"
Cohesion: 0.43
Nodes (6): BODIES, dropYa(), hasFinalYa(), pick(), reminderMessage(), TAILS

### Community 74 - "Audio Capture"
Cohesion: 0.33
Nodes (5): AudioCaptureListener, AudioCaptureState, UseVoiceResult, Session, SessionMeta

### Community 76 - "Correction Tracking"
Cohesion: 0.60
Nodes (5): addCorrection(), Correction, correctionsPath(), readCorrections(), writeCorrections()

### Community 77 - "Hotel Search"
Cohesion: 0.53
Nodes (5): fmtRp(), getHotels(), Hotel, parseBudget(), todayTomorrow()

### Community 78 - "Turn Stats"
Cohesion: 0.33
Nodes (5): recordToolCall(), recordTurn(), stats, TurnStatEntry, TurnStats

### Community 79 - "Persona Facts"
Cohesion: 0.40
Nodes (5): User fact: city=Jakarta, User fact: language=id (Indonesian), User fact: name=Naufal, User fact: plan=free, USER.md (stable user facts)

### Community 80 - "Reminder Variants"
Cohesion: 0.50
Nodes (4): enrichReminderVariants(), parseVariantLines(), ReminderProvider, VARIANT_PROMPT

### Community 81 - "ESLint Config"
Cohesion: 0.50
Nodes (3): extends, next/core-web-vitals, next/typescript

### Community 82 - "Persona Dreams"
Cohesion: 0.50
Nodes (4): Working value: brevity (ephemeral speech), Working value: match user's language/tone, Working value: listen before lecture, Mia DREAMS (aspirations, working values)

### Community 83 - "Persona Identity"
Cohesion: 0.50
Nodes (4): Mia Identity (IDENTITY.md), Mia Soul & Style (SOUL.md), Mia avatar illustration (anime woman, long dark wavy hair, glasses, white top), Avatar visual concepts: anime illustration, long dark wavy hair, glasses, white top, female persona

### Community 85 - "Place Check Intent"
Cohesion: 0.67
Nodes (3): schedulePlaceCheckFromIntent(), detectPlaceIntent(), placeNudge()

### Community 86 - "Waze CLI"
Cohesion: 1.00
Nodes (3): geocode(), is_latlon(), waze.sh script

## Knowledge Gaps
- **403 isolated node(s):** `next/core-web-vitals`, `next/typescript`, `git.sh script`, `hotel.sh script`, `path` (+398 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 502 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **24 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `main()` connect `Link Capture` to `LLM Request Pipeline`, `Spotify Auth`, `Mock AI Provider`, `Runtime Bootstrap`, `ByteRover Search`, `Tool Registry & Notes`, `Persona & Auto Memory`, `Codebase Index & RAG`, `Agent Turn Core`, `Habits & Weekly Insight`, `Automations & Reminders`, `Reply Polishing`, `Heartbeat & Health`, `Voice Hook & Providers`, `Monitors & Alerts`, `Conversation Manager`, `Morning Briefing`, `Rolling Summary`, `Reminder Store & Delivery`, `Proactive Nudges`, `Spotify Intents`, `Reading Library`, `Auth Middleware`, `Monthly Consolidation`, `Recap Config`, `Reminder Scheduling`, `Mala AI`, `Mood Tracking`, `Daily Memory`, `Monitor Intents`, `Reminder Variants`, `Place Check Intent`?**
  _High betweenness centrality (0.062) - this node is a cross-community bridge._
- **Why does `sanitizeUser()` connect `Reminder Store & Delivery` to `LLM Request Pipeline`, `Spotify Auth`, `Tool Registry & Notes`, `Persona & Auto Memory`, `Codebase Index & RAG`, `Habits & Weekly Insight`, `Automations & Reminders`, `Device Control`, `Reply Polishing`, `Heartbeat & Health`, `Monitors & Alerts`, `Multi-Session Store`, `Rolling Summary`, `Reading Library`, `Link Capture`, `Calendar`, `Monthly Consolidation`, `Plans`, `Uploads`, `Reminder Confirm Wording`, `Health Tracker`, `Provider Resolver`, `Reminder SSE Stream`, `Reminder Scheduling`, `Mood Tracking`, `Daily Memory`, `Correction Tracking`?**
  _High betweenness centrality (0.054) - this node is a cross-community bridge._
- **Why does `userDataRoot()` connect `Heartbeat & Health` to `Spotify Auth`, `Runtime Bootstrap`, `Tool Registry & Notes`, `Persona & Auto Memory`, `Codebase Index & RAG`, `Habits & Weekly Insight`, `Automations & Reminders`, `Gmail Integration`, `Device Control`, `Monitors & Alerts`, `Morning Briefing`, `Multi-Session Store`, `Rolling Summary`, `Reminder Store & Delivery`, `Proactive Nudges`, `Reading Library`, `Link Capture`, `Calendar`, `Monthly Consolidation`, `Plans`, `Uploads`, `Recap Config`, `Health Tracker`, `Provider Resolver`, `Reminder Scheduling`, `Mood Tracking`, `Daily Memory`, `Correction Tracking`?**
  _High betweenness centrality (0.040) - this node is a cross-community bridge._
- **Are the 5 inferred relationships involving `main()` (e.g. with `.finishTurn()` and `.interrupt()`) actually correct?**
  _`main()` has 5 INFERRED edges - model-reasoned connections that need verification._
- **What connects `next/core-web-vitals`, `next/typescript`, `git.sh script` to the rest of the system?**
  _403 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `LLM Request Pipeline` be split into smaller, more focused modules?**
  _Cohesion score 0.06196213425129088 - nodes in this community are weakly interconnected._
- **Should `Spotify Auth` be split into smaller, more focused modules?**
  _Cohesion score 0.06299603174603174 - nodes in this community are weakly interconnected._