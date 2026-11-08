import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { assembleFolioPlan, createAgentRunner } from '../desktop/frontend/desktop-agent-run.js';
import { emptyThread } from '../desktop/frontend/desktop-agent-store.js';
import { initial, requestFor } from '../public/controls-model.js';
import { traceFormatter } from '../desktop/frontend/agent-call-log.js';
import { createAgentPromptBudget } from '../public/agent-prompt-budget.js';
import { loadTokenizer } from '../public/prompt-tokenizer-core.js';

test('a new conversation inherits independent snapshots of both lock lanes', () => {
  const original = { ...emptyThread(), title: '第一张图', draft: '旧草稿' };
  original.locks.push(
    { id: 'style', name: '纸面', text: '!macro:墨线!', resolvedText: '1.2::ink::',
      resolvedChunks: [{ id: 'ink', name: '墨线', text: '1.2::ink::' }] },
    { id: 'folio-current-negative', name: '工作台负面提示词', lane: 'negative', text: ' blurry,  text  ' },
  );
  const next = emptyThread(original.locks);
  assert.notEqual(next.id, original.id);
  assert.equal(next.title, '');
  assert.equal(next.draft, '');
  assert.deepEqual(next.locks, original.locks);
  next.locks[0].resolvedChunks[0].text = 'changed';
  next.locks.pop();
  assert.equal(original.locks[0].resolvedChunks[0].text, '1.2::ink::');
  assert.equal(original.locks[1].text, ' blurry,  text  ');
  assert.deepEqual(emptyThread().locks, []);
});

const encoders = new Map();
async function count(type, texts) {
  if (!encoders.has(type)) encoders.set(type, loadTokenizer(type, async (url) => new Response(await readFile(url))));
  const encoder = await encoders.get(type);
  return texts.map((text) => encoder.encode(text).length);
}

test('trace snapshots preserve the actual calls/results and distinguish unexecuted tools', async () => {
  const calls = [
    ...response('search_folio', { kind: 'character', query: '鸢尾' }).toolCalls,
    ...response('compose_folio', { ...brief, render: false }).toolCalls,
    ...response('search_folio', { kind: 'tags', query: 'not invoked' }).toolCalls,
  ];
  const { send, log } = harness([{ role: 'assistant', content: '', toolCalls: calls }]);
  const events = [];
  await send({
    reasoningEffort: 'high',
    onEvent: (e) => {
      if (e.type === 'tool') events.push(e.tool);
    },
  });
  assert.deepEqual(
    events.map((e) => [e.index, e.state]),
    [
      [1, 'queued'],
      [2, 'queued'],
      [3, 'queued'],
      [1, 'running'],
      [1, 'done'],
      [2, 'running'],
      [2, 'done'],
      [3, 'skipped'],
    ],
  );
  assert.deepEqual(JSON.parse(events[4].argumentsText), calls[0].arguments);
  assert.equal(JSON.parse(events[4].resultText)[0].id, iris.id);
  assert.match(JSON.parse(events[6].resultText).plan.prompt, /harbor/);
  assert.equal(events[7].startedAt, undefined);
  assert.equal(log.find(([a]) => a === 'chat')[1].provider.reasoningEffort, 'high');
  assert.equal(log.find(([a]) => a === 'chat')[1].sessionId, 'scope');
});

test('failed and aborted tools receive terminal trace states while the original error propagates', async () => {
  for (const aborted of [false, true]) {
    const ac = new AbortController(),
      events = [];
    const { send } = harness([response('compose_folio', { ...brief, characters: [] })], {
      render: async () => {
        if (aborted) ac.abort();
        throw Error('upstream rejected generation');
      },
    });
    await assert.rejects(
      send({
        signal: ac.signal,
        onEvent: (e) => {
          if (e.type === 'tool') events.push(e.tool);
        },
      }),
    );
    assert.equal(events.at(-1).state, aborted ? 'cancelled' : 'error');
    assert.ok(events.at(-1).endedAt >= events.at(-1).startedAt);
  }
});

