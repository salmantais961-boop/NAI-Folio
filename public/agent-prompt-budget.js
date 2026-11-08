import { capabilities, formatImageBaseCaptions, initial, requestFor } from './controls-model.js'
import { countPromptTokens, summarizeTokenCounts } from './prompt-tokens.js'
import { tokenizerSpec } from './prompt-tokenizer-core.js'

function captionSettings(settings, positiveLocked, negativeLocked) {
  return {
    mode: 'generate',
    enhance: 'off',
    quality: positiveLocked ? 'off' : settings.quality,
    uc: negativeLocked ? 'none' : settings.uc,
  }
}

export function agentImageSettings(settings, plan) {
  return {
    ...settings,
    ...captionSettings(settings, plan.lockedNames?.length, plan.negativeLocked),
    batch: 1,
    source: null,
    mask: null,
    references: [],
    width: plan.width,
    height: plan.height,
    characters: plan.characters.map(({ name, prompt, negative }) => ({
      name, prompt, negative, enabled: true, x: 0.5, y: 0.5,
    })),
  }
}

function wireCaptions(body, spec) {
  const { parameters } = body
  if (!spec.characters) return {
    positive: body.input.split('|'), negative: parameters.negative_prompt.split('|'),
  }
  const read = ({ caption }) => [caption.base_caption, ...caption.char_captions.map((c) => c.char_caption)]
  return { positive: read(parameters.v4_prompt), negative: read(parameters.v4_negative_prompt) }
}

// Locks may already contain pipe-delimited characters, including negative lanes
// for characters the Agent hasn't written yet. Reserve those lanes without
// inventing or sampling any character description.
function fixedCaptions(settings, spec, positiveText, negativeText) {
  const splitRoles = (text) => text.split(/[|｜]/)
  const [positive, ...pcs] = spec.characters ? splitRoles(positiveText) : [positiveText]
  const [negative, ...ncs] = spec.characters ? splitRoles(negativeText) : [negativeText]
  const positiveRoles = pcs.map((s) => s.trim()).filter(Boolean)
  const minimumCharacters = Math.max(positiveRoles.length, ncs.findLastIndex((s) => s.trim()) + 1)
  const lockNegative = Boolean(negativeText)
  const formatted = formatImageBaseCaptions(settings, positive.trim(), negative, { lockNegative })
  if (!spec.characters) return {
    locked: { positive: positiveText.trim().split('|'), negative: negativeText.split('|') },
    reserved: { positive: formatted.prompt.split('|'), negative: formatted.negative.split('|') },
    minimumCharacters,
  }
  const negativeRoles = Array.from({ length: minimumCharacters }, (_, i) => ncs[i] ?? '')
  const requiredPositive = Array.from({ length: minimumCharacters }, (_, i) => positiveRoles[i] ?? '')
  return {
    locked: { positive: [positive.trim(), ...positiveRoles], negative: [negative, ...negativeRoles] },
    reserved: { positive: [formatted.prompt, ...requiredPositive], negative: [formatted.negative, ...negativeRoles] },
    minimumCharacters,
  }
}

export async function createAgentPromptBudget({
  settings, positiveLockedText = '', negativeLockedText = '', signal, count = countPromptTokens,
}) {
  signal?.throwIfAborted()
  const spec = tokenizerSpec(settings.model)
  if (!spec) throw Error('当前 NAI 模型缺少可用的提示词 tokenizer。')
  const base = { ...initial, ...settings }
  const fixed = { ...base, ...captionSettings(base, positiveLockedText, negativeLockedText) }
  const medium = capabilities(base).medium && base.medium
  const { locked, reserved, minimumCharacters } = fixedCaptions(fixed, spec, positiveLockedText, negativeLockedText)
  // T5 includes EOS for every real caption, even an empty one. The cost of
  // absent locks is still zero; structural EOS counts belong to the reserve.
  for (const side of ['positive', 'negative']) locked[side] = locked[side].filter((s) => s !== '')

  async function totals(groups) {
    signal?.throwIfAborted()
    const texts = [...new Set(groups.flatMap(({ positive, negative }) => [...positive, ...negative]))]
    let values
    try {
      values = await count(spec.type, texts)
    } catch {
      signal?.throwIfAborted()
      throw Error('无法读取本地 NAI 提示词计数，请重试。')
    }
    signal?.throwIfAborted()
    if (values.length !== texts.length || !values.every((n) => Number.isSafeInteger(n) && n >= 0))
      throw Error('本地 NAI 提示词计数未返回完整结果。')
    const byText = new Map(texts.map((s, i) => [s, values[i]]))
    return groups.map((group) => {
      const counts = [...group.positive, ...group.negative].map((s) => byText.get(s))
      const { positive, negative } = summarizeTokenCounts({ ...group, spec }, counts)
      return { positive: positive.total, negative: negative.total }
    })
  }

  const [lockCounts, fixedCounts] = await totals([locked, reserved])
  function lane(side, writable) {
    return {
      limit: spec.limit, locked: lockCounts[side],
      remainingAfterLocks: Math.max(0, spec.limit - lockCounts[side]),
      reserved: fixedCounts[side],
      available: writable ? Math.max(0, spec.limit - fixedCounts[side]) : 0,
      writable,
    }
  }
  return {
    limits: {
      model: base.model, tokenizer: spec.label, minimumCharacters,
      positive: lane('positive', true),
      negative: lane('negative', !negativeLockedText && !medium),
    },
    async measure(plan) {
      const job = agentImageSettings(base, plan)
      // Payload validation and accounting use the same serializer as rendering.
      // A deterministic inspection seed avoids consuming the actual image seed.
      const { body } = requestFor({ ...job, seed: job.seed ?? 0 }, plan.prompt, plan.negative, { lockNegative: plan.negativeLocked })
      const [measured] = await totals([wireCaptions(body, spec)])
      return measured
    },
  }
}
