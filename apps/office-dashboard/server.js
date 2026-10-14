#!/usr/bin/env node
'use strict';
/*
 * AI Office Dashboard — backend.
 *
 * Zero external dependencies: only node builtins (http, fs, path, os, url, child_process).
 * Listens on 127.0.0.1:3001 by default (override with PORT).
 *
 * Data policy: every number rendered by this server comes from a real source
 *   - apps/office-dashboard/data/tasks.jsonl   (ledger, append-only)
 *   - apps/office-dashboard/data/queue.jsonl   (quick-task queue, append-only)
 *   - apps/office-dashboard/data/dispatch.json (paused flag)
 *   - apps/office-dashboard/data/schedules-state.json (scheduler exactly-once slots)
 *   - apps/web/.data/audit/AUDIT-*.log        (real agent activity from Mia)
 *   - OS / process facts from node builtins
 * Anything that cannot be read is reported as unavailable — never invented.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.jsonl');
const QUEUE_FILE = path.join(DATA_DIR, 'queue.jsonl');
const DISPATCH_FILE = path.join(DATA_DIR, 'dispatch.json');
const PUBLIC_URL_FILE = path.join(ROOT, 'PUBLIC_URL.txt');
const WATCHDOG_HISTORY_FILE = path.join(ROOT, 'watchdog-history.jsonl');

const PORT = Number(process.env.PORT || 3001);
const HOST = '127.0.0.1';
const MIA_WEB_DIR = path.resolve(ROOT, '..', 'web');
const AUDIT_DIR = path.join(MIA_WEB_DIR, '.data', 'audit');
const MIA_LLM_URL = process.env.MIA_LLM_URL || 'http://127.0.0.1:3000/api/llm';
// The only endpoint that actually pushes a reply to the owner's channel and
// tells us whether the push happened (pushed: true/false).
const MIA_WEBHOOK_URL = process.env.MIA_WEBHOOK_URL || new URL('/api/webhook', MIA_LLM_URL).toString();
// Only needed when Mia has WEBHOOK_SECRET set; the webhook route rejects the
// call with 401 otherwise, which we surface honestly as a failed task.
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
// Push-target label the office dashboard delivers to. Must match a label
// registerPushTarget() published (see channels/discord.ts pushLabels).
const DELIVERY_LABEL = process.env.OFFICE_DELIVERY_LABEL || 'office';

/**
 * Which push label posts the result. Each trio member registers its OWN
 * (`office` / `office-agnes` / `office-michelle`), so a task assigned to Agnes is
 * delivered by Agnes' bot instead of whichever bot registered last.
 */
function deliveryLabelFor(agentId) {
  const base = DELIVERY_LABEL;
  if (agentId && agentId !== 'mia') return `${base}-${agentId}`;
  return base;
}
// Origin of Mia's Next app, derived from the LLM URL so there is one knob.
const MIA_WEB_BASE = process.env.MIA_WEB_BASE || new URL(MIA_LLM_URL).origin;
const OWNER_USER = process.env.OFFICE_OWNER_USER || 'naufalazhar652952';
const WORKING_WINDOW_MS = Number(process.env.OFFICE_WORKING_WINDOW_MS || 120000);
const DISPATCH_TIMEOUT_MS = Number(process.env.OFFICE_DISPATCH_TIMEOUT_MS || 180000);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_PROMPT_CHARS = 4000;
const AUTH_COOKIE = 'mia_auth'; // same cookie name as apps/web/src/lib/authGuard.ts

const AGENTS = [
  { id: 'mia', name: 'Mia', role: 'Main Assistant / Coordinator', user: OWNER_USER, accent: '#8b9dc3', idle: [-2.6, 0, 3.4], desk: [-2.6, 0, -1.6] },
  { id: 'agnes', name: 'Agnes', role: 'Researcher', user: `${OWNER_USER}.agnes`, accent: '#7fae9b', idle: [0, 0, 3.6], desk: [0, 0, -1.6] },
  { id: 'michelle', name: 'Michelle', role: 'Coder', user: `${OWNER_USER}.michelle`, accent: '#a08fc0', idle: [2.6, 0, 3.4], desk: [2.6, 0, -1.6] },
];
const AGENT_IDS = AGENTS.map((a) => a.id);

/* ─────────────────────────── small utils ─────────────────────────── */

function ensureDirs() {
  for (const d of [DATA_DIR]) fs.mkdirSync(d, { recursive: true });
  for (const f of [TASKS_FILE, QUEUE_FILE]) if (!fs.existsSync(f)) fs.writeFileSync(f, '');
  if (!fs.existsSync(DISPATCH_FILE)) fs.writeFileSync(DISPATCH_FILE, '{"paused":false}\n');
}

function readJsonl(file, { limitBytes = 512 * 1024 } = {}) {
  let raw;
  try {
    const st = fs.statSync(file);
    const start = st.size > limitBytes ? st.size - limitBytes : 0;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    raw = buf.toString('utf8');
  } catch {
    return { rows: [], broken: 0, missing: true };
  }
  const rows = [];
  let broken = 0;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v === 'object') rows.push(v);
      else broken++;
    } catch {
      broken++; // one corrupt line must never take the API down
    }
  }
  return { rows, broken, missing: false };
}