test('large tool output, images and echoed credentials are safe to persist in the trace', () => {
  const format = traceFormatter(
    { apiKey: 'sensitive-one' },
    { mcpServers: { test: { env: { SERVICE_TOKEN: 'sensitive-two' } } } },
  );
  const result = format({
    token: 'secret-hidden-field',
    note: 'two keys: sensitive-one and sensitive-two',
    nested: [
      { type: 'image', data: 'A'.repeat(1000) },
      { type: 'text', text: 'x'.repeat(60000) },
    ],
  });
  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= 24001);
  assert.doesNotMatch(result.text, /sensitive-one|sensitive-two|secret-hidden-field|A{100}/);
  assert.match(result.text, /已省略二进制数据/);
});

test('negative locks bypass model negatives and the NAI UC preset in both wire representations', () => {
  const first = '  0.8::bad anatomy::, duplicate, duplicate,\n';
  const second = '2::unfinished::, private watermark  ';
  const locks = [
    { lane: 'negative', name: '排除一', text: first },
    { lane: 'negative', name: '排除二', text: second },
  ];
  const plan = assembleFolioPlan(
    { ...brief, negative: '!macro:ignored!', characters: [{ prompt: 'girl', negative: 'new role exclusions' }] },
    { locks, identities: new Map(), settings, maxCharacters: 22 },
  );
  assert.equal(plan.negative, first + second);
  assert.equal(plan.characters[0].negative, '');
  assert.match(plan.prompt, /oil painting/, 'a negative-only lock must not constrain positive style');
  for (const model of ['nai-diffusion-5-full', 'nai-diffusion-4-5-full', 'nai-diffusion-3']) {
    const d = {
      ...initial,
      model,
      uc: 'heavy',
      characters: plan.characters.map((c) => ({ ...c, negative: 'unexpected role negative', x: 0.5, y: 0.5 })),
    };
    const { parameters: p } = requestFor(d, plan.prompt, plan.negative, { lockNegative: true }).body;
    assert.equal(p.negative_prompt, first + second);
    if (p.v4_negative_prompt) {
      assert.equal(p.v4_negative_prompt.caption.base_caption, first + second);
      assert.deepEqual(
        p.v4_negative_prompt.caption.char_captions.map((c) => c.char_caption),
        [''],
      );
    }
  }
});

test('an explicit pipe in a frozen negative belongs to its original character lane', () => {
  const captured = '  watermark  |  2::glasses::  ';
  const { parameters: p } = requestFor(
    { ...initial, uc: 'heavy', characters: [{ prompt: 'girl', negative: 'AI addition', x: 0.5, y: 0.5 }] },
    'portrait',
    captured,
    { lockNegative: true },
  ).body;
  assert.equal(p.negative_prompt, '  watermark  ');
  assert.equal(p.v4_negative_prompt.caption.char_captions[0].char_caption, '  2::glasses::  ');
});

test('frozen negative is private on followup and V5 Medium never substitutes its own preset', async () => {
  const secret = 'frozen negative words';
  const neg = {
    id: 'neg',
    name: '我的负面',
    text: secret,
    lane: 'negative',
    resolvedText: secret,
    resolvedChunks: [],
  };
  const { send, log, renders } = harness([response('compose_folio', { ...brief, characters: [] })], {
    getSettings: () => ({ ...settings, medium: true }),
  });
  await assert.rejects(
    send({
      lockedChunks: [neg],
      history: [
        { role: 'assistant', content: '完成', plan: { negative: secret, negativeLocked: true, characters: [] } },
      ],
    }),
    /High/,
  );
  assert.equal(renders.length, 0);
  assert.ok(!JSON.stringify(log.find(([a]) => a === 'chat')[1]).includes(secret));
});

const settings = { ...initial, model: 'nai-diffusion-5-full', width: 832, height: 1216 };
const brief = {
  scene: '1girl, harbor, artist:new artist, watercolor',
  style: 'oil painting',
  negative: 'watermark',
  framing: 'landscape',
  render: true,
  characters: [{ referenceId: 'tag:iris', prompt: 'looking left', negative: 'extra arms' }],
};

