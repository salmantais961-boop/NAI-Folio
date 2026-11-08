import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, copyFile, rm, readFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { runInNewContext } from 'node:vm';

const origin = 'http://tauri.localhost';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ90AAAAASUVORK5CYII=';

async function bridgeFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'folio-transport-'));
  const token = randomBytes(32).toString('hex');
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'server'));
  for (const [source, destination] of [
    ['../desktop/bridge.mjs', 'bridge.mjs'],
    ['../server/novelai.mjs', 'server/novelai.mjs'],
    ['../server/image-response.mjs', 'server/image-response.mjs'],
  ]) await copyFile(new URL(source, import.meta.url), join(dir, destination));
  const child = spawn(process.execPath, [join(dir, 'bridge.mjs')], {
    windowsHide: true, env: { ...process.env, NOVELAI_TOKEN: 'synthetic-environment-key' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    child.stdin.end();
    await exited;
  });
  const lines = createInterface({ input: child.stdout });
  const ready = once(lines, 'line', { signal: AbortSignal.timeout(5000) });
  child.stdin.write(token + '\n');
  const [line] = await ready;
  const { port } = JSON.parse(line);
  assert.ok(port > 0 && port <= 65535);
  return { base: 'http://127.0.0.1:' + port, headers: { Origin: origin, 'x-folio-desktop': token }, child, exited };
}

test('desktop sidecar checks loopback host, origin, token and CORS preflight', async t => {
  const { base, headers } = await bridgeFixture(t);
  const status = (overrides = {}) => fetch(base + '/api/status', { headers: { ...headers, ...overrides } });
  const response = await status();
  assert.deepEqual(await response.json(), { configured: false });
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal((await status({ Origin: 'https://tauri.localhost' })).status, 200);
  assert.equal((await status({ 'x-folio-desktop': 'invalid' })).status, 403);
  assert.equal((await fetch(base + '/api/status', { headers: { Origin: origin } })).status, 403);
  const denied = await status({ Origin: 'https://other.example' });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  const badHost = await new Promise((resolve, reject) => {
    http.get(base + '/api/status', { headers: { ...headers, Host: 'another.localhost' } }, res => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(badHost, 403);
  assert.equal((await fetch(base + '/public/index.html', { headers })).status, 404);
  assert.equal((await fetch(base + '/api/account', { headers })).status, 401);

  const preflight = extra => fetch(base + '/api/generate', { method: 'OPTIONS', headers: {
    Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Private-Network': 'true',
    'Access-Control-Request-Headers': 'authorization, content-type, x-folio-desktop, x-nai-provider, x-nai-image-base, x-nai-account-base',
    ...extra,
  } });
  const allowed = await preflight();
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-private-network'), 'true');
  assert.match(allowed.headers.get('access-control-allow-headers'), /x-folio-desktop/);
  assert.equal((await preflight({ 'Access-Control-Request-Headers': 'x-other' })).status, 403);
});

test('desktop sidecar streams real preview bytes before completion and exits on parent EOF', { timeout: 10000 }, async t => {
  const { base, headers, child, exited } = await bridgeFixture(t);
  const event = kind => 'event: ' + kind + '\ndata: ' + JSON.stringify({ samp_ix: 0, step_ix: 5, image: png }) + '\n\n';
  let upstream, sentHeaders;
  const relay = http.createServer((req, res) => {
    sentHeaders = req.headers;
    upstream = res;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(event('intermediate'));
    });
  });
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    relay.closeAllConnections();
    return new Promise(resolve => relay.close(resolve));
  });
  const generate = signal => fetch(base + '/api/generate-stream', {
    method: 'POST', signal, headers: {
      ...headers, Authorization: 'Bearer synthetic-relay-key', 'Content-Type': 'application/json',
      'x-nai-provider': 'relay', 'x-nai-image-base': 'http://127.0.0.1:' + relay.address().port + '/test',
    }, body: JSON.stringify({ action: 'generate', model: 'test', input: 'garden', parameters: { seed: 8 } }),
  });
  const response = await generate();
  assert.match(response.headers.get('content-type'), /ndjson/);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  assert.equal(JSON.parse((await reader.read()).value).step, 5);
  assert.equal(sentHeaders.authorization, 'Bearer synthetic-relay-key');
  assert.equal(sentHeaders['x-folio-desktop'], undefined);
  upstream.end(event('final'));
  let final = '';
  for (let chunk; !(chunk = await reader.read()).done;) final += chunk.value;
  assert.equal(JSON.parse(final).images[0].dataUrl, 'data:image/png;base64,' + png);

  const aborter = new AbortController();
  const pending = await generate(aborter.signal);
  const closed = once(upstream, 'close', { signal: AbortSignal.timeout(3000) });
  aborter.abort();
  await assert.rejects(pending.text(), { name: 'AbortError' });
  await closed;
  const abandoned = await generate();
  const lost = abandoned.text();
  child.stdin.end();
  await assert.rejects(lost);
  assert.equal((await exited)[0], 0);
});

test('desktop fetch only forwards same-origin API requests and preserves the caller signal and headers', async () => {
  const source = await readFile(new URL('../desktop/api-client.js', import.meta.url), 'utf8');
  const apiBase = 'http://127.0.0.1:15678', token = 'b'.repeat(48);
  const calls = [];
  const originalFetch = async (input, init) => { calls.push({ input, init }); return new Response('ok'); };
  const location = new URL(origin + '/index.html');
  const window = { parent: { location, __FOLIO_DESKTOP__: { apiBase, token } }, fetch: originalFetch };
  const context = { window, location, document: { baseURI: location.href }, Request, URL, Headers };
  runInNewContext(source, context);
  const signal = new AbortController().signal;
  await window.fetch('/api/generate-stream', { method: 'POST', signal, headers: { Authorization: 'Bearer test' }, body: '{}' });
  assert.equal(calls[0].input, apiBase + '/api/generate-stream');
  assert.equal(calls[0].init.signal, signal);
  assert.equal(calls[0].init.headers.get('authorization'), 'Bearer test');
  assert.equal(calls[0].init.headers.get('x-folio-desktop'), token);
  await window.fetch(new Request(location.origin + '/api/account?q=1'));
  assert.equal(calls[1].input, apiBase + '/api/account?q=1');
  for (const url of ['/catalog-data/artist.json', 'https://other.example/api/account']) {
    await window.fetch(url);
    assert.deepEqual(calls.at(-1), { input: url, init: undefined });
  }
  const external = { fetch: originalFetch, __FOLIO_DESKTOP__: { apiBase, token } };
  runInNewContext(source, { ...context, window: external, location: new URL('https://other.example') });
  assert.equal(external.fetch, originalFetch);
});