function appendJsonl(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

// Append-only writes to a small state file (rewriting the whole object).
function writeJson(file, obj) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Mask anything that looks like a credential before it can reach the UI or a log. */
function redact(value) {
  if (typeof value !== 'string') return value;
  let s = value;
  s = s.replace(/(sk-[A-Za-z0-9_\-]{6})[A-Za-z0-9_\-]+/g, '$1***');
  s = s.replace(/(xoxb|xoxp|xapp|ghp|gho|github_pat)-[A-Za-z0-9-]{6,}/gi, '$1-***');
  s = s.replace(/([?&](?:api[_-]?key|key|token|password|passwd|secret|access_token)=)[^&\s"']+/gi, '$1***');
  s = s.replace(/((?:api[_-]?key|token|password|passwd|secret|authorization|cookie)\s*[:=]\s*)("?)[^\s"',}]{6,}\2/gi, '$1***');
  s = s.replace(/\b(?:MTIz|OTU5)[A-Za-z0-9_.-]{20,}\b/g, '***discord-token***');
  s = s.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, '***jwt***');
  return s;
}

function truncate(s, n) {
  if (typeof s !== 'string') return s;
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/* ─────────────────────────── auth (reuse Mia's) ─────────────────────────── */

/**
 * Mia already has a single-owner gate in apps/web/src/lib/authGuard.ts:
 * AUTH_TOKEN env, cookie `mia_auth`, or `Authorization: Bearer <token>`.
 * We read the same env value from apps/web/.env.local so the dashboard and
 * Mia share one password. If no token exists anywhere, auth is disabled and
 * the server stays local-only (it refuses to start a tunnel; see watchdog.sh).
 */
function readEnvFile(file) {
  const out = {};
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const key = t.slice(0, i).trim();
    let val = t.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

const MIA_ENV = readEnvFile(path.join(MIA_WEB_DIR, '.env.local'));
const AUTH_TOKEN = process.env.DASHBOARD_TOKEN || MIA_ENV.AUTH_TOKEN || '';
const AUTH_ENABLED = AUTH_TOKEN.length > 0;

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

/** Same contract as authGuard.isAuthorized: cookie OR bearer OR ?token= (local UI). */
function isAuthorized(req) {
  if (!AUTH_ENABLED) return true;
  try {
    var q = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('token');
    if (q && timingSafeEqual(q, AUTH_TOKEN)) return true;
  } catch (e) {}
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[AUTH_COOKIE] && timingSafeEqual(cookies[AUTH_COOKIE], AUTH_TOKEN)) return true;
  const auth = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m && timingSafeEqual(m[1].trim(), AUTH_TOKEN)) return true;
  return false;
}

/* ─────────────────────────── real activity: Mia's audit log ─────────────────────────── */

function auditFiles() {
  let names = [];
  try {
    names = fs.readdirSync(AUDIT_DIR).filter((n) => /^AUDIT-\d{4}-\d{2}-\d{2}\.log$/.test(n)).sort();
  } catch {
    return [];
  }
  return names.slice(-2).map((n) => path.join(AUDIT_DIR, n));
}

/** Map a Mia audit `user` field onto one of our three agent ids. */
function agentForUser(user) {
  if (!user) return null;
  if (user.endsWith('.agnes')) return 'agnes';
  if (user.endsWith('.michelle')) return 'michelle';
  if (user === OWNER_USER) return 'mia';
  return null;
}

function readAudit() {
  const files = auditFiles();
  if (!files.length) {
    return { available: false, note: `Audit log tidak ditemukan di ${AUDIT_DIR}`, files: 0, events: [] };
  }
  const events = [];
  let broken = 0;
  for (const f of files) {
    const parsed = readJsonl(f, { limitBytes: 1024 * 1024 });
    broken += parsed.broken;
    for (const row of parsed.rows) {
      const agent = agentForUser(row.user);
      if (!agent) continue;
      const action = String(row.action || '');
      const at = Date.parse(row.ts || '');
      events.push({
        ts: row.ts || null,
        at: Number.isFinite(at) ? at : null,
        agent,
        user: row.user,
        action,
        detail: redact(truncate(String(row.detail ?? ''), 400)),
        file: path.basename(f),
      });
    }
  }
  events.sort((a, b) => (a.at || 0) - (b.at || 0));
  return { available: true, note: null, files: files.length, broken, events };
}

/**
 * Agent status is DERIVED from real audit events and the derivation is exposed
 * to the UI (basis + window), so nobody has to trust an invented "busy" flag.
 *   working — the newest event for this agent is a turn start or a tool call
 *             and it happened less than WORKING_WINDOW_MS ago
 *   idle    — anything older, or no events at all
 *   paused  — dispatch.json says the fleet is paused (global, honest)
 */
/**
 * The audit log stores a tool call's raw JSON arguments in `detail`. Showing
 * that verbatim under an agent's name (e.g. `{"expression":"12*8"}`) is real
 * data but unreadable, so pull out the human-meaningful part: the tool name
 * plus its first short scalar argument.
 */
function summarizeTool(action, detail) {
  const tool = action.startsWith('tool:') ? action.slice(5) : action;
  let arg = '';
  const s = String(detail || '').trim();
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s);
      const first = Array.isArray(parsed) ? parsed[0] : Object.values(parsed || {})[0];
      if (typeof first === 'string' || typeof first === 'number') {
        const v = truncate(String(first), 40).replace(/\s+/g, ' ');
        if (v && !/^https?:/i.test(v)) arg = ` · ${v}`;
      }
    } catch {
      /* not valid JSON after all — fall back to the tool name alone */
    }
  }
  return truncate(tool, 48) + arg;
}

function deriveAgents(audit, paused) {
  return AGENTS.map((a) => {
    const own = audit.available ? audit.events.filter((e) => e.agent === a.id) : [];
    const last = own.length ? own[own.length - 1] : null;
    const age = last && last.at ? Date.now() - last.at : null;
    let status = 'idle';
    if (last && age != null && age <= WORKING_WINDOW_MS) {
      status = last.action === 'turn_error' ? 'idle' : 'working';
    }
    if (paused) status = 'paused';
    const turnStarts = own.filter((e) => e.action === 'turn_provider').length;
    const turnErrors = own.filter((e) => e.action === 'turn_error').length;
    const tools = own.filter((e) => e.action.startsWith('tool')).length;
    return {
      id: a.id,
      name: a.name,
      role: a.role,
      accent: a.accent,
      status,
      active_task: last && last.action.startsWith('tool') && age != null && age <= WORKING_WINDOW_MS ? summarizeTool(last.action, last.detail) : null,
      last_event: last ? { ts: last.ts, action: last.action, detail: last.detail, source: last.file } : null,
      last_update: last ? last.ts : null,
      basis: audit.available
        ? { kind: 'audit-log', window_ms: WORKING_WINDOW_MS, last_age_ms: age, turns: turnStarts, turn_errors: turnErrors, tool_calls: tools }
        : { kind: 'unavailable', note: audit.note },
      log_available: audit.available,
    };
  });
}

/* ─────────────────────────── ledger (tasks.jsonl) ─────────────────────────── */

const observedTurns = new Set(); // task_ids already mirrored from the audit log

/**
 * `turn-<agent>-<at>` is stable for a given audit event, but an audit FILE can
 * contain several turn_error rows for one turn (verify drills re-run the same
 * confirm-decline completion, and Mia logs each attempt). Mirroring needs a
 * key that identifies the failure itself, not just the turn.
 */
function mirrorFailureKey(taskId, detail) {
  return `${taskId}::failed::${hash32(String(detail || ''))}`;
}

function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * Mirror real agent turns into tasks.jsonl so the dashboard has a durable,
 * append-only history without inventing anything. Each observed turn gets a
 * stable task_id and one `started` event; a turn_error closes it as `failed`.
 *
 * Dedup MUST be restart-durable. `observedTurns` is an in-memory Set, so after
 * a dashboard restart every previously-mirrored turn looked new and got
 * re-appended — which is why the owner saw one failure listed three times with
 * three identical `ts` values. We therefore seed the sets from the file on
 * first use, so restarts replay nothing.
 */
let observedSeeded = false;
function seedObservedFromLedger() {
  if (observedSeeded) return;
  observedSeeded = true; // set first: readJsonl below must not re-enter
  const { rows } = readJsonl(TASKS_FILE);
  for (const ev of rows) {
    if (!ev.task_id) continue;
    if (ev.status === 'failed') {
      observedTurns.add(mirrorFailureKey(ev.task_id, ev.detail));
    } else {
      observedTurns.add(ev.task_id);
    }
  }
}

function mirrorAuditTurns(audit) {
  if (!audit.available) return;
  seedObservedFromLedger();
  const openTurns = new Map(); // agent -> {task_id, ts}
  for (const e of audit.events) {
    if (e.action === 'turn_provider') {
      const taskId = `turn-${e.agent}-${e.at || Date.now()}`;
      if (!observedTurns.has(taskId)) {
        appendJsonl(TASKS_FILE, {
          ts: new Date().toISOString(),
          task_id: taskId,
          agent: e.agent,
          subagent: null,
          title: `Turn ${e.agent} via ${redact(e.detail || 'provider')}`,
          status: 'started',
          detail: 'Diamati dari audit log Mia (bukan simulasi).',
          source: 'audit-mirror',
        });
        observedTurns.add(taskId);
      }
      openTurns.set(e.agent, taskId);
    } else if (e.action === 'turn_error' && openTurns.has(e.agent)) {
      const taskId = openTurns.get(e.agent);
      const detail = redact(truncate(e.detail || 'turn failed', 400));
      const failKey = mirrorFailureKey(taskId, detail);
      if (observedTurns.has(failKey)) continue; // already mirrored — see above
      appendJsonl(TASKS_FILE, {
        ts: new Date().toISOString(),
        task_id: taskId,
        agent: e.agent,
        subagent: null,
        title: null,
        status: 'failed',
        detail,
        source: 'audit-mirror',
      });
      observedTurns.add(failKey);
    }
  }
}

/** Fold append-only events into current status + history per task_id. */
function buildTasks() {
  const { rows, broken, missing } = readJsonl(TASKS_FILE);
  const byId = new Map();
  for (const ev of rows) {
    const id = ev.task_id;
    if (!id) continue;
    if (!AGENT_IDS.includes(ev.agent)) continue;
    let t = byId.get(id);
    if (!t) {
      t = { task_id: id, agent: ev.agent, title: ev.title || '(tanpa judul)', status: 'started', started_at: ev.ts, updated_at: ev.ts, source: ev.source || 'dashboard', detail: ev.detail || '', history: [] };
      byId.set(id, t);
    }
    if (ev.title && (t.title === '(tanpa judul)' || !t.title)) t.title = ev.title;
    if (ev.status) t.status = ev.status;
    if (ev.detail) t.detail = ev.detail;
    // Delivery facts ride along so the UI never has to guess whether a
    // "kirim ke Discord" task actually reached Discord.
    if (ev.deliver) t.deliver = ev.deliver;
    if (ev.deliver_to) t.deliver_to = ev.deliver_to;
    if (ev.delivered !== undefined && ev.delivered !== null) t.delivered = ev.delivered;
    t.updated_at = ev.ts;
    t.history.push({ ts: ev.ts, status: ev.status, detail: ev.detail || '' });
  }
  const list = [...byId.values()].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  return { tasks: list, broken_lines: broken, ledger_missing: missing };
}

/* ─────────────────────────── queue + real dispatch ─────────────────────────── */

function buildQueue() {
  const { rows, broken, missing } = readJsonl(QUEUE_FILE);
  const byId = new Map();
  for (const r of rows) {
    if (!r.id) continue;
    const prev = byId.get(r.id);
    byId.set(r.id, {
      id: r.id,
      ts: r.ts,
      prompt: r.prompt,
      agent: r.agent,
      deliver: r.deliver || (prev && prev.deliver) || 'auto',
      status: r.status || (prev && prev.status) || 'queued',
      detail: r.detail != null ? r.detail : prev ? prev.detail : null,
      task_id: r.task_id || (prev && prev.task_id) || null,
    });
  }
  const list = [...byId.values()].sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  return { queue: list, broken_lines: broken, ledger_missing: missing };
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Does this quick-task want its result delivered somewhere?
 *
 * `explicit` is the UI checkbox (decisive when set). Otherwise we read the
 * prompt — but ONLY when it names the destination AND asks for a send, so
 * "apa kabar discord?" is not treated as a delivery request.
 */
function deliverRequested(prompt, explicit) {
  if (explicit === 'discord') return true;
  if (explicit === 'none') return false;
  const p = String(prompt || '');
  if (!/\bdiscord\b/i.test(p)) return false;
  return /(kirim|kirimkan|teruskan|bagikan|share|send|balas|inbox|terima)/i.test(p);
}

/**
 * Real dispatch: call Mia's own /api/llm with the agent's user key.
 * No shell, no user-controlled command — just an HTTP POST to a fixed local URL.
 *
 * When delivery to Discord is requested we go through /api/webhook instead,
 * because that endpoint is the only one that actually pushes the result to the
 * owner's channel and REPORTS whether the push happened. /api/llm only returns
 * text to us, so routing delivery through it would have been a silent no-op —
 * the task would look finished while nothing reached Discord.
 */
async function dispatchQueueItem(item) {
  const agent = AGENTS.find((a) => a.id === item.agent);
  const taskId = `task-${item.id}`;
  const userKey = agent ? agent.user : OWNER_USER;
  const wantDeliver = deliverRequested(item.prompt, item.deliver);
  const target = wantDeliver ? MIA_WEBHOOK_URL : MIA_LLM_URL;
  appendJsonl(TASKS_FILE, { ts: new Date().toISOString(), task_id: taskId, agent: item.agent, subagent: null, title: truncate(item.prompt, 120), status: 'started', detail: `Dikirim ke Mia (POST ${wantDeliver ? '/api/webhook → Discord' : '/api/llm'}).`, deliver: wantDeliver ? 'discord' : 'none', delivered: null, source: 'dashboard' });
  appendJsonl(QUEUE_FILE, { ...item, status: 'done', task_id: taskId, detail: 'dispatched' });
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), DISPATCH_TIMEOUT_MS);
  const payload = wantDeliver
    ? { prompt: item.prompt, user: userKey, agent: item.agent, deliver_to: deliveryLabelFor(item.agent), ...(WEBHOOK_SECRET ? { secret: WEBHOOK_SECRET } : {}) }
    : { messages: [{ role: 'user', content: item.prompt }], user: userKey, channel: 'office-dashboard' };
  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch { /* non-JSON body is handled below */ }
    if (!res.ok) {
      appendJsonl(TASKS_FILE, { ts: new Date().toISOString(), task_id: taskId, agent: item.agent, subagent: null, title: null, status: 'failed', deliver: wantDeliver ? 'discord' : 'none', delivered: false, detail: redact(truncate(`HTTP ${res.status}: ${(data && data.message) || raw}`, 400)), source: 'dashboard' });
      return;
    }
    if (!wantDeliver) {
      appendJsonl(TASKS_FILE, {
        ts: new Date().toISOString(),
        task_id: taskId,
        agent: item.agent,
        subagent: null,
        title: null,
        status: 'done',
        deliver: 'none',
        delivered: null,
        detail: redact(truncate(raw.replace(/\s+/g, ' ').trim(), 400)),
        source: 'dashboard',
      });
      return;
    }
    // Delivery path — never say "done" unless Discord actually got it.
    const text = redact(truncate(String((data && data.text) || '(no reply)').replace(/\s+/g, ' ').trim(), 300));
    if (data && data.status === 'needs_confirmation') {
      appendJsonl(TASKS_FILE, { ts: new Date().toISOString(), task_id: taskId, agent: item.agent, subagent: null, title: null, status: 'failed', deliver: 'discord', delivered: false, detail: redact(truncate(`Butuh konfirmasi tool (${data.tool && data.tool.name ? data.tool.name : '?'}) — tidak dikirim ke Discord.`, 400)), source: 'dashboard' });
      return;
    }
    if (data && data.pushed === true) {
      // Name the destination. "✅ Terkirim ke Discord" was true but useless —
      // the owner could not tell it had landed in his DM instead of the office
      // channel, which is exactly how a mis-routed delivery stays invisible.
      appendJsonl(TASKS_FILE, { ts: new Date().toISOString(), task_id: taskId, agent: item.agent, subagent: null, title: null, status: 'done', deliver: 'discord', delivered: true, deliver_to: data.delivered_to || deliveryLabelFor(item.agent), detail: `✅ Terkirim ke Discord [${data.delivered_to || deliveryLabelFor(item.agent)}] — ${text}`, source: 'dashboard' });
      return;
    }
    appendJsonl(TASKS_FILE, { ts: new Date().toISOString(), task_id: taskId, agent: item.agent, subagent: null, title: null, status: 'failed', deliver: 'discord', delivered: false, detail: redact(truncate(`Mia menjawab tapi hasil TIDAK terkirim ke Discord${data && data.push_error ? ` (${data.push_error})` : ''} — ${text}`, 400)), source: 'dashboard' });
  } catch (err) {
    appendJsonl(TASKS_FILE, { ts: new Date().toISOString(), task_id: taskId, agent: item.agent, subagent: null, title: null, status: 'failed', deliver: wantDeliver ? 'discord' : 'none', delivered: false, detail: redact(truncate(`${err.name}: ${err.message} (${Date.now() - started}ms)`, 400)), source: 'dashboard' });
  } finally {
    clearTimeout(timer);
  }
}

