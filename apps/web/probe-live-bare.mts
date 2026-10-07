/**
 * BARE-MINIMUM Gemini Live probe — ground truth with NO tools, NO system
 * instruction, NO transcription. If this is silent too, the problem is the
 * API/quota/model, not our setup payload.
 *
 * Run from repo root:  npx tsx apps/web/probe-live-bare.mts
 *
 * Two traps it exists to keep encoded, both of which silently look like "the
 * model is broken" rather than as protocol errors:
 *
 *   - Audio MUST go in the legacy `realtimeInput: { audio: { mimeType, data } }`
 *     shape. `realtimeInput.mediaChunks` is accepted by the socket and then
 *     IGNORED — no error, no voiceActivity, no reply, ever.
 *   - `responseModalities` must live INSIDE `generationConfig`. At the top
 *     level the socket closes with `Unknown name "responseModalities"`.
 *
 * Env: PROBE_MODEL, PROBE_VOICE, PROBE_PHRASE, PROBE_SILENCE_FRAMES,
 * PROBE_TRANSCRIPTION, PROBE_PAYLOAD (sys|tools|full), PROBE_GLOBAL_WS,
 * PROBE_NO_BACKPRESSURE, PROBE_FRAMING, PROBE_TRANSCODE, PROBE_RAW, PROBE_HEAD.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket as WsWebSocket } from "ws";

// tsx does not load .env.local
try {
  for (const line of readFileSync(join(process.cwd(), "apps/web/.env.local"), "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
} catch {
  /* ignore */
}

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) {
  console.log("no GEMINI_API_KEY");
  process.exit(1);
}

const MODEL = process.env.PROBE_MODEL || "models/gemini-3.8-live";
const VOICE = process.env.PROBE_VOICE || "Leda";
const SIL = Number(process.env.PROBE_SILENCE_FRAMES || 100);

// --- latency decomposition (owner 2026-10-07: "responnya sangat lambat") ---
// A single "first audio" number hides WHERE the time goes. These four stamps
// split the round trip into: how long the VAD waited for silence, how long the
// model then took to produce its first audio, and whether our own send loop
// was already behind. Anything that shifts is actionable; a single total is not.
let lastSpeechSentAt = 0;
let lastSilenceSentAt = 0;
let activityStartAt = 0;
let activityEndAt = 0;
let firstAudioAt = 0;
let turnCompleteAt = 0;
// Probe start, hoisted so the post-run summary can use it. It used to be
// `const t0` inside the websocket promise, which made the summary block throw
// `ReferenceError: t0 is not defined` AFTER printing the two numbers that
// matter — so the crash silently ate the rest of the report.
const T0 = Date.now();

// 1.14 s of a simple tone-ish speech via macOS `say`, as 16 kHz mono LE PCM16
const wav = join(process.cwd(), ".data/probe-bare.wav"); // ffmpeg infers AIFF/WAVE from content
const rawPath = join(process.cwd(), ".data/probe-bare.raw");
const { execFileSync } = await import("node:child_process");
execFileSync("/usr/bin/say", ["-v", "Damayanti", "-o", wav, "--data-format=LEI16@22050", process.env.PROBE_PHRASE || "Halo, berapa satu tambah satu?"]);
// ffmpeg → headerless s16le mono 16 kHz: no WAV chunk parsing to get wrong.
execFileSync("/opt/homebrew/bin/ffmpeg", ["-y", "-loglevel", "error", "-i", wav, "-f", "s16le", "-ac", "1", "-ar", "16000", rawPath]);
const pcm = readFileSync(rawPath);
let peak = 0;
for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
console.log(`model=${MODEL} voice=${VOICE} pcmBytes=${pcm.length} peak=${peak}`);

const res = await fetch("https://generativelanguage.googleapis.com/v1beta/auth_tokens", {
  method: "POST",
  headers: { "x-goog-api-key": KEY, "content-type": "application/json" },
  body: JSON.stringify({ uses: 1, expireTime: new Date(Date.now() + 60000).toISOString() }),
});
const raw = await res.text();
if (!res.ok) {
  console.log("TOKEN FAIL", res.status, raw.slice(0, 400));
  process.exit(1);
}
const json: any = JSON.parse(raw);
const token = typeof json.token === "string" ? json.token : json.token?.name ?? json.name;
if (!token) {
  console.log("TOKEN SHAPE", raw.slice(0, 400));
  process.exit(1);
}
console.log(`token ok (${token.slice(0, 12)}…)`);

