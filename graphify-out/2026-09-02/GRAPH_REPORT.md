# Graph Report - ai-assistant  (2026-09-02)

## Corpus Check
- 52 files · ~27,590 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 639 nodes · 832 edges · 60 communities (40 shown, 15 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 10 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- 10. Conversation State Machine
- useVoice.ts
- compilerOptions
- dependencies
- 8. Functional Requirements
- PRD_Real-Time_Voice_AI_Assistant.md
- devDependencies
- GroqStreamingProvider
- ai-chat-input.tsx
- mock-provider/package.json
- compilerOptions
- package.json
- compilerOptions
- compilerOptions
- ConversationManager
- AGENTS.md
- ai-provider/package.json
- state-machine/package.json
- 23. User Stories
- 24. Acceptance Criteria
- 31. Edge Cases
- 3.1 Primary Goals
- 9.2 Voice Orb
- 41. Risks
- 17. Error Handling
- 25.2 Compatibility Testing
- 36. Development Roadmap
- 40. Future Feature Roadmap
- extends
- tts/route.ts
- 12. Recommended Technology Stack
- 21. Analytics
- 22. MVP Scope
- 33. Memory Architecture
- 38. Product Success Criteria
- next.config.js
- postcss.config.js
- llm/route.ts
- stt/route.ts
- layout.tsx
- 16. Latency Requirements
- 19. Privacy Requirements
- 1. Product Overview
- 30. AI Quality Testing
- 5. Target Users
- 7. Conversation Model
- next-env.d.ts
- AIProvider
- 13. Real-Time Transport
- 26. Audio Testing
- 43. Recommended MVP Product Architecture
- IDENTITY.md
- DREAMS.md
- SOUL.md
- USER.md

## God Nodes (most connected - your core abstractions)
1. `GroqStreamingProvider` - 28 edges
2. `ConversationManager` - 27 edges
3. `AudioCapture` - 20 edges
4. `AIProvider` - 20 edges
5. `MockProvider` - 17 edges
6. `8. Functional Requirements` - 17 edges
7. `compilerOptions` - 16 edges
8. `useVoice()` - 15 edges
9. `AutoTurnManager` - 13 edges
10. `cn()` - 12 edges

## Surprising Connections (you probably didn't know these)
- `ConversationManager` --references--> `AIProvider`  [EXTRACTED]
  apps/web/src/ai/ConversationManager.ts → packages/ai-provider/src/index.ts
- `GroqStreamingProvider` --implements--> `AIProvider`  [EXTRACTED]
  apps/web/src/ai/GroqStreamingProvider.ts → packages/ai-provider/src/index.ts
- `GroqStreamingProvider` --references--> `ConfirmationRequest`  [EXTRACTED]
  apps/web/src/ai/GroqStreamingProvider.ts → packages/ai-provider/src/index.ts
- `GroqStreamingProvider` --references--> `ConversationMessage`  [EXTRACTED]
  apps/web/src/ai/GroqStreamingProvider.ts → packages/ai-provider/src/index.ts
- `AIChatCardProps` --references--> `ConfirmationRequest`  [EXTRACTED]
  apps/web/src/components/ui/ai-chat.tsx → packages/ai-provider/src/index.ts

## Import Cycles
- None detected.

## Communities (60 total, 15 thin omitted)

### Community 1 - "useVoice.ts"
Cohesion: 0.06
Nodes (19): AutoTurnManager, VADMode, TranscriptEntry, AudioCapture, AudioCaptureListener, AudioCaptureState, AudioPlayer, VADCallbacks (+11 more)

### Community 2 - "compilerOptions"
Cohesion: 0.07
Nodes (26): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+18 more)

### Community 3 - "dependencies"
Cohesion: 0.07
Nodes (29): @ai-provider/mock, dependencies, @ai-provider/mock, class-variance-authority, clsx, framer-motion, lucide-react, next (+21 more)

### Community 4 - "8. Functional Requirements"
Cohesion: 0.09
Nodes (23): 8. Functional Requirements, Acceptance Requirement, FR-001 — Voice Input, FR-002 — Voice Activity Detection, FR-003 — Streaming Speech-to-Text, FR-004 — LLM Processing, FR-005 — Streaming AI Response, FR-006 — Streaming Text-to-Speech (+15 more)

### Community 5 - "PRD_Real-Time_Voice_AI_Assistant.md"
Cohesion: 0.09
Nodes (21): 11. Technical Architecture, 14. Audio Pipeline, 15. Audio Requirements, 18. Security Requirements, 20. Observability, 27. Interrupt Testing, 28. Performance Testing, 29. Security Testing (+13 more)

