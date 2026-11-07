import { MODELS, capabilities, prepareCharacterCaptions } from './controls-model.js'
import { UC } from './controls-presets.js'
import { expandChunks, watchChunks } from './chunks.js'
import { tokenizerSpec } from './prompt-tokenizer-core.js'

// Keep aligned with controls-model.requestFor; regression tests compare the final captions.
const qualityTags = [
  'very aesthetic, masterpiece, no text',
  'very aesthetic, masterpiece, no text',
  'location, very aesthetic, masterpiece, no text',
  'location, masterpiece, no text, -0.8::feet::, rating:general',
  'no text, best quality, very aesthetic, absurdres',
  'rating:general, amazing quality, very aesthetic, absurdres',
  'best quality, amazing quality, very aesthetic, absurdres',
  '{best quality}, {amazing quality}',
]

export function prepareTokenInputs(settings, positive, negative, expand = expandChunks) {
  const spec = tokenizerSpec(settings.model)
  if (!spec) throw Error('此模型暂无已核实的 tokenizer。')
  if (['upscale', 'augment'].includes(settings.mode))
    return { spec, inactive: true, reason: settings.mode === 'upscale' ? '超分不使用这些提示词' : '导演工具使用独立提示词' }
  let random = false
  const resolve = (text = '') => expand(String(text)).replace(/\|\|([\s\S]*?)\|\|/g, (_, body) => {
    random = true
    // Like the official preview, choose the longest text alternative. This is
    // explicitly a preview, never advertised as a token upper bound.
    return body.split('|').reduce((longest, item) => item.length >= longest.length ? item : longest, '').trim()
  })
  let main = resolve(positive).trim(), excluded = resolve(negative).trim()
  let characters = []
  if (spec.characters) {
    const slots = (settings.characters || []).filter((char) => char.enabled !== false)
      .map((char) => ({ ...char, prompt: resolve(char.prompt), negative: resolve(char.negative) }))
    const captions = prepareCharacterCaptions(main, excluded, slots, capabilities(settings).chars)
    main = captions.prompt
    excluded = captions.negative
    characters = captions.characters
  }
  const modelIndex = MODELS.findIndex(([id]) => id === settings.model)
  const family = MODELS[modelIndex]?.[2]
  const v5 = spec.type === 'qwen35'
  const quality = settings.quality === 'off' || !settings.quality ? ''
    : v5 && settings.quality === 'light' ? 'very aesthetic, amazing quality, no text'
    : qualityTags[modelIndex] || ''
  const [first, ...mix] = spec.characters ? [main] : main.split('|')
  const weight = mix.length ? first.match(/\s*:\s*-?(?:\d+(?:\.\d+)?|\.\d+)\s*$/)?.[0] || '' : ''
  const weightedBase = weight ? first.slice(0, -weight.length) : first
  const additions = [
    spec.characters && settings.dataset === 'furry' ? 'fur dataset'
      : spec.characters && family !== 'v4' && settings.dataset === 'background' ? 'background dataset' : '',
    weightedBase,
    quality,
    v5 && settings.transparent ? 'transparent background' : '',
    settings.mode === 'img2img' && settings.enhance === 'normal' && ['v45', 'v5'].includes(family) ? '-2::upscaled, blurry::' : '',
  ]
  const finalPositive = [additions.filter(Boolean).join(', ') + weight, ...mix].join('|')
  const medium = settings.model === 'nai-diffusion-5-full' && settings.medium
  const preset = UC[settings.model]?.[medium ? 'heavy' : settings.uc] || ''
  const finalNegative = [preset, excluded].filter(Boolean).join(', ')
  return {
    spec, random, medium,
    positive: spec.characters ? [finalPositive, ...characters.map((char) => char.prompt)] : finalPositive.split('|'),
    negative: spec.characters ? [finalNegative, ...characters.map((char) => char.negative)] : finalNegative.split('|'),
    characterCount: characters.length,
    addedPositive: !!quality || !!additions[0] || !!additions[3] || !!additions[4],
    addedNegative: !!preset,
    negativeWarning: medium && (excluded || characters.some((char) => char.negative.trim()))
      ? 'Medium 使用固定负面词，请清空自定义负面词或切回 High。' : '',
  }
}