let dispatching = false;
async function dispatchLoop() {
  if (dispatching) return;
  const dispatchState = readJson(DISPATCH_FILE, { paused: false });
  if (dispatchState.paused) return;
  const { queue } = buildQueue();
  const next = queue.find((q) => q.status === 'queued');
  if (!next) return;
  dispatching = true;
  try {
    await dispatchQueueItem(next);
  } finally {
    dispatching = false;
  }
}

/* ─────────────────────────── system + vps ─────────────────────────── */

function diskInfo() {
  try {
    // Fixed argv, no shell, no user input.
    const out = execFileSync('/bin/df', ['-k', '/'], { encoding: 'utf8' });
    const lines = out.trim().split('\n');
    const cols = lines[1].trim().split(/\s+/);
    const total = Number(cols[1]) * 1024;
    const used = Number(cols[2]) * 1024;
    const avail = Number(cols[3]) * 1024;
    const pct = cols[4] ? Number(String(cols[4]).replace('%', '')) : null;
    return { available: true, total_bytes: total, used_bytes: used, free_bytes: avail, used_pct: pct, mount: '/', warning: pct != null && pct >= 90 };
  } catch (err) {
    return { available: false, note: `df gagal: ${err.message}` };
  }
}

/**
 * Honest host memory on macOS.
 *
 * `os.freemem()` counts only pages the kernel considers *free*; on Darwin it
 * excludes inactive/purgeable/speculative pages, which the kernel reclaims
 * instantly under pressure. Dividing (total - free)/total therefore reports a
 * permanently alarming ~99% "used" on an idle 8 GB Mac — the same trap as
 * `df /` on macOS (sealed system snapshot), already documented for Mia.
 *
 * Used  = active + wired + compressed  (what the kernel cannot hand back)
 * Avail = free + inactive + speculative + purgeable
 * Both are derived from `vm_stat`, so we report what macOS actually means and
 * label the method instead of inventing a Linux-style number.
 */
function hostMemory() {
  const total = os.totalmem();
  const pageSize = 4096;
  const base = { available: true, scope: 'host', total_bytes: total, method: 'os.freemem (linux-style)' };
  if (process.platform !== 'darwin') {
    const free = os.freemem();
    return { ...base, free_bytes: free, used_bytes: total - free, used_pct: Number((((total - free) / total) * 100).toFixed(1)) };
  }
  try {
    const out = execFileSync('/usr/bin/vm_stat', { encoding: 'utf8', timeout: 5000 });
    const sizeLine = out.match(/page size of (\d+) bytes/);
    const ps = sizeLine ? Number(sizeLine[1]) : pageSize;
    const num = (label) => {
      const m = out.match(new RegExp(`^${label}:\\s+(\\d+)\\.?$`, 'm'));
      return m ? Number(m[1]) * ps : 0;
    };
    const free = num('Pages free');
    const active = num('Pages active');
    const inactive = num('Pages inactive');
    const spec = num('Pages speculative');
    const wired = num('Pages wired down');
    const compressed = num('Pages occupied by compressor');
    const purgeable = num('Pages purgeable');
    const used = active + wired + compressed;
    const avail = free + inactive + spec + purgeable;
    const denom = used + avail;
    if (denom <= 0) throw new Error('vm_stat produced no usable page counts');
    return {
      available: true,
      scope: 'host',
      total_bytes: total,
      method: 'vm_stat (macOS: used = active+wired+compressed)',
      free_bytes: avail,
      used_bytes: used,
      used_pct: Number(((used / denom) * 100).toFixed(1)),
    };
  } catch (err) {
    // Never invent a number we could not measure.
    return { ...base, free_bytes: os.freemem(), note: `vm_stat gagal (${err && err.message ? err.message : err}) — angka di bawah memakai os.freemem() yang menipu di macOS.` };
  }
}

function systemInfo() {
  const load = os.loadavg();
  const cpus = os.cpus() || [];
  const mem = hostMemory();
  return {
    available: true,
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cpu_model: cpus.length ? cpus[0].model : null,
    cpu_cores: cpus.length || null,
    loadavg_1m: Number(load[0].toFixed(2)),
    loadavg_5m: Number(load[1].toFixed(2)),
    loadavg_15m: Number(load[2].toFixed(2)),
    host_memory_total_bytes: mem.total_bytes,
    host_memory_free_bytes: mem.free_bytes,
    host_memory_used_pct: mem.used_pct,
    host_memory_method: mem.method,
    // Spec §5 container rule: on Linux we would sum resident pages from
    // /proc/[pid]/statm. This host is macOS — there is no container cgroup to
    // read, so we say so instead of inventing a container number.
    container_memory: { available: false, note: 'Host macOS — tidak ada container/cgroup yang bisa diukur. Memory di atas adalah HOST.' },
    node_version: process.version,
    dashboard_uptime_s: Math.round(process.uptime()),
    dashboard_rss_bytes: process.memoryUsage().rss,
    scope_note: 'Nilai di atas adalah metrik host tempat dashboard berjalan (bukan nilai container terpisah).',
  };
}

function watchdogStatus() {
  const { rows } = readJsonl(WATCHDOG_HISTORY_FILE, { limitBytes: 64 * 1024 });
  const last = rows.length ? rows[rows.length - 1] : null;
  return last
    ? { available: true, last_check: last.ts, ok: last.ok, action: last.action, url: last.url || null, error: last.error || null }
    : { available: false, note: 'watchdog belum pernah berjalan (watchdog-history.jsonl kosong).' };
}

async function tunnelStatus() {
  let url = '';
  try {
    url = fs.readFileSync(PUBLIC_URL_FILE, 'utf8').trim();
  } catch {
    return { available: false, url: null, online: false, note: 'PUBLIC_URL.txt kosong — tunnel belum pernah diekspos.' };
  }
  if (!url) return { available: false, url: null, online: false, note: 'PUBLIC_URL.txt kosong — tunnel belum pernah diekspos.' };
  // Live check, not "process exists".
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 5000);
  try {
    const res = await fetch(url, { method: 'GET', signal: ac.signal, redirect: 'follow' });
    return { available: true, url, online: res.status >= 200 && res.status < 400, status: res.status };
  } catch (err) {
    return { available: true, url, online: false, error: redact(err.message) };
  } finally {
    clearTimeout(t);
  }
}

/* ─────────────────────────── schedules (frontmatter) ─────────────────────────── */

