import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join, resolve, sep } from "node:path";
import { detectMoodIntent } from "./moodIntent";
import { sanitizeUser, userDataRoot, appRoot, repoRoot, resolveInSandbox } from "./users";
import { asBodyString, asNumber, asStringArray, redactArgsForDisplay } from "./args";
import { addReminder, readReminders, type Reminder } from "./reminders";
import { addTask, listTasks, rescheduleTask, setTaskStatus } from "./tasks";
import { listUploads, readUpload } from "./uploads";
import { addOrMergeAutomation, describeSchedule } from "./automations";
import { searchMemory } from "./rag";
import { listLearnings, reviewLearnings, searchLearnings, logError } from "./learnings";
import { guard as safeGuard } from "./safeExec";
import { assertPublicUrl } from "./netGuard";
import { cuaClick, cuaClickXY, cuaDoctor, cuaLaunch, cuaListApps, cuaListWindows, cuaType, cuaWindowState } from "./cua";
import { addSleep, addWake, addWater, healthDeleteLast, healthStats, healthUpdateLast } from "./health";
import { forget as clawicForget, memoryStats as clawicStats, recall as clawicRecall, remember as clawicRemember } from "./clawicMemory";
import { ensureFreshIndex, rebuildIndex, searchCodebaseIn, indexSummary } from "./codebaseIndex";
import { readDailyMemory } from "./dailyMemory";
import { browserOpen, browserSnapshot, browserClick, browserType, browserNavigate, browserEval } from "./browser";
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

/** Human-readable reminder state — now with soul (less kaku, more Mia):
 *  Single daily reminder → warm natural line, not stiff "Daftar ... total".
 *  Multiple → keep list but with warm opener. Vary rhythm, use I when natural. */
