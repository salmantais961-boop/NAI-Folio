import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { handleAgent } from '../desktop/agent/api.mjs';
import { openDeepSeekWeb } from '../desktop/agent/deepseek-web.mjs';

const provider = { preset: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'fixture-ds' };
const page = 'https://example.org/gallery';

test('DeepSeek search and fetch target the official tools with a reusable connection, sources and bounded page text', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push([url, options]);
    return url.endsWith('/search')
      ? Response.json({ results: [{ url: page, title: 'Gallery', snippet: 'A gallery.', site_name: 'Museum' },
          { url: 'file:///local/path', title: 'Not a web source' }] })
      : Response.json({ title: 'Gallery', content: 'a'.repeat(14_000) });
  };
  const web = openDeepSeekWeb(provider, { fetchImpl });
  const result = await web.call('search_web', { query: '  美术馆  ', count: 3 });
  assert.deepEqual(result, { query: '美术馆', results: [{ url: page, title: 'Gallery', summary: 'A gallery.', site: 'Museum', date: '' }] });
  const source = await web.call('fetch_web_page', { url: page });
  assert.equal(source.url, page);
  assert.equal(source.content.length, 12_000);
  assert.equal(source.truncated, true);
  assert.deepEqual(calls.map(([url]) => url), ['https://api.deepseek.com/v1/tools/search', 'https://api.deepseek.com/v1/tools/fetch']);
  assert.deepEqual(calls.map(([, o]) => JSON.parse(o.body)), [{ query: '美术馆', count: 3, need_content: false }, { url: page }]);
  assert.ok(calls.every(([, o]) => o.headers.Authorization === 'Bearer fixture-ds' && o.redirect === 'manual'));
  assert.ok(!JSON.stringify(web.tools).includes(provider.apiKey));
});

test('search rejects unrelated credentials, malformed inputs and redirects without echoing headers or error bodies', async () => {
  assert.equal(openDeepSeekWeb(null), null);
  for (const baseUrl of ['http://api.deepseek.com', 'https://api.deepseek.com.example.org/v1',
    'https://example.org/v1/deepseek', 'https://x@api.deepseek.com', 'https://api.deepseek.com/?apiKey=test']) {
    assert.throws(() => openDeepSeekWeb({ ...provider, baseUrl }), /官方连接/);
  }
  let requests = 0;
  const web = openDeepSeekWeb(provider, { fetchImpl: async () => {
    requests++;
    return new Response(provider.apiKey, { status: 302, headers: { Location: 'https://example.org' } });
  } });
  await assert.rejects(web.call('fetch_web_page', { url: 'https://user:pass@example.org' }), /网页地址/);
  await assert.rejects(web.call('search_web', { query: '🦋'.repeat(129) }), /128/);
  await assert.rejects(web.call('search_web', { query: 'abc', count: 99 }), /1 至 8/);
  assert.equal(requests, 0);
  await assert.rejects(web.call('search_web', { query: '🦋'.repeat(128) }), (err) =>
    err.message.includes('HTTP 302') && !err.message.includes(provider.apiKey));
  assert.equal(requests, 1);
});

test('desktop scope exposes and executes search only with a configured connection; closing it cancels a pending request', async (t) => {
  let resolveStarted;
  const started = new Promise((resolve) => { resolveStarted = resolve; });
  t.mock.method(globalThis, 'fetch', async (_, { body, signal }) => {
    if (JSON.parse(body).query === 'cancel') {
      resolveStarted();
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    return Response.json({ results: [] });
  });
  async function api(action, body) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.method = 'POST';
    let response;
    await handleAgent(req, new EventEmitter(), { pathname: '/api/agent-' + action }, new AbortController().signal,
      (_, status, value) => { response = { status, value }; });
    return response;
  }
  const config = { webSearch: { enabled: true } };
  const open = await api('open', { plugins: config, webSearchProvider: provider });
  assert.equal(open.status, 200);
  assert.deepEqual(open.value.tools.filter((tool) => /web/.test(tool.name)).map((tool) => tool.name), ['search_web', 'fetch_web_page']);
  assert.equal(JSON.stringify(open.value).includes(provider.apiKey), false);
  const sessionId = open.value.sessionId;
  const guide = await api('call', { sessionId, name: 'read_skill', arguments: { name: 'folio-web-tags' } });
  assert.equal(guide.status, 200);
  assert.match(JSON.stringify(guide.value), /English name[\s\S]*Danbooru tag[\s\S]*appearance/);
  const search = (query) => api('call', { sessionId, name: 'search_web', arguments: { query } });
  assert.deepEqual(await search('empty'), { status: 200, value: { query: 'empty', results: [] } });
  const pending = search('cancel');
  await started;
  await api('close', { sessionId });
  assert.equal((await pending).status, 400);
  assert.equal((await search('expired')).status, 400);
  const off = await api('plugins', { plugins: { ...config, webSearch: { enabled: false } }, webSearchProvider: provider });
  const missing = await api('plugins', { plugins: config });
  const fresh = await api('plugins', {});
  const incompatible = await api('plugins', { plugins: config, webSearchProvider: { ...provider, baseUrl: 'https://example.org/v1' } });
  assert.equal(incompatible.value.issues[0].source, 'DeepSeek 联网检索');
  for (const result of [fresh, off, missing, incompatible]) {
    assert.deepEqual(result.value.tools, []);
    assert.deepEqual(result.value.skills, []);
  }
  assert.deepEqual(open.value.skills.map((s) => s.name), ['folio-web-tags']);
  assert.deepEqual(open.value.tools.map((tool) => tool.name).sort(), ['fetch_web_page', 'read_skill', 'search_web']);
});
