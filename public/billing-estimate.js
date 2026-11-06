// Published NovelAI web estimator, checked 2026-11-03.
// https://novelai.net/_next/static/chunks/274ff5q_u23hy.js (module 643656)
// https://novelai.net/_next/static/chunks/3ayz70v6mlfvn.js (generation and reference charges)
// https://novelai.net/_next/static/chunks/0pl9_p_r7-vwt.js (Director Tools)
const megapixel = 1024 * 1024
const maxPixels = 3 * megapixel
const perPixel = 2.951823174884865e-6
const perPixelStep = 5.753298233447344e-7
const modelId = /^nai-diffusion-(5-(full|curated)|4-5-(full|curated)|4-(full|curated-preview)|3|furry-3)$/
const round64 = (x) => Math.max(64, Math.round(x / 64) * 64)
const wait = (reason) => ({ min: null, max: null, reason, lines: [] })
const fixed = (amount, lines) => ({ min: amount, max: amount, lines })
const validSize = (size) =>
  [size?.width, size?.height].every((n) => Number.isInteger(n) && n > 0 && n <= 4096)

function normalizedArea(width, height, min, max) {
  const area = width * height
  if (area >= min && area <= max) return area
  const scale = Math.sqrt((area < min ? min : max) / area)
  return Math.floor(width * scale) * Math.floor(height * scale)
}

function maxEnhanceSize(width, height) {
  // Max Enhance bills its latent 2× working dimensions, capped at 3 MP.
  const w = Math.floor(width / 16) * 32,
    h = Math.floor(height / 16) * 32
  const k = Math.min(1, Math.sqrt(maxPixels / (w * h)))
  let rw = 32 * Math.round((w * k) / 32),
    rh = 32 * Math.round((h * k) / 32)
  if (rw * rh > maxPixels) {
    rw = 32 * Math.floor((w * k) / 32)
    rh = 32 * Math.floor((h * k) / 32)
  }
  const snapped = { width: round64(rw), height: round64(rh) }
  return snapped.width * snapped.height <= maxPixels ? snapped : { width: rw, height: rh, nearLimit: true }
}

function generationUnit(area, steps, v5, medium, smea, strength) {
  const sample = medium
    ? ((perPixel + perPixelStep * 23) * area) / 1.75
    : Math.ceil((perPixel + perPixelStep * steps) * area)
  return Math.max(2, Math.ceil(sample * (v5 ? 1.5 : 1) * smea * strength))
}

function withAllowance(unit, batch, eligible, v5, account, surcharge, lines) {
  const paid = unit * batch + surcharge
  const opus = account?.connected && account.tier >= 3 && (account.entitled ?? account.active)
  if (!eligible || !opus) {
    if (eligible && !account?.connected) lines.push('按标准价估算。连接后按账户权益重新计算。')
    return fixed(paid, lines)
  }
  if (v5 && typeof account.usage?.isNegative !== 'boolean') {
    lines.push('账户未返回 V5 额度状态。区间两端分别为首张获抵扣及全额计费。')
    return { min: paid - unit, max: paid, lines }
  }
  if (v5 && account.usage.isNegative) {
    lines.push('官方标记 V5 可用额度已用尽，按 Anlas 标准价估算。')
    return fixed(paid, lines)
  }
  lines.push('Opus 首张基础费用 −' + unit + ' Anlas' + (v5 ? '，使用 V5 额度。' : '。'))
  if (v5) {
    // Official FAQ: ~17.3 standard (1 MP / 23-step) images per percentage point.
    // The official journal states that usage scales with the image's Anlas value.
    const baseline = generationUnit(megapixel, 23, true, false, 1, 1)
    const quota = unit / (17.3 * baseline)
    lines.push(
      '额度折算约 ' +
        quota.toFixed(3) +
        '%（首张）。参考官方 1 MP / 23 步每 1% 约 17.3 张，按基础费用比例估算。',
    )
    return { ...fixed(paid - unit, lines), quota }
  }
  return fixed(paid - unit, lines)
}

