import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
  },
});
function fixture(rows) {
  store.set('folio.prompt.chunks', JSON.stringify(rows));
  store.set('folio.prompt.imported.folio-starters.v1', '1');
}
fixture([]);
const { prepareChunkMerge, saveMergedChunk, expandChunks, saveChunk, referencedChunks, removeChunk } =
  await import('../public/chunks.js');
const read = () => JSON.parse(store.get('folio.prompt.chunks'));
const data = (text, name = '合并结果') => ({ name, category: '测试组合', text });

test('merged snapshots preserve source order, weights, repeated tags and literal random alternatives', () => {
  const originals = [
    { name: '嵌套', category: '笔触', text: '{line}, glow' },
    { name: '甲', category: '画风', text: '1.2::glow::,\n!macro:嵌套!, ||red|blue||, glow,' },
    { name: '乙', category: '场景', text: ',\nwhite hair\nblue eyes' },
  ];
  fixture(originals);
  const merge = prepareChunkMerge(['乙', '甲']);
  assert.deepEqual(
    merge.sources.map((source) => source.name),
    ['乙', '甲'],
  );
  assert.equal(merge.text, ',\nwhite hair\nblue eyes,\n1.2::glow::,\n{line}, glow, ||red|blue||, glow,');
  assert(!merge.text.includes('!macro:'));
  const name = saveMergedChunk(merge, data(merge.text));
  assert.equal(name, '合并结果');
  const savedSources = read().filter((row) => row.name !== name);
  assert.deepEqual(
    savedSources.map(({ name, category, text }) => ({ name, category, text })),
    originals,
  );
  const sourceIds = savedSources.map((row) => row.id);
  assert(sourceIds.every((id) => typeof id === 'string' && id.length > 0));
  assert.equal(new Set(sourceIds).size, originals.length);
  // The first write migrates legacy rows to stable IDs. Later writes must keep
  // those identities, as shared example images now link to the source blocks.
  saveChunk(name, data(merge.text));
  assert.deepEqual(
    read()
      .filter((row) => row.name !== name)
      .map((row) => row.id),
    sourceIds,
  );
  assert.equal(expandChunks('!macro:合并结果!', read()), merge.text);
  const stored = read().find((row) => row.name === name).text;
  assert.equal((stored.match(/glow/g) || []).length, 3);
  assert(stored.includes('||red|blue||'));
});

test('merge previews do not persist changes and boundary commas cannot join neighboring tags', () => {
  fixture([
    { name: 'A', text: 'first,' },
    { name: 'B', text: ', second' },
  ]);
  const before = store.get('folio.prompt.chunks');
  assert.equal(prepareChunkMerge(['A', 'B']).text, 'first,\nsecond');
  assert.equal(store.get('folio.prompt.chunks'), before);
  assert.throws(() => prepareChunkMerge(['A']), /至少两个/);
  assert.throws(() => prepareChunkMerge(['A', 'A']), /不同/);
});

test('saving refuses name conflicts, invalid names and sources deleted or changed in another tab', () => {
  const rows = [
    { name: 'A', text: 'alpha' },
    { name: 'B', text: 'beta' },
  ];
  fixture(rows);
  const merge = prepareChunkMerge(['A', 'B']);
  const unchanged = store.get('folio.prompt.chunks');
  for (const name of ['', 'A', 'x'.repeat(61), 'bad!name'])
    assert.throws(() => saveMergedChunk(merge, data(merge.text, name)));
  assert.equal(store.get('folio.prompt.chunks'), unchanged);
  fixture([{ ...rows[0], retired: true }, rows[1]]);
  assert.throws(() => saveMergedChunk(merge, data(merge.text)), /其他窗口更改/);
  fixture([rows[0], { ...rows[1], text: 'changed' }]);
  assert.throws(() => saveMergedChunk(merge, data(merge.text)), /其他窗口更改/);
  assert.equal(read().length, 2);
});

test('nested source changes are detected and edits can add macros that are flattened on save', () => {
  const rows = [
    { name: 'A', text: '!macro:Inner!' },
    { name: 'B', text: 'beta' },
    { name: 'Inner', text: 'alpha' },
  ];
  fixture(rows);
  const merge = prepareChunkMerge(['A', 'B']);
  fixture([rows[0], rows[1], { ...rows[2], text: 'different' }]);
  assert.throws(() => saveMergedChunk(merge, data(merge.text)), /其他窗口更改/);
  fixture(rows);
  saveMergedChunk(merge, data(merge.text + ',\n!macro:Inner!'));
  assert.equal(read()[0].text, 'alpha,\nbeta,\nalpha');
});