function scheduleDirs() {
  const configured = (process.env.OFFICE_SCHEDULE_DIRS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const base = configured.length ? configured : [path.join(os.homedir(), 'workspace', 'cron.d')];
  const dirs = [];
  const notes = [];
  for (const d of base) {
    // expand ~/workspace/goals/*/crons style globs one level
    if (d.includes('*')) {
      const [parent, star, ...rest] = d.split('/');
      const parentPath = parent === '~' ? os.homedir() : parent;
      const restPath = rest.join('/');
      try {
        for (const entry of fs.readdirSync(path.join(parentPath, star))) {
          dirs.push(path.join(parentPath, star, entry, restPath));
        }
      } catch {
        notes.push(`Tidak bisa membaca ${d}`);
      }
      continue;
    }
    const resolved = d.startsWith('~') ? path.join(os.homedir(), d.slice(1)) : d;
    dirs.push(resolved);
  }
  const existing = dirs.filter((d) => fs.existsSync(d));
  return { dirs, existing, notes };
}

/** Minimal YAML subset: key: value, nested one level by indent, booleans/numbers/quoted strings. Never eval. */
function parseFrontmatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const root = {};
  let section = null;
  for (const rawLine of m[1].split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    const i = line.indexOf(':');
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if (val === '') {
      if (indent === 0) {
        section = {};
        root[key] = section;
      }
      continue;
    }
    val = val.replace(/\s+#.*$/, '').trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    else if (val === 'true') val = true;
    else if (val === 'false') val = false;
    else if (/^-?\d+(\.\d+)?$/.test(val)) val = Number(val);
    if (indent > 0 && section) section[key] = val;
    else root[key] = val;
  }
  return root;
}

function tzOffsetMs(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const parts = dtf.formatToParts(date).reduce((acc, p) => ((acc[p.type] = p.value), acc), {});
  const asUTC = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return asUTC - date.getTime();
}

/** Convert a wall-clock time in `tz` to a UTC instant (two passes, DST-safe enough for WIB). */
function zonedToUtc(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  let ts = guess - tzOffsetMs(new Date(guess), tz);
  ts = guess - tzOffsetMs(new Date(ts), tz);
  return new Date(ts);
}

const DAY_IDS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS_ID = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

function fmtIdDate(d) {
  return `${d.getDate()} ${MONTHS_ID[d.getMonth()]} ${d.getFullYear()}`;
}
function fmtIdTime(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function scheduleLabel(s) {
  const tz = s.timezone || 'Asia/Jakarta';
  const now = new Date();
  if (s.kind === 'runonce') {
    if (!s.at) return { label: 'sekali • waktu belum bisa dihitung', next_iso: null };
    const d = new Date(s.at);
    if (Number.isNaN(d.getTime())) return { label: 'sekali • tanggal tidak valid', next_iso: null };
    const passed = d.getTime() <= now.getTime();
    return { label: `sekali • ${fmtIdDate(d)}, ${fmtIdTime(d)}`, next_iso: passed ? null : d.toISOString() };
  }
  if (s.kind === 'interval') {
    const mins = Number(s.every_minutes);
    if (!Number.isFinite(mins) || mins <= 0) return { label: 'interval • konfigurasi tidak valid', next_iso: null };
    return { label: `tiap ${mins} menit`, next_iso: new Date(now.getTime() + mins * 60000).toISOString() };
  }
  const offset = tzOffsetMs(now, tz);
  const local = new Date(now.getTime() + offset);
  const L = (h, mi) => zonedToUtc(local.getFullYear(), local.getMonth() + 1, local.getDate(), h, mi, tz);
  if (s.kind === 'daily') {
    let next = L(s.hour, s.minute);
    if (next.getTime() <= now.getTime()) next = new Date(next.getTime() + 24 * 3600 * 1000);
    return { label: `harian • ${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`, next_iso: next.toISOString() };
  }
  if (s.kind === 'weekly') {
    const targetDow = Number(s.day_of_week);
    if (!Number.isFinite(targetDow)) return { label: 'mingguan • hari tidak valid', next_iso: null };
    let next = L(s.hour, s.minute);
    let delta = (targetDow - next.getDay() + 7) % 7;
    if (delta === 0 && next.getTime() <= now.getTime()) delta = 7;
    next = new Date(next.getTime() + delta * 24 * 3600 * 1000);
    return { label: `mingguan • ${DAY_IDS[targetDow]}, ${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`, next_iso: next.toISOString() };
  }
  if (s.kind === 'monthly') {
    const day = Number(s.day);
    if (!Number.isFinite(day)) return { label: 'bulanan • tanggal tidak valid', next_iso: null };
    const y = local.getFullYear();
    const mo = local.getMonth() + 1;
    let next = zonedToUtc(y, mo, day, s.hour, s.minute, tz);
    if (next.getTime() <= now.getTime()) next = zonedToUtc(y, mo + 1 > 12 ? 1 : mo + 1, day, s.hour, s.minute, tz);
    return { label: `bulanan • tanggal ${day}, ${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`, next_iso: next.toISOString() };
  }
  return { label: `jenis tidak dikenal: ${s.kind}`, next_iso: null };
}

/** "11:43" or "11:43:07" -> {h,m}; anything else that Date can parse -> its local clock. */
function parseClock(value) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(value).trim());
  if (m) return { h: Number(m[1]) % 24, m: Number(m[2]) % 60, valid: true };
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return { h: d.getHours(), m: d.getMinutes(), valid: true };
  return { h: 0, m: 0, valid: false };
}
function hourFromAt(value) {
  return parseClock(value).h;
}
function minuteFromAt(value) {
  return parseClock(value).m;
}

const SCHED_STATE_FILE = path.join(DATA_DIR, 'schedules-state.json');

/* Schedule frontmatter contract (additive — files without the new keys keep
 * working exactly as before):
 *   id:, title:, owner:, enabled:, schedule: { kind, at/hour/minute/... } (lama)
 *   agent:   trio member id (mia/agnes/michelle, default mia)
 *   prompt:  single-line task text (default title:). The parser only reads
 *            single-line values, so multi-line prompts are NOT supported.
 *   deliver: discord | none | auto (default auto — same sniffing as /api/queue)
 * Execution means appending to the normal quick-task queue; the existing
 * dispatchLoop does the running, so pause/delivery/pushed-honesty all apply
 * unchanged. A schedule that is misconfigured never enqueues — exec_reason in
 * the API says why.
 */
function readScheduleEntries() {
  const { dirs, existing, notes } = scheduleDirs();
  const entries = [];
  let skipped = 0;
  for (const dir of existing) {
    let dirEntries = [];
    try {
      dirEntries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of dirEntries) {
      if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
      const full = path.join(dir, ent.name);
      let text = '';
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch {
        skipped++;
        continue;
      }
      const fm = parseFrontmatter(text);
      // A schedule must have a usable scalar id. `id:` with an empty value makes
      // the parser build a nested section instead, which would stringify to
      // "[object Object]" — skip those instead of surfacing a fake row.
      const fmId = fm && typeof fm.id === 'string' ? fm.id.trim() : '';
      if (!fm || !fmId) {
        skipped++;
        continue;
      }
      const sch = fm.schedule && typeof fm.schedule === 'object' ? fm.schedule : {};
      const kind = sch.kind || 'unknown';
      entries.push({
        id: fmId,
        title: String(fm.title || ent.name),
        enabled: fm.enabled === undefined ? null : !!fm.enabled,
        owner: fm.owner ? String(fm.owner) : null,
        kind,
        timezone: sch.timezone || 'Asia/Jakarta',
        // `at` may be a full timestamp (runonce) or a plain clock time like
        // "11:43" (daily/weekly/monthly). new Date("11:43") is an Invalid Date
        // and used to poison the whole payload with "Invalid time value", so
        // parse both shapes explicitly and fall back to an honest 00:00.
        hour: sch.at ? hourFromAt(sch.at) : Number(sch.hour || 0),
        minute: sch.at ? minuteFromAt(sch.at) : Number(sch.minute || 0),
        day_of_week: sch.day_of_week != null ? Number(sch.day_of_week) : sch.day_of_week,
        day: sch.day != null ? Number(sch.day) : null,
        every_minutes: sch.every_minutes != null ? Number(sch.every_minutes) : null,
        at: sch.at || null,
        agent: typeof fm.agent === 'string' ? fm.agent.trim() : null,
        prompt: typeof fm.prompt === 'string' ? fm.prompt : null,
        deliver: typeof fm.deliver === 'string' ? fm.deliver.trim() : null,
        // is_system only when ownership is provable from metadata (owner:system* / goal:system*)
        is_system: typeof fm.owner === 'string' && /^system/i.test(fm.owner),
        file: path.relative(ROOT, full),
      });
    }
  }
  return { dirs, existing, notes, skipped, entries };
}

function readSchedState() {
  const st = readJson(SCHED_STATE_FILE, {});
  return st && typeof st === 'object' ? st : {};
}

/** Most recent scheduled instant at or before `now` (daily/weekly/monthly).
 *  Returns a Date, or null when the time spec itself is invalid. Mirrors the
 *  same tz helpers scheduleLabel uses so display and execution agree. */
