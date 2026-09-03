// File upload handling (Fase 3 — file handling).
//
// When a user sends a document/photo via Telegram or Discord, the adapter
// downloads the file to .data/users/<user>/uploads/<safe-filename> and
// returns metadata. Text-like files (max 100 KB) are fully read so the
// content can be prepended to the user message as LLM context. Binary/image
// files are saved but not read into the prompt.
//
// Path: .data/users/<user>/uploads/<filename>
// Same atomic-write + sanitized user key pattern as notes/reminders/tasks.

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join, extname } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";

const MAX_TEXT_BYTES = 100_000;
const MAX_UPLOADS = 50;
const TEXT_EXTENSIONS = new Set([
  ".txt", ".csv", ".json", ".md", ".log", ".xml", ".yaml", ".yml", ".toml",
  ".js", ".ts", ".jsx", ".tsx", ".py", ".rb", ".go", ".rs", ".java", ".c",
  ".cpp", ".h", ".cs", ".sh", ".bash", ".zsh", ".sql", ".html", ".css",
  ".scss", ".less", ".env", ".ini", ".cfg", ".conf", ".config",
  ".srt", ".vtt", ".lrc", ".csv", ".tsv", ".svg", ".graphql", ".gql",
]);
const TEXT_MIME_PREFIXES = ["text/", "application/json", "application/xml", "application/javascript"];
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"]);
const IMAGE_MIME_PREFIXES = ["image/"];

function uploadsDir(userKey: string): string {
  return join(userDataRoot(), userKey, "uploads");
}

/** Escape a filename: only keep safe chars, cap length. */
function safeFilename(name: string): string {
  const cleaned = (name || "file").replace(/[^a-zA-Z0-9._\-() ]/g, "_").slice(0, 120);
  return cleaned || "file";
}

export interface UploadMeta {
  name: string;
  size: number;
  mime: string;
  isText: boolean;
  isImage: boolean;
  savedAt: number;
}

function metaPath(userKey: string): string {
  return join(uploadsDir(userKey), "_index.json");
}

function readIndex(userKey: string): UploadMeta[] {
  try {
    return JSON.parse(readFileSync(metaPath(userKey), "utf8")) as UploadMeta[];
  } catch {
    return [];
  }
}

function writeIndex(metas: UploadMeta[], userKey: string): void {
  const dir = uploadsDir(userKey);
  mkdirSync(dir, { recursive: true });
  const tmp = `${metaPath(userKey)}.tmp`;
  writeFileSync(tmp, JSON.stringify(metas, null, 2));
  renameSync(tmp, metaPath(userKey));
}

export function isTextFile(filename: string, mime: string): boolean {
  const ext = extname(filename).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (TEXT_MIME_PREFIXES.some((p) => (mime || "").startsWith(p))) return true;
  return false;
}

export function isImageFile(filename: string, mime: string): boolean {
  const ext = extname(filename).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return true;
  if (IMAGE_MIME_PREFIXES.some((p) => (mime || "").startsWith(p))) return true;
  return false;
}

/**
 * Save a buffer (already downloaded by the adapter) to the user's uploads dir.
 * Returns the UploadMeta record. If the file is text-like and under the size
 * limit, the content is also returned as a string (the caller can prepend it
 * to the LLM prompt).
 */
export function saveUpload(
  rawUser: unknown,
  filename: string,
  mime: string,
  buffer: Buffer
): UploadMeta & { textContent?: string } {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) throw new Error("invalid user");

  const dir = uploadsDir(userKey);
  mkdirSync(dir, { recursive: true });

  const name = safeFilename(filename);
  const absPath = join(dir, name);

  // Deduplicate: append counter if file already exists
  let finalPath = absPath;
  let finalName = name;
  let counter = 1;
  while (existsSync(finalPath)) {
    const ext = extname(name);
    const base = name.slice(0, name.length - ext.length || undefined);
    finalName = `${base}_${counter}${ext}`;
    finalPath = join(dir, finalName);
    counter++;
  }

  writeFileSync(finalPath, buffer);

  const text = isTextFile(name, mime) && buffer.byteLength <= MAX_TEXT_BYTES
    ? readFileSync(finalPath, "utf8")
    : undefined;

  const meta: UploadMeta & { textContent?: string } = {
    name: finalName,
    size: buffer.byteLength,
    mime,
    isText: isTextFile(name, mime),
    isImage: isImageFile(name, mime),
    savedAt: Date.now(),
    ...(text !== undefined ? { textContent: text } : {}),
  };

  const index = readIndex(userKey);
  index.push(meta);
  while (index.length > MAX_UPLOADS) {
    const oldest = index.shift();
    if (oldest) {
      try { unlinkSync(join(dir, oldest.name)); } catch { /* ignore */ }
    }
  }
  writeIndex(index, userKey);
  return meta;
}

/** List saved uploads for a user, newest last. */
export function listUploads(rawUser?: unknown): string {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return "No uploads found.";
  const metas = readIndex(userKey);
  if (!metas.length) return "No files uploaded yet.";
  return metas.map((m, i) => {
    const kb = (m.size / 1024).toFixed(1);
    const kind = m.isImage ? "image" : m.isText ? "text" : "binary";
    return `${i + 1}. ${m.name} (${kb} KB, ${kind})`;
  }).join("\n").slice(0, 2000);
}

/**
 * Read the text content of a previously-uploaded file (matched by name or
 * 1-based list number). Only text-like files under MAX_TEXT_BYTES return
 * content; images/binaries return a short note instead.
 */
export function readUpload(rawUser?: unknown, nameOrNumber?: string): string {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) throw new Error("invalid user");
  const metas = readIndex(userKey);
  if (!metas.length) throw new Error("no files uploaded yet");

  let meta: UploadMeta | undefined;
  const q = (nameOrNumber || "").trim();
  if (/^\d+$/.test(q)) {
    const idx = Number(q) - 1;
    meta = metas[idx];
  } else {
    meta = metas.find((m) => m.name === q);
  }
  if (!meta) throw new Error(`no uploaded file "${q}"`);

  if (!meta.isText) return `"${meta.name}" is not a text file (${meta.isImage ? "image" : "binary"}); cannot read its content.`;
  const abs = join(uploadsDir(userKey), meta.name);
  if (!existsSync(abs)) throw new Error(`file "${meta.name}" is missing from disk`);
  const size = statSync(abs).size;
  if (size > MAX_TEXT_BYTES) return `"${meta.name}" is too large to read (${(size / 1024).toFixed(1)} KB).`;
  return readFileSync(abs, "utf8").slice(0, MAX_TEXT_BYTES);
}
