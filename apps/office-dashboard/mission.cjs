'use strict';
/**
 * Mission Control — pure domain logic for the AI Office task centre.
 *
 * One task = one stable identity. One execution = one attempt.
 *
 * Nothing here touches the network or the disk: every source (the dispatch
 * ledger, the orchestrator's plans, the workflow store) is handed in already
 * read, so the same functions can be unit-tested and reused by the server.
 *
 * Three rules that must not bend:
 *  - a conversation turn is NOT a task (audit-mirror rows are excluded);
 *  - progress is only ever the stages an engine actually reported;
 *  - an action is only offered when the backend can really perform it.
 */

const AGENT_IDS = ['mia', 'agnes', 'michelle'];
const AGENT_LABEL = { mia: 'Mia', agnes: 'Agnes', michelle: 'Michelle' };

/* The lifecycle the dashboard shows. `tone` maps onto the existing badge
   classes; every label is a human sentence, never a raw enum. */
const STATUS_META = {
  queued: { label: 'Antre', tone: 'idle' },
  running: { label: 'Berjalan', tone: 'working' },
  waiting_approval: { label: 'Menunggu Persetujuan', tone: 'warn' },
  completed: { label: 'Selesai', tone: 'done' },
  partial: { label: 'Selesai Sebagian', tone: 'warn' },
  failed: { label: 'Gagal', tone: 'failed' },
  cancelled: { label: 'Dibatalkan', tone: 'paused' },
  blocked: { label: 'Terblokir', tone: 'failed' },
  skipped: { label: 'Dilewati', tone: 'idle' },
  stale: { label: 'Berhenti', tone: 'idle' },
  idle: { label: 'Belum Ada Eksekusi', tone: 'idle' },
};

/* An agent's status is not a task's status: an idle agent is READY, not
   "without an execution". */
const AGENT_STATUS_META = {
  idle: { label: 'Siap', tone: 'idle' },
  working: { label: 'Bekerja', tone: 'working' },
  paused: { label: 'Jeda', tone: 'paused' },
};

const PERIODS = {
  all: { label: 'Semua waktu', ms: 0 },
  '24h': { label: '24 jam', ms: 24 * 60 * 60 * 1000 },
  '7d': { label: '7 hari', ms: 7 * 24 * 60 * 60 * 1000 },
};

const SORTS = {
  smart: 'Aktif dulu',
  newest: 'Terbaru',
  oldest: 'Terlama',
  updated: 'Terakhir diubah',
  duration: 'Durasi terlama',
  priority: 'Prioritas',
};

/* The headline numbers. Every entry states WHAT it counts — the period is
   shown next to them, never hidden in a tooltip nobody opens. */
const COUNTER_META = [
  { key: 'total', label: 'Total Task', hint: 'Seluruh task pada periode ini' },
  { key: 'running', label: 'Berjalan', hint: 'Sedang eksekusi sekarang' },
  { key: 'queued', label: 'Antre', hint: 'Menunggu eksekusi' },
  { key: 'waiting_approval', label: 'Menunggu Persetujuan', hint: 'Menunggu keputusan owner' },
  { key: 'completed', label: 'Selesai', hint: 'Berhasil diselesaikan' },
  { key: 'failed', label: 'Gagal', hint: 'Eksekusi gagal' },
  { key: 'partial', label: 'Selesai Sebagian', hint: 'Selesai sebagian' },
  { key: 'cancelled', label: 'Dibatalkan', hint: 'Dibatalkan' },
  { key: 'blocked', label: 'Terblokir', hint: 'Terblokir, bukan gagal' },
  { key: 'stale', label: 'Berhenti', hint: 'Eksekusi tidak pernah selesai' },
  { key: 'skipped', label: 'Dilewati', hint: 'Dilewati, bukan gagal' },
  { key: 'idle', label: 'Belum Ada Eksekusi', hint: 'Belum punya eksekusi' },
];

/* ------------------------------------------------------------------ utils */

function toMs(v) {
  if (v == null) return NaN;
  if (typeof v === 'number') return v;
  var t = Date.parse(String(v));
  return isFinite(t) ? t : NaN;
}