function scheduleSlot(s, now) {
  const tz = s.timezone || 'Asia/Jakarta';
  const offset = tzOffsetMs(now, tz);
  const local = new Date(now.getTime() + offset);
  const h = Number(s.hour);
  const mi = Number(s.minute);
  if (!Number.isFinite(h) || !Number.isFinite(mi) || h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  const Y = local.getFullYear();
  const MO = local.getMonth() + 1;
  const D = local.getDate();
  const at = (y, mo, d) => zonedToUtc(y, mo, d, h, mi, tz);
  const valid = (d) => d instanceof Date && !Number.isNaN(d.getTime());
  if (s.kind === 'daily') {
    let slot = at(Y, MO, D);
    if (!valid(slot)) return null;
    if (slot.getTime() > now.getTime()) slot = new Date(slot.getTime() - 24 * 3600 * 1000);
    return slot;
  }
  if (s.kind === 'weekly') {
    const dow = Number(s.day_of_week);
    if (!Number.isFinite(dow) || dow < 0 || dow > 6) return null;
    let slot = at(Y, MO, D);
    if (!valid(slot)) return null;
    const delta = (slot.getDay() - dow + 7) % 7;
    slot = new Date(slot.getTime() - delta * 24 * 3600 * 1000);
    if (slot.getTime() > now.getTime()) slot = new Date(slot.getTime() - 7 * 24 * 3600 * 1000);
    return slot;
  }
  if (s.kind === 'monthly') {
    const day = Number(s.day);
    if (!Number.isFinite(day) || day < 1) return null;
    const dim = new Date(Y, MO, 0).getDate();
    let slot = at(Y, MO, Math.min(day, dim));
    if (!valid(slot)) return null;
    if (slot.getTime() > now.getTime()) {
      const pm = MO === 1 ? 12 : MO - 1;
      const py = MO === 1 ? Y - 1 : Y;
      const pdim = new Date(py, pm, 0).getDate();
      slot = at(py, pm, Math.min(day, pdim));
      if (!valid(slot)) return null;
    }
    return slot;
  }
  return null;
}

/** Single source of truth for "can this schedule run, and is it due?".
 *  Used by BOTH the display (exec_ok/exec_reason) and the executor, so the
 *  dashboard can never promise what the runner refuses. */
function schedStatus(s, st, now) {
  if (s.enabled === false) return { ok: false, reason: 'disabled (enabled: false)', due: false, slotIso: null };
  const agent = s.agent || 'mia';
  if (!AGENT_IDS.includes(agent)) return { ok: false, reason: 'agen tak dikenal: ' + agent, due: false, slotIso: null };
  const prompt = (s.prompt != null ? s.prompt : s.title);
  const text = String(prompt == null ? '' : prompt).trim();
  if (!text) return { ok: false, reason: 'prompt kosong (isi prompt: atau title:)', due: false, slotIso: null };
  if (text.length > MAX_PROMPT_CHARS) return { ok: false, reason: 'prompt ' + text.length + ' chars > maks ' + MAX_PROMPT_CHARS, due: false, slotIso: null };
  if (s.kind === 'runonce') {
    if (!s.at) return { ok: false, reason: 'waktu runonce tidak valid (at:)', due: false, slotIso: null };
    const d = new Date(s.at);
    if (Number.isNaN(d.getTime())) return { ok: false, reason: 'waktu runonce tidak valid (at:)', due: false, slotIso: null };
    if (st.firedOnce) return { ok: true, reason: 'sudah dijalankan sekali', due: false, slotIso: d.toISOString() };
    if (d.getTime() > now.getTime()) return { ok: true, reason: 'menunggu jadwal', due: false, slotIso: d.toISOString() };
    return { ok: true, reason: 'jatuh tempo', due: true, slotIso: d.toISOString() };
  }
  if (s.kind === 'interval') {
    const mins = Number(s.every_minutes);
    if (!Number.isFinite(mins) || mins <= 0) return { ok: false, reason: 'interval tidak valid (every_minutes:)', due: false, slotIso: null };
    if (!st.lastFiredAt) return { ok: true, reason: 'baseline dicatat, jalan pertama ' + mins + ' mnt lagi', due: false, slotIso: null, baseline: true };
    const last = new Date(st.lastFiredAt).getTime();
    if (Number.isNaN(last)) return { ok: true, reason: 'baseline dicatat ulang, jalan pertama ' + mins + ' mnt lagi', due: false, slotIso: null, baseline: true };
    if (now.getTime() - last >= mins * 60000) return { ok: true, reason: 'jatuh tempo', due: true, slotIso: now.toISOString() };
    return { ok: true, reason: 'menunggu interval', due: false, slotIso: null };
  }
  if (s.kind === 'daily' || s.kind === 'weekly' || s.kind === 'monthly') {
    const slot = scheduleSlot(s, now);
    if (!slot) return { ok: false, reason: 'waktu tidak valid untuk jenis ' + s.kind, due: false, slotIso: null };
    const slotIso = slot.toISOString();
    if (st.lastSlot === slotIso) return { ok: true, reason: 'slot ini sudah dijalankan', due: false, slotIso };
    if (slot.getTime() > now.getTime()) return { ok: true, reason: 'menunggu jadwal', due: false, slotIso };
    return { ok: true, reason: 'jatuh tempo', due: true, slotIso };
  }
  return { ok: false, reason: 'jenis tidak dikenal: ' + s.kind, due: false, slotIso: null };
}

/** Scheduler executor: enqueue due schedules into the normal quick-task
 *  queue. No new execution path — dispatchLoop does the running, so pause,
 *  delivery, and pushed-honesty all apply unchanged. Exactly-once per slot:
 *  calendar kinds record lastSlot, interval/runonce record lastFiredAt /
 *  firedOnce, and the queue id is deterministic (sched-<id>-<slot>) so a
 *  re-enqueue while paused merges instead of duplicating. Late start fires
 *  ONCE for the current slot only — old slots are never backfilled. */
let checkingSchedules = false;
async function checkSchedules() {
  if (checkingSchedules) return;
  checkingSchedules = true;
  try {
    const { entries } = readScheduleEntries();
    if (!entries.length) return;
    const now = new Date();
    const state = readSchedState();
    const ids = new Set(entries.map((e) => e.id));
    let changed = false;
    for (const k of Object.keys(state)) {
      if (!ids.has(k)) {
        delete state[k];
        changed = true;
      }
    }
    let enqueued = 0;
    for (const s of entries) {
      const cur = state[s.id] && typeof state[s.id] === 'object' ? state[s.id] : {};
      const r = schedStatus(s, cur, now);
      if (r.baseline) {
        state[s.id] = { ...cur, lastFiredAt: now.toISOString() };
        changed = true;
        continue;
      }
      if (!r.due) continue;
      const agent = s.agent || 'mia';
      const prompt = String(s.prompt != null ? s.prompt : s.title).trim();
      const deliver = ['discord', 'none', 'auto'].includes(s.deliver) ? s.deliver : 'auto';
      appendJsonl(QUEUE_FILE, {
        id: 'sched-' + s.id + '-' + r.slotIso,
        ts: now.toISOString(),
        prompt: redact(truncate(prompt, 300)),
        agent,
        deliver,
        status: 'queued',
        task_id: null,
        detail: 'jadwal ' + s.id,
      });
      const next = { ...cur, lastFiredAt: now.toISOString() };
      if (s.kind === 'runonce') next.firedOnce = true;
      else next.lastSlot = r.slotIso;
      state[s.id] = next;
      changed = true;
      enqueued++;
    }
    if (changed) writeJson(SCHED_STATE_FILE, state);
    if (enqueued > 0) dispatchLoop().catch(() => {});
  } catch (err) {
    process.stdout.write('[schedules] check failed: ' + redact(String(err && err.message)) + '\n');
  } finally {
    checkingSchedules = false;
  }
}

function buildSchedules() {
  const { dirs, existing, notes, skipped, entries } = readScheduleEntries();
  const now = new Date();
  const state = readSchedState();
  const out = entries.map((s) => {
    const { label, next_iso } = scheduleLabel(s);
    const cur = state[s.id] && typeof state[s.id] === 'object' ? state[s.id] : {};
    const st = schedStatus(s, cur, now);
    return { ...s, label, next_iso, exec_ok: st.ok, exec_reason: st.reason, last_fired_at: cur.lastFiredAt || null };
  });
  return {
    configured: existing.length > 0,
    dirs,
    existing_dirs: existing,
    notes,
    skipped_files: skipped,
    items: out.sort((a, b) => String(a.owner || '').localeCompare(String(b.owner || ''))),
  };
}

/* ─────────────────────────── logs ─────────────────────────── */

function buildLog(audit, limit = 120) {
  const lines = [];
  for (const e of audit.events.slice(-limit)) {
    lines.push({ ts: e.ts, agent: e.agent, source: 'audit', action: e.action, message: e.detail });
  }
  const { rows } = readJsonl(TASKS_FILE, { limitBytes: 128 * 1024 });
  for (const ev of rows.slice(-limit)) {
    if (!AGENT_IDS.includes(ev.agent)) continue;
    lines.push({ ts: ev.ts, agent: ev.agent, source: 'tasks.jsonl', action: ev.status, message: redact(truncate(`${ev.task_id} ${ev.title || ''} ${ev.detail || ''}`, 300)) });
  }
  lines.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  return lines.slice(0, limit);
}

/* ─────────────────────────── state ─────────────────────────── */

async function buildState() {
  ensureDirs();
  const audit = readAudit();
  mirrorAuditTurns(audit);
  const dispatchState = readJson(DISPATCH_FILE, { paused: false });
  const paused = dispatchState.paused === true;
  const { tasks, broken_lines: taskBroken, ledger_missing: tasksMissing } = buildTasks();
  const { queue, broken_lines: queueBroken, ledger_missing: queueMissing } = buildQueue();
  const tunnel = await tunnelStatus();
  const mem = hostMemory();
  const schedulesState = buildSchedules();
  const watchdog = watchdogStatus();
  const remindersState = buildReminders();
  return {
    now: new Date().toISOString(),
    agents: deriveAgents(audit, paused),
    queue,
    tasks,
    system: systemInfo(),
    vps: {
      disk: diskInfo(),
      cpu: { model: (os.cpus()[0] || {}).model || null, cores: (os.cpus() || []).length || null, loadavg: os.loadavg().map((n) => Number(n.toFixed(2))) },
      memory: { ...mem, container: { available: false, note: 'N/A di host macOS (tidak ada container).' } },
      uptime_s: Math.round(os.uptime()),
      tunnel,
      os: `${os.type()} ${os.release()} (${os.arch()})`,
      watchdog,
    },
    schedules: schedulesState,
    reminders: remindersState,
    dispatch_paused: paused,
    log: buildLog(audit),
    version: { app: 'office-dashboard', started_iso: STARTED_ISO, node: process.version, port: PORT, auth: AUTH_ENABLED ? 'token' : 'open' },
    activity: buildActivity(audit),
    sources: buildSources(
      {
        tasks_ledger_missing: tasksMissing,
        tasks_broken_lines: taskBroken,
        queue_ledger_missing: queueMissing,
        queue_broken_lines: queueBroken,
      },
      schedulesState,
      tunnel,
      watchdog,
      audit,
      remindersState,
    ),
    integrity: {
      tasks_ledger_missing: tasksMissing,
      tasks_broken_lines: taskBroken,
      queue_ledger_missing: queueMissing,
      queue_broken_lines: queueBroken,
      audit_available: audit.available,
      audit_note: audit.note,
      audit_broken_lines: audit.broken,
    },
  };
}

/**
 * Sessions are derived, not stored: an audit file has no turn id, so a session
 * is "one agent's events inside one 15-minute bucket of one audit file". The
 * definition is exported to the UI so nobody reads it as a provider-reported
 * session count.
 */
const SESSION_BUCKET_MS = 15 * 60 * 1000;

function buildActivity(audit, limit = 20) {
  const map = new Map();
  for (const e of audit.events) {
    if (e.at == null) continue;
    const bucket = Math.floor(e.at / SESSION_BUCKET_MS);
    const key = `${e.agent}|${e.file}|${bucket}`;
    let s = map.get(key);
    if (!s) {
      s = { key, agent: e.agent, source: e.file, started: e.ts, last: e.ts, events: 0, tool_calls: 0, turn_errors: 0, last_action: null };
      map.set(key, s);
    }
    s.events += 1;
    if (e.action.indexOf('tool:') === 0) s.tool_calls += 1;
    if (e.action === 'turn_error') s.turn_errors += 1;
    if (e.at >= 0) {
      s.last = e.ts;
      s.last_action = summarizeTool(e.action, e.detail);
    }
    if (!s.started || String(e.ts) < String(s.started)) s.started = e.ts;
  }
  return Array.from(map.values())
    .sort((a, b) => String(b.last).localeCompare(String(a.last)))
    .slice(0, limit);
}

/* ─────────────────────────── reminders (Mia's own store) ─────────────────────────── */
/* Mia keeps scheduled reminders in apps/web/.data/users/<user>/reminders.json —
 * one store per agent persona (owner, owner.agnes, owner.michelle). The dashboard
 * rendered schedules from OFFICE_SCHEDULE_DIRS .md files ONLY, which is a totally
 * different scheduler, so a reminder set from Discord or Telegram never appeared
 * here. Read the real store instead of guessing. */
const REMINDERS_DIR = path.join(MIA_WEB_DIR, '.data', 'users');
const REMINDERS_FILE = 'reminders.json';
const FIRED_RECEIPTS_FILE = 'reminders-fired.json';
const REMINDERS_CAP = 60;

function readRemindersStore(dir, name) {
  const rows = readJson(path.join(dir, name), []);
  return Array.isArray(rows) ? rows : [];
}

function buildReminders() {
  const now = Date.now();
  const items = [];
  const fired = [];
  const stores = [];
  for (const agent of AGENTS) {
    if (!/^[A-Za-z0-9._-]+$/.test(agent.user)) continue;
    const dir = path.join(REMINDERS_DIR, agent.user);
    let exists = false;
    try { exists = fs.existsSync(dir); } catch { exists = false; }
    if (!exists) continue;
    stores.push({ agent: agent.id, name: agent.name, user: agent.user });
    for (const r of readRemindersStore(dir, REMINDERS_FILE)) {
      if (!r || typeof r.text !== 'string' || typeof r.at !== 'number') continue;
      if (r.fired) continue; // Mia prunes fired one-shots herself; nothing to show
      items.push({
        agent: agent.id,
        agent_name: agent.name,
        user: agent.user,
        id: String(r.id || ''),
        text: redact(truncate(r.text, 160)),
        notes: r.notes ? redact(truncate(r.notes, 160)) : null,
        at: r.at,
        at_iso: new Date(r.at).toISOString(),
        in_s: Math.max(0, Math.round((r.at - now) / 1000)),
        repeat: r.repeat === 'daily' ? 'daily' : null,
        variants: Array.isArray(r.variants) ? r.variants.length : 0,
        variant_idx: typeof r.variantIdx === 'number' ? r.variantIdx : null,
      });
    }
    for (const f of readRemindersStore(dir, FIRED_RECEIPTS_FILE)) {
      if (!f || typeof f.at !== 'number') continue;
      const delivered = typeof f.deliveredAt === 'number' ? f.deliveredAt : null;
      fired.push({
        agent: agent.id,
        agent_name: agent.name,
        text: redact(truncate(String(f.text || ''), 160)),
        at: f.at,
        at_iso: new Date(f.at).toISOString(),
        delivered_at: delivered ? new Date(delivered).toISOString() : null,
        late_s: delivered ? Math.round((delivered - f.at) / 1000) : null,
      });
    }
  }
  items.sort((a, b) => a.at - b.at);
  fired.sort((a, b) => (b.delivered_at || b.at_iso).localeCompare(a.delivered_at || a.at_iso));
  const sliced = items.slice(0, REMINDERS_CAP);
  return {
    available: stores.length > 0,
    note: stores.length ? null : 'Store reminders Mia tidak ditemukan di .data/users.',
    now: new Date(now).toISOString(),
    stores,
    pending: items.length,
    truncated: items.length > sliced.length,
    next: sliced[0] || null,
    items: sliced,
    fired: fired.slice(0, 8),
  };
}

function buildSources(integrity, schedules, tunnel, watchdog, audit, reminders) {
  const items = [];
  const push = (id, label, available, note, extra) => items.push({ id, label, available, note: note || null, ...(extra || {}) });
  push('audit', 'Audit log Mia', audit.available, audit.note, { broken_lines: audit.broken, files: audit.files });
  push('reminders', 'Reminder Mia', !!reminders.available, reminders.available ? null : reminders.note, { stores: (reminders.stores || []).map((s) => s.user), pending: reminders.pending });
  push('tasks_ledger', 'data/tasks.jsonl', !integrity.tasks_ledger_missing, integrity.tasks_ledger_missing ? 'Ledger tidak ada / belum pernah ditulis.' : null, { broken_lines: integrity.tasks_broken_lines });
  push('queue_ledger', 'data/queue.jsonl', !integrity.queue_ledger_missing, integrity.queue_ledger_missing ? 'Ledger tidak ada / belum pernah ditulis.' : null, { broken_lines: integrity.queue_broken_lines });
  push('schedules', 'Jadwal (.md)', !!schedules.configured, schedules.configured ? null : 'OFFICE_SCHEDULE_DIRS belum di-set / folder tidak ada.', { dirs: schedules.dirs || [] });
  push('tunnel', 'Tunnel publik', !!tunnel.available, tunnel.available ? null : tunnel.note);
  push('watchdog', 'Watchdog', !!watchdog.available, watchdog.available ? null : watchdog.note);
  return items;
}

/* ─────────────────────── mission-control read-only sources ───────────────────────
 * Everything below serves the dashboard's Files / Memory / Usage tabs. It is
 * READ-ONLY by construction: there is no write path, no delete, and every
 * response body goes through redact() so a credential that happens to sit in
 * a browsable file never reaches the browser.
 * --------------------------------------------------------------------------- */

const STARTED_ISO = new Date().toISOString();

// Roots the Files tab may browse. apps/web/.data is deliberately absent (it is
// also in DENY_SEGMENTS): it holds gmail.json / spotify.json / http-sessions.json /
// policy.json, i.e. live refresh tokens and cookies.
const FILE_ROOTS = [
  { id: 'web', label: 'apps/web', dir: MIA_WEB_DIR },
  { id: 'dashboard', label: 'apps/office-dashboard', dir: ROOT },
];

// Never listed, never readable — noise or secret-bearing.
const DENY_SEGMENTS = new Set([
  '.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.venv', 'venv',
  '__pycache__', '.cache', '.turbo', '.data', 'graphify-out', 'vendor',
]);
const DENY_NAME_RE = /(token|secret|password|passwd|credential|auth)/i;
const DENY_EXT_RE = /\.(pem|key|crt|cer|p12|pfx|jks|keystore|db|sqlite|sqlite3|log|p7b|der)$/i;
const BINARY_EXT_RE = /\.(png|jpe?g|gif|webp|ico|zip|gz|tgz|tar|bz2|xz|7z|mp3|mp4|wav|mov|webm|pdf|woff2?|ttf|otf|eot|so|dylib|dll|exe|node|wasm|bin|lock)$/i;

/** Deny the whole requested path, not just one listing entry: `apps/web/.data`
 *  must be unreachable even though none of its CHILDREN look secret-named. */
function denyPathReason(rel) {
  const parts = String(rel == null ? '' : rel).split(/[\\/]+/).filter(Boolean);
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i] === '..') continue; // traversal is resolveInside()'s job — keep the reason honest
    // the last segment may be a file: check it as a directory too, since a
    // secret-bearing DIRECTORY name must be refused before we ever read it.
    const reason = denyReason(parts[i], true);
    if (reason) return reason;
  }
  return null;
}

