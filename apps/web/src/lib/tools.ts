import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { execFile, execFile as execFileCb } from "node:child_process";
import { dirname, join, resolve, sep } from "node:path";
import { sanitizeUser, userDataRoot, appRoot, repoRoot, resolveInSandbox } from "./users";
import { addReminder, readReminders } from "./reminders";
import { nextOccurrence } from "./reminderIntent";
import { addTask, listTasks, rescheduleTask, setTaskStatus } from "./tasks";
import { listUploads, readUpload } from "./uploads";
import { addAutomation, describeSchedule } from "./automations";
import { searchMemory } from "./rag";
import { ensureFreshIndex, rebuildIndex, searchCodebaseIn, indexSummary } from "./codebaseIndex";
import { readDailyMemory } from "./dailyMemory";
import { browserOpen, browserSnapshot, browserClick, browserType, browserNavigate, browserClose } from "./browser";
import { listDevicesText, deviceExec, deviceScreenshot, pairDevice } from "./devices";
import { listCalText, addCalEvent, checkCalAvailability } from "./calendar";
import { addMood, listMoods, moodTrend } from "./mood";
import { sendToChannel, listChannels } from "../channels/pushTarget";
import { renderMala } from "./mala";
import { startSongGame, guessSong, quitSongGame } from "./game";
import { holidayInfo } from "./holiday";
import { buildEveningRecap } from "./recap";
import { buildWeeklyInsight } from "./weeklyInsight";
import { habitStats, logHabit } from "./habits";
import { gmailAuthUrl, gmailConfigured, gmailConnected, gmailList, gmailRead, gmailSearch } from "./email";

/** Human-readable reminder state for the model: upcoming (unfired) first, then
 *  today's delivered — so it can talk about reminders HONESTLY instead of
 *  inventing status from stale persona facts. */
function remindersListText(rawUser: unknown): string {
  const now = Date.now();
  const rs = readReminders(rawUser);
  if (!rs.length) return "Belum ada reminder terpasang.";
  const fmt = (ms: number): string =>
    new Date(ms).toLocaleString("id-ID", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const upcoming = rs.filter((r) => !r.fired && r.at >= now).sort((a, b) => a.at - b.at).slice(0, 10);
  const deliveredToday = rs.filter((r) => r.fired && now - r.at < 24 * 60 * 60 * 1000).sort((a, b) => b.at - a.at).slice(0, 5);
  const lines: string[] = [];
  for (const r of upcoming) {
    lines.push(`• ${fmt(r.at)} — "${r.text}"${r.repeat === "daily" ? " (harian)" : ""} — terjadwal`);
  }
  for (const r of deliveredToday) {
    lines.push(`• ${fmt(r.at)} — "${r.text}" — sudah terkirim ✓`);
  }
  return lines.length ? lines.join("\n") : "Belum ada reminder terjadwal (yang lama sudah terkirim).";
}
import { auditLog } from "./auditLog";
import { toolsDeny } from "./config";
import { recordToolCall } from "./turnStats";
import {
  spotifyAuthUrl,
  spotifyConfigured,
  spotifyConnected,
  spotifyNowPlaying,
  spotifySearch,
  spotifyPlay,
  spotifyPause,
  spotifyNext,
  spotifyPrevious,
  spotifySetVolume,
  spotifyDevices,
} from "./spotify";

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
      properties: Record<string, { type: string; description?: string; enum?: string[] }>;
      required: string[];
    };
  };
}

/**
 * Execution context handed to a tool plugin. `userKey` is the sanitized per-user
 * isolation key (already run through `sanitizeUser`); `rawUser` is the original
 * value the caller supplied, for stores that sanitize themselves.
 */
export interface ToolContext {
  userKey: string | null;
  rawUser?: unknown;
}

/** A tool plugin: a schema definition + its implementation, bundled together. */
export interface ToolPlugin {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string> | string;
}

/** Tools that must wait for explicit user confirmation before running (FR-014). */
export function requiresConfirmation(tool: ToolDefinition | undefined): boolean {
  return !!tool && tool.risk !== "read";
}

/**
 * Tool plugin registry. Each entry bundles its schema (`definition`) and its
 * implementation (`execute`), so adding a new tool is adding ONE plugin object
 * here — no separate switch to keep in sync. `TOOLS` (the definitions sent to
 * the model) and `executeTool` (dispatch) are both derived from this registry,
 * so they can never drift apart.
 */
