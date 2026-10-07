import { PassThrough } from "node:stream";
import { ChannelType, type Client } from "discord.js";
import {
  GeminiLiveSession,
  stripLiveFlower,
  type GeminiLiveEvent,
  type LiveToolResult,
} from "../lib/geminiLive";
import {
  bytesToBase64,
  floatTo16BitPcm,
  pcm16ToFloat32,
  resampleFloat32,
  LIVE_INPUT_SAMPLE_RATE,
  LIVE_OUTPUT_SAMPLE_RATE,
} from "../lib/pcm";
import { isAgentLabel, type AgentLabel } from "../lib/agentRole";

/**
 * Discord VOICE CHANNEL for the trio (owner 2026-10-06: "bisa ga sih fitur
 * voice channel di aktifkan? … mis. saya ingin ngobrol dengan michelle").
 *
 * Design — the NAMED agent's own bot joins (owner 2026-10-06: calling
 *   Michelle must show Michelle in the channel, not the host):
 *   the `!voice` handler resolves WHO is being spoken to and joins with THAT
 *   agent's own gateway client, driving the EXISTING `GeminiLiveSession` (the
 *   same duplex client the web console uses — not a STT→text→TTS loop, which
 *   is what the owner asked to avoid: "kalau bisa semuanya pakai gemini live
 *   aja biar realistis"). One voice presence at a time: a new `!voice on`
 *   stops any other agent's session first, so two voices never overlap; the
 *   `addressedAgentByName` (discord.ts) decision picks WHO, so "halo michelle"
 *   picks Michelle and nobody else answers.
 *
 * Sample-rate plumbing (the part that is easy to get wrong):
 *   - Discord voice is ALWAYS 48 kHz, STEREO, signed 16-bit LE PCM.
 *   - Gemini Live input wants 16 kHz MONO; its output arrives 24 kHz MONO.
 * Both directions therefore need a downmix + resample, done in float and
 * converted back with the repo's own `lib/pcm` helpers so there is exactly
 * ONE definition of the conversions.
 *
 * Missing native deps must never take the bot down: `@discordjs/voice` (plus
 * `sodium` and an Opus encoder) is imported LAZILY, so an un-installed voice
 * stack degrades to "voice unavailable" instead of a crashed Discord client.
 */

/** Discord's voice wire format: fixed by the protocol, not configurable. */
export const DISCORD_VOICE_SAMPLE_RATE = 48_000;

/** Silence gap that closes an output burst (a finished reply). */
const OUT_TAIL_MS = 700;

/** Never let a tool call stall the session (it is synchronous for Live). */
const TOOL_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Pure format helpers (exported so they can be unit-tested without Discord)
// ---------------------------------------------------------------------------

/** Decode Discord's 48 kHz stereo Opus to 16 kHz MONO Int16 — the Live input
 *  wire format. Separated from the byte-level bridge below so the framing
 *  layer can work in samples (a fixed 320-sample frame) instead of guessing
 *  byte counts. Exported for unit tests. */
export function opusPcmToLiveMono(pcm: Uint8Array): Int16Array {
  const raw = pcm16ToFloat32(pcm);
  const frames = raw.length >> 1;
  if (!frames) return new Int16Array(0);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    mono[i] = ((raw[i * 2] ?? 0) + (raw[i * 2 + 1] ?? 0)) / 2;
  }
  const at16k = resampleFloat32(mono, DISCORD_VOICE_SAMPLE_RATE, LIVE_INPUT_SAMPLE_RATE);
  const out = new Int16Array(at16k.length);
  for (let i = 0; i < at16k.length; i += 1) {
    const v = Math.max(-1, Math.min(1, at16k[i] ?? 0));
    out[i] = Math.round(v < 0 ? v * 0x8000 : v * 0x7fff);
  }
  return out;
}

/** Int16 samples -> little-endian bytes. */
export function int16ToBytes(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i += 1) view.setInt16(i * 2, samples[i] ?? 0, true);
  return bytes;
}

/** Discord 48 kHz stereo Int16 -> Gemini Live 16 kHz mono Int16. */
export function discordPcmToLiveInput(bytes: Uint8Array): Uint8Array {
  return int16ToBytes(opusPcmToLiveMono(bytes));
}

