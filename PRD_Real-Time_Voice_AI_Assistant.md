# Product Requirements Document (PRD)
# Real-Time Voice AI Assistant

**Product Name:** Voice AI Assistant  
**Document Version:** 1.0  
**Status:** Draft  
**Document Type:** Product Requirements Document  
**Target Platforms:** Web, Desktop, Mobile-ready  
**Primary Interaction:** Real-time voice conversation  
**Product Inspiration:** Siri, ChatGPT Voice, Google Gemini Live

---

## 1. Product Overview

Voice AI Assistant adalah aplikasi asisten AI berbasis suara yang memungkinkan pengguna berinteraksi secara natural menggunakan percakapan dua arah secara real-time.

Pengguna tidak perlu mengetik. Mereka cukup berbicara, dan sistem akan:

> 🎙️ Listen → 🧠 Understand → 🤖 Think → 🔊 Speak

Sistem harus mendukung percakapan yang terasa natural, termasuk:

- Streaming audio secara real-time
- Automatic Speech Recognition (ASR)
- AI response streaming
- Text-to-Speech (TTS)
- Interrupt / barge-in
- Conversation context
- Voice Activity Detection (VAD)
- Follow-up questions
- Tool/function calling
- Conversation history
- Transcript

### Product Vision

> **"An AI assistant you can talk to naturally, just like talking to another person."**

---

# 2. Problem Statement

Interaksi dengan AI saat ini masih banyak menggunakan text input. Hal ini memiliki beberapa masalah:

1. Mengetik lebih lambat dibanding berbicara.
2. Percakapan terasa seperti komunikasi satu arah.
3. Chatbot sering menunggu pengguna selesai sebelum memproses.
4. Tidak adanya interrupt membuat interaksi terasa kaku.
5. Pengguna harus terus berpindah antara keyboard, mouse, dan aplikasi.
6. Chatbot tradisional tidak memberikan pengalaman conversational yang benar-benar natural.

Produk ini bertujuan membuat AI yang terasa seperti **teman bicara digital**.

---

# 3. Product Goals

## 3.1 Primary Goals

### Fast

Response dimulai dalam waktu sesingkat mungkin setelah pengguna selesai berbicara.

### Natural

Percakapan terasa seperti berbicara dengan manusia.

### Interactive

Pengguna dapat menyela AI kapan saja.

### Context-aware

AI memahami percakapan sebelumnya.

### Reliable

Audio, transcription, AI response, dan TTS harus stabil.

## 3.2 Secondary Goals

Produk juga harus memiliki fondasi untuk:

- AI tools
- Web search
- Calendar
- Reminder
- Smart home
- Productivity
- Personal assistant
- Third-party integrations
- Autonomous agent capabilities

---

# 4. Non-Goals

Untuk MVP, sistem **tidak wajib** memiliki:

- Full autonomous agent
- Smart home control
- Phone calling
- Complex personal automation
- Face recognition
- Always-on microphone
- Wake-word detection seperti "Hey Siri"
- Computer control

Fitur tersebut dapat masuk ke fase berikutnya.

---

# 5. Target Users

## 5.1 Primary Users

Pengguna yang ingin berinteraksi dengan AI tanpa harus mengetik.

Contoh penggunaan:

> "Bantu saya memahami kode ini."

> "Apa perbedaan Playwright dan Selenium?"

> "Buatkan test case untuk fitur login."

> "Saya sedang coding, bantu debug error ini."

## 5.2 Secondary Users

Produk juga cocok untuk:

- Developer
- QA Engineer
- Student
- Researcher
- Content Creator
- Knowledge Worker
- Product Manager
- Business User

---

# 6. Core User Experience

Flow utama:

```text
User
  │
  ▼
🎙️ Microphone
  │
  ▼
Voice Activity Detection
  │
  ▼
Speech-to-Text
  │
  ▼
Conversation Manager
  │
  ▼
LLM
  │
  ▼
Streaming Response
  │
  ▼
Text-to-Speech
  │
  ▼
🔊 Speaker
  │
  └───────────────┐
                  │
             User interrupts
                  │
                  ▼
             Stop AI Audio
```

Target pengalaman:

```text
Speak
  ↓
Understand
  ↓
Think
  ↓
Respond
  ↓
Listen again
```

Percakapan harus dapat berlangsung terus tanpa pengguna harus memulai sesi baru untuk setiap pertanyaan.

---

# 7. Conversation Model

Satu voice session terdiri dari beberapa turn percakapan.

Contoh:

**User**

> "Apa itu Playwright?"

**AI**

> "Playwright adalah framework automation..."

**User**

> "Apakah lebih bagus daripada Selenium?"

AI harus mengetahui bahwa:

> "lebih bagus" = Playwright vs Selenium

dan bukan pertanyaan baru yang berdiri sendiri.

