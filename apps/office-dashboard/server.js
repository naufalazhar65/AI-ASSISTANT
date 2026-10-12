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

/** Same contract as authGuard.isAuthorized: cookie OR bearer. */
function isAuthorized(req) {
  if (!AUTH_ENABLED) return true;
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

function buildSchedules() {
  const { dirs, existing, notes } = scheduleDirs();
  const out = [];
  let skipped = 0;
  for (const dir of existing) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
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
      const s = {
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
        // is_system only when ownership is provable from metadata (owner:system* / goal:system*)
        is_system: typeof fm.owner === 'string' && /^system/i.test(fm.owner),
        file: path.relative(ROOT, full),
      };
      const { label, next_iso } = scheduleLabel(s);
      out.push({ ...s, label, next_iso });
    }
  }
  return {
    configured: existing.length > 0,
    dirs,
    existing_dirs: existing,
    notes,
    skipped_files: skipped,
    items: out.sort((a, b) => String(a.owner || '').localeCompare(String(b.owner || ''))),
  };
}

/* ─────────────────────────── token status ─────────────────────────── */

async function tokenStatus() {
  const url = process.env.OFFICE_TOKEN_STATUS_URL;
  if (!url) {
    return {
      available: false,
      label: 'Not configured',
      note: 'OFFICE_TOKEN_STATUS_URL belum di-set. Dashboard tidak pernah mengambil API key/secret untuk mengambil statistik.',
      items: [],
    };
  }
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 6000);
    const res = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    if (!res.ok) return { available: false, label: 'Unavailable', note: `Sumber token status menjawab HTTP ${res.status}`, items: [] };
    const body = await res.json();
    return { available: true, label: 'Live', source: url, items: Array.isArray(body.items) ? body.items : [body] };
  } catch (err) {
    return { available: false, label: 'Unavailable', note: redact(err.message), items: [] };
  }
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
      watchdog: watchdogStatus(),
    },
    schedules: buildSchedules(),
    tokens: await tokenStatus(),
    dispatch_paused: paused,
    log: buildLog(audit),
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