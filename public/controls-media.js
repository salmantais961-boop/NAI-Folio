import { encodingKey, cacheId } from './controls-vibe-cache.js'

export function canvasOf(w, h) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}
export async function decodeImage(input) {
  if (
    input instanceof Blob &&
    (input.size > 24 * 1024 * 1024 || !['image/png', 'image/webp', 'image/jpeg'].includes(input.type))
  )
    throw Error('请选择 24 MB 以内的 PNG、JPEG 或 WebP。')
  const url = input instanceof Blob ? URL.createObjectURL(input) : String(input)
  try {
    if (
      !(input instanceof Blob) &&
      !url.startsWith('data:image/') &&
      new URL(url, location.href).origin !== location.origin
    )
      throw Error('请使用本地图片。')
    const im = new Image()
    im.src = url
    await im.decode()
    if (!im.naturalHeight || im.naturalWidth * im.naturalHeight > 40000000)
      throw Error('输入图像超过 4000 万像素，请缩小后导入。')
    return im
  } finally {
    if (input instanceof Blob) URL.revokeObjectURL(url)
  }
}
function fit(im, w, h, bg) {
  const c = canvasOf(w, h),
    ctx = c.getContext('2d'),
    k = Math.min(w / im.naturalWidth, h / im.naturalHeight)
  if (bg) {
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, w, h)
  }
  ctx.drawImage(
    im,
    (w - im.naturalWidth * k) / 2,
    (h - im.naturalHeight * k) / 2,
    im.naturalWidth * k,
    im.naturalHeight * k,
  )
  return c.toDataURL('image/png')
}
export async function sourceImage(input, name, mode) {
  const im = await decodeImage(input),
    w = im.naturalWidth,
    h = im.naturalHeight,
    original = ['augment', 'upscale'].includes(mode),
    max = mode === 'upscale' ? 2250000 : 3145728
  const k = Math.min(1, Math.sqrt(max / (w * h)), 4096 / Math.max(w, h))
  const snap = (n) =>
    original ? Math.max(1, Math.floor(n * k)) : Math.max(64, Math.floor((n * k) / 64) * 64)
  const width = snap(w),
    height = snap(h)
  return { data: fit(im, width, height), width, height, name: name || input.name || '工作台图像' }
}
export async function referenceImage(file, kind) {
  const im = await decodeImage(file),
    w = im.naturalWidth,
    h = im.naturalHeight
  let data, v3
  if (kind === 'vibe') {
    const k = Math.min(1, 1536 / Math.max(w, h))
    data = fit(im, Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)))
    v3 = fit(im, 448, 448, 'black')
  } else {
    const [rw, rh] = w / h > 1.22 ? [1536, 1024] : h / w > 1.22 ? [1024, 1536] : [1472, 1472]
    data = fit(im, rw, rh, 'black')
  }
  return {
    name: file.name,
    kind,
    data,
    v3,
    enabled: true,
    information: 1,
    strength: 0.6,
    fidelity: 1,
    encodings: {},
  }
}
const vibeKeys = {
  'nai-diffusion-4-full': 'v4full',
  'nai-diffusion-4-curated-preview': 'v4curated',
  'nai-diffusion-4-5-full': 'v4-5full',
  'nai-diffusion-4-5-curated': 'v4-5curated',
}
export async function readVibes(file) {
  if (file.size > 24000000) throw Error('Vibe 文件超过 24 MB。')
  const pkg = JSON.parse(await file.text()),
    entries = pkg.identifier === 'novelai-vibe-transfer-bundle' ? pkg.vibes : [pkg]
  if (!Array.isArray(entries) || entries.length > 16 || !entries.length) throw Error('无法读取 Vibe 文件。')
  return Promise.all(
    entries.map(async (p) => {
      if (p.version !== 1 || p.identifier !== 'novelai-vibe-transfer') throw Error('无法识别 Vibe 格式。')
      const encodings = {}
      let first, preferred, firstMask
      for (const [model, key] of Object.entries(vibeKeys)) {
        for (const entry of Object.values(p.encodings?.[key] || {})) {
          const info = Number(entry.params?.information_extracted ?? p.importInfo?.information_extracted ?? 1)
          if (
            info >= 0 &&
            info <= 1 &&
            typeof entry.encoding === 'string' &&
            entry.encoding.length &&
            /^[\w+/=]+$/.test(entry.encoding)
          ) {
            const raw = entry.params?.mask
            const mask = raw
              ? raw.startsWith('data:image/png;base64,')
                ? raw
                : 'data:image/png;base64,' + raw
              : null
            if (mask && !/^data:image\/png;base64,iVBOR[A-Za-z0-9+/=]+$/.test(mask)) continue
            const maskInfo = mask
              ? { mask, maskId: await cacheId(mask), cropToMask: entry.params?.crop_to_mask === true }
              : {}
            encodings[encodingKey({ information: info, ...maskInfo }, model)] = entry.encoding
            if (first === undefined) {
              first = info
              firstMask = maskInfo
            }
            if (model === p.importInfo?.model && info === p.importInfo?.information_extracted && !preferred)
              preferred = { information: info, ...maskInfo }
          }
        }
      }
      if (first == null) throw Error('文件没有可用的 V4 / V4.5 编码。')
      return {
        kind: 'vibe',
        name: String(p.name || file.name),
        enabled: true,
        information: first,
        strength: Math.max(0, Math.min(1, Number(p.importInfo?.strength ?? 0.6))),
        fidelity: 1,
        ...firstMask,
        ...preferred,
        encodings,
      }
    }),
  )
}
export async function saveVibe(ref, model) {
  const encoding = ref.encodings[encodingKey(ref, model)]
  if (!encoding) throw Error('请先完成当前模型的编码。')
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encoding)),
    id = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('')
  const packet = {
    identifier: 'novelai-vibe-transfer',
    type: 'encoding',
    version: 1,
    id,
    name: ref.name,
    createdAt: new Date().toISOString(),
    encodings: {
      [vibeKeys[model]]: {
        unknown: {
          encoding,
          params: {
            information_extracted: ref.information,
            ...(ref.mask
              ? { mask: ref.mask.slice(ref.mask.indexOf(',') + 1), crop_to_mask: !!ref.cropToMask }
              : {}),
          },
        },
      },
    },
    importInfo: { model, information_extracted: ref.information, strength: ref.strength },
  }
  const a = document.createElement('a'),
    url = URL.createObjectURL(new Blob([JSON.stringify(packet)], { type: 'application/json' }))
  a.href = url
  a.download = ref.name.replace(/\.[^.]+$/, '') + '.naiv4vibe'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}
