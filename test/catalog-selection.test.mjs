import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.window = { addEventListener() {} };
const { catalogSelection } = await import('../public/catalog.js');
const row = [
  'hatsune miku',
  'Hatsune Miku',
  'hatsune miku, vocaloid',
  '初音未来',
  'Vocaloid',
  103500,
  '',
  '',
  '',
  '虚拟歌姬',
];

test('character selections include provided appearance tags without inventing descriptions or duplicate tags', () => {
  const item = catalogSelection(row, 'character', [
    '1girl',
    'aqua hair',
    'twintails',
    'aqua_hair',
    'hatsune miku',
  ]);
  assert.equal(item.id, 'tag:hatsune_miku');
  assert.equal(item.name, '初音未来');
  assert.equal(item.prompt, 'hatsune miku, vocaloid, 1girl, aqua_hair, twintails');
  assert.deepEqual(item.tags, item.prompt.split(', '));
});

test('appearance switch off and missing source data preserve the exact original trigger', () => {
  assert.equal(catalogSelection(row, 'character', ['1girl', 'aqua hair'], false).prompt, row[2]);
  assert.equal(catalogSelection(row, 'character').prompt, row[2]);
  assert.deepEqual(catalogSelection(row, 'character').appearanceTags, []);
});

test('artist selection never adds character descriptions', () => {
  const artist = ['fuzichoco', 'Fuzichoco', 'fuzichoco', '', '', 860, ''];
  assert.equal(catalogSelection(artist, 'artist', ['blue eyes']).prompt, 'fuzichoco');
});
