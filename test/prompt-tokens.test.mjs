import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'
import { createTokenizer, tokenizerSpec } from '../public/prompt-tokenizer-core.js'
import { prepareTokenInputs, summarizeTokenCounts } from '../public/prompt-tokens.js'
import { initial, MODELS, requestFor } from '../public/controls-model.js'
import { UC } from '../public/controls-presets.js'

const tokenizers = new Map()
async function tokenizer(type) {
  if (!tokenizers.has(type)) {
    const bytes = await readFile(new URL(`../public/tokenizers/${type}.def`, import.meta.url))
    tokenizers.set(type, createTokenizer(type, JSON.parse(inflateRawSync(bytes))))
  }
  return tokenizers.get(type)
}

test('offline token IDs match the verified official public tokenizer samples', async () => {
  // Generated independently with NovelAI public client b94bdee / module 423709.
  const samples = {
    qwen35: [
      ['', []],
      ['a cat', [64, 7993]],
      ['1girl, blue eyes, long hair', [16, 27620, 11, 6105, 6213, 11, 1248, 6655]],
      ['白い猫，蓝色天空。', [165203, 98500, 3709, 104145, 101850, 1710]],
      ['é cafe\u0301', [933, 50203]],
      ['<|im_start|>test<|im_end|>', [248045, 1877, 248046]],
      ['1.2::blue sky::, -0.5::rain::', [16,13,17,476,11855,12515,476,11,471,15,13,20,476,28142,476]],
    ],
    t5: [
      ['', [1]],
      ['a cat', [3, 9, 1712, 1]],
      ['1girl, blue eyes, long hair', [209, 18722, 6, 1692, 2053, 6, 307, 1268, 1]],
      ['{soft lighting}, [blurry]', [1835, 3598, 6, 16810, 651, 1]],
      ['1.2::blue sky::, -0.5::rain::', [1692, 5796, 6, 3412, 1]],
      ['😀🌸', [3, 2, 2, 2, 2, 1]],
      ['hello\n\nworld', [21820, 296, 1]],
    ],
    clip: [
      ['', []],
      ['a cat', [320, 2368]],
      ['1girl, blue eyes, long hair', [272, 1611, 267, 1746, 3095, 267, 1538, 2225]],
      ['{soft lighting}, [blurry]', [3773, 5799, 267, 21977]],
      ['😀🌸', [12832, 10980]],
      ['Text: Hello, world!', [4160, 281, 3306, 267, 1002, 256]],
    ],
  }
  for (const [type, rows] of Object.entries(samples)) {
    const encoder = await tokenizer(type)
    for (const [text, expected] of rows) assert.deepEqual(encoder.encode(text), expected, `${type}: ${text}`)
  }
  const clip = await tokenizer('clip')
  assert.deepEqual(clip.encode('cat &amp;amp; dog'), clip.encode('cat & dog'))
  assert.deepEqual(clip.encode('&#x1F600; &eacute;'), clip.encode('😀 é'))
})

test('the browser Qwen regex preserves contraction folding and Unicode whitespace boundaries', async () => {
  const encoder = await tokenizer('qwen35')
  assert.deepEqual(encoder.encode("I'Ll go"), [40, 88279, 75, 708])
  assert.deepEqual(encoder.encode('A\u0085B'), [32, 126, 227, 33])
  assert.deepEqual(encoder.encode('a\uFEFFb'), [64, 3121, 65])
  assert.deepEqual(encoder.encode('e\u0301  \r\n'), [933, 10109])
})

test('model budgets use Qwen 3.5, T5, and CLIP rather than character approximations', () => {
  for (const [model, , family] of MODELS) {
    const expected = family === 'v5' ? model.includes('curated') ? 703 : 1471 : family === 'v3' ? 225 : 512
    assert.equal(tokenizerSpec(model).limit, expected)
  }
  assert.equal(tokenizerSpec('nai-diffusion-5-full-medium').limit, 1471)
  assert.equal(tokenizerSpec('unknown-model'), null)
})

test('counted captions include exactly the prompts sent by each model request', () => {
  for (const [model, , family] of MODELS) {
    for (const quality of ['off', 'standard', ...(family === 'v5' ? ['light'] : [])]) {
      for (const uc of Object.keys(UC[model])) {
        const settings = { ...initial, model, quality, uc, seed: 1, dataset: 'furry', transparent: family === 'v5', characters: family === 'v3' ? [] : [
          { prompt: 'girl, blue dress', negative: 'hat', enabled: true, x: .5, y: .5 },
          { prompt: 'disabled role', negative: 'ignored', enabled: false, x: .5, y: .5 },
        ] }
        const { body } = requestFor(settings, 'soft light, garden', 'blurry')
        const counted = prepareTokenInputs(settings, 'soft light, garden', 'blurry', (text) => text)
        assert.equal(counted.positive[0], body.input, `${model} ${quality} ${uc}`)
        assert.equal(counted.negative[0], body.parameters.negative_prompt)
        if (family !== 'v3') {
          assert.deepEqual(counted.positive.slice(1), body.parameters.v4_prompt.caption.char_captions.map((role) => role.char_caption))
          assert.deepEqual(counted.negative.slice(1), body.parameters.v4_negative_prompt.caption.char_captions.map((role) => role.char_caption))
        }
      }
    }
  }
})