function ageOf(ts, now) {
  var t = toMs(ts);
  return isFinite(t) ? Math.max(0, now - t) : Infinity;
}

function durationBetween(from, to) {
  var a = toMs(from);
  var b = toMs(to);
  if (!isFinite(a) || !isFinite(b) || b < a) return null;
  return b - a;
}

function text(v) {
  return v == null ? '' : String(v);
}

function push(map, key, value) {
  if (!map[key]) map[key] = [];
  map[key].push(value);
}

/* ---------------------------------------------------------- status mapping */

function statusMeta(status) {
  return STATUS_META[status] || { label: text(status) || '—', tone: 'idle' };
}

/** Dispatch ledger rows only know started | done | failed. A 'started' row
 *  that has not moved inside the live window is NOT running — it stopped. */
function mapDispatchRawStatus(raw, ageMs, liveWindowMs) {
  if (raw === 'done' || raw === 'completed') return 'completed';
  if (raw === 'failed') return 'failed';
  if (raw === 'cancelled') return 'cancelled';
  if (raw === 'queued') return 'queued';
  if (raw === 'started' || raw === 'progress' || raw === 'running') {
    return ageMs <= liveWindowMs ? 'running' : 'stale';
  }
  return 'idle';
}

/** Orchestrator task states (apps/web/src/lib/orchestration.ts). */
function mapOrchStatus(state) {
  switch (String(state || '').toUpperCase()) {
    case 'PLANNED':
    case 'READY':
    case 'QUEUED':
      return 'queued';
    case 'RUNNING':
      return 'running';
    case 'AWAITING_APPROVAL':
      return 'waiting_approval';
    case 'SUCCEEDED':
      return 'completed';
    case 'PARTIALLY_COMPLETED':
      return 'partial';
    case 'FAILED':
      return 'failed';
    case 'BLOCKED':
      return 'blocked';
    case 'CANCELLED':
      return 'cancelled';
    default:
      return 'idle';
  }
}

/** Workflow execution states (apps/web/src/lib/workflow/types.ts). */
function mapWorkflowStatus(state) {
  switch (String(state || '').toUpperCase()) {
    case 'QUEUED':
      return 'queued';
    case 'RUNNING':
    case 'APPROVED':
      return 'running';
    case 'AWAITING_APPROVAL':
      return 'waiting_approval';
    case 'SUCCEEDED':
      return 'completed';
    case 'PARTIALLY_COMPLETED':
      return 'partial';
    case 'FAILED':
      return 'failed';
    case 'BLOCKED':
      return 'blocked';
    case 'CANCELLED':
      return 'cancelled';
    case 'SKIPPED':
      return 'skipped';
    default:
      return 'idle';
  }
}

/* ------------------------------------------------------------- task shape */

function baseTask() {
  return {
    task_id: null,
    title: '',
    description: '',
    created_by: null,
    owner_agent: null,
    current_assignee: null,
    supporting_agents: [],
    status: 'idle',
    priority: null,
    progress: null,
    stages: [],
    created_at: null,
    started_at: null,
    updated_at: null,
    completed_at: null,
    execution_id: null,
    parent_task_id: null,
    related_task_ids: [],
    events: [],
    results: [],
    artifacts: [],
    related_conversation_id: null,
    error: null,
    source: null,
    executions: [],
    duration_ms: null,
    handoffs: [],
  };
}

function executionId(taskId, attempt) {
  return text(taskId) + '::' + text(attempt || 1);
}

/* --------------------------------------------------- dispatch (the ledger) */

/** Group a task's history rows into executions. Rows written before this
 *  feature existed carry no execution id — they all belong to attempt 1. */