const toolRegistry: ToolPlugin[] = [
  {
    definition: {
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
    execute: (args) => webSearch(typeof args.query === "string" ? args.query : ""),
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "calculate",
        description:
          "Evaluate a simple arithmetic expression and return the numeric result.",
        parameters: {
          type: "object",
          properties: {
            expression: {
              type: "string",
              description: 'Arithmetic expression, e.g. "12.5 * 4 + (3 - 1)"',
            },
          },
          required: ["expression"],
        },
      },
    },
    execute: (args) => {
      try {
        return String(evaluateArithmetic(typeof args.expression === "string" ? args.expression : ""));
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "invalid expression"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "file_read",
        description:
          "Read a project file or list a directory. Returns file contents (truncated) or a directory listing. Paths are relative to the project root and sandboxed.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative project path, e.g. 'README.md' or 'src'",
            },
          },
          required: ["path"],
        },
      },
    },
    execute: (args) => {
      try {
        return fileRead(typeof args.path === "string" ? args.path : "");
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "cannot read path"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "write_file",
        description:
          "Create or overwrite a file in the project (or allowed workspace) with the given text content. Requires confirmation. Paths are inside the repo root or allowed workspace; parent directories are created as needed.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "File path to write, e.g. 'notes/todo.md' or 'flowtest-studio/src/new.ts' or absolute allowed path",
            },
            content: {
              type: "string",
              description: "Text content to write to the file",
            },
          },
          required: ["path", "content"],
        },
      },
    },
    execute: (args) => {
      try {
        return fileWrite(typeof args.path === "string" ? args.path : "", typeof args.content === "string" ? args.content : "");
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "cannot write file"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "edit_file",
        description:
          "Edit an existing file by replacing the first occurrence of old_string with new_string. Requires confirmation. Use for small patches; for large rewrites use write_file.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "File path to edit",
            },
            old_string: {
              type: "string",
              description: "Exact text to find and replace (must appear once)",
            },
            new_string: {
              type: "string",
              description: "Replacement text",
            },
          },
          required: ["path", "old_string", "new_string"],
        },
      },
    },
    execute: (args) => {
      try {
        return fileEdit(
          typeof args.path === "string" ? args.path : "",
          typeof args.old_string === "string" ? args.old_string : "",
          typeof args.new_string === "string" ? args.new_string : ""
        );
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "cannot edit file"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "exec",
        description:
          "Run a read-only shell command in a project and return its output. Only safe inspection commands are allowed (git status/log/diff/branch, ls, pwd, cat, node --version, npm ls); anything else is rejected. Use cwd (a path relative to the repo root, e.g. '..' is not allowed; to inspect another allowed workspace pass its folder name) to choose the directory; default is the repo root.",
        parameters: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "A read-only command from the allowlist, e.g. 'git status' or 'ls src'",
            },
            cwd: {
              type: "string",
              description: "Optional directory (relative path within an allowed workspace) to run in; defaults to the repo root",
            },
          },
          required: ["command"],
        },
      },
    },
    execute: async (args) => {
      try {
        return await execSafe(
          typeof args.command === "string" ? args.command : "",
          typeof args.cwd === "string" ? args.cwd : ""
        );
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "cannot run command"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "exec_write",
        description:
          "Run a write shell command (git add/commit/push) that modifies the project. Requires user confirmation. Use only for explicit user requests to commit or push. One command per call — do NOT chain with && or ;, call each git command as a separate tool invocation. cwd works like exec.",
        parameters: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "Write command, e.g. 'git add .' , 'git commit -m \"msg\"', 'git push' — one command only, no &&",
            },
            cwd: {
              type: "string",
              description: "Optional directory (as in exec) to run in; defaults to repo root",
            },
          },
          required: ["command"],
        },
      },
    },
    execute: async (args) => {
      try {
        return await execWriteSafe(
          typeof args.command === "string" ? args.command : "",
          typeof args.cwd === "string" ? args.cwd : ""
        );
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "cannot run command"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "save_note",
        description:
          "Save a short personal note to memory. It persists across sessions and can be looked up later with list_notes or search_memory.",
        parameters: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "The note content to remember",
            },
          },
          required: ["content"],
        },
      },
    },
    execute: (args, ctx) => {
      try {
        return saveNote(typeof args.content === "string" ? args.content : "", ctx.userKey);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "invalid note"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "list_notes",
        description:
          "List all saved personal notes, one per line with their index number. Use before delete_note to see the numbering.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    },
    execute: (_args, ctx) => listNotes(ctx.userKey),
  },
  {
    definition: {
      type: "function",
      risk: "delete",
      function: {
        name: "delete_note",
        description: "Delete a saved note by its index number from list_notes.",
        parameters: {
          type: "object",
          properties: {
            number: {
              type: "string",
              description: "The note index to delete (1-based, as shown by list_notes)",
            },
          },
          required: ["number"],
        },
      },
    },
    execute: (args, ctx) => {
      try {
        return deleteNote(Number(args.number), ctx.userKey);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "invalid note number"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "remind_me",
        description:
          "Schedule a reminder notification. Set repeat to \"daily\" for a recurring reminder (e.g. wake-up every day at 7).",
        parameters: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "What to remind about, e.g. 'call mom'",
            },
            when: {
              type: "string",
              description: "When to remind, as ISO-8601 with offset, e.g. '2026-09-04T09:00:00+07:00'",
            },
            repeat: {
              type: "string",
              enum: ["daily"],
              description: "Optional: 'daily' to repeat every day at the same time",
            },
          },
          required: ["text", "when"],
        },
      },
    },
    execute: (args, ctx) => {
      try {
        const repeatArg = args.repeat === "daily" ? "daily" : undefined;
        return scheduleReminder(
          typeof args.text === "string" ? args.text : "",
          typeof args.when === "string" ? args.when : "",
          ctx.rawUser,
          repeatArg
        );
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "invalid reminder"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "create_automation",
        description:
          "Create a recurring automation that runs a prompt on a schedule and pushes the result to the user.",
        parameters: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "What the automation should do each time it runs",
            },
            schedule: {
              type: "string",
              description: "Human schedule, e.g. 'setiap pagi jam 8' or 'setiap 2 jam'",
            },
          },
          required: ["prompt", "schedule"],
        },
      },
    },
    execute: (args, ctx) => {
      try {
        const prompt = typeof args.prompt === "string" ? args.prompt : "";
        const schedule = typeof args.schedule === "string" ? args.schedule : "";
        const auto = addAutomation(prompt, schedule, ctx.rawUser);
        return `Automation created: "${auto.prompt}" runs ${describeSchedule(auto.schedule)}.`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "invalid automation"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "add_task",
        description:
          "Add a task to the user's task list, optionally with a due date.",
        parameters: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "What needs to be done",
            },
            dueAt: {
              type: "string",
              description: "Optional ISO-8601 due date, e.g. '2026-09-10T17:00:00+07:00'",
            },
          },
          required: ["text"],
        },
      },
    },
    execute: (args, ctx) => {
      try {
        const text = typeof args.text === "string" ? args.text.trim() : "";
        addTask(
          text,
          ctx.rawUser,
          typeof args.dueAt === "string" && args.dueAt ? new Date(args.dueAt).getTime() : undefined
        );
        return `Task added: "${text}".`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "invalid task"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "list_tasks",
        description:
          "List all tasks in the task list with their index, status, and due date.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    },
    execute: (_args, ctx) => listTasks(ctx.rawUser),
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "complete_task",
        description: "Mark a task as done by its index number from list_tasks.",
        parameters: {
          type: "object",
          properties: {
            number: {
              type: "string",
              description: "The task index to complete (1-based)",
            },
          },
          required: ["number"],
        },
      },
    },
    execute: (args, ctx) => {
      try {
        return setTaskStatus(Number(args.number), "done", ctx.rawUser);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "invalid task number"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "cancel_task",
        description: "Cancel a task by its index number from list_tasks.",
        parameters: {
          type: "object",
          properties: {
            number: {
              type: "string",
              description: "The task index to cancel (1-based)",
            },
          },
          required: ["number"],
        },
      },
    },
    execute: (args, ctx) => {
      try {
        return setTaskStatus(Number(args.number), "cancelled", ctx.rawUser);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "invalid task number"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "reschedule_task",
        description: "Change the due date of a task by its index number.",
        parameters: {
          type: "object",
          properties: {
            number: {
              type: "string",
              description: "The task index to reschedule (1-based)",
            },
            dueAt: {
              type: "string",
              description: "New ISO-8601 due date",
            },
          },
          required: ["number", "dueAt"],
        },
      },
    },
    execute: (args, ctx) => {
      try {
        return rescheduleTask(Number(args.number), new Date(String(args.dueAt)).getTime(), ctx.rawUser);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "invalid reschedule"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "list_uploads",
        description:
          "List files the user has uploaded to the assistant via chat.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    },
    execute: (_args, ctx) => listUploads(ctx.rawUser),
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "read_upload",
        description: "Read the text content of a previously uploaded file.",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The upload file name, as shown by list_uploads",
            },
          },
          required: ["name"],
        },
      },
    },
    execute: (args, ctx) => {
      try {
        return readUpload(ctx.rawUser, typeof args.name === "string" ? args.name : "");
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "invalid upload"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "external",
      function: {
        name: "fetch_url",
        description:
          "Fetch a public URL and return its main text content. Use for reading a webpage, article, or raw GitHub file.",
        parameters: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "A public http(s) URL to fetch",
            },
          },
          required: ["url"],
        },
      },
    },
    execute: async (args) => {
      try {
        return await fetchUrl(typeof args.url === "string" ? args.url : "");
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "invalid fetch"}`;
      }
    },
  },
  {
    definition: {
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
    execute: (args, ctx) => {
      try {
        return searchMemory(typeof args.query === "string" ? args.query : "", ctx.rawUser);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "invalid search"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "context_active",
        description:
          "Report what the user is currently doing on their Mac: the active app and window title (privacy-safe — never screen content or keystrokes). Use when the user asks 'lagi ngapain', 'sedang di aplikasi apa', or to tailor help/answers to the app they are in.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: async () => {
      try {
        const mod = await import("./context");
        return (await mod.currentContextTextFresh()) || "Konteks tidak tersedia — sampler/pengambilan app aktif belum berjalan atau izin Accessibility belum diberikan.";
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "context unavailable"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "briefing",
        description:
          "Sajikan briefing pagi: agenda task yang jatuh tempo hari ini + task terlambat, reminder yang belum kejadian hari ini, potongan hal kemarin (mood + memory), dan tanggal merah hari ini. Panggil saat user minta 'briefing', 'ringkasan pagi', 'apa agenda hari ini', 'rencana hari ini', atau sapaan pagi yang ingin tahu jadwalnya. Berjalan tanpa konfirmasi.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: async (_, ctx) => {
      try {
        const mod = await import("./briefing");
        const msg = mod.buildMorningBriefing(ctx?.userKey);
        return msg || "Hari ini kosong — tanpa agenda, tanpa reminder, kemarin juga tanpa jejak. Rest day. 🌸";
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "briefing unavailable"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "library_list",
        description:
          "Buka daftar bacaan si user: link yang pernah disimpan (dengan ringkasannya). Panggil saat user minta 'daftar bacaan', 'link yang kusimpan', 'bacaan-ku', 'read later', atau menyebut isi yang dia pernah share. Berjalan tanpa konfirmasi.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: async (_, ctx) => {
      try {
        const mod = await import("./library");
        const reads = mod.listReads(ctx?.userKey);
        if (!reads.length) return "Daftar bacaan masih kosong — belum ada link yang disimpan.";
        const lines = reads.slice(0, 10).map((r, i) => {
          const when = new Date(r.savedAt).toLocaleDateString("id-ID", { day: "numeric", month: "short" });
          return `${i + 1}. ${r.title || r.url} (${when})\n   ${r.summary.slice(0, 160)}`;
        });
        const more = reads.length > 10 ? `\n+${reads.length - 10} lagi` : "";
        return `Daftar bacaan (${reads.length}):\n${lines.join("\n")}${more}`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "library unavailable"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "delete",
      function: {
        name: "library_remove",
        description:
          "Hapus satu link dari daftar bacaan user. `ref` = nomor urut (sesuai library_list) atau id entri. Butuh konfirmasi user sebelum dijalankan.",
        parameters: {
          type: "object",
          properties: { ref: { type: "string", description: "Nomor urut atau id entri di daftar bacaan" } },
          required: ["ref"],
        },
      },
    },
    execute: async (args, ctx) => {
      try {
        const mod = await import("./library");
        const ref = typeof args.ref === "string" ? args.ref : String(args.ref);
        return mod.removeLibraryEntry(ctx?.userKey, ref);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "library remove failed"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "memory_hygiene",
        description:
          "Bersihkan ingatan persona: hapus duplikat fakta user & ratakan format (USER.md jadi satu bagian ## Facts; baris yang sama persis di SOUL.md dipangkas). Kalau ada konflik (satu fakta punya nilai beda-beda), nilai TERBARU dipertahankan dan konfliknya dilaporkan — tanyakan ke user mana yang benar. Panggil saat user minta 'bersihkan ingatanmu', 'beresin memory', 'kenapa ingatanmu duplikat', 'rapikan fakta tentang aku'. Butuh konfirmasi user karena menulis ulang file.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: async (_args, ctx) => {
      try {
        const mod = await import("./persona");
        const results = mod.hygienizePersona(ctx?.userKey);
        const totalRemoved = results.reduce((n, r) => n + r.removed, 0);
        if (!results.some((r) => r.changed) && totalRemoved === 0) {
          return "Ingatan sudah bersih — tidak ada duplikat atau format berantakan. 🌸";
        }
        const lines: string[] = [];
        for (const r of results) {
          if (r.removed > 0) lines.push(`- ${r.file}: ${r.removed} baris duplikat dihapus`);
        }
        for (const r of results) {
          for (const c of r.conflicts) {
            lines.push(
              `- KONFLIK ${r.file} '${c.key}': kutaruh nilai terbaru "${c.kept}" (nilai lama "${c.superseded}" dihapus). Kalau yang benar yang lama, bilang aja.`,
            );
          }
        }
        return `Memory hygiene selesai.\n${lines.join("\n")}`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "hygiene failed"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "memory_get",
        description:
          "Retrieve the daily memory log for a specific date (YYYY-MM-DD, or 'today'/'yesterday'). Each day's file contains timestamped conversation snippets. Returns the file content or a not-found message.",
        parameters: {
          type: "object",
          properties: {
            date: {
              type: "string",
              description: "Date to retrieve, e.g. '2026-09-04' or 'today' or 'yesterday'",
            },
          },
          required: ["date"],
        },
      },
    },
    execute: (args, ctx) => {
      try {
        return readDailyMemory(ctx.rawUser, typeof args.date === "string" ? args.date : "");
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "cannot read memory"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "codebase_search",
        description:
          "Search the user's PROJECT SOURCE CODE (repo + allowed workspaces, pre-indexed). Use for code questions: where a feature is implemented, how a function works, file locations. Returns file:line references with generous code snippets — ANSWER FROM THESE directly; at most one follow-up file_read is usually needed, do NOT chain many searches/reads. Search by identifier names (function/class/file names) for best results.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "What to find, e.g. 'reminder dedupe merge', 'spotify play fallback', 'recap buildEveningRecap'",
            },
          },
          required: ["query"],
        },
      },
    },
    execute: (args) => {
      try {
        const q = typeof args.query === "string" ? args.query : "";
        if (!q.trim()) return "Error: query required";
        const idx = ensureFreshIndex();
        if (!idx) return "Error: codebase index unavailable";
        return searchCodebaseIn(idx, q);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "codebase search failed"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "codebase_refresh",
        description:
          "Rebuild the project source-code index (walks repo + allowed workspaces). Use when the user says the code just changed ('refresh index', 'index ulang') or right after large edits, so codebase_search answers stay current. Bounded and safe.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: () => {
      try {
        const t0 = Date.now();
        const idx = rebuildIndex();
        return `Index diperbarui: ${indexSummary(idx)} (${Date.now() - t0}ms).`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "rebuild failed"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "browser_open",
        description: "Open a public URL in a headless browser and return the page text (JS-rendered). Use for dashboards/SPAs that fetch_url can't handle. SSRF-guarded.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "Public http(s) URL to open" },
          },
          required: ["url"],
        },
      },
    },
    execute: async (args) => {
      try {
        return await browserOpen(typeof args.url === "string" ? args.url : "");
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "cannot open"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "browser_snapshot",
        description: "Take an accessibility snapshot of the current browser page (buttons/links/inputs with selectors). Call after browser_open to see what can be clicked/typed.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: async () => {
      try {
        return await browserSnapshot();
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "no snapshot"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "browser_click",
        description: "Click an element on the current browser page by CSS selector or text. Requires confirmation.",
        parameters: {
          type: "object",
          properties: { selector: { type: "string", description: "CSS selector or visible text to click" } },
          required: ["selector"],
        },
      },
    },
    execute: async (args) => {
      try {
        return await browserClick(typeof args.selector === "string" ? args.selector : "");
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "cannot click"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "browser_type",
        description: "Type text into an input on the current browser page. Requires confirmation.",
        parameters: {
          type: "object",
          properties: {
            selector: { type: "string", description: "CSS selector for the input" },
            text: { type: "string", description: "Text to type into the input" },
          },
          required: ["selector", "text"],
        },
      },
    },
    execute: async (args) => {
      try {
        return await browserType(typeof args.selector === "string" ? args.selector : "", typeof args.text === "string" ? args.text : "");
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "cannot type"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "browser_navigate",
        description: "Navigate the browser history (back/forward/reload).",
        parameters: {
          type: "object",
          properties: { action: { type: "string", description: "\"back\", \"forward\", or \"reload\"" } },
          required: ["action"],
        },
      },
    },
    execute: async (args) => {
      try {
        return await browserNavigate(typeof args.action === "string" ? args.action : "");
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "cannot navigate"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "mac_open",
        description:
          "Open a URL in the user's REAL browser on their Mac (visible window, LaunchServices `open`). Use when the user wants to actually SEE/browse a site themselves ('buka youtube dong') — browser_open instead runs an INVISIBLE headless browser for automation/reading. http(s) URLs only.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "http(s) URL to open, e.g. 'https://youtube.com'" },
          },
          required: ["url"],
        },
      },
    },
    execute: (args) => {
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!/^https?:\/\//i.test(url)) {
        return "Error: mac_open needs a plain http(s) URL (e.g. https://youtube.com)";
      }
      if (process.platform !== "darwin") return "Error: mac_open only works on macOS";
      return new Promise<string>((resolvePromise) => {
        execFile("open", [url], { timeout: 5000 }, (err) => {
          if (err) resolvePromise(`Error: gagal membuka ${url}`);
          else resolvePromise(`Udah kubuka di browser-mu ya: ${url} 🌸`);
        });
      });
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "device_list",
        description: "List paired devices (macos/ios/android) and their capabilities. Use to see available device nodes.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: (_args, ctx) => {
      try {
        return listDevicesText(ctx.rawUser);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "cannot list devices"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "device_pair",
        description: "Pair a new device (ios/android/macos) for the user. Requires confirmation. Use when user asks to pair their phone.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Device name, e.g. 'iPhone Zigen'" },
            platform: { type: "string", description: "Platform: macos, ios, or android" },
            capabilities: { type: "string", description: "Comma-separated caps: screenshot,exec,location,camera (default all)" },
          },
          required: ["name", "platform"],
        },
      },
    },
    execute: (args, ctx) => {
      try {
        const caps =
          typeof args.capabilities === "string"
            ? (args.capabilities.split(",").map((s) => s.trim()).filter(Boolean) as ("screenshot" | "exec" | "location" | "camera")[])
            : (["screenshot", "exec", "location", "camera"] as const);
        const dev = pairDevice(ctx.rawUser, "", typeof args.name === "string" ? args.name : "device", typeof args.platform === "string" ? (args.platform as "macos" | "ios" | "android") : "ios", caps as ("screenshot" | "exec" | "location" | "camera")[]);
        return `Paired ${dev.platform} "${dev.name}" as ${dev.id} caps: ${dev.capabilities.join(",")}`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "cannot pair"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "device_exec",
        description: "Run a safe command on a paired device (macOS). Requires confirmation. Allowlisted: ls, pwd, cat, git status, pmset, and 'blueutil -p [0|1]' to check/toggle Bluetooth power (0=off, 1=on). Use device_list to see device IDs.",
        parameters: {
          type: "object",
          properties: {
            device_id: { type: "string", description: "Device ID from device_list" },
            command: { type: "string", description: "Command to run, e.g. 'ls', 'pwd'" },
          },
          required: ["device_id", "command"],
        },
      },
    },
    execute: async (args, ctx) => {
      try {
        return await deviceExec(ctx.rawUser, typeof args.device_id === "string" ? args.device_id : "", typeof args.command === "string" ? args.command : "");
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "cannot exec on device"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "device_screenshot",
        description: "Take a screenshot on a paired macOS device. Requires confirmation. Returns the path where screenshot was saved.",
        parameters: {
          type: "object",
          properties: { device_id: { type: "string", description: "Device ID from device_list" } },
          required: ["device_id"],
        },
      },
    },
    execute: async (args, ctx) => {
      try {
        return await deviceScreenshot(ctx.rawUser, typeof args.device_id === "string" ? args.device_id : "");
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "cannot screenshot"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "device_location",
        description: "Get the location of a paired device (macOS IP-based approximate, iOS/Android GPS when online). Requires confirmation.",
        parameters: {
          type: "object",
          properties: { device_id: { type: "string", description: "Device ID from device_list" } },
          required: ["device_id"],
        },
      },
    },
    execute: async (args, ctx) => {
      try {
        const { deviceLocation } = await import("./devices");
        return await deviceLocation(ctx.rawUser, typeof args.device_id === "string" ? args.device_id : "");
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "cannot get location"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "device_camera",
        description: "Take a photo with the device camera (macOS FaceTime via imagesnap, iOS/Android when online). Requires confirmation.",
        parameters: {
          type: "object",
          properties: { device_id: { type: "string", description: "Device ID from device_list" } },
          required: ["device_id"],
        },
      },
    },
    execute: async (args, ctx) => {
      try {
        const { deviceCamera } = await import("./devices");
        return await deviceCamera(ctx.rawUser, typeof args.device_id === "string" ? args.device_id : "");
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "cannot use camera"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "device_battery",
        description: "Check battery level of a paired device (macOS via pmset/ioreg, iOS/Android queued).",
        parameters: {
          type: "object",
          properties: { device_id: { type: "string", description: "Device ID from device_list" } },
          required: ["device_id"],
        },
      },
    },
    execute: async (args, ctx) => {
      try {
        const { deviceBattery } = await import("./devices");
        return await deviceBattery(ctx.rawUser, typeof args.device_id === "string" ? args.device_id : "");
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "cannot check battery"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "calendar_list",
        description: "List calendar events for the next N days (default 7). Returns events with title and time.",
        parameters: {
          type: "object",
          properties: { days: { type: "string", description: "Number of days to look ahead (default 7)" } },
          required: [],
        },
      },
    },
    execute: (args, ctx) => {
      try {
        const days = typeof args.days === "string" ? parseInt(args.days, 10) : 7;
        return listCalText(ctx.rawUser, Number.isFinite(days) ? days : 7);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "cannot list calendar"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "calendar_add",
        description: "Add a calendar event with title and ISO start/end times. Requires confirmation. Use check availability first if needed.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Event title" },
            start: { type: "string", description: "ISO start time, e.g. 2026-09-05T10:00:00+07:00" },
            end: { type: "string", description: "ISO end time, e.g. 2026-09-05T11:00:00+07:00" },
            description: { type: "string", description: "Optional description" },
          },
          required: ["title", "start", "end"],
        },
      },
    },
    execute: (args, ctx) => {
      try {
        const s = Date.parse(typeof args.start === "string" ? args.start : "");
        const e = Date.parse(typeof args.end === "string" ? args.end : "");
        if (!Number.isFinite(s) || !Number.isFinite(e)) throw new Error("invalid start/end ISO");
        // Title is required but LLMs sometimes omit it when user says "tambah event besok jam 10" — default to "Event" or infer from prompt
        let title = typeof args.title === "string" ? args.title.trim() : "";
        if (!title) title = "Event";
        const ev = addCalEvent(title, s, e, ctx.rawUser, typeof args.description === "string" ? args.description : undefined);
        return `Added "${ev.title}" ${new Date(ev.start).toLocaleString()} → ${new Date(ev.end).toLocaleString()} (id ${ev.id})`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "cannot add event"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "calendar_check",
        description: "Check if a time slot is free or has conflicts. Give ISO start/end.",
        parameters: {
          type: "object",
          properties: {
            start: { type: "string", description: "ISO start" },
            end: { type: "string", description: "ISO end" },
          },
          required: ["start", "end"],
        },
      },
    },
    execute: (args, ctx) => {
      try {
        const s = Date.parse(typeof args.start === "string" ? args.start : "");
        const e = Date.parse(typeof args.end === "string" ? args.end : "");
        if (!Number.isFinite(s) || !Number.isFinite(e)) throw new Error("invalid ISO");
        const { free, conflicts } = checkCalAvailability(ctx.rawUser, s, e);
        if (free) return "Free — no conflicts.";
        return `Busy — ${conflicts.length} conflict(s):\n${conflicts.map((c) => `- ${c.title} ${new Date(c.start).toLocaleString()} → ${new Date(c.end).toLocaleString()}`).join("\n")}`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "cannot check"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "calendar_mac_add",
        description: "Add an event to the Mac's Calendar.app via AppleScript. Requires confirmation. Also adds to Mia's local calendar.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Event title" },
            start: { type: "string", description: "ISO start" },
            end: { type: "string", description: "ISO end" },
          },
          required: ["title", "start", "end"],
        },
      },
    },
    execute: async (args, ctx) => {
      try {
        const s = Date.parse(typeof args.start === "string" ? args.start : "");
        const e = Date.parse(typeof args.end === "string" ? args.end : "");
        if (!Number.isFinite(s) || !Number.isFinite(e)) throw new Error("invalid ISO");
        let title = typeof args.title === "string" ? args.title.trim() : "";
        if (!title) title = "Event";
        const ev = addCalEvent(title, s, e, ctx.rawUser);
        try {
          const { addToMacCalendar } = await import("./calendar");
          const macRes = await addToMacCalendar(title, new Date(s), new Date(e));
          return `Added "${title}" to Mia calendar (id ${ev.id}) and Mac Calendar: ${macRes}`;
        } catch (macErr) {
          return `Added "${title}" to Mia calendar (id ${ev.id}) but Mac Calendar failed: ${macErr instanceof Error ? macErr.message : String(macErr)}`;
        }
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "cannot add"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "calendar_mac_list",
        description: "List events from the Mac's Calendar.app (next 7 days) via AppleScript.",
        parameters: { type: "object", properties: { days: { type: "string", description: "Days ahead (default 7)" } }, required: [] },
      },
    },
    execute: async (args) => {
      try {
        const days = typeof args.days === "string" ? parseInt(args.days, 10) : 7;
        const { listMacCalendar } = await import("./calendar");
        return await listMacCalendar(Number.isFinite(days) ? days : 7);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "cannot list Mac calendar"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "send_channel",
        description:
          "Forward a message to another registered channel (e.g. Telegram or Discord). Use when the user asks to relay a message to a different platform than the one they are chatting on.",
        parameters: {
          type: "object",
          properties: {
            to: {
              type: "string",
              description: "Target channel label. Use listChannels() to see available targets.",
            },
            message: {
              type: "string",
              description: "The content to send to the target channel.",
            },
          },
          required: ["to", "message"],
        },
      },
    },
    execute: async (args) => {
      try {
        const to = typeof args.to === "string" ? args.to.trim() : "";
        const message = typeof args.message === "string" ? args.message.trim() : "";
        if (!to || !message) return `Error: both "to" and "message" are required. Available: ${listChannels().join(", ") || "(none)"}`;
        return await sendToChannel(to, message);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "invalid send"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "mood_log",
        description:
          "Record the user's current mood. Use when the user tells you how they feel (e.g. \"aku lagi stres\", \"hari ini bahagia\"). Supports great/good/okay/meh/stressed/anxious/sad/tired/angry in English or Indonesian.",
        parameters: {
          type: "object",
          properties: {
            mood: {
              type: "string",
              description: "The mood. One of: great, good, okay, meh, stressed, anxious, sad, tired, angry. Accepts Indonesian (bahagia, stres, capek, sedih, ...) and normalizes them.",
            },
            note: {
              type: "string",
              description: "Optional short reason/detail, e.g. 'kerjaan numpuk banget'",
            },
          },
          required: ["mood"],
        },
      },
    },
    execute: (args, ctx) => {
      try {
        const entry = addMood(args.mood, ctx.rawUser, args.note);
        return `Mood tercatat: ${entry.mood}${entry.note ? ` (${entry.note})` : ""}. Kalau kamu butuh pelarian atau pengalihan asik, bilang aja ya 🌸`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "invalid mood"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "mood_recent",
        description:
          "Show the user's recent mood history / trend. Use when asked \"gimana mood-ku belakangan ini\", \"aku sering sedih gak\", or to check if the user has been stressed lately.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    },
    execute: (_, ctx) => {
      try {
        return `Mood kamu:\n${moodTrend(ctx.rawUser)}\n\nRiwayat:\n${listMoods(ctx.rawUser)}`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "invalid mood query"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "spotify_link",
        description:
          "Return the Spotify authorization link for the user to open in a browser (one-time connection). Use when the user asks to play/control music and Spotify is not connected yet.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    },
    execute: (_, ctx) => {
      if (!spotifyConfigured()) return "Spotify belum dikonfigurasi (SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET).";
      if (spotifyConnected(ctx.rawUser)) return "Spotify sudah terhubung.";
      return `Hubungkan Spotify dulu: ${spotifyAuthUrl(ctx.rawUser)}`;
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "spotify_status",
        description:
          "Show what's currently playing on Spotify (song, artist, progress, device) or state that nothing is playing.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    },
    execute: async (_, ctx) => {
      try {
        return await spotifyNowPlaying(ctx.rawUser);
      } catch (err) {
        return spotifyToolError(err, ctx.rawUser);
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "spotify_search",
        description: "Search Spotify for tracks by title/artist and list the top results.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Song title and/or artist to search, e.g. 'Taylor Swift blank space'" },
          },
          required: ["query"],
        },
      },
    },
    execute: async (args, ctx) => {
      try {
        return await spotifySearch(ctx.rawUser, typeof args.query === "string" ? args.query : "");
      } catch (err) {
        return spotifyToolError(err, ctx.rawUser);
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "spotify_play",
        description:
          "Play a song on Spotify. Provide `query` to search and play the top result; omit `query` to resume paused playback. Runs immediately (no confirmation).",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Optional title/artist to play, e.g. 'Harry Styles as it was'. Omit to resume." },
          },
          required: [],
        },
      },
    },
    execute: async (args, ctx) => {
      try {
        return await spotifyPlay(ctx.rawUser, typeof args.query === "string" ? args.query : "");
      } catch (err) {
        return spotifyToolError(err, ctx.rawUser);
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "spotify_pause",
        description: "Pause Spotify playback. Requires confirmation.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    },
    execute: async (_, ctx) => {
      try {
        return await spotifyPause(ctx.rawUser);
      } catch (err) {
        return spotifyToolError(err, ctx.rawUser);
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "spotify_next",
        description: "Skip to the next track on Spotify. Requires confirmation.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    },
    execute: async (_, ctx) => {
      try {
        return await spotifyNext(ctx.rawUser);
      } catch (err) {
        return spotifyToolError(err, ctx.rawUser);
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "spotify_previous",
        description: "Go back to the previous track on Spotify. Requires confirmation.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    },
    execute: async (_, ctx) => {
      try {
        return await spotifyPrevious(ctx.rawUser);
      } catch (err) {
        return spotifyToolError(err, ctx.rawUser);
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "spotify_volume",
        description: "Set Spotify volume to a percentage (0–100). Requires confirmation.",
        parameters: {
          type: "object",
          properties: {
            percent: { type: "string", description: "Volume 0–100, e.g. '40'" },
          },
          required: ["percent"],
        },
      },
    },
    execute: async (args, ctx) => {
      try {
        const p = parseInt(typeof args.percent === "string" ? args.percent : "", 10);
        if (!Number.isFinite(p)) throw new Error("invalid percent");
        return await spotifySetVolume(ctx.rawUser, p);
      } catch (err) {
        return spotifyToolError(err, ctx.rawUser);
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "spotify_devices",
        description: "List Spotify playback devices (active device is marked ✓). Use when playback fails or to check where music will play.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    },
    execute: async (_, ctx) => {
      try {
        return await spotifyDevices(ctx.rawUser);
      } catch (err) {
        return spotifyToolError(err, ctx.rawUser);
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "mala",
        description:
          "Give a short, playfull daily fortune ('ramalan harian') — mood of the day, lucky color, lucky number, and a Mia-style hint. Same answer all day, changes daily, free/offline. Use when the user asks 'ramal aku', 'ramalan', 'mala', atau minta ramalan harian.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: (_, ctx) => renderMala(ctx.rawUser),
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "game_start",
        description:
          "Start a 'Tebak Lagu' round: Mia secretly picks a song the user recently played on Spotify and gives clue 1 (title length + artist initials). User guesses via game_guess; wrong answers reveal more clues (max 3). Requires Spotify connected (free tier OK).",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: async (_, ctx) => {
      try {
        return await startSongGame(ctx.rawUser);
      } catch (err) {
        return spotifyToolError(err, ctx.rawUser);
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "game_guess",
        description: "Submit a guess ('judul atau artis') for the active Tebak Lagu round. Correct → win + score; wrong → next clue (max 3 tries).",
        parameters: {
          type: "object",
          properties: { answer: { type: "string", description: "the user's guess, e.g. 'mr big' or 'beat it'" } },
          required: ["answer"],
        },
      },
    },
    execute: (args, ctx) => guessSong(ctx.rawUser, args.answer),
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "game_quit",
        description: "Give up the active Tebak Lagu round: reveal the secret song and show the score.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: (_, ctx) => quitSongGame(ctx.rawUser),
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "hari_libur",
        description:
          "Answer questions about Indonesian public holidays ('tanggal merah', 'hari libur nasional', 'libur apa?'). Returns fixed civil-calendar holidays (2026) and notes that moveable Islamic holidays follow the official SKB (confirm exact dates with web_search when needed). Optional `month` (1-12) filters to that month.",
        parameters: {
          type: "object",
          properties: { month: { type: "string", description: "optional month 1-12 to filter, e.g. '12' for December" } },
          required: [],
        },
      },
    },
    execute: (args, ctx) => {
      const m = parseInt(typeof args.month === "string" ? args.month : "", 10);
      return holidayInfo(ctx.rawUser, Number.isNaN(m) ? undefined : m);
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "recap",
        description:
          "Wrap up the user's day in a warm recap from local data (today's memory + moods). Use when asked 'rekap hari ini', 'refleksi', 'gimana hari ku', 'summarize my day'. A night recap also auto-pushes every evening.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: (_, ctx) => {
      const text = buildEveningRecap(ctx.rawUser);
      return text || "Belum ada aktivitas yang terekam hari ini — nanti malam aku rekap lebih lengkap ya. 🌸";
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "weekly_insight",
        description:
          "Weekly digest from local data: last 7 days' moods, task status, and most-repeated conversation themes, written in Mia's warm style. Use when asked 'insight minggu ini', 'rekap mingguan', 'gimana minggu ku', 'weekly recap'. Also auto-pushes once a week.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: (_, ctx) => {
      const text = buildWeeklyInsight(ctx.rawUser);
      return text || "Belum ada data yang cukup untuk minggu ini — makin sering ngobrol, makin lengkap insightnya 🌸";
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "reminders_list",
        description:
          "List the user's ACTUAL reminder state (scheduled + today's delivered). Call this BEFORE claiming anything about a reminder (belum lewat/udah lewat/terkirim) — never invent reminder status from memory.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: (_, ctx) => remindersListText(ctx.rawUser),
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "habit_log",
        description: "Log a habit for today (minum air, olahraga, tidur tepat waktu). Creates habit if new, deduped per day.",
        parameters: { type: "object", properties: { name: { type: "string", description: "habit name" } }, required: ["name"] },
      },
    },
    execute: (args, ctx) => {
      try {
        return logHabit(String(args.name || ""), ctx.rawUser);
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: { name: "habit_stats", description: "Show habit consistency this week (7 days).", parameters: { type: "object", properties: {}, required: [] } },
    },
    execute: (_, ctx) => habitStats(ctx.rawUser),
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "gmail_link",
        description: "Get Gmail connect URL. Use when user wants to connect email or when gmail_not_connected. Returns auth link.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: (_, ctx) => {
      if (!gmailConfigured()) return "Gmail belum dikonfigurasi — hubungi admin untuk set GMAIL_CLIENT_ID/SECRET.";
      if (gmailConnected(ctx.rawUser)) return "Gmail sudah terhubung ✓";
      return `Buka link ini untuk hubungkan Gmail: ${gmailAuthUrl(ctx.rawUser)}`;
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "gmail_list",
        description: "List recent Gmail inbox (10 latest). Shows id, subject, from, date, snippet. Use for inbox overview.",
        parameters: {
          type: "object",
          properties: {
            maxResults: { type: "string", description: "Number 1-20, default 10" },
          },
          required: [],
        },
      },
    },
    execute: async (args, ctx) => {
      try {
        const n = Math.min(20, Math.max(1, parseInt(String(args.maxResults || "10"), 10) || 10));
        return await gmailList(ctx.rawUser, n);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        if (m.includes("gmail_not_connected")) return `Gmail belum terhubung — ${gmailAuthUrl(ctx.rawUser)}`;
        return `Error: ${m}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "gmail_read",
        description: "Read full Gmail message by id (from gmail_list). Returns headers + body text.",
        parameters: {
          type: "object",
          properties: { id: { type: "string", description: "Message id from gmail_list" } },
          required: ["id"],
        },
      },
    },
    execute: async (args, ctx) => {
      try {
        return await gmailRead(ctx.rawUser, String(args.id || ""));
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        if (m.includes("gmail_not_connected")) return `Gmail belum terhubung — ${gmailAuthUrl(ctx.rawUser)}`;
        return `Error: ${m}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "gmail_search",
        description: "Search Gmail (Gmail query syntax: from:, subject:, after:, etc). Returns matching messages.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Gmail search query, e.g. 'from:boss after:2024/01/01'" },
            maxResults: { type: "string", description: "Number 1-20, default 10" },
          },
          required: ["query"],
        },
      },
    },
    execute: async (args, ctx) => {
      try {
        const n = Math.min(20, Math.max(1, parseInt(String(args.maxResults || "10"), 10) || 10));
        return await gmailSearch(ctx.rawUser, String(args.query || ""), n);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        if (m.includes("gmail_not_connected")) return `Gmail belum terhubung — ${gmailAuthUrl(ctx.rawUser)}`;
        return `Error: ${m}`;
      }
    },
  },
];

// Derived getter (not a static snapshot) so a runtime `registerTool` is always
// reflected in what's sent to the model. agent.ts consumes TOOLS per turn.
export function getTOOLS(): ToolDefinition[] {
  return toolRegistry.map((p) => p.definition);
}
export const TOOLS: ToolDefinition[] = getTOOLS();

export function getTool(name: string): ToolPlugin | undefined {
  return toolRegistry.find((p) => p.definition.function.name === name);
}

/** Register a new tool plugin at runtime (plugin system). */
export function registerTool(plugin: ToolPlugin): void {
  const i = toolRegistry.findIndex((p) => p.definition.function.name === plugin.definition.function.name);
  if (i >= 0) {
    toolRegistry[i] = plugin;
  } else {
    toolRegistry.push(plugin);
  }
}

/**
 * Execute a tool call by dispatching to its registered plugin. Safely parses
 * the JSON arguments and routes to the plugin's `execute` (which owns its own
 * per-tool error handling).
 */
export async function executeTool(call: ToolCall, rawUser?: unknown): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.arguments || "{}");
  } catch {
    return "Error: invalid tool arguments";
  }
  const plugin = getTool(call.name);
  if (!plugin) return `Error: unknown tool "${call.name}"`;
  // Fase-5 permission policy: TOOLS_DENY (central config) hard-blocks a tool for
  // every channel, even read-only ones. Best-effort audit records the block.
  if (toolsDeny().includes(call.name)) {
    try {
      auditLog(rawUser, `tool:${call.name}::denied`, JSON.stringify(args).slice(0, 300));
    } catch { /* no-op */ }
    return `Tool "${call.name}" dinonaktifkan oleh kebijakan (TOOLS_DENY).`;
  }
  // Fase-5 audit + observability: who/what/when for every tool call, plus a
  // call counter. Best-effort, never disturbs the result.
  try {
    auditLog(rawUser, `tool:${call.name}`, JSON.stringify(args).slice(0, 300));
  } catch { /* no-op */ }
  recordToolCall(rawUser, call.name);
  const userKey = sanitizeUser(rawUser);
  const out = await plugin.execute(args, { userKey, rawUser });
  return out ?? "";
}

/** Map a Spotify API error to a user-facing message; append the auth link when
 *  the user isn't connected yet. Shared by the spotify_* tool plugins. */
function spotifyToolError(err: unknown, rawUser?: unknown): string {
  const msg = err instanceof Error ? err.message : "Spotify error";
  if (msg === "spotify_not_connected") {
    if (!spotifyConfigured()) return "Spotify belum dikonfigurasi (SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET).";
    return `Koneksi Spotify belum dibuat. Buka link ini sekali untuk menghubungkan: ${spotifyAuthUrl(rawUser)}`;
  }
  if (msg === "spotify_no_active_device") {
    return "Tidak ada perangkat Spotify aktif — buka aplikasi Spotify di perangkatmu dulu, lalu coba lagi.";
  }
  return `Error: ${msg}`;
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

function scheduleReminder(text: string, isoWhen: string, rawUser: unknown, repeat?: "daily"): string {
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
  const r = addReminder(text, atMs, rawUser, { repeat });
  const freq = repeat === "daily" ? "daily" : "once";
  return `Reminder set (${freq}): "${r.text}" at ${whenText}. The user will be notified then.`;
}

// File access tool (Phase 4). Read-only, sandboxed to the project root
// (process.cwd()), resolved after `..` normalization, and a deny-list keeps
// secrets/build/server directories out of the LLM context:
//   - .env* / *.local        → API keys, never exposed
//   - .git, node_modules, .next, .data  → not user-authored material
const FILE_MAX_BYTES = 60000;
const DENY_SEGMENTS = [".git", "node_modules", ".next", ".data", "dist", "coverage"];
const DENY_PATTERNS = [/^\.env(\.|$)/i, /.local$/, /\.(key|pem|crt)$/i, /\.(pyc|class|o)$/];

function fileRead(rawPath: string): string {
  const p = (rawPath || "").trim();
  if (!p) throw new Error("empty path");
  if (p.includes("~")) throw new Error("tilde paths are not allowed");

  const abs = resolveInSandbox(p);
  if (!abs) throw new Error("path escapes every allowed sandbox root");

  const rel = abs.split(sep);
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

  if (stat.size > FILE_MAX_BYTES) {
    const content = readFileSync(abs, "utf8").slice(0, FILE_MAX_BYTES);
    return content + `\n… (truncated — file is ${stat.size} bytes, showing first ${FILE_MAX_BYTES})`;
  }
  return readFileSync(abs, "utf8").slice(0, FILE_MAX_BYTES);
}

const FILE_WRITE_MAX_BYTES = 60000;

function fileWrite(rawPath: string, content: string): string {
  const p = (rawPath || "").trim();
  if (!p) throw new Error("empty path");
  if (p.includes("~")) throw new Error("tilde paths are not allowed");
  if (content.length > FILE_WRITE_MAX_BYTES) throw new Error("content too large");
  const abs = resolveInSandbox(p);
  if (!abs) throw new Error("path escapes every allowed sandbox root");
  const rel = abs.split(sep);
  for (const seg of rel) {
    if (DENY_SEGMENTS.includes(seg)) throw new Error(`"${seg}" is not writable`);
    if (DENY_PATTERNS.some((re) => re.test(seg))) throw new Error(`"${seg}" is blocked for security`);
  }
  // Prevent writing directly to a directory path (no extension and exists as dir is handled, but also block bare dir writes)
  try {
    if (statSync(abs).isDirectory()) throw new Error("path is a directory, not a file");
  } catch (e) {
    if (e instanceof Error && e.message.includes("is a directory")) throw e;
    // file does not exist yet — ok, will create
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  return `Wrote ${content.length} bytes to ${p}`;
}

function fileEdit(rawPath: string, oldStr: string, newStr: string): string {
  const p = (rawPath || "").trim();
  if (!p) throw new Error("empty path");
  if (!oldStr) throw new Error("old_string is required");
  const abs = resolveInSandbox(p);
  if (!abs) throw new Error("path escapes every allowed sandbox root");
  const rel = abs.split(sep);
  for (const seg of rel) {
    if (DENY_SEGMENTS.includes(seg)) throw new Error(`"${seg}" is not writable`);
    if (DENY_PATTERNS.some((re) => re.test(seg))) throw new Error(`"${seg}" is blocked for security`);
  }
  const cur = readFileSync(abs, "utf8");
  if (!cur.includes(oldStr)) throw new Error("old_string not found in file");
  // Only replace first occurrence to keep it predictable; use replaceAll if needed via multiple calls
  const next = cur.replace(oldStr, newStr);
  if (next.length > FILE_WRITE_MAX_BYTES) throw new Error("result too large");
  writeFileSync(abs, next, "utf8");
  return `Edited ${p}: replaced 1 occurrence`;
}

/**
 * Read-only shell execution with a strict allowlist (invariant 5: no mutating
 * commands ever reach the LLM context). The whole command string must match an
 * allowlisted pattern; args are tokenized and each passed verbatim to execFile
 * (no shell interpretation), and runs in the project root with a timeout.
 */
const EXEC_MAX_OUTPUT = 60000;
const EXEC_TIMEOUT_MS = 10000;
// Write commands include npm test/script runs — a unit-test suite can easily
// take a minute, so confirmed write commands get a bigger budget.
const EXEC_WRITE_TIMEOUT_MS = 150000;
/** Allowlisted read-only commands: base binary + (for subcommand tools) allowed
 *  read-only subcommands. Anything else is rejected. */
const EXEC_ALLOWLIST: Record<
  string,
  { subcommand?: string[]; maxArgs: number } | { maxArgs: number }
> = {
  git: { subcommand: ["status", "log", "diff", "branch", "ls-files", "show", "rev-parse", "--version"], maxArgs: 4 },
  ls: { maxArgs: 4 },
  pwd: { maxArgs: 0 },
  cat: { maxArgs: 4 },
  node: { subcommand: ["--version", "-v"], maxArgs: 2 },
  npm: { subcommand: ["ls", "--version"], maxArgs: 3 },
  df: { maxArgs: 2 },
};
/** Args that are never allowed, even for an allowlisted base command. */
const EXEC_FORBIDDEN_ARG = ["--", "-a", "--all", "..", "~", ";", "&&", "|", ">", "<", "$(", "`"];
const EXEC_FORBIDDEN_SRC =
  /(\.env|\.local|\.key|\.pem|\.crt|node_modules|\.next|\.data|package-lock)/i;

function execSafe(rawCommand: string, rawCwd = ""): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const trimmed = (rawCommand || "").trim();
    if (!trimmed) {
      rejectPromise(new Error("empty command"));
      return;
    }
    // Resolve the working directory inside an allowed sandbox root. An empty
    // cwd means the repo root; a relative path may target an allowed workspace.
    let cwd = repoRoot();
    if (rawCwd && rawCwd.trim()) {
      const resolvedCwd = resolveInSandbox(rawCwd.trim());
      if (!resolvedCwd) {
        rejectPromise(new Error("cwd escapes every allowed sandbox root"));
        return;
      }
      cwd = resolvedCwd;
    }
    const parts = trimmed.split(/\s+/);
    const [cmd, ...args] = parts;
    const spec = EXEC_ALLOWLIST[cmd];
    if (!spec) {
      rejectPromise(new Error(`command "${cmd}" is not allowed for read-only exec — for running tests/scripts use exec_write (it will ask the user for confirmation)`));
      return;
    }
    if ("subcommand" in spec) {
      // First arg is the git/node/npm subcommand; must be a read-only one.
      if (args.length === 0) {
        rejectPromise(new Error("missing subcommand"));
        return;
      }
      if (!spec.subcommand!.includes(args[0])) {
        rejectPromise(new Error(`subcommand "${args[0]}" is not allowed for read-only exec — e.g. 'npm test'/'npm run' belong in exec_write (requires user confirmation)`));
        return;
      }
      if (args.length - 1 > spec.maxArgs) {
        rejectPromise(new Error("too many arguments"));
        return;
      }
    } else if (args.length > spec.maxArgs) {
      rejectPromise(new Error("too many arguments"));
      return;
    }
    for (const a of args) {
      if (EXEC_FORBIDDEN_ARG.includes(a)) {
        const hint = [";", "&&", "|", ">", "<"].includes(a) ? " — do not chain commands, call each separately" : "";
        rejectPromise(new Error(`argument "${a}" is not allowed${hint}`));
        return;
      }
    }
    // Refuse reading sensitive/dir-heavy targets (mirrors file_read deny-list).
    if (EXEC_FORBIDDEN_SRC.test(trimmed)) {
      rejectPromise(new Error("command targets a blocked path"));
      return;
    }
    // macOS: `df /` reads the sealed SYSTEM snapshot (always ~40%) — remap to
    // the real data volume so any model-generated `df -h /` answers honestly.
    const parts2 = process.platform === "darwin" && cmd === "df"
      ? args.map((a) => (a === "/" ? "/System/Volumes/Data" : a))
      : args;
    execFile(
      cmd,
      parts2,
      { cwd, timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_OUTPUT * 2 },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException & { code?: number }).code;
          const msg = stderr?.trim() || err.message || "command failed";
          rejectPromise(new Error(`${msg}${typeof code === "number" ? ` (exit ${code})` : ""}`));
          return;
        }
        resolvePromise((stdout || "").trim().slice(0, EXEC_MAX_OUTPUT) || "(no output)");
      }
    );
  });
}

