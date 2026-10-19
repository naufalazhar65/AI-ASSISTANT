// Project ownership & work attribution — evidence-driven, derived from the
// append-only audit log (the only record that a tool really ran).
//
// ROOT CAUSE (measured 2026-10-18): nothing in the pipeline ever connected a
// historical question ("nusa.html itu project apa?") to execution records. The
// truth was already on disk — `tool:write_file` by naufalazhar652952.michelle
// on 2026-10-16 for index.html + product-detail.html, while nusa.html only ever
// got `tool:file_read` — yet the answer came from `search_memory` (score 0.37,
// unrelated greetings), so the model narrated retrieval as history.
//
// Evidence hierarchy (owner, 2026-10-18): a recorded tool execution that wrote
// or read a path is STRONG. A filename appearing, a file being readable, a
// project being named in chat, a memory score, an LLM being confident, or an
// mtime with no provenance are all INSUFFICIENT and must resolve to unknown.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appRoot } from "./users";

/** Owner-defined attribution vocabulary. */
export type AttributionStatus =
  | "CONFIRMED_CONTRIBUTION"
  | "CONFIRMED_INSPECTION"
  | "CONFIRMED_REFERENCE"
  | "PARTIALLY_SUPPORTED"
  | "HISTORICAL_UNVERIFIED"
  | "UNKNOWN"
  | "CONTRADICTED";

/** Owner-defined work-event vocabulary. ORIGIN is tracked separately from activity. */
export type WorkEventType =
  | "CREATED"
  | "MODIFIED"
  | "REVIEWED"
  | "INSPECTED"
  | "TESTED"
  | "RESEARCHED"
  | "REFERENCED"
  | "DISCUSSED"
  | "IMPORTED"
  | "EXTERNAL_CONTRIBUTION"
  | "OWNERSHIP_UNKNOWN";

export interface WorkEvent {
  work_event_id: string;
  project_id: string;
  project_name: string;
  task_id: string | null;
  agent_id: string;
  event_type: WorkEventType;
  artifact_reference: string | null;
  operation_reference: string;
  timestamp: string;
  source_evidence: string;
  change_summary: string | null;
  verification_status: AttributionStatus;
}

export interface ProjectRecord {
  project_id: string;
  project_name: string;
  description: string | null;
  repository_reference: string | null;
  project_origin: "AGENT_CREATED" | "EXTERNAL" | "PRE_EXISTING" | "UNKNOWN";
  origin_evidence: string | null;
  created_at: string | null;
  last_updated_at: string | null;
  ownership_status: AttributionStatus;
  related_artifact_ids: string[];
  related_task_ids: string[];
  external_source_references: string[];
  status: "active" | "unknown" | "external";
}

// Project = the OUTERMOST meaningful ancestor directory of the artifact (the
// repo dir, the project dir), not the deepest one: "deep" inside
// TEST_MICHELLE/nested/deep is a folder, not a project. Leading system/home
// segments (Users, the home dir name, Desktop/Documents/PROJECT) and the usual
// source folders are skipped so a repo file resolves to the repo itself.
const IGNORED_PREFIXES = new Set(["Users", "Desktop", "Documents", "PROJECT", "home", "repo", "src", "app", "apps", "."]);

export function projectIdFor(artifact: string | null): { id: string; name: string } {
  if (!artifact) return { id: "unknown", name: "unknown" };
  const parts = artifact.split("/").filter(Boolean);
  const file = parts.pop() ?? artifact;
  const parents = [...parts];
  // Drop the home directory name that follows "Users" (per-machine segment).
  const usersAt = parents.indexOf("Users");
  if (usersAt >= 0 && parents[usersAt + 1]) parents.splice(usersAt + 1, 1);
  let i = 0;
  while (i < parents.length && IGNORED_PREFIXES.has(parents[i]!)) i++;
  const name = parents.slice(i)[0] ?? file;
  return { id: name, name };
}

