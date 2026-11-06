import { test } from 'node:test';
import assert from 'node:assert/strict';

const storage = new Map([
  ['folio.prompt.chunks', '[]'],
  ['folio.prompt.imported.folio-starters.v1', '1'],
]);
let rejectWrite = false;
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key) => storage.get(key) ?? null,
    setItem(key, value) {
      if (rejectWrite) throw new DOMException('Storage unavailable', 'QuotaExceededError');
      storage.set(key, String(value));
    },
  },
});
const { saveChunk, removeChunk, listChunks, readChunks, expandChunks, watchChunks } =
  await import('../public/chunks.js');
const read = () => JSON.parse(storage.get('folio.prompt.chunks'));

test('Atlas deletion matches a stable block identity, not a reused display name', () => {
  saveChunk('', { id: 'new-id', name: 'Same title', text: 'new content', category: '素材' });
  const before = storage.get('folio.prompt.chunks');
  assert.equal(removeChunk('Same title', 'old-deleted-id'), false);
  assert.equal(storage.get('folio.prompt.chunks'), before);
  assert.equal(listChunks().find((chunk) => chunk.id === 'new-id').text, 'new content');
});

test('retiring a bound block preserves archived macro text and expands active references', () => {
  saveChunk('', { id: 'bound-id', name: 'Bound example', text: 'silver hair, blue eyes', category: '画风' });
  saveChunk('', {
    id: 'parent-id',
    name: 'Parent recipe',
    text: 'scene, !macro:Bound example!',
    category: '组合',
  });
  let detail;
  const stop = watchChunks((event) => {
    detail = event.detail;
  });
  assert.equal(removeChunk('Bound example', 'bound-id'), true);
  stop();
  assert.equal(
    listChunks().some((chunk) => chunk.id === 'bound-id'),
    false,
  );
  assert.equal(expandChunks('!macro:Bound example!', read()), 'silver hair, blue eyes');
  assert.equal(listChunks().find((chunk) => chunk.id === 'parent-id').text, 'scene, silver hair, blue eyes');
  assert.deepEqual(detail, { from: '!macro:Bound example!', to: 'silver hair, blue eyes' });
});

test('failed local persistence leaves both the active block and its reference untouched', () => {
  saveChunk('', { id: 'protected-id', name: 'Protected OC', text: 'black hair, green eyes', category: 'OC' });
  const before = storage.get('folio.prompt.chunks');
  let notices = 0;
  const stop = watchChunks(() => {
    notices++;
  });
  rejectWrite = true;
  try {
    assert.throws(() => removeChunk('Protected OC', 'protected-id'), { name: 'QuotaExceededError' });
  } finally {
    rejectWrite = false;
    stop();
  }
  assert.equal(storage.get('folio.prompt.chunks'), before);
  assert.equal(notices, 0);
  assert.equal(listChunks().find((chunk) => chunk.id === 'protected-id').text, 'black hair, green eyes');
});

test('a stale Atlas snapshot cannot retire a newer body under the same block ID', () => {
  saveChunk('', { id: 'edited-id', name: 'Edited elsewhere', text: 'old body', category: 'OC' });
  const latest = read().map((chunk) => (chunk.id === 'edited-id' ? { ...chunk, text: 'new body' } : chunk));
  storage.set('folio.prompt.chunks', JSON.stringify(latest));
  assert.equal(removeChunk('Edited elsewhere', 'edited-id', 'old body'), false);
  assert.equal(read().find((chunk) => chunk.id === 'edited-id').text, 'new body');
  let notices = 0;
  const stop = watchChunks(() => {
    notices++;
  });
  assert.equal(readChunks().find((chunk) => chunk.id === 'edited-id').text, 'new body');
  stop();
  assert.equal(notices, 0, 'fresh reads must not start a cross-window synchronization loop');
});
