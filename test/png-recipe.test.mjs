import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { readPngRecipe } from '../public/png-recipe.js';

function chunk(name, bytes) {
  const data = Buffer.from(bytes), length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(name), data, Buffer.alloc(4)]);
}
test('imports compressed NovelAI international text and restores per-character placements', async () => {
  const metadata = {
    seed: 0, noise_schedule: 'karras', cfg_rescale: 0.26, model_hash: '0ADF9AB7',
    v4_prompt: { use_coords: true, caption: { base_caption: '庭院', char_captions: [{ char_caption: 'white hair', centers:[{x:.3,y:.6}] }] } },
    v4_negative_prompt: { caption: { base_caption: 'grain', char_captions: [{ char_caption: 'hat' }] } },
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1024); ihdr.writeUInt32BE(1024,4);
  const file = new Blob([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('tEXt','Software\0NovelAI'),
    chunk('iTXt',Buffer.concat([Buffer.from('Comment\0\x01\0zh\0\0'),deflateSync(JSON.stringify(metadata))])),chunk('IEND',Buffer.alloc(0))]);
  const { settings, prompt, negative } = await readPngRecipe(file);
  assert.equal(prompt,'庭院'); assert.equal(negative,'grain'); assert.equal(settings.model,'nai-diffusion-5-full');
  assert.equal(settings.seed,0); assert.equal(settings.useCoords,true); assert.equal(settings.cfgRescale,.26);
  assert.deepEqual(settings.characters,[{ prompt:'white hair',negative:'hat',enabled:true,x:.3,y:.6 }]);
});