function executionsFromHistory(history, opts) {
  var o = opts || {};
  var now = o.now || Date.now();
  var live = o.liveWindowMs || 120000;
  var map = Object.create(null);
  var order = [];
  (history || []).forEach(function (h) {
    if (!h) return;
    var key = h.execution_id || 'exec-1';
    if (!map[key]) {
      map[key] = {
        execution_id: key,
        attempt: h.attempt || 1,
        status: null,
        started_at: h.ts || null,
        finished_at: null,
        duration_ms: null,
        detail: '',
        rows: 0,
      };
      order.push(key);
    }
    var e = map[key];
    e.rows += 1;
    if (h.attempt) e.attempt = h.attempt;
    if (h.status) e.status = h.status;
    if (h.detail) e.detail = h.detail;
    if (h.ts) {
      if (!e.started_at || h.ts < e.started_at) e.started_at = h.ts;
      e.finished_at = h.ts;
    }
  });
  return order.map(function (k) {
    var e = map[k];
    e.status = mapDispatchRawStatus(e.status, ageOf(e.finished_at || e.started_at, now), live);
    e.duration_ms = durationBetween(e.started_at, e.finished_at);
    delete e.rows;
    return e;
  });
}

function dispatchActivity(status) {
  if (status === 'started') return 'Mulai eksekusi';
  if (status === 'done' || status === 'completed') return 'Selesai';
  if (status === 'failed') return 'Gagal';
  if (status === 'cancelled') return 'Dibatalkan';
  if (status === 'queued') return 'Masuk antrean';
  return 'Diperbarui';
}

/**
 * Tasks the owner dispatched from the dashboard (or a chat) — the real,
 * requested work. Audit-mirror rows are a conversation turn, not a task, so
 * they never enter Mission Control.
 */
