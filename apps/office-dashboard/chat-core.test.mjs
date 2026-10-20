// Unit tests for the office chat sidebar's pure core (`chat-core.mjs`).
// Run: node --test apps/office-dashboard/chat-core.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeMarkdown, escapeHtml, parseNdjsonLine, applyBusEvent, turnIsLive, connectionLabel,
  visibleMessages, agentAvailability, toolStateMeta, humanError, humanGenerationError, avatarUrl,
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
    data: { name: 'web_search', ok: false },
  });
  assert.equal(out[0].state, 'failed');
  assert.ok(out[0].output.includes('timeout'));
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

test('visibleMessages drops tool traffic and empty assistant turns', () => {
  const out = visibleMessages([
    { role: 'user', content: 'halo' },
    { role: 'assistant', content: null, tool_calls: [{ id: 't1' }] },
    { role: 'tool', content: 'ok', tool_call_id: 't1' },
    { role: 'assistant', content: 'hai' },
  ]);
  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant']);
  assert.equal(out[1].content, 'hai');
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
