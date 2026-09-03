import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { sanitizeUser, userDataRoot, appRoot, repoRoot } from "./users";
import { addReminder } from "./reminders";
import { nextOccurrence } from "./reminderIntent";
import { addTask, listTasks, rescheduleTask, setTaskStatus } from "./tasks";
import { listUploads, readUpload } from "./uploads";
import { addAutomation, describeSchedule } from "./automations";
import { searchMemory } from "./rag";

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** FR-014 risk categories: READ tools auto-run; WRITE/DELETE/... need confirmation. */
export type ToolRisk = "read" | "write" | "delete" | "transaction" | "external";

export interface ToolDefinition {
  type: "function";
  risk: ToolRisk;
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: string; description?: string }>;
      required: string[];
    };
  };
}

/** Tools that must wait for explicit user confirmation before running (FR-014). */
export function requiresConfirmation(tool: ToolDefinition | undefined): boolean {
  return !!tool && tool.risk !== "read";
}

export const TOOLS: ToolDefinition[] = [
  {
    type: "function",
    risk: "read",
    function: {
      name: "web_search",
      description:
        "Search the web for current or factual information. Use when the user asks about recent events, people, prices, or anything outside your knowledge.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "A short search query, e.g. 'Qwen 3 release date'",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    risk: "read",
    function: {
      name: "calculate",
      description: "Evaluate a numeric arithmetic expression, e.g. '2000000 * 0.15'.",
      parameters: {
        type: "object",
        properties: {
          expression: {
            type: "string",
            description: "Arithmetic expression using + - * / % and parentheses",
          },
        },
        required: ["expression"],
      },
    },
  },
  {
    type: "function",
    risk: "write",
    function: {
      name: "save_note",
      description:
        "Save a note to the user's notes list. This modifies persistent data, so the user must confirm before it runs.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The note text to save",
          },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    risk: "read",
    function: {
      name: "list_notes",
      description: "List all notes the user has saved, newest last.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    risk: "delete",
    function: {
      name: "delete_note",
      description:
        "Delete a saved note by number (as shown by list_notes). Destructive, so the user must confirm before it runs.",
      parameters: {
        type: "object",
        properties: {
          number: {
            type: "number",
            description: "The 1-based note number from list_notes to delete",
          },
        },
        required: ["number"],
      },
    },
  },
  {
    type: "function",
    risk: "read",
    function: {
      name: "file_read",
      description:
        "Read a file or list a directory inside the project workspace, given a path relative to the repo root (e.g. 'apps/web/src/lib/tools.ts' or 'apps/web'). Returns the file content (or directory listing). Sensitive paths (env files, .git, node_modules, .next, .data) are blocked.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path relative to the project root, e.g. 'prd' or 'apps/web'",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    risk: "write",
    function: {
      name: "remind_me",
      description:
        "Schedule a reminder. This creates a persistent scheduled notification, so the user confirms before it runs. `when` must be a concrete ISO-8601 date-time with timezone offset, e.g. '2026-09-02T15:00:00+07:00'. If the user gives a relative time, first convert it to a concrete ISO-8601 timestamp. The user will be notified when it is due.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "What to be reminded about, in the user's own words",
          },
          when: {
            type: "string",
            description: "Concrete ISO-8601 timestamp with offset, e.g. '2026-09-02T15:00:00+07:00'",
          },
        },
        required: ["text", "when"],
      },
    },
  },
  {
    type: "function",
    risk: "write",
    function: {
      name: "add_task",
      description:
        "Create a persistent task in the user's task list. The user must confirm before it runs. Optionally include a `dueAt` ISO-8601 deadline; if given, a reminder is also scheduled.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "The task to do, in the user's own words",
          },
          dueAt: {
            type: "string",
            description: "Optional concrete ISO-8601 deadline with offset, e.g. '2026-09-02T15:00:00+07:00'",
          },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    risk: "read",
    function: {
      name: "list_tasks",
      description: "List the user's tasks (active first, then done/cancelled) with their status and due date.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    risk: "write",
    function: {
      name: "complete_task",
      description: "Mark a task as done by its 1-based number (as shown by list_tasks). The user must confirm before it runs.",
      parameters: {
        type: "object",
        properties: {
          number: {
            type: "number",
            description: "The 1-based task number from list_tasks to complete",
          },
        },
        required: ["number"],
      },
    },
  },
  {
    type: "function",
    risk: "delete",
    function: {
      name: "cancel_task",
      description: "Cancel a task by its 1-based number (as shown by list_tasks), removing it from the active list. Destructive, so the user must confirm before it runs.",
      parameters: {
        type: "object",
        properties: {
          number: {
            type: "number",
            description: "The 1-based task number from list_tasks to cancel",
          },
        },
        required: ["number"],
      },
    },
  },
  {
    type: "function",
    risk: "write",
    function: {
      name: "reschedule_task",
      description:
        "Change a task's due deadline by its 1-based number (as shown by list_tasks). `dueAt` must be a concrete ISO-8601 timestamp with offset. The user must confirm before it runs.",
      parameters: {
        type: "object",
        properties: {
          number: {
            type: "number",
            description: "The 1-based task number from list_tasks to reschedule",
          },
          dueAt: {
            type: "string",
            description: "New concrete ISO-8601 deadline with offset, e.g. '2026-09-02T18:00:00+07:00'",
          },
        },
        required: ["number", "dueAt"],
      },
    },
  },
  {
    type: "function",
    risk: "read",
    function: {
      name: "list_uploads",
      description:
        "List files the user has uploaded via Telegram or Discord (text documents, images, etc.)",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    risk: "read",
    function: {
      name: "read_upload",
      description:
        "Read the text content of a file the user previously uploaded via Telegram or Discord. Provide the file name (from list_uploads) or its 1-based list number.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "File name or 1-based list number from list_uploads.",
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    risk: "write",
    function: {
      name: "create_automation",
      description:
        "Schedule a recurring automation: the assistant runs the `prompt` on the given schedule and pushes the result to the user's active channel without the user prompting it. schedule examples: \"setiap pagi jam 8\", \"setiap hari 08:30\", \"setiap 2 jam\".",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "What to do each run, e.g. \"lapor cuaca hari ini\".",
          },
          schedule: {
            type: "string",
            description: "Human schedule spec, e.g. \"setiap pagi jam 8\" or \"setiap 3 jam\".",
          },
        },
        required: ["prompt", "schedule"],
      },
    },
  },
  {
    type: "function",
    risk: "read",
    function: {
      name: "fetch_url",
      description:
        "Fetch and read the text content of a public web page URL (scrape article text or HTML summary). Use when the user asks you to read or summarize a specific web link.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The full http:// or https:// URL to fetch.",
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    risk: "read",
    function: {
      name: "search_memory",
      description:
        "Search through long-term memory, personal notes, uploaded files, tasks, and persona files for information relevant to a query. Use when asked about past knowledge or files.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search keywords or question to look up in long-term memory.",
          },
        },
        required: ["query"],
      },
    },
  },
];

