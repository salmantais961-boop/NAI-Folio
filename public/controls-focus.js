import { decodeImage, canvasOf } from './controls-media.js'

function region(mask) {
  const w = mask.width,
    h = mask.height
  const stencil = canvasOf(w, h),
    sc = stencil.getContext('2d', { willReadFrequently: true })
  sc.drawImage(mask, 0, 0)
  const px = sc.getImageData(0, 0, w, h)
  let left = w,
    top = h,
    right = -1,
    bottom = -1
  for (let i = 0; i < px.data.length; i += 4) {
    const chosen = px.data[i] > 127 && px.data[i + 3] > 127
    px.data[i + 3] = chosen ? 255 : 0
    if (chosen) {
      const pos = i / 4,
        x = pos % w,
        y = Math.floor(pos / w)
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
    }
  }
  if (right < 0) throw Error('蒙版没有可重绘区域。')
  sc.putImageData(px, 0, 0)
  const x = Math.max(0, left - 64),
    y = Math.max(0, top - 64),
    cw = Math.min(w, right + 65) - x,
    ch = Math.min(h, bottom + 65) - y
  const k = Math.min(Math.sqrt((1024 * 1024) / (cw * ch)), 1536 / Math.max(cw, ch))
  const nw = Math.max(64, Math.round((cw * k) / 64) * 64),
    nh = Math.max(64, Math.round((ch * k) / 64) * 64)
  return { stencil, x, y, cw, ch, nw, nh }
}

export async function estimateFocus(mask) {
  const { nw, nh } = region(await decodeImage(mask))
  return { width: nw, height: nh }
}

// Keep a full-size stencil for compositing. Only the magnified patch goes to the generator.
export async function focusInpaint(job) {
  if (!job.source || !job.mask) throw Error('请先导入底图并绘制蒙版。')
  const [im, mask] = await Promise.all([decodeImage(job.source.data), decodeImage(job.mask)])
  const w = im.width,
    h = im.height
  if (mask.width !== w || mask.height !== h) throw Error('蒙版与底图尺寸不一致。')
  const { stencil, x, y, cw, ch, nw, nh } = region(mask)
  function crop(img, smooth) {
    const surface = canvasOf(nw, nh),
      ctx = surface.getContext('2d')
    ctx.imageSmoothingEnabled = smooth
    ctx.drawImage(img, x, y, cw, ch, 0, 0, nw, nh)
    return surface.toDataURL('image/png')
  }
  const clip = (n) => Math.max(0, Math.min(n, 1))
  Object.assign(job, {
    width: nw,
    height: nh,
    source: { ...job.source, width: nw, height: nh, data: crop(im, true) },
    mask: crop(mask, false),
    characters: job.characters.map((c) => ({
      ...c,
      x: clip((c.x * w - x) / cw),
      y: clip((c.y * h - y) / ch),
    })),
  })
  return async (image) => {
    const generated = await decodeImage(image.url),
      full = canvasOf(w, h),
      fc = full.getContext('2d'),
      patch = canvasOf(cw, ch),
      pc = patch.getContext('2d')
    pc.drawImage(generated, 0, 0, cw, ch)
    pc.globalCompositeOperation = 'destination-in'
    pc.drawImage(stencil, x, y, cw, ch, 0, 0, cw, ch)
    fc.drawImage(im, 0, 0)
    fc.drawImage(patch, x, y)
    return { ...image, url: full.toDataURL('image/png'), filename: 'focused-' + image.filename }
  }
}
