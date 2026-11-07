import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { importCatalog } from '../scripts/import-catalog.mjs';

async function fixture(t) {
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(join(parent, 'folio-catalog-test-'));
  t.after(async () => {
    if (dirname(directory) === parent && basename(directory).startsWith('folio-catalog-test-'))
      await rm(directory, { recursive: true, force: true });
  });
  const source = join(directory, 'source');
  const target = join(directory, 'target');
  await mkdir(join(source, 'covers'), { recursive: true });
  await mkdir(target);
  const artistRow = ['ink maker', 'Ink Maker', 'ink maker', '', '', 1, 'https://example.invalid/private-url', 'covers/ink.webp'];
  const write = (name, value) => writeFile(join(source, name + '.json'), JSON.stringify(value));
  await write('tags', [['ink drawing', '墨画', 0]]);
  await write('artist', [artistRow]);
  await write('character', [['clock keeper', 'Clock Keeper', 'clock keeper']]);
  await writeFile(join(source, 'covers/ink.webp'), Buffer.from('RIFFsampleWEBP'));
  await writeFile(join(source, 'search-worker.js'), 'throw Error("must never be imported")');
  return { source, target, artistRow, write };
}

test('catalog import preserves source, publishes local covers and omits remote links, scripts and unrelated files', async (t) => {
  const { source, target, artistRow } = await fixture(t);
  const result = await importCatalog(source, target);
  const base = join(target, 'local', result.edition);
  assert.equal(result.covers, 1);
  assert.deepEqual(JSON.parse(await readFile(join(target, 'local/current.json'))), { edition: result.edition });
  assert.deepEqual(JSON.parse(await readFile(join(source, 'artist.json')))[0], artistRow);
  const [row] = JSON.parse(await readFile(join(base, 'artist.json')));
  assert.equal(row[6], '');
  assert.equal(row[7], 'covers/ink.webp');
  assert.deepEqual(await readFile(join(base, row[7])), await readFile(join(source, row[7])));
  assert.deepEqual(JSON.parse(await readFile(join(base, 'character-details.json'))), {});
  assert.deepEqual(JSON.parse(await readFile(join(base, 'related-tags.json'))), {});
  await assert.rejects(stat(join(base, 'search-worker.js')), { code: 'ENOENT' });
});

test('reimport switches editions without disrupting readers and malformed input leaves the pointer intact', async (t) => {
  const { source, target, artistRow, write } = await fixture(t);
  const old = await importCatalog(source, target);
  await write('character-details', { 'clock keeper': ['rolled sleeves'] });
  await write('related-tags', { 'ink drawing': ['line art'] });
  await write('artist', [[...artistRow.slice(0, 7), 'covers/missing.png']]);
  const next = await importCatalog(source, target);
  const root = join(target, 'local');
  const nextRoot = join(root, next.edition);
  assert.notEqual(old.edition, next.edition);
  assert.equal(next.missingCovers, 1);
  assert.deepEqual(JSON.parse(await readFile(join(nextRoot, 'character-details.json'))), { 'clock keeper': ['rolled sleeves'] });
  assert.deepEqual(JSON.parse(await readFile(join(nextRoot, 'related-tags.json'))), { 'ink drawing': ['line art'] });
  assert.equal(JSON.parse(await readFile(join(nextRoot, 'artist.json')))[0][7], '');
  assert.equal(JSON.parse(await readFile(join(root, old.edition, 'artist.json')))[0][7], 'covers/ink.webp');
  await write('artist', [[...artistRow.slice(0, 7), 'covers/../../outside.webp']]);
  await assert.rejects(importCatalog(source, target), /封面路径/);
  await write('artist', [{ name: 123 }]);
  await assert.rejects(importCatalog(source, target), /记录格式/);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'current.json'))), { edition: next.edition });
});