export async function executeTool(call: ToolCall, rawUser?: unknown): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.arguments || "{}");
  } catch {
    return "Error: invalid tool arguments";
  }
  const userKey = sanitizeUser(rawUser);
  switch (call.name) {
    case "web_search":
      return webSearch(typeof args.query === "string" ? args.query : "");
    case "calculate":
      try {
        return String(evaluateArithmetic(typeof args.expression === "string" ? args.expression : ""));
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "invalid expression"}`;
      }
    case "file_read":
      try {
        return fileRead(typeof args.path === "string" ? args.path : "");
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "cannot read path"}`;
      }
    case "save_note":
      try {
        return saveNote(typeof args.content === "string" ? args.content : "", userKey);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "invalid note"}`;
      }
    case "list_notes":
      return listNotes(userKey);
    case "delete_note":
      try {
        return deleteNote(Number(args.number), userKey);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "invalid note number"}`;
      }
    case "remind_me":
      try {
        return scheduleReminder(
          typeof args.text === "string" ? args.text : "",
          typeof args.when === "string" ? args.when : "",
          rawUser
        );
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "invalid reminder"}`;
      }
    case "create_automation": {
      try {
        const prompt = typeof args.prompt === "string" ? args.prompt : "";
        const schedule = typeof args.schedule === "string" ? args.schedule : "";
        const auto = addAutomation(prompt, schedule, rawUser);
        return `Automation created: "${auto.prompt}" runs ${describeSchedule(auto.schedule)}.`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "invalid automation"}`;
      }
    }
    case "add_task":
      try {
        const text = typeof args.text === "string" ? args.text.trim() : "";
        addTask(
          text,
          rawUser,
          typeof args.dueAt === "string" && args.dueAt ? new Date(args.dueAt).getTime() : undefined
        );
        return `Task added: "${text}".`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "invalid task"}`;
      }
    case "list_tasks":
      return listTasks(rawUser);
    case "complete_task":
      try {
        return setTaskStatus(Number(args.number), "done", rawUser);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "invalid task number"}`;
      }
    case "cancel_task":
      try {
        return setTaskStatus(Number(args.number), "cancelled", rawUser);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "invalid task number"}`;
      }
    case "reschedule_task":
      try {
        return rescheduleTask(Number(args.number), new Date(String(args.dueAt)).getTime(), rawUser);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "invalid reschedule"}`;
      }
    case "list_uploads":
      return listUploads(rawUser);
    case "read_upload":
      try {
        return readUpload(rawUser, typeof args.name === "string" ? args.name : "");
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "invalid upload"}`;
      }
    case "fetch_url":
      try {
        return await fetchUrl(typeof args.url === "string" ? args.url : "");
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "invalid fetch"}`;
      }
    case "search_memory":
      return searchMemory(typeof args.query === "string" ? args.query : "", rawUser);
    default:
      return `Error: unknown tool "${call.name}"`;
  }
}

