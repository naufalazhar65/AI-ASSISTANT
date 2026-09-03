# Graph Report - ai-assistant  (2026-09-03)

## Corpus Check
- 720 files · ~0 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 720 nodes · 1055 edges · 61 communities (47 shown, 14 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Audio & Turn Pipeline
- Persona & Memory Types
- Tools & Reminders
- AI Provider Package
- Chat Input & Attachments
- PRD Architecture & Transport
- Web Runtime Dependencies
- Web DevDependencies
- Web TypeScript Config
- Groq Streaming Provider
- Conversation Manager
- LLM Agent & Automemory
- Sessions & Persistence
- State Machine
- Test Tooling (vitest)
- Provider Event Types
- Mock Provider tsconfig
- AI Provider tsconfig
- State Machine tsconfig
- Project Docs (AGENTS)
- AIProvider Abstraction
- Chat Card UI
- Mock Provider
- PRD User Stories
- PRD Acceptance Criteria
- PRD Edge Cases
- PRD Product Goals
- PRD UI/UX
- PRD Risks
- Transcript UI
- TTS Route & Voices
- PRD Error Handling
- PRD QA Strategy
- PRD Roadmap
- PRD Future Features
- ESLint Config
- Root Layout & Viewport
- PRD Tech Stack
- PRD Analytics
- PRD MVP Scope
- PRD Memory
- PRD Success Criteria
- Next.js Config
- Persona Identity
- STT Route
- PRD Latency
- PRD Privacy
- PRD Overview
- PRD AI Quality
- PRD Target Users
- PRD Conversation Model
- Next Env Types
- Persona Dreams
- Persona Soul
- Persona User Data
- PostCSS Config
- PRD Audio Testing
- README
- Tailwind Config JS
- Tailwind Config TS
- Vitest Config

## God Nodes (most connected - your core abstractions)
1. `GroqStreamingProvider` - 29 edges
2. `ConversationManager` - 27 edges
3. `AudioCapture` - 20 edges
4. `AIProvider` - 20 edges
5. `useVoice()` - 20 edges
6. `sanitizeUser()` - 18 edges
7. `MockProvider` - 17 edges
8. `8. Functional Requirements` - 17 edges
9. `compilerOptions` - 16 edges
10. `executeTool()` - 14 edges

## Surprising Connections (you probably didn't know these)
- `UseVoiceResult` --references--> `ConfirmationRequest`  [EXTRACTED]
  apps/web/src/hooks/useVoice.ts → packages/ai-provider/src/index.ts
- `UseVoiceResult` --references--> `State`  [EXTRACTED]
  apps/web/src/hooks/useVoice.ts → packages/state-machine/src/index.ts
- `ConversationManager` --references--> `ConversationStateMachine`  [EXTRACTED]
  apps/web/src/ai/ConversationManager.ts → packages/state-machine/src/index.ts
- `ConversationManager` --references--> `AIProvider`  [EXTRACTED]
  apps/web/src/ai/ConversationManager.ts → packages/ai-provider/src/index.ts
- `GroqStreamingProvider` --implements--> `AIProvider`  [EXTRACTED]
  apps/web/src/ai/GroqStreamingProvider.ts → packages/ai-provider/src/index.ts

## Import Cycles
- None detected.

## Communities (61 total, 14 thin omitted)

### Community 0 - "Audio & Turn Pipeline"
Cohesion: 0.06
Nodes (31): AutoTurnManager.ts, AutoTurnManager, VADMode, AudioCapture.ts, AudioCapture, AudioCaptureListener, AudioCaptureState, AudioPlayer.ts (+23 more)

### Community 1 - "Persona & Memory Types"
Cohesion: 0.07
Nodes (54): llm/route.ts, buildOpenCodeSystemPrompt(), buildSystemPrompt(), ChatMessage, OPENCODE_SYSTEM_PROMPT, POST(), runAgent(), runOneCompletion() (+46 more)

### Community 2 - "Tools & Reminders"
Cohesion: 0.10
Nodes (45): stream/route.ts, dynamic, GET(), runtime, reminders.ts, addReminder(), broadcastDue(), ensureTimer() (+37 more)

### Community 3 - "AI Provider Package"
Cohesion: 0.06
Nodes (36): @voice/ai-provider, typescript, typescript, @voice/ai-provider, ai-provider/package.json, devDependencies, typescript, main (+28 more)

### Community 4 - "Chat Input & Attachments"
Cohesion: 0.09
Nodes (29): page.tsx, Home(), STATE_HUES, FloatingParticles.tsx, FloatingParticles(), mulberry32(), PARTICLE_CONFIGS, SignInForm.tsx (+21 more)

### Community 5 - "PRD Architecture & Transport"
Cohesion: 0.07
Nodes (28): PRD_Real-Time_Voice_AI_Assistant.md, 10. Conversation State Machine, 11. Technical Architecture, 13. Real-Time Transport, 14. Audio Pipeline, 15. Audio Requirements, 18. Security Requirements, 20. Observability (+20 more)

### Community 6 - "Web Runtime Dependencies"
Cohesion: 0.07
Nodes (27): @ai-provider/mock, dependencies, @ai-provider/mock, class-variance-authority, clsx, framer-motion, lucide-react, next (+19 more)

### Community 7 - "Web DevDependencies"
Cohesion: 0.07
Nodes (27): web/package.json, devDependencies, autoprefixer, eslint, eslint-config-next, postcss, tailwindcss, @types/node (+19 more)

### Community 8 - "Web TypeScript Config"
Cohesion: 0.07
Nodes (27): web/tsconfig.json, compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib (+19 more)

### Community 10 - "Conversation Manager"
Cohesion: 0.17
Nodes (5): ConversationManager, nextId(), web/verify.ts, delay(), main()

### Community 11 - "LLM Agent & Automemory"
Cohesion: 0.10
Nodes (22): 8. Functional Requirements, Acceptance Requirement, FR-001 — Voice Input, FR-002 — Voice Activity Detection, FR-003 — Streaming Speech-to-Text, FR-004 — LLM Processing, FR-005 — Streaming AI Response, FR-006 — Streaming Text-to-Speech (+14 more)

### Community 12 - "Sessions & Persistence"
Cohesion: 0.27
Nodes (19): sessions/route.ts, DELETE(), dynamic, GET(), POST(), runtime, sessions.ts, deleteSession() (+11 more)

### Community 13 - "State Machine"
Cohesion: 0.14
Nodes (13): state-machine/src/index.ts, ConversationStateMachine, Event, State, STATES, index.test.ts, Transition, TRANSITIONS (+5 more)

### Community 14 - "Test Tooling (vitest)"
Cohesion: 0.12
Nodes (16): package.json, devDependencies, vitest, name, private, scripts, build, dev (+8 more)

### Community 15 - "Provider Event Types"
Cohesion: 0.21
Nodes (9): GroqStreamingProvider.ts, ai-provider/src/index.ts, ConversationMessage, MessageRole, ProviderEvent, ProviderEventListener, SendResult, ToolDefinition (+1 more)

### Community 16 - "Mock Provider tsconfig"
Cohesion: 0.14
Nodes (14): mock-provider/tsconfig.json, compilerOptions, esModuleInterop, lib, module, moduleResolution, noEmit, skipLibCheck (+6 more)

### Community 17 - "AI Provider tsconfig"
Cohesion: 0.15
Nodes (13): ai-provider/tsconfig.json, compilerOptions, esModuleInterop, lib, module, moduleResolution, noEmit, skipLibCheck (+5 more)

### Community 18 - "State Machine tsconfig"
Cohesion: 0.15
Nodes (13): state-machine/tsconfig.json, compilerOptions, esModuleInterop, lib, module, moduleResolution, noEmit, skipLibCheck (+5 more)

### Community 19 - "Project Docs (AGENTS)"
Cohesion: 0.17
Nodes (12): AGENTS.md, Commands (npm workspaces at repo root), Critical architecture decisions (from PRD), Gotchas, Key invariants to preserve, Persona & long-term memory, Project status, Provider (free Groq tier) (+4 more)

### Community 21 - "Chat Card UI"
Cohesion: 0.25
Nodes (10): ai-chat.tsx, AIChatCard(), AIChatCardProps, AIChatMessage, CARD_PARTICLES, mulberry32(), renderContent(), renderInline() (+2 more)

### Community 23 - "PRD User Stories"
Cohesion: 0.20
Nodes (10): 23. User Stories, US-001 — Voice Input, US-002 — Streaming Response, US-003 — Interrupt, US-004 — Context, US-005 — Transcript, US-006 — Voice, US-007 — Text Fallback (+2 more)

### Community 24 - "PRD Acceptance Criteria"
Cohesion: 0.25
Nodes (8): 24. Acceptance Criteria, AC-001 — Voice Input, AC-002 — Voice Turn Completion, AC-003 — AI Response, AC-004 — Interrupt, AC-005 — Context, AC-006 — Text Fallback, AC-007 — Privacy

### Community 25 - "PRD Edge Cases"
Cohesion: 0.25
Nodes (8): 31.1 User Says Nothing, 31.2 Very Short Utterance, 31.3 User Speaks While AI Speaks, 31.4 Rapid Corrections, 31.5 Network Disconnect, 31.6 AI Generates Too Much Text, 31.7 User Changes Topic, 31. Edge Cases

### Community 26 - "PRD Product Goals"
Cohesion: 0.25
Nodes (8): 3.1 Primary Goals, 3.2 Secondary Goals, 3. Product Goals, Context-aware, Fast, Interactive, Natural, Reliable

### Community 27 - "PRD UI/UX"
Cohesion: 0.25
Nodes (8): 9.1 Main Screen, 9.2 Voice Orb, 9.3 UI State Labels, 9. UI/UX Requirements, Idle, Listening, Speaking, Thinking

### Community 28 - "PRD Risks"
Cohesion: 0.29
Nodes (7): 41. Risks, R-001 — High Latency, R-002 — Bad Speech Recognition, R-003 — Poor Interruption, R-004 — Cost, R-005 — Privacy, R-006 — Tool Abuse

### Community 29 - "Transcript UI"
Cohesion: 0.40
Nodes (5): ConversationManager.ts, ConversationEvent, ConversationListener, TranscriptEntry, Transcript.tsx

### Community 30 - "TTS Route & Voices"
Cohesion: 0.40
Nodes (6): tts/route.ts, detectModel(), GROQ_VOICES_AR, GROQ_VOICES_EN, POST(), runtime

### Community 31 - "PRD Error Handling"
Cohesion: 0.33
Nodes (6): 17.1 Microphone Denied, 17.2 Connection Lost, 17.3 AI Timeout, 17.4 TTS Failure, 17.5 Invalid Audio Device, 17. Error Handling

### Community 32 - "PRD QA Strategy"
Cohesion: 0.33
Nodes (6): 25.1 Functional Testing, 25.2 Compatibility Testing, 25. QA Test Strategy, Audio Devices, Desktop, Mobile

### Community 33 - "PRD Roadmap"
Cohesion: 0.33
Nodes (6): 36. Development Roadmap, Phase 1 — Foundation, Phase 2 — Real-Time Voice, Phase 3 — Natural Conversation, Phase 4 — Assistant Capabilities, Phase 5 — AI Agent

### Community 34 - "PRD Future Features"
Cohesion: 0.33
Nodes (6): 40. Future Feature Roadmap, Computer Control, Developer Tools, Productivity, Smart Environment, Voice Intelligence

### Community 35 - "ESLint Config"
Cohesion: 0.50
Nodes (4): .eslintrc.json, extends, next/core-web-vitals, next/typescript

### Community 36 - "Root Layout & Viewport"
Cohesion: 0.50
Nodes (3): layout.tsx, metadata, viewport

### Community 37 - "PRD Tech Stack"
Cohesion: 0.50
Nodes (4): 12.1 Frontend, 12.2 Backend, 12.3 AI Layer, 12. Recommended Technology Stack

### Community 38 - "PRD Analytics"
Cohesion: 0.50
Nodes (4): 21.1 Engagement Metrics, 21.2 Voice Metrics, 21.3 Performance Metrics, 21. Analytics

### Community 39 - "PRD MVP Scope"
Cohesion: 0.50
Nodes (4): 22.1 Must Have, 22.2 Nice to Have, 22.3 Future, 22. MVP Scope

### Community 40 - "PRD Memory"
Cohesion: 0.50
Nodes (4): 33. Memory Architecture, Conversation Memory, Long-term Memory, Short-term Context

### Community 41 - "PRD Success Criteria"
Cohesion: 0.50
Nodes (4): 38. Product Success Criteria, Product, Technical, User Experience

### Community 42 - "Next.js Config"
Cohesion: 0.67
Nodes (3): next.config.js, nextConfig, path

### Community 43 - "Persona Identity"
Cohesion: 0.67
Nodes (3): IDENTITY.md, How I introduce myself, Personality

### Community 45 - "PRD Latency"
Cohesion: 0.67
Nodes (3): 16. Latency Requirements, Long-Term Target, MVP Targets

### Community 46 - "PRD Privacy"
Cohesion: 0.67
Nodes (3): 19. Privacy Requirements, Privacy Principles, Privacy Settings

### Community 47 - "PRD Overview"
Cohesion: 0.67
Nodes (3): 1. Product Overview, Product Vision, Real-Time Voice AI Assistant

### Community 48 - "PRD AI Quality"
Cohesion: 0.67
Nodes (3): 30. AI Quality Testing, Example, Test dimensions

### Community 49 - "PRD Target Users"
Cohesion: 0.67
Nodes (3): 5.1 Primary Users, 5.2 Secondary Users, 5. Target Users

### Community 50 - "PRD Conversation Model"
Cohesion: 0.67
Nodes (3): 7.1 Conversation Structure, 7.2 Message Structure, 7. Conversation Model

## Knowledge Gaps
- **14 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Should `Audio & Turn Pipeline` be split into smaller, more focused modules?**
  _Cohesion score 0.05734767025089606 - nodes in this community are weakly interconnected._
- **Should `Persona & Memory Types` be split into smaller, more focused modules?**
  _Cohesion score 0.06568832983927324 - nodes in this community are weakly interconnected._
- **Should `Tools & Reminders` be split into smaller, more focused modules?**
  _Cohesion score 0.09565217391304348 - nodes in this community are weakly interconnected._
- **Should `AI Provider Package` be split into smaller, more focused modules?**
  _Cohesion score 0.05555555555555555 - nodes in this community are weakly interconnected._
- **Should `Chat Input & Attachments` be split into smaller, more focused modules?**
  _Cohesion score 0.08571428571428572 - nodes in this community are weakly interconnected._
- **Should `PRD Architecture & Transport` be split into smaller, more focused modules?**
  _Cohesion score 0.07142857142857142 - nodes in this community are weakly interconnected._
- **Should `Web Runtime Dependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.07407407407407407 - nodes in this community are weakly interconnected._