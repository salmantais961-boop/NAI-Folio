import { recall, remember, encodingKey, cacheId } from './controls-vibe-cache.js'
import { UC, IMAGE_SIZES, matchImageSize } from './controls-presets.js'
import { focusInpaint, estimateFocus } from './controls-focus.js'
import {
  MODELS,
  MODES,
  TOOLS,
  SAMPLERS,
  EMOTIONS,
  initial,
  seedNumber,
  isPng,
  base64,
  capabilities,
  maxBatch,
  requestFor,
} from './controls-model.js'
import { sourceImage, referenceImage, readVibes, saveVibe, editMask, expandSource } from './controls-media.js'
import { connection, streamResult } from './controls-account.js'
import { mountGenerationDock } from './generation-dock.js'

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )
const options = (entries, v) =>
  entries
    .map(
      ([id, t]) =>
        `<option value="${esc(id)}"${String(id) === String(v) ? ' selected' : ''}>${esc(t)}</option>`,
    )
    .join('')
const select = (k, label, entries, v, disabled = false) =>
  `<label class="fc-input"><span>${label}</span><select data-f="${k}" ${disabled ? 'disabled' : ''}>${options(entries, v)}</select></label>`
const number = (k, label, v, min, max, step = 1, disabled = false) =>
  `<label class="fc-input"><span>${label}</span><input type="number" data-f="${k}" value="${esc(v)}" min="${min}" max="${max}" step="${step}" ${disabled ? 'disabled' : ''} ${k === 'seed' ? 'placeholder="随机"' : ''}></label>`
const toggle = (k, label, v, disabled = false) =>
  `<label class="fc-check"><input type="checkbox" data-f="${k}" ${v ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span>${label}</span></label>`
const button = (action, label, extra = '') =>
  `<button type="button" data-action="${action}" ${extra}>${label}</button>`
const disclosure = (id, label, en, inner) =>
  `<details class="fc-details" data-section="${id}"><summary><span>${label}</span><small>${en}</small><i aria-hidden="true"></i></summary><div class="fc-detail-body">${inner}</div></details>`
const kinds = { vibe: 'Vibe 氛围', character: '角色参考', style: '风格参考', 'character&style': '角色与风格' }
const orientations = { portrait: '竖幅', landscape: '横幅', square: '方形' }
const emotionNames =
  '平静 开心 悲伤 生气 害怕 惊讶 疲惫 兴奋 紧张 思考 困惑 害羞 厌恶 得意 无聊 大笑 烦躁 激动 尴尬 担心 爱慕 坚定 受伤 俏皮'.split(
    ' ',
  )
