import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateRawSync } from 'node:zlib';
import { createFolioServer } from '../server.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ90AAAAASUVORK5CYII=', 'base64');
const uri = 'data:image/png;base64,' + png.toString('base64');
const example = { input: 'garden', action: 'generate', model: 'nai-diffusion-5-full', parameters: { n_samples: 1, seed: 17 } };

// Some image API ZIP writers put lengths after the compressed bytes.
function directorArchive() {
  const name = Buffer.from('../output.png');
  const bytes = deflateRawSync(png);
  const crc = crc32(png);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(8, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(name.length, 26);
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, 4);
  descriptor.writeUInt32LE(bytes.length, 8); descriptor.writeUInt32LE(png.length, 12);
  const entry = Buffer.concat([local, name, bytes, descriptor]);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(8, 8); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(png.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(entry.length, 16);
  return Buffer.concat([entry, central, name, end]);
}

async function fixture(t, upstreamFetch) {
  const server = createFolioServer({ upstreamFetch });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return async (route, body, extra = {}) => fetch('http://127.0.0.1:' + server.address().port + route, {
    method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer test-only', 'Content-Type': 'application/json', ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test('account exposes only the subscription summary and local calls are restricted to their origin', async t => {
  let calls = 0;
  const request = await fixture(t, async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://image.novelai.net/user/subscription');
    assert.equal(init.headers.Authorization, 'Bearer test-only');
    return Response.json({ tier: 3, active: false, expiresAt: 4102444800, trainingStepsLeft: { fixedTrainingStepsLeft: 100, purchasedTrainingSteps: 5 },
      usage: { percent: 84, purchasedPercent: 37, isNegative: false, timeUntilNextPercent: 6048, privateField: 'private' }, paymentProcessorData: 'private' });
  });
  assert.deepEqual(await (await request('/api/account')).json(), { tier: 3, active: false, entitled:true, expiresAt: 4102444800, anlas: 105,
    subscriptionAnlas:100, purchasedAnlas:5, usage: { percent:84,purchasedPercent:37,isNegative:false,timeUntilNextPercent:6048 } });
  assert.equal((await request('/api/account', null, { Origin: 'https://example.net' })).status, 403);
  assert.equal((await request('/api/upscale', { image: 'abc', model: 'nai-diffusion-5-curated' }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal(calls, 1);
});

test('returns generated images in index order with individual seeds, and decodes Director ZIPs', async t => {
  const request = await fixture(t, async (url, init) => {
    if (String(url).endsWith('/ai/augment-image')) return new Response(directorArchive(), { status: 201, headers: { 'Content-Type': 'application/zip' } });
    assert.equal(String(url), 'https://image.novelai.net/ai/generate-image');
    assert.equal(JSON.parse(init.body).parameters.n_samples, 2);
    const images = [1, 0].map(index => ({ index, seed: 17 + index, image: png.toString('base64') }));
    return Response.json({ images }, { status: 201 });
  });
  const gen = await (await request('/api/generate', { ...example, parameters: { n_samples: 2 } })).json();
  assert.equal(gen.seed, 17);
  assert.deepEqual(gen.images.map(x => [x.seed, x.dataUrl]), [[17, uri], [18, uri]]);
  const director = await (await request('/api/augment', { image: png.toString('base64'), req_type: 'lineart', width: 1, height: 1 })).json();
  assert.deepEqual(director.images, [{ name: 'output.png', dataUrl: uri }]);
});

test('fragmented SSE gives real previews and only reports complete batches', async t => {
  let complete = true;
  const request = await fixture(t, async (url, init) => {
    assert.equal(String(url), 'https://image.novelai.net/ai/generate-image-stream');
    assert.equal(JSON.parse(init.body).parameters.stream, 'sse');
    const event = kind => 'event: ' + kind + '\r\ndata: ' + JSON.stringify({ samp_ix: 0, step_ix: 4, image: png.toString('base64') }) + '\r\n\r\n';
    const bytes = Buffer.from(event('intermediate') + (complete ? event('final') : ''));
    const stream = new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.subarray(i, i + 7)); c.close(); } });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  async function events() {
    const response = await request('/api/generate-stream', example);
    return (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  }
  const [preview, result] = await events();
  assert.deepEqual(preview, { type: 'preview', url: uri, step: 4, sample: 0 });
  assert.equal(result.images[0].dataUrl, uri);
  assert.equal(result.seed, 17);
  complete = false;
  const interrupted = await events();
  assert.deepEqual(interrupted.map(e => e.type), ['preview', 'error']);
});

test('reference encoding returns raw binary and upstream failures never trigger another request', async t => {
  let calls = 0;
  const request = await fixture(t, async url => {
    calls++;
    if (String(url).endsWith('/encode-vibe')) return new Response(new Uint8Array([0, 12, 255]), { status: 201 });
    return Response.json({ message: 'private upstream text' }, { status: 402 });
  });
  assert.deepEqual(await (await request('/api/encode-vibe', { image: png.toString('base64'), model: 'nai-diffusion-4-5-full', information_extracted: 1 })).json(), { encoding: 'AAz/' });
  const response = await request('/api/upscale', { image: png.toString('base64'), model: 'nai-diffusion-5-curated' });
  assert.equal(response.status, 402);
  assert.match((await response.json()).error, /Anlas/);
  assert.equal(calls, 2);
});

test('relay preserves path prefixes for every native image operation and a separate account base', async t => {
  const seen = [];
  const relay = {
    'X-NAI-Provider': 'relay',
    'X-NAI-Image-Base': 'https://relay.example/novelai/ai/',
    'X-NAI-Account-Base': 'https://accounts.example/nai/user/subscription',
  };
  const request = await fixture(t, async (url, init) => {
    const href = String(url);
    seen.push(href);
    assert.equal(init.headers.Authorization, 'Bearer test-only');
    assert.equal(init.redirect, 'error');
    if (href.endsWith('/user/subscription'))
      return Response.json({ tier: 3, active: true, trainingStepsLeft: 19 });
    if (href.includes('/suggest-tags?')) return Response.json({ tags: [{ tag: 'garden' }] });
    if (href.endsWith('/encode-vibe')) return new Response(new Uint8Array([0, 12, 255]));
    if (href.endsWith('/generate-image-stream')) {
      const event = { samp_ix: 0, image: png.toString('base64') };
      return new Response('event: final\ndata: ' + JSON.stringify(event) + '\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    }
    return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  });
  const account = await (await request('/api/account', null, relay)).json();
  assert.equal(account.accountAvailable, true);
  assert.equal(account.provider, 'relay');
  assert.equal(account.anlas, 19);
  for (const operation of ['generate', 'generate-stream', 'encode-vibe', 'augment', 'upscale']) {
    const body = operation.startsWith('generate') ? example : { image: png.toString('base64'), model: 'nai-diffusion-4-5-full', req_type: 'lineart' };
    const response = await request('/api/' + operation, body, relay);
    assert.equal(response.status, 200, operation);
    const payload = await response.text();
    assert.ok(!payload.includes('error'), payload);
  }
  assert.equal((await request('/api/suggest-tags?prompt=garden', null, relay)).status, 200);
  assert.deepEqual(seen.slice(0, 6), [
    'https://accounts.example/nai/user/subscription',
    ...['generate-image', 'generate-image-stream', 'encode-vibe', 'augment-image', 'upscale'].map(path => 'https://relay.example/novelai/ai/' + path),
  ]);
  assert.match(seen[6], /^https:\/\/relay\.example\/novelai\/ai\/generate-image\/suggest-tags\?prompt=garden&/);
});

test('a relay without subscription support reports unknown usage and can still generate', async t => {
  let calls = 0;
  let accountResponse = () => Response.json({ error: 'private upstream details' }, { status: 404 });
  const relay = { 'X-NAI-Provider': 'relay', 'X-NAI-Image-Base': 'https://relay.example/prefix' };
  const request = await fixture(t, async url => {
    calls++;
    if (String(url).endsWith('/user/subscription')) {
      assert.equal(String(url), 'https://relay.example/prefix/user/subscription');
      return accountResponse();
    }
    assert.equal(String(url), 'https://relay.example/prefix/ai/generate-image');
    return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  });
  const info = await (await request('/api/account', null, relay)).json();
  assert.equal(info.accountAvailable, false);
  assert.equal(info.anlas, null);
  assert.equal(info.usage, null);
  assert.equal(info.tier, null);
  assert.ok(!JSON.stringify(info).includes('private upstream'));
  assert.equal((await request('/api/generate', example, relay)).status, 200);
  accountResponse = () => new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } });
  assert.equal((await (await request('/api/account', null, relay)).json()).accountAvailable, false);
  accountResponse = () => Response.json({ detail: 'secret' }, { status: 401 });
  const rejected = await request('/api/account', null, relay);
  assert.equal(rejected.status, 401);
  assert.ok(!(await rejected.text()).includes('secret'));
  assert.equal(calls, 4);
});

test('relay configuration is request scoped, validates URLs, and cannot use the environment credential', async t => {
  const oldToken = process.env.NOVELAI_TOKEN;
  process.env.NOVELAI_TOKEN = 'environment-test-only';
  t.after(() => { if (oldToken === undefined) delete process.env.NOVELAI_TOKEN; else process.env.NOVELAI_TOKEN = oldToken; });
  const seen = [];
  const request = await fixture(t, async (url, init) => {
    assert.equal(init.redirect, 'error');
    seen.push([String(url), init.headers.Authorization]);
    return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  });
  const relay = { 'X-NAI-Provider': 'relay', 'X-NAI-Image-Base': 'https://relay.example/' };
  assert.equal((await request('/api/generate', example, { ...relay, Authorization: '' })).status, 401);
  for (const base of ['file:///tmp/nai', 'http://relay.example/', 'https://user:pass@relay.example/', 'https://relay.example/?key=value', 'https://relay.example/#', 'https://relay.example/?']) {
    const response = await request('/api/generate', example, { ...relay, 'X-NAI-Image-Base': base });
    assert.equal(response.status, 400, base);
  }
  assert.equal((await request('/api/generate', example, { ...relay, 'X-NAI-Account-Base': 'https://user:pass@relay.example/' })).status, 400);
  assert.equal((await request('/api/generate', example, { 'X-NAI-Image-Base': 'https://relay.example/' })).status, 400);
  assert.equal(seen.length, 0);
  await Promise.all([
    request('/api/generate', example, { ...relay, Authorization: 'Bearer relay-test-a' }),
    request('/api/generate', example, { ...relay, 'X-NAI-Image-Base': 'http://127.0.0.1:9000/api/', Authorization: 'Bearer relay-test-b' }),
    request('/api/generate', example, { Authorization: '' }),
  ]);
  assert.deepEqual(seen.sort(), [
    ['https://relay.example/ai/generate-image', 'Bearer relay-test-a'],
    ['http://127.0.0.1:9000/api/ai/generate-image', 'Bearer relay-test-b'],
    ['https://image.novelai.net/ai/generate-image', 'Bearer environment-test-only'],
  ].sort());
});

test('native relay image variants decode without replaying a billable request or changing parameters', async t => {
  let calls = 0;
  let reply;
  const relay = { 'X-NAI-Provider': 'relay', 'X-NAI-Image-Base': 'https://relay.example' };
  const job = { ...example, parameters: { ...example.parameters, v4_prompt: { caption: { base_caption: 'garden', char_captions: [{ char_caption: 'blue coat', centers: [{ x: 0.5, y: 0.5 }] }] } }, scale: 0, dynamic_thresholding: false } };
  const request = await fixture(t, async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://relay.example/ai/generate-image');
    assert.equal(init.headers.Accept, '*/*');
    assert.deepEqual(JSON.parse(init.body), job);
    return reply();
  });
  const formats = [
    () => Response.json({ images: [png.toString('base64')] }),
    () => Response.json({ image: uri }),
    () => Response.json({ data: [{ b64_json: png.toString('base64') }] }),
    () => new Response(png, { headers: { 'Content-Type': 'application/json' } }),
    () => new Response(png.toString('base64'), { headers: { 'Content-Type': 'text/plain' } }),
    () => new Response(uri, { headers: { 'Content-Type': 'text/plain' } }),
    () => new Response(directorArchive().toString('base64'), { headers: { 'Content-Type': 'application/octet-stream' } }),
  ];
  for (const makeReply of formats) {
    reply = makeReply;
    const before = calls;
    const response = await request('/api/generate', job, relay);
    const result = await response.json();
    assert.equal(response.status, 200, result.error);
    assert.equal(result.images[0].dataUrl, uri);
    assert.equal(calls, before + 1);
  }
});

test('relay response diagnostics distinguish HTML and JSON errors without exposing upstream data or retrying', async t => {
  let calls = 0;
  let reply;
  const relay = { 'X-NAI-Provider': 'relay', 'X-NAI-Image-Base': 'https://relay.example' };
  const request = await fixture(t, async () => { calls++; return reply(); });
  reply = () => new Response('<!doctype html><html>private response</html>', { headers: { 'Content-Type': 'text/html' } });
  const html = await request('/api/generate', example, relay);
  assert.equal(html.status, 502);
  assert.match((await html.json()).error, /网页而非图片/);
  assert.equal(calls, 1);
  reply = () => Response.json({ error: { message: 'private prompt and secret', code: 'bad-request' }, 'secret-key-name': 'private value' });
  const failed = await request('/api/generate', example, relay);
  assert.equal(failed.status, 502);
  const failure = await failed.text();
  assert.match(failure, /json/);
  assert.ok(!/private|secret-key-name|bad-request/.test(failure));
  assert.equal(calls, 2);
  reply = () => new Response('<html>stream unavailable</html>', { headers: { 'Content-Type': 'text/html' } });
  const stream = await request('/api/generate-stream', example, relay);
  assert.equal(stream.status, 502);
  assert.match((await stream.json()).error, /关闭「流式预览」/);
  assert.equal(calls, 3);
});
