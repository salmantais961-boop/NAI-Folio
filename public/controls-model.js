import { encodingKey } from './controls-vibe-cache.js'
import { UC } from './controls-presets.js'
export const MODELS = [
  ['nai-diffusion-5-full', 'V5 Full', 'v5'],
  ['nai-diffusion-5-curated', 'V5 Curated', 'v5'],
  ['nai-diffusion-4-5-full', 'V4.5 Full', 'v45'],
  ['nai-diffusion-4-5-curated', 'V4.5 Curated', 'v45'],
  ['nai-diffusion-4-full', 'V4 Full', 'v4'],
  ['nai-diffusion-4-curated-preview', 'V4 Curated', 'v4'],
  ['nai-diffusion-3', 'Anime V3', 'v3'],
  ['nai-diffusion-furry-3', 'Furry V3', 'v3'],
]
export const MODES = {
  generate: ['文生图', '生成图像'],
  img2img: ['图生图', '生成变体'],
  inpaint: ['局部重绘', '重绘选区'],
  augment: ['导演工具', '执行工具'],
  upscale: ['超分放大', '放大图像'],
}
export const TOOLS = {
  'bg-removal': '去除背景',
  lineart: '提取线稿',
  sketch: '铅笔草图',
  colorize: '线稿上色',
  emotion: '调整表情',
  declutter: '清除文字',
  'declutter-keep-bubbles': '清字并保留气泡',
}
export const SAMPLERS = {
  k_euler_ancestral: 'Euler Ancestral',
  k_euler: 'Euler',
  k_dpmpp_2m: 'DPM++ 2M',
  k_dpmpp_2s_ancestral: 'DPM++ 2S Ancestral',
  k_dpmpp_sde: 'DPM++ SDE',
  k_dpmpp_2m_sde: 'DPM++ 2M SDE',
}
export const EMOTIONS =
  'neutral happy sad angry scared surprised tired excited nervous thinking confused shy disgusted smug bored laughing irritated aroused embarrassed worried love determined hurt playful'.split(
    ' ',
  )
export const initial = {
  mode: 'generate',
  model: MODELS[0][0],
  width: 832,
  height: 1216,
  steps: 23,
  scale: 7,
  batch: 1,
  seed: null,
  sampler: 'k_euler_ancestral',
  cfgRescale: 0,
  noiseSchedule: 'karras',
  quality: 'off',
  dataset: 'anime',
  medium: false,
  focusInpaint: false,
  variety: false,
  decrisper: false,
  legacyUC: false,
  normalizeVibes: false,
  transparent: false,
  smea: 'off',
  stream: false,
  useCoords: false,
  characters: [],
  strength: 0.7,
  noise: 0,
  enhance: 'off',
  tool: 'lineart',
  toolPrompt: '',
  emotion: 'neutral',
  defry: 0,
  blur: 0,
  uc: 'none',
  references: [],
  source: null,
  mask: null,
}
export const seedNumber = () => crypto.getRandomValues(new Uint32Array(1))[0]
export const isPng = (s) => typeof s === 'string' && /^data:image\/png;base64,iVBOR/.test(s)
export const base64 = (s) => s.slice(s.indexOf(',') + 1)
export function capabilities(d) {
  const [, label, family] = MODELS.find(([id]) => id === d.model) ?? MODELS[0]
  const v5 = family === 'v5',
    modern = family !== 'v3'
  const imageMode = !['augment', 'upscale'].includes(d.mode)
  return {
    label,
    family,
    v5,
    modern,
    imageMode,
    chars: modern ? (v5 ? 22 : 6) : 0,
    medium: d.model === MODELS[0][0],
    precise: family === 'v45' && imageMode,
    vibe: !v5 && imageMode && (!modern || d.mode !== 'inpaint'),
  }
}
const qualityByModel = [
  'very aesthetic, masterpiece, no text',
  'very aesthetic, masterpiece, no text',
  'location, very aesthetic, masterpiece, no text',
  'location, masterpiece, no text, -0.8::feet::, rating:general',
  'no text, best quality, very aesthetic, absurdres',
  'rating:general, amazing quality, very aesthetic, absurdres',
  'best quality, amazing quality, very aesthetic, absurdres',
  '{best quality}, {amazing quality}',
]
export function maxBatch(w, h) {
  return w * h <= 360448 ? 8 : w * h <= 409600 ? 6 : 4
}
const fail = (msg) => {
  throw new Error(msg)
}
const check = (valid, msg) => valid || fail(msg)
const num = (x, min, max) => typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max