// Optional: pull the REAL app setup payload (system instruction + tool
// declarations) from the running server so we can bisect the two suspects
// independently with the same code path that works bare.
//
//   PROBE_PAYLOAD=sys        -> app system instruction, no tools
//   PROBE_PAYLOAD=tools      -> tiny system instruction, app tools
//   PROBE_PAYLOAD=full       -> both
//   PROBE_PAYLOAD=tools+full -> alias accepted by the branch below
let appPayload: { systemInstruction: string; tools: any[] } | null = null;
const mode = process.env.PROBE_PAYLOAD || "";
if (mode) {
  const wantSys = mode.includes("sys") || mode.includes("full");
  const wantTools = mode.includes("tools") || mode.includes("full");
  const agent = process.env.PROBE_AGENT || "mia";
  const r = await fetch(process.env.PROBE_BASE || "http://localhost:3000/api/gemini-live/token", {
    method: "POST",
    headers: { "content-type": "application/json", "x-mia-agent": agent },
    body: JSON.stringify({ user: "probe_payload" }),
  });
  if (!r.ok) {
    console.log("TOKEN ROUTE FAIL", r.status, (await r.text()).slice(0, 200));
    process.exit(1);
  }
  const j: any = await r.json();
  appPayload = {
    systemInstruction: wantSys ? String(j.systemInstruction ?? "") : "You are a concise voice assistant.",
    tools: wantTools ? (j.tools ?? []) : [],
  };
}

const GLOBAL_WS = process.env.PROBE_GLOBAL_WS === "1";
const NO_BP = process.env.PROBE_NO_BACKPRESSURE === "1";
const URL_WS =`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${KEY}`;
const ws: any = GLOBAL_WS ? new (globalThis as any).WebSocket(URL_WS) : new WsWebSocket(URL_WS);
// `ws` is a node stream and needs an explicit binaryType hint; the global
// WebSocket already defaults to Blob, which would break `.toString("utf8")`.
if (GLOBAL_WS) ws.binaryType = "arraybuffer";
let audio = 0;
let sawEnd = false;
let sawModelTurn = false;
let sawSpeechStart = false;
const kinds = new Set<string>();

let setupDone = false;
const waitSetup = new Promise<void>((r) => {
  // Unref'd so a session that never completes its handshake cannot keep the
  // process alive after the 40s verdict is printed.
  const iv = setInterval(() => {
    if (setupDone) {
      clearInterval(iv);
      r();
    }
  }, 50);
  (iv as unknown as { unref?: () => void }).unref?.();
});

// PROBE_GLOBAL_WS=1 runs this KNOWN-GOOD probe on Node's global (undici)
// WebSocket instead of the `ws` package — the only remaining difference
// between this probe and the app's GeminiLiveSession. If the reply dies
// here, the transport is the bug; if it still speaks, the defect is inside
// geminiLive.ts's own send/handshake path.
const onWs = (ev: string, fn: (...a: any[]) => void): void => {
  if (GLOBAL_WS) ws.addEventListener(ev, fn as EventListener);
  else (ws as any).on(ev, fn);
};

