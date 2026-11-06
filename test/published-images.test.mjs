import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

// A PNG can carry a full NovelAI recipe in its alpha plane even when it
// contains no text chunks. Publish display-only RGB copies of sample images.
for (const folder of ['../public/art/', '../docs/media/']) {
  const root = new URL(folder, import.meta.url);
  for (const name of (await readdir(root)).filter(file => file.endsWith('.png'))) {
    test(`public image ${name} contains only RGB picture data`, async () => {
      const bytes = await readFile(new URL(name, root));
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      let offset = 8;
      const chunks = [];
      while (offset < bytes.length) {
        const length = bytes.readUInt32BE(offset);
        const type = bytes.toString('ascii', offset + 4, offset + 8);
        chunks.push(type);
        if (type === 'IHDR') {
          assert.equal(length, 13);
          assert.equal(bytes[offset + 17], 2, 'only RGB images without an alpha plane are published');
        }
        offset += length + 12;
      }
      assert.equal(offset, bytes.length);
      assert.match(chunks.join(' '), /^IHDR (?:IDAT )+IEND$/);
    });
  }
}