/** Tool → work-event type. Only ops that really ran can appear here. */
export function eventTypeForTool(tool: string): WorkEventType | null {
  const t = tool.toLowerCase();
  if (t === "write_file" || t === "file_write" || t === "edit_file" || t === "file_edit") return "MODIFIED";
  if (t === "file_read" || t === "read_file") return "INSPECTED";
  if (t === "js_mine" || t === "content_discover" || t === "codebase_search") return "REVIEWED";
  if (t === "poc_verify" || t === "sast_scan" || t === "pentest_scan" || t === "exec_write") return "TESTED";
  if (t === "web_search" || t === "fetch_url" || t === "learning_ingest") return "RESEARCHED";
  return null;
}

/** `naufalazhar652952.michelle` → `michelle`; a bare owner key is Mia. */
export function agentOfUserKey(user: string | null | undefined): string {
  const m = /^(.*)\.(agnes|michelle|mia)$/.exec(user ?? "");
  return m ? m[2]! : "mia";
}

function pathArg(detail: string): string | null {
  try {
    const o = JSON.parse(detail) as { path?: unknown; url?: unknown };
    if (typeof o.path === "string") return o.path;
    if (typeof o.url === "string") return o.url;
  } catch {
    /* detail is not JSON (plain text audit notes) */
  }
  return null;
}

export interface AuditLine {
  ts?: string;
  user?: string;
  action?: string;
  detail?: string;
}

/** Pure: audit lines → work events. No I/O, no guessing. */
export function workEventsFromAudit(lines: AuditLine[], opts: { sinceIso?: string } = {}): WorkEvent[] {
  const out: WorkEvent[] = [];
  const since = opts.sinceIso ? new Date(opts.sinceIso).getTime() : 0;
  for (const raw of lines) {
    const action = raw.action ?? "";
    if (!action.startsWith("tool:")) continue;
    const tool = action.slice(5);
    const type = eventTypeForTool(tool);
    if (!type) continue;
    const ts = raw.ts ?? "";
    // An undated line must NOT slip past the window check: "no timestamp" means
    // "cannot be placed", so it cannot be claimed as inside the window either.
    if (since && (!ts || new Date(ts).getTime() < since)) continue;
    const artifact = pathArg(raw.detail ?? "");
    const agent = agentOfUserKey(raw.user);
    const { id, name } = projectIdFor(artifact);
    // A write is strong evidence of modification. It is NOT proof of creation:
    // the audit log records the operation, never whether the path existed before.
    // A write with no recorded timestamp cannot be pinned to a point in time,
    // so it supports the contribution but is not fully confirmed.
    const verification: AttributionStatus =
      type === "MODIFIED" ? (ts ? "CONFIRMED_CONTRIBUTION" : "PARTIALLY_SUPPORTED") : type === "INSPECTED" || type === "REVIEWED" ? "CONFIRMED_INSPECTION" : type === "RESEARCHED" ? "CONFIRMED_REFERENCE" : "PARTIALLY_SUPPORTED";
    out.push({
      work_event_id: `${ts}:${agent}:${tool}:${artifact ?? id}`,
      project_id: id,
      project_name: name,
      task_id: TASK_TAG_RE.exec(raw.detail ?? "")?.[1] ?? null,
      agent_id: agent,
      event_type: type,
      artifact_reference: artifact,
      operation_reference: `audit:${action}`,
      timestamp: ts,
      source_evidence: `audit ${action}`,
      change_summary: null,
      verification_status: verification,
    });
  }
  return out.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
}