function denyReason(name, isDir) {
  const lower = String(name || '').toLowerCase();
  if (!lower) return 'invalid_name';
  if (DENY_SEGMENTS.has(lower)) return isDir ? 'directory_hidden' : 'file_hidden';
  if (lower.startsWith('.env')) return 'secret_file';
  if (lower.startsWith('.')) return 'dotfile';
  if (DENY_NAME_RE.test(lower)) return 'credential_name';
  if (DENY_EXT_RE.test(lower)) return 'secret_or_binary_ext';
  if (!isDir && BINARY_EXT_RE.test(lower)) return 'binary';
  return null;
}

/**
 * Resolve `rel` inside `root` and prove the RESULT is still inside the root.
 * realpath() on both sides means a symlink pointing outside the tree is caught
 * even though every textual component looked harmless.
 */
function resolveInside(root, rel) {
  const raw = String(rel == null ? '' : rel);
  if (raw.indexOf('\0') !== -1) return { error: 'forbidden' };
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  if (parts.some((seg) => seg === '..')) return { error: 'forbidden' };
  let rootReal;
  try {
    rootReal = fs.realpathSync(root);
  } catch {
    return { error: 'not_found' };
  }
  let real;
  try {
    real = fs.realpathSync(path.resolve(rootReal, parts.join(path.sep)));
  } catch {
    return { error: 'not_found' };
  }
  if (real !== rootReal && real.indexOf(rootReal + path.sep) !== 0) return { error: 'forbidden' };
  return { root: rootReal, real, rel: parts.join('/') };
}

