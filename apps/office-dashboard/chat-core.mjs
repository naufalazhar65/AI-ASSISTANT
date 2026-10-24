/**
 * Office chat sidebar — pure front-end core (no DOM, no network).
 *
 * Lives in its own module so it can be unit-tested with `node --test`
 * (the dashboard has no build step / test runner of its own) and imported by
 * chat.js as a plain ES module.
 *
 * SECURITY: `sanitizeMarkdown` escapes everything first and only then adds a
 * fixed set of tags, so model text can never inject markup or scripts. Links
 * are limited to http(s) — no `javascript:` / `data:` URLs.
 */

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

function safeUrl(url) {
  const raw = String(url ?? '').trim();
  // Escaped form matters because we match links AFTER escaping the text.
  const probe = raw.replace(/&amp;/g, '&').toLowerCase();
  if (!/^https?:\/\/[^\s"'<>]+$/.test(probe)) return null;
  return escapeHtml(raw);
}

/**
 * Minimal, safe markdown → HTML: fenced code, lists, inline code, bold, italic
 * and http(s) links. Everything else stays escaped text.
 */
export function sanitizeMarkdown(text) {
  const src = String(text ?? '');
  if (!src) return '';
  const blocks = [];
  // Fenced code first; its body must not be touched by inline rules.
  let rest = src.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_m, lang, body) => {
    const cls = lang ? ` class="lang-${escapeHtml(String(lang).slice(0, 16))}"` : '';
    blocks.push(`<pre class="mCode"${cls}><code>${escapeHtml(String(body).replace(/\n$/, ''))}</code></pre>`);
    return `\u0000BLOCK${blocks.length - 1}\u0000`;
  });

  rest = escapeHtml(rest)
    .replace(/`([^`\n]+)`/g, '<code class="mInline">$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    // Link URL cap is generous on purpose: Google News RSS links are 500–900
    // chars and a 300-char cap silently left every news item as raw
    // `[title](url)` markdown (measured 2026-10-19). `safeUrl` is the real
    // gate — scheme-validated, not length-validated.
    .replace(/\[([^\]\n]{1,200})\]\(([^)\s]{1,2000})\)/g, (m, label, href) => {
      const url = safeUrl(href);
      return url ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
    });

  const html = rest
    .split(/\n{2,}/)
    .map(blockHtml)
    .join('')
    .replace(/\u0000BLOCK(\d+)\u0000/g, (_m, i) => blocks[Number(i)] ?? '');
  return html;
}

const BULLET_RE = /^\s*(?:[-*•·])\s+(.*)$/;
const ORDERED_RE = /^\s*\d+[.)]\s+(.*)$/;

/**
 * One blank-line-separated chunk → a paragraph, or a real <ul>/<ol> when every
 * non-empty line carries the same marker. Agent replies are list-heavy (news
 * digests, findings, step lists); without this they rendered as one run of
 * `• …` lines with a `<br>` between each, which read as a wall of text.
 */
function blockHtml(block) {
  if (/^\u0000BLOCK\d+\u0000$/.test(block.trim())) return block; // fenced code placeholder
  const lines = block.split('\n').filter((l) => l.trim() !== '');
  if (!lines.length) return '';
  // A lead line ("6 hasil") followed by the items is the common shape of an
  // agent answer: the lead stays a paragraph, the items become the list.
  const start = lines.findIndex((l) => ORDERED_RE.test(l) || BULLET_RE.test(l));
  if (start >= 0) {
    const head = lines.slice(0, start);
    const body = lines.slice(start);
    const ordered = body.map((l) => ORDERED_RE.exec(l));
    const bulleted = body.map((l) => BULLET_RE.exec(l));
    const lead = head.length ? `<p>${head.join('<br>')}</p>` : '';
    if (ordered.every(Boolean)) {
      return `${lead}<ol>${ordered.map((m) => `<li>${m[1]}</li>`).join('')}</ol>`;
    }
    if (bulleted.every(Boolean)) {
      return `${lead}<ul>${bulleted.map((m) => `<li>${m[1]}</li>`).join('')}</ul>`;
    }
  }
  return `<p>${block.replace(/\n/g, '<br>')}</p>`;
}

/** Parse one NDJSON line; null when empty or unparsable. */
export function parseNdjsonLine(line) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed) return null;
  try {
    const v = JSON.parse(trimmed);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Fold a live bus event into the tool cards. ONLY states the backend reports:
 * `tool_called` carries `ok` (emitted after execution), `task_cancelled`
 * carries the declined tool name. No invented "running" state.
 */
export function applyBusEvent(cards, ev) {
  if (!Array.isArray(cards) || !ev || typeof ev !== 'object') return cards;
  const list = cards.slice();
  const data = (ev.data && typeof ev.data === 'object') ? ev.data : {};
  const name = data.name;
  const callId = data.call_id ? String(data.call_id) : '';
  const isTerminal = (s) => s === 'succeeded' || s === 'failed' || s === 'cancelled' || s === 'timed_out';
  /* Exact match first: the bus carries the provider's tool_call id, so only
     the event that really owns a card may change it. The name fallback is
     for older events that predate call_id — and it only ever touches a card
     that is still open, so an old turn can never be rewritten. */
  const byId = (id) => list.findIndex((c) => c && String(c.id) === id);
  const byName = () => {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const c = list[i];
      if (c && c.name === name && !isTerminal(c.state)) return i;
    }
    return -1;
  };
  const target = () => (callId ? byId(callId) : byName());
  if (ev.type === 'tool_started') {
    if (!callId && !name) return list;
    const i = target();
    if (i >= 0) list[i] = { ...list[i], state: 'running', summary: 'Sedang berjalan', at: ev.ts };
    return list;
  }
  if (ev.type === 'tool_called') {
    if (!callId && !name) return list;
    const i = target();
    if (i >= 0) {
      const ok = data.ok !== false;
      list[i] = {
        ...list[i],
        state: ok ? 'succeeded' : 'failed',
        summary: ok ? 'Selesai' : 'Gagal',
        result: String(ev.summary || '').slice(0, 200),
        at: ev.ts,
      };
    }
    return list;
  }
  if (ev.type === 'task_cancelled') {
    if (!callId && !name) return list;
    const i = target();
    /* A cancel never overwrites a real outcome: if the tool already produced
       a result, that result is the truth. */
    if (i >= 0 && !isTerminal(list[i].state)) {
      list[i] = { ...list[i], state: 'cancelled', summary: 'Dibatalkan', result: undefined, at: ev.ts };
    }
    return list;
  }
  return list;
}

/** A turn is "working" while the backend says so (task_created/started, no end). */
export function turnIsLive(frames) {
  const seen = frames || [];
  if (!seen.length) return false;
  const last = seen[seen.length - 1];
  return (
    last.type === 'task_created' ||
    last.type === 'task_started' ||
    last.type === 'tool_started' ||
    last.type === 'tool_called'
  );
}

/**
 * Messages the log actually renders, each with a stable key.
 *
 * Server messages carry no id/timestamp (the persisted `ChatMessage` has only
 * role/content/tool_calls), so the key is derived from position + role + a
 * content prefix — enough to tell "this is the same message" from "this is a new
 * one" while the stream appends, which is all the renderer needs to avoid
 * re-rendering the conversation on every token.
 */
/**
 * Internal notes the backend pushes INTO the conversation as `role: "user"`
 * (the email/probe gates nudge the model, and the rolling summary carries
 * "[Percakapan sebelumnya — …]"). They are NOT something the owner said, so
 * they must never render as a user bubble.
 */
const INTERNAL_NOTE_RE =
  /^\[(?:probe-gate|email-gate|percakapan sebelumnya|self-correct|superseded|automation|system)\b/i;

export function isInternalNote(text) {
  return INTERNAL_NOTE_RE.test(String(text ?? '').trim());
}

export function visibleMessages(messages) {
  const out = [];
  (Array.isArray(messages) ? messages : []).forEach((m, i) => {
    if (!m || typeof m !== 'object' || m.role === 'tool') return;
    const content = String(m.content ?? '');
    /* An assistant turn that ONLY proposes tool calls carries no text.
       Dropping it used to leave its cards with no anchor, so they floated to
       the end of the conversation and rendered under an unrelated later
       message. Keep the turn and expose the call ids it owns. */
    const callIds = Array.isArray(m.tool_calls)
      ? m.tool_calls.map((c) => (c && c.id ? String(c.id) : '')).filter(Boolean)
      : [];
    if (m.role === 'assistant' && !content && !callIds.length) return;
    out.push({
      key: `${i}|${m.role}|${content.slice(0, 48)}`,
      // Index into the FULL message list — the stamp array is aligned with it,
      // so a message can be dated without guessing from its text.
      index: i,
      role: m.role,
      content,
      callIds,
      internal: m.role === 'user' && isInternalNote(content),
    });
  });
  return out;
}

/**
 * Normalise send times to one array aligned with the message list. A message
 * whose time is genuinely unknown stays null — it is never filled with "now".
 * The server is the ONLY source: a local copy is indexed by position, and a
 * history that changed shape would move a time onto the wrong message.
 */
export function mergeStamps(server, len) {
  const out = new Array(Math.max(0, len)).fill(null);
  for (let i = 0; i < out.length; i += 1) {
    const s = server && server[i];
    out[i] = typeof s === 'number' && Number.isFinite(s) ? s : null;
  }
  return out;
}

/**
 * "20 Okt 2026, 14.45 WIB" — the app's configured timezone, built from
 * formatToParts so the output is identical on every ICU build. A missing or
 * unparseable date yields "" — a date is never invented.
 *
 * The zone AND its label come from the SERVER (`/api/office/chat` returns
 * `tz` / `tz_label`), so the browser never hardcodes "WIB".
 */
export function dateTimeLabel(at, zone, label) {
  if (at === null || at === undefined || at === '') return '';
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  try {
    const parts = new Intl.DateTimeFormat('id-ID', {
      timeZone: zone || 'Asia/Jakarta',
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
    const get = (t) => {
      const p = parts.find((x) => x.type === t);
      return p ? p.value : '';
    };
    const day = get('day');
    const month = get('month');
    const year = get('year');
    const hour = get('hour') === '24' ? '00' : get('hour');
    const minute = get('minute');
    if (!day || !month || !year || !hour || !minute) return '';
    const lbl = label ? String(label) : '';
    return `${day} ${month} ${year}, ${hour}.${minute}${lbl ? ' ' + lbl : ''}`;
  } catch {
    return '';
  }
}

/**
 * "11.55" — the time ALONE.
 *
 * The chat shows the date only when the day changes (a WhatsApp-style
 * separator), so a per-message stamp carries no date. The zone comes from the
 * SERVER (`tz`), so a non-Jakarta deployment shows its own clock; a
 * missing/invalid time yields "" — a time is never invented.
 */
export function timeOnly(at, zone) {
  if (at === null || at === undefined || at === '') return '';
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  try {
    const parts = new Intl.DateTimeFormat('id-ID', {
      timeZone: zone || 'Asia/Jakarta',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
    const get = (t) => {
      const p = parts.find((x) => x.type === t);
      return p ? p.value : '';
    };
    const hour = get('hour') === '24' ? '00' : get('hour');
    const minute = get('minute');
    if (!hour || !minute) return '';
    return `${hour}.${minute}`;
  } catch {
    return '';
  }
}

/**
 * "2026-10-22" — the calendar day in the app's timezone. Two stamps belong to
 * the same conversation day when their keys match, so the day separator is
 * decided by the SERVER's clock, not by the browser's.
 */
export function dayKey(at, zone) {
  if (at === null || at === undefined || at === '') return '';
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone || 'Asia/Jakarta',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(d);
    const get = (t) => {
      const p = parts.find((x) => x.type === t);
      return p ? p.value : '';
    };
    const year = get('year');
    const month = get('month');
    const day = get('day');
    if (!year || !month || !day) return '';
    return `${year}-${month}-${day}`;
  } catch {
    return '';
  }
}

/** "22 Okt 2026" — the label of the day separator. */
export function dayLabel(at, zone) {
  if (at === null || at === undefined || at === '') return '';
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  try {
    const parts = new Intl.DateTimeFormat('id-ID', {
      timeZone: zone || 'Asia/Jakarta',
      day: 'numeric', month: 'short', year: 'numeric',
    }).formatToParts(d);
    const get = (t) => {
      const p = parts.find((x) => x.type === t);
      return p ? p.value : '';
    };
    const day = get('day');
    const month = get('month');
    const year = get('year');
    if (!day || !month || !year) return '';
    return `${day} ${month} ${year}`;
  } catch {
    return '';
  }
}

/**
 * The keys of the rows that arrived AFTER the previous render.
 *
 * The log is rebuilt from scratch on every change, so "new" cannot be read
 * from the DOM — it is the rows whose index is beyond the message count the
 * last render saw.
 *
 * `seenCount` is that count. `null`/`undefined` means "this conversation was
 * never rendered before" (a history that just loaded): nothing is new, so a
 * loaded history never animates. A count of 0 means the panel was empty, so
 * the first arriving message IS new.
 */
export function freshMessageKeys(seenCount, rows) {
  const out = new Set();
  if (seenCount === null || seenCount === undefined) return out;
  const from = Number.isFinite(seenCount) && seenCount > 0 ? seenCount : 0;
  (Array.isArray(rows) ? rows : []).forEach((r) => {
    if (!r || typeof r !== 'object') return;
    const idx = Number.isFinite(r.index) ? r.index : -1;
    if (idx >= from && r.key) out.add(r.key);
  });
  return out;
}

/**
 * Cards a given assistant turn owns. The card id IS the provider's
 * tool_call id, so this is an exact join — never a name match.
 */
export function cardsForCallIds(cards, callIds) {
  const want = new Set((Array.isArray(callIds) ? callIds : []).map(String));
  if (!want.size) return [];
  return (Array.isArray(cards) ? cards : []).filter((c) => c && want.has(String(c.id)));
}

/**
 * Cards no visible turn claims — typically a live turn whose assistant
 * message has not arrived yet. They are rendered last, but they are still
 * real: they belong to the turn in flight.
 */
export function unclaimedCards(cards, msgs) {
  const claimed = new Set();
  (Array.isArray(msgs) ? msgs : []).forEach((m) => {
    (m && Array.isArray(m.callIds) ? m.callIds : []).forEach((id) => claimed.add(String(id)));
  });
  return (Array.isArray(cards) ? cards : []).filter((c) => c && !claimed.has(String(c.id)));
}

/**
 * Availability straight from the backend `status` field.
 * Unknown values stay unknown — a displayed name never implies availability.
 */
export function agentAvailability(status) {
  switch (status) {
    case 'idle':
      return { tone: 'on', label: 'Siap' };
    case 'working':
      return { tone: 'busy', label: 'Bekerja' };
    case 'paused':
      return { tone: 'off', label: 'Jeda' };
    default:
      return { tone: 'unknown', label: 'Status tidak diketahui' };
  }
}

/**
 * Tool lifecycle → label + glyph + tone. The glyph and the word both carry the
 * state, so colour is never the only signal.
 */
export function toolStateMeta(state) {
  const map = {
    queued: { label: 'Menunggu dijalankan', icon: '·', tone: 'pending' },
    running: { label: 'Sedang berjalan', icon: '↻', tone: 'warn' },
    awaiting_approval: { label: 'Menunggu persetujuanmu', icon: '?', tone: 'warn' },
    succeeded: { label: 'Selesai', icon: '✓', tone: 'ok' },
    failed: { label: 'Gagal', icon: '!', tone: 'bad' },
    cancelled: { label: 'Dibatalkan', icon: '×', tone: 'muted' },
    timed_out: { label: 'Berhenti — timeout', icon: '⏱', tone: 'bad' },
    unknown: { label: 'Status akhir tidak diketahui', icon: '?', tone: 'muted' },
  };
  return map[state] || { label: 'Status akhir tidak diketahui', icon: '?', tone: 'muted' };
}

/**
 * The correction line for a turn whose tool call was DECLINED. The agent's
 * own words can claim the action happened ("udah aku simpan") right after
 * the owner rejected it, so the interface states the fact next to the claim.
 * Returns null when nothing was declined — no note, no noise.
 */
export function declinedNoteText(cards) {
  const names = (Array.isArray(cards) ? cards : [])
    .filter((c) => c && c.state === 'cancelled')
    .map((c) => c.name)
    .filter(Boolean);
  if (!names.length) return null;
  return `${[...new Set(names)].join(', ')} tidak dijalankan — aksi itu dibatalkan.`;
}

/**
 * The TASK state of the selected agent — a different fact from the agent's
 * backend availability. An agent can be "Siap" (idle) while a tool it
 * started is still running, so both are shown side by side instead of one
 * being derived from the other.
 */
export function taskStateFor(conv) {
  const c = conv || {};
  if (c.pending && !c.pending.decided) {
    const n = Array.isArray(c.pending.calls) ? c.pending.calls.length : 0;
    return { label: n > 1 ? `Menunggu ${n} persetujuan` : 'Menunggu persetujuanmu', tone: 'warn' };
  }
  const cards = Array.isArray(c.cards) ? c.cards : [];
  const running = cards.find((x) => x && x.state === 'running');
  if (running) return { label: `Menjalankan ${running.name}`, tone: 'busy' };
  if (c.live) return { label: 'Sedang memproses', tone: 'busy' };
  if (c.failed) return { label: 'Giliran terakhir gagal', tone: 'bad' };
  return { label: 'Tidak ada giliran aktif', tone: 'idle' };
}

/**
 * Transport errors must read like a person wrote them: the chat never shows raw
 * browser/API metadata ("TypeError: Failed to fetch", `HTTP 500 <html>…`).
 */
export function humanError(err) {
  const raw = String((err && err.message) || err || '').trim();
  if (/failed to fetch|networkerror|load failed/i.test(raw)) return 'koneksi ke server agent terputus';
  if (/abort/i.test(raw)) return 'permintaan dibatalkan';
  const http = raw.match(/^HTTP\s+(\d{3})/);
  if (http) {
    return http[1] === '401' || http[1] === '403' ? 'kamu tidak punya akses ke sesi ini' : `server menjawab ${http[1]}`;
  }
  return raw.replace(/[{}\[\]"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140) || 'alasan tidak dilaporkan';
}

/**
 * Generation failures come from the model gateway and can carry raw provider
 * payloads (`LLM failed (400): {"error":{"message":"[gemini/…`). The owner gets
 * one plain sentence with the status code; the payload stays in the server log.
 */
export function humanGenerationError(message) {
  const raw = String(message || '').trim();
  if (!raw) return 'alasan tidak dilaporkan';
  /* The upstream gateway's transient function-call-shape 400. Say what it
     actually is instead of "model tidak menjawab" — and that retrying is the
     right move, because the same request usually passes right after. */
  if (/function call turn comes immediately after/i.test(raw)) {
    return 'provider menolak permintaan ini (400) — gangguan sesaat di sisi model. Coba lagi ya.';
  }
  const code = raw.match(/\b(4\d{2}|5\d{2})\b/);
  const kind = /rate|quota|limit/i.test(raw)
    ? 'batas pemakaian model tercapai'
    : /LLM failed|gateway|upstream|model/i.test(raw)
      ? 'model tidak menjawab'
      : '';
  if (kind) return code ? `${kind} (${code[1]})` : kind;
  return raw.replace(/[{}\[\]"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140) || 'alasan tidak dilaporkan';
}

/**
 * Portrait URL for a trio member. The dashboard serves them from
 * `/avatars/<id>.webp` (proxied server-side to Mia's `public/` folder), so the
 * browser never learns the backend origin. Only the three registered ids are
 * allowed — the value ends up in an `url()` so it must never carry a path.
 */
export function avatarUrl(id) {
  return id === 'mia' || id === 'agnes' || id === 'michelle' ? `/avatars/${id}.webp` : null;
}

/**
 * The voice strip inside the chat panel, as a pure view model.
 *
 * The strip is NOT the chat history: the text log is the persisted office
 * session, this is the transient voice session. They sit in one panel but
 * never pretend to be the same record.
 *
 * Every field here is something the Live client actually reported — the
 * status from the Live state, the transcript from the Live transcript, the
 * note from whatever the client last complained about. Nothing is invented,
 * and an idle session says nothing at all.
 */
export function liveStripModel(s) {
  const state = s || {};
  const status = state.status || 'idle';
  const active = status === 'ready' || status === 'connecting';
  const label =
    status === 'ready' ? (state.speaking ? 'Berbicara' : 'Siap')
    : status === 'connecting' ? 'Menyambung…'
    : status === 'error' ? 'Gagal'
    : status === 'closed' ? 'Tutup'
    : 'Idle';
  /* One honest line: the error first, else what the client is doing. */
  const note = state.error || state.note || state.stalled || state.toolNote || state.verifyNote || '';
  const heard = state.heard ? `Kamu: ${state.heard}` : '';
  const said = state.said ? `${state.agentName || 'Agent'}: ${state.said}` : '';
  return {
    status,
    active,
    label,
    pillClass: 'chatLivePill chatLivePill_' + status,
    agent: state.agentName ? `— ${state.agentName}` : '',
    heard,
    said,
    note,
    /* Idle is silent: the strip exists only while there is something to say. */
    hidden: !(active || note || state.heard || state.said),
  };
}

/** Honest connection copy — never claims "live" when the stream is gone. */
export function connectionLabel(state) {
  switch (state) {
    case 'open':
      return 'Terhubung';
    case 'connecting':
      return 'Menghubungkan…';
    case 'closed':
      return 'Terputus';
    case 'error':
      return 'Koneksi gagal';
    default:
      return 'Belum terhubung';
  }
}

/**
 * The one-line result shown under a tool card's summary row.
 *
 * An inbox card renders its OWN head ("📬 Ringkasan Inbox — N email terbaru
 * · range") plus the list, so the generic first-line result would repeat that
 * head — live 2026-10-22 the header appeared twice. Pure.
 */
export function cardResultLine(card) {
  if (!card) return '';
  if (card.inbox) return '';
  return card.result || '';
}

/**
 * A screen-reader-friendly excerpt of a message body.
 *
 * Pure helper: the live region in chat.js announces the latest agent reply,
 * and raw markdown (fences, bold markers, newlines) is noise to a screen
 * reader. This strips the markup, collapses whitespace, and truncates to a
 * sensible length so the announcement stays short and clean. Empty/missing
 * input yields an empty string (the caller decides whether to announce).
 */
export function announceExcerpt(text, maxLen = 240) {
  const raw = String(text ?? '');
  if (!raw.trim()) return '';
  // Drop fenced code blocks entirely — a screen reader reading 40 lines of
  // code is worse than saying nothing about that part.
  let body = raw.replace(/```[\s\S]*?```/g, ' ');
  // Strip common inline markdown markers.
  body = body
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/__([^_]*)__/g, '$1')
    .replace(/_([^_]*)_/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '');
  // Collapse all whitespace (newlines, tabs, runs) into single spaces.
  body = body.replace(/\s+/g, ' ').trim();
  if (!body) return '';
  if (body.length <= maxLen) return body;
  // Truncate on a word boundary when possible.
  const cut = body.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > maxLen * 0.6) return cut.slice(0, lastSpace).trim() + '…';
  return cut.trim() + '…';
}