export function summarizeTokenCounts(prepared, counts) {
  const sum = (values) => values.reduce((total, value) => total + value, 0)
  const positive = counts.slice(0, prepared.positive.length)
  const negative = counts.slice(prepared.positive.length)
  const summarize = (values) => ({
    total: prepared.spec.characters ? sum(values) : Math.max(0, ...values),
    base: values[0] || 0,
    characters: prepared.spec.characters ? sum(values.slice(1)) : 0,
    parts: values,
  })
  return { positive: summarize(positive), negative: summarize(negative) }
}

function counterClient() {
  let worker, sequence = 0
  const pending = new Map()
  function fail(message) {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error(message)) }
    pending.clear()
    worker?.terminate()
    worker = null
  }
  return {
    count(type, texts) {
      if (!worker) {
        worker = new Worker(new URL('./prompt-tokenizer-worker.js', import.meta.url), { type: 'module' })
        worker.onmessage = ({ data }) => {
          const item = pending.get(data.id)
          if (!item) return
          clearTimeout(item.timer)
          pending.delete(data.id)
          if (data.error) item.reject(Error(data.error))
          else item.resolve(data.counts)
        }
        worker.onerror = () => fail('本地 token 计数暂不可用，生成仍可继续。')
      }
      const id = ++sequence
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => fail('Token 计数超时，请缩短提示词后重试。'), 20000)
        pending.set(id, { resolve, reject, timer })
        worker.postMessage({ id, type, texts })
      })
    },
    destroy() { fail('Token 计数已停止。') },
  }
}

function createMeter(field, label) {
  const meter = document.createElement('div')
  meter.className = 'prompt-token-meter'
  meter.dataset.state = 'loading'
  meter.setAttribute('role', 'group')
  meter.setAttribute('aria-label', label + ' token 用量')
  const line = document.createElement('div')
  line.className = 'pt-token-line'
  const description = document.createElement('span')
  description.className = 'pt-token-caption'
  description.textContent = 'TOKEN'
  const value = document.createElement('output')
  value.className = 'pt-token-value'
  value.textContent = '读取词表…'
  line.append(description, value)
  const track = document.createElement('div')
  track.className = 'pt-token-track'
  track.setAttribute('role', 'progressbar')
  track.setAttribute('aria-label', label + '提示词容量')
  track.setAttribute('aria-valuemin', '0')
  const base = document.createElement('i'), characters = document.createElement('i')
  base.className = 'pt-token-base'
  characters.className = 'pt-token-characters'
  track.append(base, characters)
  const warning = document.createElement('span')
  warning.className = 'pt-token-warning'
  warning.setAttribute('aria-live', 'polite')
  warning.hidden = true
  meter.append(line, track, warning)
  ;(field.closest('.field-surface') || field).after(meter)
  return { meter, description, value, track, warning, base, characters }
}

