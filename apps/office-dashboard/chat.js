/**
 * Office chat sidebar — UI layer.
 *
 * Transport/state live in `createChat` (the useChat equivalent); every render
 * function here is pure DOM given that state. Nothing privileged happens in
 * the browser: messages go to Mia's `/api/office/chat`, which runs the real
 * agent turn; tools execute server-side only and their lifecycle comes back as
 * bus events + real tool results.
 */
import {
  sanitizeMarkdown, parseNdjsonLine, applyBusEvent, turnIsLive, connectionLabel,
  visibleMessages, agentAvailability, toolStateMeta, humanError, humanGenerationError,
  avatarUrl,
} from './chat-core.mjs';

const CHAT_AGENTS = ['mia', 'agnes', 'michelle'];
const FALLBACK_AGENT_META = {
  mia: { id: 'mia', name: 'Mia', role: 'Main Assistant / Coordinator', accent: '#8b9dc3' },
  agnes: { id: 'agnes', name: 'Agnes', role: 'Researcher', accent: '#7fae9b' },
  michelle: { id: 'michelle', name: 'Michelle', role: 'Coder / Engineer', accent: '#a08fc0' },
};
const MAX_CHARS = 4000;

/* ── transport + state ─────────────────────────────────────────────── */

/**
 * Auth: the dashboard stores its token once in `localStorage['mia_token']` and
 * appends `?token=` to every /api/ call (EventSource cannot send headers). The
 * sidebar must use the SAME convention, otherwise Mia's middleware 401s it —
 * cookie auth alone is not enough.
 */
function withAuth(url) {
  let t = '';
  try {
    t = localStorage.getItem('mia_token') || '';
  } catch {
    t = '';
  }
  if (!t) return url;
  return url + (url.indexOf('?') < 0 ? '?' : '&') + 'token=' + encodeURIComponent(t);
}