test('Agent manual frame and image settings reach the model and NovelAI even when the tool requests a square', async () => {
  const manual = { ...initial, model: 'nai-diffusion-4-5-full', dataset: 'furry', width: 1536, height: 1024,
    agentFixedFraming: true, steps: 32, scale: 5.6, sampler: 'k_euler', seed: 5952 };
  const { send, log, renders } = harness([response('compose_folio', {
    ...brief, framing: 'square', characters: [],
  })], { getSettings: () => manual });
  await send();
  const context = log.find(([action]) => action === 'chat')[1].system;
  assert.match(context, /nai-diffusion-4-5-full/);
  assert.match(context, /1536×1024 \(fixed by the user/);
  assert.match(context, /"steps":32/);
  const { plan, settings: actual } = renders[0];
  const { body } = requestFor({ ...actual, width: plan.width, height: plan.height }, plan.prompt, plan.negative);
  assert.equal(body.model, manual.model);
  assert.match(body.input, /fur dataset/);
  const p = body.parameters;
  assert.deepEqual([p.width, p.height, p.steps, p.scale, p.sampler, p.seed], [1536, 1024, 32, 5.6, 'k_euler', 5952]);
});
const locked = { id: 'locked', name: '墨线', text: '1.2::ink drawing::, soft colors' };
const iris = { id: 'tag:iris', name: '鸢尾', prompt: 'iris (paper quay), short silver hair' };
const response = (name, args) => ({
  role: 'assistant',
  content: '',
  toolCalls: [{ id: crypto.randomUUID(), name, arguments: args }],
});
function harness(answers, overrides = {}) {
  const log = [],
    renders = [];
  const run = createAgentRunner({
    getSettings: () => settings,
    createPromptBudget: (options) => createAgentPromptBudget({ ...options, count }),
    getMaxCharacters: () => 22,
    getLibrary: () => [locked],
    resolve: () => ({ text: locked.text, chunks: [locked] }),
    search: async () => [iris],
    render: async (job) => {
      renders.push(job);
      return { workIds: ['work-1'], text: 'done' };
    },
    post: async (action, args) => {
      log.push([action, structuredClone(args)]);
      if (action === 'open') return { sessionId: 'scope', skills: [], tools: [] };
      if (action === 'chat') return answers.shift();
      if (action === 'close') return { ok: true };
      throw Error('unknown operation');
    },
    ...overrides,
  });
  const send = (options) =>
    run({
      text: '画鸢尾在港口',
      history: [],
      lockedChunks: [locked],
      provider: {},
      plugins: {},
      signal: new AbortController().signal,
      ...options,
    });
  return { send, log, renders };
}
test('Agent receives numeric budgets every round and must repair an oversized draft before returning or rendering', async () => {
  for (const render of [true, false]) {
    const args = { ...brief, render, characters: [] };
    const { send, log, renders } = harness([
      response('compose_folio', { ...args, scene: 'garden, '.repeat(300) }),
      response('compose_folio', args),
    ], { getSettings: () => ({ ...settings, model: 'nai-diffusion-3' }), getMaxCharacters: () => 0 });
    const events = [];
    const result = await send({ onEvent: (e) => events.push(e) });
    assert.ok(result.plan.prompt.includes('harbor'));
    assert.equal(events.filter((e) => e.type === 'plan').length, 1);
    assert.equal(renders.length, render ? 1 : 0);
    const chats = log.filter(([action]) => action === 'chat').map(([, body]) => body);
    for (const body of chats) {
      const data = JSON.parse(body.system.match(/NovelAI image prompt token budgets: (.*)/)[1]);
      assert.equal(data.positive.limit, 225);
      assert.equal(data.negative.limit, 225);
      assert.ok(data.positive.available < 225);
      assert.doesNotMatch(JSON.stringify(body), /ink drawing/);
    }
    const feedback = JSON.parse(chats[1].messages.at(-1).content);
    assert.equal(feedback.code, 'prompt_budget_exceeded');
    assert.equal(feedback.positive.over, feedback.positive.used - 225);
  }
});

test('over-budget model replies cannot bypass verification by returning ordinary text', async () => {
  const { send, renders } = harness([
    response('compose_folio', { ...brief, render: false, characters: [], negative: ' blurry'.repeat(400) }),
    { role: 'assistant', content: 'use this unverified prompt', toolCalls: [] },
  ], { getSettings: () => ({ ...settings, model: 'nai-diffusion-3' }), getMaxCharacters: () => 0 });
  await assert.rejects(send(), /负向.*超出.*修订/);
  assert.equal(renders.length, 0);
});
test('look up an identity, protect style locally, generate once and release tools', async () => {
  const { send, log, renders } = harness([
    response('search_folio', { query: '鸢尾', kind: 'character' }),
    response('compose_folio', brief),
  ]);
  const out = await send();
  assert.equal(out.plan.prompt, locked.text + ', 1girl, harbor');
  assert.equal(out.plan.characters[0].prompt, iris.prompt + ', looking left');
  assert.deepEqual([out.plan.width, out.plan.height], [1216, 832]);
  assert.deepEqual(out.workIds, ['work-1']);
  assert.equal(renders.length, 1);
  assert.ok(
    log.filter(([a]) => a === 'chat').every(([, payload]) => !JSON.stringify(payload).includes(locked.text)),
  );
  assert.deepEqual(
    log.map(([a]) => a),
    ['open', 'chat', 'chat', 'close'],
  );
});
test('a frozen style survives edits and deletions, including already-resolved nested macros', async () => {
  const snapshot = {
    ...locked,
    text: '!macro:old nested block!',
    resolvedText: 'original, 1.3::ink::',
    resolvedChunks: [locked],
  };
  const changed = { ...locked, text: 'new look' };
  const { send, renders } = harness([response('compose_folio', { ...brief, characters: [] })], {
    getLibrary: () => [changed],
  });
  const out = await send({ lockedChunks: [snapshot] });
  assert.equal(out.plan.prompt, 'original, 1.3::ink::, 1girl, harbor');
  assert.equal(renders[0].locks[0].chunks.length, 0);
});
test('prompt-only and plain text tool mode produce a plan without charging the image account', async () => {
  const { send, renders } = harness([
    {
      content: JSON.stringify({ tool: 'compose_folio', arguments: { ...brief, render: false, characters: [] } }),
    },
  ]);
  const out = await send({ provider: { toolMode: 'text' } });
  assert.ok(out.plan);
  assert.deepEqual(out.workIds, []);
  assert.equal(renders.length, 0);
});
test('generation failure is not retried and cancellation still releases plugin sessions', async () => {
  const ac = new AbortController();
  const { send, log } = harness([response('compose_folio', { ...brief, characters: [] })], {
    render: async ({ signal }) => {
      ac.abort();
      signal.throwIfAborted();
    },
  });
  await assert.rejects(send({ signal: ac.signal }), { name: 'AbortError' });
  assert.deepEqual(
    log.map(([a]) => a),
    ['open', 'chat', 'close'],
  );
});
test('legacy image models flatten roles, medium effort respects its fixed negatives, unknown IDs are rejected', () => {
  const ctx = { locks: [], identities: new Map([[iris.id, iris]]), settings, maxCharacters: 0 };
  const v3 = assembleFolioPlan(brief, ctx);
  assert.deepEqual(v3.characters, []);
  assert.match(v3.prompt, /short silver hair/);
  const medium = assembleFolioPlan(brief, { ...ctx, settings: { ...settings, medium: true }, maxCharacters: 22 });
  assert.equal(medium.negative, '');
  assert.equal(medium.characters[0].negative, '');
  assert.throws(() => assembleFolioPlan(brief, { ...ctx, identities: new Map() }), /搜索/);
});
