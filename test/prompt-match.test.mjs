import test from 'node:test';
import assert from 'node:assert/strict';
import { foldExactChunks } from '../public/prompt-match.js';

const block = (name, text) => ({ name, text });
const basic = [block('Look', 'red hair, green eyes')];

test('folds complete contiguous exact tags and preserves the untouched prompt', () => {
  const folded = foldExactChunks('portrait, red hair, green eyes, soft light', basic);
  assert.equal(folded.value, 'portrait, !macro:Look!, soft light');
  assert.deepEqual(
    folded.matches.map(({ name, from, to }) => ({ name, from, to })),
    [{ name: 'Look', from: 10, to: 30 }],
  );
  assert.equal(foldExactChunks('green eyes, red hair', basic), null);
  assert.equal(foldExactChunks('red hair,green eyes', basic), null);
  assert.equal(foldExactChunks('Red hair, green eyes', basic), null);
});

test('does not match substrings, partial tags, or escaped separators', () => {
  for (const text of [
    'very red hair, green eyes',
    'red hair, green eyeshadow',
    'red hair\\, green eyes',
    'red hair (green eyes)',
  ])
    assert.equal(foldExactChunks(text, basic), null, text);
  assert.equal(foldExactChunks('hatsune miku (vocaloid)', [block('Series', 'vocaloid')]), null);
  assert.equal(
    foldExactChunks('name\\, detail, end', [block('Escaped', 'name\\, detail')]).value,
    '!macro:Escaped!, end',
  );
});

test('supports complete emphasis wrappers and preserves outside weights verbatim', () => {
  for (const [source, expected] of [
    ['{{red hair, green eyes}}', '{{!macro:Look!}}'],
    ['[red hair, green eyes]', '[!macro:Look!]'],
    ['1.25::red hair, green eyes::', '1.25::!macro:Look!::'],
    ['-1.5::{red hair, green eyes}, end::', '-1.5::{!macro:Look!}, end::'],
    ['{warm, red hair, green eyes, cold}', '{warm, !macro:Look!, cold}'],
  ])
    assert.equal(foldExactChunks(source, basic).value, expected);
  assert.equal(foldExactChunks('red hair, green eyes', [block('Weighted', '{red hair, green eyes}')]), null);
  assert.equal(
    foldExactChunks('1.2::{red hair}, green eyes::', [block('Weighted', '1.2::{red hair}, green eyes::')])
      .value,
    '!macro:Weighted!',
  );
  assert.equal(foldExactChunks('{red hair, green eyes', basic), null);
});

test('longest bodies beat overlapping shorter blocks and duplicate bodies choose the first candidate', () => {
  const candidates = [
    block('Short', 'red hair'),
    block('First', 'red hair, green eyes'),
    block('Duplicate', 'red hair, green eyes'),
  ];
  assert.equal(
    foldExactChunks('red hair, green eyes, red hair', candidates).value,
    '!macro:First!, !macro:Short!',
  );
  assert.equal(
    foldExactChunks('a, b, c, d', [block('Earlier', 'a, b'), block('Longer', 'b, c, d')]).value,
    'a, !macro:Longer!',
  );
});

test('existing macros and random alternatives remain opaque, including weighted random groups', () => {
  const text =
    '!macro:red hair, green eyes!, ||red hair, green eyes|other||, {||red hair, green eyes|other||}, red hair, green eyes';
  assert.equal(
    foldExactChunks(text, basic).value,
    '!macro:red hair, green eyes!, ||red hair, green eyes|other||, {||red hair, green eyes|other||}, !macro:Look!',
  );
  assert.equal(foldExactChunks('||red hair, green eyes', basic), null);
  assert.equal(foldExactChunks('!macro:red hair, green eyes', basic), null);
  assert.equal(foldExactChunks('red hair, green eyes', [block('Unsafe', '||red hair|green eyes||')]), null);
});

test('trailing commas and newlines never concatenate a macro with a subsequent tag', () => {
  const candidates = [block('Tail', '  red hair, green eyes,\n ')];
  assert.equal(foldExactChunks('red hair, green eyes, sky', candidates).value, '!macro:Tail!, sky');
  assert.equal(foldExactChunks('red hair, green eyes\nsky', candidates).value, '!macro:Tail!\nsky');
  assert.equal(foldExactChunks('  red hair, green eyes  ', candidates).value, '  !macro:Tail!  ');
  assert.equal(foldExactChunks('red hair, green eyessky', candidates), null);
});

test('caret offsets map through multiple replacements and preserve wrapper boundaries', () => {
  const text = '{red hair, green eyes}, tail, red hair, green eyes';
  const folded = foldExactChunks(text, basic);
  assert.equal(folded.mapPosition(0), 0);
  assert.equal(folded.mapPosition(1), 1);
  assert.equal(folded.mapPosition(5), 13);
  assert.equal(folded.mapPosition(21), 13);
  assert.equal(folded.mapPosition(text.indexOf('tail')), folded.value.indexOf('tail'));
  assert.equal(folded.mapPosition(text.length), folded.value.length);
  assert.equal(folded.mapPosition(9999), folded.value.length);
  assert.equal(folded.mapPosition(-5), 0);
  assert.equal(folded.matches.length, 2);
});

test('long real-length blocks match fully, never only their initial prefix', () => {
  const body = Array.from(
    { length: 800 },
    (_, i) => `${i % 3 ? '1.2::' : '{'}tag ${i}${i % 3 ? '::' : '}'}`,
  ).join(',\n');
  const result = foldExactChunks(body + ',\nending', [block('Long', body + ',\n')]);
  assert.equal(result.value, '!macro:Long!,\nending');
  assert.equal(foldExactChunks(body.slice(0, -5), [block('Long', body)]), null);
});
