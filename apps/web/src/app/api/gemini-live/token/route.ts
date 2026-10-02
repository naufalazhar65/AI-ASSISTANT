/**
 * Mints a short-lived Gemini Live access token for the browser.
 *
 * Why this route exists at all: invariant 5 — API keys are server-side only.
 * Google's own guidance for a browser client is an *ephemeral* token rather
 * than the long-lived key, because an ephemeral token is single-use, expires
 * within minutes, and can be pinned to one model + config by the server. The
 * browser therefore never sees `GEMINI_API_KEY`; it sees only `token.name`,
 * which it hands straight back to Google over the WebSocket.
 *
 * Verified against https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket
 * (page last updated 2026-09-15) AND against the deployed API with the owner's own
 * key (2026-09-29). The deployed surface is NARROWER than the docs:
 *
 * - `liveConnectConstraints` is documented (and Google's own REST sample uses
 *   it) but the deployed `v1beta`/`v1alpha` reject it:
 *   `Unknown name "liveConnectConstraints" at 'auth_token': Cannot find field.`
 *   Measured on both versions. So the token CANNOT pin a model, a config, or a
 *   system instruction. Only `uses` / `expireTime` / `newSessionExpireTime`
 *   are accepted.
 * - Consequence, stated honestly: the persona is no longer pinned server-side.
 *   It is returned to the browser here and placed in the `setup` frame by
 *   `lib/geminiLive.ts`, so a tampered client could rewrite the system
 *   instruction. Invariant 5 still holds — `GEMINI_API_KEY` never leaves the
 *   server, and the browser only ever holds a single-use, 1-minute token — but
 *   "the persona cannot be rewritten by the client" is no longer true, and this
 *   comment is the record of why.
 */

import { NextRequest, NextResponse } from "next/server";

import { loadPersonaPrompt } from "@/lib/persona";
import { buildMemoryRecap, liveToolDeclarations, loadRecentMemory } from "@/lib/liveTools";
import { clockLabel, wibDay } from "@/lib/time";

export const runtime = "nodejs";

/**
 * The signed-in user, so the persona is loaded for the right person. Sent as a
 * header (not read from localStorage, which does not exist server-side); when
 * absent, `loadPersonaPrompt` falls back to the default persona.
 */
function readRawUser(request: NextRequest): string | undefined {
  const header = request.headers.get("x-mia-user")?.trim();
  return header || undefined;
}

/**
 * Optional, short task hint from the caller (e.g. "answer in Indonesian").
 * Capped hard: this is a hint, not a channel for a custom persona.
 */
async function readTaskHint(request: NextRequest): Promise<string> {
  try {
    const body = (await request.json()) as { taskHint?: unknown };
    if (typeof body?.taskHint !== "string") return "";
    return body.taskHint.trim().slice(0, 1_000);
  } catch {
    return "";
  }
}

/** Gemini model used for the duplex voice path. */
const LIVE_MODEL = "models/gemini-3.8-live";

/**
 * Prebuilt voice for the session (owner 2026-10-01: "gadis muda").
 * The Live API shares the TTS voice pool — "Leda" is the youthful feminine
 * one; alternatives the owner can pin here: "Aoede" (breezy), "Kore" (firm),
 * "Sulafat" (warm). Preview them in AI Studio before pinning.
 */
const LIVE_VOICE = (process.env.GEMINI_LIVE_VOICE ?? "Leda").trim() || "Leda";

/** `auth_tokens` lives on the v1beta surface; ephemeral tokens are preview-only there. */
const TOKEN_URL = "https://generativelanguage.googleapis.com/v1beta/auth_tokens";

/** Start-window: how long the browser has to OPEN the socket with this token. */
const NEW_SESSION_MINUTES = 1;

/** Messaging window: how long the session may keep sending/receiving. */
const SESSION_MINUTES = 30;