function createChat({ endpoint = '/api/office/chat', fetchImpl = fetch } = {}) {
  const convs = {};
  const listeners = new Set();
  let connection = 'idle';
  let selected = 'mia';
  let busyAgent = null;
  let agentMeta = { ...FALLBACK_AGENT_META };
  let agentStatus = {};
  let abort = null;

  const emit = () => listeners.forEach((fn) => fn(snapshot()));
  function snapshot() {
    return {
      connection,
      selected,
      busyAgent,
      // The renderer reads this off the snapshot (it only ever sees a snapshot,
      // never the live getters) — omitting it silently killed the typing state.
      busyForSelected: busyAgent === selected,
      agents: CHAT_AGENTS.map((id) => ({
        ...agentMeta[id],
        id,
        status: agentStatus[id] || 'unknown',
      })),
      conv: convs[selected] || blankConv(),
    };
  }
  const blankConv = () => ({
    messages: [], cards: [], pending: null, error: null, retryText: '', live: false, failed: false,
    frames: [], stamps: {}, accepted: false,
  });
  const conv = (id) => (convs[id] ||= blankConv());
  const subscribe = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };

  async function loadAgents() {
    try {
      const r = await fetchImpl(withAuth('/api/state'), { headers: { accept: 'application/json' } });
      if (!r.ok) return;
      const data = await r.json();
      for (const a of data.agents || []) {
        if (!CHAT_AGENTS.includes(a.id)) continue;
        agentMeta[a.id] = { ...(agentMeta[a.id] || {}), ...a };
        agentStatus[a.id] = a.status;
      }
    } catch {
      /* honest: agent cards keep fallback meta + "tidak diketahui" status */
    }
  }

  async function loadHistory(agent = selected) {
    const c = conv(agent);
    connection = 'connecting';
    emit();
    try {
      const r = await fetchImpl(withAuth(`${endpoint}?agent=${encodeURIComponent(agent)}`), {
        headers: { accept: 'application/json' },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      c.messages = Array.isArray(data.messages) ? data.messages : [];
      c.cards = Array.isArray(data.cards) ? data.cards : [];
      c.pending = null;
      c.error = null;
      c.retryText = '';
      c.failed = false;
      c.live = false;
      // Persisted messages carry no server timestamp. Rather than printing the
      // current time on every render (which would read as a real send time),
      // loaded history simply shows no time — only messages that arrive live in
      // this session are stamped, in `stampNew`.
      c.stamps = {};
      connection = 'open';
    } catch (err) {
      connection = 'error';
      c.error = `Riwayat tidak bisa dimuat: ${humanError(err)}`;
    }
    emit();
  }

  function select(agent) {
    if (!CHAT_AGENTS.includes(agent) || agent === selected) return;
    selected = agent;
    emit();
    if (!convs[agent]) loadHistory(agent);
  }

  async function send(text, agent = selected) {
    const body = String(text || '').trim().slice(0, MAX_CHARS);
    if (!body || busyAgent) return false;
    const c = conv(agent);
    busyAgent = agent;
    connection = 'connecting';
    c.error = null;
    c.retryText = '';
    c.failed = false;
    c.live = true;
    c.frames = [];
    if (!c.stamps) c.stamps = {};
    // Optimistic bubble with a stable local id; replaced by server truth when
    // the stream returns `messages`.
    const outgoing = [...c.messages, { role: 'user', content: body }];
    c.messages = outgoing;
    stampNew(c);
    emit();
    abort = new AbortController();
    await stream({ agent, messages: outgoing }, abort.signal);
    busyAgent = null;
    abort = null;
    c.live = false;
    emit();
    // False = the turn did not complete, so the composer keeps the draft.
    return !c.failed;
  }

  /** Resend the last user message after a failed turn; its bubble is replaced,
   *  not duplicated. Returns false when there is nothing to retry. */
  function retry() {
    if (busyAgent) return false;
    const c = conv(selected);
    for (let i = c.messages.length - 1; i >= 0; i -= 1) {
      if (c.messages[i]?.role !== 'user') continue;
      const text = String(c.messages[i].content || '');
      c.messages = c.messages.slice(0, i);
      emit();
      return send(text, selected);
    }
    return false;
  }

  /** Approve or reject every pending call in one decision (batch, like Discord). */
  async function decide(allow) {
    const agent = selected;
    const c = conv(agent);
    if (!c.pending || !c.pending.calls?.length || busyAgent) return false;
    const calls = c.pending.calls;
    c.pending = { ...c.pending, decided: allow ? 'approved' : 'rejected' };
    busyAgent = agent;
    connection = 'connecting';
    c.live = true;
    emit();
    abort = new AbortController();
    await stream(
      {
        agent,
        messages: c.messages,
        confirm_calls: calls.map((call) => ({ call, allow })),
      },
      abort.signal,
    );
    busyAgent = null;
    abort = null;
    c.live = false;
    emit();
    return !c.failed;
  }

  async function stream(payload, signal) {
    const c = conv(payload.agent);
    const seen = new Set();
    try {
      const r = await fetchImpl(withAuth(endpoint), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
        body: JSON.stringify(payload),
        signal,
      });
      if (!r.ok || !r.body) {
        const text = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status} ${text.slice(0, 120)}`.trim());
      }
      connection = 'open';
      emit();
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const frame = parseNdjsonLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          if (frame) handle(c, frame, seen);
        }
      }
      handle(c, parseNdjsonLine(buf) || {}, seen);
      if (turnIsLive(c.frames)) {
        c.error = 'Koneksi terputus sebelum agent selesai — status sebenarnya tidak diketahui.';
        c.failed = true;
        connection = 'closed';
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      connection = 'error';
      c.error = `Gagal menghubungi agent: ${humanError(err)}`;
      c.failed = true;
    }
  }

  /** Stamp messages that just arrived in this session; older ones keep no time. */
  function stampNew(c) {
    if (!c.stamps) c.stamps = {};
    const now = Date.now();
    for (const m of visibleMessages(c.messages)) {
      if (!c.stamps[m.key]) c.stamps[m.key] = now;
    }
  }

  function handle(c, frame, seen) {
    if (!frame || !frame.type) return;
    const key = `${frame.type}:${frame.event?.id || ''}:${frame.type === 'message' ? frame.text : ''}`;
    if (seen.has(key)) return; // replay-safe dedupe by stable ids
    seen.add(key);
    if (frame.type === 'start') {
      connection = 'open';
      c.accepted = true;
    } else if (frame.type === 'bus' && frame.event) {
      c.frames.push(frame.event);
      c.cards = applyBusEvent(c.cards, frame.event);
    } else if (frame.type === 'confirm') {
      c.messages = frame.messages || c.messages;
      c.cards = frame.cards || c.cards;
      c.pending = { calls: frame.calls || [], decided: null };
      stampNew(c);
    } else if (frame.type === 'message') {
      c.messages = frame.messages || c.messages;
      c.cards = frame.cards || c.cards;
      c.pending = null;
      c.failed = false;
      c.live = false;
      stampNew(c);
    } else if (frame.type === 'error') {
      c.error = `Agent gagal menjalankan giliran ini: ${humanGenerationError(frame.message)}`;
      c.failed = true;
      c.live = false;
    }
    emit();
  }

  return {
    subscribe,
    snapshot,
    loadAgents,
    loadHistory,
    select,
    send,
    retry,
    decide,
    get busy() {
      return busyAgent !== null;
    },
    get busyForSelected() {
      return busyAgent === selected;
    },
    disconnect() {
      try {
        abort?.abort();
      } catch {
        /* ignore */
      }
      listeners.clear();
    },
  };
}

/* ── rendering ─────────────────────────────────────────────────────── */

const h = (tag, attrs = {}, kids = []) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === undefined || v === null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of [].concat(kids)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
};

function initials(name) {
  return String(name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

function clockOf(ts) {
  const d = ts ? new Date(ts) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Portrait box: the agent's photo when it loads, the initials over the accent
 * colour as the fallback (the image is removed on error, never a broken icon).
 */
function avatarBox(agentMeta, cls, text) {
  const box = h('div', {
    class: cls,
    style: `background:${agentMeta.accent || '#8b9dc3'}`,
    'aria-hidden': 'true',
  });
  box.append(document.createTextNode(text));
  const url = avatarUrl(agentMeta.id);
  if (url) {
    const img = h('img', { class: 'avImg', src: url, alt: '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', () => img.remove());
    box.append(img);
  }
  return box;
}

/**
 * One row in the log. User messages get a restrained right-aligned surface;
 * agent messages stay unboxed on the panel, with an avatar + name shown only at
 * the start of a run of consecutive agent messages (so a 5-part answer carries
 * one avatar, not five).
 */
function MessageRow(m, { agentMeta, showMeta, time }) {
  const isUser = m.role === 'user';
  const col = h('div', { class: 'msgCol' });
  if (showMeta) {
    col.append(
      h('div', { class: 'msgMeta' }, [
        h('span', { class: 'msgName', text: isUser ? 'Kamu' : agentMeta.name || 'Agent' }),
        time ? h('span', { class: 'msgTime', text: time }) : null,
      ]),
    );
  }
  col.append(h('div', { class: 'msgBody', html: sanitizeMarkdown(m.content || '') }));
  return h('div', { class: `msg ${isUser ? 'user' : 'agent'}` }, [
    !isUser && showMeta ? avatarBox(agentMeta, 'msgAvatar', initials(agentMeta.name)) : null,
    col,
  ]);
}

/**
 * Compact tool card. State is carried by a glyph + word + colour (never colour
 * alone); long output stays collapsed until the owner opens it. Nothing here is
 * inferred — the card only shows what the backend reported.
 */
function ToolCard(card) {
  const meta = toolStateMeta(card.state);
  const long = (card.output || '').length > 240;
  return h(
    'details',
    { class: 'tool', 'data-state': card.state || 'queued', ...(long ? {} : { open: true }) },
    [
      h('summary', { class: 'toolSum' }, [
        h('span', { class: 'toolState', 'data-state': card.state || 'queued', 'data-tone': meta.tone }, [
          h('span', { class: 'toolGlyph', 'aria-hidden': 'true', text: meta.icon }),
          h('span', { class: 'toolLabel', text: meta.label }),
        ]),
        h('span', { class: 'toolName', text: card.name || 'tool' }),
        h('span', { class: 'toolArgs', text: card.args || '' }),
        card.at ? h('span', { class: 'toolAt', text: clockOf(card.at) }) : null,
      ]),
      card.output ? h('pre', { class: 'toolOut', text: card.output }) : null,
    ],
  );
}

/** FR-014 pause: the actual operations + their scope, decided once. */
function ApprovalCard(pending, agentName, cards, onDecide) {
  const calls = pending.calls || [];
  const done = !!pending.decided;
  const byId = new Map((cards || []).map((c) => [c.id, c]));
  const list = h(
    'ul',
    { class: 'approvalList' },
    calls.map((call) => {
      const card = byId.get(call.id);
      const name = call.name || call.function?.name || 'tool';
      return h('li', { class: 'approvalCall' }, [
        h('span', { class: 'approvalName', text: name }),
        card && card.args ? h('span', { class: 'approvalArgs', text: card.args }) : null,
      ]);
    }),
  );
  return h('div', { class: 'approval' }, [
    h('div', { class: 'approvalHead' }, [
      h('span', { class: 'approvalGlyph', 'aria-hidden': 'true', text: '?' }),
      h('h4', { text: `${agentName} minta izin` }),
    ]),
    h('p', {
      text: `${calls.length} aksi menunggu keputusanmu. Approve = jalankan di server; Reject = jangan jalankan.`,
    }),
    list,
    h('div', { class: 'approvalActs' }, [
      h('button', {
        class: 'btn primary',
        type: 'button',
        'data-fk': 'approve',
        disabled: done,
        'aria-label': `Setujui ${calls.length} aksi yang diminta ${agentName}`,
        text: done ? 'Sudah diputuskan' : 'Approve',
        onclick: () => onDecide(true),
      }),
      h('button', {
        class: 'btn',
        type: 'button',
        'data-fk': 'reject',
        disabled: done,
        'aria-label': `Tolak ${calls.length} aksi yang diminta ${agentName}`,
        text: done ? 'Sudah diputuskan' : 'Reject',
        onclick: () => onDecide(false),
      }),
    ]),
    done
      ? h('p', {
          class: 'approvalNote',
          text: pending.decided === 'approved'
            ? 'Disetujui — agent menjalankan di server. Status sebenarnya ada di kartu tool.'
            : 'Ditolak — tool tidak dijalankan.',
        })
      : null,
  ]);
}

const SUGGESTIONS = {
  mia: ['Ringkas pekerjaan hari ini', 'Susun rencana kerja tim', 'Pantau status agent'],
  agnes: ['Riset topik terbaru', 'Bandingkan dua sumber', 'Ringkas hasil riset'],
  michelle: ['Periksa kode yang bermasalah', 'Jelaskan error terakhir', 'Review perubahan terbaru'],
};

const EMPTY_HINT = {
  mia: 'Koordinator tim — susun pekerjaan, ringkas hasil, pantau agent.',
  agnes: 'Peneliti — cari, bandingkan, dan ringkas sumber.',
  michelle: 'Engineer — telusuri kode, jelaskan error, review perubahan.',
};

/** Messages + tool cards in one pass, grouped, chronologically. */
function streamNodes(chat, c, agentMeta) {
  const msgs = visibleMessages(c.messages);
  if (!msgs.length && !c.cards.length) {
    return [
      h('div', { class: 'chatEmpty' }, [
        avatarBox(agentMeta, 'chatEmptyAv', initials(agentMeta.name)),
        h('h4', { text: agentMeta.name || 'Agent' }),
        h('p', { class: 'chatEmptyRole', text: agentMeta.role || 'Agent AI Office' }),
        h('p', { class: 'chatEmptyHint', text: EMPTY_HINT[agentMeta.id] || 'Tulis pesan di bawah — balasan datang dari agent sungguhan.' }),
        h(
          'div',
          { class: 'suggest' },
          (SUGGESTIONS[agentMeta.id] || []).map((q) =>
            h('button', { type: 'button', class: 'suggestBtn', text: q, onclick: () => chat.send(q) }),
          ),
        ),
      ]),
    ];
  }
  const nodes = [];
  let prevRole = null;
  for (const m of msgs) {
    const isUser = m.role === 'user';
    const showMeta = m.role !== prevRole;
    prevRole = m.role;
    nodes.push(
      MessageRow(m, { agentMeta, showMeta, time: c.stamps ? clockOf(c.stamps[m.key]) : '' }),
    );
    void isUser;
  }
  for (const card of c.cards || []) nodes.push(ToolCard(card));
  return nodes;
}

function ChatComposer(chat) {
  const input = h('textarea', {
    class: 'chatInput',
    'data-fk': 'composer',
    id: 'chatInput',
    rows: '1',
    'aria-label': 'Pesan',
    onkeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    },
  });
  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  };
  input.addEventListener('input', autosize);
  const sendBtn = h('button', {
    class: 'btn primary chatSend',
    type: 'submit',
    'data-fk': 'send',
    'aria-label': 'Kirim pesan',
    text: 'Kirim',
  });
  const submit = async () => {
    const text = input.value;
    if (!text.trim() || chat.busy) return;
    // The draft is cleared only when the turn was actually accepted: a failed
    // send keeps what the owner typed so nothing is lost.
    const ok = await chat.send(text);
    if (ok) {
      input.value = '';
      autosize();
    }
    input.focus();
  };
  const form = h('form', { class: 'chatForm', onsubmit: (e) => { e.preventDefault(); submit(); } }, [input, sendBtn]);
  const update = (state, agentMeta) => {
    const name = agentMeta.name || 'agent';
    input.placeholder = `Tulis pesan ke ${name}…`;
    input.setAttribute('aria-label', `Pesan untuk ${name}`);
    const busy = chat.busy;
    sendBtn.disabled = busy;
    sendBtn.textContent = busy ? 'Mengirim…' : 'Kirim';
  };
  queueMicrotask(autosize);
  return { form, input, update };
}

function ChatHeader(chat, state, agentMeta, onClose) {
  const avail = agentAvailability(agentMeta.status);
  const tab = (a, i, agents) =>
    h(
      'button',
      {
        type: 'button',
        role: 'tab',
        class: 'chatTab',
        'data-fk': `tab-${a.id}`,
        'aria-selected': a.id === state.selected ? 'true' : 'false',
        tabindex: a.id === state.selected ? '0' : '-1',
        title: `${a.name} — ${a.role || 'agent'}`,
        onclick: () => chat.select(a.id),
        onkeydown: (e) => {
          const ids = agents.map((x) => x.id);
          let next = -1;
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % ids.length;
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + ids.length) % ids.length;
          else if (e.key === 'Home') next = 0;
          else if (e.key === 'End') next = ids.length - 1;
          if (next >= 0) {
            e.preventDefault();
            chat.select(ids[next]);
            document.querySelector(`[data-fk="tab-${ids[next]}"]`)?.focus();
          }
        },
      },
      [
        h('span', { class: 'chatTabDot', 'data-tone': agentAvailability(a.status).tone, 'aria-hidden': 'true' }),
        h('span', { class: 'chatTabName', text: a.name }),
      ],
    );
  return h('div', { class: 'chatHead' }, [
    h('div', { class: 'chatHeadTop' }, [
      h('div', { class: 'chatWho' }, [
        avatarBox(agentMeta, 'chatAv', initials(agentMeta.name)),
        h('div', { class: 'chatWhoText' }, [
          h('div', { class: 'chatName', text: agentMeta.name || 'Agent' }),
          h('div', { class: 'chatRole', text: agentMeta.role || '' }),
        ]),
        h('span', { class: `chatAvail ${avail.tone}`, role: 'status' }, [
          h('i', { 'aria-hidden': 'true' }),
          h('span', { text: avail.label }),
        ]),
      ]),
      h('button', {
        class: 'iconBtn',
        type: 'button',
        'data-fk': 'close',
        'aria-label': 'Tutup panel chat',
        title: 'Tutup',
        text: '✕',
        onclick: onClose,
      }),
    ]),
    h(
      'div',
      { class: 'chatTabs', role: 'tablist', 'aria-label': 'Pilih agent' },
      state.agents.map((a, i) => tab(a, i, state.agents)),
    ),
  ]);
}

/**
 * The sidebar: header + conversation + composer, built ONCE and updated in place.
 *
 * Every state emission (each bus frame, each message) used to replace the whole
 * subtree, which destroyed the composer textarea — losing the draft and the
 * caret mid-typing — and reset the scroll position on every token. Now each
 * region is rebuilt only when its own content signature changes, so streaming
 * costs nothing but the new nodes.
 */
function ChatSidebar(chat, toggleBtn) {
  const panel = h('section', { id: 'chatPanel', 'aria-label': 'Chat dengan agent AI Office', hidden: true });

  const head = h('div', { class: 'chatHead' });
  const stream = h('div', { class: 'chatStream' });
  const approval = h('div', { class: 'approvalWrap', hidden: true });
  const errBox = h('div', { class: 'chatErr', hidden: true, role: 'alert' });
  const typing = h(
    'div',
    { class: 'msg agent typing', hidden: true },
    [
      h('div', { class: 'msgAvatar typingAvatar', 'aria-hidden': 'true', text: '·' }),
      h('div', { class: 'msgCol' }, [
        h('span', { class: 'dots', 'aria-label': 'Agent sedang bekerja' }, [h('i'), h('i'), h('i')]),
      ]),
    ],
  );
  const log = h('div', { class: 'chatLog', id: 'chatLog', role: 'log', 'aria-live': 'off', 'aria-label': 'Percakapan dengan agent' }, [
    stream,
    approval,
    errBox,
    typing,
  ]);
  const status = h('span', { class: 'chatStatus', role: 'status', 'aria-live': 'polite' });
  const hint = h('span', { class: 'chatHint' });
  const composer = ChatComposer(chat);
  const foot = h('div', { class: 'chatFoot' }, [
    h('div', { class: 'chatFootTop' }, [status, hint]),
    composer.form,
  ]);
  const jump = h('button', {
    class: 'chatJump',
    type: 'button',
    'aria-label': 'Gulir ke pesan terbaru',
    text: '↓ Pesan terbaru',
    onclick: () => {
      log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' });
    },
  });
  // Announcements live outside the log: replacing log children would otherwise
  // re-announce the whole conversation on every frame.
  const live = h('div', { class: 'sr', role: 'status', 'aria-live': 'polite' });
  panel.replaceChildren(head, log, foot, jump, live);

  let headSig = null;
  let streamSig = null;
  let tailSig = null;
  let announced = null;

  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const updateJump = () => {
    jump.classList.toggle('show', !nearBottom() && log.scrollHeight > log.clientHeight + 8);
  };
  log.addEventListener('scroll', updateJump, { passive: true });

  function render(state) {
    const agentMeta = state.agents.find((a) => a.id === state.selected) || FALLBACK_AGENT_META[state.selected];
    const c = state.conv;
    const wasNearBottom = nearBottom();

    const hSig = state.agents.map((a) => `${a.id}:${a.name}:${a.role}:${a.status}`).join('|') + `#${state.selected}`;
    if (hSig !== headSig) {
      const fk = head.contains(document.activeElement) ? document.activeElement?.dataset?.fk : undefined;
      head.replaceChildren(ChatHeader(chat, state, agentMeta, () => setOpen(false)));
      headSig = hSig;
      if (fk) head.querySelector(`[data-fk="${fk}"]`)?.focus();
    }

    const msgs = visibleMessages(c.messages);
    const sSig =
      msgs.map((m) => m.key).join('\u0001') +
      '\u0002' +
      (c.cards || []).map((x) => `${x.id}:${x.state}:${x.at || ''}:${x.output || ''}`).join('\u0001');
    if (sSig !== streamSig) {
      stream.replaceChildren(...streamNodes(chat, c, agentMeta));
      streamSig = sSig;
      const lastAgent = [...msgs].reverse().find((m) => m.role !== 'user');
      if (lastAgent && lastAgent.key !== announced) {
        announced = lastAgent.key;
        live.textContent = `${agentMeta.name || 'Agent'}: ${lastAgent.content.slice(0, 240)}`;
      }
    }

    const showing = !!(c.pending && (c.pending.calls || []).length);
    const tSig = `${showing}|${c.pending?.decided || ''}|${c.error || ''}|${!!c.failed}|${c.messages.length}`;
    if (tSig !== tailSig) {
      const fk = panel.contains(document.activeElement) ? document.activeElement?.dataset?.fk : undefined;
      approval.hidden = !showing;
      if (showing) approval.replaceChildren(ApprovalCard(c.pending, agentMeta.name, c.cards, (allow) => chat.decide(allow)));
      errBox.hidden = !c.error;
      if (c.error) {
        errBox.replaceChildren(
          h('span', { class: 'chatErrText', text: c.error }),
          c.failed ? h('button', { class: 'btn', type: 'button', 'data-fk': 'retry', text: 'Coba lagi', onclick: () => chat.retry() }) : null,
        );
      }
      tailSig = tSig;
      if (fk) panel.querySelector(`[data-fk="${fk}"]`)?.focus();
    }

    // Typing indicator: a persistent node toggled by the turn's real lifecycle,
    // so it never restarts its animation (flicker) nor sticks after an error.
    // `accepted` gates the indicator on the backend's own `start` frame, so it never
    // claims the agent is working before the server has taken the turn.
    const working = !!state.busyForSelected && !!c.live && !!c.accepted && !showing;
    typing.hidden = !working;
    const av = typing.querySelector('.msgAvatar');
    if (av) av.textContent = working ? initials(agentMeta.name) : '·';

    status.setAttribute('data-state', state.connection);
    status.textContent = connectionLabel(state.connection);
    hint.textContent = state.busyForSelected ? 'Agent sedang bekerja…' : 'Enter kirim · Shift+Enter baris baru';
    composer.update(state, agentMeta);

    updateJump();
    if (wasNearBottom && log.scrollHeight > log.clientHeight) log.scrollTo({ top: log.scrollHeight, behavior: 'auto' });
  }

  function setOpen(open) {
    panel.hidden = !open;
    toggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      chat.loadAgents();
      chat.loadHistory();
      queueMicrotask(() => composer.input.focus());
    } else {
      toggleBtn.focus();
    }
  }

  /* On phones the dashboard keeps its own overlays (nav rail + bottom HUD) in
   * body classes; the chat drawer takes the screen, so those are closed while it
   * is open — also when the window shrinks while it is already open, otherwise
   * the rail slides on top of the drawer and covers the composer. */
  const narrow = window.matchMedia('(max-width:820px)');
  const clearDashboardOverlays = () => {
    if (narrow.matches && !panel.hidden) document.body.classList.remove('sbopen', 'hudopen');
  };
  narrow.addEventListener('change', clearDashboardOverlays);

  chat.subscribe(render);
  render(chat.snapshot());
  clearDashboardOverlays();
  return { panel, setOpen, isOpen: () => !panel.hidden };
}

/* ── boot ──────────────────────────────────────────────────────────── */

function boot() {
  const app = document.getElementById('app');
  const header = document.querySelector('main header');
  if (!app || !header) return;

  const chat = createChat();
  const toggleBtn = h('button', {
    class: 'btn vb',
    id: 'chatToggle',
    type: 'button',
    'aria-expanded': 'false',
    'aria-controls': 'chatPanel',
    title: 'Chat dengan agent',
    'aria-label': 'Buka panel chat dengan agent',
    text: 'Chat',
    onclick: () => sidebar.setOpen(sidebar.panel.hidden),
  });
  const grp = header.querySelector('.grp');
  (grp || header).append(toggleBtn);

  const sidebar = ChatSidebar(chat, toggleBtn);
  app.append(sidebar.panel);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !sidebar.panel.hidden) sidebar.setOpen(false);
  });
  window.addEventListener('pagehide', () => chat.disconnect());
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();