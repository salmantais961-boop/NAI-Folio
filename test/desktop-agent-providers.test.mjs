import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { PROVIDER_PRESETS, normalizeProvider, listModels, testConnection, chat } from '../desktop/agent/providers.mjs';
import { reasoningEfforts } from '../desktop/agent/providers/effort.mjs';

async function service(t, respond) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, 'http://local.invalid');
    const request = { method: req.method, headers: req.headers, path: url.pathname, query: url.searchParams,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null };
    seen.push(request);
    const { status = 200, body, headers = {} } = respond(request, seen.length);
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { base: 'http://127.0.0.1:' + server.address().port, seen };
}

const tool = { name: 'lookup', description: 'Search an image catalog', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } };
const args = { q: 'red hair' };
const done = { role: 'assistant', content: 'ready' };
const user = { role: 'user', content: 'Find a tag' };

test('recognizes a model which rejects tools without relaying upstream error text', async t => {
  const {base} = await service(t, () => ({status: 400,body: {error: {message: 'model does not support tool calling: private request details'}}}));
  await assert.rejects(chat({preset:'custom',baseUrl:base,model:'local'}, {messages:[user], tools:[tool]}),
    error => error.message === '这个模型不支持原生工具调用。');
});

test('bare, local, gateway and pasted inference URLs normalize idempotently', () => {
  const variants = [
    [{ preset: 'groq', baseUrl: 'api.groq.com/' }, 'https://api.groq.com/openai/v1'],
    [{ preset: 'custom', baseUrl: 'relay.example/acme/v2/chat/completions/' }, 'https://relay.example/acme/v2'],
    [{ preset: 'custom', baseUrl: 'relay.example/chat/completions' }, 'https://relay.example'],
    [{ preset: 'lmstudio', baseUrl: 'localhost:1234' }, 'http://localhost:1234/v1'],
    [{ preset: 'ollama', baseUrl: '[::1]:11434/api/tags' }, 'http://[::1]:11434/api'],
    [{ preset: 'gemini', baseUrl: 'generativelanguage.googleapis.com/v1beta/models/gemini-3:generateContent' }, 'https://generativelanguage.googleapis.com/v1beta'],
    [{ preset: 'anthropic', baseUrl: 'relay.example/claude/v1/messages' }, 'https://relay.example/claude/v1'],
    [{ preset: 'openai', baseUrl: 'api.openai.com/v1/responses' }, 'https://api.openai.com/v1'],
  ];
  for (const [config, base] of variants) {
    const normalized = normalizeProvider(config);
    assert.equal(normalized.baseUrl, base);
    assert.deepEqual(normalizeProvider(normalized), normalized);
  }
  assert.equal(new Set(PROVIDER_PRESETS.map(p => p.id)).size, PROVIDER_PRESETS.length);
  assert.throws(() => normalizeProvider({ preset: 'custom' }));
  for (const baseUrl of ['https://u:pass@relay.example/a', 'https://a.example#x', 'https://a.example?key=x',
    'file:///d:/test', 'http://127.evil.example', 'http://169.254.169.254', 'https://metadata.google.internal']) {
    assert.throws(() => normalizeProvider({ preset: 'custom', baseUrl }));
  }
});