## 7.1 Conversation Structure

```text
Conversation
├── conversation_id
├── user_id
├── created_at
├── updated_at
├── system_context
└── messages[]
```

## 7.2 Message Structure

```text
Message
├── id
├── conversation_id
├── role
├── transcript
├── audio_reference
├── timestamp
├── duration
└── metadata
```

Role yang didukung:

```text
system
user
assistant
tool
```

---

# 8. Functional Requirements

## FR-001 — Voice Input

User dapat menekan tombol microphone untuk memulai percakapan.

Contoh UI:

```text
┌─────────────┐
│             │
│  🎙️ Speak   │
│             │
└─────────────┘
```

### Microphone States

```text
IDLE
LISTENING
PROCESSING
SPEAKING
INTERRUPTED
ERROR
```

---

## FR-002 — Voice Activity Detection

Sistem harus mendeteksi kapan pengguna mulai dan berhenti berbicara.

Flow:

```text
silence
   ↓
speech detected
   ↓
capture audio
   ↓
speech continues
   ↓
silence detected
   ↓
end turn
```

Sistem sebaiknya tidak mengharuskan pengguna menekan tombol stop secara manual.

### Requirements

- Mendeteksi speech start.
- Mendeteksi speech end.
- Mengabaikan silence pendek.
- Mengurangi false trigger.
- Dapat berjalan secara streaming.
- Mendukung noisy environment secara wajar.

---

## FR-003 — Streaming Speech-to-Text

Audio pengguna harus diproses secara streaming.

Contoh:

```text
User speaks:

"What is Playwright"

         ↓

"What"
"What is"
"What is Playwright"
```

Transcription sementara dapat ditampilkan secara real-time.

### Transcript States

```text
PARTIAL
FINAL
```

---

## FR-004 — LLM Processing

Setelah user turn selesai atau cukup stabil, sistem mengirimkan context ke LLM.

Contoh:

```json
{
  "conversation_id": "conv_123",
  "messages": [
    {
      "role": "user",
      "content": "What is Playwright?"
    }
  ]
}
```

LLM menghasilkan response secara streaming.

---

## FR-005 — Streaming AI Response

AI tidak boleh menunggu seluruh response selesai sebelum mengirim hasil.

Contoh:

```text
Playwright...
       ↓
Playwright is...
       ↓
Playwright is a framework...
```

Tujuannya mengurangi perceived latency.

---

## FR-006 — Streaming Text-to-Speech

Response AI harus langsung dikonversi menjadi audio ketika potongan teks tersedia.

```text
LLM
 ↓
"Playwright is..."
 ↓
TTS
 ↓
🔊 Speak
```

Tidak perlu menunggu seluruh jawaban selesai.

### Requirements

- Audio playback dapat dimulai sebelum seluruh response selesai.
- Audio chunk harus dapat diputar secara berurutan.
- TTS harus dapat dihentikan kapan saja.
- TTS harus mendukung queue atau buffer yang aman.

---

## FR-007 — Interrupt / Barge-In

Ini adalah fitur inti untuk membuat pengalaman seperti Siri atau ChatGPT Voice.

Contoh:

AI:

> "Playwright adalah framework yang digunakan untuk—"

User:

> "Tunggu, bagaimana dengan Selenium?"

Sistem harus:

```text
AI SPEAKING
     ↓
USER SPEAKS
     ↓
DETECT INTERRUPTION
     ↓
STOP AUDIO
     ↓
CANCEL CURRENT TTS
     ↓
CANCEL/UPDATE GENERATION
     ↓
PROCESS NEW INPUT
```

### Acceptance Requirement

AI tidak boleh terus melanjutkan kalimat lama setelah user mengambil turn.

---

## FR-008 — Conversation Context

Sistem harus mempertahankan konteks percakapan.

Contoh:

```text
User:
Apa itu Selenium?

AI:
Selenium adalah...

User:
Siapa pembuatnya?

AI:
Selenium awalnya dikembangkan oleh Jason Huggins.
```

AI harus memahami referensi seperti:

- "itu"
- "dia"
- "yang tadi"
- "yang kedua"
- "lebih bagus"
- "lanjut"
- "jelaskan lagi"
- "yang sebelumnya"

---

## FR-009 — Voice Selection

User dapat memilih voice.

Contoh:

```text
Voice
├── Female 01
├── Female 02
├── Male 01
├── Male 02
└── Neutral
```

Pengaturan voice:

```text
Voice
Speed
Pitch
Language
```

Voice list dapat berkembang di masa depan.

---

## FR-010 — Multilingual

MVP minimal:

```text
English
Bahasa Indonesia
```

Future:

```text
Japanese
Korean
Chinese
Spanish
French
German
```

AI harus dapat memahami code-switching.

Contoh:

> "Tolong explain this error, kenapa `useEffect`-nya infinite loop?"

---

## FR-011 — Text Fallback

Meskipun produk berorientasi voice, user harus dapat mengetik.

```text
🎙️ Voice Input

atau

┌───────────────────────────────┐
│ Type a message...             │
└───────────────────────────────┘
```

Use cases:

- Lingkungan berisik
- Microphone bermasalah
- User tidak ingin bicara
- Membutuhkan input code
- Membutuhkan input panjang

---

## FR-012 — Code Input

Karena developer merupakan salah satu target user, sistem harus mendukung code.

Contoh:

```text
User:
Kenapa kode ini error?

[code]

AI:
Karena `await` digunakan di luar async function...
```

Untuk developer mode, voice dapat digunakan untuk menjelaskan problem sementara code tetap berada dalam text editor atau editor input.

---

## FR-013 — Tool Calling

AI harus memiliki kemampuan memanggil tool.

Contoh:

```text
User
 │
 ▼
LLM
 │
 ├── Calculator
 ├── Web Search
 ├── Weather
 ├── Calendar
 ├── Files
 └── Custom APIs
```

Contoh:

> "Berapa 15% dari 2 juta?"

LLM dapat memanggil:

```text
calculator(2000000 * 0.15)
```

---

## FR-014 — Tool Confirmation

Untuk tindakan sensitif, AI harus meminta confirmation.

Contoh:

> "Saya akan menghapus file tersebut. Apakah Anda yakin?"

User:

> "Yes."

Baru kemudian action dijalankan.

### Tool Risk Categories

```text
READ
WRITE
DELETE
TRANSACTION
EXTERNAL_ACTION
```

Tindakan berisiko tinggi harus memerlukan konfirmasi eksplisit.

---

## FR-015 — Conversation History

User dapat melihat history.

```text
Today
├── Playwright discussion
├── Debug React issue
└── Test case generation

Yesterday
├── API testing
└── GitHub Actions
```

User dapat:

- Rename conversation
- Delete conversation
- Search conversation
- Continue conversation

---

## FR-016 — Transcript

Selama percakapan, user dapat melihat transcript.

```text
You
"What is Playwright?"

AI
"Playwright is an end-to-end testing framework..."
```

Transcript harus mendukung:

- Partial transcript
- Final transcript
- Speaker identification
- Timestamp
- Future transcript correction

---

# 9. UI/UX Requirements

## 9.1 Main Screen

Konsep interface minimal:

```text
┌─────────────────────────────────────────────┐
│ Voice AI                              ⚙️   │
├─────────────────────────────────────────────┤
│                                             │
│                                             │
│               ●                             │
│                                             │
│            Listening...                     │
│                                             │
│       "What can I help you with?"           │
│                                             │
│                                             │
├─────────────────────────────────────────────┤
│                                             │
│       🎙️          Type a message...         │
│                                             │
└─────────────────────────────────────────────┘
```

---

## 9.2 Voice Orb

UI utama dapat menggunakan animated orb.

### Idle

```text
     ◯
```

### Listening

```text
    ◉)))
```

### Thinking

```text
    ◌ ◌ ◌
```

### Speaking

```text
   ≋ ◉ ≋
```

Orb dapat menggunakan audio amplitude untuk menghasilkan visual yang mengikuti suara.

---

## 9.3 UI State Labels

UI dapat menampilkan:

```text
"Ready"
"Listening..."
"Thinking..."
"Speaking..."
"Interrupted"
"Reconnecting..."
"Error"
```

---

# 10. Conversation State Machine

Sangat disarankan menggunakan state machine eksplisit.

```text
          ┌─────────┐
          │  IDLE   │
          └────┬────┘
               │
               ▼
       ┌──────────────┐
       │ LISTENING    │
       └──────┬───────┘
              │
              ▼
       ┌──────────────┐
       │ PROCESSING   │
       └──────┬───────┘
              │
              ▼
       ┌──────────────┐
       │  SPEAKING    │
       └──────┬───────┘
              │
       interruption
              │
              ▼
       ┌──────────────┐
       │ INTERRUPTED  │
       └──────┬───────┘
              │
              ▼
          LISTENING
```

### State Definitions

| State | Description |
|---|---|
| IDLE | Tidak ada sesi aktif |
| LISTENING | Sistem sedang mendengarkan user |
| PROCESSING | Sistem memproses transcript |
| SPEAKING | AI sedang menghasilkan audio |
| INTERRUPTED | AI dihentikan karena user mengambil turn |
| ERROR | Terjadi error |
| RECONNECTING | Sedang membangun ulang koneksi |

---

# 11. Technical Architecture

Recommended architecture:

