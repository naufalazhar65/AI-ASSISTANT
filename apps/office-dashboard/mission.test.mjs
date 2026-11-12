'use strict';
/**
 * Mission Control — pure domain tests (node --test, no framework).
 *
 * These lock the three rules that make Mission Control trustworthy:
 * one task = one identity, one execution = one attempt, progress is only
 * ever what the engine reported.
 */

/* Unit tests for the Mission Control domain logic (apps/office-dashboard/mission.cjs).
 * The dashboard server is CommonJS, so the module is CommonJS too; this ESM
 * test reaches it through createRequire. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const M = require('./mission.cjs');

const NOW = Date.parse('2026-11-11T10:00:00Z');
const LIVE = 5 * 60 * 1000;

function iso(ms) { return new Date(ms).toISOString(); }

test('dispatch ledger rows become tasks; audit-mirror turns are not tasks', () => {
  const ledger = [
    {
      task_id: 'task-q1',
      agent: 'mia',
      title: 'Riset keamanan siber',
      status: 'done',
      started_at: iso(NOW - 60 * 60 * 1000),
      updated_at: iso(NOW - 30 * 60 * 1000),
      source: 'dashboard',
      detail: 'Selesai',
      history: [{ ts: iso(NOW - 60 * 60 * 1000), status: 'started', detail: 'Dikirim' }],
      prompt: 'riset keamanan siber',
    },
    {
      task_id: 'turn-mia-1',
      agent: 'mia',
      title: 'Turn mia via 9router',
      status: 'started',
      started_at: iso(NOW - 60 * 60 * 1000),
      updated_at: iso(NOW - 60 * 60 * 1000),
      source: 'audit-mirror',
      history: [],
    },
  ];
  const out = M.dispatchTasks(ledger, [], { now: NOW, liveWindowMs: LIVE });
  assert.equal(out.length, 1, 'a conversation turn must not enter Mission Control');
  assert.equal(out[0].task_id, 'task-q1');
  assert.equal(out[0].status, 'completed');
  assert.equal(out[0].owner_agent, 'mia');
});

test('a stale started row is "Berhenti", never "Berjalan"', () => {
  const old = [
    {
      task_id: 'task-old',
      agent: 'mia',
      title: 'Dulu',
      status: 'started',
      started_at: iso(NOW - 3 * 24 * 60 * 60 * 1000),
      updated_at: iso(NOW - 3 * 24 * 60 * 60 * 1000),
      source: 'dashboard',
      history: [],
    },
  ];
  const fresh = [Object.assign({}, old[0], {
    task_id: 'task-new',
    started_at: iso(NOW - 1000),
    updated_at: iso(NOW - 1000),
  })];
  assert.equal(M.dispatchTasks(old, [], { now: NOW, liveWindowMs: LIVE })[0].status, 'stale');
  assert.equal(M.dispatchTasks(fresh, [], { now: NOW, liveWindowMs: LIVE })[0].status, 'running');
});

test('one task id, many executions: a retry keeps the identity and adds an attempt', () => {
  const ledger = [
    {
      task_id: 'task-q1',
      agent: 'mia',
      title: 'Pekerjaan',
      status: 'failed',
      started_at: iso(NOW - 30 * 60 * 1000),
      updated_at: iso(NOW - 20 * 60 * 1000),
      source: 'dashboard',
      prompt: 'prompt asli',
      history: [
        { ts: iso(NOW - 30 * 60 * 1000), status: 'started', detail: 'dikirim', execution_id: 'task-q1::1', attempt: 1 },
        { ts: iso(NOW - 25 * 60 * 1000), status: 'failed', detail: 'gagal', execution_id: 'task-q1::1', attempt: 1 },
      ],
    },
  ];
  const queue = [
    { id: 'q2', ts: iso(NOW - 1000), prompt: 'prompt asli', agent: 'mia', status: 'queued', task_id: 'task-q1', attempt: 2 },
  ];
  const out = M.dispatchTasks(ledger, queue, { now: NOW, liveWindowMs: LIVE });
  assert.equal(out.length, 1, 'the queued retry must merge into the SAME task');
  assert.equal(out[0].task_id, 'task-q1');
  assert.equal(out[0].status, 'queued');
  assert.equal(out[0].executions.length, 2, 'two attempts, one task');
  assert.equal(out[0].executions[0].attempt, 1);
  assert.equal(out[0].executions[1].attempt, 2);
});

test('a cancelled queue row stays visible as a cancelled task', () => {
  const queue = [{ id: 'q3', ts: iso(NOW - 5000), prompt: 'dibatalkan', prompt_full: 'dibatalkan', agent: 'mia', status: 'cancelled', task_id: 'task-q3', attempt: 1 }];
  const out = M.dispatchTasks([], queue, { now: NOW, liveWindowMs: LIVE });
  assert.equal(out.length, 1, 'a cancelled task must not vanish');
  assert.equal(out[0].status, 'cancelled');
  assert.equal(out[0].prompt, 'dibatalkan', 'the prompt must survive so a retry is possible');
  const acts = M.actionsFor(out[0]);
  assert.equal(acts[0].id, 'retry', 'a cancelled task with a prompt can be re-queued');
});

test('a queued item with no dispatched row yet is one queued task', () => {
  const queue = [{ id: 'q9', ts: iso(NOW - 5000), prompt: 'baru', agent: 'agnes', status: 'queued', task_id: 'task-q9' }];
  const out = M.dispatchTasks([], queue, { now: NOW, liveWindowMs: LIVE });
  assert.equal(out.length, 1);
  assert.equal(out[0].status, 'queued');
  assert.equal(out[0].task_id, 'task-q9');
  assert.equal(out[0].current_assignee, 'agnes');
});

test('orchestration progress comes from the plan stage graph only', () => {
  const plans = [
    {
      id: 'orch_1',
      created_at: iso(NOW - 60 * 60 * 1000),
      tasks: [
        { task_id: 't1', objective: 'Riset sumber', agent_id: 'agnes', status: 'SUCCEEDED', created_at: iso(NOW - 60 * 60 * 1000), completed_at: iso(NOW - 30 * 60 * 1000) },
        { task_id: 't2', objective: 'Tulis kode', agent_id: 'michelle', status: 'RUNNING', created_at: iso(NOW - 30 * 60 * 1000) },
      ],
    },
  ];
  const out = M.orchestrationTasks(plans, [], { now: NOW });
  assert.equal(out.length, 2);
  assert.equal(out[0].task_id, 'orch:orch_1:t1');
  assert.equal(out[0].status, 'completed');
  assert.equal(out[1].status, 'running');
  assert.deepEqual(out[1].progress, { done: 1, total: 2, label: '1 dari 2 tahap' });
  assert.equal(out[1].stages.length, 2);
  assert.equal(out[1].supporting_agents.length, 1);
});

test('a workflow without stages reports no progress instead of a fake one', () => {
  const workflows = [
    { workflow_id: 'wf1', name: 'Cek harian', agent_id: 'mia', schedule: '0 8 * * *', paused: false },
  ];
  const executions = [
    { execution_id: 'ex1', workflow_id: 'wf1', status: 'FAILED', started_at: iso(NOW - 60 * 60 * 1000), finished_at: iso(NOW - 59 * 60 * 1000), error_summary: 'boom' },
  ];
  const out = M.workflowTasks(workflows, executions, { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].task_id, 'wf:wf1');
  assert.equal(out[0].status, 'failed');
  assert.equal(out[0].progress, null);
  assert.equal(out[0].error, 'boom');
});

test('actions are only offered when the backend can perform them', () => {
  const dispatchFailed = { source: 'dispatch', status: 'failed', prompt: 'p' };
  const dispatchOk = { source: 'dispatch', status: 'completed', prompt: 'p' };
  const dispatchQueued = { source: 'dispatch', status: 'queued', prompt: 'p' };
  const dispatchNoPrompt = { source: 'dispatch', status: 'failed', prompt: null };
  assert.equal(M.actionsFor(dispatchFailed)[0].id, 'retry');
  assert.equal(M.actionsFor(dispatchOk).length, 0);
  assert.equal(M.actionsFor(dispatchQueued)[0].id, 'cancel');
  assert.equal(M.actionsFor(dispatchNoPrompt).length, 0, 'no prompt = no honest retry');

  assert.equal(M.actionsFor({ source: 'workflow', status: 'failed' })[0].id, 'retry');
  assert.equal(M.actionsFor({ source: 'workflow', status: 'running' })[0].id, 'cancel');
  assert.equal(M.actionsFor({ source: 'workflow', status: 'idle', workflow_paused: true })[0].id, 'resume');
  assert.equal(M.actionsFor({ source: 'orchestration', status: 'running' })[0].id, 'cancel_plan');
  assert.equal(M.actionsFor({ source: 'orchestration', status: 'completed' }).length, 0);
});

test('counters count every task exactly once', () => {
  const tasks = [
    { status: 'running' },
    { status: 'running' },
    { status: 'completed' },
    { status: 'failed' },
    { status: 'queued' },
  ];
  const c = M.countStatuses(tasks);
  assert.equal(c.total, 5);
  assert.equal(c.running, 2);
  assert.equal(c.completed, 1);
  assert.equal(c.failed, 1);
  assert.equal(c.queued, 1);
  const sum = ['running', 'queued', 'waiting_approval', 'completed', 'partial', 'failed', 'cancelled', 'blocked', 'skipped', 'stale', 'idle']
    .reduce(function (n, k) { return n + c[k]; }, 0);
  assert.equal(sum, c.total, 'no task may be counted twice or lost');
});

test('filter honours status, agent, search and period', () => {
  const tasks = [
    { task_id: 'a', title: 'Riset keamanan', status: 'running', owner_agent: 'agnes', current_assignee: 'agnes', updated_at: iso(NOW - 1000), description: 'cari CVE' },
    { task_id: 'b', title: 'Tulis modul', status: 'completed', owner_agent: 'michelle', current_assignee: 'michelle', updated_at: iso(NOW - 10 * 24 * 60 * 60 * 1000), description: 'refactor' },
  ];
  assert.equal(M.filterTasks(tasks, { status: 'running' }).length, 1);
  assert.equal(M.filterTasks(tasks, { agent: 'michelle' }).length, 1);
  assert.equal(M.filterTasks(tasks, { q: 'cve' }).length, 1);
  assert.equal(M.filterTasks(tasks, { q: 'agnes' }).length, 1);
  assert.equal(M.filterTasks(tasks, { period: '24h', now: NOW }).length, 1);
  assert.equal(M.filterTasks(tasks, { period: 'all', now: NOW }).length, 2);
});

test('sort puts active work first by default and honours the explicit orders', () => {
  const tasks = [
    { task_id: 'done', status: 'completed', created_at: iso(NOW - 1000), updated_at: iso(NOW - 1000) },
    { task_id: 'run', status: 'running', created_at: iso(NOW - 5000), updated_at: iso(NOW - 5000) },
    { task_id: 'old', status: 'completed', created_at: iso(NOW - 90000), updated_at: iso(NOW - 90000) },
  ];
  const smart = M.sortTasks(tasks, 'smart').map(function (t) { return t.task_id; });
  assert.equal(smart[0], 'run', 'active work comes first');
  assert.equal(M.sortTasks(tasks, 'newest')[0].task_id, 'done');
  assert.equal(M.sortTasks(tasks, 'oldest')[0].task_id, 'old');
  assert.equal(M.sortTasks(tasks, 'updated')[0].task_id, 'done');
});

test('buildMission merges every source into one list with one roll-up', () => {
  const mission = M.buildMission({
    now: NOW,
    liveWindowMs: LIVE,
    ledger: [{ task_id: 'task-q1', agent: 'mia', title: 'A', status: 'done', source: 'dashboard', started_at: iso(NOW - 1000), updated_at: iso(NOW - 500), history: [] }],
    queue: [],
    plans: [],
    sessions: [],
    workflows: [],
    executions: [],
    agents: [{ id: 'mia', name: 'Mia', role: 'Main Assistant', status: 'idle' }],
  });
  assert.equal(mission.tasks.length, 1);
  assert.equal(mission.counters.total, 1);
  assert.equal(mission.agents.length, 3, 'all three agents are always listed');
  assert.equal(mission.agents[0].total, 1);
  assert.equal(mission.agents[0].active, 0, 'an idle agent is available, not broken');
  assert.ok(mission.generated_at);
});

/* ── audit 2026-11-11: bugs found in a live re-audit ────────────────────── */

