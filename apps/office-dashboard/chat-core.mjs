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
  const name = ev.data && ev.data.name;
  if (ev.type === 'tool_called' && name) {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].name === name && (list[i].state === 'queued' || list[i].state === 'awaiting_approval')) {
        list[i] = {
          ...list[i],
          state: ev.data.ok ? 'succeeded' : 'failed',
          at: ev.ts,
          output: list[i].output || (ev.data.ok ? 'Selesai (hasil di respons agent).' : String(ev.summary || 'Gagal.').slice(0, 300)),
        };
        break;
      }
    }
  } else if (ev.type === 'task_cancelled' && name) {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].name === name && list[i].state !== 'succeeded') {
        list[i] = { ...list[i], state: 'cancelled', at: ev.ts, output: 'Ditolak user — tool tidak dijalankan.' };
        break;
      }
    }
  }
  return list;
}

/** A turn is "working" while the backend says so (task_created/started, no end). */
export function turnIsLive(frames) {
  const seen = frames || [];
  if (!seen.length) return false;
  const last = seen[seen.length - 1];
  return last.type === 'task_created' || last.type === 'task_started' || last.type === 'tool_called';
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
export function visibleMessages(messages) {
  const out = [];
  (Array.isArray(messages) ? messages : []).forEach((m, i) => {
    if (!m || typeof m !== 'object' || m.role === 'tool') return;
    if (m.role === 'assistant' && !m.content) return;
    const content = String(m.content ?? '');
    out.push({ key: `${i}|${m.role}|${content.slice(0, 48)}`, role: m.role, content });
  });
  return out;
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
    awaiting_approval: { label: 'Menunggu persetujuan', icon: '?', tone: 'warn' },
    succeeded: { label: 'Selesai', icon: '✓', tone: 'ok' },
    failed: { label: 'Gagal', icon: '!', tone: 'bad' },
    cancelled: { label: 'Dibatalkan', icon: '×', tone: 'muted' },
  };
  return map[state] || { label: String(state || 'tidak diketahui'), icon: '·', tone: 'muted' };
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