function dispatchTasks(ledger, queue, opts) {
  var o = opts || {};
  var now = o.now || Date.now();
  var live = o.liveWindowMs || 120000;
  var out = [];
  var byId = Object.create(null);

  /* The queue ledger also holds the prompt of every task, so a task
     dispatched before the ledger kept prompts can still be re-run. */
  var queuePrompt = Object.create(null);
  var queueFirstTs = Object.create(null);
  (queue || []).forEach(function (q) {
    if (!q || !q.id) return;
    var qid = q.task_id || 'task-' + q.id;
    var p = q.prompt_full || q.prompt;
    if (p && !queuePrompt[qid]) queuePrompt[qid] = p; // queue is newest-first
    var ts = q.ts || null;
    if (ts && (!queueFirstTs[qid] || ts < queueFirstTs[qid])) queueFirstTs[qid] = ts;
  });

  (ledger || []).forEach(function (t) {
    if (!t || !t.task_id) return;
    if (t.source && t.source !== 'dashboard') return;

    var history = t.history || [];
    var last = history.length ? history[history.length - 1] : null;
    var task = baseTask();
    task.task_id = t.task_id;
    task.source = 'dispatch';
    task.title = text(t.title) || '(tanpa judul)';
    task.description = text(t.detail);
    task.owner_agent = t.agent || null;
    task.current_assignee = t.agent || null;
    task.created_by = 'owner';
    task.created_at = t.started_at || t.updated_at || null;
    task.started_at = t.started_at || null;
    task.updated_at = t.updated_at || t.started_at || null;
    task.execution_id = t.execution_id || null;
    task.prompt = t.prompt || queuePrompt[t.task_id] || null;
    task.delivery = t.deliver
      ? { deliver: t.deliver, deliver_to: t.deliver_to || null, delivered: t.delivered === true }
      : null;
    task.status = mapDispatchRawStatus(t.status, ageOf(task.updated_at, now), live);
    task.events = history.map(function (h) {
      return {
        ts: h.ts || null,
        actor: t.agent || null,
        activity: dispatchActivity(h.status),
        status: h.status || null,
        detail: text(h.detail),
        execution_id: h.execution_id || null,
        attempt: h.attempt || 1,
      };
    });
    task.executions = executionsFromHistory(history, { now: now, liveWindowMs: live });
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
      task.completed_at = (last && last.ts) || task.updated_at;
    }
    task.error = task.status === 'failed' ? text((last && last.detail) || t.detail) || null : null;
    task.results =
      task.status === 'completed' && t.detail ? [{ kind: 'text', text: text(t.detail) }] : [];
    task.duration_ms = taskDuration(task, now);

    byId[t.task_id] = task;
    out.push(task);
  });

  /* The queue row and the dispatched task share ONE identity: the task id is
     stamped when the item is queued, so "Antre" and "Berjalan" are one row. */
  (queue || []).forEach(function (q) {
    if (!q || !q.id) return;
    var taskId = q.task_id || 'task-' + q.id;
    var task = byId[taskId];
    if (!task) {
      /* A row that was never dispatched has no ledger entry yet: it is either
         still waiting, or it was cancelled from Mission Control. Both are real
         tasks and must stay visible — only a dispatched ('done') row belongs
         to the ledger. */
      if (q.status !== 'queued' && q.status !== 'cancelled') return;
      task = baseTask();
      task.task_id = taskId;
      task.source = 'dispatch';
      task.title = text(q.prompt) || '(tanpa judul)';
      task.description = '';
      task.owner_agent = q.agent || null;
      task.current_assignee = q.agent || null;
      task.created_by = 'owner';
      task.created_at = queueFirstTs[taskId] || q.ts || null;
      task.updated_at = q.updated_at || q.ts || null;
      task.prompt = q.prompt_full || q.prompt || null;
      task.status = q.status === 'cancelled' ? 'cancelled' : 'queued';
      if (q.status === 'cancelled') task.completed_at = q.updated_at || q.ts || null;
      task.events = [
        {
          ts: q.updated_at || q.ts || null,
          actor: q.agent || null,
          activity: q.status === 'cancelled' ? 'Dibatalkan sebelum eksekusi' : 'Masuk antrean',
          status: q.status,
          detail: '',
        },
      ];
      task.executions = [
        {
          execution_id: executionId(taskId, q.attempt),
          attempt: q.attempt || 1,
          status: task.status,
          started_at: q.ts || null,
          finished_at: q.status === 'cancelled' ? q.updated_at || q.ts || null : null,
          duration_ms: null,
          detail: '',
        },
      ];
      byId[taskId] = task;
      out.push(task);
      return;
    }
    if (q.status === 'cancelled') {
      /* A cancelled attempt never reached the ledger, but it IS part of the
         task's history — otherwise a retry would look like the first try. */
      var cancelledExec = executionId(taskId, q.attempt);
      var known = (task.executions || []).some(function (e) { return e.execution_id === cancelledExec; });
      if (!known) {
        task.executions.push({
          execution_id: cancelledExec,
          attempt: q.attempt || 1,
          status: 'cancelled',
          started_at: q.ts || null,
          finished_at: q.updated_at || q.ts || null,
          duration_ms: null,
          detail: '',
        });
        task.events.push({
          ts: q.updated_at || q.ts || null,
          actor: q.agent || null,
          activity: 'Dibatalkan sebelum eksekusi',
          status: 'cancelled',
          detail: '',
          execution_id: cancelledExec,
          attempt: q.attempt || 1,
        });
      }
      return;
    }
    if (q.status !== 'queued') return;
    /* A retry waiting for dispatch: earlier attempts stay in the history. */
    var queuedAttempt = q.attempt || task.executions.length + 1;
    var queuedExec = executionId(taskId, queuedAttempt);
    task.status = 'queued';
    task.updated_at = q.updated_at || q.ts || task.updated_at;
    task.execution_id = queuedExec;
    task.events.push({
      ts: q.updated_at || q.ts || null,
      actor: q.agent || null,
      activity: 'Menunggu eksekusi (percobaan ulang)',
      status: 'queued',
      detail: '',
      execution_id: queuedExec,
      attempt: queuedAttempt,
    });
    task.executions.push({
      execution_id: queuedExec,
      attempt: queuedAttempt,
      status: 'queued',
      started_at: q.ts || null,
      finished_at: null,
      duration_ms: null,
      detail: '',
    });
  });

  return out;
}

/* ------------------------------------------------- orchestration (plans) */