### Community 6 - "devDependencies"
Cohesion: 0.07
Nodes (28): devDependencies, autoprefixer, eslint, eslint-config-next, postcss, tailwindcss, @types/node, @types/react (+20 more)

### Community 8 - "ai-chat-input.tsx"
Cohesion: 0.07
Nodes (31): Home(), STATE_HUES, STATE_LABELS, FloatingParticles(), mulberry32(), PARTICLE_CONFIGS, SignInForm(), useAuth() (+23 more)

### Community 9 - "mock-provider/package.json"
Cohesion: 0.14
Nodes (13): dependencies, @voice/ai-provider, devDependencies, typescript, typescript, @voice/ai-provider, main, name (+5 more)

### Community 10 - "compilerOptions"
Cohesion: 0.14
Nodes (13): compilerOptions, esModuleInterop, lib, module, moduleResolution, noEmit, skipLibCheck, strict (+5 more)

### Community 11 - "package.json"
Cohesion: 0.12
Nodes (15): devDependencies, vitest, name, private, scripts, build, dev, lint (+7 more)

### Community 12 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, lib, module, moduleResolution, noEmit, skipLibCheck, strict (+4 more)

### Community 13 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, lib, module, moduleResolution, noEmit, skipLibCheck, strict (+4 more)

### Community 14 - "ConversationManager"
Cohesion: 0.08
Nodes (16): ConversationEvent, ConversationListener, ConversationManager, nextId(), main(), ConversationMessage, ConversationStateMachine, Event (+8 more)

### Community 15 - "AGENTS.md"
Cohesion: 0.15
Nodes (11): Commands (npm workspaces at repo root), Critical architecture decisions (from PRD), Gotchas, Key invariants to preserve, Persona & long-term memory, Project status, Provider (free Groq tier), Read the PRD first (+3 more)

### Community 16 - "ai-provider/package.json"
Cohesion: 0.18
Nodes (10): devDependencies, typescript, typescript, main, name, private, scripts, typecheck (+2 more)

### Community 17 - "state-machine/package.json"
Cohesion: 0.18
Nodes (10): devDependencies, typescript, typescript, main, name, private, scripts, typecheck (+2 more)

### Community 18 - "23. User Stories"
Cohesion: 0.20
Nodes (10): 23. User Stories, US-001 — Voice Input, US-002 — Streaming Response, US-003 — Interrupt, US-004 — Context, US-005 — Transcript, US-006 — Voice, US-007 — Text Fallback (+2 more)

### Community 19 - "24. Acceptance Criteria"
Cohesion: 0.25
Nodes (8): 24. Acceptance Criteria, AC-001 — Voice Input, AC-002 — Voice Turn Completion, AC-003 — AI Response, AC-004 — Interrupt, AC-005 — Context, AC-006 — Text Fallback, AC-007 — Privacy

### Community 20 - "31. Edge Cases"
Cohesion: 0.25
Nodes (8): 31.1 User Says Nothing, 31.2 Very Short Utterance, 31.3 User Speaks While AI Speaks, 31.4 Rapid Corrections, 31.5 Network Disconnect, 31.6 AI Generates Too Much Text, 31.7 User Changes Topic, 31. Edge Cases

### Community 21 - "3.1 Primary Goals"
Cohesion: 0.25
Nodes (8): 3.1 Primary Goals, 3.2 Secondary Goals, 3. Product Goals, Context-aware, Fast, Interactive, Natural, Reliable

### Community 22 - "9.2 Voice Orb"
Cohesion: 0.25
Nodes (8): 9.1 Main Screen, 9.2 Voice Orb, 9.3 UI State Labels, 9. UI/UX Requirements, Idle, Listening, Speaking, Thinking

### Community 23 - "41. Risks"
Cohesion: 0.29
Nodes (7): 41. Risks, R-001 — High Latency, R-002 — Bad Speech Recognition, R-003 — Poor Interruption, R-004 — Cost, R-005 — Privacy, R-006 — Tool Abuse

### Community 24 - "17. Error Handling"
Cohesion: 0.33
Nodes (6): 17.1 Microphone Denied, 17.2 Connection Lost, 17.3 AI Timeout, 17.4 TTS Failure, 17.5 Invalid Audio Device, 17. Error Handling

