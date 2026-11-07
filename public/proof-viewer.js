const clamp = (v, min, max) => Math.max(min, Math.min(max, v))
const ns = 'http://www.w3.org/2000/svg'
const paths = {
  fit: 'M7 3H3v4m14-4h4v4M3 17v4h4m14-4v4h-4M8 8h8v8H8z',
  minus: 'M5 12h14',
  plus: 'M5 12h14M12 5v14',
  close: 'm6 6 12 12m0-12L6 18',
}
function node(tag, className, text) {
  const n = document.createElement(tag)
  if (className) n.className = className
  if (text) n.textContent = text
  return n
}
function icon(key) {
  const svg = document.createElementNS(ns, 'svg'),
    path = document.createElementNS(ns, 'path')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.55')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  path.setAttribute('d', paths[key])
  svg.append(path)
  return svg
}
function tool(label, shortcut, glyph, text) {
  const button = node('button', 'pv-tool')
  button.type = 'button'
  button.setAttribute('aria-label', label)
  button.title = label + (shortcut ? '（' + shortcut + '）' : '')
  if (glyph) button.append(icon(glyph))
  if (text) button.append(node('span', '', text))
  return button
}
/** The caller owns artwork URLs, generation state and metadata. This component owns their presentation. */
export function mountProofViewer(stage, image, { toolbarHost = stage } = {}) {
  const view = node('div', 'pv-window'),
    sheet = node('div', 'pv-sheet'),
    edge = node('div', 'pv-edge'),
    bar = node('div', 'pv-bar'),
    info = node('div', 'pv-meta'),
    stamp = node('span', 'pv-state'),
    size = node('small', 'pv-size'),
    tools = node('div', 'pv-tools')
  const fitBtn = tool('适应画布并复位', '0', 'fit', '适应'),
    actualBtn = tool('按原始像素显示', '1', null, '1:1'),
    less = tool('缩小', '−', 'minus'),
    more = tool('放大', '+', 'plus'),
    readout = node('output', 'pv-readout', '100%')
  const hint = node(
    'span',
    'pv-sr',
    '滚轮或双指缩放，拖动平移。双击查看细节。方向键平移，0 适应，1 原尺寸，F 查看大图。',
  )
  hint.id = 'pv-hint-' + Math.random().toString(36).slice(2)
  view.tabIndex = 0
  view.setAttribute('role', 'region')
  view.setAttribute('aria-label', '图像查看区域')
  view.setAttribute('aria-describedby', hint.id)
  readout.setAttribute('aria-label', '图像缩放比例')
  readout.setAttribute('aria-live', 'off')
  bar.setAttribute('role', 'group')
  bar.setAttribute('aria-label', '图像查看工具')
  const dialog = node('dialog', 'pv-dialog'),
    head = node('header', 'pv-dialog-head'),
    title = node('div', 'pv-dialog-title'),
    quiet = node('small', '', 'FOLIO  /  IMAGE PROOF'),
    name = node('b', '', '图像查看'),
    close = tool('关闭大图', 'Esc', 'close')
  title.append(quiet, name)
  head.append(title, close)
  dialog.setAttribute('aria-label', '大图查看')
  dialog.append(head)
  document.body.append(dialog)
  info.append(stamp, size)
  tools.append(fitBtn, actualBtn, less, readout, more)
  bar.append(info, tools)
  image.draggable = false
  image.classList.add('pv-image')
  sheet.append(image)
  edge.setAttribute('aria-hidden', 'true')
  view.append(sheet, edge, hint)
  stage.append(view)
  toolbarHost.append(bar)
  stage.classList.add('pv-stage')
  stage.classList.toggle('pv-external-tools', toolbarHost !== stage)
  view.hidden = bar.hidden = true
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)')
  const pointers = new Map()
  let model = null,
    pendingURL = '',
    version = 0,
    naturalW = 0,
    naturalH = 0,
    scale = 1,
    fit = 1,
    panX = 0,
    panY = 0,
    mode = 'fit',
    frame = 0,
    edgeFrame = 0,
    previous = null,
    fade = null,
    zoomMotion = null,
    edgeReveal = null,
    flash = null,
    exposure = null,
    lastTap = null,
    touchStart = null,
    returnFocus = null
  let historyLayer = null,
    historyIn = null,
    historyOut = null,
    historySettled = null,
    resolveHistory = null,
    historyGeometry = null
  const historyMeasures = new WeakMap()
  function clearHistoryMotion() {
    historyIn?.cancel()
    historyOut?.cancel()
    historyLayer?.remove()
    delete view.dataset.historyHidden
    stage.classList.remove('pv-history-moving')
    historyIn = historyOut = historyLayer = null
    historyGeometry = null
    resolveHistory?.()
    historySettled = resolveHistory = null
  }
  function historySnapshot(decoded = false) {
    if (!model?.url || image.hidden || (!decoded && (!image.complete || !image.naturalWidth)) || view.hidden)
      return null
    const host = view.parentElement,
      bounds = view.getBoundingClientRect(),
      parent = host.getBoundingClientRect(),
      picture = sheet.getBoundingClientRect(),
      unitX = bounds.width / view.clientWidth || 1,
      unitY = bounds.height / view.clientHeight || 1,
      pictureWidth = picture.width / unitX,
      pictureHeight = picture.height / unitY,
      beforeFit = Math.min((view.clientWidth - 4) / naturalW, (view.clientHeight - 4) / naturalH)
    if (!bounds.width || !bounds.height) return null
    const layer = node('div', 'pv-window pv-history-previous'),
      paper = node('div', 'pv-sheet'),
      photo = image.cloneNode(false),
      frame = edge.cloneNode(false)
    layer.setAttribute('aria-hidden', 'true')
    layer.inert = true
    Object.assign(layer.style, {
      left: bounds.left - parent.left - host.clientLeft + host.scrollLeft + 'px',
      top: bounds.top - parent.top - host.clientTop + host.scrollTop + 'px',
      width: bounds.width + 'px',
      height: bounds.height + 'px',
    })
    layer.style.setProperty('--pv-radius', getComputedStyle(view).getPropertyValue('--pv-radius'))
    frame.style.setProperty('--pv-stroke', getComputedStyle(edge).borderTopWidth)
    layer.style.setProperty('--pv-crop', getComputedStyle(view).getPropertyValue('--pv-crop'))
    paper.style.cssText = sheet.style.cssText
    paper.style.transform = getComputedStyle(sheet).transform
    photo.removeAttribute('id')
    photo.alt = ''
    photo.className = 'pv-image'
    frame.removeAttribute('data-entering')
    paper.append(photo)
    layer.append(paper, frame)
    host.append(layer)
    historyMeasures.set(layer, {
      naturalW,
      naturalH,
      zoom: pictureWidth / naturalW / beforeFit,
      panRatioX: (picture.left + picture.right - bounds.left - bounds.right) / (2 * unitX) / pictureWidth,
      panRatioY: (picture.top + picture.bottom - bounds.top - bounds.bottom) / (2 * unitY) / pictureHeight,
    })
    return layer
  }
  const exitScale = 0.82
  function historyFrames(exitY, entryY, tilt) {
    const retreatEnd = 0.32
    const glide = 'cubic-bezier(.42,.04,.23,1)'
    return {
      out: [
        // Rotation has one uninterrupted curve across both the retreat and the slide.
        { offset: 0, rotate: '0deg', easing: 'cubic-bezier(.23,.36,.58,.84)' },
        {
          offset: 0, translate: '0 0', scale: '1', opacity: 1, filter: 'blur(0px)',
          easing: 'cubic-bezier(.28,.08,.25,1)',
        },
        {
          offset: retreatEnd, translate: '0 0', scale: '.86',
          opacity: 0.9, filter: 'blur(0.7px)', easing: glide,
        },
        { translate: `0 ${exitY}px`, scale: String(exitScale), rotate: `${tilt}deg`, opacity: 0.18, filter: 'blur(5px)' },
      ],
      incoming: [
        { translate: `0 ${entryY}px`, rotate: '0deg', easing: 'cubic-bezier(.30,.26,.26,1)' },
        { offset: 0.55, rotate: `${Math.sign(entryY) * 0.85}deg` },
        { translate: '0 0', rotate: '0deg' },
      ],
    }
  }
  function layoutHistory() {
    if (!historyGeometry || !view.clientWidth || !view.clientHeight) return null
    const { host, track, panels, direction, tilt } = historyGeometry,
      viewport = view.getBoundingClientRect(),
      outer = host.getBoundingClientRect(),
      scaleX = outer.width / host.offsetWidth || 1,
      scaleY = outer.height / host.offsetHeight || 1,
      left = (viewport.left - outer.left) / scaleX - host.clientLeft + host.scrollLeft,
      top = (viewport.top - outer.top) / scaleY - host.clientTop + host.scrollTop,
      width = view.clientWidth,
      height = view.clientHeight
    Object.assign(track.style, {
      left: '0px',
      top: '0px',
      right: '0px',
      bottom: '0px',
      width: 'auto',
      height: 'auto',
    })
    const crops = panels.map((panel) => {
      const data = historyMeasures.get(panel),
        paper = panel.querySelector('.pv-sheet'),
        frame = panel.querySelector('.pv-edge')
      const fit = Math.min(Math.max(1, width - 4) / data.naturalW, Math.max(1, height - 4) / data.naturalH),
        w = data.naturalW * fit * data.zoom,
        h = data.naturalH * fit * data.zoom,
        dx = Math.max(0, (w - width) / 2),
        dy = Math.max(0, (h - height) / 2),
        x = clamp(data.panRatioX * w, -dx, dx),
        y = clamp(data.panRatioY * h, -dy, dy),
        cropLeft = clamp((width - w) / 2 + x, 0, width),
        cropTop = clamp((height - h) / 2 + y, 0, height),
        right = clamp((width + w) / 2 + x, cropLeft, width),
        bottom = clamp((height + h) / 2 + y, cropTop, height)
      Object.assign(panel.style, {
        left: left + 'px',
        top: top + 'px',
        width: width + 'px',
        height: height + 'px',
        transformOrigin: (cropLeft + right) / 2 + 'px ' + (cropTop + bottom) / 2 + 'px',
      })
      Object.assign(paper.style, {
        width: w + 'px',
        height: h + 'px',
        transform: `translate3d(calc(-50% + ${x}px), calc(-50% + ${y}px), 0)`,
      })
      panel.style.setProperty('--pv-crop', `${cropTop}px ${width - right}px ${height - bottom}px ${cropLeft}px`)
      Object.assign(frame.style, {
        left: cropLeft + 'px',
        top: cropTop + 'px',
        width: right - cropLeft + 'px',
        height: bottom - cropTop + 'px',
      })
      return { top: top + cropTop, bottom: top + bottom, width: right - cropLeft }
    })
    // Start the new artwork at the canvas edge even when its aspect ratio
    // differs from the departing artwork's. A shared distance can delay its appearance.
    const [outgoing, incoming] = crops
    // The far corner of a tilted panorama can extend well beyond its upright bounds.
    const angle = Math.abs(tilt) * Math.PI / 180
    const centerY = (outgoing.top + outgoing.bottom) / 2
    const halfHeight = exitScale * (outgoing.width * Math.sin(angle) + (outgoing.bottom - outgoing.top) * Math.cos(angle)) / 2
    const exitY = direction > 0 ? -centerY - halfHeight - 18 : host.clientHeight - centerY + halfHeight + 18
    const entryY = direction > 0 ? host.clientHeight - incoming.top + 1 : -incoming.bottom - 1
    const frames = historyFrames(exitY, entryY, tilt)
    // Grid resizing changes geometry, never the running animation clock. This
    // keeps both copies proportional while a word-block sidebar opens/closes.
    historyOut?.effect.setKeyframes(frames.out)
    historyIn?.effect.setKeyframes(frames.incoming)
    return frames
  }
  function slideHistory(direction, layer) {
    if (!layer) return
    const incoming = historySnapshot(true)
    if (!incoming) {
      layer.remove()
      return
    }
    const track = node('div', 'pv-history-track'),
      host = dialog.open ? dialog : stage.closest('.proof-panel') || stage
    // Travel through the whole canvas background, including behind its title
    // and tools. The resting artwork stays in its original inset viewport.
    track.setAttribute('aria-hidden', 'true')
    track.inert = true
    incoming.classList.replace('pv-history-previous', 'pv-history-next')
    track.append(layer, incoming)
    host.append(track)
    view.dataset.historyHidden = 'true'
    stage.classList.add('pv-history-moving')
    const timing = { duration: 680, fill: 'both' }
    historyLayer = track
    // Re-layout can rebuild the keyframes mid-swipe; sample the angle only once.
    const tilt = (15 + 10 * Math.random()) * (Math.random() < 0.5 ? -1 : 1)
    historyGeometry = { host, track, panels: [layer, incoming], direction, tilt }
    const frames = layoutHistory()
    historySettled = new Promise((resolve) => {
      resolveHistory = resolve
    })
    historyOut = layer.animate(frames.out, timing)
    const animation = incoming.animate(frames.incoming, timing)
    historyIn = animation
    animation.onfinish = () => {
      if (historyIn === animation) clearHistoryMotion()
    }
  }
  function limits() {
    return [Math.min(0.05, fit), Math.max(8, fit * 3)]
  }
  function clearEffects() {
    clearHistoryMotion()
    fade?.cancel()
    fade = null
    flash?.cancel()
    flash = null
    exposure?.cancel()
    exposure = null
    previous?.remove()
    previous = null
  }
  // The paper and halftone settle first; the ink frame develops afterwards.
  // Keep this separate from per-frame fades so streaming never restarts it.
  function finishEdgeEntrance() {
    edgeReveal?.cancel()
    edgeReveal = null
    delete edge.dataset.entering
  }
  function enterEdge() {
    finishEdgeEntrance()
    if (reduceMotion.matches) return
    const stroke = getComputedStyle(edge).borderTopWidth
    edge.dataset.entering = 'true'
    const animation = edge.animate(
      [
        { opacity: 0, borderWidth: '0px' },
        { opacity: 1, borderWidth: stroke },
      ],
      { delay: 740, duration: 520, easing: 'cubic-bezier(.22,.61,.36,1)', fill: 'backwards' },
    )
    edgeReveal = animation
    animation.onfinish = () => {
      if (edgeReveal === animation) finishEdgeEntrance()
    }
  }
  // Round the visible intersection, not just the original image corners, which
  // can be outside the viewport after zooming. Keep the radius in screen pixels.
  function syncEdges() {
    if (!model || view.hidden) return
    const viewport = view.getBoundingClientRect(),
      artwork = sheet.getBoundingClientRect()
    if (!viewport.width || !viewport.height || !artwork.width) return
    const left = clamp(artwork.left - viewport.left, 0, viewport.width)
    const top = clamp(artwork.top - viewport.top, 0, viewport.height)
    const right = clamp(artwork.right - viewport.left, left, viewport.width)
    const bottom = clamp(artwork.bottom - viewport.top, top, viewport.height)
    view.style.setProperty(
      '--pv-crop',
      `${top}px ${viewport.width - right}px ${viewport.height - bottom}px ${left}px`,
    )
    Object.assign(edge.style, {
      left: left + 'px',
      top: top + 'px',
      width: right - left + 'px',
      height: bottom - top + 'px',
    })
  }
  function followZoomEdges() {
    edgeFrame = 0
    syncEdges()
    layoutHistory()
    if (zoomMotion) edgeFrame = requestAnimationFrame(followZoomEdges)
  }
  function draw() {
    frame = 0
    if (!model || !naturalW || !view.clientWidth || !view.clientHeight) return
    const w = view.clientWidth,
      h = view.clientHeight
    fit = Math.min(Math.max(1, w - 4) / naturalW, Math.max(1, h - 4) / naturalH)
    if (mode === 'fit') {
      scale = fit
      panX = panY = 0
    } else if (mode === 'actual') scale = 1
    const [minimum, maximum] = limits()
    scale = clamp(scale, minimum, maximum)
    const width = naturalW * scale,
      height = naturalH * scale
    const dx = Math.max(0, (width - w) / 2),
      dy = Math.max(0, (height - h) / 2)
    panX = clamp(panX, -dx, dx)
    panY = clamp(panY, -dy, dy)
    sheet.style.width = width + 'px'
    sheet.style.height = height + 'px'
    sheet.style.transform = `translate3d(calc(-50% + ${panX}px), calc(-50% + ${panY}px), 0)`
    readout.value = (scale < 0.1 ? (scale * 100).toFixed(1) : Math.round(scale * 100)) + '%'
    fitBtn.setAttribute('aria-pressed', String(mode === 'fit'))
    actualBtn.setAttribute('aria-pressed', String(mode === 'actual'))
    less.disabled = scale <= minimum + 0.00001
    more.disabled = scale >= maximum - 0.00001
    view.dataset.draggable = String(dx > 0.5 || dy > 0.5)
    syncEdges()
    layoutHistory()
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(draw)
  }
  function centeredPoint(clientX, clientY) {
    const r = view.getBoundingClientRect()
    return { x: clientX - r.left - r.width / 2, y: clientY - r.top - r.height / 2 }
  }
  const origin = { x: 0, y: 0 }
  function zoom(next, from = origin, to = from) {
    if (!model || !naturalW) return
    const [min, max] = limits(),
      target = clamp(next, min, max),
      factor = target / scale
    panX = to.x - (from.x - panX) * factor
    panY = to.y - (from.y - panY) * factor
    scale = target
    mode = 'free'
    draw()
  }
  function stopZoom(adoptVisual = false) {
    if (!zoomMotion) return
    const visual = adoptVisual ? sheet.getBoundingClientRect() : null
    zoomMotion.cancel()
    zoomMotion = null
    cancelAnimationFrame(edgeFrame)
    edgeFrame = 0
    if (visual && naturalW && visual.width) {
      const center = centeredPoint(visual.left + visual.width / 2, visual.top + visual.height / 2)
      scale = visual.width / naturalW
      panX = center.x
      panY = center.y
      mode = 'free'
      draw()
    }
    syncEdges()
  }
  function animateSheet(keyframes, timing) {
    const animation = sheet.animate(keyframes, timing)
    zoomMotion = animation
    followZoomEdges()
    animation.onfinish = () => {
      if (zoomMotion === animation) {
        zoomMotion = null
        cancelAnimationFrame(edgeFrame)
        edgeFrame = 0
        syncEdges()
      }
    }
  }
  // Animate only the sheet transform. Its layout and target zoom are already final,
  // so a second button press can retarget smoothly from the current visible rectangle.
  function smoothZoom(update) {
    if (!model) return
    clearHistoryMotion()
    const before = sheet.getBoundingClientRect()
    stopZoom()
    update()
    if (reduceMotion.matches || !before.width) return
    const after = sheet.getBoundingClientRect()
    if (
      !after.width ||
      (Math.abs(before.width - after.width) < 0.5 &&
        Math.abs(before.left - after.left) < 0.5 &&
        Math.abs(before.top - after.top) < 0.5)
    )
      return
    const pivot = centeredPoint(before.left + before.width / 2, before.top + before.height / 2)
    const start =
      'translate3d(calc(-50% + ' +
      pivot.x +
      'px), calc(-50% + ' +
      pivot.y +
      'px), 0) scale(' +
      before.width / after.width +
      ')'
    animateSheet([{ transform: start }, { transform: sheet.style.transform + ' scale(1)' }], {
      duration: 210,
      easing: 'cubic-bezier(.2,.65,.25,1)',
    })
  }
  function reset() {
    smoothZoom(() => {
      mode = 'fit'
      panX = panY = 0
      draw()
    })
  }
  function actual() {
    smoothZoom(() => {
      mode = 'actual'
      panX = panY = 0
      draw()
    })
  }
  function stepZoom(factor) {
    smoothZoom(() => zoom(scale * factor))
  }
  function detailAt(point) {
    if (mode !== 'fit') {
      reset()
      return
    }
    smoothZoom(() => zoom(fit < 0.9 ? 1 : fit * 2, point))
  }
  fitBtn.onclick = reset
  actualBtn.onclick = actual
  less.onclick = () => stepZoom(1 / Math.SQRT2)
  more.onclick = () => stepZoom(Math.SQRT2)
  function move(x, y) {
    stopZoom(true)
    panX += x
    panY += y
    draw()
  }
  function keyboard(e) {
    if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing || !model) return
    const step = e.shiftKey ? 100 : 32
    switch (e.key) {
      case '+':
      case '=':
        stepZoom(Math.SQRT2)
        break
      case '-':
      case '_':
        stepZoom(1 / Math.SQRT2)
        break
      case '0':
      case 'Home':
        reset()
        break
      case '1':
        actual()
        break
      case 'ArrowLeft':
        move(step, 0)
        break
      case 'ArrowRight':
        move(-step, 0)
        break
      case 'ArrowUp':
        move(0, step)
        break
      case 'ArrowDown':
        move(0, -step)
        break
      case 'f':
      case 'F':
        if (dialog.open) dialog.close()
        else open()
        break
      default:
        return
    }
    e.preventDefault()
    e.stopPropagation()
  }
  view.addEventListener('keydown', keyboard)
  bar.addEventListener('keydown', keyboard)
  view.addEventListener(
    'wheel',
    (e) => {
      if (!model) return
      e.preventDefault()
      stopZoom(true)
      const units = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? view.clientHeight : 1
      const dy = clamp(e.deltaY * units, -200, 200)
      zoom(scale * Math.exp(-dy * (e.ctrlKey ? 0.012 : 0.0022)), centeredPoint(e.clientX, e.clientY))
    },
    { passive: false },
  )
  let lastTouch = -Infinity
  view.addEventListener('dblclick', (e) => {
    if (e.sourceCapabilities?.firesTouchEvents || performance.now() - lastTouch < 500) return
    e.preventDefault()
    detailAt(centeredPoint(e.clientX, e.clientY))
  })
  function points() {
    return [...pointers.values()].slice(0, 2)
  }
  const middle = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
  const distance = (a, b) => Math.max(0.001, Math.hypot(a.x - b.x, a.y - b.y))
  view.addEventListener('pointerdown', (e) => {
    if (!model || e.button !== 0 || pointers.size >= 2) return
    stopZoom(true)
    if (e.pointerType === 'touch') lastTouch = performance.now()
    view.focus({ preventScroll: true })
    const p = centeredPoint(e.clientX, e.clientY)
    pointers.set(e.pointerId, p)
    touchStart = e.pointerType === 'touch' && pointers.size === 1 ? { ...p, time: performance.now() } : null
    if (pointers.size > 1) lastTap = null
    view.setPointerCapture(e.pointerId)
    view.dataset.dragging = 'true'
  })
  view.addEventListener('pointermove', (e) => {
    const last = pointers.get(e.pointerId)
    if (!last) return
    const before = points(),
      p = centeredPoint(e.clientX, e.clientY)
    pointers.set(e.pointerId, p)
    if (touchStart && distance(touchStart, p) > 8) touchStart = null
    if (pointers.size === 2) {
      const after = points()
      zoom((scale * distance(...after)) / distance(...before), middle(...before), middle(...after))
    } else move(p.x - last.x, p.y - last.y)
  })
  function release(e) {
    if (!pointers.has(e.pointerId)) return
    const p = pointers.get(e.pointerId)
    pointers.delete(e.pointerId)
    if (
      e.type === 'pointerup' &&
      e.pointerType === 'touch' &&
      touchStart &&
      performance.now() - touchStart.time < 280
    ) {
      const now = performance.now()
      if (lastTap && now - lastTap.time < 330 && distance(lastTap, p) < 24) {
        detailAt(p)
        lastTap = null
      } else lastTap = { ...p, time: now }
    }
    touchStart = null
    view.dataset.dragging = String(pointers.size > 0)
  }
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture'])
    view.addEventListener(event, release)
  function open() {
    if (!model || dialog.open) return
    clearHistoryMotion()
    stopZoom()
    returnFocus = document.activeElement
    dialog.append(view, bar)
    dialog.showModal()
    view.focus({ preventScroll: true })
    draw()
    schedule()
  }
  close.onclick = () => dialog.close()
  dialog.addEventListener('close', () => {
    clearHistoryMotion()
    stopZoom()
    stage.append(view)
    toolbarHost.append(bar)
    returnFocus?.focus?.({ preventScroll: true })
    returnFocus = null
    draw()
    schedule()
  })
  function status(state) {
    stamp.textContent =
      state === 'pending' ? 'AWAITING PROOF' : state === 'stream' ? 'LIVE PROOF' : 'IMAGE PROOF'
    bar.dataset.state = state
    size.textContent = naturalW + ' × ' + naturalH
  }
  // Reserve the submitted canvas immediately, before any account/network wait.
  // A previous result may have a different ratio; it must not size this sheet.
  function prepare({ width = 832, height = 1216 } = {}) {
    version++
    pendingURL = ''
    stopZoom()
    clearEffects()
    naturalW = Math.max(1, Number(width) || 832)
    naturalH = Math.max(1, Number(height) || 1216)
    model = { url: '', state: 'pending' }
    mode = 'fit'
    panX = panY = 0
    pointers.clear()
    touchStart = lastTap = null
    view.dataset.dragging = 'false'
    view.dataset.preparing = 'true'
    stage.dataset.state = 'pending'
    delete stage.dataset.pvError
    image.hidden = true
    image.removeAttribute('src')
    image.alt = ''
    view.hidden = bar.hidden = false
    status('pending')
    draw()
    enterEdge()
    if (!reduceMotion.matches) {
      const bounds = sheet.getBoundingClientRect(),
        viewport = view.getBoundingClientRect()
      // Stay inside even a short viewport: scaling creates a little landing room.
      const drop = Math.min(7, Math.max(0, viewport.bottom - bounds.bottom + bounds.height * 0.0075 - 1))
      animateSheet(
        [
          { transform: sheet.style.transform + ` translateY(${drop}px) scale(.985)` },
          { transform: sheet.style.transform + ' translateY(0px) scale(1)' },
        ],
        { duration: 420, easing: 'cubic-bezier(.22,.61,.36,1)' },
      )
    }
    schedule()
  }
  function reveal(type, ghost) {
    if (reduceMotion.matches) return
    if (type === 'selection') {
      // Bring the decoded artwork and its ink edge into focus as one print.
      flash = view.animate([
        { opacity: 0, filter: 'blur(9px)', translate: '0 9px' },
        { opacity: 1, filter: 'blur(0px)', translate: '0 0' },
      ], { duration: 460, easing: 'cubic-bezier(.22,.65,.25,1)' })
      return
    }
    if (ghost) {
      previous = ghost
      sheet.append(ghost)
      fade = ghost.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: type === 'frame' ? 145 : 360,
        easing: 'ease-out',
        fill: 'forwards',
      })
      fade.onfinish = () => {
        ghost.remove()
        if (previous === ghost) {
          previous = null
          fade = null
        }
      }
    }
    if (type === 'frame' && ghost) return
    const start =
      type === 'final'
        ? { filter: 'saturate(.86) brightness(1.055)', opacity: ghost ? 1 : 0.2 }
        : { filter: 'saturate(.88)', opacity: 0.35 }
    flash = image.animate([start, { filter: 'saturate(1) brightness(1)', opacity: 1 }], {
      duration: type === 'final' ? 520 : 220,
      easing: 'cubic-bezier(.22,.61,.36,1)',
    })
    if (type === 'final')
      exposure = stamp.animate(
        [
          { opacity: 0.35, letterSpacing: '.17em' },
          { opacity: 1, letterSpacing: '.1em' },
        ],
        { duration: 520, easing: 'ease-out' },
      )
  }
  async function show({
    url = '',
    alt = '',
    state = 'result',
    reveal: finalReveal = false,
    slide = 0,
    historyKey = null,
    historyOrder = [],
  } = {}) {
    stage.dataset.state = state
    delete stage.dataset.pvError
    // Restoring history/cancelling gets a finished frame immediately. A real
    // stream or very fast final image keeps the original entrance timeline.
    if (state !== 'stream' && !finalReveal) finishEdgeEntrance()
    if (!url || state === 'empty') {
      version++
      pendingURL = ''
      stopZoom()
      clearEffects()
      finishEdgeEntrance()
      model = null
      naturalW = naturalH = 0
      mode = 'fit'
      pointers.clear()
      touchStart = lastTap = null
      view.dataset.dragging = 'false'
      delete view.dataset.preparing
      if (dialog.open) dialog.close()
      view.hidden = bar.hidden = image.hidden = true
      image.removeAttribute('src')
      image.alt = ''
      return false
    }
    if (model?.url === url) {
      if (pendingURL && pendingURL !== url) {
        version++
        pendingURL = ''
      }
      model.state = state
      if (historyKey) model.historyKey = historyKey
      image.alt = alt
      status(state)
      return true
    }
    const token = ++version
    pendingURL = url
    const decoded = new Image()
    decoded.src = url
    try {
      await decoded.decode()
    } catch {
      if (token === version) {
        pendingURL = ''
        if (state !== 'stream' || !model) {
          void show({ state: 'empty' })
          stage.dataset.pvError = '图像预览不可用'
          stage.dispatchEvent(new CustomEvent('prooferror', { detail: { message: '无法解码预览图像。' } }))
        }
      }
      return false
    }
    if (token !== version) return false
    // Finish the physical rail already on screen, then take only the newest
    // selection. Rapid clicks cannot remove a half-visible image or leave ghosts.
    if (slide && state === 'result' && !finalReveal && historySettled) {
      await historySettled
      if (token !== version) return false
    }
    pendingURL = ''
    clearHistoryMotion()
    const from = historyOrder.indexOf(model?.historyKey),
      to = historyOrder.indexOf(historyKey)
    if (from >= 0 && to >= 0 && from !== to) slide = Math.sign(to - from)
    const fromEmpty = state === 'result' && !model?.url
    const historySlide = !fromEmpty && slide && state === 'result' && !finalReveal && !reduceMotion.matches
    const oldProof = historySlide ? historySnapshot() : null
    const incomingStream = state === 'stream',
      sameAspect =
        naturalH > 0 &&
        Math.abs(naturalW / naturalH / (decoded.naturalWidth / decoded.naturalHeight) - 1) < 0.035
    const contiguous =
      sameAspect && (model?.state === 'stream' || model?.state === 'pending') && (incomingStream || finalReveal)
    if (!contiguous) stopZoom()
    const ghost = contiguous && !reduceMotion.matches && image.src ? image.cloneNode(false) : null
    if (ghost) {
      ghost.removeAttribute('id')
      ghost.removeAttribute('alt')
      ghost.className = 'pv-before'
      ghost.setAttribute('aria-hidden', 'true')
    }
    clearEffects()
    if (contiguous && naturalW && mode !== 'fit') {
      if (mode === 'actual') mode = 'free'
      scale *= naturalW / decoded.naturalWidth
    } else {
      mode = 'fit'
      panX = panY = 0
    }
    naturalW = decoded.naturalWidth
    naturalH = decoded.naturalHeight
    model = { url, state, historyKey }
    image.alt = alt
    image.src = url
    delete view.dataset.preparing
    image.hidden = view.hidden = bar.hidden = false
    status(state)
    draw()
    schedule()
    if (incomingStream || finalReveal) reveal(incomingStream ? 'frame' : 'final', ghost)
    else if (fromEmpty) reveal('selection')
    else if (historySlide) slideHistory(slide, oldProof)
    return true
  }
  new ResizeObserver(() => {
    schedule()
  }).observe(view)
  reduceMotion.addEventListener('change', () => {
    if (reduceMotion.matches) {
      stopZoom()
      clearEffects()
      finishEdgeEntrance()
    }
  })
  return { show, prepare, open, reset }
}