const done = new Promise<void>((resolve) => {
  const t = setTimeout(resolve, 40000);
  onWs("open", () => {
    console.log("ws open — sending setup");
    ws.send(
      JSON.stringify({
        setup: {
          model: MODEL,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
          },
          sessionResumption: {},
          realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: 800 } },
          // The real client always enables BOTH transcriptions; the bare frame
          // omits them. `PROBE_TRANSCRIPTION=1` isolates them as the suspect.
          ...(process.env.PROBE_TRANSCRIPTION === "1"
            ? { inputAudioTranscription: {}, outputAudioTranscription: {} }
            : {}),
          ...(appPayload
            ? {
                systemInstruction: { parts: [{ text: appPayload.systemInstruction }] },
                tools: [{ functionDeclarations: appPayload.tools }],
              }
            : { systemInstruction: { parts: [{ text: "You are a concise voice assistant. Answer in one short sentence." }] } }),
        },
      }),
    );
    if (appPayload) {
      console.log(
        `app payload: sysChars=${appPayload.systemInstruction.length} tools=${appPayload.tools.length} ` +
          `sysHead=${JSON.stringify(appPayload.systemInstruction.slice(0, 90))}`,
      );
    }
    // push speech in real time, then silence — only AFTER setupComplete,
    // exactly like the real client.
    (async () => {
      await waitSetup;
      console.log("setupComplete received — streaming audio");
      const per = 640; // 20ms @16k mono
      for (let o = 0; o < pcm.length; o += per) {
        const chunk = pcm.subarray(o, Math.min(o + per, pcm.length));
        const pad = Buffer.alloc(per);
        chunk.copy(pad);
        // PROBE_NO_BACKPRESSURE=1 drops the drain guard — the app's
        // `sendAudioFrame` has no such guard, so this isolates that factor.
        if (NO_BP || !ws.bufferedAmount || ws.bufferedAmount < 64000) {
          ws.send(
            JSON.stringify({
              realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: pad.toString("base64") } },
            }),
          );
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      const sil = Buffer.alloc(per);
      lastSpeechSentAt = Date.now();
      for (let i = 0; i < SIL; i += 1) {
        if (NO_BP || ws.bufferedAmount < 64000) {
          ws.send(
            JSON.stringify({
              realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: sil.toString("base64") } },
            }),
          );
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      lastSilenceSentAt = Date.now();
      console.log(`sent ${Math.ceil(pcm.length / per)} speech + ${SIL} silence frames`);
    })();
  });

  onWs("message", (a: any, isBinary?: boolean) => {
    // `ws` hands us (Buffer, isBinary); global WebSocket hands a MessageEvent
    // whose `.data` is an ArrayBuffer (binaryType) or a string.
    const raw = a && typeof a === "object" && "data" in a ? a.data : a;
    const d: Buffer =
      raw instanceof ArrayBuffer
        ? Buffer.from(raw)
        : Buffer.isBuffer(raw)
          ? raw
          : Buffer.from(String(raw ?? ""), "utf8");
    const s = d.toString("utf8");
    if (process.env.PROBE_RAW === "1") console.log(`RAW(bin=${isBinary ?? false},${d.length}B): ${s.slice(0, 300)}`);
    if (!s.trim()) return;
    let m: any;
    try {
      m = JSON.parse(s);
    } catch {
      console.log("UNPARSEABLE", s.slice(0, 200));
      return;
    }
    {
      console.log(el(), "frame:", Object.keys(m).join(","));
      for (const k of Object.keys(m)) kinds.add(k);
      if (m.setupComplete) setupDone = true;
      if (m.voiceActivity) {
        if (m.voiceActivity.type === "ACTIVITY_END") {
          sawEnd = true;
          activityEndAt = Date.now();
        } else if (m.voiceActivity.type === "ACTIVITY_START" && !activityStartAt) {
          activityStartAt = Date.now();
        }
        console.log("voiceActivity", JSON.stringify(m.voiceActivity));
      }
      if (m.speechStart) {
        sawSpeechStart = true;
        console.log("speechStart", JSON.stringify(m.speechStart).slice(0, 120));
      }
      const sc = m.serverContent;
      if (sc) {
        if (sc.modelTurn) {
          sawModelTurn = true;
          for (const p of sc.modelTurn.parts ?? []) {
            const b = p.inlineData?.data;
            if (b) {
              audio += Buffer.from(b, "base64").length;
              if (!firstAudioAt) firstAudioAt = Date.now();
            }
            if (p.text) console.log("text:", p.text);
          }
        }
        if (sc.turnComplete) {
          turnCompleteAt = Date.now();
          console.log("turnComplete", JSON.stringify(sc.turnComplete).slice(0, 120));
        }
      }
      if (m.error) console.log("ERROR", JSON.stringify(m.error).slice(0, 300));
    }
  });
  const t0 = T0;
  const el = () => `+${Date.now() - t0}ms`;
  onWs("error", (e: any) => console.log(el(), "ws error", e?.message ?? String(e)));
  onWs("close", (a: any, r: any) => {
    // global WebSocket passes one CloseEvent; `ws` passes (code, reasonBuffer).
    const c = GLOBAL_WS ? a?.code : a;
    const txt = GLOBAL_WS ? String(a?.reason ?? "") : String(r ?? "");
    console.log(el(), "ws close", c, txt.slice(0, 300));
    clearTimeout(t);
    resolve();
  });
});

await done;
try {
  ws.close();
} catch {
  /* ignore */
}
console.log(`\nframes=${[...kinds].join(",")}`);
console.log(`ACTIVITY_END=${sawEnd} speechStart=${sawSpeechStart} modelTurn=${sawModelTurn} audioBytes=${audio}`);

// Latency decomposition. Each line is a DIFFERENT owner's fix, so keep them
// separate rather than collapsing to a total:
//   - "vad wait"    → the server's silenceDurationMs; lower it if it dominates.
//   - "model think" → TTFB after the turn closed; a big number here means the
//                     payload (system instruction / tools) is the cost.
//   - "send lag"    → OUR websocket was behind the wall clock. Non-zero means
//                     our own loop is the problem, not the model.
const vadWait = activityEndAt && lastSpeechSentAt ? activityEndAt - lastSpeechSentAt : 0;
const modelThink = firstAudioAt && activityEndAt ? firstAudioAt - activityEndAt : 0;
const total = firstAudioAt && lastSpeechSentAt ? firstAudioAt - lastSpeechSentAt : 0;
console.log(`\n--- latency (ms) ---`);
console.log(`speech sent->ACTIVITY_END (vad wait) : ${vadWait || "n/a"}`);
console.log(`ACTIVITY_END->first audio (model)   : ${modelThink || "n/a"}`);
console.log(`last silence sent                   : ${lastSilenceSentAt ? `+${lastSilenceSentAt - T0}ms` : "n/a"}`);
console.log(`first audio                         : ${firstAudioAt ? `+${firstAudioAt - T0}ms` : "n/a"}`);
console.log(`turnComplete                        : ${turnCompleteAt ? `+${turnCompleteAt - T0}ms` : "n/a"}`);
console.log(`TOTAL speech-end -> first audio     : ${total || "n/a"}`);
console.log(audio > 0 ? "VERDICT: OK — bare session speaks" : "VERDICT: NO AUDIO even bare (upstream/model/quota)");