test('a failed task whose prompt only lives in the queue can still be re-run', () => {
  const ledger = [
    {
      task_id: 'task-q1',
      agent: 'mia',
      title: 'kirim berita',
      status: 'failed',
      started_at: iso(NOW - 3600_000),
      updated_at: iso(NOW - 1800_000),
      source: 'dashboard',
      detail: 'HTTP 401',
      history: [{ ts: iso(NOW - 1800_000), status: 'failed', detail: 'HTTP 401' }],
    },
  ];
  const queue = [
    {
      id: 'q1',
      ts: iso(NOW - 3600_000),
      prompt: 'kirim berita ke discord',
      prompt_full: 'kirim berita ke discord',
      agent: 'mia',
      status: 'done',
      task_id: 'task-q1',
      attempt: 1,
    },
  ];
  const out = M.dispatchTasks(ledger, queue, { now: NOW, liveWindowMs: LIVE });
  assert.equal(out[0].status, 'failed');
  assert.equal(out[0].prompt, 'kirim berita ke discord', 'the queue ledger still holds the prompt');
  assert.ok(
    M.actionsFor(out[0]).some((a) => a.id === 'retry'),
    'a failed task must offer a retry when the prompt is recoverable',
  );
});

test('a cancelled task shows when it was cancelled, not when it was queued', () => {
  const queue = [
    {
      id: 'q1',
      ts: iso(NOW - 600_000),
      prompt: 'x',
      prompt_full: 'x',
      agent: 'mia',
      status: 'cancelled',
      detail: 'dibatalkan dari Mission Control',
      task_id: 'task-q1',
      attempt: 1,
      updated_at: iso(NOW - 60_000),
    },
  ];
  const out = M.dispatchTasks([], queue, { now: NOW, liveWindowMs: LIVE });
  assert.equal(out.length, 1);
  assert.equal(out[0].status, 'cancelled');
  assert.equal(out[0].created_at, iso(NOW - 600_000));
  assert.equal(out[0].updated_at, iso(NOW - 60_000), 'the cancel time is the update time');
});