test('macros, roles, random previews, and V3 mixing retain their distinct counting rules', async () => {
  const settings = { ...initial, model: 'nai-diffusion-4-5-full', seed: 1, characters: [] }
  const expand = (text) => text.replaceAll('!macro:light!', 'soft lighting, sidelighting')
  const prepared = prepareTokenInputs(settings, '!macro:light! | 1girl | 1boy', 'blurry | hat | cap', expand)
  const encoder = await tokenizer('t5')
  const counts = [...prepared.positive, ...prepared.negative].map((text) => encoder.encode(text).length)
  const result = summarizeTokenCounts(prepared, counts)
  assert.equal(prepared.characterCount, 2)
  assert.equal(result.positive.total, counts.slice(0, 3).reduce((sum, n) => sum + n, 0))
  assert.equal(result.negative.total, counts.slice(3).reduce((sum, n) => sum + n, 0))
  assert.ok(prepared.positive[0].includes('sidelighting'))
  const random = prepareTokenInputs(initial, 'a ||cat|long-haired dog||', '', (text) => text)
  assert.equal(random.random, true)
  assert.equal(random.positive[0], 'a long-haired dog')
  const mixed = prepareTokenInputs({ ...initial, model: 'nai-diffusion-3' }, 'a cat:0.5 | a dog:0.5', '', (text) => text)
  assert.deepEqual(summarizeTokenCounts(mixed, [5, 7, 0]).positive, { total: 7, base: 5, characters: 0, parts: [5, 7] })
  assert.equal(prepareTokenInputs({ ...initial, mode: 'upscale' }, 'cat', '').inactive, true)
})

test('pipe roles and independent roles share the same captions and budget as generation', () => {
  const slots = [
    { prompt: 'OC, red eyes', negative: 'hat', enabled: true, x: .2, y: .8 },
    { prompt: 'hidden role', negative: 'hidden exclusion', enabled: false },
    { prompt: '  ', negative: '' },
  ]
  const plain = text => text
  for (const [model, , family] of MODELS.filter(([, , family]) => family !== 'v3')) {
    const settings = { ...initial, model, characters: slots, seed: 1 }
    for (const separator of [' | ', '\n|\n', ' ｜ ']) {
      const positive = ['at a station', 'girl, hat', 'boy, scarf'].join(separator)
      const negative = ['blurry', 'glasses', 'coat'].join(separator)
      const prepared = prepareTokenInputs(settings, positive, negative, plain)
      const { body } = requestFor(settings, positive, negative)
      assert.deepEqual(prepared.positive, ['at a station', 'girl, hat', 'boy, scarf', 'OC, red eyes'])
      assert.deepEqual(prepared.negative, ['blurry', 'glasses', 'coat', 'hat'])
      assert.deepEqual(prepared.positive, [body.input, ...body.parameters.v4_prompt.caption.char_captions.map(c => c.char_caption)])
      assert.deepEqual(prepared.negative, [body.parameters.negative_prompt, ...body.parameters.v4_negative_prompt.caption.char_captions.map(c => c.char_caption)])
      assert.equal(prepared.characterCount, 3)
    }
    const max = family === 'v5' ? 22 : 6
    const full = 'street' + ' | role'.repeat(max - 1)
    assert.equal(prepareTokenInputs(settings, full, '', plain).characterCount, max)
    assert.throws(() => prepareTokenInputs(settings, full + ' | extra', '', plain), new RegExp(String(max)))
  }
  assert.equal(prepareTokenInputs(initial, '', '', plain).characterCount, 0)
})

test('medium and enhance additions are counted and over-budget text is not truncated locally', async () => {
  const medium = prepareTokenInputs({ ...initial, medium: true }, 'cat', '', (text) => text)
  assert.equal(medium.negative[0], UC[initial.model].heavy)
  const enhanced = prepareTokenInputs({ ...initial, mode: 'img2img', enhance: 'normal' }, 'cat', '', (text) => text)
  assert.match(enhanced.positive[0], /-2::upscaled, blurry::$/)
  const qwen = await tokenizer('qwen35')
  const text = 'cat, '.repeat(900)
  assert.ok(qwen.encode(text).length > 1471)
  assert.ok(qwen.encode(text).length > qwen.encode('cat, '.repeat(800)).length)
})
