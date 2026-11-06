import test from 'node:test';
import assert from 'node:assert/strict';
import { metaReuseGroups, selectedMetaPatch } from '../public/meta-reuse.js';

const recipe = {
  prompt: '1girl, rain',
  negative: '',
  settings: {
    model: 'nai-diffusion-5-full',
    dataset: 'anime',
    medium: false,
    mode: 'img2img',
    seed: 0,
    width: 832,
    height: 1216,
    steps: 28,
    scale: 7,
    source: { data: 'source bytes', width: 832, height: 1216 },
    mask: 'mask bytes',
    characters: [{ prompt: 'blue hair', negative: 'hat', x: 0.5, y: 0.5 }],
    useCoords: true,
    secret: 'must not import unknown keys',
  },
};

test('selective META never includes unchecked groups or unknown settings', () => {
  assert.deepEqual(selectedMetaPatch(recipe, ['prompt', 'seed']), {
    prompt: recipe.prompt,
    settings: { seed: 0 },
  });
  assert.deepEqual(selectedMetaPatch(recipe, ['parameters']), { settings: { steps: 28, scale: 7 } });
  assert.deepEqual(selectedMetaPatch(recipe, []), {});
});
test('empty captions and random seed remain deliberate choices; missing fields stay unavailable', () => {
  assert.deepEqual(
    selectedMetaPatch({ negative: '', settings: { seed: null } }, ['prompt', 'negative', 'seed', 'size']),
    { negative: '', settings: { seed: null } },
  );
  const groups = metaReuseGroups({ prompt: 'rain', settings: { width: 832 } });
  assert.deepEqual(
    groups.filter((group) => group.available).map((group) => group.id),
    ['prompt'],
  );
});
test('characters are independent from positive/negative base captions and cloned', () => {
  const patch = selectedMetaPatch(recipe, ['characters']);
  assert.equal(patch.prompt, undefined);
  assert.equal(patch.negative, undefined);
  assert.deepEqual(patch.settings.characters, recipe.settings.characters);
  patch.settings.characters[0].negative = 'changed';
  assert.equal(recipe.settings.characters[0].negative, 'hat');
});
test('media is optional and carries its original workflow without leaking into general settings', () => {
  assert.equal(metaReuseGroups(recipe).find((group) => group.id === 'media').optional, true);
  assert.equal(selectedMetaPatch(recipe, ['basic', 'parameters']).settings.mode, undefined);
  const patch = selectedMetaPatch(recipe, ['media']);
  assert.equal(patch.settings.mode, 'img2img');
  assert.deepEqual(patch.settings.source, recipe.settings.source);
});