export function makeDialog(label) {
  const d = document.createElement('dialog')
  d.className = 'fc-dialog'
  d.setAttribute('aria-label', label)
  document.body.append(d)
  d.addEventListener('click', (e) => {
    if (e.target === d) {
      const r = d.getBoundingClientRect()
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close()
    }
  })
  d.addEventListener('close', () => d.remove(), { once: true })
  return d
}
export async function editMask(source, mask, apply, purpose = 'inpaint') {
  const vibe = purpose === 'vibe'
  const img = await decodeImage(source.data),
    existing = mask ? await decodeImage(mask) : null
  const dialog = makeDialog(vibe ? '编辑 Vibe 蒙版' : '编辑重绘蒙版')
  dialog.classList.add('fc-mask-dialog')
  dialog.innerHTML = `<div class="fc-dialog-head"><div><small>LOCAL CANVAS　/　MASK</small><h2>${vibe ? '选取 Vibe 参考区域' : '绘制重绘区域'}</h2></div><button type="button" data-act="close" aria-label="关闭">×</button></div><div class="fc-mask-stage"><canvas aria-label="在图上涂抹要重绘的区域"></canvas></div><div class="fc-mask-tools"><button type="button" data-act="paint" aria-pressed="true">画笔</button><button type="button" data-act="erase" aria-pressed="false">橡皮</button><label>笔径 <input type="range" min="6" max="240" value="64" aria-label="笔径"></label><button type="button" data-act="undo">撤回</button><button type="button" data-act="clear">清空</button><label class="fc-file-button">导入蒙版<input type="file" accept="image/png,image/jpeg,image/webp"></label></div><div class="fc-mask-footer"><span>${vibe ? '提取紫色选区内的视觉信息' : '紫色区域将在生成时重绘'}</span><button type="button" data-act="apply" class="fc-primary">应用蒙版 ↗</button></div><div class="fc-error" role="status"></div>`
  const { width: w, height: h } = img,
    layer = canvasOf(w, h),
    ctx = layer.getContext('2d', { willReadFrequently: true }),
    display = dialog.querySelector('canvas'),
    dc = display.getContext('2d'),
    overlay = canvasOf(w, h),
    oc = overlay.getContext('2d')
  display.width = w
  display.height = h
  const range = dialog.querySelector('[type=range]'),
    note = dialog.querySelector('[role=status]')
  let mode = 'paint',
    prev = null,
    pointer = null
  const undo = []
  function checkpoint() {
    undo.push(ctx.getImageData(0, 0, w, h))
    if (undo.length > 5) undo.shift()
  }
  function repaint() {
    oc.clearRect(0, 0, w, h)
    oc.globalCompositeOperation = 'source-over'
    oc.drawImage(layer, 0, 0)
    oc.globalCompositeOperation = 'source-in'
    oc.fillStyle = '#a896ff'
    oc.fillRect(0, 0, w, h)
    oc.globalCompositeOperation = 'source-over'
    dc.clearRect(0, 0, w, h)
    dc.drawImage(img, 0, 0, w, h)
    dc.globalAlpha = 0.72
    dc.drawImage(overlay, 0, 0)
    dc.globalAlpha = 1
  }
  function readMask(im) {
    const tmp = canvasOf(w, h),
      tc = tmp.getContext('2d', { willReadFrequently: true })
    tc.drawImage(im, 0, 0, w, h)
    const data = tc.getImageData(0, 0, w, h),
      pixels = data.data
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i + 3] = pixels[i + 3] > 127 && (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3 > 127 ? 255 : 0
      pixels[i] = pixels[i + 1] = pixels[i + 2] = 255
    }
    ctx.putImageData(data, 0, 0)
  }
  if (existing) readMask(existing)
  repaint()
  function paint(e) {
    const r = display.getBoundingClientRect(),
      x = ((e.clientX - r.left) / r.width) * w,
      y = ((e.clientY - r.top) / r.height) * h,
      size = Number(range.value)
    ctx.globalCompositeOperation = mode === 'paint' ? 'source-over' : 'destination-out'
    ctx.lineJoin = ctx.lineCap = 'round'
    ctx.strokeStyle = ctx.fillStyle = '#fff'
    ctx.lineWidth = size
    ctx.beginPath()
    if (prev) {
      ctx.moveTo(...prev)
      ctx.lineTo(x, y)
      ctx.stroke()
    } else {
      ctx.arc(x, y, size / 2, 0, Math.PI * 2)
      ctx.fill()
    }
    prev = [x, y]
    ctx.globalCompositeOperation = 'source-over'
    repaint()
  }
  display.onpointerdown = (e) => {
    if (pointer !== null || e.button !== 0) return
    checkpoint()
    pointer = e.pointerId
    prev = null
    display.setPointerCapture(pointer)
    paint(e)
  }
  display.onpointermove = (e) => {
    if (e.pointerId === pointer) paint(e)
  }
  display.onpointerup =
    display.onpointercancel =
    display.onlostpointercapture =
      () => {
        pointer = null
        prev = null
      }
  dialog.querySelector('[type=file]').onchange = async (e) => {
    try {
      const f = e.target.files[0]
      if (!f) return
      const im = await decodeImage(f)
      if (im.width !== w || im.height !== h) throw Error('蒙版需与底图宽高一致。')
      checkpoint()
      readMask(im)
      repaint()
    } catch (err) {
      note.textContent = err.message
    }
  }
  dialog.onclick = (e) => {
    const action = e.target.closest('[data-act]')?.dataset.act
    if (action === 'close') dialog.close()
    if (action === 'paint' || action === 'erase') {
      mode = action
      for (const a of ['paint', 'erase'])
        dialog.querySelector(`[data-act="${a}"]`).setAttribute('aria-pressed', String(a === mode))
    }
    if (action === 'clear') {
      checkpoint()
      ctx.clearRect(0, 0, w, h)
      repaint()
    }
    if (action === 'undo' && undo.length) {
      ctx.putImageData(undo.pop(), 0, 0)
      repaint()
    }
    if (action === 'apply') {
      const im = ctx.getImageData(0, 0, w, h),
        values = im.data
      let count = 0
      for (let i = 0; i < values.length; i += 4) {
        const bit = values[i + 3] > 127 ? 255 : 0
        count += bit
        values[i] = values[i + 1] = values[i + 2] = bit
        values[i + 3] = vibe ? bit : 255
      }
      if (!count) {
        apply(null)
        dialog.close()
        return
      }
      const full = canvasOf(w, h)
      full.getContext('2d').putImageData(im, 0, 0)
      apply(full.toDataURL('image/png'))
      dialog.close()
    }
  }
  dialog.showModal()
}
export async function expandSource(source, pad) {
  const w = source.width + pad * 2,
    h = source.height + pad * 2
  if (w * h > 3145728 || w > 4096 || h > 4096) throw Error('扩展后的画布超过 314 万像素，请先缩小底图。')
  const im = await decodeImage(source.data),
    c = canvasOf(w, h),
    ctx = c.getContext('2d'),
    m = canvasOf(w, h),
    mc = m.getContext('2d')
  ctx.drawImage(im, pad, pad)
  mc.fillStyle = 'white'
  mc.fillRect(0, 0, w, h)
  mc.fillStyle = 'black'
  mc.fillRect(pad, pad, source.width, source.height)
  return {
    source: { ...source, width: w, height: h, data: c.toDataURL('image/png') },
    mask: m.toDataURL('image/png'),
  }
}
