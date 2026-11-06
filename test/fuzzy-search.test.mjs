import test from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyScore, searchItems } from '../public/fuzzy-search.js';

test('archive search supports normalized tags, multiple terms, substrings and small typos', () => {
  assert(fuzzyScore('silver_hair, Blue_Eyes, moonlight', 'slver blue') >= 0);
  assert(fuzzyScore('ＡＢＣ, 银发少女, 蓝色眼睛', 'abc 银发') >= 0);
  assert(fuzzyScore('silver hair, blue eyes', 'eyes hair') >= 0);
  assert.equal(fuzzyScore('silver hair, blue eyes', 'red hair'), -1);
  assert.equal(fuzzyScore('', 'hair'), -1);
  assert.equal(fuzzyScore('long hair', 'ox'), -1);
});

test('exact search ranks before typo matches, ties stay chronological, negative text is excluded', () => {
  const items = [
    { id: 1, prompt: 'slver hair', negative: 'garden' },
    { id: 2, prompt: 'silver hair' },
    { id: 3, prompt: 'silver hair' },
  ];
  const field = (item) => item.prompt;
  assert.deepEqual(searchItems(items, 'silver', field).map((item) => item.id), [2, 3, 1]);
  assert.deepEqual(searchItems(items, 'garden', field), []);
  assert.deepEqual(searchItems(items, '', field), items);
  assert.deepEqual(items.map((item) => item.id), [1, 2, 3]);
});