/** Chronological ledger grouped into projects. */
export function projectLedger(events: WorkEvent[]): ProjectRecord[] {
  const byId = new Map<string, ProjectRecord>();
  // Events arrive newest-first, so tasks collected in encounter order read
  // backwards; a ledger the owner reads must run oldest -> newest.
  const firstSeen = new Map<string, Map<string, string>>();
  for (const e of events) {
    let p = byId.get(e.project_id);
    if (!p) {
      p = {
        project_id: e.project_id,
        project_name: e.project_name,
        description: null,
        repository_reference: null,
        // Origin stays UNKNOWN until something establishes it. Activity by an
        // agent is NOT origin (one file write never makes the agent the author).
        project_origin: "UNKNOWN",
        origin_evidence: null,
        created_at: null,
        last_updated_at: e.timestamp,
        ownership_status: "UNKNOWN",
        related_artifact_ids: [],
        related_task_ids: [],
        external_source_references: [],
        status: "unknown",
      };
      byId.set(e.project_id, p);
    }
    if (e.artifact_reference && !p.related_artifact_ids.includes(e.artifact_reference)) p.related_artifact_ids.push(e.artifact_reference);
    // The task a project's operations ran under — the plan -> task -> tool leg of
    // the chain. Missing here simply means the work happened outside a plan.
    if (e.task_id) {
      const seen = firstSeen.get(p.project_id) ?? new Map<string, string>();
      firstSeen.set(p.project_id, seen);
      if (!seen.has(e.task_id)) {
        seen.set(e.task_id, e.timestamp);
        p.related_task_ids.push(e.task_id);
      }
    }
    if (e.timestamp > (p.last_updated_at ?? "")) p.last_updated_at = e.timestamp;
    if (e.verification_status === "CONFIRMED_CONTRIBUTION") p.ownership_status = "PARTIALLY_SUPPORTED";
  }
  for (const p of byId.values()) {
    const seen = firstSeen.get(p.project_id);
    if (seen) p.related_task_ids.sort((a, b) => ((seen.get(a) ?? "") > (seen.get(b) ?? "") ? 1 : -1));
  }
  return [...byId.values()].sort((a, b) => ((b.last_updated_at ?? "") > (a.last_updated_at ?? "") ? 1 : -1));
}

/** Real history from the append-only audit log (no parallel store to migrate). */
export function readWorkEvents(user?: string, opts: { days?: number; sinceIso?: string } = {}): WorkEvent[] {
  const dir = join(appRoot(), ".data", "audit");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.startsWith("AUDIT-") && f.endsWith(".log")).sort();
  } catch {
    return [];
  }
  // `days` is a TIME WINDOW. Audit files are written once per day, so slicing
  // by file count silently capped history at whatever the retention happened to
  // be (AUDIT_KEEP_DAYS=7), while a day with several files ate the window twice.
  const days = Math.max(1, Math.min(opts.days ?? 14, 120));
  const daysAgo = new Date(Date.now() - days * 86_400_000).toISOString();
  // The later of the two windows wins: an explicit sinceIso must never be widened.
  const sinceIso = opts.sinceIso && opts.sinceIso > daysAgo ? opts.sinceIso : daysAgo;
  const lines: AuditLine[] = [];
  for (const f of files) {
    let text = "";
    try {
      text = readFileSync(join(dir, f), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        lines.push(JSON.parse(t) as AuditLine);
      } catch {
        /* partial line */
      }
    }
  }
  // Cross-agent by design: "who actually wrote this?" is a question about the
  // whole crew, and an answer that only knows the speaker's own ops would
  // silently invent origin whenever a sibling did the work.
  void user; // cross-agent by design
  return workEventsFromAudit(lines, { sinceIso });
}

