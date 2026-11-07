import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inkRuns } from '../public/prompt-ink.js';
import { weightSelectedTags } from '../public/prompt-weight.js';

const numeric = { numeric: true, negative: true };
const increase = weight => Math.round((weight + 0.1) * 100) / 100;

function apply(text, start, end, nextWeight = increase, cap = numeric) {
  const edit = weightSelectedTags(text, start, end, nextWeight, cap);
  assert.ok(edit);
  const value = text.slice(0, edit.from) + edit.replacement + text.slice(edit.to);
  assert.ok(edit.selectedFrom >= edit.from && edit.selectedTo <= edit.from + edit.replacement.length);
  assert.ok(edit.selectedFrom < edit.selectedTo);
  return { value, ...edit };
}

function weights(text, model) {
  return inkRuns(text, model)
    .filter(part => ['tag', 'macro'].includes(part.kind) && part.value.trim())
    .map(part => [part.value.trim(), Number(part.weight.toFixed(6))]);
}

test('a selection starting and ending inside tags adjusts complete tags and repeats on the same group', () => {
  const text = '1girl, solo, blue eyes';
  const first = apply(text, 3, text.indexOf('solo') + 2);
  assert.deepEqual(weights(first.value), [['1girl', 1.1], ['solo', 1.1], ['blue eyes', 1]]);
  const second = apply(first.value, first.selectedFrom, first.selectedTo);
  assert.deepEqual(weights(second.value), [['1girl', 1.2], ['solo', 1.2], ['blue eyes', 1]]);
});

test('single partial tags expand; a boundary comma or whitespace never selects the following tag', () => {
  const text = 'soft light, blue sky';
  for (const end of [5, text.indexOf(','), text.indexOf(',') + 1, text.indexOf('blue')]) {
    assert.deepEqual(weights(apply(text, 2, end).value), [['soft light', 1.1], ['blue sky', 1]]);
  }
  assert.equal(weightSelectedTags(text, text.indexOf(','), text.indexOf('blue'), increase, numeric), null);
});

test('each selected tag increments from its own existing weight', () => {
  const text = '1.5::red hair::，-0.5::blue eyes::、hat';
  const edit = apply(text, text.indexOf('hair'), text.indexOf('eyes') + 1);
  assert.deepEqual(weights(edit.value), [['red hair', 1.6], ['blue eyes', -0.4], ['hat', 1]]);
  assert.ok(edit.value.includes('，') && edit.value.endsWith('、hat'));
});

test('changing the middle of a shared weight group preserves its neighbours', () => {
  const text = '1.5::red hair, green eyes, boots::, skirt';
  const edit = apply(text, text.indexOf('green') + 1, text.indexOf('eyes') + 2);
  assert.deepEqual(weights(edit.value), [['red hair', 1.5], ['green eyes', 1.6], ['boots', 1.5], ['skirt', 1]]);
  const again = apply(edit.value, edit.selectedFrom, edit.selectedTo);
  assert.deepEqual(weights(again.value), [['red hair', 1.5], ['green eyes', 1.7], ['boots', 1.5], ['skirt', 1]]);
});

test('role separators stay usable and punctuation inside a literal tag or a macro stays intact', () => {
  const text = 'name\\, detail, !macro:Look, A!\n|\nblue eyes, hat';
  const edit = apply(text, text.indexOf('detail') + 1, text.indexOf('blue') + 1);
  const [base, role] = edit.value.split('|');
  assert.deepEqual(weights(base), [['name', 1.1], ['\\,', 1.1], ['detail', 1.1], ['!macro:Look, A!', 1.1]]);
  assert.deepEqual(weights(role), [['blue eyes', 1.1], ['hat', 1]]);
  assert.ok(edit.value.includes('\n|\n'));
});

test('V3 brace weights adjust whole tags and retain untouched weights', () => {
  const text = '{smile, blush}, blue eyes';
  const edit = apply(text, text.indexOf('blush') + 1, text.indexOf('blush') + 3,
    weight => weight * 1.05, { numeric: false, negative: false });
  assert.deepEqual(weights(edit.value, 'nai-diffusion-3'), [['smile', 1.05], ['blush', 1.1025], ['blue eyes', 1]]);
  assert.ok(!edit.value.includes('::'));
});
