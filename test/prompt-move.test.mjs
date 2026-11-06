import { test } from 'node:test';
import assert from 'node:assert/strict';
import { macroMoveSource, macroDropStops, moveMacro } from '../public/prompt-move.js';
import { inkRuns } from '../public/prompt-ink.js';

const source = (text, name = 'A', model) => {
  const macro = '!macro:' + name + '!';
  const weight = inkRuns(text, model).find((run) => run.value === macro)?.weight;
  return macroMoveSource(text, text.indexOf(macro), { weight, model });
};
const semantics = (text) =>
  inkRuns(text)
    .filter((run) => ['tag', 'macro'].includes(run.kind) && run.value.trim())
    .map((run) => [run.value.trim(), Number(run.weight.toFixed(9))])
    .sort((a, b) => a[0].localeCompare(b[0]));

test('dragging a separately weighted macro carries its original numeric wrapper and leaves other text intact', () => {
  const text = 'warm, 1.25::!macro:A!::, cold, !macro:B!';
  const moved = moveMacro(text, source(text), text.length);
  assert.equal(moved.value, 'warm, cold, !macro:B!, 1.25::!macro:A!::');
  assert.equal(moved.value.slice(moved.from, moved.to), '1.25::!macro:A!::');
  assert.deepEqual(semantics(moved.value), semantics(text));
});

test('brace and bracket wrappers move verbatim when they contain only this macro', () => {
  const text = 'warm, cold, {[!macro:A!]}';
  const moved = moveMacro(text, source(text), 0);
  assert.equal(moved.value, '{[!macro:A!]}, warm, cold');
  assert.deepEqual(semantics(moved.value), semantics(text));
});

test('extracting one macro from a shared numeric group preserves every effective weight', () => {
  const text = '1.5::{warm}, !macro:A!, cold::, end';
  const moved = moveMacro(text, source(text), text.length);
  assert.equal(moved.value, '1.5::{warm}, cold::, end, 1.5::!macro:A!::');
  assert.deepEqual(semantics(moved.value), semantics(text));
});

test('shared brace emphasis carries equivalent weight for modern and legacy models', () => {
  const text = '{{warm, !macro:A!, cold}}, end';
  const modern = moveMacro(text, source(text), text.length);
  assert.equal(modern.value, '{{warm, cold}}, end, 1.1025::!macro:A!::');
  assert.deepEqual(semantics(modern.value), semantics(text));
  const legacy = moveMacro(text, source(text, 'A', 'nai-diffusion-3'), text.length);
  assert.equal(legacy.value, '{{warm, cold}}, end, {{!macro:A!}}');
});

test('drop points do not split a tag, escaped separator, weighted group or macro', () => {
  const text = '!macro:A!, 1.4::blue, green::, name\\, detail, !macro:B!';
  const stops = macroDropStops(text);
  assert(!stops.includes(text.indexOf('green')));
  assert(!stops.includes(text.indexOf('detail')));
  assert.equal(moveMacro(text, source(text), text.indexOf('green')), null);
  const moved = moveMacro(text, source(text), text.indexOf('1.4'));
  assert.equal(moved, null); // Same position after removal of its trailing comma.
});

test('newline layout, duplicate macro atoms and unrelated prose survive a move', () => {
  const text = 'plain words\n!macro:A!\n!macro:B!\n!macro:A!';
  const moved = moveMacro(text, source(text, 'B'), 0);
  assert.equal(moved.value, '!macro:B!, plain words\n!macro:A!\n!macro:A!');
  assert.equal((moved.value.match(/!macro:A!/g) || []).length, 2);
});

test('zero and signed weights survive extraction from a shared group', () => {
  for (const weight of [0, -1.4]) {
    const text = `${weight}::warm, !macro:A!, cold::, end`;
    const moved = moveMacro(text, source(text), 0);
    assert.equal(moved.value, `${weight}::!macro:A!::, ${weight}::warm, cold::, end`);
    assert.deepEqual(semantics(moved.value), semantics(text));
  }
});

test('self-drops, incomplete groups and random alternatives cannot corrupt a prompt', () => {
  const text = '1.4::!macro:A!::, plain';
  const atom = source(text);
  assert.equal(moveMacro(text, atom, atom.from), null);
  assert.equal(moveMacro(text, atom, atom.to), null);
  assert.equal(source('{!macro:A!'), null);
  assert.equal(source('1.4::!macro:A!'), null);
  assert.equal(source('||!macro:A!|!macro:B!||'), null);
});
