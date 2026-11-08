import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { createArchiveZip } from '../public/archive-zip.js';

function readEntries(buffer) {
  const end = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(end), 0x06054b50);
  const count = buffer.readUInt16LE(end + 10);
  const start = buffer.readUInt32LE(end + 16);
  assert.equal(start + buffer.readUInt32LE(end + 12), end);
  let central = start;
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    assert.equal(buffer.readUInt32LE(central), 0x02014b50);
    assert.equal(buffer.readUInt16LE(central + 8), 0x0800);
    assert.equal(buffer.readUInt16LE(central + 10), 0);
    const nameLength = buffer.readUInt16LE(central + 28);
    const filename = buffer.toString('utf8', central + 46, central + 46 + nameLength);
    const offset = buffer.readUInt32LE(central + 42);
    assert.equal(buffer.readUInt32LE(offset), 0x04034b50);
    assert.equal(buffer.toString('utf8', offset + 30, offset + 30 + nameLength), filename);
    const content = offset + 30 + nameLength + buffer.readUInt16LE(offset + 28);
    const bytes = buffer.subarray(content, content + buffer.readUInt32LE(central + 24));
    assert.equal(crc32(bytes), buffer.readUInt32LE(central + 16));
    entries.set(filename, bytes);
    central += 46 + nameLength + buffer.readUInt16LE(central + 30) + buffer.readUInt16LE(central + 32);
  }
  assert.equal(central, end);
  return entries;
}

test('ZIP exports ordered, collision-safe originals and a minimal Unicode tag manifest', async () => {
  const content = Buffer.alloc(590000, 0x1f);
  const works = {
    a: { filename: '../../人物.png', blob: new Blob([content], { type: 'image/png' }), galleryTags: ['插画'] },
    b: { filename: 'D:\\old\\人物.png', blob: new Blob([Buffer.of(1, 2, 3)], { type: 'image/png' }), settings: { seed: 42 } },
  };
  const reads = [], progress = [];
  const zip = await createArchiveZip([{ id: 'b' }, { id: 'a' }, { id: 'b' }], async (id) => {
    reads.push(id);
    return works[id];
  }, { onProgress: (done, total) => progress.push([done, total]) });
  assert.equal(zip.type, 'application/zip');
  const entries = readEntries(Buffer.from(await zip.arrayBuffer()));
  assert.deepEqual([...entries.keys()], ['001-人物.png', '002-人物.png', 'tags.json']);
  assert.deepEqual(entries.get('001-人物.png'), Buffer.of(1, 2, 3));
  assert.deepEqual(entries.get('002-人物.png'), content);
  assert.deepEqual(JSON.parse(entries.get('tags.json')), [
    { file: '001-人物.png', tags: [] }, { file: '002-人物.png', tags: ['插画'] },
  ]);
  assert.deepEqual(reads, ['b', 'a']);
  assert.deepEqual(progress, [[0, 2], [1, 2], [2, 2]]);
});

test('ZIP aborts incomplete exports for empty selections, missing originals or cancellation', async () => {
  await assert.rejects(createArchiveZip([], () => assert.fail()), /选择/);
  await assert.rejects(createArchiveZip([{ id: 'deleted' }], () => undefined), /原图/);
  const controller = new AbortController(), seen = [];
  await assert.rejects(createArchiveZip([{ id: 1 }, { id: 2 }], (id) => {
    seen.push(id);
    return { blob: new Blob(['image']) };
  }, { signal: controller.signal, onProgress: (done) => { if (done) controller.abort(); } }), { name: 'AbortError' });
  assert.deepEqual(seen, [1]);
});