const inRange = (n, min, max) => Math.max(min, Math.min(max, Number(n) || 0))
export function mountControls(el, callbacks = {}) {
  const d = structuredClone(initial),
    account = connection(callbacks),
    expanded = new Set()
  let modeToken = 0,
    encoding = false,
    refKind = 'vibe',
    busy = false,
    customSize = false
  const { modelHost, transportHost, dockHost } = callbacks
  const hosts = [...new Set([el, modelHost, transportHost, dockHost].filter(Boolean))]
  const sizeHost = dockHost || el
  const listen = (type, listener) => hosts.forEach((host) => host.addEventListener(type, listener))
  for (const host of hosts) host.classList.add('folio-controls')
  let cleanups = []
  function getSettings({ includeMedia = false } = {}) {
    const { source, mask, references, ...settings } = d
    return structuredClone(includeMedia ? d : settings)
  }
  let measuredMask = null,
    focusSize = null
  function billingSettings() {
    const snapshot = getSettings()
    const focused = d.mode === 'inpaint' && d.focusInpaint
    if (focused && d.mask && measuredMask !== d.mask) {
      const mask = d.mask
      measuredMask = mask
      focusSize = null
      estimateFocus(mask)
        .then((size) => {
          if (d.mask !== mask || measuredMask !== mask) return
          focusSize = size
          if (callbacks.onBillingChange) callbacks.onBillingChange()
          else change()
        })
        .catch(() => {})
    }
    if (!d.mask) {
      measuredMask = null
      focusSize = null
    }
    return {
      ...snapshot,
      source: d.source ? { width: d.source.width, height: d.source.height } : null,
      references: d.references.map((r) => ({
        kind: r.kind,
        enabled: r.enabled !== false,
        information: r.information,
        strength: r.strength,
        encoded: !!r.encodings?.[encodingKey(r, d.model)],
      })),
      focusUnknown: focused && (!focusSize || measuredMask !== d.mask),
      focusSize: focused && measuredMask === d.mask ? focusSize : null,
    }
  }
  function change() {
    refreshSamplingSummary()
    callbacks.onChange?.(getSettings())
  }
  function reportMode() {
    const [label, button] = MODES[d.mode]
    callbacks.onMode?.({ id: d.mode, label, button })
  }
  function note(msg) {
    callbacks.notify?.(msg)
    const status = el.querySelector('.fc-notice')
    if (status) status.textContent = msg
  }
  function modelPanel(cap) {
    const allModes = Object.entries(MODES)
      .map(([id, [label]]) => button('mode', label, `data-id="${id}" aria-pressed="${d.mode === id}"`))
      .join('')
    const modes = '<div class="fc-mode-switch" role="group" aria-label="工作模式">' + allModes + '</div>'
    if (!cap.imageMode) return '<div class="fc-model-bar">' + modes + '</div>'
    const dataset = cap.modern
      ? select(
          'dataset',
          '数据集',
          [
            ['anime', 'Anime'],
            ['furry', 'Furry'],
            ...(cap.family !== 'v4' ? [['background', 'Background']] : []),
          ],
          d.dataset,
        )
      : ''
    const effort = cap.medium
      ? select(
          'medium',
          '运算强度',
          [
            ['false', 'High'],
            ['true', 'Medium'],
          ],
          d.medium,
        )
      : ''
    return `<div class="fc-model-bar"><div class="fc-engine-line"><label class="fc-engine"><span class="fc-engine-icon folio-mark" aria-hidden="true"></span><span class="fc-engine-fields"><small>IMAGE MODEL</small><select aria-label="生成模型" data-f="model">${options(
      MODELS.map(([id, n]) => [id, n]),
      d.model,
    )}</select></span></label>${dataset}${effort}</div>${modes}</div>`
  }
  function sizePanel() {
    const locked = !!d.source && d.mode !== 'generate'
    const match = !customSize && matchImageSize(d.width, d.height)
    const category = match?.category || 'custom'
    const preset = IMAGE_SIZES[category]
    const ratios = Object.entries(orientations)
      .map(([id, label]) => {
        const size = preset?.[id]
        return button(
          'ratio',
          `<i class="fc-ratio-${id}" aria-hidden="true"></i><span>${label}</span>`,
          `data-id="${id}" aria-label="${label}${size ? ` ${size.join(' × ')}` : ''}" title="${size ? size.join(' × ') : 'Wallpaper 没有方形预设'}" aria-pressed="${id === match?.orientation}" ${locked || !size ? 'disabled' : ''}`,
        )
      })
      .join('')
    return `<section class="fc-size"><div class="fc-label">图像设置 <small>${esc(d.width)} × ${esc(d.height)} PX</small></div><div class="fc-size-preset"><label class="fc-preset-picker"><span class="sr-only">画幅尺寸预设</span><select data-f="sizePreset" aria-label="画幅尺寸预设" ${locked ? 'disabled' : ''}>${options([...Object.entries(IMAGE_SIZES).map(([id, p]) => [id, p.label]), ['custom', 'Custom']], category)}</select></label><div class="fc-formats" role="group" aria-label="画幅方向" ${category === 'custom' ? 'hidden' : ''}>${ratios}</div><span class="fc-size-custom" ${category === 'custom' ? '' : 'hidden'}>自定义画幅 · 64 px 步进</span></div><div class="fc-dimensions">${number('width', '宽度 / px', d.width, 64, 4096, 64, locked)}${number('height', '高度 / px', d.height, 64, 4096, 64, locked)}${number('batch', '生成张数', d.batch, 1, maxBatch(d.width, d.height))}</div></section>`
  }

  function setSizePreset(category, orientation) {
    const preset = IMAGE_SIZES[category]
    if (!preset) return
    const fallback = d.width > d.height ? 'landscape' : 'portrait'
    ;[d.width, d.height] = preset[orientation] || preset[fallback]
    d.batch = Math.min(maxBatch(d.width, d.height), d.batch)
    customSize = false
  }

  function refreshSize() {
    const size = sizeHost.querySelector('.fc-size')
    if (!size) return
    const active = document.activeElement
    const field = size.contains(active) ? active.dataset.f : null
    size.outerHTML = sizePanel()
    if (field) sizeHost.querySelector(`.fc-size [data-f="${field}"]`)?.focus({ preventScroll: true })
  }
  function transportPanel(cap) {
    const supported = cap.imageMode && cap.modern
    const checked = supported && d.stream
    const hint = !supported
      ? cap.imageMode
        ? 'V3 仅支持标准生成'
        : '此模式仅支持标准输出'
      : checked
        ? '逐步显示去噪过程'
        : '等待完整图像'
    return `<label class="fc-transport ${supported ? '' : 'is-disabled'}" title="${hint}"><span class="fc-stream-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span class="fc-stream-caption"><b>流式预览</b><small>${hint}</small></span><input type="checkbox" role="switch" aria-label="流式预览" data-f="stream" ${checked ? 'checked' : ''} ${supported ? '' : 'disabled'}><span class="fc-switch" aria-hidden="true"></span></label>`
  }
  function samplingSummary(cap = capabilities(d)) {
    const steps = d.medium && cap.medium ? 14 : Number.isFinite(d.steps) ? d.steps : '—'
    const scale = Number.isFinite(d.scale) ? d.scale : '—'
    return `${steps} STEP · CFG ${scale}`
  }
  function refreshSamplingSummary() {
    const summary = sizeHost.querySelector('[data-section="sampling"] > summary small')
    if (summary) summary.textContent = samplingSummary()
  }
  function presentSampling(cap) {
    const medium = d.medium && cap.medium
    return disclosure(
      'sampling',
      '采样参数',
      samplingSummary(cap),
      `<div class="fc-grid">

      ${number('steps', '采样步数', medium ? 14 : d.steps, 1, 50, 1, medium)}${number('scale', '提示词引导 / CFG', d.scale, 0, 10, 0.1)}
      ${select('sampler', '采样器', Object.entries(SAMPLERS), medium ? 'k_euler_ancestral' : d.sampler, medium)}
      ${select(
        'noiseSchedule',
        '噪声调度',
        ['karras', 'native', 'exponential', 'polyexponential'].map((v) => [v, v]),
        cap.v5 ? 'karras' : d.noiseSchedule,
        cap.v5,
      )}
      ${number('cfgRescale', '引导重缩放', d.cfgRescale, 0, 1, 0.01, medium)}

      </div><div class="fc-seed">${number('seed', '种子 / Seed', d.seed, 0, 4294967295)}${button('new-seed', '掷骰')}${button('reset-seed', '随机')}</div>
      <div class="fc-grid">${select('quality', '质量标签', [['off', '关闭'], ...(cap.v5 ? [['light', '轻量']] : []), ['standard', '标准']], d.quality)}
      ${select(
        'uc',
        '负面预设',
        Object.entries({
          none: '无',
          light: '轻量',
          heavy: '加强',
          humanFocus: '人物优先',
          furryFocus: 'Furry 优先',
        }).filter(([id]) => id in UC[d.model]),
        medium ? 'heavy' : d.uc,
        medium,
      )}

      ${
        !cap.modern && d.mode === 'generate'
          ? select(
              'smea',
              '采样增强',
              [
                ['off', '关闭'],
                ['auto', '自动 SMEA'],
                ['sm', 'SMEA'],
                ['dynamic', 'SMEA DYN'],
              ],
              d.smea,
            )
          : ''
      }</div>
      ${medium ? '<p class="fc-note">Medium 固定使用 14 步、Euler Ancestral 与 Heavy 负面预设。</p>' : ''}
      <div class="fc-flags">${!cap.v5 ? toggle('variety', '多样性增强', d.variety) : ''}${!cap.modern ? toggle('decrisper', 'Decrisper 去过锐', d.decrisper) : ''}${cap.family === 'v4' ? toggle('legacyUC', '旧版负面词行为', d.legacyUC) : ''}${cap.v5 ? toggle('transparent', '透明背景', d.transparent) : ''}</div>`,
    )
  }
  function characters(cap) {
    const charRows = d.characters
      .map(
        (c, i) =>
          `<div class="fc-char" data-c="${i}"><div class="fc-asset-title"><b>CHAR. ${String(i + 1).padStart(2, '0')}</b>${button('pick-char', '角色图鉴 ↗')}${button('delete-char', '移除')}</div><label class="fc-input"><span>角色提示词</span><textarea data-key="prompt" placeholder="角色名称、外观、动作…">${esc(c.prompt)}</textarea></label><label class="fc-input"><span>角色负面词</span><textarea data-key="negative" rows="1" placeholder="此角色需要避开的元素">${esc(c.negative)}</textarea></label>${d.useCoords ? `<button class="fc-position" type="button" data-action="position" aria-label="点选角色 ${i + 1} 位置" style="--cx:${c.x * 100}%;--cy:${c.y * 100}%"><i></i></button><div class="fc-grid"><label class="fc-input"><span>横向位置 X</span><input type="number" data-key="x" min="0" max="1" step="${cap.v5 ? 0.01 : 0.1}" value="${esc(c.x)}"></label><label class="fc-input"><span>纵向位置 Y</span><input type="number" data-key="y" min="0" max="1" step="${cap.v5 ? 0.01 : 0.1}" value="${esc(c.y)}"></label></div>` : ''}<div class="fc-inline"><label class="fc-check"><input data-key="enabled" type="checkbox" ${c.enabled !== false ? 'checked' : ''}>启用此角色</label>${button('raise-char', '上移', i === 0 ? 'disabled' : '')}${button('lower-char', '下移', i === d.characters.length - 1 ? 'disabled' : '')}</div></div>`,
      )
      .join('')
    return disclosure(
      'characters',
      '多角色构图',
      `${d.characters.length} / ${cap.chars}`,
      `${toggle('useCoords', '指定角色在画面中的位置', d.useCoords)}${d.useCoords ? `<p class="fc-note">${cap.v5 ? 'X、Y 范围 0 到 1；原点在画面左上角。' : cap.family === 'v4' ? 'V4 在两个以上角色时启用 5 × 5 网格定位。' : 'V4.5 使用 5 × 5 网格定位。'}</p>` : ''}${charRows}${button('add-char', '＋ 添加独立角色', `class="fc-add" ${d.characters.length >= cap.chars ? 'disabled' : ''}`)}`,
    )
  }
  function refMarkup(cap) {
    if (!cap.precise && refKind !== 'vibe') refKind = 'vibe'
    if (!cap.vibe && cap.precise && refKind === 'vibe') refKind = 'character'
    const canAdd = cap.precise || cap.vibe
    const refs = d.references
      .map((r, i) => {
        const cached = !!r.encodings?.[encodingKey(r, d.model)]
        const encoded = cap.modern && r.kind === 'vibe'
        return `<div class="fc-ref" data-r="${i}"><div class="fc-ref-top">${r.data ? `<img src="${esc(r.data)}" alt="">` : '<span>V</span>'}<div><small>${esc(kinds[r.kind])}</small><b>${esc(r.name)}</b></div><label class="fc-check"><input type="checkbox" data-key="enabled" ${r.enabled ? 'checked' : ''}>启用</label>${button('delete-ref', '移除')}</div><div class="fc-grid"><label class="fc-input"><span>参考强度</span><input type="number" data-key="strength" value="${r.strength}" min="0" max="1" step=".05"></label><label class="fc-input"><span>${r.kind === 'vibe' ? '提取信息量' : '忠实度'}</span><input type="number" data-key="${r.kind === 'vibe' ? 'information' : 'fidelity'}" value="${r.kind === 'vibe' ? r.information : r.fidelity}" min="0" max="1" step=".05"></label></div>${encoded && cap.vibe && r.data ? `<div class="fc-inline">${button('mask-vibe', r.mask ? '修改参考蒙版 ↗' : '绘制参考蒙版 ↗')}${r.mask ? `<label class="fc-check"><input type="checkbox" data-key="cropToMask" ${r.cropToMask ? 'checked' : ''}>裁至选区</label>${button('clear-vibe-mask', '整张参考')}` : ''}</div>` : ''}${encoded && cap.vibe ? `<div class="fc-asset-title"><small>${cached ? '当前模型已编码' : '生成前需完成编码'}</small>${cached ? button('export-vibe', '导出 Vibe ↗') : button('encode', '编码 · 2 Anlas', !r.data || encoding ? 'disabled' : '')}</div>` : ''}</div>`
      })
      .join('')
    return disclosure(
      'references',
      '图像参考',
      d.references.length ? `${d.references.length} REF.` : 'REFERENCE',
      `${
        canAdd
          ? `<div class="fc-ref-add"><label class="fc-input"><span>参考类型</span><select data-f="refKind">${options(
              Object.entries(kinds).filter(([k]) => (k === 'vibe' ? cap.vibe : cap.precise)),
              refKind,
            )}</select></label><label class="fc-file-button">＋ 导入参考<input type="file" data-file="reference" accept="image/jpeg,image/png,image/webp,.naiv4vibe,.naiv4vibebundle" multiple></label></div>`
          : ''
      }<p class="fc-note">${!canAdd ? '当前模型或模式没有可用的图像参考。切换至 V4.5 文生图可使用 Vibe 和精确参考。' : refKind === 'vibe' ? (cap.modern ? '可导入 .naiv4vibe 或图片。首次编码每张 2 Anlas。' : 'V3 使用 448 × 448 的参考图。') : '精确参考每张每次额外 5 Anlas，可与局部重绘同时使用。'}</p>${refs}${cap.vibe ? toggle('normalizeVibes', '将多张 Vibe 的强度合计归一化', d.normalizeVibes) : ''}`,
    )
  }
  function sourceMarkup(cap) {
    const src = d.source
    let extra = ''
    if (d.mode === 'inpaint' && src)
      extra = `<div class="fc-inline">${button('mask', d.mask ? '修改重绘蒙版 ↗' : '＋ 绘制重绘蒙版')}${button('outpaint', '向外扩展 64 px')}</div>`
    if (d.mode === 'inpaint' && src)
      extra += toggle('focusInpaint', '聚焦重绘 · 放大蒙版区域，生成后贴回原图', d.focusInpaint)
    if (['img2img', 'inpaint'].includes(d.mode))
      extra += `<div class="fc-grid">${number('strength', '重绘强度', d.strength, 0, 1, 0.01)}${d.mode === 'img2img' ? number('noise', '噪声', d.noise, 0, 1, 0.01) : ''}${d.mode === 'img2img' && ['v5', 'v45'].includes(cap.family) ? select('enhance', '图像增强', [['off', '关闭'], ['normal', 'Enhance'], ...(cap.v5 ? [['max', 'Max Enhance']] : [])], d.enhance) : ''}</div>`
    if (d.mode === 'augment')
      extra +=
        select('tool', '图像处理', Object.entries(TOOLS), d.tool) +
        (['colorize', 'emotion'].includes(d.tool)
          ? `<div class="fc-grid">${
              d.tool === 'emotion'
                ? select(
                    'emotion',
                    '目标表情',
                    EMOTIONS.map((v, i) => [v, emotionNames[i]]),
                    d.emotion,
                  )
                : ''
            }${number('defry', '削弱原图色彩', d.defry, 0, 5)}</div><label class="fc-input"><span>补充说明</span><input type="text" data-f="toolPrompt" value="${esc(d.toolPrompt)}" placeholder="配色或表情细节"></label>`
          : '')
    if (d.mode === 'upscale')
      extra += select(
        'blur',
        '超分降噪',
        [[0, '关闭'], ...[0.3, 0.35, 0.4, 0.45, 0.5].map((n) => [n, String(n)])],
        d.blur,
      )
    return `<div class="fc-source">${src ? `<div class="fc-ref-top"><img src="${esc(src.data)}" alt="底图"><div><small>BASE IMAGE</small><b>${esc(src.name)}</b><small>${src.width} × ${src.height} PX</small></div>${button('remove-source', '移除')}</div>` : ''}<label class="fc-file-button">${src ? '替换底图' : '＋ 导入底图'}<input type="file" data-file="source" accept="image/png,image/jpeg,image/webp"></label>${extra}</div>`
  }
  function render() {
    for (const fn of cleanups) if (typeof fn === 'function') fn()
    cleanups = []
    const cap = capabilities(d)
    const model = modelPanel(cap),
      transport = transportPanel(cap)
    if (modelHost) modelHost.innerHTML = model
    if (transportHost) transportHost.innerHTML = transport
    if (dockHost) {
      dockHost.classList.add('generation-controls')
      dockHost.innerHTML = cap.imageMode
        ? sizePanel() + presentSampling(cap)
        : `<div class="gd-mode-note"><span>${d.mode === 'upscale' ? '2× 超分输出' : '导演工具输出'}</span><small>${d.source ? `${d.source.width * (d.mode === 'upscale' ? 2 : 1)} × ${d.source.height * (d.mode === 'upscale' ? 2 : 1)} PX` : '先导入一张底图'}</small></div>`
    }
    const sections = [
      modelHost ? '' : model,
      d.mode === 'generate' ? '' : sourceMarkup(cap),
      cap.imageMode && cap.chars ? characters(cap) : '',
      cap.imageMode ? refMarkup(cap) : '',
      cap.imageMode && !dockHost ? sizePanel() + presentSampling(cap) : '',
      transportHost ? '' : transport,
      '<div class="fc-notice" role="status"></div>',
    ]
    el.innerHTML = sections.join('')

    for (const det of hosts.flatMap((host) => [...host.querySelectorAll('details')])) {
      const section = det.dataset.section
      det.open = expanded.has(section)
      det.ontoggle = () => {
        if (!det.isConnected) return
        if (det.open) expanded.add(section)
        else expanded.delete(section)
      }
    }
    for (const ta of el.querySelectorAll('[data-c] textarea')) {
      if (callbacks.bindAutocomplete) cleanups.push(callbacks.bindAutocomplete(ta))
      else
        import('./catalog.js')
          .then((m) => {
            if (ta.isConnected) cleanups.push(m.attachAutocomplete(ta))
          })
          .catch(() => {})
    }
  }
  function restore(settings) {
    if (!settings || typeof settings !== 'object') throw Error('无法识别生成参数。')
    const next = structuredClone(initial)
    const enums = {
      mode: Object.keys(MODES),
      model: MODELS.map(([id]) => id),
      sampler: Object.keys(SAMPLERS),
      noiseSchedule: ['karras', 'native', 'exponential', 'polyexponential'],
      uc: ['none', 'light', 'heavy', 'humanFocus', 'furryFocus'],
      dataset: ['anime', 'furry', 'background'],
      quality: ['off', 'standard', 'light'],
      smea: ['off', 'auto', 'sm', 'dynamic'],
      enhance: ['off', 'normal', 'max'],
      tool: Object.keys(TOOLS),
      emotion: EMOTIONS,
    }
    for (const [k, value] of Object.entries(next)) {
      const v = settings[k]
      if (v == null) continue
      if (k === 'seed') {
        if (Number.isInteger(v) && v >= 0 && v <= 4294967295) next.seed = v
      } else if (k in enums) {
        if (enums[k].includes(v)) next[k] = v
      } else if (typeof v === typeof value && ['boolean', 'string'].includes(typeof v)) next[k] = v
      else if (typeof value === 'number' && Number.isFinite(v)) next[k] = v
    }
    const mediaImage = (s) =>
      s &&
      isPng(s.data) &&
      Number.isInteger(s.width) &&
      Number.isInteger(s.height) &&
      s.width > 0 &&
      s.height > 0 &&
      s.width * s.height <= 3145728
    next.characters = (Array.isArray(settings.characters) ? settings.characters : [])
      .slice(0, 22)
      .filter(Boolean)
      .map((c) => ({
        prompt: String(c.prompt || ''),
        negative: String(c.negative || ''),
        x: inRange(c.x ?? 0.5, 0, 1),
        y: inRange(c.y ?? 0.5, 0, 1),
        enabled: c.enabled !== false,
      }))
    if (mediaImage(settings.source)) {
      next.source = {
        data: settings.source.data,
        name: String(settings.source.name || '配方底图'),
        width: settings.source.width,
        height: settings.source.height,
      }
      if (typeof settings.source.origin?.workId === 'string')
        next.source.origin = { workId: settings.source.origin.workId.slice(0, 160) }
      if (isPng(settings.mask)) next.mask = settings.mask
    }
    next.references = (Array.isArray(settings.references) ? settings.references : [])
      .slice(0, 16)
      .filter(
        (r) =>
          r &&
          Object.hasOwn(kinds, r.kind) &&
          (isPng(r.data) || (r.encodings && typeof r.encodings === 'object')),
      )
      .map((r) => ({
        kind: r.kind,
        name: String(r.name || '参考图'),
        data: isPng(r.data) ? r.data : undefined,
        v3: isPng(r.v3) ? r.v3 : undefined,
        mask: isPng(r.mask) ? r.mask : null,
        maskId: /^[a-f0-9]{64}$/.test(r.maskId) ? r.maskId : null,
        cropToMask: r.cropToMask === true,
        enabled: r.enabled !== false,
        strength: inRange(r.strength ?? 0.6, 0, 1),
        information: inRange(r.information ?? 1, 0, 1),
        fidelity: inRange(r.fidelity ?? 1, 0, 1),
        encodings: Object.fromEntries(
          Object.entries(r.encodings || {}).filter(
            ([key, v]) =>
              /^nai-diffusion-[\w.-]+@[0-9.]+(?:#[a-f0-9]{64}\.[01])?$/.test(key) &&
              typeof v === 'string' &&
              /^[A-Za-z0-9+/=]+$/.test(v),
          ),
        ),
      }))
    Object.assign(d, next)
    customSize = false
    d.batch = Math.min(maxBatch(d.width, d.height), d.batch)
    modeToken++
    render()
    change()
    reportMode()
  }
  async function setSource(input, mode = 'img2img', origin = null) {
    if (!Object.hasOwn(MODES, mode) || mode === 'generate') throw Error('请选择有效的图像编辑模式。')
    const seq = ++modeToken
    const src = await sourceImage(input, input.name, mode)
    if (seq !== modeToken) return
    if (origin?.workId) src.origin = { workId: String(origin.workId).slice(0, 160) }
    Object.assign(d, { source: src, mask: null, width: src.width, height: src.height, mode })
    render()
    change()
    reportMode()
  }
  function setMode(mode) {
    if (!Object.hasOwn(MODES, mode)) throw Error('未知生成模式。')
    modeToken++
    if (d.source && ['img2img', 'inpaint'].includes(mode) && (d.source.width % 64 || d.source.height % 64)) {
      return setSource(d.source.data, mode, d.source.origin).catch((err) => note(err.message))
    }
    if (d.source && mode !== 'generate') {
      d.width = d.source.width
      d.height = d.source.height
    }
    if (mode === 'generate' && (d.width % 64 || d.height % 64)) {
      d.width = initial.width
      d.height = initial.height
    }
    d.mode = mode
    render()
    change()
    reportMode()
  }
  function openSection(id) {
    const section = hosts.map((host) => host.querySelector(`[data-section="${CSS.escape(id)}"]`)).find(Boolean)
    if (!section) return
    section.open = true
    expanded.add(id)
    section.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }
  listen('input', (e) => {
    const t = e.target,
      k = t.dataset.key,
      field = t.dataset.f
    if (k && (t.matches('textarea') || t.type === 'number')) {
      const target = t.closest('[data-c]')
        ? d.characters[+t.closest('[data-c]').dataset.c]
        : d.references[+t.closest('[data-r]').dataset.r]
      target[k] = t.type === 'number' ? inRange(t.value, 0, 1) : t.value
      if (k === 'x' || k === 'y')
        t.closest('[data-c]')
          .querySelector('.fc-position')
          ?.style.setProperty('--c' + k, target[k] * 100 + '%')
      if (k === 'information') {
        const heading = t.closest('[data-r]').querySelector('.fc-asset-title'),
          cached = !!target.encodings[encodingKey(target, d.model)]
        if (heading) {
          const control = heading.querySelector('button')
          control.dataset.action = cached ? 'export-vibe' : 'encode'
          control.textContent = cached ? '导出 Vibe ↗' : '编码 · 2 Anlas'
          control.disabled = !cached && (!target.data || encoding)
          heading.querySelector('small').textContent = cached ? '当前模型已编码' : '生成前需完成编码'
        }
      }
      change()
    } else if (field && (t.type === 'number' || t.type === 'text')) {
      d[field] =
        t.type === 'text' ? t.value : t.value === '' ? (field === 'seed' ? null : NaN) : Number(t.value)
      change()
    }
  })
  listen('change', async (e) => {
    const t = e.target,
      k = t.dataset.f
    try {
      if (t.dataset.file === 'source' && t.files[0]) {
        await setSource(t.files[0], d.mode)
        return
      }
      if (t.dataset.file === 'reference' && t.files.length) {
        const files = [...t.files],
          kind = refKind,
          seq = modeToken,
          items = []
        for (const f of files)
          items.push(
            ...(/\.naiv4vibe(bundle)?$/i.test(f.name) ? await readVibes(f) : [await referenceImage(f, kind)]),
          )
        await Promise.all(items.map((ref) => recall(ref).catch(() => {})))
        if (seq !== modeToken) return
        if (items.length + d.references.length > 16) throw Error('最多可导入 16 张参考。')
        d.references.push(...items)
        render()
        change()
        return
      }
      if (t.closest('[data-c]') && t.dataset.key === 'enabled') {
        d.characters[+t.closest('[data-c]').dataset.c].enabled = t.checked
        change()
        return
      }
      if (t.closest('[data-r]') && t.dataset.key) {
        const ref = d.references[+t.closest('[data-r]').dataset.r]
        if (t.type === 'checkbox') ref[t.dataset.key] = t.checked
        if (t.dataset.key === 'cropToMask') render()
        change()
        return
      }
      if (t.closest('[data-c]') && ['x', 'y'].includes(t.dataset.key)) return
      if (t.dataset.key || !k) return
      if (k === 'refKind') {
        refKind = t.value
        render()
        return
      }
      if (k === 'sizePreset') {
        if (t.value === 'custom') customSize = true
        else
          setSizePreset(
            t.value,
            d.width === d.height ? 'square' : d.width > d.height ? 'landscape' : 'portrait',
          )
        refreshSize()
        change()
        if (customSize) sizeHost.querySelector('[data-f="width"]')?.focus({ preventScroll: true })
        return
      }
      if (t.matches('select')) d[k] = k === 'medium' ? t.value === 'true' : k === 'blur' ? +t.value : t.value
      if (t.type === 'checkbox') d[k] = t.checked
      if (k === 'stream') {
        const view = t.closest('.fc-transport')
        view.querySelector('.fc-stream-caption small').textContent = t.checked
          ? '逐步显示去噪过程'
          : '等待完整图像'
        view.title = view.querySelector('small').textContent
      }
      if (k === 'model') {
        if (!Object.hasOwn(UC[d.model], d.uc)) d.uc = 'none'
        const cap = capabilities(d)
        if (!cap.v5 && d.quality === 'light') d.quality = 'standard'
        if (cap.family === 'v4' && d.dataset === 'background') d.dataset = 'anime'
      }
      if (k === 'width' || k === 'height') {
        customSize = false
        d.batch = Math.min(maxBatch(d.width, d.height), d.batch)
        refreshSize()
      }
      if (t.matches('select') || k === 'useCoords') render()
      change()
    } catch (err) {
      note(err.message)
    }
  })
  listen('click', async (e) => {
    const b = e.target.closest('[data-action]')
    if (!b) return
    const a = b.dataset.action,
      i = Number(b.closest('[data-c]')?.dataset.c),
      r = Number(b.closest('[data-r]')?.dataset.r)
    try {
      if (a === 'mode') {
        setMode(b.dataset.id)
        return
      }
      if (a === 'ratio') {
        const preset = matchImageSize(d.width, d.height)?.category
        if (preset) setSizePreset(preset, b.dataset.id)
        refreshSize()
        change()
        sizeHost.querySelector(`.fc-formats [data-id="${b.dataset.id}"]`)?.focus({ preventScroll: true })
        return
      }
      if (a === 'new-seed') d.seed = seedNumber()
      if (a === 'reset-seed') d.seed = null
      if (a === 'add-char') {
        if (d.characters.length >= capabilities(d).chars) return
        d.characters.push({ prompt: '', negative: '', x: 0.5, y: 0.5, enabled: true })
      }
      if (a === 'delete-char') d.characters.splice(i, 1)
      if (a === 'raise-char' || a === 'lower-char') {
        const to = i + (a === 'raise-char' ? -1 : 1)
        if (to < 0 || to >= d.characters.length) return
        ;[d.characters[i], d.characters[to]] = [d.characters[to], d.characters[i]]
      }
      if (a === 'position') {
        if (!e.detail) {
          b.parentElement.querySelector('[data-key=x]').focus()
          return
        }
        const rect = b.getBoundingClientRect(),
          round = (n) =>
            capabilities(d).v5
              ? Math.round(inRange(n, 0, 1) * 100) / 100
              : (Math.min(4, Math.floor(inRange(n, 0, 1) * 5)) + 0.5) / 5
        d.characters[i].x = round((e.clientX - rect.left) / rect.width)
        d.characters[i].y = round((e.clientY - rect.top) / rect.height)
      }
      if (a === 'pick-char') {
        const ta = b.closest('[data-c]').querySelector('[data-key="prompt"]')
        ;(await import('./catalog.js')).openCatalog('character', ta)
        return
      }
      if (a === 'delete-ref') d.references.splice(r, 1)
      if (a === 'remove-source') {
        modeToken++
        d.source = null
        d.mask = null
      }
      if (a === 'mask') {
        const src = d.source
        await editMask(src, d.mask, (mask) => {
          if (d.source === src) {
            d.mask = mask
            render()
            change()
          }
        })
        return
      }
      if (a === 'outpaint') {
        const src = d.source
        const expanded = await expandSource(src, 64)
        if (d.source !== src) return
        Object.assign(d, expanded, { width: expanded.source.width, height: expanded.source.height })
      }
      if (a === 'mask-vibe') {
        const ref = d.references[r]
        await editMask(
          ref,
          ref.mask,
          async (mask) => {
            try {
              const maskId = mask ? await cacheId(mask) : null
              Object.assign(ref, { mask, maskId, cropToMask: !!mask && !!ref.cropToMask })
              render()
              change()
            } catch (error) {
              note(error.message)
            }
          },
          'vibe',
        )
        return
      }
      if (a === 'clear-vibe-mask')
        Object.assign(d.references[r], { mask: null, maskId: null, cropToMask: false })
      if (a === 'encode') {
        if (encoding) return
        const ref = d.references[r],
          model = d.model,
          info = ref.information,
          key = encodingKey(ref, model)
        if (ref.encodings[key]) return
        const body = {
          image: base64(ref.data),
          model,
          information_extracted: info,
          ...(ref.mask ? { mask: base64(ref.mask), crop_to_mask: !!ref.cropToMask } : {}),
        }
        encoding = true
        render()
        try {
          const session = await account.session()
          await session.ensure()
          const out = await (await session.fetchApi('encode-vibe', body)).json()
          if (!out.encoding) throw Error('接口没有返回 Vibe 编码。')
          ref.encodings[key] = out.encoding
          try {
            await remember(ref, key, out.encoding)
            callbacks.notify?.('Vibe 编码已缓存，重新导入相同图片即可复用')
          } catch {
            callbacks.notify?.('Vibe 已编码，浏览器缓存不可用，请导出以便复用')
          }
          void session.refresh().catch(() => {})
        } finally {
          encoding = false
          render()
        }
      }
      if (a === 'export-vibe') {
        await saveVibe(d.references[r], d.model)
        return
      }
      render()
      change()
      if (a === 'add-char') el.querySelector(`[data-c="${d.characters.length - 1}"] textarea`)?.focus()
    } catch (err) {
      note(err.message)
    }
  })
  async function generate({
    prompt = '',
    negative = '',
    signal,
    settings: override,
    accountSession,
    resolvedPrompts = false,
    lockNegative = false,
  } = {}) {
    if (busy) throw Error('上一项生成仍在进行。')
    busy = true
    try {
      const job = structuredClone({ ...d, ...override })
      callbacks.onPrepare?.({ mode: job.mode, width: job.width, height: job.height, count: job.batch })
      const session = await (accountSession || account.session())
      const snapshot = structuredClone(job),
        cap = capabilities(job)
      if (callbacks.resolvePrompt && !resolvedPrompts)
        job.characters = job.characters.map((c) => ({
          ...c,
          prompt: callbacks.resolvePrompt(c.prompt),
          negative: callbacks.resolvePrompt(c.negative),
        }))
      snapshot.characters = job.characters.map((c) => ({ ...c }))
      const composite = job.mode === 'inpaint' && job.focusInpaint ? await focusInpaint(job) : null
      const { operation, body, seed } = requestFor(job, prompt, negative, { lockNegative })
      await session.ensure()
      signal?.throwIfAborted()
      const stream = operation === 'generate-stream'
      callbacks.onTransportStart?.({
        stream,
        mode: job.mode,
        width: job.width,
        height: job.height,
        totalSteps: body.parameters?.steps,
        samples: body.parameters?.n_samples,
      })
      const resp = await session.fetchApi(operation, body, signal)
      const result = stream
        ? await streamResult(resp, (frame) => {
            if (!signal?.aborted) callbacks.onPreview?.(frame)
          })
        : await resp.json()
      signal?.throwIfAborted()
      if (!Array.isArray(result.images) || !result.images.length) throw Error('接口响应没有包含最终图像。')
      const images = result.images.map((im, i) => ({
        url: im.dataUrl,
        filename: im.name || `folio-${i + 1}.png`,
        seed: im.seed ?? (i === 0 ? seed : undefined),
      }))
      void session.refresh().catch(() => {})
      return {
        images: composite ? await Promise.all(images.map(composite)) : images,
        seed: result.seed ?? seed,
        model: body.model ?? job.model,
        modelLabel:
          job.mode === 'augment' ? TOOLS[job.tool] : job.mode === 'upscale' ? 'NovelAI Upscale' : cap.label,
        mode: job.mode,
        settings: { ...snapshot, seed: seed ?? null },
      }
    } finally {
      busy = false
    }
  }
  render()
  mountGenerationDock(dockHost)
  reportMode()
  return {
    openAccount: account.openAccount,
    captureSession: account.session,
    refreshAccount: account.refresh,
    billingSettings,
    generate,
    getState: getSettings,
    getSettings,
    setSettings: restore,
    restore,
    setSource,
    setSourceImage: setSource,
    setMode,
    openSection,
  }
}
