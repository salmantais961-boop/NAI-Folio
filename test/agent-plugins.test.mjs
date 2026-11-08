import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openPlugins } from '../desktop/agent/plugins.mjs';

const fixtures = [];
after(async () => {
  for (const root of fixtures)
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 70 });
});
async function temporary() {
  const root = await mkdtemp(path.join(tmpdir(), 'folio-agent-fixture-'));
  fixtures.push(root);
  return async (file, data) => {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
    return target;
  };
}

test('skills use package discovery, progressive reading, relative documents and containment', async (t) => {
  const file = await temporary(t);
  const root = path.dirname(
    await file('package.json', JSON.stringify({ pi: { skills: ['./kit/*', '!./kit/scratch'] } })),
  );
  await file(
    'kit/ink/SKILL.md',
    '\uFEFF---\r\nname: ink-wash\r\ndescription: >-\r\n  Ink wash for drawings\r\n  and shadows.\r\n---\r\nSee references/paper.md',
  );
  await file('kit/ink/references/paper.md', 'Use grain.');
  await file(
    'kit/manual/SKILL.md',
    '---\nname: manual\ndescription: manual\ndisable-model-invocation: true\n---\nonly on request',
  );
  await file('kit/scratch/SKILL.md', '---\nname: scratch\ndescription: ignore me\n---\nno');
  const runtime = await openPlugins({ skillPaths: [root, root] });
  t.after(() => runtime.close());
  assert.deepEqual(runtime.skills, [{ name: 'ink-wash', description: 'Ink wash for drawings and shadows.' }]);
  assert.deepEqual(runtime.issues, []);
  const read = (args) => runtime.call('read_skill', { name: 'ink-wash', ...args });
  assert.match((await read({})).content[0].text, /references/);
  assert.equal((await read({ file: 'references/paper.md' })).content[0].text, 'Use grain.');
  await assert.rejects(read({ file: '../../package.json' }));
  await assert.rejects(read({ name: 'manual' }));
  await runtime.close();
  await assert.rejects(read({}));
});

test('a packaged Pi tool runs with real execute arguments and stays isolated from the bridge', async (t) => {
  const file = await temporary(t);
  const root = path.dirname(
    await file('package.json', JSON.stringify({ pi: { extensions: ['./kit/lookup.mjs'] } })),
  );
  await file(
    'kit/lookup.mjs',
    [
      'export default function(pi){',
      ' let ready=false; pi.on("session_start",()=>{ready=true});',
      ' pi.registerTool({name:"lookup",description:"Look up ink",parameters:{type:"object",properties:{ink:{type:"string"}}},',
      ' async execute(id,params,signal,onUpdate,ctx){return {content:[{type:"text",text:params.ink}],details:{ready,id:!!id,signal:!!signal,hasUI:ctx.hasUI,update:typeof onUpdate}}}})',
      '}',
    ].join('\n'),
  );
  await file('kit/unlisted.mjs', 'throw Error("unlisted file was imported")');
  const runtime = await openPlugins({ extensionPaths: [root] });
  t.after(() => runtime.close());
  assert.deepEqual(runtime.issues, []);
  assert.equal(runtime.tools.length, 1);
  const [tool] = runtime.tools;
  assert.match(tool.name, /^pi__.{1,50}__lookup$/);
  const result = await runtime.call(tool.name, { ink: 'cobalt' });
  assert.equal(result.content[0].text, 'cobalt');
  assert.deepEqual(result.structuredContent.details, {
    ready: true,
    id: true,
    signal: true,
    hasUI: false,
    update: 'function',
  });
});

