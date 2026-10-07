/**
 * Ground-truth probe for "Live hears me but never answers" (owner 2026-10-06).
 *
 * Drives the REAL `GeminiLiveSession` class with REAL speech (macOS `say` →
 * 16 kHz mono s16le) and counts every server frame by kind. No voice channel,
 * no Discord — pure Live, so a failure here cannot be blamed on the bridge.
 *
 * It exists because that bug had TWO causes that both look identical from the
 * client ("I spoke, it stayed silent"), and neither is visible without this:
 *
 *   1. `.next` chunk loss → `POST /api/gemini-live/token` 500s. The session
 *      can never start. Check `/tmp/mia-dev.log` for
 *      `ENOENT ... api/gemini-live/token/route.js` and restart via
 *      `./scripts/restart-mia.sh` BEFORE reading anything into the audio path.
 *   2. Trailing silence shorter than `silenceDurationMs`. The server ends a
 *      turn only after that much quiet, so sending exactly the knob's worth of
 *      silence never crosses the threshold: ACTIVITY_START, then nothing.
 *      Keep SILENCE_FRAMES deliberately ABOVE the knob (see below).
 *
 * Env: PROBE_AGENTS, PROBE_BASE, PROBE_SILENCE_FRAMES, PROBE_HEAD.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiLiveSession } from "./src/lib/geminiLive";

const BASE = process.env.PROBE_BASE || "http://127.0.0.1:3000";

/** A crude voiced signal: 120 Hz + harmonics with an envelope, so the
 *  server-side VAD has something speech-like to latch onto. */
function speechFrames(count: number): Uint8Array[] {
  const SR = 16_000;
  const FRAME = 320; // 20 ms
  const out: Uint8Array[] = [];
  for (let n = 0; n < count; n += 1) {
    const bytes = new Uint8Array(FRAME * 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < FRAME; i += 1) {
      const t = (n * FRAME + i) / SR;
      const env = Math.sin((Math.PI * (n * FRAME)) / (SR * 1.2)) ** 2; // syllabic-ish
      const s =
        0.35 * Math.sin(2 * Math.PI * 120 * t) +
        0.2 * Math.sin(2 * Math.PI * 240 * t) +
        0.1 * Math.sin(2 * Math.PI * 600 * t);
      view.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(s * env * 26000))), true);
    }
    out.push(bytes);
  }
  return out;
}

async function probe(agent: string | null, speech: Uint8Array[]): Promise<void> {
  const label = agent ?? "(no agent header → mia)";
  const counts = new Map<string, number>();
  let inText = "";
  let outText = "";
  let audioBytes = 0;
  let firstAudioMs = 0;
  const started = Date.now();

  const session = new GeminiLiveSession({
    // HEAD's GeminiLiveSession has no `tokenUrl` option (it resolves the route
    // relative to the browser origin), so a server-side probe needs an
    // absolute base to stand in for that origin.
    ...(process.env.PROBE_HEAD === "1" ? {} : {
          tokenUrl: `${BASE}/api/gemini-live/token`,
          userHeader: agent ? { "x-mia-user": "naufalazhar652952.agnes", "x-mia-agent": agent } : undefined,
        }),
    enableInputTranscription: true,
    enableOutputTranscription: true,
  });
  session.on((e) => {
    switch (e.type) {
      case "audio": {
        audioBytes += e.pcm.length;
        if (!firstAudioMs) firstAudioMs = Date.now() - started;
        break;
      }
      case "input_transcript": inText = e.text; break;
      case "output_transcript": outText = e.text; break;
      case "tool_call": counts.set("tool_call", (counts.get("tool_call") ?? 0) + 1); break;
      case "speaking": counts.set(`speaking:${e.speaking}`, (counts.get(`speaking:${e.speaking}`) ?? 0) + 1); break;
      case "interrupted": counts.set("interrupted", (counts.get("interrupted") ?? 0) + 1); break;
      case "error": counts.set("error", (counts.get("error") ?? 0) + 1); break;
      default: break;
    }
  });

  // PROBE_WIRE=1 — dump the exact frames the app class puts on the wire, so it
  // can be diffed against the bare probe that DOES work. Patches the global
  // WebSocket BEFORE start(), so `geminiLive.ts` picks the wrapper up.
  if (process.env.PROBE_WIRE === "1") {
    const G = globalThis as Record<string, unknown>;
    const Orig = G.WebSocket as typeof WebSocket;
    class Traced extends Orig {
      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        const s = typeof data === "string" ? data : `<${typeof data}>`;
        let keys: string[] = [];
        try {
          keys = Object.keys(JSON.parse(s).setup ?? { realtimeInput: {} });
        } catch {
          keys = ["<unparsable>"];
        }
        console.log(`  >> ${s.slice(0, 60)}… (${s.length}B keys=${keys})`);
        return super.send(data as string);
      }
    }
    G.WebSocket = Traced as unknown as typeof WebSocket;
  }

  const res = await session.start();
  console.log(`\n=== agent=${label} ===`);
  if (!res.ok) {
    console.log(`  START FAILED: ${res.error}`);
    return;
  }
  console.log(`  started (via ${res.via})`);

  (globalThis as Record<string, unknown>).__miaLiveTrace = true;
  for (const f of speech) {
    session.sendAudioFrame(f, Buffer.from(f).toString("base64"));
    await new Promise((r) => setTimeout(r, 20));
  }
  // TRAILING SILENCE: the server VAD needs ~800 ms of quiet to close the turn
  // and START the reply. Without it the model is still waiting for the user to
  // finish, which looks exactly like "it never answers".
  const silence = new Uint8Array(320 * 2);
  // 250 frames = 5 s, deliberately WELL above the client's `silenceDurationMs`