function orchestrationTasks(plans, sessions, opts) {
  var o = opts || {};
  var now = o.now || Date.now();
  var out = [];
  var sessionById = Object.create(null);
  (sessions || []).forEach(function (s) {
    if (s && s.id) sessionById[s.id] = s;
  });

  (plans || []).forEach(function (plan) {
    if (!plan || !plan.id) return;
    var planTasks = Array.isArray(plan.tasks) ? plan.tasks : [];
    var stages = planTasks.map(function (t) {
      return {
        id: text(t.task_id),
        label: text(t.objective),
        status: mapOrchStatus(t.status),
        agent_id: t.agent_id || null,
      };
    });
    var doneCount = stages.filter(function (s) {
      return s.status === 'completed';
    }).length;

    planTasks.forEach(function (t) {
      var task = baseTask();
      task.task_id = 'orch:' + plan.id + ':' + text(t.task_id);
      task.source = 'orchestration';
      task.title = text(t.objective) || '(tanpa judul)';
      task.description = text(t.expected_output);
      task.created_by = 'owner';
      task.user = plan.user || null;
      task.owner_agent = 'mia';
      task.current_assignee = t.agent_id || null;
      task.supporting_agents = planTasks
        .map(function (x) { return x.agent_id; })
        .filter(function (a, i, arr) { return a && arr.indexOf(a) === i && a !== t.agent_id; });
      task.status = mapOrchStatus(t.status);
      task.priority = typeof t.priority === 'number' ? t.priority : null;
      task.created_at = t.created_at || plan.created_at || null;
      task.started_at = t.started_at || null;
      task.updated_at = t.completed_at || t.started_at || t.created_at || plan.created_at || null;
      task.completed_at = t.completed_at || null;
      task.execution_id = t.ps_session_id || null;
      task.parent_task_id = t.parent_task_id ? 'orch:' + plan.id + ':' + text(t.parent_task_id) : null;
      task.related_task_ids = planTasks
        .filter(function (x) { return x.task_id !== t.task_id; })
        .map(function (x) { return 'orch:' + plan.id + ':' + text(x.task_id); });
      task.stages = stages;
      /* Real progress = the plan's own task graph, as reported by the engine. */
      task.progress = stages.length
        ? { done: doneCount, total: stages.length, label: doneCount + ' dari ' + stages.length + ' tahap' }
        : null;
      task.error = text(t.error_summary) || null;
      task.results = [];
      if (t.result_reference) task.results.push({ kind: 'reference', text: text(t.result_reference) });
      (t.evidence_references || []).forEach(function (r) {
        task.results.push({ kind: 'evidence', text: text(r) });
      });
      task.criteria_outcome = t.criteria_outcome || null;
      task.related_conversation_id = null;

      var session = sessionById['ps_' + plan.id + '_' + text(t.task_id)];
      if (session) {
        task.executions = (session.attempts || []).map(function (a) {
          return {
            execution_id: 'ps:' + plan.id + ':' + text(t.task_id) + '#' + text(a.n),
            attempt: a.n,
            status: a.failure ? 'failed' : a.recovery ? 'running' : 'running',
            started_at: a.at || null,
            finished_at: a.at || null,
            duration_ms: typeof a.duration_ms === 'number' ? a.duration_ms : null,
            detail: text(a.error) || text(a.recovery_reason) || '',
            phase: a.phase || null,
            recovery: a.recovery || null,
          };
        });
        (session.attempts || []).forEach(function (a) {
          task.events.push({
            ts: a.at || null,
            actor: t.agent_id || null,
            activity: a.phase ? 'Tahap ' + text(a.phase).toLowerCase() : 'Percobaan',
            status: a.failure ? 'failed' : 'running',
            detail: text(a.error) || text(a.action) || '',
            execution_id: 'ps:' + plan.id + ':' + text(t.task_id) + '#' + text(a.n),
          });
          if (a.recovery === 'delegate') {
            task.handoffs.push({
              at: a.at || null,
              from: t.agent_id || null,
              to: null,
              reason: text(a.recovery_reason),
            });
          }
        });
        task.criteria_outcome = task.criteria_outcome || session.criteria_outcome || null;
      }

      task.duration_ms = durationBetween(task.started_at, task.completed_at || task.updated_at);
      out.push(task);
    });
  });

  return out;
}

/* ------------------------------------------------------ workflow (scheduled) */

