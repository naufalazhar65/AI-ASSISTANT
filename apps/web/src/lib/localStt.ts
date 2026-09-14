/**
 * Local speech-to-text via the Whisper CLI (OpenAI Whisper, brew: openai-whisper)
 * — offline, no API key, no OpenClaw dependency. Mia owns this: it shells out to
 * the `whisper` binary, writes the transcript to a temp dir, reads it back.
 *
 * Safety: the caller supplies an already-sandboxed/per-user absolute path; the
 * model/language/task are validated against allowlists so nothing user-controlled
 * reaches the shell (execFile, no shell interpretation).
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

const MODELS = new Set([
  "tiny", "tiny.en", "base", "base.en", "small", "small.en", "medium", "medium.en",
  "large", "large-v1", "large-v2", "large-v3", "turbo", "large-v3-turbo", "distil-large-v3",
]);
const AUDIO_EXT = new Set([".mp3", ".m4a", ".wav", ".aiff", ".aif", ".ogg", ".opus", ".webm", ".flac", ".aac", ".mp4", ".mpga"]);
const MAX_TRANSCRIPT = 12_000;

export type TranscribeOpts = { model?: string; language?: string; task?: "transcribe" | "translate"; bin?: string };
export type TranscribeResult = { text: string; model: string; language: string | null };

const binOf = (o?: TranscribeOpts): string => o?.bin || process.env.WHISPER_BIN || "whisper";

function timeoutFor(model: string): number {
  if (model.startsWith("tiny") || model.startsWith("base") || model.startsWith("small")) return 240_000;
  if (model === "turbo" || model === "large-v3-turbo" || model === "medium") return 480_000;
  return 720_000;
}

function run(bin: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err) => {
      if (err) {
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
        if (e.code === "ENOENT") {
          reject(new Error("`whisper` belum terpasang — jalankan `brew install openai-whisper`"));
          return;
        }
        if (e.killed || e.signal) {
          reject(new Error(`whisper timeout/terhenti (model terlalu besar? coba model lebih kecil)`));
          return;
        }
        reject(new Error(`whisper gagal: ${e.message.split("\n")[0]}`));
        return;
      }
      resolve();
    });
  });
}

/** Is the whisper CLI available (and which models are cached locally)? */
export function whisperInfo(): { available: boolean; bin: string; models: string[] } {
  const bin = binOf();
  const dir = join(homedir(), ".cache", "whisper");
  let models: string[] = [];
  try {
    models = readdirSync(dir).filter((f) => f.endsWith(".pt"));
  } catch {
    /* no cache yet */
  }
  // `existsSync` only covers a literal path; a bare "whisper" is resolved via PATH
  // at run time — treat a non-path bin as available (the run surfaces ENOENT).
  const available = bin.includes("/") ? existsSync(bin) : true;
  return { available, bin, models };
}

/**
 * Transcribe a local audio file. `absPath` MUST already be a safe, resolved path
 * (sandbox or per-user uploads) — this function does not re-validate it.
 */
export async function transcribeAudio(absPath: string, opts: TranscribeOpts = {}): Promise<TranscribeResult> {
  if (!existsSync(absPath)) throw new Error(`audio tidak ditemukan: ${basename(absPath)}`);
  const ext = extname(absPath).toLowerCase();
  if (!AUDIO_EXT.has(ext)) throw new Error(`format audio tidak didukung: ${ext || "(tanpa ekstensi)"} (didukung: mp3/m4a/wav/ogg/opus/webm/flac/aac/mp4)`);
  const model = opts.model && MODELS.has(opts.model) ? opts.model : "small";
  const language = opts.language && /^[a-z]{2,3}$/i.test(opts.language) ? opts.language.toLowerCase() : null;
  const outDir = mkdtempSync(join(tmpdir(), "mia-stt-"));
  const args = [absPath, "--model", model, "--output_format", "txt", "--output_dir", outDir, "--fp16", "False", "--verbose", "False"];
  if (language) args.push("--language", language);
  if (opts.task === "translate") args.push("--task", "translate");
  try {
    await run(binOf(opts), args, timeoutFor(model));
    const txtPath = join(outDir, `${basename(absPath, ext)}.txt`);
    if (!existsSync(txtPath)) throw new Error("whisper tidak menghasilkan teks (audio kosong?)");
    const text = readFileSync(txtPath, "utf8").trim().slice(0, MAX_TRANSCRIPT);
    return { text, model, language };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
