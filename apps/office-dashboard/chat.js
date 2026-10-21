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
  visibleMessages, cardsForCallIds, unclaimedCards, isInternalNote, declinedNoteText, mergeStamps,
  dateTimeLabel, agentAvailability,
  taskStateFor, toolStateMeta, humanError, humanGenerationError,
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
    // Send times, aligned with `messages` by index. A null = unknown time.
    frames: [], stamps: [], accepted: false,
    // True while the history is still being fetched. Sending before it lands
    // would POST a one-message conversation and REPLACE the stored history —
    // a silent wipe of everything the owner had.
    loading: false,
  });
  const conv = (id) => {
    if (!convs[id]) {
      convs[id] = blankConv();
      convs[id].agent = id;
    }
    return convs[id];
  };
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
    /* The panel renders from the chat snapshot, so a status that arrived
       without an emit() would sit on screen as "tidak diketahui" until the
       next chat event — which, on an idle panel, is never. */
    emit();
  }

  async function loadHistory(agent = selected) {
    const c = conv(agent);
    c.loading = true;
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
      // The send time is a property of the message, not of the page. The
      // server hands back the real times it persisted; the browser's local
      // copy fills any gap (older sessions were stored before times existed).
      // A message with no known time shows NO time — never "now".
      c.stamps = mergeStamps(data.stamps, (c.messages || []).length);
      // The app's real timezone config, from the server.
      c.tz = typeof data.tz === 'string' ? data.tz : 'Asia/Jakarta';
      c.tzLabel = typeof data.tz_label === 'string' ? data.tz_label : '';
      connection = 'open';
      c.loading = false;
    } catch (err) {
      connection = 'error';
      c.error = `Riwayat tidak bisa dimuat: ${humanError(err)}`;
      c.loading = false;
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
    if (c.loading) {
      // The history is still on its way. Sending now would replace the stored
      // conversation with a one-message one — the owner's history, gone.
      c.error = 'Riwayat percakapan masih dimuat — tunggu sebentar lalu kirim lagi.';
      emit();
      return false;
    }
    busyAgent = agent;
    connection = 'connecting';
    c.error = null;
    c.retryText = '';
    c.failed = false;
    c.live = true;
    c.frames = [];
    if (!Array.isArray(c.stamps)) c.stamps = [];
    // Optimistic bubble with a stable local id; replaced by server truth when
    // the stream returns `messages`.
    const outgoing = [...c.messages, { role: 'user', content: body }];
    c.messages = outgoing;
    // Only the message sent NOW gets a timestamp. The history keeps the times
    // it already had — stamping everything again is what made a reload change
    // every time in the conversation to the reload time.
    c.stamps = mergeStamps(c.stamps, outgoing.length - 1).concat([Date.now()]);
    emit();
    abort = new AbortController();
    await stream({ agent, messages: outgoing, stamps: c.stamps }, abort.signal);
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
      // The stamps array is aligned with the messages — drop the same tail.
      if (Array.isArray(c.stamps)) c.stamps = c.stamps.slice(0, i);
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

  /**
   * The server sends the send time of every message it persisted; the browser
   * keeps a local copy for the ones the server could not date. Nothing is
   * invented here: an unknown time stays unknown.
   */
  function applyStamps(c, agent, frame) {
    const len = (c.messages || []).length;
    c.stamps = mergeStamps(frame && frame.stamps, len);
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
      applyStamps(c, c.agent, frame);
    } else if (frame.type === 'message') {
      c.messages = frame.messages || c.messages;
      c.cards = frame.cards || c.cards;
      c.pending = null;
      c.failed = false;
      c.live = false;
      applyStamps(c, c.agent, frame);
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

/**
 * The time, in the app's configured timezone: "20 Okt 2026, 14.45 WIB".
 * The zone AND its label come from the server (`tz` / `tz_label`), so a
 * non-Jakarta deployment shows its own zone — "WIB" is never hardcoded.
 * A missing/invalid time renders NOTHING (a date is never invented).
 */
function clockOf(ts, zone, label) {
  return dateTimeLabel(ts, zone, label);
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
  /* A backend nudge ("[email-gate] …") is not the owner speaking. It gets a
     quiet note, never the beige user bubble — otherwise a long internal
     message fills the panel and looks like something the owner said. */
  if (m.internal) {
    return h('div', { class: 'msgNote' }, [
      h('span', { class: 'msgNoteText', html: sanitizeMarkdown(m.content) }),
    ]);
  }
  const isUser = m.role === 'user';
  /* An assistant turn with no text is a turn that only PROPOSES tool calls.
     An empty bubble is a hole in the conversation; one honest line says what
     happened and the tool card below carries the details. */
  if (m.role === 'assistant' && !m.content) {
    const n = Array.isArray(m.callIds) ? m.callIds.length : 0;
    return h('div', { class: 'msg agent proposal' }, [
      !isUser && showMeta ? avatarBox(agentMeta, 'msgAvatar', initials(agentMeta.name)) : null,
      h('div', { class: 'msgCol' }, [
        h('div', { class: 'msgProposal', text: n > 1 ? `Mengusulkan ${n} tindakan` : 'Mengusulkan tindakan' }),
      ]),
    ]);
  }
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
function ToolCard(card, zone, zoneLabel) {
  const meta = toolStateMeta(card.state);
  const state = card.state || 'unknown';
  /* The card header states the OUTCOME; the raw output is diagnostics and
     lives in its own disclosure, so a model-facing placeholder can never
     read as a user-facing status. A card that is still open (queued, running,
     awaiting approval) or that failed opens itself — those need attention.
     A finished card stays closed. */
  /* An inbox result IS the answer, so that card opens itself. A finished
     operation with no list stays closed — its raw output is diagnostics. */
  const open = state === 'queued' || state === 'running' || state === 'awaiting_approval'
    || state === 'failed' || state === 'timed_out' || !!card.inbox;
  const summary = card.summary || meta.label;
  return h(
    'details',
    { class: 'tool', 'data-state': state, ...(open ? { open: true } : {}) },
    [
      h('summary', { class: 'toolSum' }, [
        h('span', { class: 'toolState', 'data-state': state, 'data-tone': meta.tone }, [
          h('span', { class: 'toolGlyph', 'aria-hidden': 'true', text: meta.icon }),
          h('span', { class: 'toolLabel', text: summary }),
        ]),
        h('span', { class: 'toolName', text: card.name || 'tool' }),
        h('span', { class: 'toolArgs', text: card.args || '' }),
        card.at ? h('span', { class: 'toolAt', text: clockOf(card.at, zone, zoneLabel) }) : null,
      ]),
      card.result ? h('p', { class: 'toolResult', text: card.result }) : null,
      /* An inbox result renders as a REAL list — subject, sender display
         name, converted time, short snippet. No bodies, no full addresses:
         the provider text stays behind "Detail teknis". */
      card.inbox
        ? h('div', { class: 'inbox' }, [
            h('div', {
              class: 'inboxHead',
              text: `📬 Ringkasan Inbox — ${card.inbox.count} email terbaru`
                + (card.inbox.range ? ` · ${card.inbox.range}` : ''),
            }),
            h('ul', { class: 'inboxList' }, (card.inbox.emails || []).map((e) =>
              h('li', { class: 'inboxItem' }, [
                h('div', { class: 'inboxSubject', text: e.subject || '(tanpa judul)' }),
                h('div', { class: 'inboxMeta' }, [
                  e.from ? h('span', { class: 'inboxFrom', text: e.from }) : null,
                  e.at ? h('span', { class: 'inboxAt', text: e.at }) : null,
                ]),
                e.snippet ? h('div', { class: 'inboxSnippet', text: e.snippet }) : null,
              ]),
            )),
          ])
        : null,
      card.detail
        ? h('details', { class: 'toolDiag' }, [
            h('summary', { class: 'toolDiagHead', text: 'Detail teknis' }),
            h('pre', { class: 'toolOut', text: card.detail }),
          ])
        : null,
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
    /* No identity block: the header already shows name + role. The empty
       state starts the conversation instead of repeating the profile. */
    return [
      h('div', { class: 'chatEmpty' }, [
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
  let declineNote = null;
  for (const m of msgs) {
    const showMeta = m.role !== prevRole;
    prevRole = m.role;
    nodes.push(
      MessageRow(m, {
        agentMeta,
        showMeta,
        time: clockOf(Array.isArray(c.stamps) ? c.stamps[m.index] : null, c.tz, c.tzLabel),
      }),
    );
    /* A pending correction belongs AFTER the reply it corrects. */
    if (declineNote) {
      nodes.push(declineNote);
      declineNote = null;
    }
    /* The cards a turn owns render directly under it. Appending every card
       at the end of the conversation made an old tool result look like the
       outcome of the newest reply. */
    const owned = cardsForCallIds(c.cards, m.callIds);
    for (const card of owned) nodes.push(ToolCard(card, c.tz, c.tzLabel));
    /* A declined call is the one case where the agent's own words can say
       the opposite of what happened ("udah aku simpan" for a tool the owner
       just rejected). The truth is stated AFTER that reply, so the last
       thing on screen is the fact and not the claim. */
    const declinedText = declinedNoteText(owned);
    if (declinedText) {
      declineNote = h('div', { class: 'msgNote warn' }, [
        h('span', { class: 'msgNoteText', text: declinedText }),
      ]);
    }
  }
  /* Cards no turn claims yet: a live turn whose assistant message has not
     arrived. They are real, so they are shown — at the end, where the turn
     being read actually is. */
  for (const card of unclaimedCards(c.cards, msgs)) nodes.push(ToolCard(card, c.tz, c.tzLabel));
  /* The turn ended on the proposal itself — the correction still has to be
     shown, otherwise the decline would be visible only as a card. */
  if (declineNote) nodes.push(declineNote);
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
  const task = taskStateFor(state.conv);
  return h('div', { class: 'chatHead' }, [
    h('div', { class: 'chatHeadTop' }, [
      h('div', { class: 'chatWho' }, [
        avatarBox(agentMeta, 'chatAv', initials(agentMeta.name)),
        h('div', { class: 'chatWhoText' }, [
          h('div', { class: 'chatName', text: agentMeta.name || 'Agent' }),
          h('div', {
            class: 'chatRole',
            text: agentMeta.role || '',
            // The full role for a truncated one.
            title: agentMeta.role || '',
          }),
          h('div', { class: 'chatStates' }, [
            h('span', { class: `chatAvail ${avail.tone}`, role: 'status' }, [
              h('i', { 'aria-hidden': 'true' }),
              h('span', { text: avail.label }),
            ]),
            h('span', {
              class: `chatTask ${task.tone}`,
              role: 'status',
              'data-fk': 'taskstate',
              text: task.tone === 'idle' ? '' : task.label,
            }),
          ]),
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
      h('div', { class: 'msgCol typingCol' }, [
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
  // The jump button belongs INSIDE the scroll region: as a panel sibling it
  // was absolutely positioned over the conversation and covered the tool card
  // it was meant to help the user reach. Sticky at the bottom of the log, it
  // stays in the region and the log reserves a band for it.
  const jump = h('button', {
    class: 'chatJump',
    type: 'button',
    'aria-label': 'Gulir ke pesan terbaru',
    text: '↓ Terbaru',
    onclick: () => {
      unseen = false;
      log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' });
    },
  });
  log.appendChild(jump);
  // Announcements live outside the log: replacing log children would otherwise
  // re-announce the whole conversation on every frame.
  const live = h('div', { class: 'sr', role: 'status', 'aria-live': 'polite' });
  /* The visible surface is a wrapper: the panel is the layout column, the
     wrapper is what the eye sees — and what the open/close motion plays on. */
  const inner = h('div', { class: 'chatInner' });
  inner.replaceChildren(head, log, foot, live);
  panel.replaceChildren(inner);

  let headSig = null;
  let streamSig = null;
  let tailSig = null;
  let announced = null;

  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  /* The jump button is a "there is something new below" affordance, not a
     permanent overlay: it appears only when NEW messages arrive while the
     reader is up in the history, and disappears as soon as they are back at
     the bottom. That keeps it from sitting on top of the conversation. */
  let unseen = false;
  let lastCount = 0;
  const updateJump = () => {
    if (nearBottom()) unseen = false;
    jump.classList.toggle('show', unseen && !nearBottom() && log.scrollHeight > log.clientHeight + 8);
  };
  log.addEventListener('scroll', updateJump, { passive: true });

  function render(state) {
    const agentMeta = state.agents.find((a) => a.id === state.selected) || FALLBACK_AGENT_META[state.selected];
    const c = state.conv;
    const wasNearBottom = nearBottom();
    const count = (c.messages || []).length;
    if (count > lastCount && !wasNearBottom) unseen = true;
    lastCount = count;

    const hSig = state.agents.map((a) => `${a.id}:${a.name}:${a.role}:${a.status}`).join('|') + `#${state.selected}`;
    if (hSig !== headSig) {
      const fk = head.contains(document.activeElement) ? document.activeElement?.dataset?.fk : undefined;
      head.replaceChildren(ChatHeader(chat, state, agentMeta, () => setOpen(false)));
      headSig = hSig;
      if (fk) head.querySelector(`[data-fk="${fk}"]`)?.focus();
    }
    /* Task state updates in place: rebuilding the head on every turn would
       steal focus from the agent tabs. */
    const task = taskStateFor(c);
    const taskEl = head.querySelector('[data-fk="taskstate"]');
    /* Idle means "no turn right now" — say nothing rather than "nothing". */
    const taskLabel = task.tone === 'idle' ? '' : task.label;
    if (taskEl && taskEl.textContent !== taskLabel) {
      taskEl.textContent = taskLabel;
      taskEl.className = `chatTask ${task.tone}`;
    }

    const msgs = visibleMessages(c.messages);
    const sSig =
      msgs.map((m) => m.key).join('\u0001') +
      '\u0002' +
      (c.cards || []).map((x) => `${x.id}:${x.state}:${x.at || ''}:${x.summary || ''}:${x.result || ''}`).join('\u0001');
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

  /* A close in flight: the sheet slides away, then the panel is really
     hidden. Re-opening cancels it, so a fast toggle never hides a panel that
     the owner just opened again. */
  let closing = null;
  function cancelClose() {
    if (!closing) return;
    clearTimeout(closing.timer);
    inner.removeEventListener('transitionend', closing.done);
    closing = null;
  }
  /* The chat moves like the rail does: the column widens or narrows while the
     sheet slides in from the right edge. `animate:false` is for the first
     paint, where there is nothing to slide from. */
  function setOpen(open, opts) {
    const animate = !opts || opts.animate !== false;
    toggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      cancelClose();
      panel.classList.remove('closing');
      panel.hidden = false;
      /* The sheet waits off the right edge and slides in, the way the nav
         rail slides in from the left. The column starts collapsed so the
         canvas reflows with the sheet instead of jumping. */
      panel.classList.remove('open');
      panel.style.flexBasis = '0px';
      panel.style.width = '0px';
      requestAnimationFrame(() => requestAnimationFrame(() => {
        panel.style.flexBasis = '';
        panel.style.width = '';
        panel.classList.add('open');
      }));
      chat.loadAgents();
      chat.loadHistory();
      queueMicrotask(() => composer.input.focus());
    } else {
      toggleBtn.focus();
      cancelClose();
      panel.classList.remove('open');
      if (!animate) {
        panel.hidden = true;
        panel.classList.remove('closing');
        return;
      }
      panel.classList.add('closing');
      /* The anchor collapses at once: its box is 0x0, so the panel stops
         catching the pointer while the sheet slides out over the canvas.
         visibility:hidden is not used here on purpose - it cancels the
         transitions of everything inside it. */
      panel.style.flexBasis = '0px';
      panel.style.width = '0px';
      panel.style.height = '0px';
      const finish = () => {
        cancelClose();
        panel.hidden = true;
        panel.classList.remove('closing');
        panel.style.flexBasis = '';
        panel.style.width = '';
        panel.style.height = '';
      };
      const done = (ev) => {
        if (ev && ev.target !== inner) return;
        finish();
      };
      const timer = setTimeout(finish, 400);
      closing = { timer, done };
      inner.addEventListener('transitionend', done);
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
  /* Wide screens start with the chat open (it is a daily surface, and the
     office keeps enough room beside it); below ~1200 px it starts closed,
     because a docked chat next to the 248 px rail leaves the header and the
     view title nothing. The Chat button toggles either way — `hidden` now
     really hides the panel. */
  const wide = window.matchMedia('(min-width:1201px)');
  sidebar.setOpen(wide.matches, { animate: false });
  wide.addEventListener('change', (e) => sidebar.setOpen(e.matches));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !sidebar.panel.hidden) sidebar.setOpen(false);
  });
  window.addEventListener('pagehide', () => chat.disconnect());
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();