function workflowTasks(workflows, executions, opts) {
  var o = opts || {};
  var now = o.now || Date.now();
  var out = [];
  var byWorkflow = Object.create(null);
  (executions || []).forEach(function (e) {
    if (!e || !e.workflow_id) return;
    push(byWorkflow, e.workflow_id, e);
  });

  (workflows || []).forEach(function (wf) {
    if (!wf || !wf.workflow_id) return;
    var runs = (byWorkflow[wf.workflow_id] || []).slice().sort(function (a, b) {
      return toMs(b.started_at || b.scheduled_for || 0) - toMs(a.started_at || a.scheduled_for || 0);
    });
    var latest = runs[0] || null;
    var task = baseTask();
    task.task_id = 'wf:' + text(wf.workflow_id);
    task.source = 'workflow';
    task.title = text(wf.name) || text(wf.workflow_id);
    task.description = text(wf.schedule);
    task.created_by = text(wf.created_by) || 'owner';
    task.user = wf.user || null;
    task.owner_agent = wf.agent_id || null;
    task.current_assignee = wf.agent_id || null;
    task.status = latest ? mapWorkflowStatus(latest.status) : 'idle';
    task.created_at = wf.created_at || (runs.length ? runs[runs.length - 1].started_at : null);
    task.started_at = latest ? latest.started_at || latest.scheduled_for || null : null;
    task.updated_at = latest
      ? latest.finished_at || latest.started_at || wf.updated_at || null
      : wf.updated_at || null;
    task.completed_at = latest && latest.finished_at ? latest.finished_at : null;
    task.execution_id = latest ? text(latest.execution_id) || null : null;
    task.priority = null;
    /* The workflow engine reports no stages — say so instead of inventing one. */
    task.progress = null;
    task.workflow_paused = wf.paused === true;
    task.workflow_enabled = wf.enabled !== false;
    task.next_run_at = wf.next_run_at || null;
    /* Oldest first: the duration reads the LAST execution, so a newest-first
       list would report the oldest run's duration (owner decision: the
       duration is the last attempt). */
    task.executions = runs.slice().reverse().map(function (e, i) {
      return {
        execution_id: text(e.execution_id),
        attempt: i + 1,
        status: mapWorkflowStatus(e.status),
        started_at: e.started_at || e.scheduled_for || null,
        finished_at: e.finished_at || null,
        duration_ms: typeof e.duration_ms === 'number' ? e.duration_ms : null,
        detail: text(e.error_summary),
      };
    });
    task.events = runs
      .slice()
      .reverse()
      .map(function (e) {
        return {
          ts: e.started_at || e.scheduled_for || null,
          actor: wf.agent_id || null,
          activity: 'Eksekusi ' + mapWorkflowStatus(e.status).toLowerCase(),
          status: e.status || null,
          detail: text(e.error_summary),
          execution_id: text(e.execution_id),
        };
      });
    if (latest) {
      if (latest.result_text) task.results.push({ kind: 'text', text: text(latest.result_text) });
      (latest.artifacts || []).forEach(function (a) {
        task.artifacts.push(typeof a === 'string' ? { kind: 'artifact', text: a } : a);
      });
      task.error = text(latest.error_summary) || null;
    }
    task.duration_ms = durationBetween(task.started_at, task.completed_at || task.updated_at);
    out.push(task);
  });

  return out;
}

/* ------------------------------------------------------------- assembling */

function countStatuses(tasks) {
  var counters = {
    total: 0,
    running: 0,
    queued: 0,
    waiting_approval: 0,
    completed: 0,
    partial: 0,
    failed: 0,
    cancelled: 0,
    blocked: 0,
    skipped: 0,
    stale: 0,
    idle: 0,
  };
  (tasks || []).forEach(function (t) {
    counters.total += 1;
    if (counters[t.status] !== undefined) counters[t.status] += 1;
  });
  return counters;
}

/** Per-agent roll-up. "Active" means work in flight (running or waiting for a
 *  decision) — an idle agent is still available, never counted as offline. */