test('a waiting retry points at its own execution', () => {
  const ledger = [
    {
      task_id: 'task-q1',
      agent: 'mia',
      title: 'x',
      status: 'failed',
      started_at: iso(NOW - 3600_000),
      updated_at: iso(NOW - 1800_000),
      source: 'dashboard',
      detail: 'boom',
      history: [{ ts: iso(NOW - 1800_000), status: 'failed', detail: 'boom' }],
    },
  ];
  const queue = [
    {
      id: 'q2',
      ts: iso(NOW - 60_000),
      prompt: 'x',
      prompt_full: 'x',
      agent: 'mia',
      status: 'queued',
      task_id: 'task-q1',
      attempt: 2,
    },
  ];
  const out = M.dispatchTasks(ledger, queue, { now: NOW, liveWindowMs: LIVE });
  const t = out[0];
  assert.equal(t.status, 'queued');
  assert.equal(t.execution_id, 'task-q1::2', 'the task points at the execution that waits');
  const ev = t.events[t.events.length - 1];
  assert.equal(ev.execution_id, 'task-q1::2');
  assert.equal(ev.attempt, 2);
});

test('the word the owner SEES is searchable', () => {
  const ledger = [
    {
      task_id: 'task-q1',
      agent: 'mia',
      title: 'kirim berita',
      status: 'failed',
      started_at: iso(NOW - 3600_000),
      updated_at: iso(NOW - 1800_000),
      source: 'dashboard',
      history: [],
    },
  ];
  const out = M.buildMission({ ledger, queue: [], now: NOW, liveWindowMs: LIVE });
  assert.equal(M.filterTasks(out.tasks, { q: 'Gagal', now: NOW }).length, 1, 'the badge word filters');
  assert.equal(M.filterTasks(out.tasks, { q: 'failed', now: NOW }).length, 1, 'the raw enum still filters');
});