// Covers first person (the common shape) plus the passive and third-person
// shapes that used to slip through: "nusa.html itu yang bikin dia" / "dibuat
// oleh Michelle" read as authorship claims just as much as "aku yang bikin".
// Remaining known gap: a third-person NAME + creation verb with no marker
// ("Michelle yang bikin nusa.html") still only fires via OWNERSHIP_ASK_RE.
const CREATION_CLAIM_RE = /\b(?:(?:aku|kami|saya|gue)\s+(?:yang\s+)?(?:bikin|buat|membuat|create[d]?|bikinnya|yg\s+bikin)|(?:itu|ini)\s+yang\s+(?:bikin|buat|membuat|made)|(?:dibuat|dibikin|dikarang|ditulis)\s+(?:oleh|ama|by)|(?:(?:hasil\s+)?karya)\s+(?:(?:dari|oleh)\s+)?(?=\S))/i;
const ORIGIN_CLAIM_RE = /\b(?:project|proyek|repo|repository|aplikasi|app|file)\s+(?:ini\s+)?(?:open[\s-]?source|opensource|dibuat\s+dari\s+nol|from\s+scratch)\b/i;
const OWNERSHIP_ASK_RE = /\b(?:apakah|who|siapa)\b[^.?!]{0,40}\b(?:bikin|buat|membuat|made|create[d]?|author|penulis)\b/i;
// Owner phrasing is often inverted — "BisaModule itu bikin kamu?" has no
// interrogative opener, so the pattern above misses it and the claim went
// unchecked. Any authorship verb aimed at a person counts.
const OWNERSHIP_TARGETED_RE = /\b(?:bikin|buat|membuat|made|create[d]?|author|penulis)\s+(?:kamu|aku|saya|gue|Anda|anda)\b/i;
// Operation -> task link written by tools.ts (`||task=<id>` suffix on the audit
// detail), so a work event can be traced back to the plan it belonged to.
const TASK_TAG_RE = /\|\|task=([A-Za-z0-9_.-]{1,80})/;
const FILE_MENTION_RE = /[\w./-]+\.(?:html|css|js|ts|tsx|jsx|json|md|txt|py|sh|mjs)\b/i;

/** Who the claim is ABOUT, when the text names a sibling. Ambiguous or
 * unnamed falls back to the speaker, so the guard never invents a subject. */
function subjectAgent(text: string): string | null {
  const found = [...text.matchAll(/\b(mia|agnes|michelle)\b/gi)].map((m) => m[1]!.toLowerCase());
  const unique = [...new Set(found)];
  return unique.length === 1 ? unique[0]! : null;
}

export interface AttributionFacts {
  events: WorkEvent[];
  agent: string;
  /** path the claim is about, when a file is named */
  artifact: string | null;
}

/**
 * Classify a work-history claim against recorded operations only.
 * Fail-closed: no matching write record → the claim can never be confirmed.
 */
export function classifyAttributionClaim(text: string, facts: AttributionFacts): { status: AttributionStatus; claimed: boolean; reason: string; note: string } {
  const claimsCreation = CREATION_CLAIM_RE.test(text) || ORIGIN_CLAIM_RE.test(text) || OWNERSHIP_ASK_RE.test(text) || OWNERSHIP_TARGETED_RE.test(text);
  if (!claimsCreation) return { status: "UNKNOWN", claimed: false, reason: "tidak ada klaim authorship di teks", note: "" };

  const project = facts.artifact ? projectIdFor(facts.artifact).id : null;
  // A question about a SIBLING ("apakah Michelle yang bikin X?") must be judged
  // on the subject's records, not on the speaker's own ops: filtering to the
  // speaker made Mia deny a contribution the audit log plainly records.
  const subject = subjectAgent(text) ?? facts.agent;
  const writes = facts.events.filter((e) => e.agent_id === subject && e.event_type === "MODIFIED" && (!project || e.project_id === project));
  const reads = facts.events.filter((e) => e.agent_id === subject && (e.event_type === "INSPECTED" || e.event_type === "REVIEWED") && (!project || e.project_id === project));
  const named = FILE_MENTION_RE.exec(text)?.[0] ?? null;
  // A write in the SAME project says nothing about a DIFFERENT file: scoping to
  // the named artifact is what stops "you wrote index.html" from confirming
  // "you made nusa.html". And no write record may never reach the
  // "a write exists" branch below — that would invent evidence.
  // No file named = a question about the work as a whole. Scoping to
  // `project_id === null` there discarded EVERY write record, so a project-level
  // claim answered "no operations recorded" while the same reply's history
  // line listed the files. Project scoping already happened above.
  const inScope = (e: (typeof facts.events)[number]): boolean =>
    named ? Boolean(e.artifact_reference?.endsWith(named)) : !project || e.project_id === project;
  const fileWrites = writes.filter(inScope);
  const fileReads = reads.filter(inScope);

  if (fileWrites.length === 0) {
    const readOnly = fileReads.length > 0;
    return {
      status: readOnly ? "CONFIRMED_INSPECTION" : "HISTORICAL_UNVERIFIED",
      claimed: true,
      reason: readOnly
        ? `tidak ada operasi tulis yang tercatat; yang ada hanya ${fileReads.length} operasi baca`
        : "tidak ada operasi tulis maupun baca yang tercatat untuk klaim ini",
      note: readOnly
        ? "Yang tercatat cuma dibaca, bukan dibuat — jadi penciptaan project ini belum bisa dipastikan dari riwayat."
        : "Riwayat yang tersedia belum punya catatan operasi apa pun untuk klaim itu, jadi belum bisa dipastikan.",
    };
  }

  // A write exists → the contribution is provable, but ORIGIN is not: the log
  // records the operation, never whether the file or project predated it.
  return {
    status: "PARTIALLY_SUPPORTED",
    claimed: true,
    reason: `${fileWrites.length} operasi tulis tercatat, tetapi tidak ada bukti bahwa file/project itu belum ada sebelumnya`,
    note: "Operasi tulisnya tercatat, tapi sistem tidak punya bukti apakah file ini baru dibuat atau hanya diperbarui — jadi asal-usulnya belum bisa dipastikan.",
  };
}

