import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const workerSource = await readFile(
  new URL('../public/catalog-data/search-worker.js', import.meta.url),
  'utf8',
);
const dataRoot = new URL('../public/catalog-data/', import.meta.url);
const clone = (value) => JSON.parse(JSON.stringify(value));

function harness(fetchFile = async (name) => JSON.parse(await readFile(new URL(name, dataRoot), 'utf8')), search = '') {
  const messages = [];
  const requests = [];
  const self = {
    location: { href: 'https://local.test/catalog-data/search-worker.js' + search },
    postMessage: (data) => messages.push(clone(data)),
  };
  runInNewContext(workerSource, {
    self,
    URL,
    fetch: async (url) => {
      assert.equal(url.origin, 'https://local.test');
      const name = url.pathname.split('/').at(-1);
      requests.push(name);
      return { ok: true, json: () => fetchFile(name, url) };
    },
  });
  return {
    messages,
    requests,
    async send(data) {
      await self.onmessage({ data });
      return messages.find((message) => message.id === data.id);
    },
  };
}

test('bundled characters resolve exact canonical and aliases through NAI weights, preserving parenthesized names', async () => {
  const h = harness();
  const found = await h.send({
    id: 1,
    kind: 'exact-characters',
    texts: [
      '{{1.25::character:IRIS_(PAPER_QUAY)::}}, 1girl, long_hair, blue eyes, iris_(paper_quay)',
      '[character:mira_lensmaker] | +.8::teo_(paper_quay)::\ncharacter:ada_clockmaker',
    ],
  });
  assert.deepEqual(
    found.characters.map((item) => item.id),
    ['tag:iris_(paper_quay)', 'tag:mira_(paper_quay)', 'tag:teo_(paper_quay)', 'tag:ada_(paper_quay)'],
  );
  assert.equal(found.characters[0].name, '鸢尾 · 测星员');
  assert.deepEqual(h.requests, ['character.json']);
  const repeated = await h.send({ id: 2, kind: 'exact-characters', texts: ['iris the surveyor, mira (paper quay)'] });
  assert.equal(repeated.characters.length, 2);
  assert.deepEqual(h.requests, ['character.json']);
});

test('identity lookup does not infer characters from partial names, series, translations, or general descriptions', async () => {
  const h = harness(async () => [
    [
      'hatsune miku',
      'Hatsune Miku',
      'hatsune miku, vocaloid',
      '初音未来',
      'Vocaloid',
      '',
      '',
      '',
      'miku hatsune',
    ],
  ]);
  const result = await h.send({
    id: 1,
    kind: 'exact-characters',
    texts: [
      'miku, hatsune, vocaloid, 初音未来, 1girl, long hair, artist:hatsune miku, hatsune miku costume, !macro:hatsune miku!',
    ],
  });
  assert.deepEqual(result.characters, []);
  const alias = await h.send({ id: 2, kind: 'exact-characters', texts: ['character:{{miku_hatsune}}'] });
  assert.deepEqual(alias.characters, [{ id: 'tag:hatsune_miku', name: '初音未来' }]);
});

test('ambiguous aliases are skipped while canonical character names always win', async () => {
  const row = (name, aliases) => [name, '', '', '', '', '', '', '', aliases];
  const h = harness(async () => [row('alice (one)', 'alice|bob (two)'), row('bob (two)', 'alice')]);
  const result = await h.send({ id: 1, kind: 'exact-characters', texts: ['alice, bob (two)'] });
  assert.deepEqual(result.characters, [{ id: 'tag:bob_(two)', name: 'bob (two)' }]);
});

test('character jobs never supersede each other or interfere with suggestion stale handling', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = harness(async (name) => {
    await gate;
    return name === 'tags.json' ? [['long hair', '', 0]] : [['hatsune miku', '', '', '', '', '', '', '', '']];
  });
  const jobs = [
    h.send({ id: 1, kind: 'tags', query: 'l', channel: 'suggest' }),
    h.send({ id: 2, kind: 'exact-characters', texts: ['hatsune_miku'], channel: 'suggest' }),
    h.send({ id: 3, kind: 'tags', query: 'long', channel: 'suggest' }),
    h.send({ id: 4, kind: 'exact-characters', texts: ['hatsune miku'], channel: 'suggest' }),
  ];
  release();
  const [old, first, latest, second] = await Promise.all(jobs);
  assert.equal(old.stale, true);
  assert.deepEqual(latest.results, [['long hair', '', 0]]);
  assert.deepEqual(first.characters, second.characters);
  assert.equal(first.characters[0].id, 'tag:hatsune_miku');
  assert.deepEqual(h.requests.sort(), ['character.json', 'tags.json']);
});

test('missing or corrupt index reports a recoverable error and a subsequent request retries', async () => {
  let failures = 2;
  const h = harness(async () => {
    if (failures-- === 2) throw new Error('missing file');
    if (failures === 0) return { malformed: true };
    return [['frieren', '', '', '芙莉莲', '', '', '', '', '']];
  });
  for (const id of [1, 2]) {
    const failed = await h.send({ id, kind: 'exact-characters', texts: ['frieren'] });
    assert.equal(failed.code, 'CHARACTER_INDEX_UNAVAILABLE');
    assert.match(failed.error, /本地角色索引/);
  }
  const good = await h.send({ id: 3, kind: 'exact-characters', texts: ['frieren'] });
  assert.deepEqual(good.characters, [{ id: 'tag:frieren', name: '芙莉莲' }]);
  assert.equal(h.requests.length, 3);
});

test('blank and invalid captions need no character index', async () => {
  const h = harness();
  const result = await h.send({ id: 1, kind: 'exact-characters', texts: ['', null, 123, '{{::}}'] });
  assert.deepEqual(result.characters, []);
  assert.deepEqual(h.requests, []);
});

test('a selected private edition reads all indexes from its own offline directory', async () => {
  const edition = 'fa0dc5fd-3410-44ba-8d4a-45663ac0136b';
  const h = harness(async (name, url) => {
    assert.equal(url.pathname, '/catalog-data/local/' + edition + '/' + name);
    return name === 'character-details.json' ? { iris: ['brass telescope'] } : [['iris', 'Iris']];
  }, '?edition=' + edition);
  const found = await h.send({ id: 1, kind: 'character', query: 'iris', includeDetails: true });
  assert.deepEqual(found.details.iris, ['brass telescope']);
});

test('character picker supplements only its page with verified local appearance tags', async () => {
  const h = harness();
  const result = await h.send({
    id: 1,
    kind: 'character',
    query: 'iris (paper quay)',
    limit: 1,
    includeDetails: true,
    channel: 'picker',
  });
  assert.equal(result.results[0][0], 'iris (paper quay)');
  assert(result.details['iris (paper quay)'].includes('brass telescope'));
  assert.deepEqual(Object.keys(result.details), ['iris (paper quay)']);
  assert.deepEqual(h.requests, ['character.json', 'character-details.json']);
});

test('missing appearance supplement leaves canonical picker results usable and does not affect exact identity', async () => {
  const h = harness(async (name) => {
    if (name === 'character-details.json') throw Error('missing');
    return [['frieren', 'Frieren', 'frieren', '芙莉莲', '', 1, '', '', '']];
  });
  const result = await h.send({ id: 1, kind: 'character', includeDetails: true, channel: 'picker' });
  assert.equal(result.results.length, 1);
  assert.equal(result.detailsUnavailable, true);
  const identity = await h.send({ id: 2, kind: 'exact-characters', texts: ['frieren'] });
  assert.deepEqual(identity.characters, [{ id: 'tag:frieren', name: '芙莉莲' }]);
});