test('a task whose dispatch never closed can be re-run', () => {  const ledger = [
    {
      task_id: 'task-stuck',
      agent: 'mia',
      title: 'x',
      status: 'started',
      started_at: iso(NOW - 3600_000),
      updated_at: iso(NOW - 3600_000),
      source: 'dashboard',
      prompt: 'x',
      history: [{ ts: iso(NOW - 3600_000), status: 'started' }],
    },
  ];
  const out = M.dispatchTasks(ledger, [], { now: NOW, liveWindowMs: LIVE });
  assert.equal(out[0].status, 'stale');
  assert.ok(M.actionsFor(out[0]).some((a) => a.id === 'retry'), 'a dead dispatch can be re-run');
});

test('the duration is the last attempt, not the span across attempts', () => {
  const ledger = [
    {
      task_id: 'task-q1',
      agent: 'mia',
      title: 'x',
      status: 'done',
      started_at: iso(NOW - 20 * 24 * 3600_000),
      updated_at: iso(NOW - 1000),
      source: 'dashboard',
      detail: 'ok',
      history: [
        { ts: iso(NOW - 20 * 24 * 3600_000), status: 'started', execution_id: 'exec-1' },
        { ts: iso(NOW - 20 * 24 * 3600_000 + 12), status: 'failed', execution_id: 'exec-1' },
        { ts: iso(NOW - 5000), status: 'started', execution_id: 'task-q1::2' },
        { ts: iso(NOW - 1000), status: 'done', execution_id: 'task-q1::2' },
      ],
    },
  ];
  const out = M.dispatchTasks(ledger, [], { now: NOW, liveWindowMs: LIVE });
  const t = out[0];
  assert.equal(t.duration_ms, 4000, 'the last attempt took 4 s, not 20 days');
  assert.ok(t.duration_ms < 60_000, 'a retry weeks later must not be a 20-day duration');
});

