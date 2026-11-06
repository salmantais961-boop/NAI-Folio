import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePromptReferences, expandPrompt } from '../public/chunks.js';

function withRandom(values, action) {
  const previous = Math.random;
  let index = 0;
  Math.random = () => values[index++ % values.length];
  try { return action(); } finally { Math.random = previous; }
}
const row = (name, text, fields = {}) => ({ id: name, name, text, ...fields });
const ids = (result) => result.chunks.map((chunk) => chunk.id);

test('only the selected random branch can claim an OC or automatic example', () => {
  const library = [row('A', 'red hair', { kind: 'oc' }), row('B', 'blue hair', { kind: 'oc' })];
  const text = 'portrait, ||!macro:A!|!macro:B!||, light';
  const first = withRandom([0], () => resolvePromptReferences(text, library));
  assert.equal(first.text, 'portrait, red hair, light');
  assert.deepEqual(ids(first), ['A']);
  const second = withRandom([.999], () => resolvePromptReferences(text, library));
  assert.equal(second.text, 'portrait, blue hair, light');
  assert.deepEqual(ids(second), ['B']);
  assert.deepEqual(ids(resolvePromptReferences('red hair, blue hair', library)), []);
});

test('selected parent chunks and their selected recursive branches are tracked in order', () => {
  const library = [
    row('Parent', '||!macro:Inner!|!macro:Unused!||, soft light'),
    row('Inner', '||green eyes|amber eyes||'), row('Unused', '!macro:Missing!'),
  ];
  const result = withRandom([0, .99], () => resolvePromptReferences('!macro:Parent!', library));
  assert.equal(result.text, 'amber eyes, soft light');
  assert.deepEqual(ids(result), ['Parent', 'Inner']);
  assert.equal(expandPrompt(result.text, library), result.text);
});

test('unselected missing chunks and cycles are ignored, selected failures are rejected', () => {
  const library = [row('Loop', '!macro:Loop!')];
  const text = '||plain|!macro:Missing!|!macro:Loop!||';
  assert.deepEqual(withRandom([0], () => resolvePromptReferences(text, library)), { text: 'plain', chunks: [] });
  assert.throws(() => withRandom([.4], () => resolvePromptReferences(text, library)), /找不到/);
  assert.throws(() => withRandom([.9], () => resolvePromptReferences(text, library)), /循环引用/);
});

test('retired aliases lead to live chunks and repeated references choose independently but deduplicate identity', () => {
  const library = [row('Old', '!macro:Live!', { retired: true }), row('Live', '||red|blue||')];
  const result = withRandom([0, .99], () => resolvePromptReferences('!macro:Old!, !macro:Live!', library));
  assert.equal(result.text, 'red, blue');
  assert.deepEqual(ids(result), ['Live']);
  assert.equal(result.chunks[0].retired, undefined);
  assert.notEqual(result.chunks[0], library[1]);
});

test('weights and literal tags survive, legacy chunks get deterministic ids without library mutation', () => {
  const library = [{ name: 'Legacy', text: '{{hatsune_miku}}, 1.2::sky::' }];
  const first = resolvePromptReferences('[!macro:Legacy!]', library);
  const next = resolvePromptReferences('!macro:Legacy!', library);
  assert.equal(first.text, '[{{hatsune_miku}}, 1.2::sky::]');
  assert.match(first.chunks[0].id, /^block-/);
  assert.equal(first.chunks[0].id, next.chunks[0].id);
  assert.equal(library[0].id, undefined);
});

test('resolution enforces depth, input/output length and cycle limits', () => {
  const library = Array.from({ length: 17 }, (_, i) => row('N' + i, i === 16 ? 'leaf' : '!macro:N' + (i + 1) + '!'));
  assert.throws(() => resolvePromptReferences('!macro:N0!', library), /嵌套过深/);
  assert.equal(resolvePromptReferences('!macro:N1!', library).text, 'leaf');
  assert.throws(() => resolvePromptReferences('a'.repeat(100001), []), /内容过长/);
  assert.throws(() => resolvePromptReferences('!macro:Long!!macro:Long!', [row('Long', 'a'.repeat(50001))]), /过长/);
  assert.equal(resolvePromptReferences('a'.repeat(100000), []).text.length, 100000);
});

test('expressions cannot be assembled across chunk boundaries and rerolled by later processing', () => {
  assert.throws(() => resolvePromptReferences('!macro:Start!red|blue||', [row('Start', '||')]), /不要跨词块拼接/);
  assert.throws(() => resolvePromptReferences('!macro:Start!Other!', [row('Start', '!macro:')]), /不要跨词块拼接/);
});
