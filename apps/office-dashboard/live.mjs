/**
 * Office — Gemini Live transport.
 *
 * The Live client itself comes from the committed bundle
 * `vendor/live.bundle.js` (esbuild output from `apps/web`, global `MiaLive`).
 * This module is the thin transport around it: it holds the session, asks for
 * the microphone, and forwards every Mia call through the DASHBOARD's own
 * `/api/gemini-live/*` proxy.
 *
 * Identity is never claimed here. The browser names only WHICH of the three
 * known agents answers (`?agent=`); the proxy pins `x-mia-user` and
 * `x-mia-agent` server-side, so the page cannot become somebody else.
 *
 * No DOM in this file — the chat panel renders the state.
 *
 * The seams (fetchImpl / getUserMedia / token) exist so the transport can be
 * unit-tested with `node --test` (the dashboard has no test runner of its own)
 * without a browser.
 */

/** The state a caller sees before a session exists. */
const LIVE_IDLE = {
  status: 'idle',
  speaking: false,
  heard: '',
  said: '',
  error: '',
  stalled: '',
  toolNote: '',
  verifyNote: '',
};

export function createLive(opts = {}) {
  const listeners = new Set();
  let client = null;
  let stream = null;
  let agentId = 'mia';
  let state = { ...LIVE_IDLE };
  /** A note the TRANSPORT owns (agent switched, bundle missing, mic refused). */
  let note = '';

  const publish = () => {
    for (const fn of listeners) {
      try {
        fn({ ...state, note, agent: agentId });
      } catch {
        /* a listener fault must never break the session */
      }
    }
  };

  const doFetch = opts.fetchImpl || ((...args) => globalThis.fetch(...args));
  const getUserMedia = opts.getUserMedia || ((c) => globalThis.navigator.mediaDevices.getUserMedia(c));
  const readToken = opts.readToken || (() => {
    try {
      return globalThis.localStorage.getItem('mia_token') || '';
    } catch {
      return '';
    }
  });

  /**
   * Every Mia-web call this client makes carries the dashboard's own bearer
   * and names the chosen agent in the query. The proxy pins the identity
   * itself, so the agent here is a SELECTOR, not a claim about who the user is.
   */
  const liveFetch = (url, init = {}) => {
    const headers = { ...(init.headers || {}) };
    const token = readToken();
    if (token) headers.authorization = `Bearer ${token}`;
    let target = String(url);
    if (target.includes('/api/gemini-live/')) {
      target += (target.includes('?') ? '&' : '?') + 'agent=' + encodeURIComponent(agentId);
    }
    return doFetch(target, { ...init, headers });
  };

  const build = () => {
    const LiveClient = (globalThis.MiaLive || {}).LiveClient;
    if (!LiveClient) return false;
    client = new LiveClient({ fetchImpl: liveFetch });
    client.subscribe((s) => {
      state = { ...s };
      publish();
    });
    return true;
  };

  const teardown = () => {
    try {
      if (client) client.stop();
    } catch {
      /* already gone */
    }
    try {
      if (stream) stream.getTracks().forEach((t) => t.stop());
    } catch {
      /* already gone */
    }
    client = null;
    stream = null;
    state = { ...LIVE_IDLE };
  };

  const start = async () => {
    if (!client && !build()) {
      note = 'Bundle Live tidak termuat (vendor/live.bundle.js). Jalankan: npm run build:dashboard-live';
      publish();
      return;
    }
    note = '';
    try {
      stream = await getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      note = 'Mikrofon tidak bisa dibuka: ' + (err && err.message ? err.message : String(err));
      publish();
      return;
    }
    const res = await client.start(stream);
    if (!res || !res.ok) note = (res && res.error) || 'Live tidak bisa dimulai.';
    publish();
  };

  const stop = () => {
    teardown();
    note = '';
    publish();
  };

  /**
   * The persona and the voice are pinned when the token is minted, so a new
   * agent only means anything on a fresh session. Never keep the old agent's
   * voice under the new name: the running session is closed and the reason is
   * stated.
   */
  const setAgent = (id) => {
    if (!id || id === agentId) return;
    const wasLive = !!client && state.status !== 'idle' && state.status !== 'closed' && state.status !== 'error';
    agentId = id;
    /* The client is rebuilt on the next start (the persona and the voice are
       pinned when the token is minted), so an open session is closed now. */
    if (client) teardown();
    note = wasLive ? 'Agent diganti — sesi live ditutup.' : '';
    publish();
  };

  return {
    /** Subscribe to the live state (the listener fires immediately). */
    subscribe(fn) {
      listeners.add(fn);
      fn({ ...state, note, agent: agentId });
      return () => listeners.delete(fn);
    },
    /** The agent this session speaks for. */
    get agent() {
      return agentId;
    },
    /** Start or stop the microphone session. */
    toggle() {
      const busy = state.status !== 'idle' && state.status !== 'closed' && state.status !== 'error';
      if (busy) {
        stop();
        return;
      }
      return start();
    },
    stop,
    setAgent,
  };
}
