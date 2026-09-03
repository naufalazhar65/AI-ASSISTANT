# Graph Report - ai-assistant  (2026-09-03)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 723 nodes · 1056 edges · 61 communities (44 shown, 12 thin omitted)
- Extraction: 82% EXTRACTED · 18% INFERRED · 0% AMBIGUOUS · INFERRED: 192 edges (avg confidence: 0.99)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `51677550`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- useVoice.ts
- llm/route.ts
- dependencies
- ai-chat-input.tsx
- sessions.ts
- devDependencies
- compilerOptions
- GroqStreamingProvider
- PRD_Real-Time_Voice_AI_Assistant.md
- ConversationManager
- tools.ts
- 8. Functional Requirements
- state-machine/src/index.ts
- AIProvider
- package.json
- MockProvider
- compilerOptions
- compilerOptions
- compilerOptions
- AGENTS.md
- 23. User Stories
- 24. Acceptance Criteria
- 31. Edge Cases
- 3.1 Primary Goals
- 9.2 Voice Orb
- 41. Risks
- ConversationManager.ts
- tts/route.ts
- 17. Error Handling
- 25.2 Compatibility Testing
- 36. Development Roadmap
- 40. Future Feature Roadmap
- extends
- layout.tsx
- 12. Recommended Technology Stack
- 21. Analytics
- 22. MVP Scope
- 33. Memory Architecture
- 38. Product Success Criteria
- next.config.js
- IDENTITY.md
- postcss.config.js
- stt/route.ts
- 16. Latency Requirements
- 19. Privacy Requirements
- 1. Product Overview
- 30. AI Quality Testing
- 5. Target Users
- 7. Conversation Model
- next-env.d.ts
- DREAMS.md
- SOUL.md
- USER.md
- 10. Conversation State Machine
- 13. Real-Time Transport
- README.md

## God Nodes (most connected - your core abstractions)
1. `GroqStreamingProvider` - 29 edges
2. `ConversationManager` - 27 edges
3. `AudioCapture` - 20 edges
4. `AIProvider` - 20 edges
5. `useVoice()` - 20 edges
6. `sanitizeUser()` - 18 edges
7. `MockProvider` - 17 edges
8. `compilerOptions` - 16 edges
9. `executeTool()` - 14 edges
10. `AutoTurnManager` - 13 edges

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

## Communities (61 total, 12 thin omitted)

### Community 0 - "useVoice.ts"
Cohesion: 0.06
Nodes (26): AutoTurnManager, VADMode, AudioCapture, AudioCaptureListener, AudioCaptureState, AudioPlayer, VADCallbacks, VADOptions (+18 more)

### Community 1 - "llm/route.ts"
Cohesion: 0.07
Nodes (47): buildOpenCodeSystemPrompt(), buildSystemPrompt(), ChatMessage, OPENCODE_SYSTEM_PROMPT, POST(), runAgent(), runOneCompletion(), runtime (+39 more)

### Community 2 - "dependencies"
Cohesion: 0.04
Nodes (47): @ai-provider/mock, dependencies, @ai-provider/mock, class-variance-authority, clsx, framer-motion, lucide-react, next (+39 more)

### Community 3 - "ai-chat-input.tsx"
Cohesion: 0.07
Nodes (29): Home(), STATE_HUES, FloatingParticles(), mulberry32(), PARTICLE_CONFIGS, SignInForm(), useAuth(), AIChatCard() (+21 more)

### Community 4 - "sessions.ts"
Cohesion: 0.12
Nodes (36): dynamic, GET(), runtime, DELETE(), dynamic, GET(), POST(), runtime (+28 more)

### Community 5 - "devDependencies"
Cohesion: 0.05
Nodes (39): devDependencies, autoprefixer, eslint, eslint-config-next, postcss, tailwindcss, @types/node, @types/react (+31 more)

### Community 6 - "compilerOptions"
Cohesion: 0.07
Nodes (26): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+18 more)

### Community 7 - "GroqStreamingProvider"
Cohesion: 0.15
Nodes (4): GroqStreamingProvider, stripEmojiForSpeech(), AIChatCardProps, ConfirmationRequest

### Community 8 - "PRD_Real-Time_Voice_AI_Assistant.md"
Cohesion: 0.08
Nodes (26): PRD_Real-Time_Voice_AI_Assistant.md, 11. Technical Architecture, 14. Audio Pipeline, 15. Audio Requirements, 18. Security Requirements, 20. Observability, 26. Audio Testing, 27. Interrupt Testing (+18 more)