/** Gemini Live 24 kHz mono Int16 -> Discord 48 kHz stereo Int16. */
export function liveAudioToDiscordPcm(bytes: Uint8Array): Uint8Array {
  const mono = pcm16ToFloat32(bytes);
  if (!mono.length) return new Uint8Array(0);
  const at48 = resampleFloat32(mono, LIVE_OUTPUT_SAMPLE_RATE, DISCORD_VOICE_SAMPLE_RATE);
  const stereo = new Float32Array(at48.length * 2);
  for (let i = 0; i < at48.length; i += 1) {
    const s = at48[i] ?? 0;
    stereo[i * 2] = s;
    stereo[i * 2 + 1] = s;
  }
  return floatTo16BitPcm(stereo);
}

// ---------------------------------------------------------------------------
// Lazy voice dependency loader
// ---------------------------------------------------------------------------

type VoiceDeps = typeof import("@discordjs/voice");

let voiceDepsPromise: Promise<VoiceDeps> | null = null;
/** Set when a load actually failed. `voiceDepsPromise === null` is NOT this:
 *  it is also true before the first load, which is why the naive version of
 *  this predicate reported "missing" on a perfectly healthy install. */
let voiceDepsMissing = false;

export function voiceDependenciesMissing(): boolean {
  return voiceDepsMissing;
}

async function loadVoiceDeps(): Promise<VoiceDeps> {
  if (!voiceDepsPromise) {
    voiceDepsMissing = false;
    voiceDepsPromise = import(/* webpackIgnore: true */ "@discordjs/voice").catch((e) => {
      voiceDepsPromise = null;
      voiceDepsMissing = true;
      throw new Error(
        "Discord voice is not installed. Run: npm i @discordjs/voice sodium @discordjs/opus " +
          `(${e instanceof Error ? e.message : String(e)})`
      );
    });
  }
  return voiceDepsPromise;
}

// ---------------------------------------------------------------------------
// Session registry (process-wide, one live session per agent)
// ---------------------------------------------------------------------------

export interface VoiceSessionInfo {
  agent: AgentLabel;
  channelId: string;
  guildId: string;
  startedAt: number;
  /** Why the session ended, for the log and the next reply. */
  detail: string;
}

interface ActiveVoice extends VoiceSessionInfo {
  stop: () => Promise<void>;
}

const active = new Map<AgentLabel, ActiveVoice>();

export function isVoiceActive(agent?: AgentLabel): boolean {
  return agent ? active.has(agent) : active.size > 0;
}

export function voiceSessionInfo(): VoiceSessionInfo[] {
  return [...active.values()].map(({ agent, channelId, guildId, startedAt, detail }) => ({
    agent,
    channelId,
    guildId,
    startedAt,
    detail,
  }));
}

function sessionKey(agent: AgentLabel): string {
  return `discord-voice-${agent}`;
}

// ---------------------------------------------------------------------------
// Start / stop
// ---------------------------------------------------------------------------

export interface StartVoiceOptions {
  /** The HOST bot's discord.js client (the one that joins the channel). */
  client: Client;
  guildId: string;
  /** VOICE channel id (Discord validates the type; we assert it too). */
  voiceChannelId: string;
  /** Whose mic we listen to — the owner. */
  ownerId: string;
  /** Who is being spoken to (decides persona + voice). */
  agent: AgentLabel;
  /** Persona/memory key for that agent (e.g. `naufalazhar652952.michelle`). */
  userKey: string;
  /** Text channel where each finished turn is posted for the record. */
  textChannelId: string;
  /** Absolute URL of `/api/gemini-live/token`. */
  tokenUrl: string;
  /** Absolute URL of `/api/gemini-live/tool`. */
  toolUrl: string;
}

/** Human-facing one-liner, safe to post straight into Discord. */
export function voiceCommandHelp(): string {
  return (
    "**Voice** — `!voice on [nama]` membawa akun bot yang kamu sebut ke voice " +
    "channel (`!voice on michelle` → Michelle yang masuk, bukan Mia), ngomong " +
    "biasa seperti human, dan dia jawab dengan suara. `!voice off` untuk " +
    "berhenti. Sebut namanya kalau mau ngomong ke yang tertentu (mis. \"halo " +
    "michelle\") — yang lain diam. Kalau voice-nya belum aktif, jalankan " +
    "`npm i @discordjs/voice sodium @discordjs/opus` lalu restart."
  );
}

/**
 * Join the voice channel and start a duplex Live session for `agent`.
 * Idempotent per agent: a second `on` stops the previous session first.
 * Throws with a message that is already safe to show the owner.
 */