function reminderDeliveryStamp(r: Reminder): string {
  const stamp = (ms: number) =>
    new Date(ms).toLocaleString("id-ID", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  if (r.deliveredAt && r.lastFiredAt && r.deliveredAt - r.lastFiredAt > 30 * 60_000) {
    return ` · kesampaian TELAT ${stamp(r.deliveredAt)} (slot ${stamp(r.lastFiredAt)} pas device off)`;
  }
  return ` · terkirim ${stamp(r.lastFiredAt ?? r.at)}`;
}
function remindersListText(rawUser: unknown): string {
  const now = Date.now();
  const rs = readReminders(rawUser);
  if (!rs.length) return "Belum ada reminder beb — mau aku ingetin apa? 🌸";
  const fmt = (ms: number): string =>
    new Date(ms).toLocaleString("id-ID", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const upcoming = rs.filter((r) => !r.fired && r.at >= now).sort((a, b) => a.at - b.at).slice(0, 10);
  if (!upcoming.length) return "Belum ada reminder terjadwal beb — semuanya udah lewat, mau bikin baru? 🌸";
  // Single → natural warm, not stiff list (maximal anti-kaku, soul: short punchy) — keep "terjadwal" for verify/honesty
  if (upcoming.length === 1 && upcoming[0].repeat === "daily") {
    const r = upcoming[0];
    const jam = new Date(r.at).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
    if (r.delivered && reminderDeliveryStamp(r).includes("TELAT")) {
      return `Maaf beb, ini jujur ya — ${reminderDeliveryStamp(r).replace(" · ", "")}. Slot berikut besok jam ${jam}, mau kubangunin nanti malam aja sekalian? 🌸 (late)`;
    }
    if (r.missedAt && r.delivered === false) {
      const miss = new Date(r.missedAt).toLocaleString("id-ID", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
      return `Maaf beb, slot ${miss} WIB kelewat — device mati / nggak ada kanal yang nyampe 🙏 ${r.repeat === "daily" ? `slot berikut besok jam ${jam}, udah kusiapin ulang 🌸 (missed)` : `mau aku ingetin sekarang aja? 🌸 (missed)`}`;
    }
    return `Besok jam ${jam} ya beb — "${r.text}" harian 🔁${r.delivered ? reminderDeliveryStamp(r) : ""}, udah aku siapin 🌸 (terjadwal)`;
  }
  if (upcoming.length === 1) {
    const r = upcoming[0];
    const jam = new Date(r.at).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
    if (r.missedAt && r.delivered === false) {
      const miss = new Date(r.missedAt).toLocaleString("id-ID", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
      return `Maaf beb, "${r.text}" tadi ${miss} kelewat — device mati, nggak kesampaian 🙏 Mau kuingetin sekarang? 🌸 (missed)`;
    }
    return `Kamu ada 1 reminder beb — jam ${jam} "${r.text}" 🌸 (terjadwal)`;
  }
  const lines: string[] = [`Nih beb — ${upcoming.length} reminder aktif 🌸`];
  for (const r of upcoming) {
    const stamp = (ms: number) =>
      new Date(ms).toLocaleString("id-ID", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    const status = r.delivered
      ? reminderDeliveryStamp(r)
      : r.missedAt
        ? ` · KELEWAT ${stamp(r.missedAt)}`
        : "";
    lines.push(`• ${fmt(r.at)} — "${r.text}"${r.repeat === "daily" ? " (harian 🔁)" : ""}${status} — siap aku ingetin ⏰`);
  }
  return lines.join("\n");
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
  /** The user's most recent message this turn. Tools that must only record
   *  USER-sourced data (e.g. mood_log) verify against it. */
  lastUserText?: string;
  userKey: string | null;
  rawUser?: unknown;
}

/** A tool plugin: a schema definition + its implementation, bundled together. */
export interface ToolPlugin {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string> | string;
}

/** Tools that must wait for explicit user confirmation before running (FR-014). */
/**
 * Honest flag for high/critical findings filed without poc/retest proof
 * (audit 2026-09-23). Returns a warning suffix or "". Pure — tested.
 */
export function proofWarning(severity: string, evidenceSteps: string, retestUrl: string): string {
  if ((severity === "high" || severity === "critical") && !retestUrl) {
    if (!/poc_verify|retest|terkonfirmasi|STABIL|deterministik|oast_poll/i.test(evidenceSteps || "")) {
      return `\n⚠️ Temuan ${severity} TANPA bukti poc/retest — verifikasi via \`poc_verify\` + retest case sebelum submit/lapor.`;
    }
  }
  return "";
}

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
        name: "google_news",
        description:
          "Fetch Google News headlines — top stories, or a keyword search scoped to one or more language editions, deduped across outlets. Use when the user asks about current news, breaking stories, or 'berita terbaru'.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Optional keyword to search. Omit for top headlines.",
            },
            language: {
              type: "string",
              description: "Primary edition, e.g. 'id-ID' (default), 'en-US'. Maps to Google News hl/gl.",
            },
            region: {
              type: "string",
              description: "Optional extra comma-separated editions to merge, e.g. 'en-US,en-GB' (primary edition comes first).",
            },
            within: {
              type: "number",
              description: "Optional hours window: keep only stories published in the last N hours (e.g. 24).",
            },
          },
          required: [],
        },
      },
    },
    execute: (args) =>
      googleNews(
        typeof args.query === "string" ? args.query : "",
        typeof args.language === "string" ? args.language : "id-ID",
        typeof args.region === "string" ? args.region : undefined,
        asNumber(args.within)
      ),
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "research",
        description:
          "Multi-source research digest: merges Google News editions (deduped) + web search snippets + up to two article bodies into one summarized bundle with citation links. Best for questions needing cross-source synthesis ('riset', 'kabari lengkap', 'bagaimana perkembangan ...').",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Topic or question to research (required).",
            },
            language: {
              type: "string",
              description: "Primary edition, e.g. 'id-ID' (default), 'en-US'.",
            },
            region: {
              type: "string",
              description: "Optional extra comma-separated editions to merge, e.g. 'en-US,en-GB'.",
            },
            within: {
              type: "number",
              description: "Optional hours window: keep only stories published in the last N hours (e.g. 72).",
            },
          },
          required: ["query"],
        },
      },
    },
    execute: (args) =>
      research(
        typeof args.query === "string" ? args.query : "",
        typeof args.language === "string" ? args.language : "id-ID",
        typeof args.region === "string" ? args.region : undefined,
        asNumber(args.within)
      ),
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
          "Run a read-only shell command in a project and return its output. Only safe inspection commands are allowed: git status/log/diff/branch/remote/tag/blame/… ; ls, pwd, cat, head, tail, wc, du, stat, file, which, sort, uniq, cut, tr, jq; system info (whoami, id, hostname, uname, sw_vers, date, uptime, w, sysctl, vm_stat, mount); df, ps, pgrep, netstat, ifconfig, arp; docker ps|images|version|info; and lsof restricted to network queries (e.g. 'lsof -iTCP -sTCP:LISTEN -P -n'). Anything else (env, curl, sed -i, rm, git push, chained commands) is rejected — use exec_write for mutating commands (asks confirmation). Use cwd (a path relative to the repo root; to inspect another allowed workspace pass its folder name) to choose the directory; default is the repo root.",
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
        description:
          "Delete saved notes. Use `number` for a single note (1-based index from list_notes), `match` to delete every note whose text contains a substring, or `all:true` to clear all notes. You do NOT need to list first — pass `match` directly.",
        parameters: {
          type: "object",
          properties: {
            number: {
              type: "string",
              description: "The note index to delete (1-based, as shown by list_notes)",
            },
            match: {
              type: "string",
              description: "Delete every note whose content contains this text (case-insensitive)",
            },
            all: {
              type: "boolean",
              description: "Delete ALL saved notes",
            },
          },
          required: [],
        },
      },
    },
    execute: (args, ctx) => {
      try {
        if (args.all === true) return deleteNotesBy(() => true, ctx.userKey, "all");
        if (typeof args.match === "string" && args.match.trim()) {
          const needle = args.match.toLowerCase();
          return deleteNotesBy((n) => n.content.toLowerCase().includes(needle), ctx.userKey, `matching "${args.match.trim()}"`);
        }
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
          "Schedule a reminder notification ONLY when the user explicitly asks to be reminded in the future (e.g. 'ingetin aku jam 12', 'set alarm buat besok'). Set repeat to \"daily\" for a recurring reminder (e.g. wake-up every day at 7). Make the title engaging (emoji, vibe) and add a warm notes field with creative details — but ONLY when the user actually asked for a reminder; never schedule a reminder unprompted.",
        parameters: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "Imaginative title, e.g. 'Nonton Cars 🚗 — Pixar marathon, siap popcorn!'",
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
            notes: {
              type: "string",
              description: "Optional warm/imaginative body/notes, e.g. 'Nostalgia Lightning McQueen, jangan lupa siapin cemilan!'",
            },
          },
          required: ["text", "when"],
        },
      },
    },
    execute: (args, ctx) => {
      try {
        const repeatArg = args.repeat === "daily" ? "daily" : undefined;
        const notes = typeof args.notes === "string" ? args.notes : undefined;
        const out = scheduleReminder(
          typeof args.text === "string" ? args.text : "",
          typeof args.when === "string" ? args.when : "",
          ctx.rawUser,
          repeatArg,
          notes
        );
        // Creating a wake reminder updates the persona wake_up_time (single
        // source of truth) so Mia never cites a stale hour.
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { syncWakePersona } = require("./persona") as typeof import("./persona");
          syncWakePersona(ctx.rawUser);
        } catch { /* best-effort */ }
        return out;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "invalid reminder"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "automation_list",
        description: "List all cronjob automations for the user (the scheduled prompts). Use when user asks 'cronjob kamu apa aja?'",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: (_args, ctx) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { listAutomationsText } = require("./automations") as typeof import("./automations");
        return listAutomationsText(ctx.rawUser);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "cannot list automations"}`;
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
          "Create a recurring automation that runs a prompt on a schedule and pushes the result to the user. Only when user explicitly says 'buatin cronjob/automation' — do NOT call when user just asks to list.",
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
        const { automation: auto, merged } = addOrMergeAutomation(prompt, schedule, ctx.rawUser);
        return merged
          ? `Automation sudah ada (TIDAK diduplikasi) — prompt diperbarui: "${auto.prompt}" runs ${describeSchedule(auto.schedule)}. Katakan ke user bahwa automation itu sudah aktif (diperbarui), jangan buat lagi.`
          : `Automation created: "${auto.prompt}" runs ${describeSchedule(auto.schedule)}.`;
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
          "Add a task — be imaginative: make title engaging with emoji/vibe, not raw (e.g. 'Nonton Cars' → 'Nonton Cars 🚗 — Pixar night!').",
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
        let text = typeof args.text === "string" ? args.text.trim() : "";
        if (/^nonton cars$/i.test(text) && !/[^\x00-\x7F]/.test(text)) {
          text = "Nonton Cars 🚗 — Pixar marathon, siap popcorn!";
        }
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
        description:
          "Mark a task as done. Pass `number` (1-based from list_tasks) OR `match` (text substring of the task) — don't list first just to complete.",
        parameters: {
          type: "object",
          properties: {
            number: {
              type: "string",
              description: "The task index to complete (1-based)",
            },
            match: {
              type: "string",
              description: "Complete the single task whose text contains this (case-insensitive)",
            },
          },
          required: [],
        },
      },
    },
    execute: (args, ctx) => {
      try {
        return setTaskStatus({ number: args.number, match: args.match }, "done", ctx.rawUser);
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
        description:
          "Cancel a task. Pass `number` (1-based from list_tasks) OR `match` (text substring of the task) — don't list first just to cancel.",
        parameters: {
          type: "object",
          properties: {
            number: {
              type: "string",
              description: "The task index to cancel (1-based)",
            },
            match: {
              type: "string",
              description: "Cancel the single task whose text contains this (case-insensitive)",
            },
          },
          required: [],
        },
      },
    },
    execute: (args, ctx) => {
      try {
        return setTaskStatus({ number: args.number, match: args.match }, "cancelled", ctx.rawUser);
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
        description:
          "Change a task's due date. Pass `number` (1-based from list_tasks) OR `match` (text substring of the task), plus `dueAt`.",
        parameters: {
          type: "object",
          properties: {
            number: {
              type: "string",
              description: "The task index to reschedule (1-based)",
            },
            match: {
              type: "string",
              description: "Reschedule the single task whose text contains this (case-insensitive)",
            },
            dueAt: {
              type: "string",
              description: "New ISO-8601 due date",
            },
          },
          required: ["dueAt"],
        },
      },
    },
    execute: (args, ctx) => {
      try {
        return rescheduleTask({ number: args.number, match: args.match }, new Date(String(args.dueAt)).getTime(), ctx.rawUser);
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
      risk: "write",
      function: {
        name: "cancel_reminder",
        description: "Cancel/delete reminders matching a keyword (e.g. 'sikat gigi' deletes sikat gigi reminders). Use when user says 'hapus reminder sikat gigi' or 'cancel sikat gigi'.",
        parameters: { type: "object", properties: { query: { type: "string", description: "Keyword to match reminder text, e.g. 'sikat gigi'" } }, required: ["query"] },
      },
    },
    execute: (args, ctx) => {
      try {
        const q = typeof args.query === "string" ? args.query : "";
        if (!q.trim()) return "Error: query required";
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { deleteReminders, readReminders } = require("./reminders") as typeof import("./reminders");
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { isWakeIntent } = require("./reminderIntent") as typeof import("./reminderIntent");
        const n = deleteReminders(ctx.rawUser, q);
        // If the wake reminder is gone, drop the persona wake_up_time fact rather
        // than leaving a stale hour behind.
        try {
          if (!readReminders(ctx.rawUser).some((r: { text: string }) => isWakeIntent(r.text))) {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { forgetPersonaFact } = require("./persona") as typeof import("./persona");
            forgetPersonaFact(ctx.rawUser, "wake_up_time");
          }
        } catch { /* best-effort */ }
        return n ? `Dihapus ${n} reminder mengandung "${q}" beb 🌸` : `Tidak ada reminder mengandung "${q}"`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "cannot delete"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
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
    execute: async (args, ctx) => {
      try {
        const res = await searchMemory(typeof args.query === "string" ? args.query : "", ctx.rawUser);
        if (/^No |empty query/i.test(res.trim())) return res;
        return `Aku inget ini beb — hasil memory untuk "${String(args.query).slice(0,60)}" 🌸\n${res}`;
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
    definition: { type: "function", risk: "read", function: { name: "memory_where", description: "Tunjukkan DI MANA memori user disimpan (path + jumlah entri) — jawab pertanyaan 'kamu nyimpen memori di mana' dari fakta, bukan tebakan. Read, auto.", parameters: { type: "object", properties: {}, required: [] } } },
    execute: async (_args, ctx) => { try { const { memoryWhere } = await import("./memoryWhere"); return memoryWhere(ctx.rawUser); } catch (e) { return `Error: ${e instanceof Error ? e.message : "memory_where failed"}`; } },
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
        const res = searchCodebaseIn(idx, q);
        if (/^No |Error:/i.test(res.trim())) return res;
        return `Nih beb — aku temuin di codebase untuk "${q.slice(0,60)}" 🌸\n${res}`;
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
        name: "browser_eval",
        description: "Evaluate a JS expression in the current Playwright page (after browser_open) — enumerate script[src]/DOM/fetch endpoints. No external daemon needed. Read, auto.",
        parameters: { type: "object", properties: { expr: { type: "string", description: "JS expression, mis. \"[...document.querySelectorAll('script[src]')].map(s=>s.src)\"" } }, required: ["expr"] },
      },
    },
    execute: async (args) => {
      try {
        return await browserEval(typeof args.expr === "string" ? args.expr : "");
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "browser_eval failed"}`;
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
        description: "Add a calendar event — be imaginative: title should be engaging warm (emoji/vibe), not raw. Requires confirmation.",
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
        if (/^nonton cars$/i.test(title) && !/[^\x00-\x7F]/.test(title)) title = "Nonton Cars 🚗 — Pixar marathon, siap popcorn!";
        let desc = typeof args.description === "string" ? args.description.trim() : "";
        if (!desc && title.toLowerCase().includes("cars")) desc = "Pixar marathon — Lightning McQueen nostalgia, siap popcorn & minuman dingin 🚗🌸";
        const ev = addCalEvent(title, s, e, ctx.rawUser, desc || undefined);
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
      risk: "write",
      function: {
        name: "reminders_mac_add",
        description: "Add a reminder to the Mac's Reminders.app via AppleScript (visible in the Reminders app). Be imaginative: make title engaging with emoji/vibe and add warm notes — don't leave title raw. Requires confirmation. Use when user says 'di app reminder' / 'Reminders.app' / 'Apple Reminders'.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Imaginative title, e.g. 'Nonton Cars 🚗 — Pixar marathon!'" },
            due: { type: "string", description: "ISO due date, e.g. 2026-09-09T12:00:00+07:00" },
            notes: { type: "string", description: "Optional warm/imaginative body, e.g. 'Siap popcorn, nostalgia Lightning McQueen!'" },
          },
          required: ["title", "due"],
        },
      },
    },
    execute: async (args) => {
      try {
        const dueMs = Date.parse(typeof args.due === "string" ? args.due : "");
        if (!Number.isFinite(dueMs)) throw new Error("invalid due ISO");
        let title = typeof args.title === "string" ? args.title.trim() : "";
        if (!title) title = "Reminder";
        let notes = typeof args.notes === "string" ? args.notes.trim().slice(0, 500) : undefined;
        if (!notes) notes = imaginativeNotes(title);
        if (/^nonton cars$/i.test(title.trim()) && !/[^\x00-\x7F]/.test(title)) {
          title = "Nonton Cars 🚗 — Pixar marathon, siap popcorn!";
        } else if (/^nonton up$/i.test(title.trim()) && !/[^\x00-\x7F]/.test(title)) {
          title = "Nonton Up 🎈 — Petualangan Rumah Terbang!";
        }
        const { addToMacReminders } = await import("./calendar");
        const res = await addToMacReminders(title, new Date(dueMs), notes);
        return `Added "${title}" to Mac Reminders (due ${new Date(dueMs).toLocaleString("id-ID")}) — ${res}`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "cannot add Mac reminder"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "reminders_mac_list",
        description: "List reminders from the Mac's Reminders.app via AppleScript.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: async () => {
      try {
        const { listMacReminders } = await import("./calendar");
        return await listMacReminders();
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "cannot list Mac reminders"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "plan_create",
        description: "Create a planning board ONLY when user explicitly says 'buatin plan/bikin plan/buat rencana' for a new complex task. Do NOT call for 'coba cari/lanjut/next step' — use web_search or plan_update_step instead. Be imaginative in title/goal, not raw.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short plan title, e.g. 'Riset Kopi Arabika'" },
            goal: { type: "string", description: "What the plan should achieve" },
          },
          required: ["title", "goal"],
        },
      },
    },
    execute: (args, ctx) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { createPlan, planToText } = require("./planning") as typeof import("./planning");
        const p = createPlan(typeof args.title === "string" ? args.title : "", typeof args.goal === "string" ? args.goal : "", ctx.rawUser);
        return `Plan created ${p.id}:\n${planToText(p)}`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "cannot create plan"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "plan_add_step",
        description: "Add a step to an existing plan. Use to break down the plan into actionable steps.",
        parameters: {
          type: "object",
          properties: {
            plan_id: { type: "string", description: "Plan id from plan_create" },
            title: { type: "string", description: "Step title" },
          },
          required: ["plan_id", "title"],
        },
      },
    },
    execute: (args, ctx) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { addPlanStep, readPlan, planToText } = require("./planning") as typeof import("./planning");
        const s = addPlanStep(typeof args.plan_id === "string" ? args.plan_id : "", typeof args.title === "string" ? args.title : "", ctx.rawUser);
        const p = readPlan(ctx.rawUser, typeof args.plan_id === "string" ? args.plan_id : "");
        return `Step added ${s.id}:\n${p ? planToText(p) : s.title}`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "cannot add step"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "plan_update_step",
        description:
          "Update a plan step status (pending/in_progress/completed/cancelled). Pass plan_id+step_id, OR plan_match (plan title/goal text) + step_match (step title text) or step_id as a 1-based number — no need to list first.",
        parameters: {
          type: "object",
          properties: {
            plan_id: { type: "string", description: "Plan id" },
            plan_match: { type: "string", description: "Plan title/goal substring (alternative to plan_id)" },
            step_id: { type: "string", description: "Step id, or a 1-based step number" },
            step_match: { type: "string", description: "Step title substring (alternative to step_id)" },
            status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"], description: "New status" },
            notes: { type: "string", description: "Optional notes" },
          },
          required: ["status"],
        },
      },
    },
    execute: (args, ctx) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { updatePlanStep, planToText } = require("./planning") as typeof import("./planning");
        const s = updatePlanStep({
          planId: typeof args.plan_id === "string" ? args.plan_id : undefined,
          planMatch: typeof args.plan_match === "string" ? args.plan_match : undefined,
          stepId: typeof args.step_id === "string" ? args.step_id : undefined,
          stepMatch: typeof args.step_match === "string" ? args.step_match : undefined,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          status: typeof args.status === "string" ? (args.status as any) : "pending",
          notes: typeof args.notes === "string" ? args.notes : undefined,
          rawUser: ctx.rawUser,
        });
        return `Step ${s.step.id} → ${s.step.status}\n${planToText(s.plan)}`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "cannot update step"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "plan_list",
        description: "List all planning boards for the user.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: (_args, ctx) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { listPlansText } = require("./planning") as typeof import("./planning");
        return listPlansText(ctx.rawUser);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "cannot list plans"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "plan_get",
        description: "Get a single plan with all its steps by id.",
        parameters: { type: "object", properties: { plan_id: { type: "string", description: "Plan id" } }, required: ["plan_id"] },
      },
    },
    execute: (args, ctx) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { readPlan, planToText } = require("./planning") as typeof import("./planning");
        const p = readPlan(ctx.rawUser, typeof args.plan_id === "string" ? args.plan_id : "");
        return p ? planToText(p) : "Error: plan not found";
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "cannot get plan"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "skill_list",
        description: "List all skills in Mia's marketplace (apps/web/skills/*/SKILL.md).",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { searchSkillsText } = require("./skills") as typeof import("./skills");
        return searchSkillsText("");
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "cannot list skills"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "skill_search",
        description: "Search skills in the marketplace by keyword.",
        parameters: { type: "object", properties: { query: { type: "string", description: "Search keyword" } }, required: ["query"] },
      },
    },
    execute: (args) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { searchSkillsText } = require("./skills") as typeof import("./skills");
        return searchSkillsText(typeof args.query === "string" ? args.query : "");
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : "cannot search skills"}`;
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
        // Mood entries must come from the USER. The model used to log its own
        // apology phrasing as the user's mood ("maap ya kalo sering bikin kamu
        // marah" -> angry), which then drove the next morning's "kemarin agak
        // berat" briefing. Verify against the user's own last message.
        if (ctx.lastUserText !== undefined && !detectMoodIntent(ctx.lastUserText)) {
          return 'Mood TIDAK dicatat: pesan terakhir user tidak memuat ungkapan perasaannya sendiri. Hanya catat mood kalau user benar-benar menyebutnya (mis. "aku lagi stres").';
        }
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
      risk: "read",
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
      risk: "read",
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
      risk: "read",
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
      risk: "read",
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
      risk: "read",
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
      risk: "write",
      function: {
        name: "spotify_sleep_timer",
        description:
          "Sleep timer Spotify: after_track=true = matikan playback setelah lagu ini selesai; minutes=N = matikan N menit lagi; cancel=true = batalkan. Pakai ini (BUKAN remind_me) untuk 'stop lagunya kalau udah habis' / 'matiin spotify kalau ketiduran'. Tanpa argumen = status timer.",
        parameters: {
          type: "object",
          properties: {
            after_track: { type: "boolean", description: "matikan setelah lagu ini selesai" },
            minutes: { type: "number", description: "matikan setelah N menit (maks 360)" },
            cancel: { type: "boolean", description: "batalkan sleep timer" },
          },
          required: [],
        },
      },
    },
    execute: async (args, ctx) => {
      try {
        const { spotifySleepTimer, spotifySleepTimerStatus } = await import("./spotify");
        const hasArgs = args.after_track === true || typeof args.minutes === "number" || args.cancel === true;
        if (!hasArgs) return spotifySleepTimerStatus(ctx.rawUser);
        return await spotifySleepTimer(ctx.rawUser, {
          after_track: args.after_track === true,
          minutes: asNumber(args.minutes),
          cancel: args.cancel === true,
        });
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
        name: "spotify_queue",
        description:
          "Tambahkan lagu ke antrean Spotify (diputar SETELAH lagu yang sekarang) — mis. 'tambahin ke antrean', 'putar ini berikutnya'. Jalankan langsung tanpa konfirmasi.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Judul + artis lagu, mis. 'Perfect Ed Sheeran'. Boleh 'lagu favoritku' (diambil dari persona)." },
          },
          required: ["query"],
        },
      },
    },
    execute: async (args, ctx) => {
      try {
        const { spotifyQueue } = await import("./spotify");
        return await spotifyQueue(ctx.rawUser, asBodyString(args.query));
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
        name: "spotify_mode",
        description:
          "Atur shuffle/repeat Spotify: shuffle=true/false, repeat='track'|'context'|'off'. Tanpa argumen = laporkan status sekarang. Mis. 'shuffle dong', 'ulang lagu ini terus', 'matiin repeat'. Jalankan langsung tanpa konfirmasi.",
        parameters: {
          type: "object",
          properties: {
            shuffle: { type: "boolean", description: "true = nyalakan shuffle, false = matikan" },
            repeat: { type: "string", description: "'track' (ulang lagu ini), 'context' (ulang album/playlist), 'off' (matikan)" },
          },
          required: [],
        },
      },
    },
    execute: async (args, ctx) => {
      try {
        const { spotifyMode } = await import("./spotify");
        return await spotifyMode(ctx.rawUser, { shuffle: args.shuffle, repeat: args.repeat });
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
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "waze_route",
        description:
          "Cek traffic real-time via Waze Direct (gratis, tanpa API key). Beri durasi + jarak dengan traffic untuk alamat atau koordinat. Fallback OSRM bila Waze rate-limit. Pakai saat user tanya 'ke BSD macet ga', 'berapa menit ke PIK', 'rute tercepat'.",
        parameters: {
          type: "object",
          properties: {
            from: {
              type: "string",
              description: "Alamat asal atau 'lat,lon', mis. 'Monas, Jakarta' atau '-6.1754,106.8272'",
            },
            to: {
              type: "string",
              description: "Alamat tujuan atau 'lat,lon', mis. 'BSD City, Tangerang'",
            },
          },
          required: ["from", "to"],
        },
      },
    },
    execute: async (args, ctx) => {
      const from = typeof args.from === "string" ? args.from : "";
      const to = typeof args.to === "string" ? args.to : "";
      if (!from || !to) return "Error: from dan to wajib diisi";
      try {
        const { getWazeRoute } = await import("./waze");
        const r = await getWazeRoute(from, to, ctx.rawUser);
        const routesTxt = r.routes.map((x, i) => `${i === 0 ? "★" : " "} ${x.duration_min} menit (${x.distance_km} km) via ${x.name}`).join("\n");
        return `${r.human}\n\n${routesTxt}\n\nJSON:\n${JSON.stringify({ from: r.from, to: r.to, routes: r.routes, fastest: r.fastest }, null, 2)}`;
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "learnings_search",
        description:
          "Cari learnings/errors/feature requests di .learnings/ (self-improving). Pakai saat user tanya 'apa learning terbaru', 'ada error apa', 'fitur apa yang diminta'.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Kata kunci, mis. 'waze', 'correction', 'error'" },
            limit: { type: "number", description: "Maks entri (default 10)" },
          },
          required: [],
        },
      },
    },
    execute: (args) => {
      const q = typeof args.query === "string" && args.query ? args.query : "";
      const lim = typeof args.limit === "number" ? args.limit : 10;
      if (q) return searchLearnings(q, lim);
      return listLearnings(lim, "pending");
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "learnings_review",
        description: "Review ringkas .learnings/ — hitung pending/resolved per file + kandidat promote (Recurrence>=3).",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: () => reviewLearnings(),
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "weather",
        description:
          "Cek cuaca real-time (gratis wttr.in + Open-Meteo, no key). Pakai saat user tanya 'BSD hujan ga', 'besok perlu payung ga', 'cuaca Jakarta'. Beri suhu, deskripsi, humidity, wind.",
        parameters: {
          type: "object",
          properties: {
            location: { type: "string", description: "Lokasi atau 'lat,lon', mis. 'BSD City', 'Jakarta', '-6.30,106.64'" },
          },
          required: ["location"],
        },
      },
    },
    execute: async (args, ctx) => {
      const loc = typeof args.location === "string" ? args.location : "";
      if (!loc) return "Error: location wajib diisi";
      try {
        const { getWeather } = await import("./weather");
        const r = await getWeather(loc, ctx.rawUser);
        return `${r.human}\n\nJSON:\n${JSON.stringify({ location: r.location, temp_c: r.temp_c, desc: r.desc, humidity: r.humidity, wind_kmh: r.wind_kmh, time: r.time, source: r.source }, null, 2)}`;
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "hotel_search",
        description:
          "Cari harga hotel live via Booking.com (Playwright, no key). WAJIB untuk semua pertanyaan hotel/lodging — jangan jawab dari memori. Beri nama + harga/malam + rating + link. Opsi: checkin/checkout (YYYY-MM-DD), adults/rooms, sort (price|rating|popularity), minRating, stars.",
        parameters: {
          type: "object",
          properties: {
            location: { type: "string", description: "Kota/daerah, mis. 'Bandung', 'Jakarta'" },
            budget: { type: "string", description: "Budget per malam, mis. '400rb', '600rb', '1jt' atau '600000' — opsional" },
            checkin: { type: "string", description: "Tanggal check-in YYYY-MM-DD (default hari ini)" },
            checkout: { type: "string", description: "Tanggal check-out YYYY-MM-DD (default besok)" },
            adults: { type: "number", description: "Jumlah tamu dewasa (default 1)" },
            rooms: { type: "number", description: "Jumlah kamar (default 1)" },
            sort: { type: "string", enum: ["price", "rating", "popularity"], description: "Urutan hasil (default price)" },
            minRating: { type: "number", description: "Skor ulasan minimum, mis. 8" },
            stars: { type: "number", description: "Minimum bintang hotel 1-5" },
          },
          required: ["location"],
        },
      },
    },
    execute: async (args) => {
      const loc = typeof args.location === "string" ? args.location : "";
      const bud =
        typeof args.budget === "string" ? args.budget : typeof args.budget === "number" ? String(args.budget) : undefined;
      if (!loc) return "Error: location wajib diisi";
      try {
        const { getHotels } = await import("./hotel");
        const r = await getHotels(loc, bud, {
          checkin: typeof args.checkin === "string" ? args.checkin : undefined,
          checkout: typeof args.checkout === "string" ? args.checkout : undefined,
          adults: asNumber(args.adults),
          rooms: asNumber(args.rooms),
          sort: args.sort === "price" || args.sort === "rating" || args.sort === "popularity" ? args.sort : undefined,
          minRating: asNumber(args.minRating),
          stars: asNumber(args.stars),
        });
        // Return ONLY the formatted list — it is delivered verbatim (VERBATIM_LIST),
        // so the model can't collapse it into a paragraph or leak the JSON.
        return r.human;
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "cinema_showtimes",
        description:
          "Jadwal film + harga tiket bioskop live (Indonesia, sumber jadwalnonton.com). WAJIB dipakai untuk pertanyaan 'film apa yang tayang / jam berapa / harga tiket di bioskop X / kota Y' — JANGAN jawab dari memori. Isi `city` dulu; `cinema` (nama bioskop), `film` (judul), atau `genre` (mis. horror) opsional. Tanpa cinema/film → daftar film tayang di kota itu.",
        parameters: {
          type: "object",
          properties: {
            city: { type: "string", description: "Kota, mis. 'Tangerang', 'Tangsel', 'Jakarta', 'Bandung'" },
            cinema: { type: "string", description: "Nama/kata kunci bioskop, mis. 'Bintaro Xchange', 'CGV Paradise Walk'" },
            film: { type: "string", description: "Judul film (kata kunci), mis. 'Munafik'" },
            genre: { type: "string", description: "Filter genre saat tak ada cinema/film, mis. 'horror'" },
          },
          required: ["city"],
        },
      },
    },
    execute: async (args) => {
      try {
        const { cinemaShowtimes } = await import("./cinema");
        return await cinemaShowtimes({
          city: typeof args.city === "string" ? args.city : "",
          cinema: typeof args.cinema === "string" ? args.cinema : undefined,
          film: typeof args.film === "string" ? args.film : undefined,
          genre: typeof args.genre === "string" ? args.genre : undefined,
        });
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "cannot fetch showtimes"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "train_search",
        description:
          "Jadwal + tarif kereta api antarkota (keyless, sumber Traveloka). WAJIB untuk 'jadwal kereta X ke Y', 'kereta ke Bandung jam berapa / berapa harganya'. JANGAN jawab dari memori. Isi from + to (nama kota).",
        parameters: {
          type: "object",
          properties: {
            from: { type: "string", description: "Kota asal, mis. 'Jakarta'" },
            to: { type: "string", description: "Kota tujuan, mis. 'Bandung'" },
          },
          required: ["from", "to"],
        },
      },
    },
    execute: async (args) => {
      try {
        const { trainSearch } = await import("./transport");
        return (await trainSearch(String(args.from || ""), String(args.to || ""))).human;
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "cannot fetch trains"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "bus_search",
        description:
          "Daftar operator bus/travel antarkota + kisaran harga & jam (keyless, sumber busonlineticket). WAJIB untuk 'bus ke Bandung', 'travel Jakarta-Bandung'. JANGAN jawab dari memori. Isi from + to.",
        parameters: {
          type: "object",
          properties: {
            from: { type: "string", description: "Kota asal, mis. 'Jakarta'" },
            to: { type: "string", description: "Kota tujuan, mis. 'Bandung'" },
          },
          required: ["from", "to"],
        },
      },
    },
    execute: async (args) => {
      try {
        const { busSearch } = await import("./transport");
        return (await busSearch(String(args.from || ""), String(args.to || ""))).human;
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "cannot fetch buses"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "transcribe",
        description:
          "Transkripsi audio → teks pakai Whisper LOKAL (offline, tanpa API key). Pakai untuk voice note / file audio: `upload` (nama atau nomor dari list_uploads) atau `path` (file audio di workspace). Opsional: model (tiny/base/small/medium/turbo; default small), language (mis. 'id'), task ('translate' = terjemah ke Inggris).",
        parameters: {
          type: "object",
          properties: {
            upload: { type: "string", description: "Nama/nomor file audio hasil upload (lihat list_uploads)" },
            path: { type: "string", description: "Path file audio di workspace (alternatif upload)" },
            model: { type: "string", description: "tiny|base|small|medium|turbo (default small)" },
            language: { type: "string", description: "Kode bahasa, mis. 'id' / 'en' (opsional)" },
            task: { type: "string", enum: ["transcribe", "translate"], description: "translate = terjemahkan ke Inggris" },
          },
          required: [],
        },
      },
    },
    execute: async (args, ctx) => {
      try {
        const { transcribeAudio } = await import("./localStt");
        let abs: string;
        if (typeof args.upload === "string" && args.upload.trim()) {
          const { uploadPath } = await import("./uploads");
          abs = uploadPath(ctx.rawUser, args.upload);
        } else if (typeof args.path === "string" && args.path.trim()) {
          const resolved = resolveInSandbox(args.path);
          if (!resolved) return "Error: path audio di luar sandbox / tidak valid.";
          abs = resolved;
        } else {
          return "Error: beri `upload` (mis. '1' atau 'voice.m4a') atau `path` file audio.";
        }
        const r = await transcribeAudio(abs, {
          model: typeof args.model === "string" ? args.model : undefined,
          language: typeof args.language === "string" ? args.language : undefined,
          task: args.task === "translate" ? "translate" : args.task === "transcribe" ? "transcribe" : undefined,
        });
        return r.text
          ? `📝 Transkrip (${r.model}${r.language ? `, ${r.language}` : ""}):\n${r.text}`
          : "Audio-nya kosong / tak ada suara yang bisa ditranskrip.";
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "transcribe gagal"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "git_status",
        description: "Cek git status --short --branch (read, no key). Pakai saat user tanya 'status git dong'.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: async () => {
      const { execFile: ef } = await import("node:child_process");
      const { repoRoot } = await import("./users");
      return new Promise<string>((resolve) => {
        ef("git", ["status", "--short", "--branch"], { cwd: repoRoot(), timeout: 8000 }, (err, stdout, stderr) => {
          if (err) resolve(`Error: ${stderr || err.message}`);
          else resolve(stdout.trim() || "working tree clean");
        });
      });
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "git_commit",
        description:
          "Mia commit dong — git add -A + commit + push (write, perlu konfirmasi). Pakai saat user bilang 'Mia commit dong \"feat: X\"'.",
        parameters: {
          type: "object",
          properties: {
            message: { type: "string", description: "Pesan commit, mis. 'feat: tambah fitur X'" },
          },
          required: ["message"],
        },
      },
    },
    execute: async (args) => {
      const msg = typeof args.message === "string" ? args.message : "";
      if (!msg) return "Error: message wajib diisi";
      const { execFile: ef } = await import("node:child_process");
      const { repoRoot } = await import("./users");
      const cwd = repoRoot();
      const run = (cmd: string, a: string[]) =>
        new Promise<{ ok: boolean; out: string }>((res) =>
          ef(cmd, a, { cwd, timeout: 15000 }, (err, stdout, stderr) => {
            const out = (stdout + "\n" + stderr).trim();
            res({ ok: !err, out: out || (err ? err.message : "done") });
          })
        );
      const st = await run("git", ["status", "--porcelain"]);
      if (!st.out) return "working tree clean — nothing to commit";
      const add = await run("git", ["add", "-A"]);
      if (!add.ok) return `Error add: ${add.out}`;
      const diff = await run("git", ["diff", "--cached", "--quiet"]);
      // diff --quiet exits 1 if staged, 0 if empty — execFile err when 1, so check via git status
      const staged = await run("git", ["diff", "--cached", "--name-only"]);
      if (!staged.out) return "working tree clean — nothing staged";
      const cm = await run("git", ["commit", "-m", msg]);
      if (!cm.ok) return `Error commit: ${cm.out}`;
      const push = await run("git", ["push", "origin", "HEAD"]);
      const hash = await run("git", ["rev-parse", "--short", "HEAD"]);
      if (!push.ok) return `commit ${hash.out} done, push failed: ${push.out}`;
      return `push done — ${hash.out}\n${cm.out.split("\n")[0]}`;
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "safe_exec_list",
        description: "List pending SafeExec requests (CRITICAL/HIGH intercepted, need approval). Auto, read.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: async () => {
      const { listPending } = await import("./safeExec");
      const list = listPending();
      if (!list.length) return "No pending SafeExec requests — all clear.";
      return list.map((r) => `${r.id} | ${r.risk} | ${r.command} | ${r.reason} | ${r.createdAt}`).join("\n");
    },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "cua_doctor", description: "Cek cua-driver health (doctor) — platform, daemon, TCC. Read, auto.", parameters: { type: "object", properties: {}, required: [] } } },
    execute: () => cuaDoctor(),
  },
  {
    definition: { type: "function", risk: "read", function: { name: "cua_list_apps", description: "List running apps + windows (cua). Read, auto.", parameters: { type: "object", properties: {}, required: [] } } },
    execute: () => cuaListApps(),
  },
  {
    definition: { type: "function", risk: "write", function: { name: "cua_launch", description: "Launch native app via cua (macOS bundle_id, e.g. com.apple.finder). Write, confirm. For Finder Downloads use urls [\"~/Downloads\"].", parameters: { type: "object", properties: { bundle_id: { type: "string", description: "Bundle ID, mis. com.apple.TextEdit" }, urls: { type: "array", description: "Optional file/URL to open, mis. [\"~/Downloads\"]" } }, required: ["bundle_id"] } } },
    execute: (args) => cuaLaunch(typeof args.bundle_id === "string" ? args.bundle_id : "", Array.isArray(args.urls) ? (args.urls as string[]) : undefined),
  },
  {
    definition: { type: "function", risk: "read", function: { name: "cua_window_state", description: "Snapshot window AX tree + screenshot (WAJIB sebelum click). Read, auto. Need pid+window_id from launch/list.", parameters: { type: "object", properties: { pid: { type: "number" }, window_id: { type: "number" }, no_screenshot: { type: "boolean" } }, required: ["pid", "window_id"] } } },
    execute: (args) => cuaWindowState(Number(args.pid), Number(args.window_id), Boolean(args.no_screenshot)),
  },
  {
    definition: { type: "function", risk: "write", function: { name: "cua_click", description: "Click native app: by element_index (AX) atau x,y (pixel). WAJIB snapshot dulu. Write, confirm.", parameters: { type: "object", properties: { pid: { type: "number" }, window_id: { type: "number" }, element_index: { type: "number" }, x: { type: "number" }, y: { type: "number" } }, required: ["pid"] } } },
    execute: (args) => {
      const pid = Number(args.pid), wid = Number(args.window_id), ei = args.element_index !== undefined ? Number(args.element_index) : undefined;
      if (ei !== undefined) return cuaClick(pid, wid, ei);
      if (typeof args.x === "number" && typeof args.y === "number") return cuaClickXY(pid, Number(args.x), Number(args.y), wid || undefined);
      return Promise.resolve("Error: need element_index or x,y");
    },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "cua_type", description: "Type text ke native app (AX atau pixel x,y). WAJIB snapshot dulu. Write, confirm.", parameters: { type: "object", properties: { pid: { type: "number" }, window_id: { type: "number" }, text: { type: "string" }, element_index: { type: "number" }, x: { type: "number" }, y: { type: "number" } }, required: ["pid", "window_id", "text"] } } },
    execute: (args) => cuaType(Number(args.pid), Number(args.window_id), String(args.text || ""), args.element_index !== undefined ? Number(args.element_index) : undefined, args.x !== undefined ? Number(args.x) : undefined, args.y !== undefined ? Number(args.y) : undefined),
  },
  {
    definition: { type: "function", risk: "write", function: { name: "cua_start_session", description: "Start cua session (auto/window/desktop) — WAJIB sebelum browser typed. Write, confirm.", parameters: { type: "object", properties: { session: { type: "string" }, capture_scope: { type: "string", description: "auto|window|desktop" } }, required: ["session"] } } },
    execute: async (args) => {
      const { cuaStartSession } = await import("./cua");
      return cuaStartSession(String(args.session || "default"), (args.capture_scope as "auto" | "window" | "desktop") || "auto");
    },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "cua_browser_state", description: "Browser typed: get_browser_state (bind pid/window_id+session atau target/tab+session). Read, auto.", parameters: { type: "object", properties: { pid: { type: "number" }, window_id: { type: "number" }, session: { type: "string" }, target_id: { type: "string" }, tab_id: { type: "string" } }, required: [] } } },
    execute: async (args) => {
      const { cuaGetBrowserState } = await import("./cua");
      return cuaGetBrowserState(args as Record<string, unknown>);
    },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "cua_browser_click", description: "Browser typed click by ref (trusted/dom_event). Write, confirm. Need target_id/tab_id/ref+session.", parameters: { type: "object", properties: { target_id: { type: "string" }, tab_id: { type: "string" }, ref: { type: "string" }, session: { type: "string" } }, required: ["target_id", "tab_id", "ref", "session"] } } },
    execute: async (args) => {
      const { cuaBrowserClick } = await import("./cua");
      return cuaBrowserClick(args as Record<string, unknown>);
    },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "cua_browser_type", description: "Browser typed type by ref. Write, confirm.", parameters: { type: "object", properties: { target_id: { type: "string" }, tab_id: { type: "string" }, ref: { type: "string" }, text: { type: "string" }, session: { type: "string" } }, required: ["target_id", "tab_id", "ref", "text", "session"] } } },
    execute: async (args) => {
      const { cuaBrowserType } = await import("./cua");
      return cuaBrowserType(args as Record<string, unknown>);
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "cua_keys",
        description:
          "Keyboard native (whichever app is targeted): action='hotkey' (keys: array mis. ['cmd','c'] untuk copy, ['cmd','shift','4'] screenshot), action='press' (key tunggal: return/tab/escape/up/down/left/right/space/delete/home/end/pageup/pagedown/f1-f12/huruf/angka; opsional modifiers), atau action='type' (text; WAJIB snapshot cua_window_state dulu; untuk mengetik ke field pakai delivery_mode='foreground' — background sering gagal bila field belum fokus). Write, confirm.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["hotkey", "press", "type"], description: "Aksi keyboard" },
            keys: { type: "array", description: "Untuk hotkey, mis. ['cmd','c']" },
            key: { type: "string", description: "Untuk press, mis. 'return'/'tab'/'up'" },
            modifiers: { type: "array", description: "Modifier opsional untuk press, mis. ['cmd','shift']" },
            text: { type: "string", description: "Untuk type" },
            pid: { type: "number", description: "PID app target (opsional)" },
            window_id: { type: "number", description: "Window id target (opsional)" },
            delivery_mode: { type: "string", enum: ["background", "foreground"], description: "foreground untuk shortcut menu non-Chromium" },
          },
          required: ["action"],
        },
      },
    },
    execute: async (args) => {
      try {
        const { cuaHotkey, cuaPressKey, cuaType } = await import("./cua");
        const opts = { pid: asNumber(args.pid), windowId: asNumber(args.window_id), deliveryMode: args.delivery_mode === "foreground" ? ("foreground" as const) : args.delivery_mode === "background" ? ("background" as const) : undefined };
        const action = String(args.action || "");
        if (action === "hotkey") {
          const keys = Array.isArray(args.keys) ? args.keys.map(String) : [];
          if (!keys.length) return "Error: `keys` wajib untuk hotkey (mis. ['cmd','c']).";
          return cuaHotkey(keys, opts);
        }
        if (action === "press") {
          const key = String(args.key || "");
          if (!key) return "Error: `key` wajib untuk press.";
          const modifiers = asStringArray(args.modifiers);
          return cuaPressKey(key, modifiers, opts);
        }
        if (action === "type") {
          if (!opts.pid || !opts.windowId) return "Error: `type` butuh pid + window_id (snapshot cua_window_state dulu).";
          return cuaType(opts.pid, opts.windowId, String(args.text || ""), undefined, undefined, undefined, opts.deliveryMode);
        }
        return "Error: action harus 'hotkey' | 'press' | 'type'.";
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "cua_keys failed"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "cua_mouse",
        description:
          "Mouse native: action='scroll' (direction up/down/left/right, amount 1-50, by line/page), 'right_click' (x,y atau element_index+window_id+pid), 'double_click' (x,y), 'drag' (from_x,from_y,to_x,to_y dalam pixel window; duration_ms opsional). Koordinat dari cua_window_state. Write, confirm.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["scroll", "right_click", "double_click", "drag"], description: "Aksi mouse" },
            direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Untuk scroll" },
            amount: { type: "number", description: "Untuk scroll (1-50, default 3)" },
            by: { type: "string", enum: ["line", "page"], description: "Granularitas scroll" },
            pid: { type: "number" },
            window_id: { type: "number" },
            element_index: { type: "number", description: "Untuk right_click AX (butuh window_id+pid)" },
            x: { type: "number" },
            y: { type: "number" },
            from_x: { type: "number" },
            from_y: { type: "number" },
            to_x: { type: "number" },
            to_y: { type: "number" },
            duration_ms: { type: "number", description: "Durasi drag (default 500)" },
          },
          required: ["action"],
        },
      },
    },
    execute: async (args) => {
      try {
        const { cuaScroll, cuaRightClick, cuaDoubleClick, cuaDrag } = await import("./cua");
        const action = String(args.action || "");
        if (action === "scroll") {
          const dir = args.direction;
          if (dir !== "up" && dir !== "down" && dir !== "left" && dir !== "right") return "Error: `direction` wajib untuk scroll (up/down/left/right).";
          return cuaScroll({ pid: asNumber(args.pid), windowId: asNumber(args.window_id), direction: dir, amount: asNumber(args.amount), by: args.by === "page" ? "page" : args.by === "line" ? "line" : undefined });
        }
        if (action === "right_click") {
          if (typeof args.pid !== "number") return "Error: right_click butuh pid (atau element_index).";
          return cuaRightClick({ pid: args.pid, windowId: asNumber(args.window_id), elementIndex: asNumber(args.element_index), x: asNumber(args.x), y: asNumber(args.y) });
        }
        if (action === "double_click") {
          return cuaDoubleClick({ pid: asNumber(args.pid), windowId: asNumber(args.window_id), elementIndex: asNumber(args.element_index), x: asNumber(args.x), y: asNumber(args.y) });
        }
        if (action === "drag") {
          if ([args.from_x, args.from_y, args.to_x, args.to_y].some((v) => typeof v !== "number")) return "Error: drag butuh from_x,from_y,to_x,to_y.";
          return cuaDrag({ fromX: args.from_x as number, fromY: args.from_y as number, toX: args.to_x as number, toY: args.to_y as number, pid: asNumber(args.pid), windowId: asNumber(args.window_id), durationMs: asNumber(args.duration_ms) });
        }
        return "Error: action harus 'scroll' | 'right_click' | 'double_click' | 'drag'.";
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "cua_mouse failed"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "cua_pointer",
        description: "Info pointer/layar: action='position' (posisi kursor) atau 'screen_size' (resolusi). Read, auto.",
        parameters: { type: "object", properties: { action: { type: "string", enum: ["position", "screen_size"] } }, required: ["action"] },
      },
    },
    execute: async (args) => {
      try {
        const { cuaCursorPosition, cuaScreenSize } = await import("./cua");
        return String(args.action) === "screen_size" ? await cuaScreenSize() : await cuaCursorPosition();
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "cua_pointer failed"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "clipboard_get",
        description: "Baca isi clipboard (teks). Read, auto. Pakai saat user minta 'paste'/'baca clipboard'.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: async () => {
      try {
        const { clipboardReadText } = await import("./cua");
        return await clipboardReadText();
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "clipboard_get failed"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "clipboard_set",
        description: "Tulis teks ke clipboard. Write, confirm. Pakai sebelum paste (mis. isi form).",
        parameters: { type: "object", properties: { text: { type: "string", description: "Teks untuk clipboard" } }, required: ["text"] },
      },
    },
    execute: async (args) => {
      try {
        const { clipboardWriteText } = await import("./cua");
        const text = typeof args.text === "string" ? args.text : "";
        if (!text) return "Error: `text` wajib.";
        return await clipboardWriteText(text);
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "clipboard_set failed"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "cua_desktop",
        description: "Snapshot ringan desktop: daftar app berjalan + window di layar (bounds, z-order, pid). Cepat, tanpa grant. Read, auto. Pakai untuk tahu 'apa yang lagi kebuka'.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: async () => {
      try {
        const { cuaAccessibilityTree } = await import("./cua");
        return await cuaAccessibilityTree();
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "cua_desktop failed"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "cua_screen",
        description: "Screenshot: action='desktop' (layar penuh → simpan PNG, balik path) atau action='zoom' (potong region window: window_id + x1,y1,x2,y2 dalam pixel screenshot, pid opsional; balik JPEG). Read, auto.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["desktop", "zoom"] },
            window_id: { type: "number" },
            x1: { type: "number" },
            y1: { type: "number" },
            x2: { type: "number" },
            y2: { type: "number" },
            pid: { type: "number" },
          },
          required: ["action"],
        },
      },
    },
    execute: async (args) => {
      try {
        const { cuaDesktopState, cuaZoom } = await import("./cua");
        if (String(args.action) === "desktop") {
          const { appRoot } = await import("./users");
          const { mkdirSync } = await import("node:fs");
          const { join } = await import("node:path");
          const dir = join(appRoot(), ".data", "cua");
          mkdirSync(dir, { recursive: true });
          const out = join(dir, `desktop-${Date.now()}.png`);
          const r = await cuaDesktopState(out);
          return `${r}\n(saved: ${out})`;
        }
        if (String(args.action) === "zoom") {
          if (typeof args.window_id !== "number" || [args.x1, args.y1, args.x2, args.y2].some((v) => typeof v !== "number")) {
            return "Error: zoom butuh window_id + x1,y1,x2,y2 (pixel dari cua_window_state).";
          }
          return cuaZoom({ windowId: args.window_id, x1: args.x1 as number, y1: args.y1 as number, x2: args.x2 as number, y2: args.y2 as number, pid: asNumber(args.pid) });
        }
        return "Error: action harus 'desktop' | 'zoom'.";
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "cua_screen failed"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "security_scan",
        description:
          "Cek postur keamanan Mac sendiri (read-only, keyless): FileVault, Firewall, Gatekeeper, SIP, jumlah port TCP listening, sesi login + skor. Read, auto. Pakai untuk 'cek keamanan Mac-ku', 'amankah laptopku'.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: async () => {
      try {
        const { securityPosture } = await import("./security");
        return await securityPosture();
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "security_scan failed"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "secret_scan",
        description:
          "Pindai kode/direktori (di sandbox: repo atau ALLOWED_WORKSPACES) untuk rahasia yang bocor (AWS/GCP/Slack/OpenAI/GitHub token, private key, JWT, assignment secret). Hasil hanya file:line + jenis (nilai di-redact). Read, auto. Pakai untuk 'cek ada API key bocor ga'.",
        parameters: { type: "object", properties: { dir: { type: "string", description: "Direktori relatif repo (opsional; default repo root)" } }, required: [] },
      },
    },
    execute: async (args) => {
      try {
        const { scanForSecrets } = await import("./security");
        const { hits, scanned } = scanForSecrets(typeof args.dir === "string" ? args.dir : "");
        if (!hits.length) return `✅ Tidak ada rahasia terdeteksi (${scanned} file dipindai).`;
        const lines = hits.map((h) => `• ${h.file}:${h.line} — ${h.type}`);
        return `⚠️ ${hits.length} potensi rahasia bocor (${scanned} file dipindai):\n${lines.join("\n")}\n\n(Nilai di-redact. Pindahkan ke .env yang di-gitignore / secret manager, lalu rotate.)`;
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "secret_scan failed"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "tls_check",
        description: "Cek sertifikat TLS sebuah host milikmu/berizin (issuer, masa berlaku, verifikasi chain) via node:tls. Keyless, read, auto. Pakai untuk 'cek sertifikat domainku'.",
        parameters: { type: "object", properties: { host: { type: "string", description: "Domain, mis. example.com" }, port: { type: "number", description: "Port (default 443)" } }, required: ["host"] },
      },
    },
    execute: async (args) => {
      try {
        const { tlsCheck } = await import("./security");
        return await tlsCheck(String(args.host || ""), typeof args.port === "number" ? args.port : 443);
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "tls_check failed"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "breach_check",
        description:
          "Cek apakah sebuah PASSWORD pernah bocor di kebocoran data (HaveIBeenPwned Pwned Passwords, k-anonymity — hanya 5 huruf pertama hash yang dikirim, password asli tidak keluar). Keyless, read, auto. PENTING: jangan kirim password penting; teks obrolan bisa tersimpan di log.",
        parameters: { type: "object", properties: { password: { type: "string", description: "Password yang mau dicek (sebaiknya password uji, bukan password utama)" } }, required: ["password"] },
      },
    },
    execute: async (args) => {
      try {
        const { breachCheck } = await import("./security");
        const { count } = await breachCheck(typeof args.password === "string" ? args.password : "");
        return count > 0
          ? `⚠️ Password ini muncul di ${count.toLocaleString("id-ID")} kebocoran data — JANGAN dipakai. Ganti ke password unik + password manager.`
          : `✅ Password ini tidak ditemukan di database kebocoran Pwned Passwords. (Tetap pakai yang unik & panjang.)`;
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "breach_check failed"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "pentest_resources",
        description:
          "Daftar platform latihan ethical hacking + URL lab lokal (Juice Shop/DVWA/WebGoat via labs/pentest/docker-compose.yml). Read, auto. Pakai saat user tanya 'di mana bisa latihan pentest', 'platform CTF', 'lab buat latihan'.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: async () => {
      try {
        const { pentestResources } = await import("./security");
        return pentestResources();
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "pentest_resources failed"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "pentest_scan",
        description:
          "Jalankan tool pentest (nmap/nuclei/nikto/ffuf/whatweb/gobuster) ke target. HANYA localhost/lab/RFC1918 atau host di PENTEST_LAB_TARGETS — target publik DITOLAK. Write, confirm. ffuf otomatis pakai wordlist bawaan (labs/pentest/wordlists/common.txt) bila `wordlist` tak diisi.",
        parameters: {
          type: "object",
          properties: {
            tool: { type: "string", enum: ["nmap", "nuclei", "nikto", "ffuf", "whatweb", "gobuster"], description: "Tool yang dijalankan" },
            target: { type: "string", description: "Target, mis. http://localhost:3001 atau 127.0.0.1" },
            wordlist: { type: "string", description: "Untuk ffuf: path wordlist (di sandbox)" },
          },
          required: ["tool", "target"],
        },
      },
    },
    execute: async (args) => {
      try {
        const { pentestScan } = await import("./security");
        return await pentestScan({ tool: String(args.tool || ""), target: String(args.target || ""), wordlist: typeof args.wordlist === "string" ? args.wordlist : undefined });
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "pentest_scan failed"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "nuclei_custom",
        description:
          "Nuclei custom — jalankan nuclei dengan filter severity/tags atau template custom (file/dir .yaml di sandbox). HANYA localhost/lab/RFC1918 atau host di engagement aktif/PENTEST_LAB_TARGETS (scope-gated). Write, confirm. Tanpa templates → auto-scan (-as); dengan templates → -t path. Severity default critical,high,medium.",
        parameters: {
          type: "object",
          properties: {
            target: { type: "string", description: "Target http(s) atau host:port, mis. http://localhost:4010 atau https://app.example.com" },
            severity: { type: "string", description: "Filter severity, mis. \"critical,high\" (critical/high/medium/low/info/unknown)" },
            tags: { type: "string", description: "Filter tags, mis. \"xss,sqli,cve\" (opsional)" },
            templates: { type: "string", description: "Path sandbox ke file .yaml/.yml atau direktori template custom (opsional)" },
          },
          required: ["target"],
        },
      },
    },
    execute: async (args) => {
      try {
        const { nucleiCustom } = await import("./nuclei");
        return await nucleiCustom({
          target: String(args.target || ""),
          severity: typeof args.severity === "string" ? args.severity : undefined,
          tags: typeof args.tags === "string" ? args.tags : undefined,
          templates: typeof args.templates === "string" ? args.templates : undefined,
        });
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "nuclei_custom failed"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "finding_add",
        description: "Catat satu temuan pentest (Title/Severity/CVSS/OWASP/CWE/Evidence/Impact/Remediation). Bila `cvss` diisi, severity DITURUNKAN otomatis dari band CVSS (mis. 6.1→medium, 9.8→critical) — tak perlu menebak. Read, auto.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string" },
            severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"] },
            cvss: { type: "number", description: "Skor CVSS 0.0-10.0 (opsional; default per severity)" },
            owasp: { type: "string", description: "Kategori OWASP, mis. 'A03:2021 Injection'" },
            cwe: { type: "string", description: "CWE, mis. 'CWE-89'" },
            target: { type: "string" },
            evidence: { type: "string" },
            steps: { type: "string", description: "Langkah reproduksi (Steps to Reproduce)" },
            impact: { type: "string" },
            root_cause: { type: "string", description: "Akar masalah (Root Cause)" },
            remediation: { type: "string" },
            references: { type: "string", description: "Referensi (OWASP/CVE/URL)" },
            retest_url: { type: "string", description: "OPSIONAL: URL untuk regression retest — membuat case otomatis supaya 'sudah dipatch belum?' bisa dicek 1 perintah (retest_run)" },
            retest_method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] },
            retest_session: { type: "string", description: "nama http_session untuk request retest" },
            retest_expect: { type: "string", description: "substring pada respons VULNERABLE (signature temuan)" },
            retest_status: { type: "number", description: "status respons vulnerable (0 = abaikan)" },
          },
          required: ["title"],
        },
      },
    },
    execute: async (args, ctx) => {
      try {
        const { addFinding } = await import("./security");
        const f = addFinding(ctx.rawUser, {
          title: String(args.title || ""),
          severity: typeof args.severity === "string" ? args.severity : undefined,
          cvss: asNumber(args.cvss),
          owasp: typeof args.owasp === "string" ? args.owasp : undefined,
          cwe: typeof args.cwe === "string" ? args.cwe : undefined,
          target: typeof args.target === "string" ? args.target : undefined,
          evidence: typeof args.evidence === "string" ? args.evidence : undefined,
          steps: typeof args.steps === "string" ? args.steps : undefined,
          impact: typeof args.impact === "string" ? args.impact : undefined,
          rootCause: typeof args.root_cause === "string" ? args.root_cause : undefined,
          remediation: typeof args.remediation === "string" ? args.remediation : undefined,
          references: typeof args.references === "string" ? args.references : undefined,
        });
        // SUPERPOWER hooks (best-effort, never fail the finding):
        // 1) target brain — record the proven finding on the target.
        try {
          const { brainRecordProof } = await import("./targetBrain");
          const t = typeof args.target === "string" ? args.target : f.target;
          if (t) brainRecordProof(ctx.rawUser, t, { what: `${f.title}${t ? ` @ ${t}` : ""}`, how: (typeof args.evidence === "string" ? args.evidence : f.evidence || "finding_add").slice(0, 200), severity: f.severity, findingId: f.id });
        } catch { /* best-effort */ }
        // 2) regression retest — auto-create a case when retest_* args given.
        let retestNote = "";
        const retestUrl = typeof args.retest_url === "string" ? args.retest_url.trim() : "";
        if (retestUrl && /^https?:\/\//i.test(retestUrl)) {
          try {
            const { retestSave } = await import("./retest");
            const c = retestSave(ctx.rawUser, {
              title: f.title,
              url: retestUrl,
              method: typeof args.retest_method === "string" ? args.retest_method : undefined,
              session: typeof args.retest_session === "string" ? args.retest_session : undefined,
              expect_contains: typeof args.retest_expect === "string" ? args.retest_expect : undefined,
              expect_status: asNumber(args.retest_status),
              findingId: f.id,
              severity: f.severity,
            });
            retestNote = `\n♻️ Retest case otomatis: ${c.id} — jalankan retest_run id=${c.id} kapan pun untuk cek patch.`;
          } catch { /* best-effort */ }
        }
        // Proof-link warning (audit 2026-09-23): high/critical findings filed
        // with no poc/retest evidence get an honest flag — warn, don't block
        // (auto-history fallback + lab flows must keep working).
        const proofNote = proofWarning(f.severity, `${f.evidence}\n${f.steps}`, retestUrl);
        return `✅ Temuan dicatat: [${f.severity.toUpperCase()}${f.cvss != null ? ` CVSS ${f.cvss}` : ""}] ${f.title} (${f.id})${retestNote}${proofNote}`;
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "finding_add failed"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "finding_list",
        description: "Daftar temuan pentest yang tercatat (urut severity). Opsional `target` (host/URL) untuk membatasi ke target itu — pakai saat membahas satu lab/target. Read, auto.",
        parameters: { type: "object", properties: { target: { type: "string" } }, required: [] },
      },
    },
    execute: async (args, ctx) => {
      try {
        const { listFindingsText } = await import("./security");
        return listFindingsText(ctx.rawUser, { target: typeof args.target === "string" ? args.target : undefined });
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "finding_list failed"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "report_generate",
        description: "Susun laporan pentest markdown dari temuan. WAJIB sertakan `target` saat user menyebut satu lab/target — tanpa target, laporan mencampur SEMUA temuan. Read, auto.",
        parameters: { type: "object", properties: { target: { type: "string", description: "host atau URL target — WAJIB diisi" } }, required: ["target"] },
      },
    },
    execute: async (args, ctx) => {
      try {
        const { generateReport } = await import("./security");
        return generateReport(ctx.rawUser, { target: typeof args.target === "string" ? args.target : undefined });
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "report_generate failed"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "zap_scan",
        description:
          "OWASP ZAP baseline scan (web) via Docker ke target. HANYA localhost/lab/RFC1918/host berizin (publik DITOLAK). Butuh Docker — kalau Docker tak ada, pakai web_audit + security_hunt + pentest_scan tool=nuclei (padanan native). Write, confirm.",
        parameters: { type: "object", properties: { target: { type: "string", description: "URL target, mis. http://localhost:3001" }, minutes: { type: "number", description: "Batas menit (1-30, default 5)" } }, required: ["target"] },
      },
    },
    execute: async (args) => {
      try {
        const { zapScan } = await import("./security");
        return await zapScan(String(args.target || ""), typeof args.minutes === "number" ? args.minutes : 5);
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "zap_scan failed"}`;
      }
    },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "web_audit", description: "Audit pasif web (1x GET): header keamanan (HSTS/CSP/XFO/dll), flag cookie (Secure/HttpOnly/SameSite), server banner + skor. Read, auto. Pakai untuk 'cek keamanan web X'.", parameters: { type: "object", properties: { url: { type: "string", description: "URL http(s)" } }, required: ["url"] } } },
    execute: async (args) => { try { const { webAudit } = await import("./security"); return await webAudit(String(args.url || "")); } catch (e) { return `Error: ${e instanceof Error ? e.message : "web_audit failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "domain_audit", description: "Audit email/DNS domain (passive): SPF, DMARC, DKIM (selector umum), CAA, MX, NS. Read, auto. Untuk 'cek SPF/DMARC domainku'.", parameters: { type: "object", properties: { domain: { type: "string", description: "mis. example.com" } }, required: ["domain"] } } },
    execute: async (args) => { try { const { domainAudit } = await import("./security"); return await domainAudit(String(args.domain || "")); } catch (e) { return `Error: ${e instanceof Error ? e.message : "domain_audit failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "password_strength", description: "Analisis kekuatan password secara LOKAL (entropy, pola umum) — tanpa jaringan. Read, auto. Arg di-redact dari audit. Pakai password uji.", parameters: { type: "object", properties: { password: { type: "string" } }, required: ["password"] } } },
    execute: async (args) => { try { const { passwordStrength } = await import("./security"); return passwordStrength(String(args.password || "")); } catch (e) { return `Error: ${e instanceof Error ? e.message : "password_strength failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "hash_identify", description: "Identifikasi jenis hash + hitung SHA-256/SHA-1/MD5 (defensif, untuk verifikasi integritas/IOC). Read, auto.", parameters: { type: "object", properties: { input: { type: "string", description: "Hash atau teks" } }, required: ["input"] } } },
    execute: async (args) => { try { const { hashIdentify } = await import("./security"); return hashIdentify(String(args.input || "")); } catch (e) { return `Error: ${e instanceof Error ? e.message : "hash_identify failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "jwt_inspect", description: "Decode JWT (tanpa verifikasi): header/payload + flag alg=none/expired. Read, auto.", parameters: { type: "object", properties: { token: { type: "string" } }, required: ["token"] } } },
    execute: async (args) => { try { const { jwtInspect } = await import("./security"); return jwtInspect(String(args.token || "")); } catch (e) { return `Error: ${e instanceof Error ? e.message : "jwt_inspect failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "ioc_extract", description: "Ekstrak IOC (IP/domain/URL/email/hash) dari teks laporan/log — termasuk yang defanged (hxxp, [.]). Read, auto.", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } },
    execute: async (args) => { try { const { iocExtract } = await import("./security"); return iocExtract(String(args.text || "")); } catch (e) { return `Error: ${e instanceof Error ? e.message : "ioc_extract failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "report_save", description: "Simpan laporan pentest ke file markdown. WAJIB sertakan `target` saat user menyebut satu lab/target — tanpa target, laporan mencampur SEMUA temuan. Read, auto.", parameters: { type: "object", properties: { target: { type: "string", description: "host atau URL target — WAJIB diisi" } }, required: ["target"] } } },
    execute: async (args, ctx) => { try { const { reportSave } = await import("./security"); return reportSave(ctx.rawUser, { target: typeof args.target === "string" ? args.target : undefined }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "report_save failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "sqlmap_scan", description: "Uji SQL injection dengan sqlmap ke URL (butuh parameter, mis. ?id=1). HANYA localhost/lab/aset berizin (publik DITOLAK). Write, confirm.", parameters: { type: "object", properties: { url: { type: "string", description: "URL dengan parameter, mis. http://localhost:8081/vulnerabilities/sqli/?id=1&Submit=Submit" }, level: { type: "number", description: "1-5 (default 1)" }, risk: { type: "number", description: "1-3 (default 1)" } }, required: ["url"] } } },
    execute: async (args) => { try { const { sqlmapScan } = await import("./security"); return await sqlmapScan(String(args.url || ""), { level: asNumber(args.level), risk: asNumber(args.risk) }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "sqlmap_scan failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "report_pdf", description: "Buat PDF laporan pentest via Playwright → .data/users/<user>/reports/*.pdf. WAJIB sertakan `target` (host/URL) — tanpa target, laporan mencampur SEMUA temuan dari semua target. Read, auto.", parameters: { type: "object", properties: { target: { type: "string", description: "host atau URL target — WAJIB diisi" } }, required: ["target"] } } },
    execute: async (args, ctx) => { try { const { reportPdf } = await import("./security"); return await reportPdf(ctx.rawUser, { target: typeof args.target === "string" ? args.target : undefined }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "report_pdf failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "lab_status", description: "Status lab pentest lokal (vuln-node :4010 tanpa Docker; juice-shop/dvwa/webgoat bila Docker). Read, auto.", parameters: { type: "object", properties: {}, required: [] } } },
    execute: async () => { try { const { labStatus } = await import("./security"); return await labStatus(); } catch (e) { return `Error: ${e instanceof Error ? e.message : "lab_status failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "lab_start", description: "Nyalakan/matikan lab latihan lokal (default vuln-node :4010, tanpa Docker). Write, confirm.", parameters: { type: "object", properties: { action: { type: "string", enum: ["start", "stop"] }, name: { type: "string", description: "default vuln-node" } }, required: ["action"] } } },
    execute: async (args) => { try { const { labStart, labStop } = await import("./security"); const name = typeof args.name === "string" && args.name ? args.name : "vuln-node"; return String(args.action) === "stop" ? await labStop(name) : await labStart(name); } catch (e) { return `Error: ${e instanceof Error ? e.message : "lab_start failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "lab_fetch", description: "GET URL LAB/berizin (localhost/private/permitted) — menembus guard SSRF publik agar Mia bisa lihat respons target lokal (mis. verifikasi XSS ter-reflect). Publik ditolak. Read, auto.", parameters: { type: "object", properties: { url: { type: "string", description: "URL lab, mis. http://127.0.0.1:4010/greet?name=<script>alert(1)</script>" } }, required: ["url"] } } },
    execute: async (args) => { try { const { labFetch } = await import("./security"); return await labFetch(String(args.url || "")); } catch (e) { return `Error: ${e instanceof Error ? e.message : "lab_fetch failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "recon_subdomains", description: "Recon PASIF subdomain via Certificate Transparency (crt.sh, fallback hackertarget) — keyless, tanpa menyentuh target. Read, auto. Domain milik sendiri/klien. Pakai untuk 'cari subdomain domainku'.", parameters: { type: "object", properties: { domain: { type: "string", description: "mis. example.com" } }, required: ["domain"] } } },
    execute: async (args, ctx) => { try { const { reconSubdomains } = await import("./recon"); return await reconSubdomains(ctx.rawUser, String(args.domain || "")); } catch (e) { return `Error: ${e instanceof Error ? e.message : "recon_subdomains failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "recon_httpx", description: "Probe AKTIF host hidup (HTTP/HTTPS) untuk subdomain hasil recon_subdomains (atau `hosts`). HANYA lab/engagement/PENTEST_LAB_TARGETS (publik DITOLAK). Write, confirm.", parameters: { type: "object", properties: { domain: { type: "string" }, hosts: { type: "array", description: "Host spesifik (opsional; default subdomain tercache)" } }, required: ["domain"] } } },
    execute: async (args, ctx) => { try { const { reconHttpx } = await import("./recon"); const hosts = asStringArray(args.hosts); return await reconHttpx(ctx.rawUser, String(args.domain || ""), hosts); } catch (e) { return `Error: ${e instanceof Error ? e.message : "recon_httpx failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "recon_params", description: "Recon PASIF URL + query-parameter dari arsip publik (OTX + urlscan + Wayback) — keyless. Menandai param menarik (id/redirect/url/file/dst) untuk uji manual IDOR/SSRF/LFI. Read, auto.", parameters: { type: "object", properties: { domain: { type: "string" } }, required: ["domain"] } } },
    execute: async (args, ctx) => { try { const { reconParams } = await import("./recon"); return await reconParams(ctx.rawUser, String(args.domain || "")); } catch (e) { return `Error: ${e instanceof Error ? e.message : "recon_params failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "recon_list", description: "Ringkasan cache recon per-user (subdomain/host hidup/param per domain). Read, auto.", parameters: { type: "object", properties: {}, required: [] } } },
    execute: async (_args, ctx) => { try { const { reconList } = await import("./recon"); return reconList(ctx.rawUser); } catch (e) { return `Error: ${e instanceof Error ? e.message : "recon_list failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "recon_takeover", description: "Cek PASIF kandidat subdomain takeover: resolve CNAME subdomain (dari cache recon) lalu cocokkan ke layanan rentan (GitHub Pages/Heroku/S3/Azure/Netlify/Vercel/...). DNS-only, read, auto. Domain sendiri/klien.", parameters: { type: "object", properties: { domain: { type: "string" } }, required: ["domain"] } } },
    execute: async (args, ctx) => { try { const { reconTakeover } = await import("./recon"); return await reconTakeover(ctx.rawUser, String(args.domain || "")); } catch (e) { return `Error: ${e instanceof Error ? e.message : "recon_takeover failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "security_playbook", description: "Muat playbook keamanan (metodologi/kelas-vuln/teknologi) sesuai kebutuhan — counterevidence, severity-calibration, fix-verification, source-aware-sast, subdomain-takeover, oauth, graphql, llm-applications, dll. Tanpa argumen = katalog. Read, auto.", parameters: { type: "object", properties: { name: { type: "string", description: "nama playbook, mis. 'counterevidence'" }, query: { type: "string", description: "kata kunci bila nama tak diketahui" } }, required: [] } } },
    execute: async (args) => { try { const { securityPlaybook } = await import("./securityPlaybook"); return securityPlaybook(typeof args.name === "string" ? args.name : undefined, typeof args.query === "string" ? args.query : undefined); } catch (e) { return `Error: ${e instanceof Error ? e.message : "security_playbook failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "sast_scan", description: "SAST (semgrep: p/default + p/secrets) pada source di sandbox (repo/ALLOWED_WORKSPACES) — pola kerentanan + secret di kode. Read, auto. Install: brew install semgrep (butuh internet saat pertama untuk unduh rules).", parameters: { type: "object", properties: { dir: { type: "string", description: "Direktori relatif (opsional; default repo root)" } }, required: [] } } },
    execute: async (args) => { try { const { sastScan } = await import("./security"); return await sastScan(typeof args.dir === "string" ? args.dir : ""); } catch (e) { return `Error: ${e instanceof Error ? e.message : "sast_scan failed"}`; } },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "engagement_create",
        description:
          "Catat engagement pentest klien (otorisasi). Setelah dibuat & AKTIF, host di `scope` boleh diuji (pentest_scan/zap_scan/sqlmap_scan/lab_fetch) — di luar scope tetap ditolak. Write, confirm (ini yang memberi izin scan). WAJIB isi: name, client, authorization (no. PO/kontrak/email izin), scope[].",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Nama engagement, mis. 'QA Web App PT X'" },
            client: { type: "string", description: "Klien/owner" },
            authorization: { type: "string", description: "Referensi izin tertulis (no. PO/kontrak/email)" },
            scope: { type: "array", description: "Host/domain in-scope, mis. ['app.ptx.co.id','api.ptx.co.id']" },
            out_of_scope: { type: "array", description: "Host yang dikecualikan (opsional)" },
            window_start: { type: "string", description: "Mulai window uji ISO-8601 (opsional)" },
            window_end: { type: "string", description: "Akhir window uji ISO-8601 (opsional)" },
            contact: { type: "string", description: "Kontak darurat klien (opsional)" },
            notes: { type: "string", description: "Catatan RoE (opsional)" },
          },
          required: ["name", "client", "authorization", "scope"],
        },
      },
    },
    execute: async (args) => {
      try {
        const { createEngagement } = await import("./engagement");
        const arr = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
        const e = createEngagement({
          name: String(args.name || ""),
          client: String(args.client || ""),
          authorization: String(args.authorization || ""),
          scope: arr(args.scope),
          outOfScope: arr(args.out_of_scope),
          windowStart: typeof args.window_start === "string" ? args.window_start : undefined,
          windowEnd: typeof args.window_end === "string" ? args.window_end : undefined,
          contact: typeof args.contact === "string" ? args.contact : undefined,
          notes: typeof args.notes === "string" ? args.notes : undefined,
        });
        return `✅ Engagement dibuat: ${e.id} — ${e.name} (${e.client})\nScope: ${e.scope.join(", ")}\nIzin: ${e.authorization}\nStatus: ACTIVE — host di scope kini boleh diuji.`;
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "engagement_create failed"}`;
      }
    },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "engagement_list", description: "Daftar engagement pentest + scope/izin/status. Read, auto.", parameters: { type: "object", properties: {}, required: [] } } },
    execute: async () => { try { const { engagementsText } = await import("./engagement"); return engagementsText(); } catch (e) { return `Error: ${e instanceof Error ? e.message : "engagement_list failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "engagement_close", description: "Tutup engagement (status closed → host tak lagi boleh diuji). Read, auto.", parameters: { type: "object", properties: { id: { type: "string", description: "ID engagement, mis. ENG-..." } }, required: ["id"] } } },
    execute: async (args) => { try { const { closeEngagement } = await import("./engagement"); const id = String(args.id || ""); return closeEngagement(id) ? `🛑 Engagement ${id} ditutup.` : `Error: engagement ${id} tidak ditemukan.`; } catch (e) { return `Error: ${e instanceof Error ? e.message : "engagement_close failed"}`; } },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "dep_audit",
        description: "Audit kerentanan dependency (CVE) via OSV.dev (keyless): baca package-lock.json (npm) & requirements.txt (PyPI). Opsi `dir` (sandbox) & `to_findings` untuk menambah ke board temuan. Read, auto.",
        parameters: { type: "object", properties: { dir: { type: "string", description: "Direktori relatif repo (opsional; default repo root)" }, to_findings: { type: "boolean", description: "Tambahkan hasil ke findings" } }, required: [] },
      },
    },
    execute: async (args, ctx) => {
      try {
        const { depAudit } = await import("./security");
        return await depAudit(typeof args.dir === "string" ? args.dir : "", args.to_findings === true ? ctx.rawUser : undefined);
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "dep_audit failed"}`;
      }
    },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "hardening_plan", description: "Rencana perbaikan berprioritas (dari temuan, urut CVSS) + rekomendasi tiap temuan. Read, auto.", parameters: { type: "object", properties: {}, required: [] } } },
    execute: async (_args, ctx) => { try { const { hardeningPlan } = await import("./security"); return hardeningPlan(ctx.rawUser); } catch (e) { return `Error: ${e instanceof Error ? e.message : "hardening_plan failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "finding_resolve", description: "Tandai temuan selesai/resolved (hilang dari daftar terbuka & laporan). Write, confirm.", parameters: { type: "object", properties: { id: { type: "string", description: "ID temuan, mis. F-..." } }, required: ["id"] } } },
    execute: async (args, ctx) => { try { const { resolveFinding } = await import("./security"); const id = String(args.id || ""); return resolveFinding(ctx.rawUser, id) ? `✅ Temuan ${id} ditandai resolved.` : `Error: temuan ${id} tidak ditemukan.`; } catch (e) { return `Error: ${e instanceof Error ? e.message : "finding_resolve failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "finding_export", description: "Export temuan terbuka ke file: format csv | json | sarif (untuk tiket tim / CI). Read, auto.", parameters: { type: "object", properties: { format: { type: "string", enum: ["csv", "json", "sarif"] } }, required: [] } } },
    execute: async (args, ctx) => { try { const { exportFindings } = await import("./security"); return exportFindings(ctx.rawUser, typeof args.format === "string" ? args.format : "csv"); } catch (e) { return `Error: ${e instanceof Error ? e.message : "finding_export failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "cvss_score", description: "Hitung skor base CVSS dari vektor v3.1 atau v4.0 (v4.0 didukung penuh). Contoh: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' atau 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N'. Read, auto.", parameters: { type: "object", properties: { vector: { type: "string" } }, required: ["vector"] } } },
    execute: async (args) => { try { const { cvssScoreAny } = await import("./security"); return cvssScoreAny(String(args.vector || "")); } catch (e) { return `Error: ${e instanceof Error ? e.message : "cvss_score failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "verify_patch", description: "Cek temuan dependency (A06) vs versi terpasang di package-lock: mana yang sudah >= fixed. Opsi apply=true menandai yang patched sebagai resolved. Read, auto.", parameters: { type: "object", properties: { dir: { type: "string", description: "Direktori repo (opsional)" }, apply: { type: "boolean", description: "Auto-resolve yang sudah patched" } }, required: [] } } },
    execute: async (args, ctx) => { try { const { verifyPatch } = await import("./security"); return verifyPatch(ctx.rawUser, typeof args.dir === "string" ? args.dir : "", args.apply === true); } catch (e) { return `Error: ${e instanceof Error ? e.message : "verify_patch failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "hardening_pdf", description: "Buat PDF 'hardening plan' (rencana perbaikan prioritas CVSS) → .data/users/<user>/reports. Read, auto.", parameters: { type: "object", properties: {}, required: [] } } },
    execute: async (_args, ctx) => { try { const { hardeningPdf } = await import("./security"); return await hardeningPdf(ctx.rawUser); } catch (e) { return `Error: ${e instanceof Error ? e.message : "hardening_pdf failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "encoding", description: "Encode/decode teks: format base64|url|hex|html|rot13, action encode|decode. Read, auto.", parameters: { type: "object", properties: { action: { type: "string", enum: ["encode", "decode"] }, format: { type: "string", enum: ["base64", "url", "hex", "html", "rot13"] }, text: { type: "string" } }, required: ["action", "format", "text"] } } },
    execute: async (args) => { try { const { encoding } = await import("./security"); return encoding(String(args.action || ""), String(args.format || ""), String(args.text || "")); } catch (e) { return `Error: ${e instanceof Error ? e.message : "encoding failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "http_request", description: "Kirim HTTP request (method/headers/body) ke target LAB/berizin saja (uji API: REST/GraphQL/mass-assignment). Opsional `session`=nama sesi (cookie+header tersimpan), `save_session`=simpan Set-Cookie ke sesi itu. Publik ditolak. Write, confirm.", parameters: { type: "object", properties: { url: { type: "string" }, method: { type: "string", description: "GET/POST/PUT/PATCH/DELETE" }, headers: { type: "object", description: "Header tambahan" }, body: { type: "string", description: "Body: string JSON atau objek (otomatis di-stringify), mis. body=\"{\\\"query\\\":\\\"{__typename}\\\"}\"" }, session: { type: "string", description: "Nama sesi tersimpan (mis. 'A'/'B')" }, save_session: { type: "string", description: "Simpan cookie respons ke nama sesi ini" } }, required: ["url"] } } },
    execute: async (args, ctx) => { try { const { httpRequest } = await import("./security"); return await httpRequest({ url: String(args.url || ""), method: typeof args.method === "string" ? args.method : undefined, headers: (args.headers && typeof args.headers === "object") ? (args.headers as Record<string, string>) : undefined, body: asBodyString(args.body), session: typeof args.session === "string" ? args.session : undefined, saveSession: typeof args.save_session === "string" ? args.save_session : undefined }, ctx.rawUser); } catch (e) { return `Error: ${e instanceof Error ? e.message : "http_request failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "oast_create", description: "Buat callback URL OAST unik (webhook.site, keyless) untuk konfirmasi BLIND bugs (SSRF/blind XSS/XXE/RCE/SQLi-OOB). Hit didorong OTOMATIS ke channel owner oleh watcher (~5 menit, teratribusi ke http_history) — poll manual hanya untuk cek instan. Read, auto.", parameters: { type: "object", properties: {}, required: [] } } },
    execute: async (_args, ctx) => { try { const { oastCreate } = await import("./oast"); return await oastCreate(ctx.rawUser); } catch (e) { return `Error: ${e instanceof Error ? e.message : "oast_create failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "oast_poll", description: "Cek interaksi yang masuk ke callback OAST (bukti out-of-band) — menampilkan hit + atribusi 'kirim via' dari http_history, ditandai baru/lama. Watcher juga mendorong hit otomatis, jadi tool ini untuk cek instan. Read, auto.", parameters: { type: "object", properties: {}, required: [] } } },
    execute: async (_args, ctx) => { try { const { oastPoll } = await import("./oast"); return await oastPoll(ctx.rawUser); } catch (e) { return `Error: ${e instanceof Error ? e.message : "oast_poll failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "oast_stop", description: "Hapus token OAST aktif. Read, auto.", parameters: { type: "object", properties: {}, required: [] } } },
    execute: async (_args, ctx) => { try { const { oastStop } = await import("./oast"); return await oastStop(ctx.rawUser); } catch (e) { return `Error: ${e instanceof Error ? e.message : "oast_stop failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "http_session", description: "Kelola sesi HTTP bernama (cookie+header) untuk uji terautentikasi/BOLA: action set (name + cookie/headers) | list | delete. Read, auto.", parameters: { type: "object", properties: { action: { type: "string", enum: ["set", "list", "delete"] }, name: { type: "string" }, cookie: { type: "string", description: "mis. 'sid=abc; csrf=xyz'" }, headers: { type: "object", description: "Header tetap, mis. {\"Authorization\":\"Bearer ...\"}" } }, required: ["action"] } } },
    execute: async (args, ctx) => {
      try {
        const mod = await import("./httpSession");
        const a = String(args.action || "").toLowerCase();
        if (a === "list") return mod.listSessions(ctx.rawUser);
        const name = String(args.name || "");
        if (a === "delete") return mod.deleteSession(ctx.rawUser, name) ? `🗑️ session "${name}" dihapus.` : `Session "${name}" tidak ada.`;
        if (a === "set") {
          const s = mod.setSession(ctx.rawUser, name, { headers: (args.headers && typeof args.headers === "object") ? (args.headers as Record<string, string>) : undefined, cookie: typeof args.cookie === "string" ? args.cookie : undefined });
          return `🔑 session "${name}" disimpan (${Object.keys(s.cookies).length} cookie, ${Object.keys(s.headers).length} header).`;
        }
        return "Error: action harus set|list|delete.";
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "http_session failed"}`;
      }
    },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "bola_diff", description: "Uji BOLA/IDOR: kirim request SAMA dengan dua sesi (A & B) lalu bandingkan status/body. Hanya lab/engagement. Write, confirm.", parameters: { type: "object", properties: { url: { type: "string" }, method: { type: "string" }, session_a: { type: "string", description: "nama sesi identitas A" }, session_b: { type: "string", description: "nama sesi identitas B" }, body: { type: "string" } }, required: ["url", "session_a", "session_b"] } } },
    execute: async (args, ctx) => { try { const { bolaDiff } = await import("./security"); return await bolaDiff(ctx.rawUser, { url: String(args.url || ""), method: typeof args.method === "string" ? args.method : undefined, sessionA: String(args.session_a || ""), sessionB: String(args.session_b || ""), body: asBodyString(args.body) }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "bola_diff failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "tamper_script", description: "Buat skrip Console siap-tempel untuk men-tamper body request JSON milik app sendiri (patch fetch+XHR). Solusi saat WAF/Cloudflare memblokir replay programatik (curl/fetch manual): app tetap mengirim request-nya, kita ubah body in-flight. Pakai untuk uji IDOR (`set` UserId) / mass assignment (`add` field). Read/auto, tanpa jaringan.", parameters: { type: "object", properties: { url_contains: { type: "string", description: "potongan URL target, mis. UpdateUserProfile" }, set: { type: "object", description: "field yang DIGANTI, mis. {\"UserId\":\"999999\"}" }, add: { type: "object", description: "field TAMBAHAN (mass assignment), mis. {\"IsPremium\":true}" } }, required: ["url_contains"] } } },
    execute: async (args) => {
      try {
        const { buildTamperScript } = await import("./tamper");
        const asMap = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : undefined);
        return buildTamperScript({ urlContains: String(args.url_contains || ""), set: asMap(args.set), add: asMap(args.add) });
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "tamper_script failed"}`;
      }
    },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "cdp_status", description: "Cek Chrome lokal (remote-debugging) yang dikendalikan user + daftar tab-nya. Fondasi uji ber-autentikasi: request dijalankan di sesi browser user, rahasia tak masuk LLM. Read/auto, hanya 127.0.0.1.", parameters: { type: "object", properties: {}, required: [] } } },
    execute: async () => { try { const { cdpStatus } = await import("./cdp"); return await cdpStatus(); } catch (e) { return `Error: ${e instanceof Error ? e.message : "cdp_status failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "cdp_request", description: "Kirim request HTTP DI DALAM tab browser user (cookie/CF-clearance berlaku), jadi lolos WAF dan memakai sesi login. `token_from` = ekspresi JS in-page (mis. localStorage token) yang dievaluasi saat request → token TIDAK pernah masuk ke Mia. `credentials` default include; pakai `omit` bila API cross-origin mengirim `Access-Control-Allow-Origin: *` (credentials+wildcard ditolak browser). Scope-gated. Write, confirm.", parameters: { type: "object", properties: { tab: { type: "string", description: "potongan URL tab, mis. id.jobstreet.com" }, url: { type: "string" }, method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] }, headers: { type: "object", description: "header tambahan (JSON)" }, body: { type: "string", description: "string JSON atau objek (auto-stringify)" }, token_from: { type: "string", description: "ekspresi JS in-page untuk Bearer token (opsional)" }, credentials: { type: "string", enum: ["include", "omit", "same-origin"], description: "default include" } }, required: ["tab", "url"] } } },
    execute: async (args) => { try { const { cdpRequest } = await import("./cdp"); return await cdpRequest({ tab: String(args.tab || ""), url: String(args.url || ""), method: typeof args.method === "string" ? args.method : undefined, headers: args.headers && typeof args.headers === "object" ? (args.headers as Record<string, string>) : undefined, body: asBodyString(args.body), token_from: typeof args.token_from === "string" ? args.token_from : undefined, credentials: typeof args.credentials === "string" ? (args.credentials as "include" | "omit" | "same-origin") : undefined }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "cdp_request failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "cdp_eval", description: "Jalankan JS di tab browser user (scope-gated) — baca state halaman, pasang patch tamper (lihat tamper_script), atau panggil API app. Write, confirm.", parameters: { type: "object", properties: { tab: { type: "string" }, expr: { type: "string", description: "ekspresi JS" } }, required: ["tab", "expr"] } } },
    execute: async (args) => { try { const { cdpEval } = await import("./cdp"); return await cdpEval(String(args.tab || ""), String(args.expr || "")); } catch (e) { return `Error: ${e instanceof Error ? e.message : "cdp_eval failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "cdp_open", description: "Arahkan tab browser user ke URL (scope-gated) — untuk memulai sesi uji ber-autentikasi. Write, confirm.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
    execute: async (args) => { try { const { cdpOpen } = await import("./cdp"); return await cdpOpen(String(args.url || "")); } catch (e) { return `Error: ${e instanceof Error ? e.message : "cdp_open failed"}`; } },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "ato_prove",
        description:
          "BUKTIKAN rantai account takeover: login dengan kredensial yang bocor (mis. dari SQLi dump / /api/admin-data), simpan cookie sesi, lalu buka halaman terlindungi (opsional) sebagai bukti. HANYA lab milik owner / engagement aktif. Password TIDAK pernah dikembalikan (dimask). Write, confirm.",
        parameters: {
          type: "object",
          properties: {
            login_url: { type: "string", description: "Endpoint login, mis. https://lab/api/login" },
            credential: { type: "string", description: 'Shorthand "user:pass" (mis. "admin:K0h0na_Sup3rAdmin!")' },
            username: { type: "string" },
            password: { type: "string" },
            protected_url: { type: "string", description: "Halaman/endpoint yang butuh login (mis. /api/admin-data)" },
            user_field: { type: "string", description: "Nama field username (default username)" },
            pass_field: { type: "string", description: "Nama field password (default password)" },
            body_template: { type: "string", description: "Body mentah dengan {{username}}/{{password}} untuk login form-urlencoded" },
            session: { type: "string", description: "Nama sesi tersimpan (default ato)" },
          },
          required: ["login_url"],
        },
      },
    },
    execute: async (args, ctx) => {
      try {
        const { atoProve } = await import("./ato");
        return await atoProve(ctx.rawUser, {
          login_url: typeof args.login_url === "string" ? args.login_url : "",
          credential: typeof args.credential === "string" ? args.credential : undefined,
          username: typeof args.username === "string" ? args.username : undefined,
          password: typeof args.password === "string" ? args.password : undefined,
          protected_url: typeof args.protected_url === "string" ? args.protected_url : undefined,
          user_field: typeof args.user_field === "string" ? args.user_field : undefined,
          pass_field: typeof args.pass_field === "string" ? args.pass_field : undefined,
          body_template: typeof args.body_template === "string" ? args.body_template : undefined,
          session: typeof args.session === "string" ? args.session : undefined,
        });
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "ato_prove failed"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "auth_setup",
        description:
          "Wizard sesi uji 1 perintah: login N akun (maks 4) via atoProve, simpan cookie sesi bernama (admin/guest/...) siap untuk exploit_chain (session_a/session_b), bola_diff, auth_matrix, http_request. HANYA lab milik owner / engagement aktif. Password TIDAK pernah dikembalikan (dimask). Write, confirm.",
        parameters: {
          type: "object",
          properties: {
            login_url: { type: "string", description: "Endpoint login, mis. https://lab/api/login" },
            accounts: { type: "array", description: 'Daftar akun: [{credential:"user:pass", session:"admin"}, ...] atau [{username, password, session}]' },
            user_field: { type: "string", description: "nama field username (default: username)" },
            pass_field: { type: "string", description: "nama field password (default: password)" },
            body_template: { type: "string", description: "template body form dengan {{username}}/{{password}}" },
            protected_url: { type: "string", description: "URL terlindungi untuk bukti akses (opsional)" },
          },
          required: ["login_url", "accounts"],
        },
      },
    },
    execute: async (args, ctx) => {
      try {
        const { authSetup } = await import("./authSetup");
        const raw = Array.isArray(args.accounts) ? args.accounts : [];
        return await authSetup(ctx.rawUser, {
          login_url: typeof args.login_url === "string" ? args.login_url : undefined,
          accounts: raw.filter((x): x is Record<string, unknown> => !!x && typeof x === "object").map((x) => ({
            credential: typeof x.credential === "string" ? x.credential : undefined,
            username: typeof x.username === "string" ? x.username : undefined,
            password: typeof x.password === "string" ? x.password : undefined,
            session: typeof x.session === "string" ? x.session : undefined,
          })),
          user_field: typeof args.user_field === "string" ? args.user_field : undefined,
          pass_field: typeof args.pass_field === "string" ? args.pass_field : undefined,
          body_template: typeof args.body_template === "string" ? args.body_template : undefined,
          protected_url: typeof args.protected_url === "string" ? args.protected_url : undefined,
        });
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "auth_setup failed"}`;
      }
    },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "exposure_hunt", description: "Sapu path predictable yang terekspos (.git/HEAD, .env, backup, VCS metadata, API docs — 24 path, GET-only) pada SATU origin. Klasifikasi LEAD (200+marker) vs info (401/403); nilai secret TIDAK pernah ditampilkan (keys only). Sinyal bukan vuln: poc_verify dulu. Scope-gated. Write, confirm.", parameters: { type: "object", properties: { url: { type: "string", description: "URL dasar lab/engagement (origin-nya yang diuji)" }, paths: { type: "array", description: "subset path opsional (mis. ['/.git/HEAD','/.env'])" } }, required: ["url"] } } },
    execute: async (args, ctx) => {
      try {
        const { exposureHunt } = await import("./exposureHunt");
        return await exposureHunt(ctx.rawUser, {
          url: typeof args.url === "string" ? args.url : undefined,
          paths: Array.isArray(args.paths) ? args.paths.filter((x): x is string => typeof x === "string") : undefined,
        });
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "exposure_hunt failed"}`;
      }
    },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "csrf_prove", description: "Buktikan CSRF end-to-end: parse form state-changing + cek field token + posture SameSite, replay aksi TANPA token memakai session, dan bila diterima tulis PoC HTML standalone ke evidence (file nyata). Verdict jujur: PROVEN / TOKEN-ENFORCED / NO-FORMS. Scope-gated. Write, confirm.", parameters: { type: "object", properties: { url: { type: "string", description: "halaman/form target lab/engagement" }, session: { type: "string", description: "nama http_session (status korban login)" } }, required: ["url"] } } },
    execute: async (args, ctx) => {
      try {
        const { csrfProve } = await import("./csrfProve");
        return await csrfProve(ctx.rawUser, {
          url: typeof args.url === "string" ? args.url : undefined,
          session: typeof args.session === "string" ? args.session : undefined,
        });
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "csrf_prove failed"}`;
      }
    },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "mass_assignment", description: "Buktikan mass assignment: injeksikan field privileged (role/admin/verified/user_id/…) ke POST/PUT/PATCH lalu diff vs baseline sesi yang sama — echo/reflection atau outcome berubah = kandidat; opsional verify_url GET untuk konfirmasi persistensi (role terbaca kembali). Verdict jujur: kandidat/terkontrol/diabaikan. Scope-gated. Write, confirm.", parameters: { type: "object", properties: { url: { type: "string", description: "endpoint lab/engagement" }, method: { type: "string", enum: ["POST", "PUT", "PATCH"], description: "default POST" }, body: { type: "string", description: "body dasar (JSON)" }, session: { type: "string", description: "nama http_session" }, fields: { type: "array", description: "subset field opsional" }, verify_url: { type: "string", description: "URL GET untuk cek persistensi (mis. /me/profile)" } }, required: ["url"] } } },
    execute: async (args, ctx) => {
      try {
        const { massAssign } = await import("./massAssign");
        return await massAssign(ctx.rawUser, {
          url: typeof args.url === "string" ? args.url : undefined,
          method: typeof args.method === "string" ? args.method : undefined,
          body: typeof args.body === "string" ? args.body : undefined,
          session: typeof args.session === "string" ? args.session : undefined,
          fields: Array.isArray(args.fields) ? args.fields.filter((x): x is string => typeof x === "string") : undefined,
          verify_url: typeof args.verify_url === "string" ? args.verify_url : undefined,
        });
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "mass_assignment failed"}`;
      }
    },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "upload_fuzz", description: "Uji upload file: bypass ekstensi (.phtml/.php5/case/double-ext/mime-confusion/polyglot/traversal, marker inert — tanpa webshell, tanpa .htaccess) lalu GET lokasi hasil upload untuk verifikasi akses. Verdict jujur: LEAD / UNVERIFIED / REJECTED. Scope-gated. Write, confirm.", parameters: { type: "object", properties: { url: { type: "string", description: "endpoint upload lab/engagement" }, field: { type: "string", description: "nama field form (default file)" }, session: { type: "string", description: "nama http_session" }, vectors: { type: "array", description: "subset nama vektor opsional" } }, required: ["url"] } } },
    execute: async (args, ctx) => {
      try {
        const { uploadFuzz } = await import("./uploadFuzz");
        return await uploadFuzz(ctx.rawUser, {
          url: typeof args.url === "string" ? args.url : undefined,
          field: typeof args.field === "string" ? args.field : undefined,
          session: typeof args.session === "string" ? args.session : undefined,
          vectors: Array.isArray(args.vectors) ? args.vectors.filter((x): x is string => typeof x === "string") : undefined,
        });
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "upload_fuzz failed"}`;
      }
    },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "xss_hunt", description: "Buru XSS reflected/stored: semai marker inert per titik injeksi (param+form) → klasifikasi konteks (html/atribut/script/comment) → 1 breakout confirmer + beacon script-src OAST → korelasi. Refleksi tanpa breakout = kandidat lemah (jujur). Scope-gated. Write, confirm.", parameters: { type: "object", properties: { url: { type: "string", description: "halaman lab/engagement ber-param/form" }, session: { type: "string", description: "nama http_session" }, callback: { type: "string", description: "URL OAST https (auto-create bila kosong)" } }, required: ["url"] } } },
    execute: async (args, ctx) => {
      try {
        const { xssHunt } = await import("./xssHunt");
        return await xssHunt(ctx.rawUser, {
          url: typeof args.url === "string" ? args.url : undefined,
          session: typeof args.session === "string" ? args.session : undefined,
          callback: typeof args.callback === "string" ? args.callback : undefined,
        });
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "xss_hunt failed"}`;
      }
    },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "idor_enum", description: "Enumerasi ID rentang (default 1..20) sebagai DUA sesi: hit bila A+B 200 + body identik; kontrol anon menurunkan publik jadi info (bukan temuan). Guard: maks 30 request, stop di 5 hit. Output angka dampak konkrit. Scope-gated. Write, confirm.", parameters: { type: "object", properties: { url: { type: "string", description: "URL dengan {id} atau param ID (mis. /api/dokumen?id=1)" }, session_a: { type: "string" }, session_b: { type: "string" }, id_start: { type: "number" }, id_end: { type: "number" } }, required: ["url", "session_a", "session_b"] } } },
    execute: async (args, ctx) => {
      try {
        const { idorEnum } = await import("./idorEnum");
        return await idorEnum(ctx.rawUser, {
          url: typeof args.url === "string" ? args.url : undefined,
          session_a: typeof args.session_a === "string" ? args.session_a : undefined,
          session_b: typeof args.session_b === "string" ? args.session_b : undefined,
          id_start: typeof args.id_start === "number" ? args.id_start : undefined,
          id_end: typeof args.id_end === "number" ? args.id_end : undefined,
        });
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "idor_enum failed"}`;
      }
    },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "host_header_hunt", description: "Uji Host-header (8 header: Host/X-Forwarded-Host/Scheme/Forwarded/dll) dengan canary: pantulan di body/Location + jalur reset-poisoning (reset_url + email → link reset ber-host evil). Verdict jujur per vektor. Scope-gated. Write, confirm.", parameters: { type: "object", properties: { url: { type: "string" }, reset_url: { type: "string" }, email: { type: "string" }, email_field: { type: "string" }, session: { type: "string" } }, required: ["url"] } } },
    execute: async (args, ctx) => {
      try {
        const { hostHeaderHunt } = await import("./hostHeaderHunt");
        return await hostHeaderHunt(ctx.rawUser, {
          url: typeof args.url === "string" ? args.url : undefined,
          reset_url: typeof args.reset_url === "string" ? args.reset_url : undefined,
          email: typeof args.email === "string" ? args.email : undefined,
          email_field: typeof args.email_field === "string" ? args.email_field : undefined,
          session: typeof args.session === "string" ? args.session : undefined,
        });
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "host_header_hunt failed"}`;
      }
    },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "recon_full", description: "Pipeline recon satu-konfirmasi: subdomains (pasif) → httpx → params arsip → tech fingerprint → exposure_hunt → content_discover. Tiap tahap bounded + output dipotong jujur + tahap gagal tak menggugurkan lainnya. Hemat 3-5 round. Scope-gated. Write, confirm.", parameters: { type: "object", properties: { target: { type: "string", description: "URL lab/engagement" } }, required: ["target"] } } },
    execute: async (args, ctx) => {
      try {
        const { reconFull } = await import("./reconFull");
        return await reconFull(ctx.rawUser, { target: typeof args.target === "string" ? args.target : undefined });
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "recon_full failed"}`;
      }
    },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "smuggle_probe", description: "Buktikan HTTP request smuggling (CL.TE/TE.CL/TE-obfuscation) via raw socket: probe berisi hidden request canary + victim request → canary terjawab sebagai respons victim = DESYNC TERKONFIRMASI (CWE-444); satu hop konsisten/parse tegas = bukan temuan (jujur). Scope-gated, bounded ≤3 mode. Write, confirm.", parameters: { type: "object", properties: { url: { type: "string", description: "URL lab/engagement (http/https)" }, modes: { type: "string", description: "subset koma: clte,tecl,teob (default ketiganya)" }, te: { type: "number", description: "indeks varian obfuscation TE untuk mode teob (default 0)" } }, required: ["url"] } } },
    execute: async (args, ctx) => {
      try {
        const { smuggleProbe } = await import("./smuggleProbe");
        return await smuggleProbe(ctx.rawUser, {
          url: typeof args.url === "string" ? args.url : undefined,
          modes: typeof args.modes === "string" ? args.modes : undefined,
          te: typeof args.te === "number" ? args.te : undefined,
        });
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "smuggle_probe failed"}`;
      }
    },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "dom_xss_prove", description: "Buktikan DOM-XSS secara dinamis di Chromium headless: payload ganda JS+HTML per sumber (hash/search/postMessage/window.name/referrer) → PROVEN bila handler/JS jalan, INJECTED_ONLY bila HTML masuk tanpa eksekusi (cek CSP), NOT_CONFIRMED bila nihil. Melengkapi dom_taint yang statik. Scope-gated, bounded ≤5 sumber. Write, confirm.", parameters: { type: "object", properties: { url: { type: "string", description: "halaman lab/engagement" }, sources: { type: "string", description: "subset koma: hash,search,postmessage,windowname,referrer (default semua)" }, param: { type: "string", description: "nama query-param untuk attempt search/referrer (default mia)" }, session: { type: "string", description: "nama http_session (opsional)" } }, required: ["url"] } } },
    execute: async (args, ctx) => {
      try {
        const { domXssProve } = await import("./domXssProve");
        return await domXssProve(ctx.rawUser, {
          url: typeof args.url === "string" ? args.url : undefined,
          sources: typeof args.sources === "string" ? args.sources : undefined,
          param: typeof args.param === "string" ? args.param : undefined,
          session: typeof args.session === "string" ? args.session : undefined,
        });
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "dom_xss_prove failed"}`;
      }
    },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "poc_verify", description: "Buktikan lead sebelum lapor: jalankan request N× (default 3), fingerprint tiap respons (status+body+header), cek determinisme, assertion expect_status/expect_contains/expect_header/expect_header_absent/expect_cookie_missing (atribut cookie per-nama), dan opsional banding baseline (kontrol) → verdict layak-lapor. Scope-gated. Write, confirm.", parameters: { type: "object", properties: { url: { type: "string" }, method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] }, headers: { type: "object" }, body: { type: "string" }, session: { type: "string", description: "nama http_session (opsional)" }, times: { type: "number", description: "default 3, maks 8" }, expect_status: { type: "number" }, expect_contains: { type: "string" }, expect_header: { type: "string", description: "substring (case-insensitive) yang HARUS ada di header respons" }, expect_header_absent: { type: "string", description: "substring yang TIDAK boleh ada di header respons" }, expect_cookie: { type: "string", description: "bukti temuan cookie: NAMA cookie yang diperiksa (mis. ASP.NET_SessionId_CROSS_DOM_custom)" }, expect_cookie_missing: { type: "string", description: "flag yang hilang pada cookie itu, dipisah koma (mis. HttpOnly, Secure, SameSite)" }, baseline_url: { type: "string", description: "request kontrol (mis. id/identitas lain)" }, baseline_method: { type: "string" }, baseline_body: { type: "string" }, baseline_session: { type: "string" }, save_evidence: { type: "boolean" } }, required: ["url"] } } },
    execute: async (args, ctx) => {
      try {
        const { pocVerify } = await import("./poc");
        return await pocVerify(ctx.rawUser, {
          url: String(args.url || ""),
          method: typeof args.method === "string" ? args.method : undefined,
          headers: args.headers && typeof args.headers === "object" ? (args.headers as Record<string, string>) : undefined,
          body: asBodyString(args.body),
          session: typeof args.session === "string" ? args.session : undefined,
          times: asNumber(args.times),
          expect_status: asNumber(args.expect_status),
          expect_contains: typeof args.expect_contains === "string" ? args.expect_contains : undefined,
          expect_header: typeof args.expect_header === "string" ? args.expect_header : undefined,
          expect_header_absent: typeof args.expect_header_absent === "string" ? args.expect_header_absent : undefined,
          expect_cookie_missing: typeof args.expect_cookie === "string" && args.expect_cookie.trim() && typeof args.expect_cookie_missing === "string"
            ? { name: args.expect_cookie.trim(), flags: args.expect_cookie_missing.split(/[,\s]+/).map((f) => f.trim()).filter(Boolean) }
            : undefined,
          baseline_url: typeof args.baseline_url === "string" ? args.baseline_url : undefined,
          baseline_method: typeof args.baseline_method === "string" ? args.baseline_method : undefined,
          baseline_body: asBodyString(args.baseline_body),
          baseline_session: typeof args.baseline_session === "string" ? args.baseline_session : undefined,
          save_evidence: args.save_evidence === true,
        });
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "poc_verify failed"}`;
      }
    },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "cloud_misconfig", description: "Cek storage cloud MILIK organisasi dalam scope (keyless): S3/GCS/Azure Blob listing publik + Firebase RTDB terbuka + Supabase. `base_domain` = domain org (dasar otorisasi; harus lab/engagement). `target` untuk nama bucket eksplisit. Write, confirm.", parameters: { type: "object", properties: { base_domain: { type: "string", description: "mis. example.com (harus tercakup engagement)" }, target: { type: "string", description: "nama bucket/project eksplisit (opsional)" }, provider: { type: "string", enum: ["auto", "s3", "gcs", "azure", "firebase", "supabase"] } }, required: ["base_domain"] } } },
    execute: async (args, ctx) => { try { const { cloudMisconfig } = await import("./cloud"); return await cloudMisconfig(ctx.rawUser, { base_domain: typeof args.base_domain === "string" ? args.base_domain : undefined, target: typeof args.target === "string" ? args.target : undefined, provider: typeof args.provider === "string" ? args.provider : undefined }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "cloud_misconfig failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "tech_watch", description: "Fingerprint teknologi host (framework/versi dari header+marker), diff vs snapshot terakhir, dan cari CVE untuk yang berubah. Scope-gated, read/auto, bounded (1 GET).", parameters: { type: "object", properties: { url: { type: "string" }, cve: { type: "boolean", description: "cari CVE (default true saat ada perubahan)" } }, required: ["url"] } } },
    execute: async (args, ctx) => { try { const { techWatch } = await import("./techWatch"); const out = await techWatch(ctx.rawUser, String(args.url || ""), { cve: args.cve !== false }); try { const { brainRecordTech } = await import("./targetBrain"); const m = out.match(/^tech:\s*(.+)$/m); if (m) brainRecordTech(ctx.rawUser, String(args.url || ""), m[1].trim()); } catch { /* best-effort */ } return out; } catch (e) { return `Error: ${e instanceof Error ? e.message : "tech_watch failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "persona_show", description: "Tampilkan apa yang Mia ingat tentang user (fakta persona USER + gaya SOUL, plus riwayat yang digantikan). Read/auto.", parameters: { type: "object", properties: {}, required: [] } } },
    execute: async (_a, ctx) => { try { const { personaFactsText } = await import("./persona"); return personaFactsText(ctx.rawUser); } catch (e) { return `Error: ${e instanceof Error ? e.message : "persona_show failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "persona_set", description: "Simpan fakta tentang user secara eksplisit (mis. 'ingat ini: aku suka kopi tubruk'). Key kanonik + nilai; rahasia/token DITOLAK. Write, confirm.", parameters: { type: "object", properties: { key: { type: "string", description: "mis. preference.coffee / name / job" }, value: { type: "string" }, target: { type: "string", enum: ["USER", "SOUL"], description: "USER (fakta) atau SOUL (gaya)" } }, required: ["key", "value"] } } },
    execute: async (args, ctx) => { try { const { setPersonaFact } = await import("./persona"); return setPersonaFact(ctx.rawUser, String(args.key || ""), String(args.value || ""), args.target === "SOUL" ? "SOUL" : "USER"); } catch (e) { return `Error: ${e instanceof Error ? e.message : "persona_set failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "persona_forget", description: "Hapus fakta persona yang cocok dengan kata kunci (key atau value). Write, confirm.", parameters: { type: "object", properties: { query: { type: "string", description: "mis. 'kopi'" } }, required: ["query"] } } },
    execute: async (args, ctx) => { try { const { forgetPersonaFact } = await import("./persona"); return forgetPersonaFact(ctx.rawUser, String(args.query || "")); } catch (e) { return `Error: ${e instanceof Error ? e.message : "persona_forget failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "policy_show", description: "Lihat policy auto-approve (tool mana yang boleh jalan tanpa konfirmasi saat engagement aktif). Read/auto.", parameters: { type: "object", properties: {}, required: [] } } },
    execute: async () => { try { const { policyText } = await import("./policy"); return policyText(); } catch (e) { return `Error: ${e instanceof Error ? e.message : "policy_show failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "policy_set", description: "Atur auto-approve tool berisiko (hanya read/write; delete/transaction/external TIDAK pernah; URL wajib lab/engagement). action=set|add|reset + tools[] . Write, confirm.", parameters: { type: "object", properties: { action: { type: "string", enum: ["set", "add", "reset"] }, tools: { type: "array", description: "nama tool, mis. [\"http_request\",\"poc_verify\"]" }, note: { type: "string" } }, required: ["action"] } } },
    execute: async (args) => {
      try {
        const { setPolicy } = await import("./policy");
        const tools = Array.isArray(args.tools) ? args.tools.map(String) : [];
        const p = setPolicy((["set", "add", "reset"].includes(String(args.action)) ? String(args.action) : "set") as "set" | "add" | "reset", tools, typeof args.note === "string" ? args.note : "");
        return `✅ Policy diperbarui — auto-approve (${p.autoApprove.length}): ${p.autoApprove.join(", ") || "(kosong)"}`;
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "policy_set failed"}`;
      }
    },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "flow_run", description: "Jalankan sekuens langkah HTTP (login→ambil id→akses objek→assert) dengan variabel {{var}} + extract + assertion. Untuk IDOR/logic multi-request. `save=<nama>` menyimpan; `name=<nama>` memuat. Scope-gated per langkah. Write, confirm.", parameters: { type: "object", properties: { name: { type: "string", description: "muat flow tersimpan" }, save: { type: "string", description: "simpan flow ini dengan nama" }, vars: { type: "object" }, flow: { type: "object", description: "{steps:[{method,url,headers,body,session,expect_status,expect_contains,extract}]}" }, steps: { type: "array", description: "alternatif inline ke flow.steps" } }, required: [] } } },
    execute: async (args, ctx) => {
      try {
        const { flowRun } = await import("./flow");
        const flow = (args.flow && typeof args.flow === "object" ? (args.flow as Record<string, unknown>) : Array.isArray(args.steps) ? { steps: args.steps } : undefined) as { steps?: unknown[]; vars?: Record<string, string> } | undefined;
        return await flowRun(ctx.rawUser, {
          flow: flow ? ({ name: typeof args.save === "string" ? args.save : undefined, vars: flow.vars, steps: Array.isArray(flow.steps) ? flow.steps : [] } as never) : undefined,
          name: typeof args.name === "string" ? args.name : undefined,
          save: typeof args.save === "string" ? args.save : undefined,
          vars: args.vars && typeof args.vars === "object" ? (args.vars as Record<string, string>) : undefined,
        });
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "flow_run failed"}`;
      }
    },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "workflow_fuzz", description: "FUZZ ALUR BISNIS (state-transition): definisikan happy-path flow ≥2 langkah (login→cart→checkout→refund) → mutasi urutan (skip step/repeat/reorder) + mutasi nilai (qty -1/0/99999, amount 0/0.01/negatif, currency, coupon reuse) → diff outcome vs happy path. Menemukan missing state validation (checkout tanpa bayar) & double-processing (refund dobel) yang TIDAK terlihat scanner signature. `name` = flow tersimpan (flow_run save=), atau `steps` inline. Scope-gated, bounded ≤14 mutasi. Write, confirm.", parameters: { type: "object", properties: { name: { type: "string", description: "flow tersimpan" }, steps: { type: "array", description: "[{method,url,headers,body,session,expect_status,expect_contains,extract}] — happy path" }, vars: { type: "object" }, focus_step: { type: "number", description: "index step untuk value mutation (default step terakhir)" }, kinds: { type: "array", description: "skip/repeat/reorder/value (default semua)" }, max: { type: "number", description: "maks mutasi (default 14)" } }, required: [] } } },
    execute: async (args, ctx) => {
      try {
        const { workflowFuzz } = await import("./workflowFuzz");
        const steps = Array.isArray(args.steps) ? (args.steps as unknown[]) : undefined;
        return await workflowFuzz(ctx.rawUser, {
          name: typeof args.name === "string" ? args.name : undefined,
          flow: steps?.length ? { steps: steps as never } : undefined,
          vars: args.vars && typeof args.vars === "object" ? (args.vars as Record<string, string>) : undefined,
          focus_step: typeof args.focus_step === "number" ? args.focus_step : undefined,
          kinds: Array.isArray(args.kinds) ? (args.kinds as string[]).filter((k): k is string => typeof k === "string") : undefined,
          max: typeof args.max === "number" ? args.max : undefined,
        });
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "workflow_fuzz failed"}`;
      }
    },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "flow_list", description: "Daftar flow tersimpan. Read/auto.", parameters: { type: "object", properties: {}, required: [] } } },
    execute: async (_a, ctx) => { try { const { flowListText } = await import("./flow"); return flowListText(ctx.rawUser); } catch (e) { return `Error: ${e instanceof Error ? e.message : "flow_list failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "program_score", description: "Skor ROI sebuah program/scope (heuristik transparan) + urutkan host prioritas. Beri `scope` (teks program) atau `engagement` (id). Read/auto.", parameters: { type: "object", properties: { scope: { type: "string", description: "teks scope program (Targets)" }, engagement: { type: "string", description: "id engagement" } }, required: [] } } },
    execute: async (args) => { try { const { roiText } = await import("./roi"); return roiText({ scope: typeof args.scope === "string" ? args.scope : undefined, engagement: typeof args.engagement === "string" ? args.engagement : undefined }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "program_score failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "campaign_run", description: "Loop hunt ber-guard & resumable: jalankan suite_hunt per host (skip yang dead/lead), batas host + waktu, berhenti saat lead (opsional). Tanpa `targets`/`engagement` → pakai engagement AKTIF TERBARU (tidak pernah menggabung beberapa program). Write, confirm.", parameters: { type: "object", properties: { targets: { type: "array", description: "daftar host (opsional)" }, engagement: { type: "string", description: "id engagement (opsional; default yang terbaru aktif)" }, deep: { type: "boolean" }, max_hosts: { type: "number", description: "default 5, maks 12" }, max_seconds: { type: "number", description: "budget, default 480s" }, stop_on_lead: { type: "boolean" }, spec: { type: "string" }, session: { type: "string" } }, required: [] } } },
    execute: async (args, ctx) => {
      try {
        const { campaignRun } = await import("./campaign");
        return await campaignRun(ctx.rawUser, {
          targets: asStringArray(args.targets),
          engagement: typeof args.engagement === "string" ? args.engagement : undefined,
          deep: args.deep === true,
          max_hosts: asNumber(args.max_hosts),
          max_seconds: asNumber(args.max_seconds),
          stop_on_lead: args.stop_on_lead === true,
          spec: typeof args.spec === "string" ? args.spec : undefined,
          session: typeof args.session === "string" ? args.session : undefined,
        });
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "campaign_run failed"}`;
      }
    },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "dup_check", description: "Cek kemungkinan duplikat sebelum submit: bandingkan judul (+target) dengan findings & submissions lokal (kemiripan token). Read/auto.", parameters: { type: "object", properties: { title: { type: "string" }, target: { type: "string" }, cwe: { type: "string" } }, required: ["title"] } } },
    execute: async (args, ctx) => { try { const { dupCheck } = await import("./dupes"); return dupCheck(ctx.rawUser, { title: String(args.title || ""), target: typeof args.target === "string" ? args.target : undefined, cwe: typeof args.cwe === "string" ? args.cwe : undefined }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "dup_check failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "bounty_run", description: "SATU PERINTAH bug-bounty (draft-only): engagement → worklist ber-ROI → campaign hunt bounded → klasifikasi lead → DRAFT finding (high-signal, +dup_check) → draft report → HANDOFF. TIDAK submit, tidak destruktif, tidak bypass WAF. Resumable. Baru: auto_chain (exploit_chain otomatis per lead), auto_evidence (browser snapshot), max_chains. Write, confirm.", parameters: { type: "object", properties: { engagement: { type: "string", description: "id engagement (opsional; default engagement aktif pertama)" }, targets: { type: "array", description: "host eksplisit (opsional)" }, max_hosts: { type: "number", description: "default 5, maks 12" }, max_seconds: { type: "number", description: "budget, default 480s" }, deep: { type: "boolean" }, spec: { type: "string" }, session: { type: "string" }, auto_chain: { type: "boolean", description: "jalankan exploit_chain otomatis pada lead high-signal (IDOR/auth_bypass/SSRF/session_fixation)" }, auto_evidence: { type: "boolean", description: "capture browser screenshot untuk tiap kandidat" }, max_chains: { type: "number", description: "maks chain per host (default 3, maks 5)" } }, required: [] } } },
    execute: async (args, ctx) => {
      try {
        const { bountyRun } = await import("./bounty");
        return await bountyRun(ctx.rawUser, {
          engagement: typeof args.engagement === "string" ? args.engagement : undefined,
          targets: asStringArray(args.targets),
          max_hosts: asNumber(args.max_hosts),
          max_seconds: asNumber(args.max_seconds),
          deep: args.deep === true,
          spec: typeof args.spec === "string" ? args.spec : undefined,
          session: typeof args.session === "string" ? args.session : undefined,
          auto_chain: args.auto_chain === true,
          auto_evidence: args.auto_evidence === true,
          max_chains: asNumber(args.max_chains),
        });
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "bounty_run failed"}`;
      }
    },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "bounty_status", description: "Riwayat ringkas bounty_run terakhir (host/lead/draft). Read/auto.", parameters: { type: "object", properties: {}, required: [] } } },
    execute: async () => { try { const { bountyStatus } = await import("./bounty"); return bountyStatus(); } catch (e) { return `Error: ${e instanceof Error ? e.message : "bounty_status failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "exploit_chain", description: "Jalankan exploit chain otomatis: IDOR (bola_diff), auth_bypass (JWT alg:none/claim tampering), SSRF (OAST callback), session_fixation, RACE (paralel + nonce unik), GRAPHQL (introspection/suggestion/batching/depth), XXE (OOB + file-read), OPEN_REDIRECT (matrix bypass), CACHE_POISON (header matrix). chain BISA koma-terpisah untuk beberapa chain sekaligus (mis. \"idor,ssrf,race\") ATAU chain='auto' (rekomendasi + jalan otomatis dari intel target_brain + sesi yang ada, maks 5, skip jujur) — tiap chain jalan berurutan dan hasilnya per-chain; yang butuh setup (sesi/token/kredensial) di-skip dengan penanda ⛔ CHAIN TIDAK DIJALANKAN (tidak pernah dianggap jalan). Satu konfirmasi = seluruh chain yang diminta. Scope-gated. Write, confirm.", parameters: { type: "object", properties: { chain: { type: "string", description: "jenis chain — satu nama ATAU koma-terpisah (mis. \"idor,ssrf,race\"): idor, auth_bypass, ssrf, session_fixation, race, graphql, xxe, open_redirect, cache_poison" }, url: { type: "string", description: "target URL (lab/engagement)" }, session_a: { type: "string", description: "nama http_session akun A (untuk IDOR)" }, session_b: { type: "string", description: "nama http_session akun B (untuk IDOR)" }, token: { type: "string", description: "JWT token (untuk auth_bypass)" }, session: { type: "string", description: "nama http_session (auth_bypass/race/graphql/xxe/redirect/cache)" }, callback: { type: "string", description: "OAST callback URL (opsional, auto-create jika kosong)" }, params: { type: "array", description: "parameter spesifik (ssrf/open_redirect/cache_poison)" }, login_url: { type: "string", description: "URL login (untuk session_fixation)" }, username: { type: "string", description: "username (untuk session_fixation)" }, password: { type: "string", description: "password (untuk session_fixation)" }, user_field: { type: "string", description: "nama field username di form (default: username)" }, pass_field: { type: "string", description: "nama field password di form (default: password)" }, protected_url: { type: "string", description: "URL terlindungi untuk diuji (untuk session_fixation)" }, body: { type: "string", description: "body POST (race — boleh {{NONCE}})" }, count: { type: "number", description: "jumlah request race 2-30 (default 10)" }, method: { type: "string" }, body_template: { type: "string", description: "template body XML dgn marker {XXE}" }, content_type: { type: "string" }, depth: { type: "number", description: "kedalaman depth probe graphql (default 25, maks 50)" } }, required: ["chain", "url"] } } },
    execute: async (args, ctx) => {
      try {
        const { runExploitChain } = await import("./exploitChains");
        return await runExploitChain(ctx.rawUser, String(args.chain || ""), {
          url: typeof args.url === "string" ? args.url : undefined,
          session_a: typeof args.session_a === "string" ? args.session_a : undefined,
          session_b: typeof args.session_b === "string" ? args.session_b : undefined,
          token: typeof args.token === "string" ? args.token : undefined,
          session: typeof args.session === "string" ? args.session : undefined,
          callback: typeof args.callback === "string" ? args.callback : undefined,
          params: asStringArray(args.params),
          login_url: typeof args.login_url === "string" ? args.login_url : undefined,
          username: typeof args.username === "string" ? args.username : undefined,
          password: typeof args.password === "string" ? args.password : undefined,
          user_field: typeof args.user_field === "string" ? args.user_field : undefined,
          pass_field: typeof args.pass_field === "string" ? args.pass_field : undefined,
          protected_url: typeof args.protected_url === "string" ? args.protected_url : undefined,
          body: typeof args.body === "string" ? args.body : undefined,
          headers: args.headers && typeof args.headers === "object" ? (args.headers as Record<string, string>) : undefined,
          count: typeof args.count === "number" ? args.count : undefined,
          depth: typeof args.depth === "number" ? args.depth : undefined,
          method: typeof args.method === "string" ? args.method : undefined,
          body_template: typeof args.body_template === "string" ? args.body_template : undefined,
          content_type: typeof args.content_type === "string" ? args.content_type : undefined,
        });
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "exploit_chain failed"}`;
      }
    },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "vuln_compose", description: "Susun ≥2 temuan PROVEN pada satu host jadi SATU chain E2E lintas-kelas: cari relasi output-A → input-B (endpoint/param/token/object-id konkret), replay tiap hop via pocVerify, verdict jujur (TERBUKTI PENUH → temuan komposit critical; PUTUS DI HOP n / TAK TERSAMBUNG → tanpa temuan baru). Scope-gated, bounded. Write, confirm.", parameters: { type: "object", properties: { target: { type: "string", description: "host target (opsional — default kelompok terbesar satu host)" }, finding_ids: { type: "array", description: "id finding spesifik (opsional, mis. [\"F-abc\",\"F-def\"])" } }, required: [] } } },
    execute: async (args, ctx) => {
      try {
        const { vulnCompose } = await import("./vulnCompose");
        const ids = Array.isArray(args.finding_ids) ? args.finding_ids.filter((x): x is string => typeof x === "string") : undefined;
        return await vulnCompose(ctx.rawUser, {
          target: typeof args.target === "string" ? args.target : undefined,
          finding_ids: ids,
        });
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "vuln_compose failed"}`;
      }
    },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "exploit_build", description: "Bangun artefak exploit STANDALONE dari satu temuan proven sebagai FILE nyata di disk (script replay deterministik + payload + OAST beacon opsional + asserts, exit 0=VULNERABLE / 1=NOT CONFIRMED). Jujur: bila target tak bisa diturunkan/di luar scope, menjawab 'tidak dibuat' dan TIDAK menulis file. language: node|python|curl. Scope-gated. Write, confirm.", parameters: { type: "object", properties: { finding_id: { type: "string", description: "id finding (lihat finding_list)" }, language: { type: "string", enum: ["node", "python", "curl"], description: "default node" }, callback: { type: "string", description: "URL OAST https milikmu untuk beacon (opsional)" } }, required: ["finding_id"] } } },
    execute: async (args, ctx) => {
      try {
        const { buildExploitArtifact } = await import("./exploitBuild");
        return await buildExploitArtifact(ctx.rawUser, {
          finding_id: typeof args.finding_id === "string" ? args.finding_id : undefined,
          language: typeof args.language === "string" ? args.language : undefined,
          callback: typeof args.callback === "string" ? args.callback : undefined,
        });
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "exploit_build failed"}`;
      }
    },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "oauth_hunt", description: "Uji OAuth/OIDC (scope-gated): ambil discovery, lalu probe authorization_endpoint dengan varian bypass `redirect_uri` → deteksi open redirect (jalur ATO). Bounded, GET saja. Write, confirm.", parameters: { type: "object", properties: { url: { type: "string", description: "issuer / /.well-known/openid-configuration / base host" }, client_id: { type: "string", description: "client_id (opsional)" } }, required: ["url"] } } },
    execute: async (args, ctx) => { try { const { oauthHunt } = await import("./oauth"); return await oauthHunt(ctx.rawUser, { url: String(args.url || ""), client_id: typeof args.client_id === "string" ? args.client_id : undefined }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "oauth_hunt failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "writeup", description: "Hasilkan laporan siap-submit (impact-first, langkah repro, raw evidence, remediasi) untuk satu finding. `id` opsional (default terbaru). Read/auto.", parameters: { type: "object", properties: { id: { type: "string", description: "id finding, mis. F-..." }, platform: { type: "string", enum: ["bugcrowd", "hackerone"] } }, required: [] } } },
    execute: async (args, ctx) => { try { const { writeupText } = await import("./writeup"); return writeupText(ctx.rawUser, { id: typeof args.id === "string" ? args.id : undefined, platform: typeof args.platform === "string" ? args.platform : undefined }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "writeup failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "target_brain", description: "Memori persisten PER-TARGET: endpoint/params yang pernah terlihat, tech, auth model, temuan TERBUKTI, dan request yang sudah dites aman — WAJIB dibaca (action=brief) SEBELUM menguji ulang sebuah target supaya lanjut dari titik terakhir, bukan mengulang. action=coverage untuk peta % teruji + gap kelas serangan. content_discover/js_mine/tech_watch/finding_add menulis ke sini OTOMATIS. Read/auto.", parameters: { type: "object", properties: { action: { type: "string", enum: ["brief", "list", "forget", "note", "coverage"], description: "default brief" }, target: { type: "string", description: "host/URL target (untuk brief/forget/note/coverage)" }, note: { type: "string", description: "catatan bebas (untuk action=note)" } }, required: [] } } },
    execute: async (args, ctx) => {
      try {
        const brain = await import("./targetBrain");
        const action = typeof args.action === "string" ? args.action : "brief";
        const target = typeof args.target === "string" ? args.target : "";
        if (action === "list" || (!target && action !== "list")) return action === "list" ? brain.brainListText(ctx.rawUser) : "Error: target wajib untuk action=brief/forget/note/coverage (mis. target=host.tld).";
        if (action === "forget") return brain.brainForget(ctx.rawUser, target) ? `🧠 Target brain ${target} direset.` : `Tidak ada data untuk ${target}.`;
        if (action === "coverage") return await brain.brainCoverage(ctx.rawUser, target);
        if (action === "note") {
          const note = typeof args.note === "string" ? args.note : "";
          if (!note) return "Error: note wajib untuk action=note.";
          brain.brainNote(ctx.rawUser, target, note);
          return `🧠 Catatan tersimpan untuk ${target}.`;
        }
        return brain.brainBrief(ctx.rawUser, target);
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "target_brain failed"}`;
      }
    },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "retest_list", description: "Daftar retest case (regression suite): temuan terbukti + signature rentan untuk di-recheck kapan pun. Opsi `target` (host) untuk filter. Read/auto.", parameters: { type: "object", properties: { target: { type: "string" } }, required: [] } } },
    execute: async (args, ctx) => { try { const { retestListText } = await import("./retest"); return retestListText(ctx.rawUser, { target: typeof args.target === "string" ? args.target : undefined }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "retest_list failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "retest_add", description: "Simpan/edit retest case manual: request + signature respons RENTAN (expect_contains/expect_status). Dipakai saat temuan belum punya case. (finding_add dengan retest_url+retest_expect membuat case OTOMATIS.) Write, confirm.", parameters: { type: "object", properties: { title: { type: "string" }, url: { type: "string" }, method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] }, headers: { type: "object" }, body: { type: "string" }, session: { type: "string", description: "nama http_session" }, expect_contains: { type: "string", description: "substring pada respons VULNERABLE" }, expect_status: { type: "number", description: "status respons vulnerable (0 = abaikan)" }, finding_id: { type: "string" }, severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"] } }, required: ["title", "url"] } } },
    execute: async (args, ctx) => {
      try {
        const { retestSave } = await import("./retest");
        const c = retestSave(ctx.rawUser, {
          title: String(args.title || ""),
          url: String(args.url || ""),
          method: typeof args.method === "string" ? args.method : undefined,
          headers: args.headers && typeof args.headers === "object" ? (args.headers as Record<string, string>) : undefined,
          body: typeof args.body === "string" ? args.body : undefined,
          session: typeof args.session === "string" ? args.session : undefined,
          expect_contains: typeof args.expect_contains === "string" ? args.expect_contains : undefined,
          expect_status: asNumber(args.expect_status),
          findingId: typeof args.finding_id === "string" ? args.finding_id : undefined,
          severity: typeof args.severity === "string" ? args.severity : undefined,
        });
        return `♻️ Retest case tersimpan ${c.id} — ${c.title}\n   ${c.method} ${c.url}\n   expect: ${c.expect_contains || `(status ${c.expect_status || "2xx"})`}\nJalankan ulang kapan pun: retest_run id=${c.id} (atau per target).`;
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "retest_add failed"}`;
      }
    },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "retest_run", description: "Jalankan retest case (id) atau SEMUA case per target → verdict 🔴 masih rentan / 🟢 sudah dipatch / ⚪ error. Ini cara 'sudah dipatch belum?' dijawab dalam satu perintah (fix-verification). Scope-gated per case. Write, confirm.", parameters: { type: "object", properties: { id: { type: "string", description: "id case, mis. R-..." }, target: { type: "string", description: "host — jalankan semua case target itu" } }, required: [] } } },
    execute: async (args, ctx) => { try { const { retestRun } = await import("./retest"); return await retestRun(ctx.rawUser, { id: typeof args.id === "string" ? args.id : undefined, target: typeof args.target === "string" ? args.target : undefined }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "retest_run failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "auth_matrix", description: "Matriks otorisasi N-role: iterasi SEMUA http_session (+ anonymous) × endpoint, deteksi akses lintas-role & anonymous-access. Upgrade bola_diff (2 sesi) ke matriks penuh. sessions=list,name (urutan = hak akses turun); endpoints=list,url. Bounded ≤6×6, 1 request/pasangan. Write, confirm.", parameters: { type: "object", properties: { endpoints: { type: "array", description: "URL/paths, mis. [\"/api/dokumen?id=1\",\"/api/admin\"]" }, sessions: { type: "array", description: "nama http_session, mis. [\"admin\",\"user\",\"guest\"] — urutan pertama = paling berprivilege" }, base_url: { type: "string", description: "prefix bila endpoints berupa path relatif" }, granted_status_max: { type: "number", description: "status yang dianggap 'diberikan akses' (default 399)" } }, required: ["endpoints", "sessions"] } } },
    execute: async (args, ctx) => { try { const { authMatrix } = await import("./authMatrix"); return await authMatrix(ctx.rawUser, { endpoints: args.endpoints, sessions: args.sessions, base_url: typeof args.base_url === "string" ? args.base_url : undefined, granted_status_max: asNumber(args.granted_status_max) }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "auth_matrix failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "dom_taint", description: "Analisis taint DOM-XSS (statik): trace location.hash/search/postMessage/referrer → innerHTML/eval/Function/document.write di bundle JS target, tandai aliran TANPA sanitizer. Input `url` (scope-gated) atau `text` (isi bundle dari js_mine). Hasil = statik, WAJIB verifikasi manual sebelum finding_add. Write, confirm.", parameters: { type: "object", properties: { url: { type: "string", description: "halaman HTML atau file .js (scope-gated)" }, text: { type: "string", description: "isi bundle JS (dari js_mine) — tanpa jaringan" }, file_label: { type: "string", description: "label file untuk text" } }, required: [] } } },
    execute: async (args, ctx) => { try { const { domTaint } = await import("./domTaint"); return await domTaint(ctx.rawUser, { url: typeof args.url === "string" ? args.url : undefined, text: typeof args.text === "string" ? args.text : undefined, file_label: typeof args.file_label === "string" ? args.file_label : undefined }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "dom_taint failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "learning_ingest", description: "Belajar dari report disclosed: tempel `text` writeup atau `url` artikel publik → pattern (kelas vuln, tech, endpoint style, trik, detection) tersimpan & bisa di-query saat hunt target serupa. Simpan PATTERN saja (bukan kredensial). Read/auto.", parameters: { type: "object", properties: { text: { type: "string", description: "isi report/writeup" }, url: { type: "string", description: "URL artikel publik" }, title: { type: "string" } }, required: [] } } },
    execute: async (args, ctx) => { try { const { learningIngest } = await import("./learning"); return await learningIngest(ctx.rawUser, { text: typeof args.text === "string" ? args.text : undefined, url: typeof args.url === "string" ? args.url : undefined, title: typeof args.title === "string" ? args.title : undefined }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "learning_ingest failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "learning_query", description: "Query pattern dari report disclosed yang cocok dengan target sekarang (tech/endpoint style/vuln_class) — hint 'target seperti ini biasanya kena X via Y' SEBELUM hunting. Tanpa arg = statistik. Read/auto.", parameters: { type: "object", properties: { query: { type: "string", description: "mis. tech=laravel, /api/v1/, graphql" }, vuln_class: { type: "string", description: "mis. idor, ssrf, jwt" } }, required: [] } } },
    execute: async (args, ctx) => {
      try {
        const learning = await import("./learning");
        const q = typeof args.query === "string" ? args.query.trim() : "";
        const vc = typeof args.vuln_class === "string" ? args.vuln_class.trim() : "";
        if (!q && !vc) return learning.learningStatsText(ctx.rawUser);
        return learning.learningQuery(ctx.rawUser, { query: q || undefined, vuln_class: vc || undefined });
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "learning_query failed"}`;
      }
    },
  },
  // ── Tier-1 attack suite (race/graphql/cache/xxe/redirect/ws/github/har) ──
  {
    definition: { type: "function", risk: "write", function: { name: "race_attack", description: "Race-condition pro (upgrade `race`): N request paralel + NONCE unik per request (placeholder {{NONCE}} di url/body) untuk bukti duplicate-creation (kupon/withdraw/registrasi dobel), plus deteksi outcome tidak deterministik (TOCTOU). count ≤30 — bukan DoS. Scope-gated. Write, confirm.", parameters: { type: "object", properties: { url: { type: "string", description: "URL; boleh memuat {{NONCE}}" }, method: { type: "string" }, body: { type: "string", description: "body; boleh memuat {{NONCE}}" }, headers: { type: "object" }, count: { type: "number", description: "2-30 (default 10)" }, nonce: { type: "boolean", description: "default true — value unik per request" }, session: { type: "string", description: "nama http_session (opsional)" } }, required: ["url"] } } },
    execute: async (args, ctx) => { try { const { raceAttackPro } = await import("./proAttack"); return await raceAttackPro(ctx.rawUser, { url: String(args.url || ""), method: typeof args.method === "string" ? args.method : undefined, body: typeof args.body === "string" ? args.body : undefined, headers: args.headers && typeof args.headers === "object" ? (args.headers as Record<string, string>) : undefined, count: typeof args.count === "number" ? args.count : undefined, nonce: typeof args.nonce === "boolean" ? args.nonce : undefined, session: typeof args.session === "string" ? args.session : undefined }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "race_attack failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "graphql_hunt", description: "GraphQL deep probe: introspection → (kalau diblokir) field-suggestion mining 'Did you mean' → alias ganda → JSON-array BATCHING abuse → depth/complexity probe → GET-query support. `session` (http_session) untuk uji terautentikasi. Scope-gated. Write, confirm.", parameters: { type: "object", properties: { url: { type: "string", description: "endpoint GraphQL (POST)" }, session: { type: "string" }, depth: { type: "number", description: "kedalaman depth probe (default 25, maks 50)" } }, required: ["url"] } } },
    execute: async (args, ctx) => { try { const { graphqlHunt } = await import("./graphqlHunt"); return await graphqlHunt(ctx.rawUser, { url: String(args.url || ""), session: typeof args.session === "string" ? args.session : undefined, depth: typeof args.depth === "number" ? args.depth : undefined }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "graphql_hunt failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "cache_poison_prover", description: "Web cache poisoning prover: matriks header (X-Forwarded-Host/X-Host/X-Original-URL/X-Rewrite-URL/X-Forwarded-Scheme/Port), fat GET, refleksi param umum; deteksi header cache (x-cache/age/cf-cache-status/…). `callback` (OAST) membuat marker terverifikasi OOB. Pantulan + cacheable = kandidat kuat. Scope-gated. Write, confirm.", parameters: { type: "object", properties: { url: { type: "string" }, callback: { type: "string", description: "URL OAST (oast_create) — opsional" }, params: { type: "array", description: "param refleksi (default utm_*/callback/next/redirect/url)" }, session: { type: "string" } }, required: ["url"] } } },
    execute: async (args, ctx) => { try { const { cachePoisonProver } = await import("./proAttack"); return await cachePoisonProver(ctx.rawUser, { url: String(args.url || ""), callback: typeof args.callback === "string" ? args.callback : undefined, params: asStringArray(args.params), session: typeof args.session === "string" ? args.session : undefined }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "cache_poison_prover failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "xxe_chain", description: "XXE chain: auto-OAST callback → 4 payload (file-read /etc/passwd inline, OOB entity, param-entity OOB, PHP filter) → kirim ke endpoint XML → klasifikasi sinyal (passwd leak/parser aktif) → oast_poll bukti OOB. `body_template` berisi {XXE} untuk penempatan presisi. Scope-gated. Write, confirm.", parameters: { type: "object", properties: { url: { type: "string", description: "endpoint yang menerima XML" }, method: { type: "string" }, body_template: { type: "string", description: "template body dgn marker {XXE} (opsional)" }, content_type: { type: "string", description: "default application/xml" }, callback: { type: "string", description: "URL OAST (auto-create jika kosong)" }, session: { type: "string" } }, required: ["url"] } } },
    execute: async (args, ctx) => { try { const { xxeChain } = await import("./proAttack"); return await xxeChain(ctx.rawUser, { url: String(args.url || ""), method: typeof args.method === "string" ? args.method : undefined, body_template: typeof args.body_template === "string" ? args.body_template : undefined, content_type: typeof args.content_type === "string" ? args.content_type : undefined, callback: typeof args.callback === "string" ? args.callback : undefined, session: typeof args.session === "string" ? args.session : undefined }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "xxe_chain failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "open_redirect_chain", description: "Open-redirect chain: param × payload matrix (8 payload bypass, 19 param umum) → verdict Location EKSTERNAL vs refleksi client-side; `session` untuk cek token-leak di redirect; `callback` OAST untuk konfirmasi. Redirect eksternal terkonfirmasi = siap poc_verify. Scope-gated. Write, confirm.", parameters: { type: "object", properties: { url: { type: "string", description: "URL + param redirect (atau auto-param)" }, params: { type: "array" }, callback: { type: "string", description: "URL OAST (opsional)" }, session: { type: "string" }, method: { type: "string" }, body: { type: "string" } }, required: ["url"] } } },
    execute: async (args, ctx) => { try { const { openRedirectChain } = await import("./proAttack"); return await openRedirectChain(ctx.rawUser, { url: String(args.url || ""), params: asStringArray(args.params), callback: typeof args.callback === "string" ? args.callback : undefined, session: typeof args.session === "string" ? args.session : undefined, method: typeof args.method === "string" ? args.method : undefined, body: typeof args.body === "string" ? args.body : undefined }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "open_redirect_chain failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "ws_hunt", description: "WebSocket hunt (upgrade `ws_probe`): handshake RAW dgn Origin arbitrary → verdict validasi Origin (CSWSH kandidat bila Origin evil diterima), frame awal, + opsi `tab` (CDP): handshake dari browser user dgn cookie ASLI = bukti CSWSH penuh. Scope-gated. Write, confirm.", parameters: { type: "object", properties: { url: { type: "string", description: "ws:// atau wss://" }, message: { type: "string", description: "frame awal (opsional)" }, tab: { type: "string", description: "match URL tab Chrome (CDP) untuk bukti cookie asli" } }, required: ["url"] } } },
    execute: async (args, ctx) => { try { const { wsHunt } = await import("./wsHunt"); return await wsHunt(ctx.rawUser, { url: String(args.url || ""), message: typeof args.message === "string" ? args.message : undefined, tab: typeof args.tab === "string" ? args.tab : undefined }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "ws_hunt failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "github_osint", description: "GitHub OSINT keyless: action=code (grep.app public search untuk `domain`/`q` — kredensial bocor di repo publik) atau action=commits (riwayat commit repo publik `owner/name`, pindai diff untuk secret yang MASUK di history — key rotate tapi lama masih ada). Nilai rahasia selalu DISENSUR. Read, auto.", parameters: { type: "object", properties: { action: { type: "string", enum: ["code", "commits"] }, domain: { type: "string", description: "target domain untuk dork (action=code)" }, q: { type: "string", description: "query manual (action=code)" }, repo: { type: "string", description: "owner/name atau URL github (action=commits)" }, max: { type: "number" } }, required: [] } } },
    execute: async (args) => { try { const { githubOsint } = await import("./githubOsint"); return await githubOsint(undefined, { action: typeof args.action === "string" ? args.action : undefined, domain: typeof args.domain === "string" ? args.domain : undefined, q: typeof args.q === "string" ? args.q : undefined, repo: typeof args.repo === "string" ? args.repo : undefined, max: typeof args.max === "number" ? args.max : undefined }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "github_osint failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "har_import", description: "Tempel isi HAR (DevTools → Network → Save all as HAR) → inventaris endpoint, param terbanyak, header auth (dimask), union cookie host → simpan jadi http_session (`save_session`) siap dipakai bola_diff/auth_matrix/http_request. Read, auto.", parameters: { type: "object", properties: { text: { type: "string", description: "isi file HAR (JSON)" }, save_session: { type: "string", description: "nama session untuk cookie union" }, host: { type: "string", description: "host spesifik (default host pertama)" } }, required: ["text"] } } },
    execute: async (args, ctx) => { try { const { harImport } = await import("./harImport"); return await harImport(ctx.rawUser, { text: String(args.text || ""), save_session: typeof args.save_session === "string" ? args.save_session : undefined, host: typeof args.host === "string" ? args.host : undefined }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "har_import failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "prompt_injection_hunt", description: "Uji LLM-app target: system-prompt leak (repeat instructions), indirect injection dgn beacon OAST (bukti via oast_poll), tool-call bait, guardrail bypass. Baseline-controlled (marker yang sudah ada di respons normal tidak dianggap sinyal). Scope-gated, ≤40 request. Write, confirm. Bukti → poc_verify → finding_add (OWASP LLM01/LLM02).", parameters: { type: "object", properties: { url: { type: "string", description: "Endpoint chat/completion target, mis. http://127.0.0.1:4010/api/ask" }, param: { type: "string", description: "Nama param utk metode GET (default q)" }, method: { type: "string", enum: ["GET", "POST"], description: "POST default (JSON body {body_field: payload})" }, body_field: { type: "string", description: "Nama field JSON utk POST (default message)" }, callback: { type: "string", description: "URL OAST (dari oast_create) — wajib utk kelas indirect" }, classes: { type: "array", description: "leak/indirect/toolbait/bypass (opsional; default semua yang bisa)" }, session: { type: "string", description: "Nama http_session utk cookie (opsional)" } }, required: ["url"] } } },
    execute: async (args, ctx) => { try { const { promptInjectionHunt } = await import("./promptInjection"); const classes = asStringArray(args.classes); return await promptInjectionHunt(ctx.rawUser, { url: String(args.url || ""), param: typeof args.param === "string" ? args.param : undefined, method: typeof args.method === "string" ? args.method : undefined, body_field: typeof args.body_field === "string" ? args.body_field : undefined, callback: typeof args.callback === "string" ? args.callback : undefined, classes, session: typeof args.session === "string" ? args.session : undefined }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "prompt_injection_hunt failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "llm_hunt", description: "Red-team harness LLM-app (melengkapi prompt_injection_hunt): 5 kelas — jailbreak (DAN/UnGPT/encoding, marker game-on + refusal hilang vs baseline), rag (injection LEWAT retrieved-doc: marker vektor ditaati = LLM08), agency (tool kuat tanpa konfirmasi: send_email/delete_user/transfer/exec — marker echo atau tool-call JSON), exfil (canary rahasia di-seed, echo di respons = bocor STRONG, bukti OOB via oast_poll), pii (NIK/email seed echo = disclosure). Auto-map OWASP LLM Top 10 2025 (LLM01–LLM11). Baseline-controlled, ≤40 request, scope-gated. Write, confirm. Bukti → poc_verify → finding_add.", parameters: { type: "object", properties: { url: { type: "string", description: "Endpoint chat/completion target, mis. http://127.0.0.1:4010/api/ask" }, param: { type: "string", description: "Nama param utk metode GET (default q)" }, method: { type: "string", enum: ["GET", "POST"], description: "POST default (JSON body {body_field: payload})" }, body_field: { type: "string", description: "Nama field JSON utk POST (default message)" }, callback: { type: "string", description: "URL OAST (dari oast_create) — utk rag/exfil supaya ada bukti beacon" }, classes: { type: "array", description: "jailbreak/rag/agency/exfil/pii (opsional; default semua)" }, session: { type: "string", description: "Nama http_session utk cookie (opsional)" }, seed: { type: "string", description: "Canary token tetap utk replikasi (opsional; default acak)" } }, required: ["url"] } } },
    execute: async (args, ctx) => { try { const { llmHunt } = await import("./llmHunt"); const classes = asStringArray(args.classes); return await llmHunt(ctx.rawUser, { url: String(args.url || ""), param: typeof args.param === "string" ? args.param : undefined, method: typeof args.method === "string" ? args.method : undefined, body_field: typeof args.body_field === "string" ? args.body_field : undefined, callback: typeof args.callback === "string" ? args.callback : undefined, classes, session: typeof args.session === "string" ? args.session : undefined, seed: typeof args.seed === "string" ? args.seed : undefined }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "llm_hunt failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "mcp_hunt", description: "Audit server MCP (Model Context Protocol, JSON-RPC 2.0): discovery endpoint (root,/mcp,/sse + SSE legacy) → initialize → tools/list/resources/list/prompts/list → sinyal: anon-access (inventaris tanpa auth), sensitive-tool terekspos (exec/delete/transfer — TIDAK dipanggil), arg injection (marker di param string tool non-sensitif, echo = input→output tanpa sanitasi, callback OAST utk bukti), resource scan (secret ter-redact + marker instruksi-injeksi). MCP = surface SUPPLY-CHAIN (LLM03) — output tool & konten resource dikonsumsi LLM. Scope-gated, ≤40 request. Write, confirm. Bukti → poc_verify → finding_add.", parameters: { type: "object", properties: { url: { type: "string", description: "Endpoint MCP, mis. http://127.0.0.1:4010/mcp atau origin (auto-probe /mcp,/sse)" }, session: { type: "string", description: "Nama http_session utk cookie (opsional)" }, callback: { type: "string", description: "URL OAST utk arg-injection (opsional)" }, seed: { type: "string", description: "Marker tetap utk replikasi (opsional; default acak)" } }, required: ["url"] } } },
    execute: async (args, ctx) => { try { const { mcpHunt } = await import("./mcpHunt"); return await mcpHunt(ctx.rawUser, { url: String(args.url || ""), session: typeof args.session === "string" ? args.session : undefined, callback: typeof args.callback === "string" ? args.callback : undefined, seed: typeof args.seed === "string" ? args.seed : undefined }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "mcp_hunt failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "content_discover", description: "Content discovery aktif (scope-gated): robots.txt/sitemap, link halaman, endpoint dari file JS, + probe path umum (mis. /admin,/.env,/swagger.json). Hanya lab/engagement. Write, confirm.", parameters: { type: "object", properties: { url: { type: "string", description: "mis. http://127.0.0.1:4010 atau https://app.klien.com" } }, required: ["url"] } } },
    execute: async (args, ctx) => { try { const { contentDiscover } = await import("./recon"); const out = await contentDiscover(ctx.rawUser, String(args.url || "")); try { const { brainRecordEndpoints } = await import("./targetBrain"); const paths = [...out.matchAll(/^•\s(\/.+)$/gm)].map((m) => m[1]); brainRecordEndpoints(ctx.rawUser, String(args.url || ""), paths.slice(0, 60)); } catch { /* best-effort */ } return out; } catch (e) { return `Error: ${e instanceof Error ? e.message : "content_discover failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "param_fuzz", description: "Fuzz parameter URL dgn payload (XSS/SQLi/SSTI/redirect/cmdi) → deteksi reflection, SQL error, eval 7*7, open-redirect, timing. Scope-gated, low-rate. Opsi `callback` (dari oast_create) menambah kelas SSRF. Write, confirm.", parameters: { type: "object", properties: { url: { type: "string", description: "URL dgn param, mis. http://127.0.0.1:4010/greet?name=x" }, params: { type: "array", description: "Param spesifik (opsional; default dari URL)" }, classes: { type: "array", description: "xss/sqli/ssti/redirect/cmdi/ssrf (opsional)" }, method: { type: "string", enum: ["GET", "POST"] }, callback: { type: "string", description: "URL OAST untuk kelas ssrf (opsional)" } }, required: ["url"] } } },
    execute: async (args) => { try { const { paramFuzz } = await import("./paramFuzz"); const params = asStringArray(args.params); const classes = asStringArray(args.classes); return await paramFuzz(undefined, { url: String(args.url || ""), params, classes, method: typeof args.method === "string" ? args.method : undefined, callback: typeof args.callback === "string" ? args.callback : undefined }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "param_fuzz failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "js_deobfuscate", description: "Mining JS bundle yang SADAR-obfuscasi: string-array webpack/obfuscator.io diganti literal (eval-free), string concat dilipat, source map .map yang ter-publish dipulihkan (source asli, file/line asli) → endpoint + secret yang tidak terlihat js_mine biasa. Bisa arahkan ke halaman HTML atau langsung ke file .js. Read, auto, scope-gated.", parameters: { type: "object", properties: { url: { type: "string", description: "URL halaman HTML atau file .js (lab/engagement berizin)" } }, required: ["url"] } } },
    execute: async (args, ctx) => { try { const { deobfuscateAndMine } = await import("./jsDeobfuscate"); return await deobfuscateAndMine(ctx.rawUser, String(args.url || "")); } catch (e) { return `Error: ${e instanceof Error ? e.message : "js_deobfuscate failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "jwt_attack", description: "Toolkit JWT: decode, forge alg:none, HS256 (secret), alg-confusion (public key), crack secret HS256 lemah. Lokal (tanpa jaringan). Read, auto. Uji token hasilnya via http_request ke target berizin.", parameters: { type: "object", properties: { action: { type: "string", enum: ["decode", "none", "hs256", "confusion", "crack"] }, token: { type: "string" }, secret: { type: "string" }, publicKey: { type: "string", description: "PEM kunci publik server (untuk confusion)" }, claims: { type: "string", description: "JSON claim override, mis. {\"role\":\"admin\"}" }, words: { type: "string", description: "kata tambahan untuk crack" } }, required: ["action"] } } },
    execute: async (args) => { try { const { jwtAttack } = await import("./jwt"); return jwtAttack({ action: String(args.action || ""), token: typeof args.token === "string" ? args.token : undefined, secret: typeof args.secret === "string" ? args.secret : undefined, publicKey: typeof args.publicKey === "string" ? args.publicKey : undefined, claims: typeof args.claims === "string" ? args.claims : undefined, words: typeof args.words === "string" ? args.words : undefined }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "jwt_attack failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "evidence_capture", description: "Simpan bukti laporan: raw HTTP request/response (`request`) dan/atau screenshot halaman (`url`) ke reports/evidence/. Scope-gated. Write, confirm.", parameters: { type: "object", properties: { url: { type: "string", description: "URL untuk screenshot full-page" }, request: { type: "object", description: "{\"url\":\"...\",\"method\":\"GET\",\"headers\":{},\"body\":\"\"} untuk raw HTTP" } }, required: [] } } },
    execute: async (args, ctx) => {
      try {
        const { evidenceCapture } = await import("./evidence");
        const r = (args.request && typeof args.request === "object") ? (args.request as { url?: unknown; method?: unknown; headers?: unknown; body?: unknown }) : undefined;
        const request = r && typeof r.url === "string" ? { url: r.url, method: typeof r.method === "string" ? r.method : undefined, headers: r.headers && typeof r.headers === "object" ? (r.headers as Record<string, string>) : undefined, body: typeof r.body === "string" ? r.body : undefined } : undefined;
        return await evidenceCapture(ctx.rawUser, { url: typeof args.url === "string" ? args.url : undefined, request });
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "evidence_capture failed"}`;
      }
    },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "scope_import", description: "Parse scope program bug bounty (tempel `text` daftar Targets, atau `url` halaman policy publik) → daftar in-scope/out-of-scope + saran engagement_create. Read, auto.", parameters: { type: "object", properties: { text: { type: "string", description: "Tempel bagian Targets / In scope dari program" }, url: { type: "string", description: "URL halaman policy/targets publik (opsional)" } }, required: [] } } },
    execute: async (args) => { try { const { scopeImport } = await import("./scopeImport"); return await scopeImport({ text: typeof args.text === "string" ? args.text : undefined, url: typeof args.url === "string" ? args.url : undefined }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "scope_import failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "crawl", description: "Crawl same-origin (BFS terbatas): halaman, path, form + field, file JS. Scope-gated. Opsi maxPages (≤60) & depth (≤3). Write, confirm.", parameters: { type: "object", properties: { url: { type: "string" }, maxPages: { type: "number" }, depth: { type: "number" } }, required: ["url"] } } },
    execute: async (args, ctx) => { try { const { crawlSite } = await import("./recon"); return await crawlSite(ctx.rawUser, String(args.url || ""), typeof args.maxPages === "number" ? args.maxPages : 30, typeof args.depth === "number" ? args.depth : 2); } catch (e) { return `Error: ${e instanceof Error ? e.message : "crawl failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "param_discover", description: "Cari parameter tersembunyi: probe ~100 nama param umum, flag bila respons berubah/reflect. Scope-gated. Write, confirm.", parameters: { type: "object", properties: { url: { type: "string" }, names: { type: "array", description: "Nama param kustom (opsional)" }, method: { type: "string", enum: ["GET", "POST"] } }, required: ["url"] } } },
    execute: async (args) => { try { const { paramDiscover } = await import("./paramFuzz"); return await paramDiscover(undefined, { url: String(args.url || ""), names: asStringArray(args.names), method: typeof args.method === "string" ? args.method : undefined }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "param_discover failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "recon_diff", description: "Bandingkan subdomain cache vs sekarang → tandai aset BARU/hilang (pasif, CT). Read, auto.", parameters: { type: "object", properties: { domain: { type: "string" } }, required: ["domain"] } } },
    execute: async (args, ctx) => { try { const { reconDiff } = await import("./recon"); return await reconDiff(ctx.rawUser, String(args.domain || "")); } catch (e) { return `Error: ${e instanceof Error ? e.message : "recon_diff failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "recon_screenshot", description: "Visual recon: screenshot host hidup (dari cache recon_httpx via `domain`, atau `hosts` eksplisit spt 127.0.0.1:4010) ke reports/evidence/. Scope-gated (≤12 host). Write, confirm.", parameters: { type: "object", properties: { domain: { type: "string", description: "FQDN (opsional bila `hosts` diisi)" }, hosts: { type: "array", description: "Host spesifik (opsional)" } }, required: [] } } },
    execute: async (args, ctx) => { try { const { reconScreenshot } = await import("./recon"); return await reconScreenshot(ctx.rawUser, String(args.domain || ""), asStringArray(args.hosts)); } catch (e) { return `Error: ${e instanceof Error ? e.message : "recon_screenshot failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "request_save", description: "Kelola koleksi request + variabel {{x}}: action set (name + method/url/headers/body) | list | delete. Read, auto.", parameters: { type: "object", properties: { action: { type: "string", enum: ["set", "list", "delete"] }, name: { type: "string" }, method: { type: "string" }, url: { type: "string", description: "mis. {{base}}/api/users/{{id}}" }, headers: { type: "object" }, body: { type: "string" } }, required: ["action"] } } },
    execute: async (args, ctx) => {
      try {
        const m = await import("./requests");
        const a = String(args.action || "").toLowerCase();
        if (a === "list") return m.requestListText(ctx.rawUser);
        const name = String(args.name || "");
        if (a === "delete") return m.requestDelete(ctx.rawUser, name) ? `🗑️ request "${name}" dihapus.` : `Request "${name}" tidak ada.`;
        if (a === "set") {
          const r = m.requestSave(ctx.rawUser, name, { method: typeof args.method === "string" ? args.method : undefined, url: typeof args.url === "string" ? args.url : undefined, headers: args.headers && typeof args.headers === "object" ? (args.headers as Record<string, string>) : undefined, body: asBodyString(args.body) });
          return `🗂️ request "${name}" disimpan: ${r.method} ${r.url}`;
        }
        return "Error: action harus set|list|delete.";
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "request_save failed"}`;
      }
    },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "request_run", description: "Jalankan request tersimpan dgn substitusi variabel {{x}} (vars={...}). Scope-gated. Write, confirm.", parameters: { type: "object", properties: { name: { type: "string" }, vars: { type: "object", description: "mis. {\"base\":\"https://app.x\",\"id\":\"42\"}" }, method: { type: "string" }, url: { type: "string" }, headers: { type: "object" }, body: { type: "string" } }, required: ["name"] } } },
    execute: async (args, ctx) => { try { const { requestRun } = await import("./requests"); return await requestRun(ctx.rawUser, String(args.name || ""), { vars: args.vars && typeof args.vars === "object" ? (args.vars as Record<string, string>) : undefined, method: typeof args.method === "string" ? args.method : undefined, url: typeof args.url === "string" ? args.url : undefined, headers: args.headers && typeof args.headers === "object" ? (args.headers as Record<string, string>) : undefined, body: asBodyString(args.body) }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "request_run failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "platform_severity", description: "Map CVSS (angka/vektor) atau severity → severity HackerOne + prioritas Bugcrowd VRT (P1-P5). Read, auto.", parameters: { type: "object", properties: { cvss: { type: "number" }, vector: { type: "string" }, severity: { type: "string" } }, required: [] } } },
    execute: async (args) => { try { const { platformSeverity } = await import("./security"); return platformSeverity({ cvss: asNumber(args.cvss), vector: typeof args.vector === "string" ? args.vector : undefined, severity: typeof args.severity === "string" ? args.severity : undefined }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "platform_severity failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "js_mine", description: "Mining file JS (scope-gated): ekstrak endpoint/path + indikasi secret/token (nilai di-redact) dari bundle. Write, confirm. PENTING: js_mine hanya grep teks mentah — kalau bundle minified/besar dan hasilnya kosong atau hanya sedikit endpoint, LANGSUNG lanjutkan dengan `js_deobfuscate` (membaca string-array obfuscator.io, concat, dan source map yang js_mine tidak lihat); jangan menyimpulkan 'tidak ada endpoint' sebelum js_deobfuscate dicoba.", parameters: { type: "object", properties: { url: { type: "string", description: "Halaman HTML atau file .js" } }, required: ["url"] } } },
    execute: async (args, ctx) => { try { const { jsMine } = await import("./recon"); const out = await jsMine(ctx.rawUser, String(args.url || "")); try { const { brainRecordEndpoints } = await import("./targetBrain"); const paths = [...out.matchAll(/^[•]\s(\/.+)$/gm)].map((m) => m[1]).slice(0, 60); brainRecordEndpoints(ctx.rawUser, String(args.url || ""), paths); } catch { /* best-effort */ } return out; } catch (e) { return `Error: ${e instanceof Error ? e.message : "js_mine failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "api_spec", description: "Enumerasi endpoint dari spec OpenAPI/Swagger atau Postman (JSON): `path` (file sandbox), `url` (publik/target), atau `text`. Read, auto.", parameters: { type: "object", properties: { path: { type: "string" }, url: { type: "string" }, text: { type: "string" } }, required: [] } } },
    execute: async (args) => { try { const { apiSpec } = await import("./apiSpec"); return await apiSpec({ path: typeof args.path === "string" ? args.path : undefined, url: typeof args.url === "string" ? args.url : undefined, text: typeof args.text === "string" ? args.text : undefined }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "api_spec failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "graphql_probe", description: "GraphQL introspection (scope-gated): daftar query/mutation; deteksi bila introspection dilarang. Write, confirm.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
    execute: async (args) => { try { const { graphqlProbe } = await import("./apiSpec"); return await graphqlProbe(String(args.url || "")); } catch (e) { return `Error: ${e instanceof Error ? e.message : "graphql_probe failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "cve_intel", description: "Intel CVE/exploit (keyless): NVD keyword search + searchsploit (bila terpasang). Read, auto. Untuk 'CVE apache 2.4.7', 'exploit untuk X'.", parameters: { type: "object", properties: { query: { type: "string", description: "produk/versi/keyword" } }, required: ["query"] } } },
    execute: async (args) => { try { const { cveIntel } = await import("./cveIntel"); return await cveIntel(String(args.query || "")); } catch (e) { return `Error: ${e instanceof Error ? e.message : "cve_intel failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "recon_dnsbrute", description: "DNS brute pasif (native, keyless): ~120 nama subdomain umum → host yang resolve (+ cek wildcard). Read, auto.", parameters: { type: "object", properties: { domain: { type: "string" } }, required: ["domain"] } } },
    execute: async (args, ctx) => { try { const { reconDnsBrute } = await import("./recon"); return await reconDnsBrute(ctx.rawUser, String(args.domain || "")); } catch (e) { return `Error: ${e instanceof Error ? e.message : "recon_dnsbrute failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "recon_ports", description: "Cek port umum (native TCP connect) pada host ber-scope. Opsi `ports`. Write, confirm.", parameters: { type: "object", properties: { host: { type: "string", description: "mis. 127.0.0.1 atau example.com" }, ports: { type: "array", description: "Port spesifik (opsional)" } }, required: ["host"] } } },
    execute: async (args) => { try { const { reconPorts } = await import("./recon"); const ports = Array.isArray(args.ports) ? args.ports.map((x) => Number(x)).filter((n) => Number.isInteger(n)) : undefined; return await reconPorts(undefined, String(args.host || ""), ports); } catch (e) { return `Error: ${e instanceof Error ? e.message : "recon_ports failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "bucket_enum", description: "Enum bucket S3/GCS dari nama domain (keyless, scope-gated): kandidat nama → deteksi bucket ada/publik. Write, confirm.", parameters: { type: "object", properties: { domain: { type: "string" }, names: { type: "array", description: "Nama bucket tambahan (opsional)" } }, required: ["domain"] } } },
    execute: async (args) => { try { const { bucketEnum } = await import("./recon"); return await bucketEnum(undefined, String(args.domain || ""), asStringArray(args.names)); } catch (e) { return `Error: ${e instanceof Error ? e.message : "bucket_enum failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "submission_track", description: "Tracker submission bounty: action add (title/severity/cvss/platform/url/status) | list | update (id + status/url) | delete (id). Read, auto.", parameters: { type: "object", properties: { action: { type: "string", enum: ["add", "list", "update", "delete"] }, id: { type: "string" }, title: { type: "string" }, severity: { type: "string" }, cvss: { type: "number" }, platform: { type: "string" }, url: { type: "string" }, status: { type: "string", enum: ["draft", "submitted", "triaged", "needs-info", "duplicate", "n/a", "resolved", "paid"] } }, required: ["action"] } } },
    execute: async (args, ctx) => { try { const { submissionTrack } = await import("./submissions"); return submissionTrack(ctx.rawUser, String(args.action || ""), { id: typeof args.id === "string" ? args.id : undefined, title: typeof args.title === "string" ? args.title : undefined, severity: typeof args.severity === "string" ? args.severity : undefined, cvss: asNumber(args.cvss), platform: typeof args.platform === "string" ? args.platform : undefined, url: typeof args.url === "string" ? args.url : undefined, status: typeof args.status === "string" ? args.status : undefined }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "submission_track failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "cors_audit", description: "Uji misconfiguration CORS (scope-gated): kirim Origin arbitrer + preflight OPTIONS, flag refleksi origin / wildcard+credentials / null. Write, confirm.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
    execute: async (args, ctx) => { try { const { corsAudit } = await import("./security"); return await corsAudit(String(args.url || ""), ctx.rawUser); } catch (e) { return `Error: ${e instanceof Error ? e.message : "cors_audit failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "csp_audit", description: "Audit pasif CSP (Content-Security-Policy): flag unsafe-inline/eval, wildcard, data:, tanpa object-src 'none'/frame-ancestors/base-uri. Read, auto.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
    execute: async (args) => { try { const { cspAudit } = await import("./security"); return await cspAudit(String(args.url || "")); } catch (e) { return `Error: ${e instanceof Error ? e.message : "csp_audit failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "http_history", description: "Riwayat request HTTP yang dikirim tool aktif (http_request/bola_diff/cors) — mirip log Burp. Read, auto.", parameters: { type: "object", properties: { limit: { type: "number" } }, required: [] } } },
    execute: async (args, ctx) => { try { const { httpHistoryText } = await import("./httpHistory"); return httpHistoryText(ctx.rawUser, typeof args.limit === "number" ? args.limit : 40); } catch (e) { return `Error: ${e instanceof Error ? e.message : "http_history failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "oast_dns_create", description: "Buat domain DNS-OAST unik (interactsh-client) untuk membuktikan blind bugs via DNS — blind SQLi/XXE OOB/SSRF-DNS/log4j. Read, auto.", parameters: { type: "object", properties: {}, required: [] } } },
    execute: async (_args, ctx) => { try { const { oastDnsCreate } = await import("./oastDns"); return await oastDnsCreate(ctx.rawUser); } catch (e) { return `Error: ${e instanceof Error ? e.message : "oast_dns_create failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "oast_dns_poll", description: "Cek interaksi DNS/HTTP yang masuk ke domain DNS-OAST (bukti out-of-band). Read, auto.", parameters: { type: "object", properties: {}, required: [] } } },
    execute: async (_args, ctx) => { try { const { oastDnsPoll } = await import("./oastDns"); return await oastDnsPoll(ctx.rawUser); } catch (e) { return `Error: ${e instanceof Error ? e.message : "oast_dns_poll failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "oast_dns_stop", description: "Hentikan DNS-OAST (interactsh-client). Read, auto.", parameters: { type: "object", properties: {}, required: [] } } },
    execute: async (_args, ctx) => { try { const { oastDnsStop } = await import("./oastDns"); return await oastDnsStop(ctx.rawUser); } catch (e) { return `Error: ${e instanceof Error ? e.message : "oast_dns_stop failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "rapyd_request", description: "Kirim request API Rapyd SANDBOX dengan signature HMAC otomatis (access_key/secret_key sandbox). RoE: sandbox-only. Write, confirm.", parameters: { type: "object", properties: { method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] }, path: { type: "string", description: "mis. /v1/payments atau /v1/customers" }, body: { type: "string", description: "Body JSON (opsional). Boleh string JSON, atau objek (otomatis di-stringify)." }, access_key: { type: "string" }, secret_key: { type: "string" }, base: { type: "string", description: "default https://sandboxapi.rapyd.net" } }, required: ["path", "access_key", "secret_key"] } } },
    execute: async (args, ctx) => { try { const { rapydRequest } = await import("./rapyd"); return await rapydRequest(ctx.rawUser, { method: typeof args.method === "string" ? args.method : undefined, path: String(args.path || ""), body: asBodyString(args.body), access_key: String(args.access_key || ""), secret_key: String(args.secret_key || ""), base: typeof args.base === "string" ? args.base : undefined }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "rapyd_request failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "race", description: "Uji RACE CONDITION: kirim N request identik paralel, bandingkan outcome (double-spend/idempotency). Scope-gated, count ≤30 (bukan DoS). Write, confirm.", parameters: { type: "object", properties: { url: { type: "string" }, method: { type: "string" }, body: { type: "string" }, headers: { type: "object" }, count: { type: "number", description: "2-30 (default 10)" } }, required: ["url"] } } },
    execute: async (args, ctx) => { try { const { raceAttack } = await import("./attack"); return await raceAttack(ctx.rawUser, { url: String(args.url || ""), method: typeof args.method === "string" ? args.method : undefined, body: asBodyString(args.body), headers: args.headers && typeof args.headers === "object" ? (args.headers as Record<string, string>) : undefined, count: asNumber(args.count) }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "race failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "ws_probe", description: "Probe endpoint WebSocket (ws/wss): handshake + frame awal (opsional kirim `message`). Scope-gated. Write, confirm.", parameters: { type: "object", properties: { url: { type: "string", description: "ws:// atau wss://" }, message: { type: "string", description: "pesan yang dikirim setelah open (opsional)" } }, required: ["url"] } } },
    execute: async (args, ctx) => { try { const { wsProbe } = await import("./attack"); return await wsProbe(ctx.rawUser, String(args.url || ""), typeof args.message === "string" ? args.message : undefined); } catch (e) { return `Error: ${e instanceof Error ? e.message : "ws_probe failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "security_hunt", description: "HUNT OTONOM satu host in-scope: jalankan header/cookie audit + CSP + CORS + content discovery + crawl + JS mining (+ param discovery bila deep) lalu rangkum LEADS. Scope-gated, bounded. Write, confirm.", parameters: { type: "object", properties: { url: { type: "string", description: "mis. https://app.klien.com" }, deep: { type: "boolean", description: "tambah param_discover (~100 request)" } }, required: ["url"] } } },
    execute: async (args, ctx) => { try { const { securityHunt } = await import("./hunt"); return await securityHunt(ctx.rawUser, String(args.url || ""), { deep: args.deep === true }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "security_hunt failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "hunt_log", description: "Memori hunt per-target (catat/lihat) supaya tidak mengulang jalan buntu. action=note (target+status+note+evidence) | list | get. status: todo/testing/dead/lead/finding. Read/auto, lokal tanpa jaringan — CEK `list` sebelum menguji target agar tidak mengulang yang sudah dead.", parameters: { type: "object", properties: { action: { type: "string", enum: ["note", "list", "get"], description: "default note" }, target: { type: "string", description: "mis. db.klien.com/admin (host[/path])" }, status: { type: "string", enum: ["todo", "testing", "dead", "lead", "finding"] }, note: { type: "string" }, evidence: { type: "string" } }, required: [] } } },
    execute: async (args, ctx) => {
      try {
        const { huntSet, huntListText, huntGetText } = await import("./huntLog");
        const action = String(args.action || (args.target ? "note" : "list"));
        if (action === "list") return huntListText(ctx.rawUser);
        if (action === "get") return huntGetText(ctx.rawUser, String(args.target || ""));
        return huntSet(ctx.rawUser, String(args.target || ""), String(args.status || "todo"), String(args.note || ""), String(args.evidence || ""));
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "hunt_log failed"}`;
      }
    },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "auth_hunt", description: "Probe permukaan alur auth satu host in-scope (login/register/forgot/reset/providers/csrf/openid) → status + redirect + flag cookie + CSP per path, lalu rangkum LEADS. Scope-gated, bounded. Write, confirm.", parameters: { type: "object", properties: { url: { type: "string", description: "mis. https://app.klien.com" } }, required: ["url"] } } },
    execute: async (args, ctx) => { try { const { authHunt } = await import("./hunt"); return await authHunt(ctx.rawUser, String(args.url || "")); } catch (e) { return `Error: ${e instanceof Error ? e.message : "auth_hunt failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "api_hunt", description: "Spec-driven API hunt: ambil OpenAPI/Postman JSON (url=spec, atau spec=JSON), enumerasi endpoint, probe masing-masing tanpa auth (opsional `session`) → flag endpoint sensitif yang jawab tanpa kredensial. Scope-gated, ≤20 endpoint. Write, confirm.", parameters: { type: "object", properties: { url: { type: "string", description: "URL spec / base API" }, spec: { type: "string", description: "JSON spec (bila tak mau fetch)" }, session: { type: "string", description: "nama http_session (opsional)" } }, required: ["url"] } } },
    execute: async (args, ctx) => { try { const { apiHunt } = await import("./hunt"); return await apiHunt(ctx.rawUser, String(args.url || ""), { spec: typeof args.spec === "string" ? args.spec : undefined, session: typeof args.session === "string" ? args.session : undefined }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "api_hunt failed"}`; } },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "suite_hunt", description: "Hunt satu host dalam SATU konfirmasi: security_hunt + auth_hunt (+ api_hunt bila ada spec/session), gabung jadi LEADS berprioritas, dan otomatis tulis hunt_log. Scope-gated, bounded. Write, confirm.", parameters: { type: "object", properties: { url: { type: "string", description: "mis. https://app.klien.com" }, deep: { type: "boolean", description: "tambah param_discover" }, spec: { type: "string", description: "OpenAPI/Postman JSON (opsional → aktifkan api_hunt)" }, session: { type: "string", description: "nama http_session (opsional)" } }, required: ["url"] } } },
    execute: async (args, ctx) => { try { const { suiteHunt } = await import("./hunt"); return await suiteHunt(ctx.rawUser, String(args.url || ""), { deep: args.deep === true, spec: typeof args.spec === "string" ? args.spec : undefined, session: typeof args.session === "string" ? args.session : undefined }); } catch (e) { return `Error: ${e instanceof Error ? e.message : "suite_hunt failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "engagement_targets", description: "Worklist host siap-uji dari semua engagement AKTIF (scope digabung status hunt_log) — mulai dari yang tanpa status/`todo`, skip yang `dead`. Read/auto, lokal tanpa jaringan.", parameters: { type: "object", properties: {}, required: [] } } },
    execute: async (_args, ctx) => { try { const { engagementTargetsText } = await import("./engagement"); return engagementTargetsText(ctx.rawUser); } catch (e) { return `Error: ${e instanceof Error ? e.message : "engagement_targets failed"}`; } },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "trivy_scan", description: "Scan CVE filesystem/image dengan trivy (keyless) di path sandbox. Read, auto. Install: brew install trivy.", parameters: { type: "object", properties: { dir: { type: "string", description: "Direktori (opsional; default repo)" } }, required: [] } } },
    execute: async (args) => { try { const { trivyScan } = await import("./security"); return await trivyScan(typeof args.dir === "string" ? args.dir : ""); } catch (e) { return `Error: ${e instanceof Error ? e.message : "trivy_scan failed"}`; } },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "health",
        description: "Track water/sleep (per-user JSON). water: minum X gelas, sleep: đi ngủ, wake: thức dậy/bangun, stats: thống kê. Auto, read (write water/sleep also auto, no confirm).",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", description: "water|sleep|wake|stats|update|delete", enum: ["water", "sleep", "wake", "stats", "update", "delete"] },
            cups: { type: "number", description: "Jumlah gelas untuk water/update" },
          },
          required: ["action"],
        },
      },
    },
    execute: (args, ctx) => {
      const a = String(args.action || "stats").toLowerCase();
      const cups = typeof args.cups === "number" ? args.cups : Number(args.cups);
      if (a === "water") return addWater(Number.isFinite(cups) ? cups : 1, ctx.rawUser);
      if (a === "sleep") return addSleep(ctx.rawUser);
      if (a === "wake") return addWake(ctx.rawUser);
      if (a === "update") return healthUpdateLast(cups, ctx.rawUser);
      if (a === "delete") return healthDeleteLast(ctx.rawUser);
      return healthStats(ctx.rawUser);
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "memory",
        description: "Clawic Memory — durable categorized store di .memory/ (plain markdown). remember: save this/don't forget; recall: what did I tell you about X; forget: delete. Write before reply, dated+sourced, one fact one home, INDEX capped.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", description: "remember|recall|forget|stats", enum: ["remember", "recall", "forget", "stats"] },
            category: { type: "string", description: "Kategori, mis. people, projects, decisions" },
            name: { type: "string", description: "Nama entry, mis. alice-smith" },
            fact: { type: "string", description: "Fakta 1 baris, mis. Moved to Northwind as PM" },
            query: { type: "string", description: "Query untuk recall, mis. alpha project" },
          },
          required: ["action"],
        },
      },
    },
    execute: (args) => {
      const a = String(args.action || "stats").toLowerCase();
      if (a === "remember") {
        const cat = typeof args.category === "string" ? args.category : "inbox";
        const n = typeof args.name === "string" ? args.name : "entry";
        const f = typeof args.fact === "string" ? args.fact : "";
        if (!f) return "Error: fact wajib diisi untuk remember";
        return clawicRemember(cat, n, f, "stated");
      }
      if (a === "recall") return clawicRecall(typeof args.query === "string" ? args.query : typeof args.name === "string" ? args.name : "");
      if (a === "forget") return clawicForget(typeof args.query === "string" ? args.query : typeof args.name === "string" ? args.name : "");
      return clawicStats();
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "evolver_status",
        description: "Cek status Evolver (Proxy mailbox, GEP assets, node). Read, auto, no confirm. Butuh A2A_NODE_ID.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: async () => {
      const { readFileSync, existsSync, readdirSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const { repoRoot } = await import("./users");
      const lines: string[] = [];
      let nodeId = process.env.A2A_NODE_ID || "";
      if (!nodeId) {
        try {
          const envLocal = readFileSync(join(repoRoot(), "apps/web/.env.local"), "utf8");
          const m = envLocal.match(/^A2A_NODE_ID=(.*)$/m);
          if (m) nodeId = m[1].trim();
        } catch {}
      }
      if (!nodeId) nodeId = "(not set — export A2A_NODE_ID)";
      lines.push(`A2A_NODE_ID: ${nodeId}`);
      const proxySet = join(homedir(), ".evolver", "settings.json");
      const localSet = join(repoRoot(), ".evolver", "settings.json");
      lines.push(`Proxy settings: ${existsSync(proxySet) ? proxySet : localSet} ${existsSync(proxySet) || existsSync(localSet) ? "found" : "missing"}`);
      // Proxy live check (best-effort, no throw)
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1500);
        const r = await fetch("http://127.0.0.1:19820/proxy/status", { signal: ctrl.signal });
        clearTimeout(t);
        lines.push(`Proxy live: ${r.ok ? "running" : `http ${r.status}`} (127.0.0.1:19820)`);
      } catch {
        lines.push("Proxy live: not running (auto-start on evolver --loop with EVOMAP_PROXY=1)");
      }
      const gepDir = join(repoRoot(), ".skills/capability-evolver", "assets", "gep");
      if (existsSync(gepDir)) {
        try { const files = readdirSync(gepDir); lines.push(`GEP assets: ${files.join(", ")}`); } catch {}
        try { const genes = JSON.parse(readFileSync(join(gepDir, "genes.json"), "utf8")); lines.push(`Genes: ${Array.isArray(genes) ? genes.length : 0}`); } catch {}
      } else lines.push("GEP assets: missing");
      const localEvolver = join(repoRoot(), ".evolver");
      lines.push(`Local .evolver: ${existsSync(localEvolver) ? "exists" : "missing"} (${existsSync(join(localEvolver, "assets/gep/genes.json")) ? "genes ok" : "no genes"})`);
      return lines.join("\n");
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "evolver_review",
        description: "Review mode evolver — analisis history tanpa nulis. Read, auto.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: async () => {
      const { readFileSync, existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { repoRoot } = await import("./users");
      const events = join(repoRoot(), ".evolver", "assets/gep/events.jsonl");
      if (!existsSync(events)) return "No events yet — run evolver loop first (EVOMAP_PROXY=1 node index.js --loop)";
      try {
        const lines = readFileSync(events, "utf8").trim().split("\n").slice(-5);
        return `Last 5 GEP events:\n${lines.join("\n").slice(0, 2500)}`;
      } catch (e) { return `Error: ${e instanceof Error ? e.message : String(e)}`; }
    },
  },
  // ── ByteRover (mandiri, local .brv/context-tree, no .openclaw) ──
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "brv_query",
        description: "Query ByteRover knowledge base (.brv/context-tree) — LLM synthesis dari ingatan terstruktur. Pakai sebelum jawab kalau butuh pola/aturan tersimpan. Read, auto.",
        parameters: { type: "object", properties: { query: { type: "string", description: "Pertanyaan, mis. 'How is authentication implemented?'" } }, required: ["query"] },
      },
    },
    execute: async (args) => {
      const { brvQuery } = await import("./byterover");
      return brvQuery(typeof args.query === "string" ? args.query : "");
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "brv_search",
        description: "BM25 search di .brv/context-tree — balikan file paths + scores + excerpts, tanpa LLM. Murah & cepat. Read, auto.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Keywords, mis. 'authentication patterns'" },
            limit: { type: "string", description: "Max results 1-50 (default 10)" },
            scope: { type: "string", description: "Path prefix filter, mis. 'architecture/'" },
            format: { type: "string", description: "Output format: 'text' atau 'json'", enum: ["text", "json"] },
          },
          required: ["query"],
        },
      },
    },
    execute: async (args) => {
      const { brvSearch } = await import("./byterover");
      return brvSearch(
        typeof args.query === "string" ? args.query : "",
        typeof args.limit === "string" ? parseInt(args.limit, 10) : asNumber(args.limit),
        typeof args.scope === "string" ? args.scope : undefined,
        typeof args.format === "string" ? args.format : undefined
      );
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "brv_curate",
        description: "Simpan pengetahuan baru ke .brv/context-tree via LLM kategorisasi. Butuh confirm. Maks 5 file project-scoped.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "Pengetahuan/pola/keputusan yang mau disimpan" },
            files: { type: "string", description: "Optional comma-separated relative paths (max 5), mis. 'src/auth.ts,README.md'" },
          },
          required: ["text"],
        },
      },
    },
    execute: async (args) => {
      const { brvCurate } = await import("./byterover");
      const files = typeof args.files === "string" && args.files.trim() ? args.files.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      return brvCurate(typeof args.text === "string" ? args.text : "", files);
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "brv_status",
        description: "Cek status ByteRover: CLI version, account, project, context-tree VC. Read, auto.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: async () => {
      const { brvStatus } = await import("./byterover");
      return brvStatus();
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "brv_vc_status",
        description: "Git status untuk .brv/context-tree (brv vc status). Read, auto.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: async () => {
      const { brvVcStatus } = await import("./byterover");
      return brvVcStatus();
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "brv_vc_log",
        description: "History commits .brv/context-tree (brv vc log). Read, auto.",
        parameters: { type: "object", properties: { limit: { type: "string", description: "Max entries (default 10)" } }, required: [] },
      },
    },
    execute: async (args) => {
      const { brvVcLog } = await import("./byterover");
      return brvVcLog(typeof args.limit === "string" ? parseInt(args.limit, 10) : asNumber(args.limit));
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "brv_swarm_query",
        description: "Swarm query — cari di semua memory providers (byterover + obsidian + GBrain dll) via RRF. Tanpa LLM. Read, auto.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Query, mis. 'How does JWT refresh work?'" },
            limit: { type: "string", description: "Max results (default 10)" },
          },
          required: ["query"],
        },
      },
    },
    execute: async (args) => {
      const { brvSwarmQuery } = await import("./byterover");
      return brvSwarmQuery(
        typeof args.query === "string" ? args.query : "",
        typeof args.limit === "string" ? parseInt(args.limit, 10) : asNumber(args.limit)
      );
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "brv_swarm_status",
        description: "Health check swarm providers (byterover/obsidian/GBrain). Read, auto.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: async () => {
      const { brvSwarmStatus } = await import("./byterover");
      return brvSwarmStatus();
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "brv_review",
        description: "List pending HITL reviews dari brv curate (brv review pending). Read, auto.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: async () => {
      const { brvReviewPending } = await import("./byterover");
      return brvReviewPending();
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "brv_locations",
        description: "List registered ByteRover projects & paths (brv locations). Read, auto.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: async () => {
      const { brvLocations } = await import("./byterover");
      return brvLocations();
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "brv_swarm_curate",
        description: "Swarm curate — simpan ke provider swarm (GBrain/local-markdown). Butuh confirm.",
        parameters: { type: "object", properties: { text: { type: "string", description: "Text to curate" }, provider: { type: "string", description: "Optional provider id, ex. 'local-markdown:notes' or 'gbrain'" } }, required: ["text"] },
      },
    },
    execute: async (args) => {
      const { brvSwarmCurate } = await import("./byterover");
      return brvSwarmCurate(typeof args.text === "string" ? args.text : "", typeof args.provider === "string" ? args.provider : undefined);
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "brv_review_approve",
        description: "Approve pending HITL review (brv review approve). Butuh confirm. taskId = UUID dari brv_review.",
        parameters: { type: "object", properties: { taskId: { type: "string", description: "UUID task id" }, files: { type: "string", description: "Optional comma-separated file paths" } }, required: ["taskId"] },
      },
    },
    execute: async (args) => {
      const { brvReviewApprove } = await import("./byterover");
      const files = typeof args.files === "string" && args.files.trim() ? args.files.split(",").map((s) => s.trim()) : undefined;
      return brvReviewApprove(typeof args.taskId === "string" ? args.taskId : "", files);
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "brv_review_reject",
        description: "Reject pending HITL review (brv review reject). Butuh confirm.",
        parameters: { type: "object", properties: { taskId: { type: "string", description: "UUID task id" }, files: { type: "string", description: "Optional comma-separated file paths" } }, required: ["taskId"] },
      },
    },
    execute: async (args) => {
      const { brvReviewReject } = await import("./byterover");
      const files = typeof args.files === "string" && args.files.trim() ? args.files.split(",").map((s) => s.trim()) : undefined;
      return brvReviewReject(typeof args.taskId === "string" ? args.taskId : "", files);
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "brv_curate_view",
        description: "Lihat history curate (brv curate view) — last 10 atau detail per logId. Read, auto.",
        parameters: { type: "object", properties: { logId: { type: "string", description: "Optional logId cur-..." }, detail: { type: "string", description: "'true' for --detail" }, limit: { type: "string", description: "Max entries" } }, required: [] },
      },
    },
    execute: async (args) => {
      const { brvCurateView } = await import("./byterover");
      return brvCurateView(typeof args.logId === "string" ? args.logId : undefined, typeof args.detail === "string" ? args.detail === "true" : undefined, typeof args.limit === "string" ? parseInt(args.limit, 10) : undefined);
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "brv_query_log_view",
        description: "Lihat history query (brv query-log view). Read, auto.",
        parameters: { type: "object", properties: { logId: { type: "string", description: "Optional qry-..." }, detail: { type: "string", description: "'true' for --detail" }, limit: { type: "string", description: "Max entries" } }, required: [] },
      },
    },
    execute: async (args) => {
      const { brvQueryLogView } = await import("./byterover");
      return brvQueryLogView(typeof args.logId === "string" ? args.logId : undefined, typeof args.detail === "string" ? args.detail === "true" : undefined, typeof args.limit === "string" ? parseInt(args.limit, 10) : undefined);
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "brv_query_log_summary",
        description: "Aggregated query recall metrics (brv query-log summary). Read, auto.",
        parameters: { type: "object", properties: { last: { type: "string", description: "Window, ex. '7d' or '24h'" } }, required: [] },
      },
    },
    execute: async (args) => {
      const { brvQueryLogSummary } = await import("./byterover");
      return brvQueryLogSummary(typeof args.last === "string" ? args.last : undefined);
    },
  },
  // ── Summarize Pro (mandiri, lokal .data/summarize-pro, no .openclaw) ──
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "summarize",
        description: "Summarize any text: quick/tldr/bullets/eli5/takeaways/action_items/executive/meeting/email/thread/chapter/progressive + smart auto-detect + language + custom length. 20 formats, local deterministic + LLM fallback (provider bawaan), word stats. Read, auto. Trigger: summarize/tldr/eli5/key takeaways/action items/bullet points/executive/compare/meeting/email/thread/chapter/progressive + language + length.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "Long text to summarize (max 30k chars)" },
            format: { type: "string", description: "Format: quick/tldr/bullets/eli5/takeaways/action_items/executive/meeting/email/thread/chapter/progressive/auto (default auto)", enum: ["quick", "bullets", "tldr", "eli5", "takeaways", "action_items", "executive", "meeting", "email", "thread", "chapter", "progressive", "auto"] },
            language: { type: "string", description: "Output language, ex. hindi/spanish/french (default english)" },
            length_words: { type: "string", description: "Custom length in words, ex. '50' or '100'" },
            compare_text: { type: "string", description: "Second text for compare format" },
            template: { type: "string", description: "Custom template name (from templates.json)" },
          },
          required: ["text"],
        },
      },
    },
    execute: async (args) => {
      const { summarizePro, getTemplate } = await import("./summarizePro");
      const text = typeof args.text === "string" ? args.text : "";
      const template = typeof args.template === "string" ? args.template.trim() : "";
      if (template) {
        const tmpl = getTemplate(template);
        if (tmpl) {
          const sections = tmpl.sections.map((s) => `**${s}:** ${text.slice(0, 400)}`).join("\n");
          return summarizePro({ text: sections, format: "bullets" });
        }
      }
      return summarizePro({
        text,
        format: typeof args.format === "string" ? args.format : "auto",
        language: typeof args.language === "string" ? args.language : undefined,
        customLengthWords: typeof args.length_words === "string" ? parseInt(args.length_words, 10) : undefined,
        compareText: typeof args.compare_text === "string" ? args.compare_text : undefined,
      });
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "summarize_history",
        description: "List recent summarize history (history.json, last 10, 100 max). Read, auto.",
        parameters: { type: "object", properties: { limit: { type: "string", description: "Max entries (default 10)" } }, required: [] },
      },
    },
    execute: async (args) => {
      const { getSummarizeHistory } = await import("./summarizePro");
      const lim = typeof args.limit === "string" ? parseInt(args.limit, 10) : 10;
      const h = getSummarizeHistory(Number.isFinite(lim) ? lim : 10);
      if (!h.length) return "No summary history yet.";
      return h.map((e) => `${e.id} — ${e.topic.slice(0, 40)} — ${new Date(e.timestamp).toLocaleString("id-ID")} — ${e.format} — ${e.original_words}→${e.summary_words}w`).join("\n");
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "summarize_saved",
        description: "List or save summaries (saved.json). Use 'save' to bookmark last summary. Read, auto.",
        parameters: { type: "object", properties: { action: { type: "string", description: "list or save (default list)", enum: ["list", "save"] } }, required: [] },
      },
    },
    execute: async (args) => {
      const { listSaved, saveLastSummary } = await import("./summarizePro");
      const a = typeof args.action === "string" ? args.action : "list";
      return a === "save" ? saveLastSummary() : listSaved();
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "summarize_stats",
        description: "Show summarize stats & achievements (summaries_count, words_processed, streak, favorite). Read, auto.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: async () => {
      const { getStats } = await import("./summarizePro");
      return getStats();
    },
  },
  {
    definition: {
      type: "function",
      risk: "write",
      function: {
        name: "summarize_template",
        description: "Create or list custom summary templates. Butuh confirm untuk create. Action: create (name+sections) or list.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", description: "create or list", enum: ["create", "list"] },
            name: { type: "string", description: "Template name (for create)" },
            sections: { type: "string", description: "Comma-separated sections, ex. 'Yesterday,Today,Blockers' (for create)" },
          },
          required: ["action"],
        },
      },
    },
    execute: async (args) => {
      const { createTemplate, listTemplates } = await import("./summarizePro");
      const a = typeof args.action === "string" ? args.action : "list";
      if (a === "list") return listTemplates();
      const name = typeof args.name === "string" ? args.name : "";
      const secs = typeof args.sections === "string" ? args.sections.split(",").map((s) => s.trim()).filter(Boolean) : [];
      return createTemplate(name, secs);
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "summarize_default",
        description: "Set default summarize format (bullets/tldr/eli5 etc). Read, auto.",
        parameters: { type: "object", properties: { format: { type: "string", description: "Default format name" } }, required: ["format"] },
      },
    },
    execute: async (args) => {
      const { setDefaultFormat } = await import("./summarizePro");
      return setDefaultFormat(typeof args.format === "string" ? args.format : "");
    },
  },
  // ── Browser-Use (daemon 50ms, indices, persistent, cloud/tunnel) ──
  {
    definition: { type: "function", risk: "read", function: { name: "browser_use_doctor", description: "browser-use doctor — diagnostics (platform, daemon, chrome). Read, auto.", parameters: { type: "object", properties: {}, required: [] } } },
    execute: async () => {
      const { buDoctor } = await import("./browserUse");
      return buDoctor();
    },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "browser_use_open", description: "browser-use open — new_tab(url) daemon persistent (~50ms). Use for JS-heavy/interactive pages, not plain fetch. Read, auto. http(s) only.", parameters: { type: "object", properties: { url: { type: "string", description: "http(s) URL to open" } }, required: ["url"] } } },
    execute: async (args) => {
      const { buOpen } = await import("./browserUse");
      return buOpen(typeof args.url === "string" ? args.url : "");
    },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "browser_use_state", description: "browser-use state — page_info + AX tree (indices) for click/input. Always call state before click. Read, auto.", parameters: { type: "object", properties: {}, required: [] } } },
    execute: async () => {
      const { buState } = await import("./browserUse");
      return buState();
    },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "browser_use_click", description: "browser-use click by index or x y (e.g. '5' or '120 340'). Requires confirm.", parameters: { type: "object", properties: { target: { type: "string", description: "Index from state or 'x y'" } }, required: ["target"] } } },
    execute: async (args) => {
      const { buClick } = await import("./browserUse");
      return buClick(typeof args.target === "string" ? args.target : "");
    },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "browser_use_input", description: "browser-use input <index> text — click then type fast (selectAll+insertText). Requires confirm.", parameters: { type: "object", properties: { index: { type: "string", description: "AX index from state" }, text: { type: "string", description: "Text to input" } }, required: ["index", "text"] } } },
    execute: async (args) => {
      const { buInput } = await import("./browserUse");
      return buInput(typeof args.index === "string" ? args.index : "", typeof args.text === "string" ? args.text : "");
    },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "browser_use_type", description: "browser-use type into focused element. Requires confirm.", parameters: { type: "object", properties: { text: { type: "string", description: "Text to type" } }, required: ["text"] } } },
    execute: async (args) => {
      const { buType } = await import("./browserUse");
      return buType(typeof args.text === "string" ? args.text : "");
    },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "browser_use_keys", description: "browser-use keys — send keys e.g. 'Enter', 'Control+a'. Requires confirm.", parameters: { type: "object", properties: { keys: { type: "string", description: "Keys to send" } }, required: ["keys"] } } },
    execute: async (args) => {
      const { buKeys } = await import("./browserUse");
      return buKeys(typeof args.keys === "string" ? args.keys : "");
    },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "browser_use_screenshot", description: "browser-use screenshot — Page.captureScreenshot base64. Read, auto.", parameters: { type: "object", properties: {}, required: [] } } },
    execute: async () => {
      const { buScreenshot } = await import("./browserUse");
      return buScreenshot();
    },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "browser_use_get", description: "browser-use get — title/html/text/value. Read, auto.", parameters: { type: "object", properties: { what: { type: "string", description: "title|html|text|value", enum: ["title", "html", "text", "value"] }, index: { type: "string", description: "AX index for text/value" }, selector: { type: "string", description: "CSS selector for html" } }, required: ["what"] } } },
    execute: async (args) => {
      const { buGet } = await import("./browserUse");
      return buGet(typeof args.what === "string" ? args.what : "", typeof args.index === "string" ? args.index : undefined, typeof args.selector === "string" ? args.selector : undefined);
    },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "browser_use_eval", description: "browser-use eval — js('code') return result. Read, auto. For DOM extraction when AX lacking.", parameters: { type: "object", properties: { code: { type: "string", description: "JS code to eval" } }, required: ["code"] } } },
    execute: async (args) => {
      const { buEval } = await import("./browserUse");
      return buEval(typeof args.code === "string" ? args.code : "");
    },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "browser_use_scroll", description: "browser-use scroll up/down. Read, auto. Amount px optional.", parameters: { type: "object", properties: { dir: { type: "string", description: "up or down", enum: ["up", "down"] }, amount: { type: "string", description: "Pixels (100-5000)" } }, required: ["dir"] } } },
    execute: async (args) => {
      const { buScroll } = await import("./browserUse");
      return buScroll(typeof args.dir === "string" ? args.dir : "", typeof args.amount === "string" ? parseInt(args.amount, 10) : undefined);
    },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "browser_use_tab", description: "browser-use tab list/new/switch/close. Write for new/switch/close, read for list.", parameters: { type: "object", properties: { action: { type: "string", description: "list|new|switch|close", enum: ["list", "new", "switch", "close"] }, arg: { type: "string", description: "URL for new or index for switch/close" } }, required: ["action"] } } },
    execute: async (args) => {
      const { buTab } = await import("./browserUse");
      return buTab(typeof args.action === "string" ? args.action : "", typeof args.arg === "string" ? args.arg : undefined);
    },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "browser_use_wait", description: "browser-use wait selector/text — poll 10s. Read, auto.", parameters: { type: "object", properties: { where: { type: "string", description: "selector or text", enum: ["selector", "text"] }, value: { type: "string", description: "CSS or text to wait for" } }, required: ["where", "value"] } } },
    execute: async (args) => {
      const { buWait } = await import("./browserUse");
      return buWait(typeof args.where === "string" ? args.where : "", typeof args.value === "string" ? args.value : "");
    },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "browser_use_close", description: "browser-use close — stop daemon (browser-use --reload). Requires confirm.", parameters: { type: "object", properties: {}, required: [] } } },
    execute: async () => {
      const { buClose } = await import("./browserUse");
      return buClose();
    },
  },
  // ── Humanizer (24-pattern Wikipedia + soul, lokal .data/humanizer) ──
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "humanize",
        description: "Remove AI writing patterns (24 Wikipedia patterns + clichés ID + soul) — inflated symbolism, promotional, -ing fluff, vague attribution, em dash, rule of three, AI vocab, negative parallelism, bold, title-case, sycophantic, plus Indonesian fillers. Deterministic + LLM polish (provider bawaan). Read, auto. Trigger: humanize this/edit this to sound human.",
        parameters: { type: "object", properties: { text: { type: "string", description: "Text to humanize (max 30k chars)" } }, required: ["text"] },
      },
    },
    execute: async (args) => {
      const { humanize } = await import("./humanizer");
      const t = typeof args.text === "string" ? args.text : "";
      try {
        const r = await humanize(t);
        const pat = r.patterns.length ? `\n\n🔍 Patterns: ${r.patterns.slice(0, 8).join(", ")}` : "\n\n🔍 No AI patterns detected — already human-like";
        return `${r.humanized}\n\n📊 ${r.original_words} → ${r.humanized_words} words${pat}`;
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "humanize failed"}`;
      }
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "humanize_history",
        description: "List humanizer history (last 10, 100 max). Read, auto.",
        parameters: { type: "object", properties: { limit: { type: "string", description: "Max entries" } }, required: [] },
      },
    },
    execute: async (args) => {
      const { getHumanizerHistory } = await import("./humanizer");
      const lim = typeof args.limit === "string" ? parseInt(args.limit, 10) : 10;
      const h = getHumanizerHistory(Number.isFinite(lim) ? lim : 10);
      if (!h.length) return "No humanizer history yet.";
      return h.map((e) => `${e.id} — ${new Date(e.timestamp).toLocaleString("id-ID")} — ${e.original_words}→${e.humanized_words}w — ${e.patterns.slice(0, 3).join(",") || "clean"}`).join("\n");
    },
  },
  {
    definition: {
      type: "function",
      risk: "read",
      function: {
        name: "humanize_stats",
        description: "Show humanizer stats (count, words, history). Read, auto.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: async () => {
      const { getHumanizerStats } = await import("./humanizer");
      return getHumanizerStats();
    },
  },
  // ── FreeRide (free OpenRouter ranking + fallback chain, mandiri .data/freeride) ──
  {
    definition: { type: "function", risk: "read", function: { name: "freeride_status", description: "FreeRide status — primary/fallbacks/cache/watcher + OPENROUTER_API_KEY. Read, auto.", parameters: { type: "object", properties: {}, required: [] } } },
    execute: async () => {
      const { freerideStatus } = await import("./freeride");
      return freerideStatus();
    },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "freeride_list", description: "List free OpenRouter models ranked (quality+context). Read, auto.", parameters: { type: "object", properties: { limit: { type: "string", description: "Max 1-30" } }, required: [] } } },
    execute: async (args) => {
      const { freerideList } = await import("./freeride");
      const lim = typeof args.limit === "string" ? parseInt(args.limit, 10) : 10;
      const list = await freerideList(Number.isFinite(lim) ? lim : 10);
      if (!list.length) return "No free models found.";
      return list.map((m, i) => `${i+1}. ${m.id} — ${m.context_length} ctx`).join("\n");
    },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "freeride_auto", description: "FreeRide auto — ranks free models, sets primary + 5 fallbacks (openrouter/free first). Butuh confirm.", parameters: { type: "object", properties: { keep_primary: { type: "string", description: "true to keep current primary" }, count: { type: "string", description: "Fallback count 1-10 (default 5)" } }, required: [] } } },
    execute: async (args) => {
      const { freerideAuto } = await import("./freeride");
      return freerideAuto({ keepPrimary: typeof args.keep_primary === "string" ? args.keep_primary === "true" : undefined, count: typeof args.count === "string" ? parseInt(args.count, 10) : undefined });
    },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "freeride_switch", description: "Switch primary model or add fallback. Butuh confirm.", parameters: { type: "object", properties: { model: { type: "string", description: "OpenRouter model id exactly as freeride_list reports it (ex. nvidia/nemotron-3-ultra-550b-a55b:free)" }, fallback_only: { type: "string", description: "true to add as fallback only" } }, required: ["model"] } } },
    execute: async (args) => {
      const { freerideSwitch } = await import("./freeride");
      return freerideSwitch(typeof args.model === "string" ? args.model : "", typeof args.fallback_only === "string" ? args.fallback_only === "true" : undefined);
    },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "freeride_refresh", description: "Force refresh free models cache from OpenRouter. Read, auto.", parameters: { type: "object", properties: {}, required: [] } } },
    execute: async () => {
      const { freerideRefresh } = await import("./freeride");
      return freerideRefresh();
    },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "freeride_rotate", description: "Live-test fallbacks and rebuild chain. Butuh confirm.", parameters: { type: "object", properties: {}, required: [] } } },
    execute: async () => {
      const { freerideRotate } = await import("./freeride");
      return freerideRotate();
    },
  },
  {
    definition: { type: "function", risk: "read", function: { name: "freeride_watcher", description: "Run watcher once (probe primary 60s). Read, auto.", parameters: { type: "object", properties: {}, required: [] } } },
    execute: async () => {
      const { freerideWatcherOnce } = await import("./freeride");
      return freerideWatcherOnce();
    },
  },
  // ── Auto-Update (mandiri daily self-update: git pull → npm install → gates → push, no .openclaw/Clawdbot) ──
  {
    definition: { type: "function", risk: "read", function: { name: "auto_update_status", description: "Auto-Update status — jadwal harian, last run, hasil gates, riwayat. Read, auto.", parameters: { type: "object", properties: {}, required: [] } } },
    execute: async () => {
      const { autoUpdateStatus } = await import("./autoUpdater");
      return autoUpdateStatus();
    },
  },
  {
    definition: { type: "function", risk: "write", function: { name: "auto_update", description: "Jalankan update Mia sekarang (git pull --ff-only + npm install + gates typecheck/test/verify + push ringkasan ke owner). Butuh confirm.", parameters: { type: "object", properties: { deliver: { type: "string", description: "true untuk push ringkasan ke channel (default true)" } }, required: [] } } },
    execute: async (args) => {
      const { runAutoUpdate } = await import("./autoUpdater");
      return runAutoUpdate({ force: true, deliver: !(typeof args.deliver === "string" && args.deliver === "false") });
    },
  },
  // ── Provider health (auto-failover + quota watchdog) ──
  {
    definition: { type: "function", risk: "read", function: { name: "provider_status", description: "Provider health + auto-failover — brain default, per-provider OK/DOWN + cooldown + quota-hit, dan chain efektif yang dipakai turn (provider mati di-skip, pulih auto-restore). Read, auto.", parameters: { type: "object", properties: {}, required: [] } } },
    execute: async () => {
      const { providerHealthStatus } = await import("./providerHealth");
      return providerHealthStatus();
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
export async function executeTool(call: ToolCall, rawUser?: unknown, extra?: { lastUserText?: string }): Promise<string> {
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
    // Never persist sensitive tool args (e.g. a password handed to breach_check).
    // Redact by KEY (any secret-ish arg, any tool) — the old 5-name list let
    // http_request/jwt_attack/http_session/cdp_request write tokens into the log.
    auditLog(rawUser, `tool:${call.name}`, redactArgsForDisplay(JSON.stringify(args)).slice(0, 300));
  } catch { /* no-op */ }
  recordToolCall(rawUser, call.name);
  const userKey = sanitizeUser(rawUser);
  // Defensive: a plugin that throws must surface as an Error string, never
  // bubble up and 500 the whole turn.
  try {
    const out = await plugin.execute(args, { userKey, rawUser, lastUserText: extra?.lastUserText });
    return out ?? "";
  } catch (err) {
    try { logError({ skill: call.name, summary: `${call.name} threw`, error: err instanceof Error ? err.message.slice(0, 400) : String(err), context: JSON.stringify(args).slice(0, 200), relatedFiles: ["apps/web/src/lib/tools.ts"] }); } catch { /* best-effort */ }
    return `Error: ${err instanceof Error ? err.message : "tool execution failed"}`;
  }
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

/** Bulk delete: removes every note matching `pred` (used by delete_note match/all). */
function deleteNotesBy(
  pred: (n: { id: string; content: string }) => boolean,
  userKey: string | null,
  label: string
): string {
  const notes = readNotes(userKey);
  const kept = notes.filter((n) => !pred(n));
  const removed = notes.length - kept.length;
  if (removed === 0) throw new Error(`no note ${label}`);
  writeNotes(kept, userKey);
  return `Deleted ${removed} note(s) ${label}.`;
}

function imaginativeNotes(title: string): string | undefined {
  const t = title.toLowerCase();
  if (t.includes("cars")) return "Pixar marathon — Lightning McQueen nostalgia, siap popcorn & minuman dingin 🚗🌸";
  if (t.includes("up") && t.includes("nonton")) return "Petualangan Rumah Terbang — Carl & Russell, siap selimut & cemilan 🎈🌸";
  if (t.includes("nonton") || t.includes("film") || t.includes("movie")) return "Waktunya santai, siap cemilan & nikmati ceritanya 🌸";
  if (t.includes("meeting") || t.includes("rapat")) return "Siap agenda & jangan telat, Mia ingetin lagi 5 menit sebelum 🌸";
  if (t.includes("belajar") || t.includes("study")) return "Fokus 25 menit, istirahat sejenak, kamu pasti bisa 🌸";
  return undefined;
}

function scheduleReminder(text: string, isoWhen: string, rawUser: unknown, repeat?: "daily", notes?: string): string {
  const parsed = new Date(isoWhen);
  if (Number.isNaN(parsed.getTime())) throw new Error(`cannot parse time "${isoWhen}" — use ISO-8601 with offset`);
  // Safety net: a model without a live clock sometimes emits a past/stale date
  // for a bare clock time ("jam 3 sore"). Never schedule in the past — rebase
  // such a time to its next occurrence (today/tomorrow) via the shared parser.
  // Wall-clock is read from the STRING (audit 2026-09-23): the model writes WIB
  // wall times, so Date methods (server zone) would rebase to the wrong clock
  // on any non-WIB host. Falls back to WIB-reading the instant when unparseable.
  const wall = /T(\d{2}):(\d{2})/.exec(isoWhen);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { wibDailyNext, wibParts } = require("./time") as typeof import("./time");
  const atMs = parsed.getTime() < Date.now()
    ? wall
      ? wibDailyNext(Number(wall[1]), Number(wall[2]))
      : wibDailyNext(wibParts(parsed).h, wibParts(parsed).mi)
    : parsed.getTime();
  const whenText = new Date(atMs).toLocaleString("en-GB", {
    timeZone: "Asia/Jakarta",
    dateStyle: "medium",
    timeStyle: "short",
  });
  // Imaginative fallback: if LLM left title raw & notes empty, enrich deterministically
  let enrichedText = text;
  let enrichedNotes = notes;
  if (!enrichedNotes) enrichedNotes = imaginativeNotes(enrichedText);
  // If title is still raw (no emoji), add a gentle touch for Cars/Up
  if (/^nonton cars$/i.test(enrichedText.trim()) && !/[^\x00-\x7F]/.test(enrichedText)) {
    enrichedText = "Nonton Cars 🚗 — Pixar marathon, siap popcorn!";
  } else if (/^nonton up$/i.test(enrichedText.trim()) && !/[^\x00-\x7F]/.test(enrichedText)) {
    enrichedText = "Nonton Up 🎈 — Petualangan Rumah Terbang!";
  }
  const r = addReminder(enrichedText, atMs, rawUser, { repeat, notes: enrichedNotes });
  const freq = repeat === "daily" ? "daily" : "once";
  const notePart = r.notes ? ` Notes: ${r.notes}` : "";
  return `Reminder set (${freq}): "${r.text}" at ${whenText}.${notePart} The user will be notified then.`;
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

/** Atomic file write (tmp + rename) — a crash mid-write never leaves a corrupt target. */
function atomicWrite(abs: string, content: string): void {
  const tmp = `${abs}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, abs);
}

function fileWrite(rawPath: string, content: string): string {
  const p = (rawPath || "").trim();
  if (!p) throw new Error("empty path");
  if (p.includes("~")) throw new Error("tilde paths are not allowed");
  if (Buffer.byteLength(content, "utf8") > FILE_WRITE_MAX_BYTES) throw new Error("content too large");
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
  atomicWrite(abs, content);
  return `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${p}`;
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
  if (Buffer.byteLength(next, "utf8") > FILE_WRITE_MAX_BYTES) throw new Error("result too large");
  atomicWrite(abs, next);
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
  { subcommand?: string[]; maxArgs: number; requireArgPrefix?: string; forbidArg?: string[] }
> = {
  // VCS / repo
  git: {
    subcommand: ["status", "log", "diff", "branch", "ls-files", "show", "rev-parse", "remote", "tag", "shortlog", "describe", "blame", "reflog", "worktree", "config", "--version"],
    maxArgs: 4,
  },
  // filesystem read
  ls: { maxArgs: 4 },
  pwd: { maxArgs: 0 },
  cat: { maxArgs: 4 },
  head: { maxArgs: 4 },
  tail: { maxArgs: 4, forbidArg: ["-f", "-F"] },
  wc: { maxArgs: 4 },
  du: { maxArgs: 3 },
  stat: { maxArgs: 3 },
  file: { maxArgs: 3 },
  which: { maxArgs: 3 },
  realpath: { maxArgs: 2 },
  basename: { maxArgs: 2 },
  dirname: { maxArgs: 2 },
  sort: { maxArgs: 3 },
  uniq: { maxArgs: 3 },
  cut: { maxArgs: 4 },
  tr: { maxArgs: 3 },
  jq: { maxArgs: 4 },
  // system info
  whoami: { maxArgs: 0 },
  id: { maxArgs: 1 },
  hostname: { maxArgs: 1 },
  uname: { maxArgs: 2 },
  sw_vers: { maxArgs: 1 },
  arch: { maxArgs: 0 },
  date: { maxArgs: 2 },
  uptime: { maxArgs: 1 },
  w: { maxArgs: 1 },
  sysctl: { maxArgs: 3, forbidArg: ["-w"] },
  vm_stat: { maxArgs: 1 },
  mount: { maxArgs: 2 },
  // runtimes
  node: { subcommand: ["--version", "-v"], maxArgs: 2 },
  npm: { subcommand: ["ls", "--version"], maxArgs: 3 },
  // network / process inspection (read-only)
  df: { maxArgs: 2 },
  ps: { maxArgs: 4 },
  pgrep: { maxArgs: 3 },
  netstat: { maxArgs: 4, forbidArg: ["-w"] },
  ifconfig: { maxArgs: 3 },
  arp: { maxArgs: 3, forbidArg: ["-d", "-s"] },
  dig: { maxArgs: 4 },
  nslookup: { maxArgs: 4 },
  host: { maxArgs: 3 },
  whois: { maxArgs: 2 },
  lsof: { maxArgs: 6, requireArgPrefix: "-i" },
  tcpdump: { maxArgs: 5, forbidArg: ["-w", "-z", "-G", "-C"] },
  nc: { maxArgs: 4, forbidArg: ["-e", "-c", "-l"] },
  netcat: { maxArgs: 4, forbidArg: ["-e", "-c", "-l"] },
  searchsploit: { maxArgs: 4 },
  // containers (read-only subcommands)
  docker: { subcommand: ["ps", "images", "version", "info"], maxArgs: 4 },
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
    if (spec.requireArgPrefix && !args.some((a) => a.startsWith(spec.requireArgPrefix!))) {
      rejectPromise(new Error(`"${cmd}" read-only only allows network queries, e.g. \`${cmd} ${spec.requireArgPrefix}TCP -sTCP:LISTEN -P -n\``));
      return;
    }
    if (spec.forbidArg && args.some((a) => spec.forbidArg!.includes(a))) {
      rejectPromise(new Error(`argument not allowed for "${cmd}" read-only (blocked: ${spec.forbidArg.join(", ")})`));
      return;
    }
    // Refuse reading sensitive/dir-heavy targets (mirrors file_read deny-list).
    if (EXEC_FORBIDDEN_SRC.test(trimmed)) {
      rejectPromise(new Error("command targets a blocked path"));
      return;
    }
    // SafeExec guard (CRITICAL/HIGH intercepted, agent auto-bypass for LOW/MEDIUM)
    const safe = safeGuard(trimmed);
    if (!safe.allow) {
      rejectPromise(new Error(`Blocked by SafeExec (${safe.risk}): ${safe.reason} — pending ${safe.requestId}. Approve via safe-exec-approve ${safe.requestId} or set SAFE_EXEC_DISABLE=1`));
      return;
    }
    // Path-argument sandbox guard (invariant 5): `cat /etc/passwd` or
    // `ls /Users` read outside the repo even though the base command is
    // allowlisted. Resolve every non-flag argument against cwd and require it
    // to stay within an allowed sandbox root. `df` is exempt — it reports
    // mounted-volume stats, never file contents (its `/` is remapped below).
    if (cmd !== "df") {
      for (const a of args) {
        if (a.startsWith("-")) continue;
        if (!resolveInSandbox(resolve(cwd, a))) {
          rejectPromise(new Error(`path argument "${a}" escapes every allowed sandbox root`));
          return;
        }
      }
    }
    // macOS: `df /` reads the sealed SYSTEM snapshot (always ~40%) — remap to
    // the real data volume so any model-generated `df -h /` answers honestly.
    const parts2 = process.platform === "darwin" && cmd === "df"
      ? args.map((a) => (a === "/" ? "/System/Volumes/Data" : a))
      : args;
    execFile(
      cmd,
      parts2,
      { cwd, timeout: EXEC_TIMEOUT_MS, maxBuffer: Math.max(EXEC_MAX_OUTPUT * 2, 2 * 1024 * 1024) },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException & { code?: number }).code;
          // lsof convention (like grep): exit 1 with empty stderr means "no
          // matches" (e.g. zero TCP listeners on a CI runner) — a legitimate
          // empty read-only result, not a failure. Real errors print stderr.
          if (cmd === "lsof" && code === 1 && !stderr?.trim()) {
            resolvePromise("(no output)");
            return;
          }
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
    const safe = safeGuard(trimmed);
    if (!safe.allow) {
      rejectPromise(new Error(`Blocked by SafeExec (${safe.risk}): ${safe.reason} — pending ${safe.requestId}. Approve via safe-exec-approve ${safe.requestId}`));
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
const BING_HTML = "https://www.bing.com/search";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

/**
 * Search with DuckDuckGo first (Instant Answer → HTML scrape), then fall back to
 * Bing HTML — DDG's gateway frequently fails on this host (CERT_HAS_EXPIRED /
 * 000), and without a fallback web_search returns nothing for current/factual
 * questions. All keyless; graceful on failure either way.
 */
/**
 * Strip conversational particles from a search query so Bing gets the
 * useful keywords, not Indonesian filler ("cari", "dong", "kamu tau", etc.)
 */
function cleanSearchQuery(raw: string): string {
  return raw
    .replace(/\b(cari|cariin|kasih\s+tau\s+kalau|kamu\s+tau|coba\s+cari|soal|soalnya|tentang|dengan\s+web_search|web_search)\b/gi, " ")
    .replace(/\b(dong|ya|yah|yuk|be|beb|mas|bang|kak|please|plis|tolong|web_search)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b(\w+)\s+\1\b/gi, "$1");
}

async function webSearch(query: string): Promise<string> {
  const q = cleanSearchQuery(query.trim().slice(0, 200));
  if (!q) return "Error: empty search query";

  const instant = await fetchInstantAnswer(q);
  if (instant) return instant;

  // 1) DuckDuckGo HTML
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
    if (res.ok) {
      const parsed = parseResults(await res.text());
      if (parsed !== "No results found.") return parsed;
    }
  } catch { /* fall through to Bing */ }

  // 2) Bing HTML fallback
  try {
    const res = await fetch(`${BING_HTML}?q=${encodeURIComponent(q)}&setlang=id&cc=ID`, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) return "Error: web search failed";
    return parseBingResults(await res.text());
  } catch {
    return "Error: web search failed";
  }
}

/** Resolve Bing's /ck redirect wrapper into the real publisher URL (or passthrough). */
function resolveBingRedirect(raw: string): string {
  // Bing encodes the actual target URL as a base64 `u=` query param, prefixed
  // with a "1" marker character, and the href arrives HTML-escaped (&amp; → &).
  const decodedQuery = raw.replace(/&amp;/g, "&");
  const m = decodedQuery.match(/[?&]u=([^&]+)/);
  if (!m) return raw;
  try {
    const b64 = m[1].startsWith("a1") ? m[1].slice(2) : m[1];
    const decoded = Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return decoded.startsWith("http") ? decoded : raw;
  } catch {
    return raw;
  }
}

const GOOGLE_NEWS_RSS = "https://news.google.com/rss";
const GN_MAX_ITEMS = 6;
const GN_FETCH_PER_EDITION = 12; // fetch more than shown so dedup has candidates
const GN_SIMILARITY_THRESHOLD = 0.55;

/** Lightweight stopword set so title-similarity dedup ignores filler tokens. */
const GN_STOPWORDS = new Set([
  "yang","dan","di","dari","untuk","dengan","pada","ini","itu","akan","tidak","para",
  "saat","setelah","dalam","karena","polisi","berikut","antar","antarpulau","the","a","an",
  "of","to","in","on","and","for","is","are","was","were","by","at","as","or","ke","set"
]);

/** One normalized Google News story. */
type GNItem = {
  title: string;
  source: string;
  when: string; // formatted " — 10 Sep, 04.47"
  host: string;
  url: string;
  pubMs: number; // 0 = no valid date
};

function gnTokens(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !GN_STOPWORDS.has(w));
}

/** Dice coefficient on normalized token sets — same story across outlets ≈ ≥0.55. */
function gnSimilar(a: string, b: string): boolean {
  const A = gnTokens(a);
  const B = gnTokens(b);
  if (!A.length || !B.length) return a === b;
  const setA = new Set(A);
  let common = 0;
  for (const t of B) if (setA.has(t)) common++;
  return (2 * common) / (A.length + B.length) >= GN_SIMILARITY_THRESHOLD;
}

/** Build the ordered, deduped edition array from `language` + optional `region`. */
function buildGnLangs(language: string, region?: string): string[] {
  const seen = new Set<string>();
  const langs: string[] = [];
  const candidates = [
    language || "id-ID",
    ...(region ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  ];
  for (const c of candidates) {
    const l = /^[a-z]{2}-[A-Z]{2}$/.test(c) ? c : null;
    if (l && !seen.has(l)) {
      seen.add(l);
      langs.push(l);
    }
  }
  return langs.length ? langs : ["id-ID"];
}

/**
 * Fetch one RSS edition into structured items. `withinHours` (0 = off) keeps
 * only items published inside that window. Never throws — null when the fetch
 * itself failed (network/HTTP error, e.g. datacenter-IP blocking), [] when it
 * succeeded but yielded nothing. Callers must not conflate the two: a failed
 * fetch is an honest Error, an empty one is "no news".
 */
async function fetchGnEdition(query: string, lang: string, withinHours: number): Promise<GNItem[] | null> {
  const [hl, gl] = lang.split("-");
  const params = new URLSearchParams({ hl, gl, ceid: `${gl}:${hl}` });
  if (query.trim()) params.set("q", query.trim().slice(0, 200));
  let xml: string;
  try {
    const res = await fetch(`${GOOGLE_NEWS_RSS}${query.trim() ? "/search" : ""}?${params}`, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml, application/xml, text/xml" },
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) return null;
    xml = await res.text();
  } catch {
    return null;
  }
  const now = Date.now();
  const out: GNItem[] = [];
  for (const [, body] of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const title = stripTags(body.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/^Google News:\s+/i, "");
    const srcAttr = body.match(/<source url="([^"]*)"[^>]*>([\s\S]*?)<\/source>/i);
    const source = stripTags(srcAttr?.[2] ?? "");
    const titleClean = source && title.endsWith(` - ${source}`) ? title.slice(0, -(` - ${source}`.length)) : title;
    if (!titleClean) continue;
    const pub = body.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1]?.trim() ?? "";
    const pubMs = pub ? Date.parse(pub) : 0;
    if (withinHours > 0 && pubMs && now - pubMs > withinHours * 3_600_000) continue;
    const when = pubMs ? ` — ${new Date(pubMs).toLocaleDateString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}` : "";
    const host = (() => { try { return srcAttr?.[1] ? new URL(srcAttr[1]).hostname.replace(/^www\./, "") : ""; } catch { return ""; } })();
    const url = body.match(/<link>\s*(?:<\!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/link>/i)?.[1]?.trim() ?? "";
    out.push({ title: titleClean, source, when, host, url, pubMs });
  }
  return out.slice(0, GN_FETCH_PER_EDITION);
}

/**
 * Fetch all editions (primary first), merge, and dedup stories by title
 * similarity so the same story from 6 outlets shows once. Capped at GN_MAX_ITEMS.
 * Returns null only when EVERY edition failed (partial success still merges).
 */
async function fetchGnItems(query: string, langs: string[], withinHours: number): Promise<GNItem[] | null> {
  const results = await Promise.all(langs.map((l) => fetchGnEdition(query, l, withinHours)));
  if (results.every((r) => r === null)) return null;
  const merged = (results.filter((r): r is GNItem[] => r !== null)).flat();
  const kept: GNItem[] = [];
  for (const item of merged) {
    if (kept.some((k) => gnSimilar(k.title, item.title))) continue;
    kept.push(item);
    if (kept.length >= GN_MAX_ITEMS) break;
  }
  return kept;
}

/**
 * Google News headlines via the official RSS endpoint (keyless). `query` empty
 * → latest headlines; otherwise news.google.com keyword search. `language`
 * like "id-ID" or "en-US" maps to hl/gl/ceid edition params; `region` merges
 * additional comma-separated editions (e.g. "en-US,en-GB"); `within` (hours)
 * keeps only stories published in that window. Returns a terse per-item list
 * (title — source + date · source hostname) deduped across outlets. The RSS
 * `<link>` carries 400+ char base64 redirect URLs that render as ugly link
 * previews, so the article link is embedded as a compact markdown anchor
 * `[host](url)`. Fetch failure (all editions down/blocked) is a short honest
 * "Error: ..." — never a fake "No news found." Genuine empty stays "No news".
 */
async function googleNews(query: string, language: string, region?: string, within?: number): Promise<string> {
  const withinHours = typeof within === "number" && within > 0 ? Math.floor(within) : 0;
  const items = await fetchGnItems(query, buildGnLangs(language, region), withinHours);
  if (items === null) return "Error: Google News tidak bisa dihubungi sekarang — coba lagi nanti ya.";
  if (!items.length) return withinHours > 0 ? `No news in the last ${withinHours}h.` : "No news found.";
  const rows = items.map((it) => `• ${it.title} (${it.source || "berita"}${it.when})${it.host ? ` — [${it.host}](${it.url})` : ""}`);
  const head = query.trim()
    ? `Nih berita soal "${query.trim()}" — ${rows.length} hasil 🌸`
    : `Ini headline terbaru 🌸 — ${rows.length} hasil`;
  return [head, ...rows].join("\n").slice(0, 4000);
}

/**
 * Composite research tool: merges Google News editions + web search + up to two
 * article bodies into one digest for the model to synthesize with citations.
 * Degrades gracefully per source (a failing piece is skipped, never fatal).
 * Article bodies are fetched from the publisher URLs found in web-search rows —
 * Google News article links are a JS interstitial (~600KB, never resolvable
 * server-side), so they are never fetched directly.
 */
async function research(query: string, language?: string, region?: string, within?: number): Promise<string> {
  const q = query.trim().slice(0, 200);
  if (!q) return "Error: empty research query";
  const withinHours = typeof within === "number" && within > 0 ? Math.floor(within) : 0;
  const items = (await fetchGnItems(q, buildGnLangs(language || "id-ID", region), withinHours)) ?? [];
  const newsLines = items.map((it) => `• ${it.title} (${it.source || "berita"}${it.when})${it.host ? ` — [${it.host}](${it.url})` : ""}`);
  const webText = await webSearch(q).catch(() => "Error: web search failed");
  // Publisher URLs from web-search rows (indented line holding a single URL).
  // Skip search-engine chrome (bing.com/duckduckgo.com own pages) and Google
  // News's own JS interstitial — none carry article content.
  const webUrls: string[] = [];
  if (webText && !webText.startsWith("Error:") && !webText.startsWith("No results")) {
    for (const line of webText.split("\n")) {
      const m = line.trim().match(/^https?:\/\/\S+$/);
      if (!m) continue;
      const u = m[0];
      try {
        const h = new URL(u).hostname.replace(/^www\./, "").toLowerCase();
        if (!h || h === "bing.com" || h.endsWith(".bing.com") || h === "duckduckgo.com" || h.includes("news.google.com")) continue;
      } catch { continue; }
      if (webUrls.length < 4) webUrls.push(u);
    }
  }
  const articleLines: string[] = [];
  for (const u of webUrls.slice(0, 4)) {
    if (articleLines.length >= 2) break;
    try {
      const txt = await fetchUrl(u);
      const host = (() => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return "sumber"; } })();
      const clean = txt.replace(/\s+/g, " ").trim();
      if (clean.length >= 40) articleLines.push(`- ${host}: ${clean.slice(0, 500)}`);
    } catch { /* article body unavailable — skip */ }
  }
  const parts = [`Nih hasil riset "${q}" 🌸`];
  if (newsLines.length) parts.push("Berita:", ...newsLines);
  if (webText && !webText.startsWith("Error:") && !webText.startsWith("No results")) parts.push("Web:", webText.slice(0, 1200));
  if (articleLines.length) parts.push("Isi artikel:", ...articleLines);
  // Every source failed: an content-free digest header would read as a result —
  // fail honestly instead (same slop class as fake "No news found").
  if (parts.length === 1) return `Error: riset "${q}" gagal — sumber berita dan web tidak bisa dihubungi, coba lagi nanti ya.`;
  return parts.join("\n").slice(0, 6000);
}

/** Extract Bing organic results (b_algo blocks with <h2> links + b_lineclamp snippets).
 *  Filters out Bing's own "Search Images" / feature links at the top. */
function parseBingResults(html: string): string {
  const titles: string[] = [];
  const urls: string[] = [];
  const h2Re = /<h2[^>]*><a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a><\/h2>/gi;
  let m: RegExpExecArray | null;
  while ((m = h2Re.exec(html)) !== null && titles.length < 5) {
    const title = stripTags(m[2]);
    const raw = m[1];
    // Skip Bing's own feature links ("Search Images", "Bing Camera", etc.)
    if (/^(?:Search|Bing)\s/i.test(title) || /bing\.com\/(?!ck)/i.test(raw)) continue;
    const displayUrl = raw.includes("bing.com/ck") ? resolveBingRedirect(raw) : cleanUrl(raw);
    titles.push(title);
    urls.push(displayUrl);
  }
  if (!titles.length) return "No results found.";

  const snippets: string[] = [];
  const snipRe = /class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/gi;
  while ((m = snipRe.exec(html)) !== null && snippets.length < 5) snippets.push(stripTags(m[1]));

  const rows = titles.map((title, i) => {
    const line = `${i + 1}. ${title}\n   ${urls[i] ?? ""}`;
    const snippet = snippets[i];
    return snippet ? `${line}\n   ${snippet.slice(0, 220)}` : line;
  });
  return rows.join("\n").slice(0, 1800);
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
    .replace(/&nbsp;/g, " ")
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

const FETCH_MAX_BYTES = 1_000_000; // ~ cap we feed to the LLM (news pages are JS-heavy)
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