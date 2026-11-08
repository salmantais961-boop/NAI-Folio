import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'
import { agentImageSettings, createAgentPromptBudget } from '../public/agent-prompt-budget.js'
import { initial, MODELS, requestFor } from '../public/controls-model.js'
import { UC } from '../public/controls-presets.js'
import { createTokenizer, tokenizerSpec } from '../public/prompt-tokenizer-core.js'

const encoders = new Map()
async function count(type, texts) {
  if (!encoders.has(type)) {
    const bytes = await readFile(new URL('../public/tokenizers/' + type + '.def', import.meta.url))
    encoders.set(type, createTokenizer(type, JSON.parse(inflateRawSync(bytes))))
  }
  return texts.map((text) => encoders.get(type).encode(text).length)
}
const settings = { ...initial, quality: 'standard', uc: 'heavy', dataset: 'furry', transparent: true }
const plan = {
  width: settings.width, height: settings.height,
  prompt: 'a garden at dawn', negative: 'blurry',
  characters: [{ prompt: 'girl, blue hair', negative: 'gloves' }],
  lockedNames: [], negativeLocked: false,
}

test('Agent budgets include model additions, independently count wire captions, and exclude workbench-only roles', async () => {
  for (const [model] of MODELS) {
    const d = { ...settings, model, characters: [{ prompt: 'irrelevant workbench role', negative: 'old UC' }] }
    const { type, limit, characters } = tokenizerSpec(model)
    const { limits, measure } = await createAgentPromptBudget({ settings: d, count })
    assert.equal(limits.positive.limit, limit)
    assert.equal(limits.negative.limit, limit)
    assert.equal(limits.positive.locked, 0)
    assert.equal(limits.negative.locked, 0)
    assert.equal(limits.minimumCharacters, 0)
    const sample = characters ? plan : { ...plan, characters: [], prompt: 'garden:0.4 | flower field:0.6' }
    const { body } = requestFor(agentImageSettings(d, sample), sample.prompt, sample.negative)
    const actual = await measure(sample)
    if (characters) {
      const expected = async (wire) => (await count(type, [
        wire.caption.base_caption, ...wire.caption.char_captions.map((c) => c.char_caption),
      ])).reduce((a, b) => a + b, 0)
      assert.equal(actual.positive, await expected(body.parameters.v4_prompt))
      assert.equal(actual.negative, await expected(body.parameters.v4_negative_prompt))
    } else {
      assert.equal(actual.positive, Math.max(...await count(type, body.input.split('|'))))
      assert.equal(actual.negative, Math.max(...await count(type, body.parameters.negative_prompt.split('|'))))
    }
    assert.ok(limits.positive.available < limit)
    assert.ok(limits.negative.available <= limit)
  }
})

test('Agent freezes both polarity budgets after model decorations and accounts for future pipe lanes', async () => {
  const model = 'nai-diffusion-4-5-full'
  const positiveLockedText = 'pencil strokes', negativeLockedText = '  motion blur  ｜2::crown::  '
  const d = { ...settings, model }
  const { limits, measure } = await createAgentPromptBudget({ settings: d, positiveLockedText, negativeLockedText, count })
  const tokens = async (strings) => (await count('t5', strings)).reduce((a, b) => a + b, 0)
  assert.equal(limits.minimumCharacters, 1)
  assert.equal(limits.positive.locked, await tokens([positiveLockedText]))
  assert.equal(limits.positive.remainingAfterLocks, 512 - await tokens([positiveLockedText]))
  assert.equal(limits.positive.reserved, await tokens(['fur dataset, ' + positiveLockedText, '']))
  assert.equal(limits.positive.available, 512 - limits.positive.reserved)
  assert.equal(limits.negative.locked, await tokens(negativeLockedText.split('｜')))
  assert.equal(limits.negative.reserved, limits.negative.locked)
  assert.equal(limits.negative.available, 0)
  assert.equal(limits.negative.writable, false)
  const ready = {
    ...plan, lockedNames: ['style'], negativeLocked: true,
    prompt: positiveLockedText + ', girl', negative: negativeLockedText,
  }
  assert.deepEqual(await measure(ready), {
    positive: await tokens(['fur dataset, ' + ready.prompt, ready.characters[0].prompt]),
    negative: await tokens(negativeLockedText.split('｜')),
  })
  assert.doesNotMatch(JSON.stringify(limits), /pencil|motion blur|crown/)
})

test('V5 Medium reserves its built-in negative and disallows model-written exclusions', async () => {
  const d = { ...settings, medium: true }
  const { limits } = await createAgentPromptBudget({ settings: d, count })
  assert.equal(limits.negative.available, 0)
  assert.equal(limits.negative.reserved, (await count('qwen35', [UC[d.model].heavy]))[0])
  assert.equal(limits.negative.locked, 0)
  const invalid = await createAgentPromptBudget({ settings: d, negativeLockedText: 'extra hands', count })
  assert.equal(invalid.limits.negative.writable, false)
  await assert.rejects(invalid.measure({ ...plan, negativeLocked: true, negative: 'extra hands' }), /Medium/)
})