function agentSummary(tasks, liveAgents) {
  var byId = Object.create(null);
  (liveAgents || []).forEach(function (a) {
    if (a && a.id) byId[a.id] = a;
  });
  return AGENT_IDS.map(function (id) {
    var live = byId[id] || {};
    /* One task, one agent: the assignee wins, otherwise the owner. Counting
       both would count an orchestration task twice (the roll-up would not
       add up to the counter above it). */
    var mine = (tasks || []).filter(function (t) {
      return (t.current_assignee || t.owner_agent) === id;
    });
    var st = AGENT_STATUS_META[live.status] || { label: String(live.status || 'tak diketahui'), tone: 'idle' };
    return {
      id: id,
      name: (live.name || AGENT_LABEL[id] || id),
      role: live.role || null,
      status: live.status || 'idle',
      status_label: st.label,
      status_tone: st.tone,
      active_task: live.active_task || null,
      total: mine.length,
      active: mine.filter(function (t) {
        return t.status === 'running' || t.status === 'waiting_approval';
      }).length,
      completed: mine.filter(function (t) { return t.status === 'completed'; }).length,
      failed: mine.filter(function (t) { return t.status === 'failed'; }).length,
    };
  });
}

/**
 * Actions the backend can really perform for this task. Nothing else is
 * offered — a button without an implementation is a lie.
 */
function actionsFor(task) {
  var out = [];
  if (!task) return out;
  if (task.source === 'dispatch') {
    /* A stale row ("Berhenti") is a dispatch that never closed — the backend
       can re-run it, so the button belongs there too. */
    if (
      (task.status === 'failed' || task.status === 'cancelled' || task.status === 'stale') &&
      task.prompt
    ) {
      out.push({ id: 'retry', label: 'Jalankan ulang', kind: 'retry', confirm: 'Eksekusi baru akan dimulai. Riwayat percobaan sebelumnya tetap tersimpan.' });
    }
    if (task.status === 'queued') {
      out.push({ id: 'cancel', label: 'Batalkan', kind: 'cancel', confirm: 'Task ini belum dikirim ke agent. Batalkan antrean?' });
    }
    return out;
  }
  if (task.source === 'workflow') {
    var running = task.status === 'running' || (task.executions || []).some(function (e) { return e.status === 'running'; });
    var canRun = task.workflow_enabled !== false && task.workflow_paused !== true && !running;
    if (canRun) {
      out.push({ id: 'retry', label: 'Jalankan sekarang', kind: 'retry', confirm: 'Eksekusi baru akan dibuat. Riwayat eksekusi sebelumnya tetap tersimpan.' });
    }
    if (task.workflow_paused) {
      out.push({ id: 'resume', label: 'Lanjutkan jadwal', kind: 'resume', confirm: 'Jadwal akan diaktifkan lagi.' });
    }
    if (running) {
      out.push({ id: 'cancel', label: 'Batalkan eksekusi', kind: 'cancel', confirm: 'Eksekusi yang sedang berjalan akan ditandai dibatalkan.' });
    }
    return out;
  }
  if (task.source === 'orchestration') {
    if (
      task.status === 'running' ||
      task.status === 'queued' ||
      task.status === 'waiting_approval' ||
      task.status === 'blocked'
    ) {
      out.push({
        id: 'cancel_plan',
        label: 'Batalkan rencana',
        kind: 'cancel_plan',
        confirm: 'Seluruh tahap rencana yang belum selesai akan dibatalkan.',
      });
    }
    return out;
  }
  return out;
}

/**
 * How long the work really took. The LAST attempt decides: a task retried
 * weeks later is not "24 days of work", and the span across attempts would
 * also outrank every real duration in the "Durasi terlama" order.
 */
function taskDuration(t, now) {
  var execs = (t.executions || []).filter(function (e) {
    return typeof e.duration_ms === 'number';
  });
  if (execs.length) return execs[execs.length - 1].duration_ms;
  var until = t.completed_at || t.updated_at || (now ? new Date(now).toISOString() : null);
  return durationBetween(t.started_at, until);
}

function buildMission(input) {
  var i = input || {};
  var now = i.now || Date.now();
  var live = i.liveWindowMs || 120000;
  var tasks = []
    .concat(dispatchTasks(i.ledger, i.queue, { now: now, liveWindowMs: live }))
    .concat(orchestrationTasks(i.plans, i.sessions, { now: now }))
    .concat(workflowTasks(i.workflows, i.executions, { now: now }));
  tasks.forEach(function (t) {
    t.duration_ms = taskDuration(t, now);
    var meta = statusMeta(t.status);
    t.status_label = meta.label;
    t.status_tone = meta.tone;
    t.actions = actionsFor(t);
  });
  return {
    tasks: tasks,
    counters: countStatuses(tasks),
    agents: agentSummary(tasks, i.agents),
    statuses: STATUS_META,
    counter_meta: COUNTER_META,
    generated_at: new Date(now).toISOString(),
  };
}