/** Answering policy: what an agent may say about past work, given only records. */
export function workHistoryNote(agent: string, artifact: string | null, events: WorkEvent[]): string {
  // "Riwayat tercatat untuk unknown" reads like a bug to the owner; when the
  // question named no file, label the ledger with the project actually seen.
  const project = artifact ? projectIdFor(artifact).name : events[0]?.project_name ?? "unknown";
  const mine = artifact
    ? events.filter((e) => e.agent_id === agent && e.artifact_reference?.endsWith(`/${artifact.split("/").pop()}`))
    : events.filter((e) => e.agent_id === agent);
  if (mine.length === 0) return "";
  const wrote = mine.filter((e) => e.event_type === "MODIFIED");
  const read = mine.filter((e) => e.event_type === "INSPECTED" || e.event_type === "REVIEWED");
  const parts: string[] = [];
  if (wrote.length) parts.push(`menulis ${new Set(wrote.map((e) => e.artifact_reference)).size} file`);
  if (read.length) parts.push(`membaca ${new Set(read.map((e) => e.artifact_reference)).size} file`);
  const last = mine[0]!.timestamp.slice(0, 10);
  return `Riwayat tercatat untuk ${project}: ${parts.join(", ")} (terakhir ${last}). Asal-usul project belum terverifikasi.`;
}
/**
 * Response-side guard: when a reply claims authorship of past work, append what
 * the RECORD actually says. Deliberately not a prompt rule — a prompt is a
 * request, this is a correction computed from the audit log.
 */
/** Cheap pre-check: is there any authorship claim to police? */
// Owner phrasing is often inverted — "BisaModule itu bikin kamu?" has no
// interrogative opener, so the pattern above misses it and the claim went
export function hasAuthorshipClaim(text: string): boolean {
  return CREATION_CLAIM_RE.test(text) || ORIGIN_CLAIM_RE.test(text) || OWNERSHIP_ASK_RE.test(text) || OWNERSHIP_TARGETED_RE.test(text);
}

export function attributionNote(text: string, opts: { user?: unknown; agent?: string }): string {
  // Every turn would otherwise read + JSON.parse the whole audit log to conclude
  // there is no claim in the message.
  if (!hasAuthorshipClaim(text)) return "";
  const events = readWorkEvents(opts.user === undefined || opts.user === null ? undefined : String(opts.user));
  const agent = opts.agent ?? "mia";
  const verdict = classifyAttributionClaim(text, { events, agent, artifact: FILE_MENTION_RE.exec(text)?.[0] ?? null });
  if (!verdict.claimed || verdict.status === "CONFIRMED_CONTRIBUTION") return "";
  const artifact = FILE_MENTION_RE.exec(text)?.[0] ?? null;
  const history = workHistoryNote(agent, artifact, events);
  return [verdict.note, history].filter(Boolean).join(" ").trim();
}
