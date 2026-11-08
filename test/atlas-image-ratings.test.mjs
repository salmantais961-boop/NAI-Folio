import test from 'node:test';
import assert from 'node:assert/strict';
import { atlasImageMatches, trackStoredCover } from '../public/atlas-image-meta.js';
import { NSFW_RULES_VERSION } from '../public/nsfw-tags.js';

test('old cover ratings are refreshed from embedded META once and retain orphaned source hits', async () => {
  function chunk(type, value) {
    const body = Buffer.from(value), size = Buffer.alloc(4);
    size.writeUInt32BE(body.length);
    return Buffer.concat([size, Buffer.from(type), body, Buffer.alloc(4)]);
  }
  const blob = new Blob([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', Buffer.alloc(13)),
    chunk('tEXt', 'Software\0NovelAI'), chunk('tEXt', 'Description\0penis under clothes'),
    chunk('IEND', [])], { type: 'image/png' });
  let writes = 0;
  const entry = trackStoredCover({ blob, imageNsfwTags: [], prompt: 'unrelated template' }, async () => writes++);
  const [first, again] = await Promise.all([atlasImageMatches(entry), atlasImageMatches(entry)]);
  assert.ok(first.length > 0);
  assert.deepEqual(first, again);
  assert.equal(entry.imageNsfwVersion, NSFW_RULES_VERSION);
  assert.deepEqual(await atlasImageMatches(entry), first);
  assert.equal(writes, 1);
  assert.deepEqual(await atlasImageMatches({ blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    imageNsfwTags: ['naked'] }), ['naked']);
});