test('stdio discovery paginates and respects disabled tools, credentials boundaries and cancellation', async (t) => {
  const file = await temporary(t);
  const fixture = await file(
    'mcp.mjs',
    [
      'import {createInterface} from "node:readline";',
      'const reply=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:"2.0",id,result})+"\\n");',
      'createInterface({input:process.stdin}).on("line",line=>{const m=JSON.parse(line);',
      ' if(m.method==="initialize")return reply(m.id,{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}}});',
      ' if(m.method==="tools/list"){const second=!!m.params.cursor;return reply(m.id,{tools:(second?["lookup","wait"]:["generate"]).map(name=>({name,description:name,inputSchema:{type:"object"}})), ...(!second?{nextCursor:"page-2"}:{})})}',
      ' if(m.method==="tools/call"&&m.params.name!=="wait")return reply(m.id,{content:[{type:"text",text:m.params.arguments.name}],structuredContent:{env:process.env.FOLIO_EXPLICIT_FIXTURE,private:!!process.env.FOLIO_PRIVATE_FIXTURE}});',
      '});',
    ].join('\n'),
  );
  process.env.FOLIO_PRIVATE_FIXTURE = 'fixture-token';
  t.after(() => {
    delete process.env.FOLIO_PRIVATE_FIXTURE;
  });
  const runtime = await openPlugins({
    mcpServers: {
      offline: { enabled: false, command: 'does-not-exist' },
      reference: {
        command: process.execPath,
        args: [fixture],
        env: { FOLIO_EXPLICIT_FIXTURE: 'allowed' },
        exposure: 'hidden',
        toolExposure: { lookup: 'direct', wait: 'direct' },
      },
    },
  });
  t.after(() => runtime.close());
  assert.deepEqual(runtime.issues, []);
  assert.deepEqual(
    runtime.tools.map((t) => t.name),
    ['mcp__reference__lookup', 'mcp__reference__wait'],
  );
  const res = await runtime.call('mcp__reference__lookup', { name: 'red hair' });
  assert.equal(res.content[0].text, 'red hair');
  assert.deepEqual(res.structuredContent, { env: 'allowed', private: false });
  const cancel = new AbortController();
  const pending = runtime.call('mcp__reference__wait', {}, { signal: cancel.signal });
  cancel.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('MCP streamable HTTP negotiates session, combines SSE chunks and tears it down', async (t) => {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    calls.push({ method: req.method, rpc: body.method, headers: req.headers });
    const reply = (result) => JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
    if (req.method === 'DELETE') {
      res.writeHead(200).end();
      return;
    }
    if (body.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'session' });
      res.end(reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} } }));
      return;
    }
    if (body.method === 'notifications/initialized') {
      res.writeHead(202).end();
      return;
    }
    if (body.method === 'tools/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(reply({ tools: [{ name: 'tags', inputSchema: { type: 'object' } }] }));
      return;
    }
    if (body.method === 'tools/call') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': keep-alive\r\n\r\n');
      res.write('event: message\r\ndata: ');
      res.write(reply({ content: [{ type: 'text', text: '水彩' }] }));
      setTimeout(() => res.end('\r\n\r\n'), 15);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(
    () =>
      new Promise((r) => {
        server.close(r);
        server.closeAllConnections();
      }),
  );
  const runtime = await openPlugins({
    mcpServers: {
      remote: {
        url: 'http://127.0.0.1:' + server.address().port + '/mcp',
        headers: { Authorization: 'Bearer test-only' },
      },
    },
  });
  t.after(() => runtime.close());
  assert.deepEqual(runtime.issues, []);
  assert.equal((await runtime.call('mcp__remote__tags', {})).content[0].text, '水彩');
  await runtime.close();
  assert.equal(calls.at(-1).method, 'DELETE');
  assert.equal(calls[0].headers['mcp-session-id'], undefined);
  for (const c of calls.slice(1)) {
    assert.equal(c.headers['mcp-session-id'], 'session');
    assert.equal(c.headers['mcp-protocol-version'], '2025-06-18');
  }
  assert.equal(calls[0].headers.authorization, 'Bearer test-only');
  assert.doesNotMatch(JSON.stringify(runtime), /test-only/);
});