test('a finished attempt is not shown as still running (the session outcome wins)', () => {
  const plans = [
    {
      id: 'orch_2',
      created_at: iso(NOW - 60 * 60 * 1000),
      tasks: [
        { task_id: 't1', objective: 'Riset sumber', agent_id: 'agnes', status: 'SUCCEEDED', created_at: iso(NOW - 60 * 60 * 1000), completed_at: iso(NOW - 30 * 60 * 1000) },
      ],
    },
  ];
  const sessions = [
    {
      id: 'ps_orch_2_t1',
      plan_id: 'orch_2',
      task_id: 't1',
      status: 'succeeded',
      attempts: [
        { n: 1, at: iso(NOW - 60 * 60 * 1000), phase: 'DIAGNOSE', action: 'gagal', failure: 'boom', duration_ms: 1200 },
        { n: 2, at: iso(NOW - 50 * 60 * 1000), phase: 'VERIFY', action: 'ok', duration_ms: 3400 },
      ],
    },
  ];
  const out = M.orchestrationTasks(plans, sessions, { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].executions.length, 2);
  assert.equal(out[0].executions[0].status, 'failed', 'the failed attempt stays failed');
  assert.equal(out[0].executions[1].status, 'completed', 'the last attempt inherits the finished session');
  assert.equal(out[0].events[out[0].events.length - 1].status, 'completed', 'the timeline says the same');
});

test('the attempt count falls back to the engine when no per-attempt history is on disk', () => {
  const plans = [
    {
      id: 'orch_3',
      created_at: iso(NOW - 60 * 60 * 1000),
      tasks: [
        { task_id: 't1', objective: 'Riset sumber', agent_id: 'agnes', status: 'SUCCEEDED', attempts: 2, created_at: iso(NOW - 60 * 60 * 1000), completed_at: iso(NOW - 30 * 60 * 1000) },
      ],
    },
  ];
  const out = M.orchestrationTasks(plans, [], { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].attempts, 2, 'the board must not say "no attempts" when the engine says two');
});