```text
                  CLIENT
              ┌───────────────┐
              │ Web / Mobile  │
              └───────┬───────┘
                      │
                   WebRTC
                      │
                      ▼
              REAL-TIME SERVER
              ┌───────────────┐
              │ Audio Gateway │
              └───────┬───────┘
                      │
          ┌───────────┼────────────┐
          │           │            │
          ▼           ▼            ▼
       VAD/ASR       LLM          TTS
          │           │            │
          └───────────┼────────────┘
                      │
                      ▼
               Conversation
                  Service
                      │
                      ▼
                  Database
```

---

# 12. Recommended Technology Stack

## 12.1 Frontend

```text
Next.js
React
TypeScript
Web Audio API
WebRTC
Tailwind CSS
Framer Motion
```

## 12.2 Backend

```text
Node.js
TypeScript
Fastify / Express
WebSocket
WebRTC
```

## 12.3 AI Layer

AI provider harus diabstraksikan:

```text
AI Provider
├── Realtime Model
├── Speech-to-Text
├── LLM
└── Text-to-Speech
```

Contoh interface:

```typescript
interface AIProvider {
  connect(): Promise<void>;

  sendAudio(audio: ArrayBuffer): void;

  sendText(text: string): void;

  interrupt(): void;

  disconnect(): void;
}
```

Dengan abstraction ini, provider AI dapat diganti tanpa mengubah seluruh aplikasi.

---

# 13. Real-Time Transport

Untuk pengalaman seperti ChatGPT Voice, **WebRTC** menjadi kandidat utama untuk audio real-time.

Alternatif:

```text
WebSocket
```

WebSocket lebih sederhana pada beberapa use case, tetapi untuk audio bidirectional real-time WebRTC memberikan fondasi yang lebih natural.

### Recommended Design

```text
Browser
   │
   │ WebRTC
   ▼
Realtime Gateway
   │
   ├── Audio
   ├── Session Events
   └── Control Events
```

---

# 14. Audio Pipeline

```text
Microphone
    │
    ▼
Audio Capture
    │
    ▼
Noise Suppression
    │
    ▼
Voice Activity Detection
    │
    ▼
Audio Streaming
    │
    ▼
Speech Recognition
    │
    ▼
Conversation Manager
    │
    ▼
LLM
    │
    ▼
TTS
    │
    ▼
Audio Streaming
    │
    ▼
Speaker
```

---

# 15. Audio Requirements

MVP:

```text
Sample Rate: 16 kHz / 24 kHz
Channels: Mono
Encoding: Provider-compatible streaming format
```

Sistem harus menangani:

- Microphone permission
- Device switching
- Headset
- Bluetooth audio
- Microphone disconnect
- Speaker disconnect
- Permission changes
- Browser audio restrictions

---

# 16. Latency Requirements

Latency adalah KPI utama produk.

## MVP Targets

| Metric | Target |
|---|---:|
| Mic → audio processing | <100 ms |
| User stops → AI processing begins | <500 ms |
| First AI audio response | <1.5 sec |
| Interruption detection | <200 ms |
| TTS playback start | <500 ms after usable text chunk |
| UI state update | <100 ms |

## Long-Term Target

> **~300–800 ms perceived response latency**

Semakin rendah latency, semakin "alive" AI terasa.

---

# 17. Error Handling

## 17.1 Microphone Denied

```text
Microphone access is required

[Enable microphone]
```

## 17.2 Connection Lost

```text
Connection lost.
Reconnecting...
```

## 17.3 AI Timeout

```text
Sorry, I couldn't process that.
Try again.
```

## 17.4 TTS Failure

Fallback:

```text
Show text response
```

## 17.5 Invalid Audio Device

```text
Selected microphone is unavailable.
Please choose another device.
```

---

# 18. Security Requirements

Sistem harus:

- Meminta microphone permission secara eksplisit.
- Menggunakan HTTPS.
- Mengenkripsi communication.
- Tidak menyimpan audio tanpa consent.
- Menjaga API key tetap berada di server.
- Membatasi akses conversation berdasarkan user ID.
- Memvalidasi tool calls di server.
- Mencegah client memanggil privileged tool secara langsung.
- Memiliki rate limiting.
- Memiliki authentication dan authorization.

---

# 19. Privacy Requirements

User harus mengetahui kapan microphone aktif.

Contoh:

```text
Microphone
✓ Active
✓ Audio streaming
```

Saat berhenti:

```text
Microphone
○ Inactive
```

### Privacy Settings

```text
Save conversations
Save transcripts
Improve AI
Voice data retention
Delete audio history
Delete conversation history
```

### Privacy Principles

- Collect only what is required.
- Make storage behavior visible.
- Give users deletion controls.
- Separate audio retention from transcript retention.
- Avoid storing raw audio unless necessary.

---

# 20. Observability

Backend harus mengukur:

```text
Session ID
User ID
Connection duration
Audio latency
ASR latency
LLM latency
TTS latency
First token latency
First audio latency
Interruption count
Error count
Token usage
```

Contoh event:

```text
voice.session.started
voice.session.ended
voice.user.started_speaking
voice.user.stopped_speaking
voice.user.interrupted
voice.asr.started
voice.asr.completed
voice.llm.started
voice.llm.first_token
voice.tts.started
voice.tts.first_audio
voice.error
```

---

# 21. Analytics

## 21.1 Engagement Metrics

```text
Daily Active Users
Weekly Active Users
Sessions per User
Conversation Duration
Messages per Session
Sessions per Day
```

## 21.2 Voice Metrics

```text
Average speaking duration
Average AI speaking duration
Interruption rate
Voice session completion rate
Voice session abandonment rate
```

## 21.3 Performance Metrics

```text
Median first audio latency
P95 first audio latency
ASR error rate
TTS error rate
Connection failure rate
Average session latency
```

---

# 22. MVP Scope

## 22.1 Must Have

```text
✅ Microphone input
✅ Real-time speech recognition
✅ LLM response
✅ Streaming TTS
✅ Interrupt AI
✅ Conversation context
✅ Transcript
✅ Conversation history
✅ Voice selection
✅ Text fallback
✅ Error handling
✅ Basic authentication
✅ Privacy controls
```

## 22.2 Nice to Have

```text
🟡 Web search
🟡 Calculator
🟡 File upload
🟡 Code understanding
🟡 Multiple voice personalities
🟡 Basic tool calling
```

## 22.3 Future

```text
🔵 Wake word
🔵 Personal memory
🔵 Calendar
🔵 Email
🔵 Smart home
🔵 Computer control
🔵 Autonomous agents
🔵 Multi-agent workflows
```

---

# 23. User Stories

## US-001 — Voice Input

**As a user**, I want to talk to the AI using my microphone so I don't need to type.

## US-002 — Streaming Response

**As a user**, I want the AI to respond while generating the answer so conversations feel fast.

## US-003 — Interrupt

**As a user**, I want to interrupt the AI when it is speaking so I can change or correct my question.

## US-004 — Context

**As a user**, I want the AI to remember what we discussed earlier in the conversation.

## US-005 — Transcript

**As a user**, I want to see the transcript of our conversation.

## US-006 — Voice

**As a user**, I want to switch between different voices.

## US-007 — Text Fallback

**As a user**, I want to type instead of speaking when I'm in a noisy environment.

## US-008 — Tool Usage

**As a user**, I want the AI to use tools when necessary to answer my request.

## US-009 — Confirmation

**As a user**, I want confirmation before an action that can modify or delete data.

---

# 24. Acceptance Criteria

## AC-001 — Voice Input

```text
GIVEN microphone permission is granted

WHEN the user speaks

THEN the system detects speech

AND streams audio

AND displays live transcription.
```

## AC-002 — Voice Turn Completion

```text
GIVEN the user is speaking

WHEN speech ends and the configured silence threshold is reached

THEN the system finalizes the turn

AND begins AI processing.
```

## AC-003 — AI Response

```text
GIVEN the user finishes speaking

WHEN the transcript is finalized

THEN the AI generates a response

AND response audio begins streaming.
```

## AC-004 — Interrupt

```text
GIVEN AI is speaking

WHEN the user starts speaking

THEN AI audio stops within the target interruption latency

AND current TTS playback is cancelled

AND the new user input becomes the active turn.
```

## AC-005 — Context

```text
GIVEN the conversation contains previous messages

WHEN the user asks a follow-up question

THEN the AI uses previous conversation context.
```

## AC-006 — Text Fallback

```text
GIVEN voice input is unavailable

WHEN the user types a message

THEN the system processes the message as a normal conversation turn.
```

## AC-007 — Privacy

```text
GIVEN microphone access is granted

WHEN the microphone is active

THEN the UI clearly indicates microphone activity.
```

---

# 25. QA Test Strategy

Karena produk ini voice-first, QA strategy harus mencakup web, audio, networking, AI behavior, latency, dan interruption.

## 25.1 Functional Testing

Test:

```text
Microphone permission
Microphone start/stop
Recording
Speech detection
Transcription
LLM response
TTS
Interruption
Conversation history
Voice settings
Text fallback
Error handling
Authentication
Privacy settings
Tool confirmation
```

## 25.2 Compatibility Testing

### Desktop

```text
Chrome
Safari
Edge
Firefox
macOS
Windows
```

### Mobile

```text
iOS Safari
Android Chrome
```

### Audio Devices

```text
Built-in microphone
Bluetooth headset
USB microphone
Wired headset
External speaker
```

---

# 26. Audio Testing

Test pada berbagai kondisi:

```text
Quiet room
Noisy room
Background music
Low microphone volume
High microphone volume
Echo
Multiple speakers
Bluetooth headset
USB microphone
Built-in microphone
Network interruption
```

### Audio Edge Cases

- User whispers.
- User shouts.
- User speaks very slowly.
- User speaks very quickly.
- User changes microphone while speaking.
- Bluetooth disconnects mid-session.
- Browser tab loses audio focus.
- User switches output device while AI is speaking.

---

# 27. Interrupt Testing

Test interruption pada:

```text
AI starts speaking
        ↓
User interrupts after 200 ms
```

```text
AI starts speaking
        ↓
User interrupts after 1 second
```

```text
AI is almost finished
        ↓
User interrupts near end
```

```text
AI speaks continuously
        ↓
User interrupts multiple times
```

Expected behavior:

- AI audio berhenti cepat.
- TTS queue dibatalkan.
- Generation lama tidak mengganggu turn baru.
- Conversation state tetap konsisten.

---

# 28. Performance Testing

Test:

```text
1 concurrent session
10 concurrent sessions
100 concurrent sessions
1,000 concurrent sessions
10,000 concurrent sessions
```

Metric:

```text
Latency
CPU
Memory
Bandwidth
Connection count
WebRTC session count
LLM concurrency
TTS concurrency
ASR concurrency
Database throughput
```

---

# 29. Security Testing

QA harus menguji:

```text
Authentication bypass
Authorization bypass
Conversation data isolation
API key exposure
Tool abuse
Prompt injection
Tool injection
Rate limit bypass
Session hijacking
WebSocket/WebRTC session abuse
Audio data exposure
Transcript exposure
```

---

# 30. AI Quality Testing

AI harus diuji bukan hanya berdasarkan HTTP 200 atau koneksi berhasil.

### Test dimensions

```text
Accuracy
Context retention
Instruction following
Interruption handling
Language detection
Code understanding
Tool selection
Tool arguments
Safety behavior
Hallucination
Response relevance
```

### Example

User:

> "Tadi kamu bilang Selenium lebih lama. Maksudmu apa?"

AI harus menggunakan konteks percakapan sebelumnya.

---

# 31. Edge Cases

## 31.1 User Says Nothing

```text
🎙️ Listening...

→ timeout
```

## 31.2 Very Short Utterance

> "Yes."

AI harus memproses berdasarkan context.

## 31.3 User Speaks While AI Speaks

Harus trigger interruption.

## 31.4 Rapid Corrections

User:

> "Open GitHub—actually wait—open Gmail instead."

AI harus memprioritaskan intent terbaru.

## 31.5 Network Disconnect

Session harus dapat reconnect dengan state yang konsisten.

## 31.6 AI Generates Too Much Text

Sistem harus tetap dapat memulai TTS lebih awal.

## 31.7 User Changes Topic

Context lama tidak boleh menyebabkan AI salah memahami topik baru.

---

# 32. Tool Calling Architecture

Recommended architecture:

```text
User Voice
   │
   ▼
Speech-to-Text
   │
   ▼
LLM
   │
   ├───────────────┐
   │               │
Normal response   Tool call
                   │
                   ▼
             Tool Executor
                   │
                   ▼
             Tool result
                   │
                   ▼
                  LLM
                   │
                   ▼
                  TTS
```

Tool layer harus dipisahkan dari UI dan audio layer.

---

# 33. Memory Architecture

Future personal memory dapat dibagi menjadi:

```text
Short-term Context
        │
        ▼
Conversation Memory
        │
        ▼
Long-term Memory
```

### Short-term Context

Percakapan aktif.

### Conversation Memory

History dari conversation.

### Long-term Memory

Informasi yang secara eksplisit disimpan untuk membantu interaksi di masa depan.

---

# 34. Recommended Project Structure

```text
src/
├── app/
│
├── components/
│   ├── VoiceOrb/
│   ├── Transcript/
│   ├── Conversation/
│   ├── VoiceControls/
│   └── Settings/
│
├── audio/
│   ├── AudioCapture.ts
│   ├── AudioPlayer.ts
│   ├── VoiceActivityDetector.ts
│   ├── AudioStream.ts
│   └── AudioDeviceManager.ts
│
├── realtime/
│   ├── RealtimeClient.ts
│   ├── SessionManager.ts
│   ├── InterruptManager.ts
│   └── EventManager.ts
│
├── ai/
│   ├── AIProvider.ts
│   ├── ConversationManager.ts
│   ├── ToolManager.ts
│   ├── MemoryManager.ts
│   └── PromptManager.ts
│
├── hooks/
│   ├── useVoice.ts
│   ├── useConversation.ts
│   ├── useRealtime.ts
│   └── useAudioDevices.ts
│
├── services/
│   ├── auth/
│   ├── analytics/
│   └── api/
│
└── types/
```