export function estimateAnlas(settings, account) {
  if (!settings) return wait('等待读取参数')
  const d = settings
  if (d.mode === 'encode-vibe')
    return fixed(d.encoded ? 0 : 2, [d.encoded ? '复用已有编码。' : '新编码一次收取 2 Anlas。'])
  if (d.mode === 'pixel-snap') return fixed(0, ['像素规整在本机处理。'])
  if (d.mode !== 'generate' && !validSize(d.source)) return wait('等待导入底图')
  if (d.mode === 'upscale') {
    const area = d.source.width * d.source.height
    if (area > 2_250_000) return wait('超过工作台超分输入上限')
    const thresholds = [megapixel, 1_747_627, 2_446_678, maxPixels]
    const price = thresholds.findIndex((max) => area <= max) + 1
    return fixed(price, ['独立放大按输入分辨率计费，每张 ' + price + ' Anlas。'])
  }
  if (d.mode === 'augment') {
    if (
      ![
        'lineart',
        'sketch',
        'colorize',
        'emotion',
        'bg-removal',
        'declutter',
        'declutter-keep-bubbles',
      ].includes(d.tool)
    )
      return wait('等待选择导演工具')
    const area = normalizedArea(d.source.width, d.source.height, megapixel, maxPixels)
    const unit = generationUnit(area, 28, false, false, 1, 1)
    if (d.tool === 'bg-removal') return fixed(3 * unit + 5, ['去背景按 3 × ' + unit + ' + 5 计费。'])
    return withAllowance(unit, 1, area <= megapixel, false, account, 0, [
      '导演工具按 28 步和输入图尺寸估算，基础 ' + unit + ' Anlas。',
    ])
  }
  if (!['generate', 'img2img', 'inpaint'].includes(d.mode) || !modelId.test(d.model))
    return wait('此操作暂无计费数据')
  const v5 = d.model.startsWith('nai-diffusion-5-'),
    modern = !d.model.endsWith('-3')
  const medium = d.medium === true && d.model === 'nai-diffusion-5-full'
  const steps = medium ? 14 : d.steps
  const batch = d.batch
  const focus = d.mode === 'inpaint' && d.focusInpaint
  if (focus && (d.focusUnknown || !validSize(d.focusSize))) return wait('等待读取聚焦蒙版尺寸')
  const maxEnhance = d.mode === 'img2img' && v5 && d.enhance === 'max'
  const size = focus ? d.focusSize : maxEnhance ? maxEnhanceSize(d.source.width, d.source.height) : d
  const area = size.width * size.height
  if (
    !validSize(size) ||
    area > maxPixels ||
    !Number.isInteger(steps) ||
    steps < 1 ||
    steps > 50 ||
    !Number.isInteger(batch) ||
    batch < 1 ||
    batch > 8 ||
    (maxEnhance && batch !== 1)
  )
    return wait('请核对尺寸、步数与张数')
  const strength = d.mode === 'img2img' || (modern && d.mode === 'inpaint') ? d.strength : 1
  if (typeof strength !== 'number' || !Number.isFinite(strength) || strength < 0 || strength > 1)
    return wait('请核对重绘强度')
  const smea = modern || d.mode !== 'generate' ? 1 : { sm: 1.2, dynamic: 1.4 }[d.smea] || 1
  const unit = generationUnit(area, steps, v5, medium, smea, strength)
  if (unit > 140) return wait('当前设置超出官方单张费用估算范围')
  const refs = (d.references || []).filter((r) => r.enabled !== false),
    vibes = refs.filter((r) => r.kind === 'vibe')
  const precise = refs.length - vibes.length
  if (
    (vibes.length && (v5 || precise || (modern && d.mode === 'inpaint'))) ||
    (precise && !d.model.startsWith('nai-diffusion-4-5-'))
  )
    return wait('请核对当前模型的参考图组合')
  const vibeFee = modern ? 2 * Math.max(0, vibes.length - 4) : 0
  const preciseFee = 5 * precise * batch
  const lines = [
    size.width + ' × ' + size.height + ' · ' + steps + ' 步 · ' + unit + ' Anlas × ' + batch + ' 张。',
  ]
  if (focus) lines.push('按聚焦重绘区域估算。')
  if (maxEnhance) lines.push('按 Max Enhance 放大后的工作尺寸估算。')
  if (size.nearLimit) lines.push('此长宽比按官方工作尺寸近似，64 像素取整后会越过 3 MP 上限。')
  if (medium) lines.push('V5 Full Medium 使用官方 14 步折算。')
  if (vibeFee) lines.push('超过 4 个 Vibe 的附加费 +' + vibeFee + ' Anlas / 次。')
  if (preciseFee)
    lines.push('精确参考 ' + precise + ' 个 × 5 × ' + batch + ' 张，附加 ' + preciseFee + ' Anlas。')
  if (modern) {
    const missing = vibes.filter((r) => r.encoded === false).length
    if (missing)
      lines.push(missing + ' 个 Vibe 待单独编码，共 ' + 2 * missing + ' Anlas。生成价不含这笔费用。')
  }
  return withAllowance(
    unit,
    batch,
    area <= megapixel && steps <= 28,
    v5,
    account,
    vibeFee + preciseFee,
    lines,
  )
}
