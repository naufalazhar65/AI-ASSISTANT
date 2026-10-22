/**
 * The dashboard's Live transport — unit tests.
 *
 *   node --test apps/office-dashboard/live.test.mjs
 *
 * The transport is the only place the browser names an agent, so the property
 * under test is: the browser picks WHICH agent answers, and it never names a
 * user. The identity itself is pinned server-side by the proxy (see
 * apps/web/drill-dashboard-live.mts, which proves that over real HTTP).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLive } from './live.mjs';

/** A fake LiveClient that records how it was built and started. */
function fakeLiveClient(calls) {
  return class Fake {
    constructor(options) {
      calls.options = options;
      this.options = options;
      this.listeners = [];
    }
    subscribe(fn) {
      this.listeners.push(fn);
      fn({ status: 'idle', speaking: false, heard: '', said: '' });
      return () => {};
    }
    async start(stream) {
      calls.stream = stream;
      calls.started = true;
      /* The real client mints its token through the fetch it was given. */
      await this.options.fetchImpl('/api/gemini-live/token', { method: 'POST' });
      this.listeners.forEach((fn) => fn({ status: 'ready', speaking: false, heard: '', said: '' }));
      return { ok: true };
    }
    stop() {
      calls.stopped = true;
    }
  };
}

function fakeStream() {
  return { getTracks: () => [{ stop() {} }] };
}

test('the transport starts the session with the dashboard bearer and the chosen agent', async () => {
  const calls = {};
  globalThis.MiaLive = { LiveClient: fakeLiveClient(calls) };
  const seen = [];
  const live = createLive({
    readToken: () => 'dash-token',
    getUserMedia: async () => fakeStream(),
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return { ok: true, json: async () => ({}) };
    },
  });

  const states = [];
  live.subscribe((s) => states.push(s));
  await live.toggle();

  assert.equal(calls.started, true, 'the Live client must be started');
  assert.equal(states.at(-1).status, 'ready', 'the state must follow the client');

  /* The token route is fetched by the client itself, so the transport's
     fetch wrapper is what carries the bearer and the agent. */
  const tokenCall = seen.find((c) => c.url.includes('/api/gemini-live/token'));
  assert.ok(tokenCall, 'the token route must be called');
  assert.equal(tokenCall.init.headers.authorization, 'Bearer dash-token');
  assert.match(tokenCall.url, /agent=mia/, 'the agent travels in the query');

  delete globalThis.MiaLive;
});

test('switching the agent names the new agent and closes the running session', async () => {
  const calls = {};
  globalThis.MiaLive = { LiveClient: fakeLiveClient(calls) };
  const seen = [];
  const live = createLive({
    readToken: () => '',
    getUserMedia: async () => fakeStream(),
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return { ok: true, json: async () => ({}) };
    },
  });

  const states = [];
  live.subscribe((s) => states.push(s));
  await live.toggle();
  live.setAgent('agnes');

  assert.equal(live.agent, 'agnes');
  assert.equal(calls.stopped, true, 'the open session must be closed');
  assert.match(states.at(-1).note, /Agent diganti/, 'the reason must be stated');
  /* No bearer in localStorage means no bearer header — never an empty one. */
  const tokenCall = seen.find((c) => c.url.includes('/api/gemini-live/token'));
  assert.equal(tokenCall.init.headers.authorization, undefined);

  delete globalThis.MiaLive;
});

test('a refused microphone says so instead of pretending a session is open', async () => {
  const calls = {};
  globalThis.MiaLive = { LiveClient: fakeLiveClient(calls) };
  const live = createLive({
    readToken: () => '',
    getUserMedia: async () => {
      throw new Error('Permission denied');
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });

  const states = [];
  live.subscribe((s) => states.push(s));
  await live.toggle();

  assert.equal(calls.started, undefined, 'no session without a microphone');
  assert.match(states.at(-1).note, /Mikrofon tidak bisa dibuka/);
  assert.match(states.at(-1).note, /Permission denied/);

  delete globalThis.MiaLive;
});

test('a missing bundle is reported honestly, not as a silent idle', async () => {
  delete globalThis.MiaLive;
  const live = createLive({ readToken: () => '' });
  const states = [];
  live.subscribe((s) => states.push(s));
  await live.toggle();
  assert.match(states.at(-1).note, /Bundle Live tidak termuat/);
});

test('the transport never names a user — only the agent', async () => {
  const calls = {};
  globalThis.MiaLive = { LiveClient: fakeLiveClient(calls) };
  const seen = [];
  const live = createLive({
    readToken: () => 'dash-token',
    getUserMedia: async () => fakeStream(),
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return { ok: true, json: async () => ({}) };
    },
  });
  await live.toggle();
  const tokenCall = seen.find((c) => c.url.includes('/api/gemini-live/token'));
  assert.equal(tokenCall.init.headers['x-mia-user'], undefined);
  assert.equal(tokenCall.init.headers['x-mia-agent'], undefined);
  delete globalThis.MiaLive;
});
