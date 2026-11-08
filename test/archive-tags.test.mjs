import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkTags, archiveSearchText } from '../public/archive-tags.js';
import { searchItems } from '../public/fuzzy-search.js';

test('archive tags retain display names and multiword tags while deduplicating mixed input', () => {
  assert.deepEqual(parseWorkTags(' OC，oc、ＯＣ\nLoose   Ink, loose ink, 冬景， '), [
    'OC', 'Loose Ink', '冬景',
  ]);
  assert.deepEqual(parseWorkTags(['OC', '冬景', 'oc, Watercolor']), ['OC', '冬景', 'Watercolor']);
  assert.deepEqual(parseWorkTags('，,\n'), []);
});

test('archive search can combine user tags, main prompts and active character prompts', () => {
  const legacy = { prompt: 'winter light' };
  const tagged = {
    prompt: 'winter light', galleryTags: ['Illustration', '插画'],
    settings: { characters: [{ prompt: 'blue eyes' }, { prompt: 'ribbon', enabled: false }] },
  };
  const works = [legacy, tagged];
  assert.deepEqual(searchItems(works, 'winter', archiveSearchText), works);
  assert.deepEqual(searchItems(works, '插画 winter eyes', archiveSearchText), [tagged]);
  assert.deepEqual(searchItems(works, 'ilustration', archiveSearchText), [tagged]);
  assert.deepEqual(searchItems(works, 'ribbon', archiveSearchText), []);
  assert.equal(tagged.prompt, 'winter light');
});