// Called after resolving macros and random choices. Build request-only roles
// so editing, saving and reopening a draft preserve the original pipe syntax.
export function prepareCharacterCaptions(prompt, negative, slots = [], maxCharacters) {
  const [base, ...inline] = (prompt || '').split(/[|｜]/).map(text => text.trim())
  const [baseUC, ...roleUC] = (negative || '').split(/[|｜]/).map(text => text.trim())
  while (inline.length && !inline.at(-1)) inline.pop()
  while (roleUC.length && !roleUC.at(-1)) roleUC.pop()

  const roles = inline.map(text => ({ prompt: text, negative: '', x: 0.5, y: 0.5 }))
  for (const slot of slots) {
    if (slot.enabled !== false && (slot.prompt?.trim() || slot.negative?.trim())) roles.push(slot)
  }
  check(roleUC.length <= roles.length, '负面提示词的角色段数超过正向角色数，请核对竖线的顺序。')
  const characters = []
  for (const [index, role] of roles.entries()) {
    const exclusions = [role.negative?.trim(), roleUC[index]].filter(Boolean).join(', ')
    if (!role.prompt?.trim()) {
      check(!exclusions, '第 ' + (index + 1) + ' 个角色只填写了负面词，请补充正向描述。')
      continue
    }
    characters.push({ ...role, negative: exclusions, x: role.x ?? 0.5, y: role.y ?? 0.5 })
  }
  check(characters.length <= maxCharacters, '当前模型最多支持 ' + maxCharacters + ' 个角色。')
  return { prompt: base, negative: baseUC, characters }
}

export function formatImageBaseCaptions(d, basePrompt, baseNegative, { lockNegative = false } = {}) {
  const cap = capabilities(d), medium = cap.medium && d.medium
  const quality =
    d.quality === 'off'
      ? ''
      : cap.v5 && d.quality === 'light'
        ? 'very aesthetic, amazing quality, no text'
        : qualityByModel[MODELS.findIndex(([id]) => id === d.model)]
  const raw = basePrompt.trim()
  const [first, ...mix] = cap.modern ? [raw] : raw.split('|')
  const weight = mix.length ? first.match(/\s*:\s*-?(?:\d+(?:\.\d+)?|\.\d+)\s*$/)?.[0] || '' : ''
  const weightedBase = weight ? first.slice(0, -weight.length) : first
  const promptBase = [
    cap.modern && d.dataset === 'furry'
      ? 'fur dataset'
      : cap.family !== 'v4' && cap.modern && d.dataset === 'background'
        ? 'background dataset'
        : '',
    weightedBase,
    quality,
    cap.v5 && d.transparent ? 'transparent background' : '',
    d.mode === 'img2img' && d.enhance === 'normal' && ['v45', 'v5'].includes(cap.family)
      ? '-2::upscaled, blurry::'
      : '',
  ]
    .filter(Boolean)
    .join(', ')
  const prompt = [promptBase + weight, ...mix].join('|')
  const ucTag = UC[d.model][medium ? 'heavy' : d.uc] || ''
  const negative = lockNegative ? baseNegative : [ucTag, baseNegative?.trim()].filter(Boolean).join(', ')
  return { prompt, negative }
}