const fixtures = {
  'chat-completions': {
    base: '/v1', endpoint: '/v1/chat/completions', list: '/v1/models',
    models: { data: [{ id: 'fixture' }] }, final: { choices: [{ message: done }] },
    first: { choices: [{ message: { content: null, reasoning_content: 'continuation', tool_calls: [
      { id: 'id-1', type: 'function', function: { name: 'lookup', arguments: JSON.stringify(args) } },
    ] } }] },
    check(b) {
      assert.equal(b.messages[0].content, 'system');
      assert.equal(b.messages.at(-2).reasoning_content, 'continuation');
      assert.equal(b.messages.at(-1).tool_call_id, 'id-1');
      assert.equal(b.tools[0].function.name, 'lookup');
    },
  },
  responses: {
    base: '/v1', endpoint: '/v1/responses', list: '/v1/models',
    models: { data: [{ id: 'fixture' }] },
    first: { output: [{ type: 'reasoning', encrypted_content: 'opaque', summary: [] }, { type: 'function_call', call_id: 'id-1', name: 'lookup', arguments: JSON.stringify(args) }] },
    final: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ready' }] }] },
    check(b) {
      assert.equal(b.store, false);
      assert.equal(b.instructions, 'system');
      assert.equal(b.input[1].encrypted_content, 'opaque');
      assert.deepEqual(b.input.at(-1), { type: 'function_call_output', call_id: 'id-1', output: 'match' });
      assert.equal(b.tools[0].name, 'lookup');
    },
  },
  anthropic: {
    base: '/v1', endpoint: '/v1/messages', list: '/v1/models',
    models: { data: [{ id: 'fixture' }], has_more: false },
    first: { content: [{ type: 'tool_use', name: 'lookup', id: 'id-1', input: args }] },
    final: { content: [{ type: 'text', text: 'ready' }] },
    check(b) {
      assert.equal(b.system, 'system');
      assert.equal(b.messages.at(-1).role, 'user');
      assert.deepEqual(b.messages.at(-1).content[0], { type: 'tool_result', tool_use_id: 'id-1', content: 'match' });
      assert.deepEqual(b.tools[0].input_schema, tool.parameters);
    },
  },
  gemini: {
    base: '/v1beta', endpoint: '/v1beta/models/fixture:generateContent', list: '/v1beta/models',
    models: { models: [{ name: 'models/fixture', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embed', supportedGenerationMethods: ['embedContent'] }] },
    first: { candidates: [{ content: { parts: [{ functionCall: { name: 'lookup', args }, thoughtSignature: 'opaque' }] } }] },
    final: { candidates: [{ content: { parts: [{ text: 'ready' }] } }] },
    check(b) {
      assert.equal(b.systemInstruction.parts[0].text, 'system');
      assert.equal(b.contents.at(-2).parts[0].thoughtSignature, 'opaque');
      assert.deepEqual(b.contents.at(-1).parts[0].functionResponse, { name: 'lookup', response: { result: 'match' } });
      assert.equal(b.tools[0].functionDeclarations[0].name, 'lookup');
    },
  },
  ollama: {
    base: '/api', endpoint: '/api/chat', list: '/api/tags', models: { models: [{ name: 'fixture' }] },
    first: { message: { role: 'assistant', content: '', thinking: 'continuation', tool_calls: [{ function: { name: 'lookup', arguments: args } }] } },
    final: { message: done },
    check(b) {
      assert.equal(b.stream, false);
      assert.equal(b.messages[0].content, 'system');
      assert.equal(b.messages.at(-2).thinking, 'continuation');
      assert.equal(b.messages.at(-1).tool_name, 'lookup');
      assert.deepEqual(b.tools[0].function.parameters, tool.parameters);
    },
  },
};

for (const [protocol, f] of Object.entries(fixtures)) {
  test(protocol + ' discovers live models, pings inference and completes a tool exchange', async t => {
    const { base, seen } = await service(t, (req, position) => {
      if (req.method === 'GET') return { body: f.models };
      return { body: position === 3 ? f.first : f.final };
    });
    const config = { preset: 'custom', protocol, apiKey: 'fixture-only', baseUrl: base + f.base, model: 'fixture' };
    assert.deepEqual(await listModels(config), ['fixture']);
    assert.deepEqual(await testConnection(config), { ok: true, model: 'fixture' });
    const first = await chat(config, { system: 'system', messages: [user], tools: [tool] });
    const c = first.toolCalls[0];
    assert.deepEqual(c.arguments, args);
    const final = await chat(config, { system: 'system', messages: [user, first, { role: 'tool', name: c.name, toolCallId: c.id, content: 'match' }], tools: [tool] });
    assert.equal(final.content, 'ready');
    assert.deepEqual(seen.map(r => r.path), [f.list, f.endpoint, f.endpoint, f.endpoint]);
    const h = seen[0].headers;
    if (protocol === 'anthropic') assert.equal(h['x-api-key'], 'fixture-only');
    else if (protocol === 'gemini') assert.equal(h['x-goog-api-key'], 'fixture-only');
    else assert.equal(h.authorization, 'Bearer fixture-only');
    f.check(seen.at(-1).body);
  });
}

test('explicit reasoning effort reaches the correct provider field across complete tool rounds', async t => {
  const cases = [
    ['openai','responses','gpt-5.4','high',b => assert.equal(b.reasoning.effort, 'high')],
    ['custom','chat-completions','aliased-reasoner','low',b => assert.equal(b.reasoning_effort, 'low')],
    ['deepseek','chat-completions','deepseek-v4-pro','max',b => {
      assert.deepEqual(b.thinking,{type:'enabled'}); assert.equal(b.reasoning_effort,'max');
    }],
    ['openrouter','chat-completions','openai/gpt-oss-20b','medium',b => assert.equal(b.reasoning.effort,'medium')],
    ['anthropic','anthropic','claude-sonnet-4-6','high',b => {
      assert.deepEqual(b.thinking,{type:'adaptive'}); assert.equal(b.output_config.effort,'high');
    }],
    ['anthropic','anthropic','claude-sonnet-4-5','medium',b => {
      assert.deepEqual(b.thinking,{type:'enabled',budget_tokens:4096}); assert.ok(b.max_tokens > b.thinking.budget_tokens);
    }],
    ['gemini','gemini','gemini-3.1-pro-preview','high',b => assert.equal(b.generationConfig.thinkingConfig.thinkingLevel,'HIGH')],
    ['gemini','gemini','gemini-2.5-flash','medium',b => assert.equal(b.generationConfig.thinkingConfig.thinkingBudget,4096)],
    ['ollama','ollama','gpt-oss:20b','low',b => assert.equal(b.think,'low')],
    ['ollama','ollama','qwen3:8b','off',b => assert.equal(b.think,false)],
  ];
  for (const [preset,protocol,model,effort,check] of cases) {
    const f=fixtures[protocol];
    const {base,seen}=await service(t,(_,n) => ({body:n===1?f.first:f.final}));
    const config={preset,protocol,model,baseUrl:base+f.base,reasoningEffort:effort};
    const first=await chat(config,{messages:[user],tools:[tool],maxTokens:2800});
    const reply={role:'tool',toolCallId:first.toolCalls[0].id,name:'lookup',content:'ok'};
    await chat(config,{messages:[user,first,reply],tools:[tool],maxTokens:2800});
    for (const r of seen) check(r.body);
  }
});

test('auto keeps the original wire body, invalid or unsupported efforts make no upstream call', async t => {
  for(const [protocol,f] of Object.entries(fixtures)){
    const {base,seen}=await service(t,()=>({body:f.final}));
    const config={protocol,baseUrl:base+f.base,model:'legacy'};
    await chat(config,{reasoningEffort:'auto',messages:[user],maxTokens:2800});
    const b=seen[0].body;
    assert.equal(b.reasoning_effort,undefined); assert.equal(b.reasoning,undefined);
    assert.equal(b.thinking,undefined); assert.equal(b.think,undefined);
    assert.equal(b.generationConfig?.thinkingConfig,undefined);
    await assert.rejects(chat(config,{messages:[user],reasoningEffort:'invented'}),/思考强度/);
    assert.equal(seen.length,1);
  }
  assert.deepEqual(reasoningEfforts({preset:'deepseek',model:'deepseek-flash'}),['auto','off','low','high','max']);
  assert.deepEqual(reasoningEfforts({preset:'gemini',model:'gemini-3-pro-preview'}),['auto','low','high']);
  assert.deepEqual(reasoningEfforts({preset:'ollama',model:'llama3.2'}),['auto']);
  const {base,seen}=await service(t,()=>({body:fixtures.responses.final}));
  await assert.rejects(chat({preset:'openai',baseUrl:base,model:'gpt-4o',reasoningEffort:'high'},{messages:[user]}),/思考强度/);
  assert.equal(seen.length,0);
});

test('pagination carries opaque cursors only on the configured origin', async t => {
  for (const protocol of ['anthropic', 'gemini']) {
    const { base, seen } = await service(t, (_, position) => ({ body: protocol === 'anthropic'
      ? { data: [{ id: 'm' + position }], has_more: position === 1, last_id: 'cursor' }
      : { models: [{ name: 'models/m' + position }], nextPageToken: position === 1 ? 'cursor' : undefined } }));
    assert.deepEqual(await listModels({ protocol, baseUrl: base }), ['m1', 'm2']);
    assert.equal(seen[1].query.get(protocol === 'anthropic' ? 'after_id' : 'pageToken'), 'cursor');
  }
});

test('upstream secrets are redacted and a bad model list does not block a manually configured model', async t => {
  const { base } = await service(t, r => r.path.endsWith('/models')
    ? { status: 404, body: { error: 'secret-value' } }
    : { body: { choices: [{ message: done }] } });
  const config = { preset: 'custom', baseUrl: base, model: 'manual' };
  await assert.rejects(listModels(config), e => e.message.includes('手动') && !e.message.includes('secret-value'));
  assert.equal((await testConnection(config)).model, 'manual');
});

test('string-based tool arguments retain their original whitespace without adding UI fields to replay', async t => {
  const raw = '{\n  "q" : "red hair"\n}';
  for (const protocol of ['chat-completions','responses']) {
    const first = protocol === 'responses'
      ? {output:[{type:'function_call',call_id:'raw-1',name:'lookup',arguments:raw}]}
      : {choices:[{message:{content:null,tool_calls:[{id:'raw-1',type:'function',function:{name:'lookup',arguments:raw}}]}}]};
    const f=fixtures[protocol];
    const {base,seen}=await service(t,(_,n)=>({body:n===1?first:f.final}));
    const config={baseUrl:base+f.base,protocol,model:'fixture'};
    const message=await chat(config,{messages:[user],tools:[tool]});
    const persisted=JSON.parse(JSON.stringify(message));
    assert.equal(persisted.toolCalls[0].rawArguments,raw);
    assert.deepEqual(persisted.toolCalls[0].arguments,args);
    await chat(config,{messages:[user,persisted,{role:'tool',toolCallId:'raw-1',name:'lookup',content:'match'}],tools:[tool]});
    const wire=seen[1].body;
    assert.equal(JSON.stringify(wire).includes('rawArguments'),false);
    const serialized=protocol==='responses' ? wire.input.find(i=>i.type==='function_call').arguments
      : wire.messages.find(m=>m.tool_calls).tool_calls[0].function.arguments;
    assert.deepEqual(JSON.parse(serialized),args);
  }
});

test('cross-origin redirects cannot receive credentials; canceled requests do not run', async t => {
  const other = await service(t, () => ({ body: {} }));
  const relay = await service(t, () => ({ status: 307, headers: { Location: other.base }, body: {} }));
  const config = { baseUrl: relay.base, apiKey: 'fake-key', model: 'fixture' };
  await assert.rejects(chat(config, { messages: [user] }), /重定向/);
  assert.equal(other.seen.length, 0);
  await assert.rejects(listModels(config, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(relay.seen.length, 1);
});

test('all five protocols send actual pixels in their native user image field', async t => {
  const encoded = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  const url = 'data:image/png;base64,' + encoded;
  for (const [protocol, f] of Object.entries(fixtures)) {
    const { base, seen } = await service(t, () => ({ body: f.final }));
    await chat({ preset: 'custom', protocol, model: 'vision', baseUrl: base + f.base },
      { messages: [{ role: 'user', content: 'image request', images: [url] }] });
    const b = seen[0].body;
    const part = protocol === 'responses' ? b.input[0].content[0] : protocol === 'gemini'
      ? b.contents[0].parts[0] : b.messages[0].content[0];
    switch (protocol) {
      case 'chat-completions': assert.deepEqual(part, { type: 'image_url', image_url: { url } }); break;
      case 'responses': assert.deepEqual(part, { type: 'input_image', image_url: url }); break;
      case 'anthropic': assert.deepEqual(part.source, { type: 'base64', media_type: 'image/png', data: encoded }); break;
      case 'gemini': assert.deepEqual(part.inlineData, { mimeType: 'image/png', data: encoded }); break;
      case 'ollama': assert.deepEqual(b.messages[0].images, [encoded]); assert.equal(b.messages[0].content, 'image request'); break;
      default: assert.fail('Unverified protocol ' + protocol);
    }
  }
});

test('vision errors preserve attachments, report model rejection, and reject external image URLs before forwarding', async t => {
  const {base,seen} = await service(t, () => ({status:400,body:{error:{message:'Image input is not supported by this model: private sample'}}}));
  const provider = {preset:'custom',baseUrl:base,model:'text'};
  const image = 'data:image/jpeg;base64,/9j/2Q==';
  const send = images => chat(provider, {messages:[{role:'user',content:'review',images}], tools:[tool]});
  await assert.rejects(send([image]), e => e.message.includes('未接受图片') && !e.message.includes('private'));
  for (const invalid of [['https://example.invalid/private.png'],Array(5).fill(image),['data:image/png;base64,QUJD']])
    await assert.rejects(send(invalid), /图片|附件/);
  assert.equal(seen.length,1);
});