// Persistent notes store (server-side only; `node:fs`). Path is built from a
// sanitized user key (fallback to a shared file when none) so it is never
// derived raw from user input → no path traversal. A write is atomic (temp
// file + rename) so a crash can't corrupt the store.
const NOTES_FILE = join(appRoot(), ".data", "notes.json");
const USER_NOTES_DIR = userDataRoot();
const MAX_NOTES = 50;
const NOTE_BUDGET = 80000;

function notesPath(userKey: string | null): string {
  return userKey ? `${USER_NOTES_DIR}/${userKey}/notes.json` : NOTES_FILE;
}

function readNotes(userKey: string | null): { id: string; content: string }[] {
  try {
    const raw = readFileSync(notesPath(userKey), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeNotes(notes: { id: string; content: string }[], userKey: string | null): void {
  mkdirSync(dirname(notesPath(userKey)), { recursive: true });
  const tmp = `${notesPath(userKey)}.tmp`;
  writeFileSync(tmp, JSON.stringify(notes, null, 2));
  renameSync(tmp, notesPath(userKey));
}

function saveNote(content: string, userKey: string | null): string {
  const note = content.trim().slice(0, 500);
  if (!note) throw new Error("empty note");
  const notes = readNotes(userKey);
  notes.push({ id: String(Date.now()), content: note });
  while (notes.length > MAX_NOTES) notes.shift();
  if (JSON.stringify(notes).length > NOTE_BUDGET) notes.splice(0, Math.max(1, notes.length - 5));
  writeNotes(notes, userKey);
  return `Saved note #${notes.length}: "${note}".`;
}

function listNotes(userKey: string | null): string {
  const notes = readNotes(userKey);
  if (!notes.length) return "You have no saved notes yet.";
  return notes.map((n, i) => `${i + 1}. ${n.content}`).join("\n").slice(0, 3000);
}

function deleteNote(index: number, userKey: string | null): string {
  const notes = readNotes(userKey);
  if (index < 1 || index > notes.length) throw new Error(`no note #${index}`);
  const removed = notes.splice(index - 1, 1)[0];
  writeNotes(notes, userKey);
  return `Deleted note #${index} "${removed.content}".`;
}

function scheduleReminder(text: string, isoWhen: string, rawUser: unknown): string {
  const parsed = new Date(isoWhen);
  if (Number.isNaN(parsed.getTime())) throw new Error(`cannot parse time "${isoWhen}" — use ISO-8601 with offset`);
  // Safety net: a model without a live clock sometimes emits a past/stale date
  // for a bare clock time ("jam 3 sore"). Never schedule in the past — rebase
  // such a time to its next occurrence (today/tomorrow) via the shared parser.
  const atMs = parsed.getTime() < Date.now()
    ? nextOccurrence(parsed.getHours(), parsed.getMinutes())
    : parsed.getTime();
  const whenText = new Date(atMs).toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const r = addReminder(text, atMs, rawUser);
  return `Reminder set: "${r.text}" at ${whenText}. The user will be notified then.`;
}

// File access tool (Phase 4). Read-only, sandboxed to the project root
// (process.cwd()), resolved after `..` normalization, and a deny-list keeps
// secrets/build/server directories out of the LLM context:
//   - .env* / *.local        → API keys, never exposed
//   - .git, node_modules, .next, .data  → not user-authored material
const FILE_ROOT = () => repoRoot();
const FILE_MAX_BYTES = 60000;
const DENY_SEGMENTS = [".git", "node_modules", ".next", ".data", "dist", "coverage"];
const DENY_PATTERNS = [/^\.env(\.|$)/i, /.local$/, /\.(key|pem|crt)$/i, /\.(pyc|class|o)$/];

function fileRead(rawPath: string): string {
  const p = (rawPath || "").trim();
  if (!p) throw new Error("empty path");
  if (isAbsolute(p) || p.includes("~")) throw new Error("path must be relative to the project root");

  const root = FILE_ROOT();
  const abs = resolve(root, p);
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error("path escapes the project root");

  const rel = abs.slice(root.length).split(sep).filter(Boolean);
  for (const seg of rel) {
    if (DENY_SEGMENTS.includes(seg)) throw new Error(`"${seg}" is not readable`);
    if (DENY_PATTERNS.some((re) => re.test(seg))) throw new Error(`"${seg}" is blocked for security`);
  }

  const stat = statSync(abs);
  if (stat.isDirectory()) {
    const entries = readdirSync(abs).slice(0, 200);
    const labeled = entries.map((e) => {
      let type = "file";
      try {
        type = statSync(resolve(abs, e)).isDirectory() ? "dir" : type;
      } catch {
        /* ignore */
      }
      return `${type}\t${e}`;
    });
    return labeled.length ? `Directory listing (${rel.join("/") || "."}):\n${labeled.join("\n")}` : "(empty directory)";
  }

  if (stat.size > FILE_MAX_BYTES) throw new Error("file too large to read");
  return readFileSync(abs, "utf8").slice(0, FILE_MAX_BYTES);
}

const DDG_INSTANT = "https://api.duckduckgo.com/";
const DDG_HTML = "https://html.duckduckgo.com/html/";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

async function webSearch(query: string): Promise<string> {
  const q = query.trim().slice(0, 200);
  if (!q) return "Error: empty search query";

  const instant = await fetchInstantAnswer(q);
  if (instant) return instant;

  try {
    const res = await fetch(DDG_HTML, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
        Accept: "text/html",
      },
      body: new URLSearchParams({ q }),
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) return "Error: web search failed";
    return parseResults(await res.text());
  } catch {
    return "Error: web search failed";
  }
}

async function fetchInstantAnswer(q: string): Promise<string | null> {
  try {
    const res = await fetch(`${DDG_INSTANT}?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { Answer?: string; AbstractText?: string };
    const chunk: string[] = [];
    if (data.Answer) chunk.push(data.Answer);
    if (data.AbstractText) chunk.push(data.AbstractText);
    return chunk.length ? chunk.join(" — ").slice(0, 800) : null;
  } catch {
    return null;
  }
}

function parseResults(html: string): string {
  const titles: string[] = [];
  const urls: string[] = [];
  const anchorRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null && titles.length < 5) {
    titles.push(stripTags(m[2]));
    urls.push(cleanUrl(m[1]));
  }
  const snippets: string[] = [];
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = snippetRe.exec(html)) !== null && snippets.length < 5) snippets.push(stripTags(m[1]));

  if (!titles.length) return "No results found.";

  const rows = titles.map((title, i) => {
    const line = `${i + 1}. ${title}\n   ${urls[i] ?? ""}`;
    const snippet = snippets[i];
    return snippet ? `${line}\n   ${snippet.slice(0, 200)}` : line;
  });
  return rows.join("\n").slice(0, 1500);
}

function stripTags(htmlText: string): string {
  return htmlText
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function cleanUrl(href: string): string {
  const match = href.match(/uddg=([^&]+)/);
  const raw = match ? decodeURIComponent(match[1]) : href;
  return raw.startsWith("//") ? `https:${raw}` : raw;
}

// ---- fetch_url tool (Web interaction: read a public page by URL) ----

const FETCH_MAX_BYTES = 120_000; // ~ cap we feed to the LLM
const FETCH_TIMEOUT_MS = 12_000;

/**
 * Canonicalize common "human page" URLs into plain-text/raw counterparts so the
 * scraper fetches clean content instead of heavy HTML wrappers.
 *   - GitHub blob → raw.githubusercontent (lightweight raw file)
 *   - GitHub tree → not a file (throw)
 *   - raw.githubusercontent already fine
 */
function canonicalizeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  const host = u.hostname.toLowerCase();

  // github.com/<owner>/<repo>/blob/<ref>/<path>  -> raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>
  if ((host === "github.com" || host.endsWith(".github.com")) && u.pathname.includes("/blob/")) {
    const parts = u.pathname.replace(/^\/+|\/+$/g, "").split("/");
    // parts = [owner, repo, "blob", ref, ...path]
    if (parts.length >= 5 && parts[2] === "blob") {
      const [owner, repo, , ref, ...rest] = parts;
      const rawPath = [owner, repo, ref, ...rest].join("/");
      return `https://raw.githubusercontent.com/${rawPath}`;
    }
  }
  // github.com/.../tree/<ref> is a directory view — not fetchable as a file.
  if (host === "github.com" && u.pathname.includes("/tree/")) {
    throw new Error("GitHub tree links point to a directory; provide a blob (file) link or use file_read for local files");
  }
  return raw;
}

/** SSRF guard: refuse internal/loopback/private addresses and non-http schemes. */
function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http/https URLs are allowed");
  const host = url.hostname.toLowerCase();
  // Block obvious internal targets (server environment, LAN, metadata).
  if (host === "localhost" || host === "0.0.0.0" || host === "[::1]" || host.endsWith(".localhost")) {
    throw new Error("internal addresses are not fetchable");
  }
  if (host.startsWith("127.") || host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("0.")) {
    throw new Error("private network addresses are not fetchable");
  }
  if (host.startsWith("172.")) {
    const seg = Number(host.split(".")[1]);
    if (seg >= 16 && seg <= 31) throw new Error("private network addresses are not fetchable");
  }
  if (host.startsWith("169.254.") || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) {
    throw new Error("private network addresses are not fetchable");
  }
  if (!host.includes(".")) throw new Error("host does not look public"); // crude TLD sanity
  return url;
}

/** Fetch a page and return its dominant article/summary text (bounded). */
async function fetchUrl(urlStr: string): Promise<string> {
  const canonical = canonicalizeUrl(urlStr);
  const url = assertPublicUrl(canonical);
  const res = await fetch(url.toString(), {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
  const ct = res.headers.get("content-type") || "";
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > FETCH_MAX_BYTES) throw new Error("page too large to read");
  const html = buf.toString("utf8", 0, FETCH_MAX_BYTES);

  if (ct.includes("text/html") || html.toLowerCase().includes("<!doctype html") || html.toLowerCase().includes("<html")) {
    return extractArticleText(html).slice(0, 2000);
  }
  // Non-HTML: return as-is (truncated).
  return html.slice(0, 2000);
}

/**
 * Best-effort article-text extraction without a DOM (no extra deps).
 * Prefers <article>/<main>/<og:description>; falls back to visible text.
 */
function extractArticleText(html: string): string {
  const og = html.match(/<meta\s+(?:name|property)=["']?og:description["'][^>]*content=["']([^"']*)["']/i);
  if (og?.[1]) return `Judul/Deskripsi: ${og[1].replace(/\s+/g, " ")}`;

  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const t = title ? title[1].trim() : "";

  // Try <article> then <main> then <body>.
  let block: string | null = null;
  const art = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (art) block = art[1];
  if (!block) {
    const main = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    if (main) block = main[1];
  }
  if (!block) {
    const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    if (body) block = body[1];
  }
  if (!block) return `${t}\n${stripTags(html)}`.slice(0, 2000);

  // Drop navigation/ads boilerplate heuristically: keep text nodes, strip nav/script/style.
  const cleaned = stripTags(block).replace(/^[\s\n]+|[ \t]{2,}/g, " ").replace(/\n{2,}/g, "\n").trim();
  return `${t ? `${t}\n` : ""}${cleaned || stripTags(html)}`.slice(0, 2000);
}

function evaluateArithmetic(expr: string): number {
  const s = expr.trim();
  if (!s) throw new Error("empty expression");
  if (s.length > 200) throw new Error("expression too long");
  if (!/^[0-9+\-*/().%\s]+$/.test(s)) throw new Error("unsupported characters — use + - * / % and parentheses");

  let pos = 0;
  const ws = (): void => {
    while (pos < s.length && /\s/.test(s[pos])) pos++;
  };
  const peek = (): string => (pos < s.length ? s[pos] : "");
  const number = (): number => {
    ws();
    const m = s.slice(pos).match(/^\d+(\.\d+)?/);
    if (!m) throw new Error(`unexpected "${s.slice(pos, pos + 12)}"`);
    pos += m[0].length;
    return Number(m[0]);
  };
  const primary = (): number => {
    ws();
    if (peek() === "(") {
      pos++;
      const v = exprSum();
      ws();
      if (peek() !== ")") throw new Error('missing ")"');
      pos++;
      return v;
    }
    return number();
  };
  const factor = (): number => {
    ws();
    if (peek() === "-") {
      pos++;
      return -factor();
    }
    if (peek() === "+") {
      pos++;
      return factor();
    }
    let v = primary();
    for (;;) {
      ws();
      if (peek() === "*") {
        pos++;
        v *= factor();
      } else if (peek() === "/") {
        pos++;
        const d = factor();
        if (d === 0) throw new Error("division by zero");
        v /= d;
      } else if (peek() === "%") {
        pos++;
        const d = factor();
        if (d === 0) throw new Error("division by zero");
        v %= d;
      } else {
        break;
      }
    }
    return v;
  };
  const exprSum = (): number => {
    let v = factor();
    for (;;) {
      ws();
      if (peek() === "+") {
        pos++;
        v += factor();
      } else if (peek() === "-") {
        pos++;
        v -= factor();
      } else {
        break;
      }
    }
    return v;
  };

  ws();
  const result = exprSum();
  ws();
  if (pos !== s.length) throw new Error(`unexpected "${s.slice(pos, pos + 12)}"`);
  return result;
}