// (800 ms). A run that sends only ~equal trailing silence cannot prove
// anything: it can never cross the server's endpointing threshold.
const SILENCE_FRAMES = Number(process.env.PROBE_SILENCE_FRAMES || 250);
  for (let i = 0; i < SILENCE_FRAMES; i += 1) {
    session.sendAudioFrame(silence, Buffer.from(silence).toString("base64"));
    await new Promise((r) => setTimeout(r, 20));
  }
  console.log(`  (sent ${speech.length} speech + ${SILENCE_FRAMES} silence frames; waiting for reply)`);
  // The trailing-silence loop above is what closes the turn, and its length is
  // the whole ballgame: the server ends the turn only after `silenceDurationMs`
  // of quiet, so a run whose trailing silence is NOT strictly longer than that
  // knob can never see ACTIVITY_END and looks "silent" while being perfectly
  // healthy (measured 2026-10-07: 1200 ms knob + 1200 ms of silence = no
  // ACTIVITY_END; the same build with 250 frames = 5000 ms = instant reply).
  // The manual-VAD re-send experiment was removed: it produced nothing and it
  // was the only caller of the private `GeminiLiveSession.send` (a typecheck
  // error). Keep this budget comfortably ABOVE the knob, never equal to it.
  await new Promise((r) => setTimeout(r, 2_000));

  console.log(`  heard      : ${JSON.stringify(inText.slice(0, 80))}`);
  console.log(`  said       : ${JSON.stringify(outText.slice(0, 120))}`);
  console.log(`  audio bytes: ${audioBytes}${firstAudioMs ? ` (first audio ${firstAudioMs}ms)` : ""}`);
  console.log(`  events     : ${JSON.stringify(Object.fromEntries(counts))}`);
  console.log(
    `  VERDICT    : ${audioBytes > 0 ? "AUDIO OK — server answers" : "NO AUDIO — server silent"}`
  );
  session.stop();
}