function readTextCapped(file, capBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(capBytes);
    const read = fs.readSync(fd, buf, 0, capBytes, 0);
    return { buf: buf.subarray(0, read), read };
  } finally {
    fs.closeSync(fd);
  }
}

const FILE_LIST_CAP = 800;
const FILE_TEXT_CAP = 256 * 1024;

function buildFiles(query) {
  const roots = FILE_ROOTS.map((r) => ({ id: r.id, label: r.label }));
  const rootId = typeof query.root === 'string' && query.root ? query.root : FILE_ROOTS[0].id;
  const spec = FILE_ROOTS.find((r) => r.id === rootId);
  if (!spec) return { error: 'unknown_root', allowed: roots };

  const pathReason = denyPathReason(query.path);
  if (pathReason) return { error: 'forbidden', reason: pathReason, root: rootId, path: String(query.path || '') };

  const target = resolveInside(spec.dir, query.path);
  if (target.error) return { error: target.error, root: rootId, path: String(query.path || '') };

  let st;
  try {
    st = fs.statSync(target.real);
  } catch {
    return { error: 'not_found', root: rootId, path: target.rel };
  }

  if (st.isDirectory()) {
    let names;
    try {
      names = fs.readdirSync(target.real);
    } catch (e) {
      return { error: 'unreadable', root: rootId, path: target.rel, message: redact(String(e.message)) };
    }
    names.sort((a, b) => a.localeCompare(b));
    const entries = [];
    let truncated = false;
    let hidden = 0;
    for (const name of names) {
      if (entries.length >= FILE_LIST_CAP) {
        truncated = true;
        break;
      }
      let type = 'file';
      let size = 0;
      let mtime = null;
      try {
        const lst = fs.lstatSync(path.join(target.real, name));
        mtime = lst.mtime.toISOString();
        if (lst.isSymbolicLink()) {
          const link = resolveInside(spec.dir, target.rel ? `${target.rel}/${name}` : name);
          if (link.error) {
            entries.push({ name, type: 'link', denied: true, reason: link.error });
            continue;
          }
          const lstTarget = fs.statSync(link.real);
          type = lstTarget.isDirectory() ? 'dir' : 'file';
          size = lstTarget.size;
        } else {
          type = lst.isDirectory() ? 'dir' : 'file';
          size = lst.isDirectory() ? 0 : lst.size;
        }
      } catch {
        entries.push({ name, type: 'file', denied: true, reason: 'unreadable' });
        continue;
      }
      const reason = denyReason(name, type === 'dir');
      if (reason) {
        hidden += 1;
        entries.push({ name, type, size, mtime, denied: true, reason });
        continue;
      }
      entries.push({ name, type, size, mtime });
    }
    return { kind: 'dir', root: rootId, roots, path: target.rel, entries, hidden, truncated };
  }

  const base = path.basename(target.real);
  const reason = denyReason(base, false);
  if (reason) return { kind: 'file', root: rootId, roots, path: target.rel, name: base, denied: true, reason };
  if (BINARY_EXT_RE.test(base)) {
    return {
      kind: 'file', root: rootId, roots, path: target.rel, name: base,
      size: st.size, mtime: st.mtime.toISOString(), binary: true,
      note: 'File biner — tidak ditampilkan sebagai teks.',
    };
  }
  const cap = Math.min(st.size, FILE_TEXT_CAP);
  const { buf, read } = readTextCapped(target.real, cap || 1);
  return {
    kind: 'file', root: rootId, roots, path: target.rel, name: base,
    size: st.size, mtime: st.mtime.toISOString(), binary: false,
    truncated: st.size > read, text: redact(buf.toString('utf8')),
  };
}

const USERS_DIR = path.join(MIA_WEB_DIR, '.data', 'users');
const MEMORY_FILE_CAP = 40;
const MEMORY_TEXT_CAP = 64 * 1024;
const MEMORY_DAILY_KEEP = 14;
const MEMORY_TREE_CAP = 12;

/** Real, owner-scoped data dir for one agent (null when absent or unsafe). */
function agentUserDir(agentId) {
  const spec = AGENTS.find((a) => a.id === agentId);
  if (!spec) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(spec.user)) return null;
  let base;
  try {
    base = fs.realpathSync(USERS_DIR);
  } catch {
    return null;
  }
  const dir = path.resolve(base, spec.user);
  if (dir.indexOf(base + path.sep) !== 0) return null;
  try {
    if (!fs.statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  return { dir, rel: path.relative(base, dir) };
}

function walkMarkdown(dir, depth, out, cap) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  names.sort();
  for (const name of names) {
    if (out.length >= cap) return;
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (depth > 0) walkMarkdown(full, depth - 1, out, cap);
      continue;
    }
    if (!name.toLowerCase().endsWith('.md')) continue;
    out.push(full);
  }
}

function buildMemory(query) {
  const agents = AGENTS.map((a) => ({ id: a.id, name: a.name, user: a.user }));
  const agentId = typeof query.agent === 'string' && query.agent ? query.agent : 'mia';
  if (!AGENTS.some((a) => a.id === agentId)) {
    return { available: false, note: 'agent_unknown', allowed: agents, files: [] };
  }
  const base = agentUserDir(agentId);
  if (!base) {
    return {
      available: false, note: `Tidak ada folder data untuk agent ini di ${USERS_DIR}.`, agents, files: [],
    };
  }

  const wanted = [];
  const personaDir = path.join(base.dir, 'persona');
  try {
    for (const name of fs.readdirSync(personaDir).sort()) {
      if (name.toLowerCase().endsWith('.md')) wanted.push(path.join(personaDir, name));
    }
  } catch { /* persona optional */ }

  const memoryDir = path.join(base.dir, 'memory');
  try {
    const daily = fs.readdirSync(memoryDir)
      .filter((n) => n.toLowerCase().endsWith('.md'))
      .sort()
      .reverse()
      .slice(0, MEMORY_DAILY_KEEP);
    for (const name of daily) wanted.push(path.join(memoryDir, name));
  } catch { /* memory optional */ }

  const corrections = path.join(base.dir, 'corrections.md');
  if (fs.existsSync(corrections)) wanted.push(corrections);

  const learning = [];
  walkMarkdown(path.join(base.dir, '.self-improving'), 2, learning, MEMORY_TREE_CAP);
  wanted.push(...learning);

  const files = [];
  for (const full of wanted.slice(0, MEMORY_FILE_CAP)) {
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    let text = '';
    let truncated = false;
    try {
      const cap = Math.min(st.size, MEMORY_TEXT_CAP) || 1;
      const { buf, read } = readTextCapped(full, cap);
      truncated = st.size > read;
      text = redact(buf.toString('utf8'));
    } catch (e) {
      files.push({
        path: path.relative(base.dir, full), size: st.size, mtime: st.mtime.toISOString(),
        truncated: true, text: '', note: `Gagal dibaca: ${redact(String(e.message))}`,
      });
      continue;
    }
    files.push({
      path: path.relative(base.dir, full),
      size: st.size,
      mtime: st.mtime.toISOString(),
      chars: text.length,
      truncated,
      text,
    });
  }

  return {
    available: true,
    note: files.length ? null : 'Folder ada tapi belum ada file memory/persona untuk agent ini.',
    agent: agentId,
    user: AGENTS.find((a) => a.id === agentId).user,
    root: base.rel,
    agents,
    files,
    truncated: wanted.length > MEMORY_FILE_CAP,
  };
}

const USAGE_PERIODS = { '24h': 24 * 3600 * 1000, '7d': 7 * 24 * 3600 * 1000, '30d': 30 * 24 * 3600 * 1000 };