### Community 25 - "25.2 Compatibility Testing"
Cohesion: 0.33
Nodes (6): 25.1 Functional Testing, 25.2 Compatibility Testing, 25. QA Test Strategy, Audio Devices, Desktop, Mobile

### Community 26 - "36. Development Roadmap"
Cohesion: 0.33
Nodes (6): 36. Development Roadmap, Phase 1 — Foundation, Phase 2 — Real-Time Voice, Phase 3 — Natural Conversation, Phase 4 — Assistant Capabilities, Phase 5 — AI Agent

### Community 27 - "40. Future Feature Roadmap"
Cohesion: 0.33
Nodes (6): 40. Future Feature Roadmap, Computer Control, Developer Tools, Productivity, Smart Environment, Voice Intelligence

### Community 28 - "extends"
Cohesion: 0.50
Nodes (3): extends, next/core-web-vitals, next/typescript

### Community 30 - "12. Recommended Technology Stack"
Cohesion: 0.50
Nodes (4): 12.1 Frontend, 12.2 Backend, 12.3 AI Layer, 12. Recommended Technology Stack

### Community 31 - "21. Analytics"
Cohesion: 0.50
Nodes (4): 21.1 Engagement Metrics, 21.2 Voice Metrics, 21.3 Performance Metrics, 21. Analytics

### Community 32 - "22. MVP Scope"
Cohesion: 0.50
Nodes (4): 22.1 Must Have, 22.2 Nice to Have, 22.3 Future, 22. MVP Scope

### Community 33 - "33. Memory Architecture"
Cohesion: 0.50
Nodes (4): 33. Memory Architecture, Conversation Memory, Long-term Memory, Short-term Context

### Community 34 - "38. Product Success Criteria"
Cohesion: 0.50
Nodes (4): 38. Product Success Criteria, Product, Technical, User Experience

### Community 37 - "llm/route.ts"
Cohesion: 0.08
Nodes (36): buildSystemPrompt(), ChatMessage, POST(), runAgent(), runOneCompletion(), runtime, SYSTEM_PROMPT, POST() (+28 more)

### Community 40 - "16. Latency Requirements"
Cohesion: 0.67
Nodes (3): 16. Latency Requirements, Long-Term Target, MVP Targets

### Community 41 - "19. Privacy Requirements"
Cohesion: 0.67
Nodes (3): 19. Privacy Requirements, Privacy Principles, Privacy Settings

### Community 42 - "1. Product Overview"
Cohesion: 0.67
Nodes (3): 1. Product Overview, Product Vision, Real-Time Voice AI Assistant

### Community 43 - "30. AI Quality Testing"
Cohesion: 0.67
Nodes (3): 30. AI Quality Testing, Example, Test dimensions

### Community 44 - "5. Target Users"
Cohesion: 0.67
Nodes (3): 5.1 Primary Users, 5.2 Secondary Users, 5. Target Users

### Community 45 - "7. Conversation Model"
Cohesion: 0.67
Nodes (3): 7.1 Conversation Structure, 7.2 Message Structure, 7. Conversation Model

### Community 47 - "AIProvider"
Cohesion: 0.09
Nodes (8): AIProvider, MessageRole, MockProviderLike, ProviderEvent, ProviderEventListener, SendResult, ToolDefinition, MockProvider

## Knowledge Gaps
- **305 isolated node(s):** `next/core-web-vitals`, `next/typescript`, `path`, `nextConfig`, `name` (+300 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 365 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **15 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `ConversationManager` connect `ConversationManager` to `useVoice.ts`, `llm/route.ts`, `AIProvider`?**
  _High betweenness centrality (0.022) - this node is a cross-community bridge._
- **Why does `GroqStreamingProvider` connect `GroqStreamingProvider` to `ai-chat-input.tsx`, `useVoice.ts`, `ConversationManager`, `AIProvider`?**
  _High betweenness centrality (0.022) - this node is a cross-community bridge._
- **What connects `next/core-web-vitals`, `next/typescript`, `path` to the rest of the system?**
  _305 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `useVoice.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.06110102843315184 - nodes in this community are weakly interconnected._
- **Should `compilerOptions` be split into smaller, more focused modules?**
  _Cohesion score 0.07407407407407407 - nodes in this community are weakly interconnected._
- **Should `dependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.06896551724137931 - nodes in this community are weakly interconnected._
- **Should `8. Functional Requirements` be split into smaller, more focused modules?**
  _Cohesion score 0.08695652173913043 - nodes in this community are weakly interconnected._