### Community 9 - "ConversationManager"
Cohesion: 0.16
Nodes (5): ConversationManager, nextId(), delay(), main(), ConversationMessage

### Community 10 - "tools.ts"
Cohesion: 0.16
Nodes (22): cleanUrl(), deleteNote(), DENY_PATTERNS, DENY_SEGMENTS, evaluateArithmetic(), executeTool(), fetchInstantAnswer(), FILE_ROOT() (+14 more)

### Community 11 - "8. Functional Requirements"
Cohesion: 0.10
Nodes (22): 8. Functional Requirements, Acceptance Requirement, FR-001 — Voice Input, FR-002 — Voice Activity Detection, FR-003 — Streaming Speech-to-Text, FR-004 — LLM Processing, FR-005 — Streaming AI Response, FR-006 — Streaming Text-to-Speech (+14 more)

### Community 12 - "state-machine/src/index.ts"
Cohesion: 0.14
Nodes (10): ConversationStateMachine, Event, State, STATES, Transition, TRANSITIONS, cycle, ILLEGAL (+2 more)

### Community 13 - "AIProvider"
Cohesion: 0.13
Nodes (6): AIProvider, MessageRole, MockProviderLike, ProviderEvent, SendResult, ToolDefinition

### Community 14 - "package.json"
Cohesion: 0.12
Nodes (15): devDependencies, vitest, name, private, scripts, build, dev, lint (+7 more)

### Community 16 - "compilerOptions"
Cohesion: 0.14
Nodes (13): compilerOptions, esModuleInterop, lib, module, moduleResolution, noEmit, skipLibCheck, strict (+5 more)

### Community 17 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, lib, module, moduleResolution, noEmit, skipLibCheck, strict (+4 more)

### Community 18 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, lib, module, moduleResolution, noEmit, skipLibCheck, strict (+4 more)

### Community 19 - "AGENTS.md"
Cohesion: 0.17
Nodes (12): AGENTS.md, Commands (npm workspaces at repo root), Critical architecture decisions (from PRD), Gotchas, Key invariants to preserve, Persona & long-term memory, Project status, Provider (free Groq tier) (+4 more)

### Community 20 - "23. User Stories"
Cohesion: 0.20
Nodes (10): 23. User Stories, US-001 — Voice Input, US-002 — Streaming Response, US-003 — Interrupt, US-004 — Context, US-005 — Transcript, US-006 — Voice, US-007 — Text Fallback (+2 more)

### Community 21 - "24. Acceptance Criteria"
Cohesion: 0.25
Nodes (8): 24. Acceptance Criteria, AC-001 — Voice Input, AC-002 — Voice Turn Completion, AC-003 — AI Response, AC-004 — Interrupt, AC-005 — Context, AC-006 — Text Fallback, AC-007 — Privacy

### Community 22 - "31. Edge Cases"
Cohesion: 0.25
Nodes (8): 31.1 User Says Nothing, 31.2 Very Short Utterance, 31.3 User Speaks While AI Speaks, 31.4 Rapid Corrections, 31.5 Network Disconnect, 31.6 AI Generates Too Much Text, 31.7 User Changes Topic, 31. Edge Cases

### Community 23 - "3.1 Primary Goals"
Cohesion: 0.25
Nodes (8): 3.1 Primary Goals, 3.2 Secondary Goals, 3. Product Goals, Context-aware, Fast, Interactive, Natural, Reliable

### Community 24 - "9.2 Voice Orb"
Cohesion: 0.25
Nodes (8): 9.1 Main Screen, 9.2 Voice Orb, 9.3 UI State Labels, 9. UI/UX Requirements, Idle, Listening, Speaking, Thinking

### Community 25 - "41. Risks"
Cohesion: 0.29
Nodes (7): 41. Risks, R-001 — High Latency, R-002 — Bad Speech Recognition, R-003 — Poor Interruption, R-004 — Cost, R-005 — Privacy, R-006 — Tool Abuse

### Community 26 - "ConversationManager.ts"
Cohesion: 0.40
Nodes (3): ConversationEvent, ConversationListener, TranscriptEntry

### Community 27 - "tts/route.ts"
Cohesion: 0.40
Nodes (5): detectModel(), GROQ_VOICES_AR, GROQ_VOICES_EN, POST(), runtime

### Community 28 - "17. Error Handling"
Cohesion: 0.33
Nodes (6): 17.1 Microphone Denied, 17.2 Connection Lost, 17.3 AI Timeout, 17.4 TTS Failure, 17.5 Invalid Audio Device, 17. Error Handling