/** Allowlisted write commands — require FR-014 confirmation (risk: write). */
const EXEC_WRITE_ALLOWLIST: Record<string, { subcommand: string[]; maxArgs: number }> = {
  git: { subcommand: ["add", "commit", "push", "restore"], maxArgs: 6 },
  // npm test / npm run <script> execute the project's own scripts (unit tests!):
  // confirmed by the user via FR-014 before they run. `npx` stays out (it can
  // download arbitrary packages).
  npm: { subcommand: ["test", "run"], maxArgs: 6 },
};

/** Tokenize a command string respecting single/double quotes (e.g. git commit -m "msg with spaces"). */
function tokenizeCommand(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === " " || ch === "\t") {
      if (cur) {
        out.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function execWriteSafe(rawCommand: string, rawCwd = ""): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const trimmed = (rawCommand || "").trim();
    if (!trimmed) {
      rejectPromise(new Error("empty command"));
      return;
    }
    let cwd = repoRoot();
    if (rawCwd && rawCwd.trim()) {
      const resolvedCwd = resolveInSandbox(rawCwd.trim());
      if (!resolvedCwd) {
        rejectPromise(new Error("cwd escapes every allowed sandbox root"));
        return;
      }
      cwd = resolvedCwd;
    }
    const parts = tokenizeCommand(trimmed);
    const [cmd, ...args] = parts;
    const spec = EXEC_WRITE_ALLOWLIST[cmd];
    if (!spec) {
      rejectPromise(new Error(`command "${cmd}" is not allowed for write — allowed: git add/commit/push/restore, npm test, npm run <script>`));
      return;
    }
    if (args.length === 0) {
      rejectPromise(new Error("missing subcommand"));
      return;
    }
    if (!spec.subcommand.includes(args[0])) {
      rejectPromise(new Error(`subcommand "${args[0]}" is not allowed for write`));
      return;
    }
    if (args.length - 1 > spec.maxArgs) {
      rejectPromise(new Error("too many arguments"));
      return;
    }
    for (const a of args) {
      if ([";", "&&", "|", ">", "<", "$(", "`", "..", "~"].includes(a)) {
        rejectPromise(new Error(`argument "${a}" is not allowed — do not chain commands with && or ;, call each command separately`));
        return;
      }
    }
    if (EXEC_FORBIDDEN_SRC.test(trimmed)) {
      rejectPromise(new Error("command targets a blocked path"));
      return;
    }
    execFile(cmd, args, { cwd, timeout: EXEC_WRITE_TIMEOUT_MS, maxBuffer: EXEC_MAX_OUTPUT * 2 }, (err, stdout, stderr) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException & { code?: number }).code;
        // npm prefixes progress noise on stderr ("npm notice run ...") — keep
        // the actual error lines so a failed test run isn't unreadable.
        const msg = stderr?.split("\n").filter((l) => !/^npm notice/i.test(l)).join("\n").trim() || err.message || "command failed";
        rejectPromise(new Error(`${msg}${typeof code === "number" ? ` (exit ${code})` : ""}`));
        return;
      }
      resolvePromise((stdout || "").trim().slice(0, EXEC_MAX_OUTPUT) || "(no output)");
    });
  });
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
export function canonicalizeUrl(raw: string): string {
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
export function assertPublicUrl(raw: string): URL {
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