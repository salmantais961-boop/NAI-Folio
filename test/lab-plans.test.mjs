import test from 'node:test';
import assert from 'node:assert/strict';
import { makeArtistPlans, makeSamplerPlans, mergeLabTags } from '../public/lab-plans.js';
import { MODELS, requestFor } from '../public/controls-model.js';
import { resolvePromptReferences } from '../public/chunks.js';

const payload = plan => requestFor(plan.settings, plan.prompt, plan.negative, { lockNegative: true }).body;

test('artist comparison scales each original style group along a seeded, stratified curve', () => {
  const args = { artists: '0.5::a::, b\nc', character: 'girl, silver hair', background: 'courtyard', negative: 'blurry', seed: 99 };
  const plans = makeArtistPlans(args);
  assert.equal(plans.length, 10);
  assert.equal(new Set(plans.map(p => p.prompt)).size, 10);
  assert.deepEqual(plans, makeArtistPlans(args));
  const other = makeArtistPlans({ ...args, round: 1 });
  assert(other.some((p, i) => p.prompt !== plans[i].prompt));
  for (const plan of plans) {
    assert.equal(plan.weights.length, 2);
    const [a, b, c] = [...plan.prompt.matchAll(/([\d.]+)::([a-c])::/gu)].map(m => Number(m[1]));
    assert.equal(a * 2, b);
    assert(Math.abs(b + c - 2) < .002);
    const params = payload(plan).parameters;
    assert.equal(params.seed, 99);
    assert.equal(params.n_samples, 1);
    assert.equal(params.negative_prompt, args.negative);
    assert.equal(params.v4_prompt.caption.char_captions[0].char_caption, args.character);
    assert(plan.prompt.endsWith(', courtyard'));
  }
  const shared = makeArtistPlans({ artists: '0.6::a, b::, c', seed: 22 });
  assert.equal(shared[0].weights.length, 2);
  assert.equal(makeArtistPlans({ artists: 'a,b,c', seed: 1 })[0].weights.length, 3);
  assert.equal(makeArtistPlans({ artists: 'a', seed: 1 })[0].weights.length, 1);
});

test('fixed random alternatives and referenced blocks retain their exact submitted caption across sheets', () => {
  const args = { artists: 'a,b', character: '||silver hair|brown hair||', negative: '||blur|noise||',
    background: '||!macro:柔和侧光!|!macro:空气透视!||', seed: 0 };
  const all = [...makeArtistPlans(args), ...makeArtistPlans({ ...args, round: 9 })];
  const chosen = all.map(p => [p.prompt.split('::, ').at(-1), p.negative, p.settings.characters[0].prompt]);
  assert.equal(new Set(chosen.map(parts => JSON.stringify(parts))).size, 1);
  assert(!chosen.flat().some(v => /[!|]/u.test(v)));
  assert(all.every(p => payload(p).parameters.seed === 0));
  assert.deepEqual(resolvePromptReferences('!macro:x!', [{ name: 'x', text: '||fox|wolf||' }], () => .99).text, 'wolf');
});

test('all supported models yield legal comparison payloads with independent character mode when available', () => {
  for (const [model, , family] of MODELS) {
    const plans = makeArtistPlans({ artists: 'a', character: 'girl', background: 'city', settings: { model }, seed: 111 });
    assert.equal(new Set(plans.map(p => p.prompt)).size, 10);
    for (const plan of plans) {
      const req = payload(plan);
      if (family === 'v3') {
        assert(plan.prompt.endsWith('city, girl'));
        assert(!plan.prompt.includes('::'));
        assert.equal(req.parameters.v4_prompt, undefined);
      } else assert.equal(req.parameters.v4_prompt.caption.char_captions.length, 1);
    }
  }
  assert.throws(() => makeArtistPlans({ artists: 'a', character: 'girl | boy', seed: 0 }), /角色/);
  assert.throws(() => makeArtistPlans({ artists: ' ', seed: 0 }), /画师/);
  assert.throws(() => makeArtistPlans({ artists: '0::a::', seed: 0 }), /零权重/);
});