// Real speech beats a synthetic buzz: the server-side VAD is tuned for human
// voices, and a buzz can leave it un-latched (a silent probe proves nothing
// about the product). Fall back to the buzz only if TTS is unavailable.
async function realSpeech(): Promise<Uint8Array[] | null> {
  try {
    // macOS `say` is keyless and offline — the same path
    // `lib/tts.ts` uses for Indonesian. Prefer it over Groq (absent here).
    const aiff = join(tmpdir(), `mia-probe-${Date.now()}.aiff`);
    execFileSync("/usr/bin/say", ["-v", "Damayanti", "-o", aiff, "Halo, sebutkan dua warna."], {
      stdio: "pipe",
    });
    // PROBE_FFMPEG=1 uses the EXACT resampling path the known-good bare probe
    // uses (`say --data-format=LEI16@22050` then ffmpeg to raw 16k mono). The
    // app probe's default afconvert + resampleFloat32 path was the last
    // untested difference between "bare probe speaks" and "app class silent".
    const raw = readFileSync(aiff);
    if (process.env.PROBE_FFMPEG === "1") {
      const rawaiff = join(tmpdir(), `mia-probe-raw-${Date.now()}.aiff`);
      const rawpcm = join(tmpdir(), `mia-probe-raw-${Date.now()}.pcm`);
      execFileSync("/usr/bin/say", ["-v", "Damayanti", "-o", rawaiff, "Halo, sebutkan dua warna."], { stdio: "pipe" });
      execFileSync("/opt/homebrew/bin/ffmpeg", ["-y", "-f", "s16le", "-ac", "1", "-ar", "16000", "-i", rawaiff, rawpcm], { stdio: "pipe" });
      const pcmBytes = new Uint8Array(readFileSync(rawpcm));
      const FRAME = 320;
      const out: Uint8Array[] = [];
      for (let o = 0; o + FRAME * 2 <= pcmBytes.length; o += FRAME * 2) out.push(pcmBytes.subarray(o, o + FRAME * 2));
      for (const f of [rawaiff, rawpcm]) { try { unlinkSync(f); } catch { /* ignore */ } }
      if (out.length < 10) return null;
      console.log(`  (real speech [ffmpeg path]: ${out.length} frames of 20ms)`);
      return out;
    }
    const wav = join(aiff.replace(/\.aiff$/, ".wav"));
    execFileSync("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16", aiff, wav], { stdio: "pipe" });
    const bytes = new Uint8Array(readFileSync(wav));
    for (const f of [aiff, wav]) {
      try {
        unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
    const wavBuf = bytes;
    // Parse the WAV header instead of assuming a fixed 44-byte offset: the
    // local `say` path can emit extra chunks, and a wrong offset here would
    // feed the model header bytes as "speech" and prove nothing.
    const dv = new DataView(wavBuf.buffer, wavBuf.byteOffset, wavBuf.byteLength);
    let off = 12;
    let dataOff = -1;
    let dataLen = 0;
    while (off + 8 <= wavBuf.length) {
      const id = String.fromCharCode(wavBuf[off], wavBuf[off + 1], wavBuf[off + 2], wavBuf[off + 3]);
      const size = dv.getUint32(off + 4, true);
      if (id === "data") {
        dataOff = off + 8;
        dataLen = size;
        break;
      }
      off += 8 + size + (size % 2);
    }
    if (dataOff < 0 || dataLen < 400) return null;
    const pcm = wavBuf.slice(dataOff, dataOff + dataLen);
    const { pcm16ToFloat32, resampleFloat32 } = await import("./src/lib/pcm");
    // WAV header offsets: 22 = numChannels, 24 = sampleRate, 28 = byteRate,
// 34 = bitsPerSample. Offset 28 (byteRate) is NOT the sample rate — feeding it
// here resampled the speech to ~1/3 speed, which latched the server VAD on
// (ACTIVITY_START) and never let it release. That made a healthy client look
// dead for hours.
    const sampleRate = dv.getUint32(24, true) || 16_000;
    const bytesPerFrame = (dv.getUint16(22, true) || 2) * ((dv.getUint16(34, true) || 16) / 8);
    const frames = Math.floor(pcm.length / bytesPerFrame);
    const mono = new Float32Array(frames);
    const asF32 = pcm16ToFloat32(pcm);
    for (let i = 0; i < frames; i += 1) mono[i] = asF32[i] ?? 0;
    const at16k = resampleFloat32(mono, sampleRate, 16_000);
    const out16 = new Int16Array(at16k.length);
    for (let i = 0; i < at16k.length; i += 1) {
      const v = Math.max(-1, Math.min(1, at16k[i] ?? 0));
      out16[i] = Math.round(v < 0 ? v * 0x8000 : v * 0x7fff);
    }
    const FRAME = 320;
    const out: Uint8Array[] = [];
    for (let o = 0; o + FRAME <= out16.length; o += FRAME) {
      const b = new Uint8Array(FRAME * 2);
      const bv = new DataView(b.buffer);
      for (let i = 0; i < FRAME; i += 1) bv.setInt16(i * 2, out16[o + i] ?? 0, true);
      out.push(b);
    }
    if (out.length < 10) return null;
    {
      let peak = 0;
      let sum = 0;
      for (let i = 0; i < out16.length; i += 1) {
        const a = Math.abs(out16[i] ?? 0);
        if (a > peak) peak = a;
        sum += (out16[i] ?? 0) ** 2;
      }
      const rms = Math.sqrt(sum / Math.max(1, out16.length));
      console.log(
        `  (real speech: ${out.length} frames of 20ms, ${(out16.length / 16000).toFixed(2)}s, ` +
          `peak=${peak} rms=${rms.toFixed(0)} srcRate=${sampleRate})`,
      );
    }
    return out;
  } catch (e) {
    console.log(`  (TTS unavailable: ${e instanceof Error ? e.message : String(e)})`);
    return null;
  }
}

async function run(): Promise<void> {
  const speech = (await realSpeech()) ?? speechFrames(75);
  const targets = (process.env.PROBE_AGENTS || "agnes,mia").split(",").map((s) => s.trim());
  const agent = targets[0] === "mia" ? null : targets[0];
  await probe(agent, speech);
  process.exit(0);
}

await run();