---

# 35. AI Provider Abstraction

Sistem harus menggunakan abstraction layer.

```typescript
interface AIProvider {
  connect(): Promise<void>;

  sendAudio(audio: ArrayBuffer): void;

  sendText(text: string): void;

  interrupt(): void;

  disconnect(): void;
}
```

Implementasi dapat berupa:

```text
AIProvider
├── RealtimeProvider
├── StreamingProvider
└── MockProvider
```

MockProvider penting untuk QA dan automated testing tanpa harus selalu menggunakan model AI nyata.

---

# 36. Development Roadmap

## Phase 1 — Foundation

```text
Week 1

├── Project setup
├── UI foundation
├── Authentication
├── Microphone access
├── Audio capture
└── Basic conversation screen
```

## Phase 2 — Real-Time Voice

```text
Week 2

├── Streaming ASR
├── Streaming LLM
├── Streaming TTS
├── Audio playback
└── Realtime transport
```

## Phase 3 — Natural Conversation

```text
Week 3

├── VAD
├── Interrupt / barge-in
├── Conversation state machine
├── Context management
└── Transcript improvements
```

## Phase 4 — Assistant Capabilities

```text
Week 4+

├── Tool calling
├── Web search
├── Calculator
├── File access
├── Memory
└── External APIs
```

## Phase 5 — AI Agent

```text
Future

├── Planning
├── Multi-step execution
├── Computer control
├── Personal automation
└── Autonomous workflows
```

---

# 37. MVP Definition of Done

MVP dianggap selesai ketika:

```text
[✓] User dapat memulai voice session
[✓] Microphone bekerja
[✓] Speech dikenali
[✓] Partial transcript tampil
[✓] Final transcript tersedia
[✓] LLM merespons
[✓] Response di-stream
[✓] AI berbicara
[✓] User dapat interrupt AI
[✓] Context percakapan bekerja
[✓] History tersimpan
[✓] Text fallback tersedia
[✓] Error handling tersedia
[✓] Authentication tersedia
[✓] Privacy controls tersedia
[✓] HTTPS/security diterapkan
[✓] Performance monitoring tersedia
[✓] Basic QA coverage tersedia
```

---

# 38. Product Success Criteria

MVP dianggap berhasil jika:

### User Experience

- Percakapan terasa natural.
- User dapat berbicara tanpa push-to-talk terus menerus.
- AI dapat diinterupsi.
- Response dimulai dengan cepat.
- User memahami kapan AI mendengarkan dan berbicara.

### Technical

- Sistem stabil selama voice session.
- Reconnect berjalan dengan baik.
- Audio tidak sering terputus.
- Transcript cukup akurat.
- P95 latency berada di target.
- Tidak terjadi kebocoran data conversation.

### Product

- User kembali menggunakan voice mode.
- Average session duration meningkat.
- Interruption tidak menyebabkan conversation corruption.
- Voice session abandonment rendah.

---

# 39. Long-Term Vision — Voice AI Agent

Setelah voice assistant stabil, arsitekturnya dapat berkembang menjadi:

```text
                   Voice
                     │
                     ▼
              Conversation AI
                     │
            ┌────────┴────────┐
            ▼                 ▼
          Memory            Tools
            │                 │
            │       ┌─────────┼─────────┐
            │       ▼         ▼         ▼
            │     Web       Files    Computer
            │
            └──────────┬──────────┘
                       ▼
                  AI Agent
```

User kemudian dapat berkata:

> "Tolong buka GitHub, cek repository saya, lihat issue yang belum selesai, lalu rangkum apa yang harus saya kerjakan hari ini."

AI kemudian:

```text
Understand
   ↓
Plan
   ↓
Call tools
   ↓
Observe
   ↓
Reason
   ↓
Execute
   ↓
Respond by voice
```

Produk pada tahap ini berubah dari:

> **Voice Chatbot**

menjadi:

> **Voice AI Agent**

---

# 40. Future Feature Roadmap

## Voice Intelligence

```text
Wake word
Emotion-aware response
Speaker recognition
Personalized voices
Voice cloning with explicit consent
Natural pauses
Backchanneling
```

## Productivity

```text
Calendar
Reminder
Email
Notes
Tasks
Meetings
```

## Developer Tools

```text
Repository analysis
Code explanation
Terminal tools
CI/CD integration
Bug triage
Test generation
Log analysis
```

## Computer Control

```text
Open application
Navigate UI
Click controls
Type text
Read screen
Execute workflow
```

## Smart Environment

```text
Smart home
IoT
Home automation
Device control
```

---

# 41. Risks

## R-001 — High Latency

**Risk:** Percakapan terasa lambat.

**Mitigation:**

- Streaming
- Parallel processing
- Early TTS
- Connection reuse
- Low-latency transport
- Optimize prompt/context size