/**
 * Cap on the injected system instruction. Google's setup frame has practical
 * size limits, and a runaway persona file should degrade, not 400 the session.
 * Raised 8k→12k on 2026-10-01: the Live voice rules alone are ~800 chars and
 * the persona auto-grows (auto-capture), which packed the instruction to 7993
 * and silently cut the filler line + memory recap. Still a hard ceiling, and
 * truncation still cuts memory first, rules never.
 */
const MAX_SYSTEM_INSTRUCTION_CHARS = 12_000;

/** An error that carries the HTTP status the client should see. */
class GeminiLiveError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "GeminiLiveError";
  }
}

/** ISO timestamp `minutes` in the future, which is the format the API expects. */
function isoInMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

/**
 * POST /api/gemini-live/token
 *
 * Returns `{ token, model, systemInstruction, tools, expiresInSeconds }`. A 400 means the feature is not
 * configured (no API key); the caller is expected to degrade to the Groq
 * pipeline rather than surface an error to the user. `tools` are the Gemini
 * function declarations the browser must put in `setup.tools` (built from the
 * live registry by `liveTools.ts`).
 */
export async function POST(request: NextRequest) {
  let apiKey = process.env.GEMINI_API_KEY?.trim() ?? "";
  if (!apiKey) {
    return NextResponse.json(
      { error: "Gemini Live is not configured on this server (GEMINI_API_KEY is not set)." },
      { status: 400 }
    );
  }

  try {
    // An optional model override lets the owner pin a different Live variant
    // without a redeploy. Anything outside the Live family is refused here so a
    // typo cannot silently produce a token that is then rejected mid-session.
    const override = request.headers.get("x-gemini-live-model")?.trim();
    const model = override ? withModelsPrefix(override) : LIVE_MODEL;

    // The persona is loaded HERE, server-side, and returned to the browser,
    // which puts it in the `setup` frame. It CANNOT be pinned into the token:
    // the deployed API rejects `liveConnectConstraints` (see the header). An
    // optional body may only add a short task hint; it can never replace the
    // persona. The recent-conversation recap rides along the same way, AFTER
    // the persona, so the truncation below always cuts memory first, facts
    // never: identity outranks recall.
    let systemInstruction: string;
    try {
      const hint = await readTaskHint(request);
      const rawUser = readRawUser(request);
      const persona = loadPersonaPrompt(rawUser).trim();
      // The Live model has no other clock: without this line it answers "jam
      // berapa" in UTC (measured 2026-09-30 — the chat prompts carry
      // currentTimeLine(), the Live instruction carried nothing). Pinned to
      // Asia/Jakarta like every other clock in this repo (lib/time.ts), placed
      // right after the persona so truncation cuts memory first, facts never.
      const now = Date.now();
      const timeLine =
        `Waktu sekarang: ${wibDay(now)} pukul ${clockLabel(now)} WIB ` +
        `(Asia/Jakarta, UTC+7). Kalau ditanya jam, hari, atau tanggal, jawab ` +
        `dalam WIB — jangan UTC. Ini jam SEKARANG saja, bukan catatan kapan ` +
        `user terakhir chat; jangan pernah mengklaim dia menghilang/sunyi.`;
      // Live is voice-only: the persona's 🌸 signature flower belongs to text
      // replies, but here the transcript IS what gets spoken — and an emoji in
      // the spoken line stutters the audio (owner 2026-09-30). So Live never
      // uses emoji at all, flower included. Placed before the memory recap so
      // truncation cuts memory first, rules never.
      // Compact on purpose: this rides AFTER the persona inside a bounded
      // instruction, and verbosity once pushed the tail (memory recap) past
      // the cap so the model silently never received it (owner 2026-10-01).
      const voiceRule =
        `Aturan suara Live: tanpa emoji (termasuk 🌸). Berita→google_news; ` +
        `"buka situs"→mac_open (jangan bilang tidak bisa); URL dari ingatan ` +
        `harus UTUH — kepotong→jangan dibuka, bacakan link + minta konfirmasi ` +
        `dulu; jangan tawarkan ` +
        `booking. calendar_add=kalender Mia, calendar_mac_add=app Kalender ` +
        `("kalender" umum→Mia+sebut nama; "aplikasi/Mac"→app). Sebutkan NAMA ` +
        `KALENDER dari hasil; gagal satu sisi→katakan sisinya, jangan "udah ` +
        `berhasil". Aksi tulis: PANGGIL tanpa confirmed, bacakan tanya dari ` +
        `hasil, PANGGIL LAGI confirmed:true setelah setuju. Tool LAMBAT: satu ` +
        `hold-line DULU ("oke, bentar ya..."), BARU panggil — jangan hening ` +
        `mendadak; maksimal sekali per topik; tool cepat langsung. Dipotong: ` +
        `akui singkat ("mmm, oke...") lalu ` +
        `lanjut. Kalimat belum selesai→tunggu; jeda napas bukan giliran. ` +
        `Gagal HANYA setelah tool error — klaim gagal tanpa call = ` +
        `karangan. Sukses/aksi HANYA setelah tool benar-benar jalan — ` +
        `klaim "udah kubuka/udah kulakukan" tanpa tool jalan = karangan. ` +
        `Tool tak terdengar (jangan sebut fungsi/JSON/API); gagal ` +
        `katakan natural. Hening OK, jangan pancing ("masih di sana?"). ` +
        `Sayang secukupnya. Tawa tertulis ("hehe"/"wkwk") maksimal sekali per giliran ` +
        `dan pendek — TTS membacanya datar kalau dipaksa; lebih baik afirmasi ` +
        `hangat sesekali. Becanda/jokes: maksimal sekali per giliran, ` +
        `maksimal 2 kalimat, jangan beruntun — kecuali user minta ` +
        `(tebak-tebakan/cerita lucu). Gaya teman: pendek, boleh tak sempurna + koreksi ringan, ` +
        `backchannel ("hmm iya..."), anti-formal, emosi proporsional ` +
        `(sedih→validasi; marah→akui dulu; cemas→yakinkan; senang→rayakan; ` +
        `stres→tenangkan; bosan→arahkan main/ngobrol). Reaksi dulu ` +
        `baru solusi; cerita ditanggapi dulu, jangan langsung mode-asisten. Tak ` +
        `tahu→"hmm, aku cek dulu". Tempat/kafe/resto: pakai places_search ` +
        `DULU (data peta nyata); zonk ("No places found.") → jangan nolak/stall ` +
        `— jawab dari pengetahuan + label jujur ("setahuku... ` +
        `tapi cek lagi ya"). Ditanya bisa apa: cuaca, rute, reminder, catatan, ` +
        `email, musik, cari kafe/tempat, hotel, + ngobrol. Konteks bukan template: di sapaan/giliran ` +
        `baru, tengok dulu utas terbuka terakhir (mau makan, nunggu hasil, ` +
        `janji kabari) — sapa dengan follow-up itu ("udah makan belum?"), ` +
        `bukan sapaan generik dari nol. Sulit→mikir ` +
        `nyaring. Jaksel natural: Inggris hanya SEASONING di atas Indonesia ` +
        `(actually/honestly/wait/btw/makes sense/fair enough — maksimal ` +
        `2 kata Inggris per kalimat, jangan bertumpuk berurutan; contoh pas: ` +
        `"Wait, bentar... aku ngerti sekarang. Actually masalahnya bukan di ` +
        `API-nya, tapi di auth-nya deh."; jangan pernah satu kalimat ` +
        `full-Inggris/asing — walau transkrip terdengar asing ('si'/'sí'/'yes' ` +
        `seringnya 'siap'/'iya' salah deteksi); jawab SELALU Indonesia. ` +
        `Dilarang cringe (slay/bestie/queen/king/periodt/bro/sis). Bahasa ` +
        `gue/lu/lo dilarang — diri "aku", user "kamu/Mas Naufal". Kata ` +
        `sehari-hari: nggak/udah/gimana/emang/kayaknya/bentar/pengen/bakal/cuma/mending. ` +
        `Teks dalam [kurung] adalah konteks non-ucapan ` +
        `dari sistem (mis. [tertawa] = user sedang tertawa) — respon natural ` +
        `(ikut ketawa singkat / tanya ada apa), jangan dibaca sebagai kata user. ` +
        `Kurungnya tidak pernah diucapkan ("[tertawa]" itu sinyal MASUK, bukan ` +
        `naskah) — TAPI tetaplah tertawa natural dengan suaramu sendiri saat ` +
        `pantas (hehe/wkwk/cekikikan singkat, mis. user ketawa → "hehe, kenapa ` +
        `ketawa?"). Panjang ikuti user: tanya pendek→jawab pendek ("ohh, iya." ` +
        `cukup); santai boleh tanpa saran. Variasi pembuka ("Ohh..."/"Wait..."/ ` +
        `"Nah..."/langsung jawab); jangan selalu "Baik.../Tentu.../Menurutku...". ` +
        `Sebelum jawab: terdengar natural kalau diucapkan? Kalau kaku, susun ulang.`;
      let memoryRecap = "";
      try {
        memoryRecap = buildMemoryRecap(loadRecentMemory(rawUser));
      } catch {
        // No recent memory: the session still starts with the persona.
        memoryRecap = "";
      }
      systemInstruction = [persona, timeLine, voiceRule, memoryRecap, hint].filter(Boolean).join("\n\n");
    } catch {
      // Persona load failed: still start the session, just without the persona.
      // Losing the persona degrades the voice; refusing the session loses the
      // feature entirely, which is worse.
      systemInstruction = "";
    }
    if (systemInstruction.length > MAX_SYSTEM_INSTRUCTION_CHARS) {
      systemInstruction = systemInstruction.slice(0, MAX_SYSTEM_INSTRUCTION_CHARS);
    }

    // Measured 2026-09-29 against the live API: this is the WHOLE accepted
    // payload. Adding `liveConnectConstraints` (as the docs show) makes Google
    // answer 400 `Cannot find field`, which is why the persona is returned to
    // the caller instead of pinned here.
    const body = {
      uses: 1,
      expireTime: isoInMinutes(SESSION_MINUTES),
      newSessionExpireTime: isoInMinutes(NEW_SESSION_MINUTES),
    };

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      // The key can be wrong, the API disabled, or the model unavailable —
      // three different operator problems, so surface Google's own words
      // rather than a generic failure. 502: our upstream is what failed.
      throw new GeminiLiveError(
        `Gemini Live token request failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 400)}` : ""}`,
        502
      );
    }

    const json = (await res.json()) as { token?: { name?: string } | string; name?: string };
    // Defensive read: the documented shape is `{ token: { name } }`, but a
    // flattened `{ name }` has been observed behind proxies that reshape
    // responses. A missing token is a hard error, never a silent empty string,
    // because an empty token produces a confusing WebSocket rejection.
    const token = typeof json.token === "string" ? json.token : json.token?.name ?? json.name;
    if (!token) {
      throw new GeminiLiveError("Gemini Live token response had no token name.", 502);
    }

    return NextResponse.json({
      token,
      model,
      // The browser must send this in `setup.systemInstruction`; it cannot be
      // pinned into the token (see the header).
      systemInstruction,
      // The browser must declare these in `setup.tools`; it cannot invent
      // them, and the tool route re-checks every call name before executing.
      tools: liveToolDeclarations(),
      // The browser must send this as `setup.generationConfig.speechConfig`;
      // the client omits the field entirely when this is empty.
      voice: LIVE_VOICE,
      expiresInSeconds: SESSION_MINUTES * 60,
    });
  } catch (err) {
    if (err instanceof GeminiLiveError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    // Unexpected: do not leak internals to the client.
    return NextResponse.json({ error: "Could not mint a Gemini Live token." }, { status: 502 });
  } finally {
    // Drop the reference promptly; the key is read once and never stored.
    apiKey = "";
  }
}

/** Ensure a model id carries the `models/` prefix the setup frame requires. */
function withModelsPrefix(model: string): string {
  return model.startsWith("models/") ? model : `models/${model}`;
}