/**
 * What the page shows: the SAME list the counters describe. Filtering and
 * sorting happen here, on the server, so the browser and the dashboard can
 * never disagree about what "Total Task" counts.
 */
function missionView(input, opts) {
  var o = opts || {};
  var all = buildMission(input);
  var tasks = filterTasks(all.tasks, o);
  tasks = sortTasks(tasks, o.sort);
  return {
    tasks: tasks,
    counters: countStatuses(tasks),
    agents: agentSummary(tasks, all.agents),
    statuses: all.statuses,
    counter_meta: all.counter_meta,
    total: all.tasks.length,
    period: o.period || 'all',
    status: o.status || '',
    agent: o.agent || '',
    sort: o.sort || 'smart',
    generated_at: all.generated_at,
  };
}

/* ------------------------------------------------------- filter and sort */

function filterTasks(tasks, opts) {
  var o = opts || {};
  var status = o.status || '';
  var agent = o.agent || '';
  var q = text(o.q).trim().toLowerCase();
  var now = o.now || Date.now();
  var period = PERIODS[o.period] ? o.period : 'all';
  var windowMs = PERIODS[period].ms;

  return (tasks || []).filter(function (t) {
    if (status && t.status !== status) return false;
    if (agent && t.owner_agent !== agent && t.current_assignee !== agent) return false;
    if (windowMs) {
      var at = toMs(t.updated_at || t.created_at);
      if (isFinite(at) && now - at > windowMs) return false;
    }
    if (q) {
      var hay = [
        t.title,
        t.task_id,
        t.description,
        AGENT_LABEL[t.owner_agent] || t.owner_agent,
        AGENT_LABEL[t.current_assignee] || t.current_assignee,
        t.status,
        statusMeta(t.status).label, // the word the owner SEES must be searchable
      ]
        .join(' ')
        .toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  });
}

var ACTIVE_FIRST = ['running', 'waiting_approval', 'queued'];

function sortTasks(tasks, sort) {
  var list = (tasks || []).slice();
  var by = sort || 'smart';
  function updated(t) { return toMs(t.updated_at || t.created_at) || 0; }
  function created(t) { return toMs(t.created_at || t.updated_at) || 0; }
  if (by === 'newest') {
    list.sort(function (a, b) { return created(b) - created(a); });
  } else if (by === 'oldest') {
    list.sort(function (a, b) { return created(a) - created(b); });
  } else if (by === 'updated') {
    list.sort(function (a, b) { return updated(b) - updated(a); });
  } else if (by === 'duration') {
    list.sort(function (a, b) {
      var x = typeof a.duration_ms === 'number' ? a.duration_ms : -1;
      var y = typeof b.duration_ms === 'number' ? b.duration_ms : -1;
      return y - x;
    });
  } else if (by === 'priority') {
    list.sort(function (a, b) {
      var x = typeof a.priority === 'number' ? a.priority : -1;
      var y = typeof b.priority === 'number' ? b.priority : -1;
      return y - x;
    });
  } else {
    list.sort(function (a, b) {
      var ax = ACTIVE_FIRST.indexOf(a.status);
      var bx = ACTIVE_FIRST.indexOf(b.status);
      if (ax !== bx) {
        if (ax < 0) return 1;
        if (bx < 0) return -1;
        return ax - bx;
      }
      return updated(b) - updated(a);
    });
  }
  return list;
}

module.exports = {
  AGENT_IDS,
  AGENT_LABEL,
  STATUS_META,
  AGENT_STATUS_META,
  COUNTER_META,
  PERIODS,
  SORTS,
  statusMeta,
  mapDispatchRawStatus,
  mapOrchStatus,
  mapWorkflowStatus,
  executionsFromHistory,
  dispatchTasks,
  orchestrationTasks,
  workflowTasks,
  actionsFor,
  countStatuses,
  agentSummary,
  taskDuration,
  buildMission,
  missionView,
  filterTasks,
  sortTasks,
};