export function requestFor(d, basePrompt, baseNegative, { lockNegative = false } = {}) {
  const cap = capabilities(d),
    src = d.source
  if (d.mode !== 'generate') check(src && isPng(src.data), '请先导入底图。')
  if (src && d.mode !== 'generate') {
    check(
      Number.isInteger(src.width) &&
        Number.isInteger(src.height) &&
        src.width > 0 &&
        src.height > 0 &&
        src.width * src.height <= 3145728,
      '底图尺寸无效。',
    )
  }
  if (d.mode === 'augment') {
    check(Object.hasOwn(TOOLS, d.tool), '请选择导演工具。')
    const body = { image: base64(src.data), width: src.width, height: src.height, req_type: d.tool }
    if (['colorize', 'emotion'].includes(d.tool)) {
      check(Number.isInteger(d.defry) && num(d.defry, 0, 5), '削弱原图色彩范围为 0 到 5。')
      body.defry = d.defry
      body.prompt = (d.tool === 'emotion' ? d.emotion + ';;' : '') + d.toolPrompt
    }
    return { operation: 'augment', body }
  }
  if (d.mode === 'upscale') {
    check(src.width * src.height <= 2250000, '超分输入最多 225 万像素，请缩小后再导入。')
    check([0, 0.3, 0.35, 0.4, 0.45, 0.5].includes(d.blur), '请选择有效的超分降噪级别。')
    return {
      operation: 'upscale',
      body: { image: base64(src.data), model: 'nai-diffusion-5-curated', declared_blur_sigma: d.blur },
    }
  }
  check(MODES[d.mode] && MODELS.some(([id]) => id === d.model), '请选择有效模型和生成模式。')
  check(basePrompt?.trim(), '请先输入正向提示词。')
  check(
    [d.width, d.height].every((v) => num(v, 64, 4096) && v % 64 === 0) && d.width * d.height <= 3145728,
    '宽高需为 64 的倍数，总像素不能超过 314 万。',
  )
  check(
    Number.isInteger(d.steps) && num(d.steps, 1, 50) && num(d.scale, 0, 10) && num(d.cfgRescale, 0, 1),
    '请检查步数、引导值和引导重缩放。',
  )
  check(
    Number.isInteger(d.batch) && num(d.batch, 1, maxBatch(d.width, d.height)),
    '本尺寸单次最多 ' + maxBatch(d.width, d.height) + ' 张。',
  )
  check(
    d.seed === null || (Number.isInteger(d.seed) && num(d.seed, 0, 0xffffffff)),
    '种子需为 0–4294967295 的整数，留空即随机。',
  )
  let chars = []
  if (cap.modern) {
    const lanes = lockNegative ? d.characters.map(c => ({ ...c, negative: '' })) : d.characters
    const captions = prepareCharacterCaptions(basePrompt, baseNegative, lanes, cap.chars)
    basePrompt = captions.prompt
    if (lockNegative) {
      // Preserve weights, repeated tags, punctuation and whitespace from the user's
      // frozen text. An explicit pipe still addresses the corresponding NovelAI lane.
      const [base, ...roleText] = baseNegative.split(/[|｜]/)
      baseNegative = base
      chars = captions.characters.map((c, i) => ({ ...c, negative: roleText[i] ?? '' }))
    } else {
      baseNegative = captions.negative
      chars = captions.characters
    }
    check(basePrompt || chars.length, '请先输入正向提示词或角色描述。')
  }
  const medium = cap.medium && d.medium
  if (medium)
    check(
      !baseNegative?.trim() && !chars.some((c) => c.negative.trim()),
      'Medium Effort 使用固定负面词，请清空自定义负面词，或将运算强度切回 High。',
    )
  const { prompt, negative } = formatImageBaseCaptions(d, basePrompt, baseNegative, { lockNegative })
  const seed = d.seed ?? seedNumber()
  const p = {
    params_version: 4,
    width: d.width,
    height: d.height,
    steps: medium ? 14 : d.steps,
    scale: d.scale,
    seed,
    n_samples: d.batch,
    sampler: medium ? 'k_euler_ancestral' : d.sampler,
    noise_schedule: cap.v5 ? 'karras' : d.noiseSchedule,
    negative_prompt: negative,
    image_format: 'png',
  }
  if (medium) p.tag_hint_uc_preset = 2
  else p.cfg_rescale = d.cfgRescale
  if (p.sampler === 'k_euler_ancestral' && p.noise_schedule !== 'native')
    Object.assign(p, { deliberate_euler_ancestral_bug: false, prefer_brownian: true })
  if (!cap.v5 && d.variety) p.skip_cfg_above_sigma = cap.family === 'v45' ? 58 : 19
  if (!cap.modern && d.decrisper) p.dynamic_thresholding = true
  if (cap.v5) Object.assign(p, { straight_alpha: true, tag_hint_transparent_background: d.transparent })
  if (
    !cap.modern &&
    d.mode === 'generate' &&
    (d.smea === 'auto' ? d.width * d.height >= 1048576 : d.smea !== 'off')
  )
    Object.assign(p, { sm: true, sm_dyn: d.smea === 'dynamic' })
  if (cap.modern) {
    const coord = (v) => (cap.v5 ? v : (Math.min(4, Math.floor(v * 5)) + 0.5) / 5)
    const captions = (main, k) => ({
      base_caption: main,
      char_captions: chars.map((c) => ({ char_caption: c[k], centers: [{ x: coord(c.x), y: coord(c.y) }] })),
    })
    p.v4_prompt = {
      caption: captions(prompt, 'prompt'),
      use_coords: d.useCoords && chars.length > 0 && (cap.family !== 'v4' || chars.length > 1),
      use_order: true,
    }
    p.v4_negative_prompt = {
      caption: captions(negative, 'negative'),
      legacy_uc: cap.family === 'v4' && d.legacyUC,
    }
  }
  let model = d.model + (medium ? '-medium' : '')
  if (d.mode === 'img2img' || d.mode === 'inpaint')
    check(num(d.strength, 0, 1) && num(d.noise, 0, 1), '重绘强度和噪声范围为 0 到 1。')
  if (d.mode === 'img2img') {
    Object.assign(p, {
      image: base64(src.data),
      strength: d.strength,
      noise: d.noise,
      extra_noise_seed: Math.max(0, seed - 1),
      color_correct: false,
    })
    if (d.enhance === 'max' && cap.v5) {
      check(d.batch === 1, 'Max Enhance 需要单张输出。')
      p.upscaled_enhance = true
    }
  }
  if (d.mode === 'inpaint') {
    check(isPng(d.mask), '请先绘制需要重绘的区域。')
    model = model.replace('-curated-preview', '-curated') + '-inpainting'
    Object.assign(p, { image: base64(src.data), mask: base64(d.mask), add_original_image: true })
    if (cap.modern && d.strength !== 1) p.img2img = { strength: d.strength, color_correct: true }
  }
  const refs = d.references.filter((r) => r.enabled !== false)
  check(
    !(refs.some((r) => r.kind === 'vibe') && refs.some((r) => r.kind !== 'vibe')),
    'Vibe 与精确参考需分开使用，请停用其中一种。',
  )
  if (refs.some((r) => r.kind === 'vibe')) {
    if (!cap.modern) check(!refs.some((ref) => ref.mask), '区域 Vibe 需要使用 V4 或 V4.5。')
    check(cap.vibe, '当前模型或模式不支持 Vibe，请停用参考图或切换模型。')
    p.reference_image_multiple = refs.map((r) =>
      cap.modern
        ? r.encodings?.[encodingKey(r, d.model)] || fail('请先编码参考图，或导入当前模型对应的 .naiv4vibe。')
        : r.v3
          ? base64(r.v3)
          : fail('V3 需要原始参考图。'),
    )
    const total = refs.reduce((sum, r) => sum + Math.abs(r.strength), 0)
    p.reference_strength_multiple = refs.map((r) =>
      d.normalizeVibes && total > 1 ? r.strength / total : r.strength,
    )
    if (!cap.modern) p.reference_information_extracted_multiple = refs.map((r) => r.information)
  } else if (refs.length) {
    check(cap.precise, '精确参考只支持 V4.5，请停用参考图或切换模型。')
    p.director_reference_images = refs.map((r) => base64(r.data))
    p.director_reference_descriptions = refs.map((r) => ({
      caption: { base_caption: r.kind, char_captions: [] },
      legacy_uc: false,
    }))
    p.director_reference_information_extracted = refs.map(() => 1)
    p.director_reference_strength_values = refs.map((r) => r.strength)
    p.director_reference_secondary_strength_values = refs.map((r) => 1 - r.fidelity)
  }
  if (cap.modern && d.stream) p.stream = 'sse'
  return {
    operation: p.stream ? 'generate-stream' : 'generate',
    body: { input: prompt, model, action: d.mode === 'inpaint' ? 'infill' : d.mode, parameters: p },
    seed,
  }
}