### Community 29 - "25.2 Compatibility Testing"
Cohesion: 0.33
Nodes (6): 25.1 Functional Testing, 25.2 Compatibility Testing, 25. QA Test Strategy, Audio Devices, Desktop, Mobile

### Community 30 - "36. Development Roadmap"
Cohesion: 0.33
Nodes (6): 36. Development Roadmap, Phase 1 — Foundation, Phase 2 — Real-Time Voice, Phase 3 — Natural Conversation, Phase 4 — Assistant Capabilities, Phase 5 — AI Agent

### Community 31 - "40. Future Feature Roadmap"
Cohesion: 0.33
Nodes (6): 40. Future Feature Roadmap, Computer Control, Developer Tools, Productivity, Smart Environment, Voice Intelligence

### Community 32 - "extends"
Cohesion: 0.50
Nodes (3): extends, next/core-web-vitals, next/typescript

### Community 34 - "12. Recommended Technology Stack"
Cohesion: 0.50
Nodes (4): 12.1 Frontend, 12.2 Backend, 12.3 AI Layer, 12. Recommended Technology Stack

### Community 35 - "21. Analytics"
Cohesion: 0.50
Nodes (4): 21.1 Engagement Metrics, 21.2 Voice Metrics, 21.3 Performance Metrics, 21. Analytics

### Community 36 - "22. MVP Scope"
Cohesion: 0.50
Nodes (4): 22.1 Must Have, 22.2 Nice to Have, 22.3 Future, 22. MVP Scope

### Community 37 - "33. Memory Architecture"
Cohesion: 0.50
Nodes (4): 33. Memory Architecture, Conversation Memory, Long-term Memory, Short-term Context

### Community 38 - "38. Product Success Criteria"
Cohesion: 0.50
Nodes (4): 38. Product Success Criteria, Product, Technical, User Experience

### Community 40 - "IDENTITY.md"
Cohesion: 0.67
Nodes (3): IDENTITY.md, How I introduce myself, Personality

### Community 43 - "16. Latency Requirements"
Cohesion: 0.67
Nodes (3): 16. Latency Requirements, Long-Term Target, MVP Targets

### Community 44 - "19. Privacy Requirements"
Cohesion: 0.67
Nodes (3): 19. Privacy Requirements, Privacy Principles, Privacy Settings

### Community 45 - "1. Product Overview"
Cohesion: 0.67
Nodes (3): 1. Product Overview, Product Vision, Real-Time Voice AI Assistant

### Community 46 - "30. AI Quality Testing"
Cohesion: 0.67
Nodes (3): 30. AI Quality Testing, Example, Test dimensions

### Community 47 - "5. Target Users"
Cohesion: 0.67
Nodes (3): 5.1 Primary Users, 5.2 Secondary Users, 5. Target Users

### Community 48 - "7. Conversation Model"
Cohesion: 0.67
Nodes (3): 7.1 Conversation Structure, 7.2 Message Structure, 7. Conversation Model

## Knowledge Gaps
- **148 isolated node(s):** `VADMode`, `AudioCaptureListener`, `VADCallbacks`, `VADOptions`, `PersistedSettings` (+143 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 380 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **12 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `GroqStreamingProvider` connect `GroqStreamingProvider` to `useVoice.ts`, `ConversationManager`, `AIProvider`, `MockProvider`?**
  _High betweenness centrality (0.025) - this node is a cross-community bridge._
- **Why does `ConversationManager` connect `ConversationManager` to `useVoice.ts`, `ConversationManager.ts`, `state-machine/src/index.ts`, `AIProvider`?**
  _High betweenness centrality (0.024) - this node is a cross-community bridge._
- **Are the 47 inferred relationships involving `PRD_Real-Time_Voice_AI_Assistant.md` (e.g. with `10. Conversation State Machine` and `11. Technical Architecture`) actually correct?**
  _`PRD_Real-Time_Voice_AI_Assistant.md` has 47 INFERRED edges - model-reasoned connections that need verification._
- **What connects `VADMode`, `AudioCaptureListener`, `VADCallbacks` to the rest of the system?**
  _148 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `useVoice.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05734767025089606 - nodes in this community are weakly interconnected._
- **Should `llm/route.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.06568832983927324 - nodes in this community are weakly interconnected._
- **Should `dependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.04081632653061224 - nodes in this community are weakly interconnected._