test('oversized, broken and cyclic merged contents are rejected without writing the library', () => {
  fixture([
    { name: 'A', text: 'x'.repeat(60000) },
    { name: 'B', text: 'y'.repeat(60000) },
  ]);
  assert.throws(() => prepareChunkMerge(['A', 'B']), /超过/);
  fixture([
    { name: 'A', text: '!macro:A!' },
    { name: 'B', text: 'beta' },
  ]);
  assert.throws(() => prepareChunkMerge(['A', 'B']), /循环引用/);
  fixture([
    { name: 'A', text: '!macro:missing!' },
    { name: 'B', text: 'beta' },
  ]);
  assert.throws(() => prepareChunkMerge(['A', 'B']), /找不到/);
});

test('reference tracking follows nested macros across prompt fields once per live block', () => {
  const library = [
    { id: 'outer', name: '外层', text: '!macro:角色!, !macro:光线!' },
    { id: 'character', name: '角色', text: 'silver hair, !macro:光线!', kind: 'oc', atlasId: 'oc-cover' },
    { id: 'light', name: '光线', text: 'soft lighting' },
  ];
  const referenced = referencedChunks(
    ['1.2::!macro:外层!::', '!macro:角色!, !macro:光线!, !macro:missing!'],
    library,
  );
  assert.deepEqual(
    referenced.map((row) => row.id),
    ['outer', 'character', 'light'],
  );
  assert.equal(referenced[1].atlasId, 'oc-cover');
  assert.equal(expandChunks('!macro:外层!', library), 'silver hair, soft lighting, soft lighting');
});

test('matching plain tags and names never opt into automatic block examples', () => {
  const library = [
    { id: 'hair', name: 'silver hair', text: 'silver hair, amber eyes' },
    { id: 'light', name: '光线', text: 'soft lighting' },
  ];
  assert.deepEqual(
    referencedChunks(['silver hair, amber eyes', '光线, soft lighting', '!macro:missing!'], library),
    [],
  );
  assert.deepEqual(
    referencedChunks('!macro:silver hair!', library).map((row) => row.id),
    ['hair'],
  );
});

test('renaming a block preserves its identity and atlas link while archived references resolve', () => {
  fixture([
    {
      id: 'stable-oc',
      name: 'OC · 原名',
      category: 'OC',
      text: 'silver hair',
      kind: 'oc',
      atlasId: 'atlas-oc',
    },
    { id: 'scene', name: '场景', category: '场景', text: '!macro:OC · 原名!, moonlight' },
  ]);
  saveChunk('OC · 原名', { name: 'OC · 新名', category: 'OC', text: 'silver hair, amber eyes' });
  const renamed = read().find((row) => row.name === 'OC · 新名');
  assert.deepEqual(
    { id: renamed.id, atlasId: renamed.atlasId, kind: renamed.kind },
    { id: 'stable-oc', atlasId: 'atlas-oc', kind: 'oc' },
  );
  assert.equal(expandChunks('!macro:OC · 原名!'), 'silver hair, amber eyes');
  assert.equal(expandChunks('!macro:场景!'), 'silver hair, amber eyes, moonlight');
  assert.deepEqual(
    referencedChunks('!macro:OC · 原名!').map((row) => row.id),
    ['stable-oc'],
  );
  assert.equal(read().find((row) => row.name === '场景').id, 'scene');
});

test('retired alias chains stay expandable but removed snapshots are not live references', () => {
  fixture([{ id: 'stable-block', name: '第一版', category: '画风', text: 'watercolor, soft colors' }]);
  saveChunk('第一版', { name: '第二版', category: '画风', text: 'watercolor, soft colors' });
  saveChunk('第二版', { name: '第三版', category: '画风', text: 'watercolor, soft colors' });
  assert.equal(
    expandChunks('!macro:第一版!, !macro:第二版!'),
    'watercolor, soft colors, watercolor, soft colors',
  );
  assert.deepEqual(
    referencedChunks(['!macro:第一版!', '!macro:第二版!', '!macro:第三版!']).map((row) => row.id),
    ['stable-block'],
  );
  removeChunk('第三版');
  assert.equal(expandChunks('!macro:第一版!'), 'watercolor, soft colors');
  assert.deepEqual(referencedChunks(['!macro:第一版!', '!macro:第三版!']), []);
});