---

## R-002 — Bad Speech Recognition

**Risk:** AI salah memahami user.

**Mitigation:**

- Noise suppression
- Better VAD
- Multiple STT strategies
- Confidence monitoring
- Transcript correction
- Ask clarification when confidence is low

---

## R-003 — Poor Interruption

**Risk:** AI berbicara menimpa user.

**Mitigation:**

- Continuous VAD
- Immediate playback cancellation
- TTS queue cancellation
- Explicit conversation state
- Barge-in testing

---

## R-004 — Cost

**Risk:** Voice interaction mahal dibanding text interaction.

**Mitigation:**

- Monitor token usage
- Limit session duration
- Compress/optimize context
- Cache where appropriate
- Provider abstraction
- Usage quotas

---

## R-005 — Privacy

**Risk:** User tidak nyaman dengan audio retention.

**Mitigation:**

- Clear permission UI
- Explicit data policy
- Audio deletion controls
- Minimal storage
- Optional audio retention

---

## R-006 — Tool Abuse

**Risk:** AI menjalankan action yang tidak diinginkan.

**Mitigation:**

- Tool permission layer
- Confirmation flow
- Server-side validation
- Least-privilege access
- Audit logs

---

# 42. Open Questions

Pertanyaan berikut perlu ditentukan sebelum production:

1. Apakah audio mentah disimpan?
2. Berapa lama transcript disimpan?
3. Apakah semua conversation tersimpan secara default?
4. Apakah user dapat menghapus seluruh data?
5. Provider AI mana yang menjadi primary provider?
6. Apakah akan tersedia provider fallback?
7. Apakah voice session unlimited?
8. Apakah akan ada usage quota?
9. Apakah tool calling tersedia di MVP?
10. Apakah web search tersedia di MVP?
11. Apakah memory opt-in atau opt-out?
12. Apakah wake word akan masuk production?
13. Apakah aplikasi harus mendukung mobile native?
14. Apakah AI boleh melakukan actions tanpa confirmation untuk low-risk tools?

---

# 43. Recommended MVP Product Architecture

```text
                   ┌─────────────────────┐
                   │      Next.js        │
                   │      Frontend       │
                   └──────────┬──────────┘
                              │
                           WebRTC
                              │
                              ▼
                   ┌─────────────────────┐
                   │   Realtime Gateway  │
                   │      Node.js        │
                   └──────────┬──────────┘
                              │
              ┌───────────────┼────────────────┐
              │               │                │
              ▼               ▼                ▼
             VAD             ASR              TTS
              │               │                │
              └───────────────┼────────────────┘
                              ▼
                        ┌───────────┐
                        │    LLM    │
                        └─────┬─────┘
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
                 Memory               Tools
                    │                   │
                    └─────────┬─────────┘
                              ▼
                         PostgreSQL
```

### Architectural Principle

**AI provider harus interchangeable.**

```text
Voice Engine
     │
     ├── Provider A
     ├── Provider B
     └── Provider C
```

Aplikasi tidak boleh tergantung pada implementasi satu provider.

Hal ini memudahkan perbandingan:

- Latency
- ASR quality
- Voice quality
- Cost
- Context window
- Function calling
- Availability
- Reliability

---

# 44. Final Product Definition

Produk ini bukan sekadar:

> "Chatbot yang mempunyai microphone."

Definisi produk yang lebih tepat adalah:

> **"A low-latency conversational AI that can listen, understand, think, speak, and be interrupted naturally."**

Tiga capability yang paling menentukan kualitas pengalaman adalah:

```text
1. Streaming audio
2. Low latency
3. Interrupt / barge-in
```

Apabila tiga hal tersebut bekerja dengan baik, produk akan terasa jauh lebih dekat dengan pengalaman Siri atau ChatGPT Voice dibanding chatbot tradisional.

---

# 45. Appendix — Example User Session

```text
[00:00]
User opens Voice AI.

[00:01]
System:
"Hi! What can I help you with?"

[00:03]
User:
"Explain Playwright."

[00:03]
ASR:
"Explain Playwright."

[00:04]
LLM starts generating.

[00:04]
TTS starts speaking:
"Playwright is an end-to-end testing framework..."

[00:07]
User interrupts:
"Is it better than Selenium?"

[00:07]
AI audio immediately stops.

[00:08]
ASR:
"Is it better than Selenium?"

[00:09]
LLM:
"It depends on your use case. Playwright..."

[00:09]
TTS:
"It depends on your use case..."
```

Target experience:

> **Fast enough that the user feels they are talking to an AI, not waiting for an API.**

---

# 46. Document Status

**Status:** Draft  
**Version:** 1.0  
**Next Step:** Technical Design Document (TDD)  
**Next Implementation Step:** MVP architecture and repository setup