export async function startDiscordVoice(opts: StartVoiceOptions): Promise<string> {
  if (!isAgentLabel(opts.agent)) throw new Error(`unknown agent "${String(opts.agent)}"`);
  await stopDiscordVoice(opts.agent);

  const deps = await loadVoiceDeps();
  const { agent } = opts;

  const channel = await opts.client.channels.fetch(opts.voiceChannelId);
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    throw new Error(
      `channel ${opts.voiceChannelId} is not a voice channel — set DISCORD_VOICE_CHANNEL_ID to a voice channel id`
    );
  }

  // A voice channel always belongs to a guild; the gateway adapter that
  // carries voice signalling comes from that guild object (there is no
  // `PrismMediaAdapter` export — that was a guess that never existed).
  // DM context has no voice channel, so an empty guildId fails here with a
  // message that is already safe to show the owner.
  const guild = await opts.client.guilds.fetch(opts.guildId).catch(() => null);
  if (!guild) {
    throw new Error(
      "could not find the server for this voice channel — run `!voice on` from a server text channel, not a DM"
    );
  }

  // `selfDeaf` MUST be false: the receiver only yields audio when we are not
  // deafened (stated on `VoiceConnection.receiver` itself). Deafening would
  // make the mic silently dead — the worst failure mode for a voice feature.
  // No feedback loop: the receiver only streams OTHER users' packets, never
  // our own player output. `selfMute` stays true (we speak via the player,
  // never via a mic input).
  const connection = await (async () => {
    try {
      const conn = deps.joinVoiceChannel({
        channelId: opts.voiceChannelId,
        guildId: opts.guildId,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: true,
      });
      await deps.entersState(conn, deps.VoiceConnectionStatus.Ready, 20_000);
      return conn;
    } catch (e) {
      throw new Error(
        `could not join the voice channel (${e instanceof Error ? e.message : String(e)})`
      );
    }
  })();

  // --- Gemini Live session -------------------------------------------------
  const live = new GeminiLiveSession({
    // Server-side: the token route must be ABSOLUTE (Node has no origin to
    // resolve the browser-relative path against), and both identity headers
    // must be explicit because there is no localStorage to derive them from.
    tokenUrl: opts.tokenUrl,
    userHeader: { "x-mia-user": opts.userKey, "x-mia-agent": agent },
    enableInputTranscription: true,
    enableOutputTranscription: true,
  });

  const started = await live.start();
  if (!started.ok) {
    try {
      connection.destroy();
    } catch {
      /* ignore */
    }
    throw new Error(started.error ?? "Gemini Live did not start");
  }

  // --- output (Live -> Discord) -------------------------------------------
  // Playback goes through an AudioPlayer subscribed to the connection:
  // `VoiceConnection` has no `.play()` of its own. One player lives for the
  // whole session; each reply burst gets a fresh stream + resource on it.
  const player = deps.createAudioPlayer();
  connection.subscribe(player);
  let out: PassThrough | null = null;
  let tailTimer: ReturnType<typeof setTimeout> | null = null;

  const closeOut = () => {
    if (tailTimer) {
      clearTimeout(tailTimer);
      tailTimer = null;
    }
    if (out) {
      try {
        out.end();
      } catch {
        /* ignore */
      }
      out = null;
    }
  };

  const pushOut = (pcm: Uint8Array) => {
    if (!pcm.length) return;
    if (!out) {
      out = new PassThrough();
      // Pass the stream itself, NOT `Readable.from(out)`: the resource already
      // consumes a Readable, and re-wrapping a PassThrough adds a needless
      // layer that muddies backpressure between Gemini and the encoder.
      const resource = deps.createAudioResource(out, {
        inputType: deps.StreamType.Raw,
      });
      try {
        player.play(resource);
      } catch (e) {
        console.warn("[discord-voice] play failed:", e instanceof Error ? e.message : String(e));
      }
    }
    out.write(Buffer.from(pcm));
    if (tailTimer) clearTimeout(tailTimer);
    tailTimer = setTimeout(closeOut, OUT_TAIL_MS);
  };

  // --- input (Discord -> Live) --------------------------------------------
  // The receiver yields Opus PACKETS, not PCM (`AudioReceiveStream` is
  // documented as "a readable stream of Opus packets"), so each chunk is
  // decoded with the repo's own `@discordjs/opus` binding before the
  // mono-downmix + resample in `discordPcmToLiveInput`. There is no
  // `mode: "pcm"` subscribe option — that was a guess that never existed,
  // and decoding matters: feeding Opus bytes in as if they were PCM would
  // be loud garbage, not silence.
  let opus: { decode(buf: Buffer): Buffer } | null = null;
  try {
    // ESM/CJS interop: under `import()` the CJS `module.exports` may land on
    // `.default` instead of the namespace top level (observed live), so both
    // shapes are accepted — a missing constructor must never read as a
    // missing install.
    const opusNs = (await import(
      /* webpackIgnore: true */ "@discordjs/opus"
    )) as unknown as {
      OpusEncoder?: new (rate: number, channels: number) => {
        decode(buf: Buffer): Buffer;
      };
      default?: {
        OpusEncoder?: new (rate: number, channels: number) => {
          decode(buf: Buffer): Buffer;
        };
      };
    };
    const OpusEncoder = opusNs.OpusEncoder ?? opusNs.default?.OpusEncoder;
    if (!OpusEncoder) throw new Error("OpusEncoder export not found");
    opus = new OpusEncoder(
      DISCORD_VOICE_SAMPLE_RATE,
      2
    );
  } catch (e) {
    live.stop();
    connection.destroy();
    throw new Error(
      `could not load the Opus decoder (${e instanceof Error ? e.message : String(e)}) — ` +
        "run: npm i @discordjs/opus (needs a native build) then restart"
    );
  }
  let sub: ReturnType<typeof connection.receiver.subscribe> | null = null;
  let micPackets = 0;

  // --- input framing (the "sometimes answers, sometimes doesn't" bug) ------
  // Discord hands us Opus packets whose sizes jump around (measured live:
  // 167B … then 3B — the 3B ones are DTX/silence frames). Forwarding those
  // verbatim sends Gemini ragged, empty-ish realtimeInput frames, and its
  // server-side voice-activity detection then fails to see the end of an
  // utterance — the turn never closes, so the model stays silent. The web
  // console and coucou are immune because their browser capture ALWAYS
  // produces fixed 16 kHz frames; this bridge has to do that itself.
  //
  // So: accumulate decoded PCM and emit exactly FRAME_SAMPLES Int16 per
  // frame, zero-padding the tail. Steady framing is what the VAD expects.
  const FRAME_SAMPLES = 320; // 20 ms at 16 kHz
  let pendingMono = new Int16Array(0);

  function emitFixedFrames(mono: Int16Array): void {
    if (!mono.length) return;
    const buf = new Int16Array(pendingMono.length + mono.length);
    buf.set(pendingMono, 0);
    buf.set(mono, pendingMono.length);
    const usable = buf.length - (buf.length % FRAME_SAMPLES);
    for (let off = 0; off < usable; off += FRAME_SAMPLES) {
      const bytes = int16ToBytes(buf.slice(off, off + FRAME_SAMPLES));
      live.sendAudioFrame(bytes, bytesToBase64(bytes));
    }
    // Keep the ragged remainder for the next packet — dropping it here would
    // click at every boundary, the same defect the web player had.
    pendingMono = buf.slice(usable);
  }

  try {
    sub = connection.receiver.subscribe(opts.ownerId, {
      end: { behavior: deps.EndBehaviorType.Manual },
    });
  } catch (e) {
    live.stop();
    connection.destroy();
    throw new Error(
      `could not subscribe to your mic (${e instanceof Error ? e.message : String(e)}) — ` +
        "unmute yourself in the voice channel first"
    );
  }
  sub.on("data", (chunk: Buffer) => {
    try {
      micPackets += 1;
      // First packet only: it proves the mic path is alive (the 2026-10-06
      // "mic never reaches Gemini" hunt needed exactly this one line). Per-
      // packet or periodic logging would drown the log for no extra signal.
      if (micPackets === 1) {
        console.log(`[discord-voice] mic stream alive (last packet ${chunk.length}B opus)`);
      }
      if (!opus) return;
      emitFixedFrames(opusPcmToLiveMono(opus.decode(chunk)));
    } catch (e) {
      console.warn("[discord-voice] input convert failed:", e instanceof Error ? e.message : String(e));
    }
  });
  sub.on("error", (e: unknown) => {
    console.warn("[discord-voice] mic stream error:", e instanceof Error ? e.message : String(e));
  });

  // --- events --------------------------------------------------------------
  let inText = "";
  let outText = "";
  // Latency probe (owner 2026-10-06: "lama responnya"): turn-end → first
  // reply-audio, logged per turn so slowness is a NUMBER from the server log,
  // not a feeling. Resets on every new turn. One line per turn is the whole
  // budget — the transcript itself is posted to the text channel by
  // postTranscript(), so it must NOT be logged twice.
  let turnEndAt = 0;
  let firstAudioLogged = false;
  const sessionStartAt = Date.now();
  const off = live.on((event: GeminiLiveEvent) => {
    switch (event.type) {
      case "audio":
        if (!firstAudioLogged) {
          firstAudioLogged = true;
          console.log(
            `[discord-voice] first-audio latency: ${Date.now() - (turnEndAt || sessionStartAt)}ms`
          );
        }
        pushOut(liveAudioToDiscordPcm(event.pcm));
        break;
      case "input_transcript":
        inText = event.text;
        break;
      case "output_transcript":
        outText = event.text;
        break;
      case "speaking":
        // `speaking: true` opens a turn: reset the accumulators so one turn
        // never inherits the previous one (the session assigns, not appends).
        if (event.speaking) {
          inText = "";
          outText = "";
          turnEndAt = 0;
          firstAudioLogged = false;
        } else {
          turnEndAt = Date.now();
          closeOut();
          // Without this the text channel never shows what was said and the
          // accumulators grow for the whole session: the "auditable
          // transcript" was documented in postTranscript but never fired.
          void postTranscript("turn selesai");
        }
        break;
      case "interrupted":
        closeOut();
        break;
      case "tool_call": {
        void runToolCalls(event.calls)
          .then((results) => live.sendToolResponse(results))
          .catch((e) => {
            // An unanswered Live tool call is a HUNG conversation (measured
            // 2026-09-30), so even a failure must be answered.
            const message = e instanceof Error ? e.message : String(e);
            live.sendToolResponse(
              event.calls.map((c) => ({ id: c.id, name: c.name, result: `Error: ${message}` }))
            );
          });
        break;
      }
      case "error":
        console.warn("[discord-voice] live error:", event.message);
        break;
      default:
        break;
    }
  });

  /** Every tool call MUST be answered (Live is synchronous). */
  async function runToolCalls(calls: { id: string; name: string; args: Record<string, unknown> }[]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TOOL_TIMEOUT_MS);
    try {
      const res = await fetch(opts.toolUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-mia-user": opts.userKey,
        },
        body: JSON.stringify({ calls }),
        signal: controller.signal,
      });
      const json = (await res.json().catch(() => ({}))) as {
        results?: { id: string; result?: string; name?: string }[];
      };
      const byId = new Map((json.results ?? []).map((r) => [r.id, r]));
      return calls.map<LiveToolResult>((c) => ({
        id: c.id,
        name: c.name,
        result: byId.get(c.id)?.result ?? "Error: no result returned",
      }));
    } finally {
      clearTimeout(timer);
    }
  }

  /** Post the finished turn as text, so the voice chat is auditable. */
  async function postTranscript(detail: string): Promise<void> {
    const said = stripLiveFlower(outText).trim();
    const heard = inText.trim();
    if (!said && !heard) return;
    try {
      const tc = await opts.client.channels.fetch(opts.textChannelId);
      if (!tc || !("send" in tc)) return;
      const lines: string[] = [];
      if (heard) lines.push(`_kamu_: ${heard}`);
      if (said) lines.push(`_${agent} (voice)_: ${said}`);
      lines.push(`_voice session ${detail}_`);
      await (tc as unknown as { send(content: string): Promise<unknown> }).send(lines.join("\n"));
    } catch (e) {
      console.warn("[discord-voice] transcript post failed:", e instanceof Error ? e.message : String(e));
    }
  }

  // --- teardown ------------------------------------------------------------
  const stop = async () => {
    off();
    closeOut();
    try {
      player.stop(true);
    } catch {
      /* ignore */
    }
    try {
      sub?.destroy();
    } catch {
      /* ignore */
    }
    try {
      live.stop();
    } catch {
      /* ignore */
    }
    try {
      connection.destroy();
    } catch {
      /* ignore */
    }
    active.delete(agent);
  };

  active.set(agent, {
    agent,
    channelId: opts.voiceChannelId,
    guildId: opts.guildId,
    startedAt: Date.now(),
    detail: "listening",
    stop,
  });

  void postTranscript("start");
  console.log(
    `[discord-voice] ${agent} joined ${opts.voiceChannelId} (live via ${started.via})`
  );
  // No signature glyph here on purpose: the host bot can be Agnes or Michelle
  // (DISCORD_VOICE_HOST), and the trio glyph firewall lives in `runAgent`, not
  // in channel-level replies — so a 🌸 here would leak from a non-Mia bot,
  // which is exactly the defect class this repo keeps closing.
  return `${agent} masuk voice channel, langsung ngomong aja`;
}

export async function stopDiscordVoice(agent: AgentLabel): Promise<boolean> {
  const s = active.get(agent);
  if (!s) return false;
  await s.stop();
  console.log(`[discord-voice] ${agent} left the voice channel`);
  return true;
}

export async function stopAllDiscordVoice(): Promise<void> {
  await Promise.all([...active.keys()].map((a) => stopDiscordVoice(a)));
}
