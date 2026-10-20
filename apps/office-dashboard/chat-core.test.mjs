// Unit tests for the office chat sidebar's pure core (`chat-core.mjs`).
// Run: node --test apps/office-dashboard/chat-core.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeMarkdown, escapeHtml, parseNdjsonLine, applyBusEvent, turnIsLive, connectionLabel,
  visibleMessages, cardsForCallIds, unclaimedCards, isInternalNote, declinedNoteText, mergeStamps,
  dateTimeLabel,
  agentAvailability, taskStateFor,
  toolStateMeta, humanError, humanGenerationError, avatarUrl,
} from './chat-core.mjs';

test('escapeHtml neutralises every HTML-significant char', () => {
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
});

test('markdown: raw HTML never becomes markup', () => {
  const html = sanitizeMarkdown('<script>alert(1)</script><b>x</b>');
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<b>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('markdown: supports bold, italic and inline code', () => {
  const html = sanitizeMarkdown('**tebal** *miring* `kode`');
  assert.ok(html.includes('<strong>tebal</strong>'));
  assert.ok(html.includes('<em>miring</em>'));
  assert.ok(html.includes('<code class="mInline">kode</code>'));
});

test('markdown: fenced code keeps its body literal and untouched by inline rules', () => {
  const html = sanitizeMarkdown('```js\nconst a = **not bold**;\n```');
  assert.ok(html.includes('<pre class="mCode"'));
  assert.ok(html.includes('const a = **not bold**;'));
  assert.ok(!html.includes('<strong>'));
});

test('markdown: links only for http(s), with rel/target hardening', () => {
  const ok = sanitizeMarkdown('[docs](https://example.com/a)');
  assert.ok(ok.includes('<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">docs</a>'));
  const bad = sanitizeMarkdown('[x](javascript:alert(1))');
  assert.ok(!bad.includes('<a '));
  assert.ok(bad.includes('x'));
});

test('markdown: empty and paragraph handling', () => {
  assert.equal(sanitizeMarkdown(''), '');
  const p = sanitizeMarkdown('satu\ndua\n\ntiga');
  assert.equal((p.match(/<p>/g) || []).length, 2);
  assert.ok(p.includes('<br>'));
});

test('parseNdjsonLine tolerates junk lines', () => {
  assert.equal(parseNdjsonLine(''), null);
  assert.equal(parseNdjsonLine('   '), null);
  assert.equal(parseNdjsonLine('{oops'), null);
  assert.deepEqual(parseNdjsonLine('{"type":"start"}'), { type: 'start' });
});

test('applyBusEvent: tool_called ok settles a queued card as succeeded', () => {
  const cards = [{ id: 'c1', name: 'http_request', args: 'url=x', state: 'queued' }];
  const out = applyBusEvent(cards, { type: 'tool_called', ts: 'T', data: { name: 'http_request', ok: true } });
  assert.equal(out[0].state, 'succeeded');
  assert.equal(cards[0].state, 'queued', 'must not mutate the input');
});

test('applyBusEvent: tool_called ok:false settles as failed', () => {
  const out = applyBusEvent([{ id: 'c1', name: 'web_search', state: 'awaiting_approval' }], {
    type: 'tool_called',
    ts: 'T',
    summary: 'web_search → Error: timeout',
    data: { name: 'web_search', ok: false, call_id: 'c1' },
  });
  assert.equal(out[0].state, 'failed');
  assert.equal(out[0].summary, 'Gagal');
  assert.ok(out[0].result.includes('timeout'), 'the failure reason is the user-facing result');
});

test('applyBusEvent: task_cancelled marks a declined tool cancelled, never succeeded', () => {
  const out = applyBusEvent([{ id: 'c1', name: 'rm', state: 'awaiting_approval' }], {
    type: 'task_cancelled',
    ts: 'T',
    data: { name: 'rm' },
  });
  assert.equal(out[0].state, 'cancelled');
  const done = applyBusEvent([{ id: 'c2', name: 'rm', state: 'succeeded' }], {
    type: 'task_cancelled',
    ts: 'T',
    data: { name: 'rm' },
  });
  assert.equal(done[0].state, 'succeeded', 'a finished tool must not flip to cancelled');
});

test('applyBusEvent: unrelated tool / event type changes nothing', () => {
  const base = [{ id: 'c1', name: 'http_request', state: 'queued' }];
  assert.equal(applyBusEvent(base, { type: 'tool_called', data: { name: 'other', ok: true } })[0].state, 'queued');
  assert.equal(applyBusEvent(base, { type: 'task_done' })[0].state, 'queued');
});

test('turnIsLive reflects real backend lifecycle frames only', () => {
  assert.equal(turnIsLive([]), false);
  assert.equal(turnIsLive([{ type: 'task_created' }]), true);
  assert.equal(turnIsLive([{ type: 'task_done' }]), false);
  assert.equal(turnIsLive([{ type: 'task_created' }, { type: 'task_failed' }]), false);
});

test('connectionLabel is honest per state', () => {
  assert.equal(connectionLabel('open'), 'Terhubung');
  assert.equal(connectionLabel('error'), 'Koneksi gagal');
  assert.notEqual(connectionLabel('error'), 'Terhubung');
  assert.equal(connectionLabel(undefined), 'Belum terhubung');
});

test('visibleMessages keeps the tool-proposal turn but never the tool result', () => {
  const out = visibleMessages([
    { role: 'user', content: 'halo' },
    { role: 'assistant', content: null, tool_calls: [{ id: 't1' }] },
    { role: 'tool', content: 'ok', tool_call_id: 't1' },
    { role: 'assistant', content: 'hai' },
  ]);
  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant', 'assistant']);
  assert.deepEqual(out[1].callIds, ['t1'], 'the proposal turn owns the card');
  assert.equal(out[2].content, 'hai');
});

test('visibleMessages gives every rendered message a distinct, stable key', () => {
  const a = visibleMessages([{ role: 'user', content: 'sama' }, { role: 'user', content: 'sama' }]);
  assert.notEqual(a[0].key, a[1].key, 'two identical messages must not collide');
  const again = visibleMessages([{ role: 'user', content: 'sama' }, { role: 'user', content: 'sama' }]);
  assert.deepEqual(a.map((m) => m.key), again.map((m) => m.key), 'keys must be reproducible for a re-render');
});

test('agentAvailability never invents availability for an unknown status', () => {
  assert.equal(agentAvailability('idle').label, 'Siap');
  assert.equal(agentAvailability('working').label, 'Bekerja');
  assert.equal(agentAvailability('paused').label, 'Jeda');
  assert.equal(agentAvailability(undefined).tone, 'unknown');
  assert.equal(agentAvailability('offline-maybe').label, 'Status tidak diketahui');
  assert.notEqual(agentAvailability(undefined).tone, 'on');
});

test('toolStateMeta carries state as word + glyph, not colour alone', () => {
  const states = ['queued', 'awaiting_approval', 'succeeded', 'failed', 'cancelled'];
  const glyphs = new Set();
  for (const s of states) {
    const meta = toolStateMeta(s);
    assert.ok(meta.label.length > 0, `${s} needs a word`);
    assert.ok(meta.icon.length > 0, `${s} needs a glyph`);
    glyphs.add(meta.icon);
  }
  assert.equal(glyphs.size, states.length, 'each state must read differently without colour');
  assert.equal(toolStateMeta('nonsense').tone, 'muted');
});
test('humanError never leaks raw browser/API metadata', () => {
  assert.equal(humanError(new TypeError('Failed to fetch')), 'koneksi ke server agent terputus');
  assert.equal(humanError(new Error('HTTP 500 <html>boom</html>')), 'server menjawab 500');
  assert.equal(humanError(new Error('HTTP 401 unauthorized')), 'kamu tidak punya akses ke sesi ini');
  assert.equal(humanError(new Error('AbortError: The user aborted')), 'permintaan dibatalkan');
  assert.equal(humanError(undefined), 'alasan tidak dilaporkan');
  const long = humanError({ message: `x${'y'.repeat(400)}` });
  assert.ok(long.length <= 140, 'error copy must stay short');
  assert.ok(!/["{}\[\]]/.test(long), 'json punctuation must not reach the chat');
});

test('humanGenerationError reduces a provider payload to one honest sentence', () => {
  const raw = 'LLM failed (400): {"error":{"message":"[gemini/api] invalid schema"}}';
  const out = humanGenerationError(raw);
  assert.equal(out, 'model tidak menjawab (400)');
  assert.ok(!out.includes('gemini'), 'provider internals must not be shown');
  assert.equal(humanGenerationError('429 rate limit reached'), 'batas pemakaian model tercapai (429)');
  assert.equal(humanGenerationError(''), 'alasan tidak dilaporkan');
  assert.equal(humanGenerationError('Timeout while waiting'), 'Timeout while waiting');
});

test('markdown: a Google-News-length link still becomes a link (2026-10-19)', () => {
  const long = `https://news.google.com/rss/articles/CBMivgFBVV95cUxQSEpGdHZWeVdZUnZGeGpvdzlsX2VnNmZ3MjM3QkNLOW1OVFh0enAtY185bVVsczZRVTJ2QXdfSHgwTlUyUVFTa1ZiTlNrOVN1NVJlR2t5Wm1GVHY1VExFazVtWmU3RmVrQTZDQnRveTFGSm5XNG5iekt0VjdvMVJUTm5hVFVIUzVyTHBmV1hwNDFfMzQ5YUxmaGVLQ0pzU29xM0h6cVA2NkZkRXRQaktYZGJSc2tGSFNEVkJsbzBB?oc=5&hl=id&gl=ID&ceid=ID:id${'x'.repeat(200)}`;
  assert.ok(long.length > 300, 'fixture must exceed the old 300-char cap');
  const html = sanitizeMarkdown(`[Demo ProtesBiaya Hidup](${long})`);
  assert.ok(html.includes('<a href='), 'long link must render as an anchor');
  assert.ok(!html.includes('](http'), 'no raw markdown may survive');
  assert.ok(!html.includes(long), 'the visible text must be the label, not the URL');
});

test('markdown: bullet and numbered lines become real lists', () => {
  const ul = sanitizeMarkdown('• Satu\n• Dua\n• Tiga');
  assert.ok(ul.startsWith('<ul>'), ul);
  assert.equal((ul.match(/<li>/g) || []).length, 3);
  const ol = sanitizeMarkdown('1. Satu\n2. Dua');
  assert.ok(ol.startsWith('<ol>'), ol);
  assert.equal((ol.match(/<li>/g) || []).length, 2);
  const dash = sanitizeMarkdown('- alpha\n- beta');
  assert.ok(dash.startsWith('<ul>'), dash);
});

test('markdown: a list keeps its inline formatting and stays escaped', () => {
  const html = sanitizeMarkdown('• **Bold** dan `code` — <script>x</script>');
  assert.ok(html.includes('<li><strong>Bold</strong> dan <code class="mInline">code</code>'));
  assert.ok(html.includes('&lt;script&gt;'), 'list items stay escaped');
  assert.ok(!html.includes('<script>'));
});

test('markdown: prose with a dash mid-line is NOT turned into a list', () => {
  const html = sanitizeMarkdown('Ada dua pilihan: naik - atau turun - lalu pilih.');
  assert.ok(html.includes('<p>'), html);
  assert.ok(!html.includes('<ul>'), html);
});

test('markdown: fenced code is untouched by list rules', () => {
  const html = sanitizeMarkdown('```sh\n- not a list\n1. not a list\n```');
  assert.ok(html.includes('<pre class="mCode"'), html);
  assert.ok(!html.includes('<ul>') && !html.includes('<ol>'), html);
});

test('markdown: a lead line followed by bullets keeps the lead and lists the items', () => {
  const html = sanitizeMarkdown('Ini headline terbaru — 6 hasil\n• Satu\n• Dua');
  assert.ok(html.startsWith('<p>Ini headline terbaru — 6 hasil</p>'), html);
  assert.ok(html.includes('<ul>'), html);
  assert.equal((html.match(/<li>/g) || []).length, 2);
  assert.ok(!html.includes('<br>•'), 'items must not stay as broken lines');
});

test('avatarUrl allows only the registered trio and never carries a path', () => {
  assert.equal(avatarUrl('mia'), '/avatars/mia.webp');
  assert.equal(avatarUrl('agnes'), '/avatars/agnes.webp');
  assert.equal(avatarUrl('michelle'), '/avatars/michelle.webp');
  // A crafted id must not be able to escape into the URL (it lands in url()).
  assert.equal(avatarUrl('../../etc/passwd'), null);
  assert.equal(avatarUrl('mia/../../secret'), null);
  assert.equal(avatarUrl(''), null);
  assert.equal(avatarUrl(undefined), null);
});

/* ── tool execution integrity (2026-10-20) ─────────────────────────────────
   The reported bug: a tool card from an old turn rendered under the newest
   reply, so the user read a stale result as the outcome of the last action.
   The fix has two halves — cards are anchored to the turn that proposed
   them, and a bus event may only touch the card its own call id owns. */

test('visibleMessages keeps the tool-proposal turn even when it has no text', () => {
  const msgs = visibleMessages([
    { role: 'user', content: 'cek email' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', function: { name: 'gmail_list' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
    { role: 'assistant', content: 'Sudah kubaca.' },
  ]);
  assert.equal(msgs.length, 3, 'the tool result message is not a bubble');
  assert.deepEqual(msgs[1].callIds, ['call_1'], 'the proposal turn must expose its call ids');
  assert.equal(msgs[1].content, '');
});

test('visibleMessages still drops an assistant turn with neither text nor calls', () => {
  const msgs = visibleMessages([
    { role: 'assistant', content: '' },
    { role: 'assistant', content: 'halo' },
  ]);
  assert.equal(msgs.length, 1);
});

test('cardsForCallIds joins a card to the turn that proposed it, by id only', () => {
  const cards = [
    { id: 'call_old', name: 'gmail_list', state: 'succeeded' },
    { id: 'call_new', name: 'gmail_list', state: 'queued' },
  ];
  const picked = cardsForCallIds(cards, ['call_new']);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].id, 'call_new');
  assert.deepEqual(cardsForCallIds(cards, []), []);
  assert.deepEqual(cardsForCallIds(cards, ['nope']), []);
});

test('unclaimedCards keeps only the cards no visible turn owns', () => {
  const cards = [{ id: 'call_old' }, { id: 'call_live' }];
  const msgs = [{ callIds: ['call_old'] }];
  assert.deepEqual(unclaimedCards(cards, msgs).map((c) => c.id), ['call_live']);
});

test('applyBusEvent matches by call id, so a same-named call in another turn is untouched', () => {
  const cards = [
    { id: 'call_old', name: 'gmail_list', state: 'succeeded', summary: 'Selesai' },
    { id: 'call_new', name: 'gmail_list', state: 'queued', summary: 'Menunggu dijalankan' },
  ];
  const out = applyBusEvent(cards, {
    type: 'tool_called', ts: '2026-10-20T00:00:00Z', summary: 'gmail_list → ok',
    data: { name: 'gmail_list', ok: true, call_id: 'call_new' },
  });
  assert.equal(out[0].state, 'succeeded', 'the older card keeps its own outcome');
  assert.equal(out[0].summary, 'Selesai');
  assert.equal(out[1].state, 'succeeded', 'the addressed card takes the outcome');
  assert.equal(out[1].result, 'gmail_list → ok');
});

test('applyBusEvent marks a started tool as running instead of guessing', () => {
  const cards = [{ id: 'call_1', name: 'gmail_list', state: 'queued' }];
  const out = applyBusEvent(cards, {
    type: 'tool_started', ts: 't1', data: { name: 'gmail_list', call_id: 'call_1' },
  });
  assert.equal(out[0].state, 'running');
  assert.equal(out[0].summary, 'Sedang berjalan');
});

test('applyBusEvent never overwrites a finished card with a late cancel', () => {
  const cards = [{ id: 'call_1', name: 'gmail_list', state: 'succeeded', summary: 'Selesai' }];
  const out = applyBusEvent(cards, {
    type: 'task_cancelled', ts: 't1', data: { name: 'gmail_list', call_id: 'call_1' },
  });
  assert.equal(out[0].state, 'succeeded');
  assert.equal(out[0].summary, 'Selesai');
});

test('applyBusEvent cancels exactly the declined call id', () => {
  const cards = [
    { id: 'call_a', name: 'gmail_list', state: 'queued' },
    { id: 'call_b', name: 'gmail_list', state: 'queued' },
  ];
  const out = applyBusEvent(cards, {
    type: 'task_cancelled', ts: 't1', data: { name: 'gmail_list', call_id: 'call_b' },
  });
  assert.equal(out[0].state, 'queued');
  assert.equal(out[1].state, 'cancelled');
});

test('toolStateMeta knows every state the backend can report', () => {
  assert.equal(toolStateMeta('running').label, 'Sedang berjalan');
  assert.equal(toolStateMeta('unknown').label, 'Status akhir tidak diketahui');
  assert.equal(toolStateMeta('timed_out').label, 'Berhenti — timeout');
  assert.equal(toolStateMeta('nonsense').label, 'Status akhir tidak diketahui');
});

test('turnIsLive counts a started tool as a live turn', () => {
  assert.equal(turnIsLive([{ type: 'tool_started' }]), true);
  assert.equal(turnIsLive([{ type: 'task_done' }]), false);
});

test('taskStateFor separates the running task from the agent availability', () => {
  assert.equal(taskStateFor({ live: true }).tone, 'busy');
  assert.equal(taskStateFor({ pending: { calls: [{}] } }).tone, 'warn');
  assert.equal(taskStateFor({ cards: [{ name: 'gmail_list', state: 'running' }] }).label, 'Menjalankan gmail_list');
  assert.equal(taskStateFor({}).tone, 'idle');
});

test('a backend nudge is flagged as an internal note, never as the owner speaking', () => {
  const msgs = visibleMessages([
    { role: 'user', content: '[email-gate] Error: giliran ini belum mengecek email' },
    { role: 'user', content: '[probe-gate] teliti ya' },
    { role: 'user', content: 'halo' },
  ]);
  assert.equal(msgs[0].internal, true);
  assert.equal(msgs[1].internal, true);
  assert.equal(msgs[2].internal, false);
  assert.equal(isInternalNote('halo'), false);
  assert.equal(isInternalNote('[Percakapan sebelumnya — …]'), true);
});

test('declinedNoteText names the declined tool and stays silent otherwise', () => {
  assert.equal(
    declinedNoteText([{ name: 'save_note', state: 'cancelled' }]),
    'save_note tidak dijalankan — aksi itu dibatalkan.',
  );
  assert.equal(declinedNoteText([{ name: 'gmail_list', state: 'succeeded' }]), null);
  assert.equal(declinedNoteText([{ name: 'gmail_list', state: 'unknown' }]), null);
  assert.equal(declinedNoteText([]), null);
});

test('a transient function-call-shape 400 reads as an upstream hiccup, not "model tidak menjawab"', () => {
  const raw = 'LLM failed (400): {"error":{"message":"[gemini/gemini-3.5-flash-lite] [400]: {"error": {"code": 400, "message": "Please ensure that function call turn comes immediately after a user turn or after a function response turn."}} (reset after 30s)"}}';
  const copy = humanGenerationError(raw);
  assert.ok(copy.includes('400'), copy);
  assert.ok(copy.includes('gangguan sesaat'), copy);
  assert.ok(!copy.includes('model tidak menjawab'), copy);
});

test('mergeStamps keeps the server time and never invents one', () => {
  assert.deepEqual(mergeStamps([1000, null], 3), [1000, null, null]);
  assert.deepEqual(mergeStamps(null, 2), [null, null]);
  assert.deepEqual(mergeStamps([1], 0), []);
  assert.deepEqual(mergeStamps(['x', 5], 2), [null, 5], 'a non-numeric stamp is not a time');
});

test('visibleMessages exposes the source index, so a message can be dated without guessing', () => {
  const out = visibleMessages([
    { role: 'user', content: 'a' },
    { role: 'tool', content: 'r', tool_call_id: 't1' },
    { role: 'assistant', content: 'b' },
  ]);
  assert.deepEqual(out.map((m) => m.index), [0, 2], 'the index points into the FULL list');
});

test('dateTimeLabel renders the configured timezone and never fabricates a date', () => {
  assert.equal(dateTimeLabel(new Date('2026-10-20T07:45:38Z'), 'Asia/Jakarta', 'WIB'), '20 Okt 2026, 14.45 WIB');
  assert.equal(dateTimeLabel(new Date('2026-10-20T07:45:38Z'), 'Asia/Jayapura', 'WIT'), '20 Okt 2026, 16.45 WIT');
  assert.equal(dateTimeLabel(null, 'Asia/Jakarta', 'WIB'), '');
  assert.equal(dateTimeLabel('bukan tanggal', 'Asia/Jakarta', 'WIB'), '');
  assert.equal(dateTimeLabel('', 'Asia/Jakarta', 'WIB'), '');
});