function buildUsage(query) {
  const period = Object.prototype.hasOwnProperty.call(USAGE_PERIODS, String(query.period)) ? String(query.period) : '7d';
  const spanMs = USAGE_PERIODS[period];
  const since = Date.now() - spanMs;
  const hourly = period === '24h';
  const bucketMs = hourly ? 3600 * 1000 : 24 * 3600 * 1000;
  const bucketCount = Math.ceil(spanMs / bucketMs);

  const audit = readAudit();
  const perAgent = {};
  const perAction = {};
  const perSource = {};
  const buckets = [];
  for (let i = 0; i < bucketCount; i += 1) buckets.push({ start: since + i * bucketMs, events: 0, tool_calls: 0, turns: 0, errors: 0 });
  let events = 0;
  let toolCalls = 0;
  let turns = 0;
  let errors = 0;
  let inWindow = 0;

  for (const e of audit.events) {
    if (e.at == null || e.at < since) continue;
    inWindow += 1;
    events += 1;
    perAgent[e.agent] = (perAgent[e.agent] || 0) + 1;
    perSource[e.file] = (perSource[e.file] || 0) + 1;
    const isTool = e.action.indexOf('tool:') === 0;
    const isTurn = e.action === 'turn_provider';
    const isError = e.action === 'turn_error';
    if (isTool) toolCalls += 1;
    if (isTurn) turns += 1;
    if (isError) errors += 1;
    const key = isTool ? e.action.slice(5) : e.action;
    perAction[key] = (perAction[key] || 0) + 1;
    const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((e.at - since) / bucketMs)));
    if (idx >= 0) {
      buckets[idx].events += 1;
      if (isTool) buckets[idx].tool_calls += 1;
      if (isTurn) buckets[idx].turns += 1;
      if (isError) buckets[idx].errors += 1;
    }
  }

  const top = (obj, limit) => Object.keys(obj)
    .map((k) => ({ key: k, count: obj[k] }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit);

  return {
    period,
    window_ms: spanMs,
    bucket: hourly ? 'hour' : 'day',
    available: audit.available,
    note: audit.available ? null : audit.note,
    window_events: inWindow,
    audit_files: audit.files || 0,
    audit_broken_lines: audit.broken || 0,
    totals: { events, turns, tool_calls: toolCalls, turn_errors: errors },
    per_agent: top(perAgent, AGENT_IDS.length),
    per_action: top(perAction, 25),
    per_source: top(perSource, 14),
    timeseries: buckets.map((b) => ({ start: new Date(b.start).toISOString(), ...b })),
    definitions: {
      turns: 'Jumlah event audit action=turn_provider (satu giliran assistant).',
      tool_calls: 'Jumlah event audit action=tool:<nama>.',
      turn_errors: 'Jumlah event audit action=turn_error. Kegagalan tool tidak dilog terpisah oleh sumber audit.',
    },
  };
}

/* ─────────────────────────── http plumbing ─────────────────────────── */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Body terlalu besar'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const resolved = path.resolve(ROOT, rel);
  // path traversal guard: the resolved path must stay inside ROOT
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  const stat = fs.existsSync(resolved) ? fs.statSync(resolved) : null;
  if (!stat || !stat.isFile()) {
    sendJson(res, 404, { error: 'not_found', path: urlPath });
    return;
  }
  const ext = path.extname(resolved);
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8' };
  res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'content-length': stat.size, 'cache-control': 'no-store' });
  fs.createReadStream(resolved).pipe(res);
}

/**
 * Proxy SSE dari Mia Event Bus (`/api/bus/stream`) ke dashboard.
 *
 * Kenapa proxy, bukan EventSource langsung ke port 3000:
 *  1. Route Next tidak mengirim `Access-Control-Allow-Origin`, jadi EventSource
 *     lintas-origin (3001 → 3000) akan diblokir browser. Proxy membuat stream
 *     tetap same-origin.
 *  2. Tidak perlu melemahkan keamanan route Next (CORS wildcard) demi viewer.
 *  3. Kunci user dipinjol dari server (`OWNER_USER`) — klien tidak pernah
 *     menentukan event mana yang boleh dia lihat.
 *
 * Backpressure: `pipe` mengalirkan seluruh isi. Event murni display-only, jadi
 * tidak ada ack yang perlu diteruskan balik.
 */
function proxyBusStream(req, res, url) {
  const target = new URL('/api/bus/stream', MIA_WEB_BASE);
  // Pinjol user key server-side. `since` tetap diteruskan supaya klien bisa
  // mereplay event yang terlewat (cursor = seq terakhir yang diterima).
  target.searchParams.set('user', OWNER_USER);
  const since = url.searchParams.get('since');
  if (since && /^\d+$/.test(since)) target.searchParams.set('since', since);

  let upstream = null;
  let closed = false;
  try {
    upstream = http.get(target, { headers: { accept: 'text/event-stream' } }, (up) => {
      if (closed) {
        up.resume();
        return;
      }
      if (up.statusCode !== 200) {
        // Teruskan status upstream apa adanya (mis. 429 rate-limit) supaya
        // klien bisa membedakan "stream ditolak" dari "Mia tidak hidup".
        const text = `event: error\ndata: {"error":"bus_unavailable","status":${up.statusCode}}\n\n`;
        res.writeHead(up.statusCode, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
        res.end(text);
        up.resume();
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      up.pipe(res);
      /* Upstream hanya mengirim komentar `: keepalive`, yang dibuang oleh
         EventSource. Akibatnya socket yang sudah mati tetap ber-readyState OPEN
         dan tidak pernah memicu onerror, sehingga dashboard akan tetap
         mengklaim bus "terhubung" padahal isinya sudah tak terlihat. Kita
         kirim keepalive milik sendiri yang bisa diamati klien, supaya
         konektivitas dibuktikan, bukan diasumsikan. */
      const beat = setInterval(() => {
        if (closed || res.writableEnded) return;
        res.write(`event: keepalive\ndata: ${Date.now()}\n\n`);
      }, 15000);
      const stopBeat = () => clearInterval(beat);
      res.on('close', stopBeat);
      res.on('error', stopBeat);
    });
    upstream.on('error', (err) => {
      if (closed) return;
      closed = true;
      if (!res.headersSent) {
        sendJson(res, 502, { error: 'bus_unreachable', detail: redact(String(err && err.message)), hint: `is Mia running on ${MIA_WEB_BASE}?` });
      } else {
        res.end(`event: error\ndata: {"error":"bus_stream_broken"}\n\n`);
      }
    });
    // Klien menutup EventSource / tab ditutup → stop biayanya upstream juga.
    // Tanpa ini Mia akan tetap menahan satu koneksi terbuka per tab.
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 502, { error: 'bus_unreachable', detail: redact(String(err && err.message)) });
    }
  }
  const abort = () => {
    if (closed) return;
    closed = true;
    if (upstream) upstream.destroy();
    try {
      res.end();
    } catch {
      /* already closed */
    }
  };
  req.on('close', abort);
  res.on('error', abort);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;
  try {
    if (p === '/api/health') {
      sendJson(res, 200, { ok: true, auth: AUTH_ENABLED ? 'enabled' : 'open (set AUTH_TOKEN in apps/web/.env.local or DASHBOARD_TOKEN)', uptime_s: Math.round(process.uptime()) });
      return;
    }
    if (p.startsWith('/api/') && !isAuthorized(req)) {
      sendJson(res, 401, { error: 'unauthorized', hint: 'Set cookie mia_auth=<AUTH_TOKEN> or send Authorization: Bearer <AUTH_TOKEN>' });
      return;
    }
    if (p === '/api/bus/stream' && req.method === 'GET') {
      proxyBusStream(req, res, url);
      return;
    }
    if (p === '/api/state' && req.method === 'GET') {
      sendJson(res, 200, await buildState());
      return;
    }
    if (p === '/api/files' && req.method === 'GET') {
      const out = buildFiles(Object.fromEntries(url.searchParams.entries()));
      if (out.error === 'unknown_root' || out.error === 'forbidden' || out.error === 'not_found') {
        sendJson(res, out.error === 'unknown_root' ? 400 : 403, out);
        return;
      }
      sendJson(res, 200, out);
      return;
    }
    if (p === '/api/memory' && req.method === 'GET') {
      sendJson(res, 200, buildMemory(Object.fromEntries(url.searchParams.entries())));
      return;
    }
    if (p === '/api/usage' && req.method === 'GET') {
      sendJson(res, 200, buildUsage(Object.fromEntries(url.searchParams.entries())));
      return;
    }
    if (p === '/api/queue' && req.method === 'POST') {
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch (e) {
        sendJson(res, e.statusCode || 400, { error: e.statusCode === 413 ? 'payload_too_large' : 'invalid_json' });
        return;
      }
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      const agent = typeof body.agent === 'string' ? body.agent.trim() : '';
      const deliver = body.deliver === 'discord' ? 'discord' : body.deliver === 'none' ? 'none' : 'auto';
      if (!prompt) return sendJson(res, 400, { error: 'prompt_required', message: 'prompt harus string non-kosong.' });
      if (prompt.length > MAX_PROMPT_CHARS) return sendJson(res, 400, { error: 'prompt_too_long', max: MAX_PROMPT_CHARS });
      if (!AGENT_IDS.includes(agent)) return sendJson(res, 400, { error: 'unknown_agent', allowed: AGENT_IDS });
      const item = { id: newId('q'), ts: new Date().toISOString(), prompt: redact(truncate(prompt, 300)), agent, deliver, status: 'queued', task_id: null };
      appendJsonl(QUEUE_FILE, item);
      dispatchLoop();
      sendJson(res, 201, { ok: true, item });
      return;
    }
    if (p === '/api/dispatch' && req.method === 'POST') {
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch (e) {
        sendJson(res, e.statusCode || 400, { error: e.statusCode === 413 ? 'payload_too_large' : 'invalid_json' });
        return;
      }
      if (typeof body.paused !== 'boolean') return sendJson(res, 400, { error: 'paused_must_be_boolean' });
      writeJson(DISPATCH_FILE, { paused: body.paused });
      sendJson(res, 200, { ok: true, dispatch_paused: body.paused });
      return;
    }
    if (p.startsWith('/api/')) {
      sendJson(res, 404, { error: 'unknown_api_route', path: p });
      return;
    }
    if (req.method === 'GET') {
      serveStatic(req, res, p);
      return;
    }
    sendJson(res, 405, { error: 'method_not_allowed' });
  } catch (err) {
    sendJson(res, err && err.statusCode ? err.statusCode : 500, { error: 'internal_error', message: redact(String(err && err.message)) });
  }
});

ensureDirs();
server.listen(PORT, HOST, () => {
  process.stdout.write(`[office-dashboard] http://${HOST}:${PORT} (auth ${AUTH_ENABLED ? 'enabled' : 'DISABLED — local only'})\n`);
});

setInterval(() => { dispatchLoop().catch(() => {}); }, 3000).unref();
// Scheduler executor: due .md schedules enqueue into the normal queue above
// (30s cadence is plenty for minute-level schedules; overlap-guarded inside).
setInterval(() => { checkSchedules().catch(() => {}); }, 30000).unref();