export function mountPromptTokens({ positive, negative, getSettings, onResult } = {}) {
  if (!positive || !negative || typeof getSettings !== 'function') throw Error('缺少提示词计数挂载参数。')
  const meters = { positive: createMeter(positive, '正向'), negative: createMeter(negative, '负面') }
  const client = counterClient()
  let timer, version = 0, disposed = false, lastKey = ''
  function status(message, state = 'unavailable') {
    for (const ui of Object.values(meters)) {
      ui.meter.dataset.state = state
      ui.meter.title = message
      ui.description.textContent = 'TOKEN'
      ui.value.textContent = state === 'inactive' ? '—' : '暂不可用'
      ui.track.removeAttribute('aria-valuenow')
      ui.base.style.width = ui.characters.style.width = '0%'
      ui.warning.hidden = true
      ui.warning.textContent = ''
    }
  }
  function paint(side, data, prepared) {
    const ui = meters[side], limit = prepared.spec.limit
    const over = Math.max(0, data.total - limit)
    ui.meter.dataset.state = over ? 'over' : data.total >= limit * .9 ? 'near' : 'ready'
    ui.description.textContent = prepared.random ? '随机预览' : side === 'negative' && prepared.medium ? '固定负面 · TOKEN' : 'TOKEN'
    ui.value.textContent = data.total.toLocaleString('en-US') + ' / ' + limit
    ui.track.setAttribute('aria-valuemax', String(limit))
    ui.track.setAttribute('aria-valuenow', String(Math.min(limit, data.total)))
    ui.track.setAttribute('aria-valuetext', `${data.total} / ${limit} tokens${over ? `，超出 ${over}` : ''}`)
    const base = Math.min(100, (prepared.spec.characters ? data.base : data.total) / limit * 100)
    ui.base.style.width = base + '%'
    ui.characters.style.width = Math.min(100 - base, data.characters / limit * 100) + '%'
    const detail = [`${prepared.spec.label} · 本地计数，与官方网页 tokenizer 同口径。`]
    if (prepared.spec.characters && prepared.characterCount)
      detail.push(`基础 ${data.base} + ${prepared.characterCount} 个启用角色 ${data.characters} = ${data.total}；正、负向各有独立上限。`)
    else if (!prepared.spec.characters && data.parts.length > 1)
      detail.push('混合提示词各段分别计数，此处显示最大值：' + data.parts.join(' / ') + '。')
    if (side === 'positive' && prepared.addedPositive) detail.push('已计入实际追加的质量、数据集及画面标签。')
    if (side === 'negative' && prepared.addedNegative) detail.push('已计入当前 UC 预设。')
    if (prepared.random) detail.push('随机块按最长文本候选预览；实际随机结果的 token 数可能不同，此数不是上界。')
    if (prepared.spec.type === 't5') detail.push('含 T5 结束 token；不支持的字符按官方网页的未知 token 计数。')
    detail.push('仅提示词容量，不代表 Anlas 消耗或账户额度。')
    const message = side === 'negative' && prepared.negativeWarning ? prepared.negativeWarning
      : over ? `超出 ${over} token${prepared.random ? '（当前预览）' : ''}，超出部分可能被截断。` : ''
    ui.warning.textContent = message
    ui.warning.hidden = !message
    ui.meter.title = [...detail, message].filter(Boolean).join('\n')
  }
  async function update() {
    let stamp
    try {
      const prepared = prepareTokenInputs(getSettings(), positive.value, negative.value)
      if (prepared.inactive) { version++; lastKey = ''; status(prepared.reason, 'inactive'); return }
      const key = JSON.stringify(prepared)
      if (key === lastKey) return
      stamp = ++version
      lastKey = key
      for (const ui of Object.values(meters)) ui.meter.classList.add('is-counting')
      const counts = await client.count(prepared.spec.type, [...prepared.positive, ...prepared.negative])
      if (disposed || stamp !== version) return
      const result = summarizeTokenCounts(prepared, counts)
      paint('positive', result.positive, prepared)
      paint('negative', result.negative, prepared)
      onResult?.({ ...prepared, ...result })
    } catch (error) {
      stamp ??= ++version
      if (!disposed && stamp === version) { lastKey = ''; status(error.message || 'Token 计数暂不可用。') }
    } finally {
      if (stamp === version) for (const ui of Object.values(meters)) ui.meter.classList.remove('is-counting')
    }
  }
  function refresh() { clearTimeout(timer); timer = setTimeout(update, 100) }
  for (const field of [positive, negative]) {
    field.addEventListener('input', refresh)
    field.addEventListener('change', refresh)
  }
  document.addEventListener('chunkschange', refresh)
  const unwatch = watchChunks(refresh)
  refresh()
  return {
    refresh,
    destroy() {
      disposed = true
      version++
      clearTimeout(timer)
      client.destroy()
      unwatch()
      for (const field of [positive, negative]) { field.removeEventListener('input', refresh); field.removeEventListener('change', refresh) }
      document.removeEventListener('chunkschange', refresh)
      for (const ui of Object.values(meters)) ui.meter.remove()
    },
  }
}