test('sampler matrix enumerates each request exactly once while holding both prompts, dimensions and seed fixed', () => {
  const plans = makeSamplerPlans({ prompt: '||cat|dog||', negative: 'lowres', settings: { width: 1216, height: 832 },
    samplers: ['k_euler', 'k_euler_ancestral'], steps: '20，30,20', scales: '4.5；7', seed: 7 });
  assert.equal(plans.length, 8);
  const sums = plans.map(plan => {
    const req = payload(plan);
    assert.equal(req.input, plans[0].prompt);
    assert.equal(req.parameters.negative_prompt, 'lowres');
    assert.equal(req.parameters.seed, 7);
    assert.equal(req.parameters.width, 1216);
    assert.equal(req.parameters.height, 832);
    return [req.parameters.sampler, req.parameters.steps, req.parameters.scale].join('/');
  });
  assert.equal(new Set(sums).size, 8);
});

test('random sampling draws unique feasible combinations reproducibly and enforces actual Medium settings', () => {
  const args = { random: true, prompt: 'ink', seed: 17 };
  const first = makeSamplerPlans(args);
  assert.equal(first.length, 10);
  assert.equal(new Set(first.map(p => JSON.stringify(p.settings))).size, 10);
  assert.deepEqual(first, makeSamplerPlans(args));
  assert.notDeepEqual(first.map(p => p.settings), makeSamplerPlans({ ...args, round: 1 }).map(p => p.settings));
  const medium = { ...args, settings: { medium: true } };
  for (const p of makeSamplerPlans(medium)) {
    assert.equal(payload(p).parameters.steps, 14);
    assert.equal(payload(p).parameters.sampler, 'k_euler_ancestral');
  }
  assert.throws(() => makeSamplerPlans({ ...medium, negative: 'noise' }), /Medium/);
  assert.throws(() => makeSamplerPlans({ ...medium, samplers: ['k_euler'] }), /Euler/);
  assert.throws(() => makeSamplerPlans({ ...medium, steps: [28] }), /14/);
  assert.throws(() => makeSamplerPlans({ ...args, scales: 'oops' }), /CFG/);
  assert.throws(() => makeSamplerPlans({ ...args, steps: '99' }), /步数/);
  assert.throws(() => makeSamplerPlans({ ...args, samplers: [] }), /选择/);
});

test('shortening combines positive and negative strength, including nested numeric and bracket scopes', () => {
  assert.deepEqual(mergeLabTags('3::artist:x::, 4::artist:x::, other'), {
    text: '5::artist:x::, other', merged: 1, before: 3, after: 2 });
  assert.equal(mergeLabTags('5::x::, -3::x::').text, '4::x::');
  assert.equal(mergeLabTags('1::x::, -1::x::').text, '0::x::');
  assert.equal(mergeLabTags('1.5::x, {x}, .5::x::::').text, '2.300679::x::');
  assert.equal(mergeLabTags('2::2025::, 2025').text, '2.236068::2025::');
  assert.equal(mergeLabTags('a (series, title), a (series, title)').merged, 1);
  assert.equal(mergeLabTags('o_o, o o, o_o').after, 2);
  assert.equal(mergeLabTags('red_hair, Red Hair').after, 1);
  assert.equal(mergeLabTags('unchanged,\n 1.44::other::').text, 'unchanged,\n 1.44::other::');
  assert.throws(() => mergeLabTags('{x, x'), /闭合/);
});

test('opaque choices and references are preserved, and duplicates never cross character/negative boundaries', () => {
  const raw = 'Character 1: 2::red::, red\nCharacter 2: red, red | red | red\nNegative Prompt: red, !macro:x!, !macro:x!, ||red|blue||';
  const out = mergeLabTags(raw);
  assert.equal(out.merged, 2);
  assert(out.text.startsWith('Character 1: 2.236068::red::\nCharacter 2: 1.414214::red:: | red | red\nNegative Prompt:'));
  assert(out.text.endsWith('red, !macro:x!, !macro:x!, ||red|blue||'));
  assert.equal(mergeLabTags('0.8::a\\,b::, a\\,b, a, b').after, 3);
});
