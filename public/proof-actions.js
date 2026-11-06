import { sourceImage, editMask } from './controls-media.js'
import { estimateAnlas } from './billing-estimate.js'
import { maxBatch, TOOLS } from './controls-model.js'

const icons = {
  enhance:
    '<path d="m13 2 1.5 4.5L19 8l-4.5 1.5L13 14l-1.5-4.5L7 8l4.5-1.5zM5 13l.9 2.7 2.6.8-2.6.9L5 20l-.9-2.6-2.6-.9 2.6-.8z"/>',
  vary: '<rect x="7.5" y="7.5" width="12" height="12" rx="1.7"/><path d="M15.5 5.4V4.2c0-.9-.7-1.6-1.6-1.6H4.2c-.9 0-1.6.7-1.6 1.6v9.7c0 .9.7 1.6 1.6 1.6h1.2"/><circle cx="11" cy="11" r=".8"/><circle cx="16" cy="16" r=".8"/>',
  upscale: '<path d="M9 5H4.5v14.5H19V15M11 12l8-8m-6.5 0H19v6.5"/><path d="M8 14.5v1h1"/>',
  inpaint:
    '<path d="M6 3H3v3m0 4v4m0 4v3h3m4 0h4m4 0h3v-3M7.1 15.5 7.8 12 16.2 3.6a1.8 1.8 0 0 1 2.6 2.6l-8.4 8.4zM14.8 5l2.6 2.6"/>',
  more: '<path d="M3.5 8h17m-17 8h17"/><rect x="7" y="5.8" width="3.2" height="4.4" rx=".6"/><rect x="14" y="13.8" width="3.2" height="4.4" rx=".6"/>',
  'bg-removal': '<path d="M3 4h18v16H3zM3 11l5-5 4 4m-6 10 7-8 7 7M14 5l5 5m-3-5 3 3"/>',
  lineart: '<path d="m4 17 3.5-1 11.7-11.7-2.5-2.5L5 13.5zM12 19c3-3.4 5 3.6 9-1.2"/>',
  sketch: '<path d="m2 18 7-12-2 10 9-12-3.3 12 8-7-4.5 10"/>',
  colorize: '<path d="M12 3S5.5 10.3 5.5 14.2a6.5 6.5 0 0 0 13 0C18.5 10.3 12 3 12 3zM9 15a3 3 0 0 0 3 3"/>',
  emotion:
    '<path d="M3.3 6q8.8-5 17.4 0v5.2c0 5.3-4.4 8.5-8.8 10-4.4-1.6-8.6-4.7-8.6-10zM6.9 10q2-1.6 3.7 0m2.8 0q1.7-1.6 3.7 0m-8.2 4q3.1 3 6.2 0"/>',
  declutter: '<path d="M3 4h18v13h-9l-5 4v-4H3zM7 8h10m-10 4h6"/>',
  'declutter-keep-bubbles': '<path d="M3 4h18v13h-9l-5 4v-4H3zM7.5 12l3-5 3 5m-4.8-1.5h3.8"/>',
}
const primary = [
  {
    id: 'enhance',
    name: '增强',
    mode: 'img2img',
    models: /^nai-diffusion-(4-5|5)-/,
    requires: '增强需要 V4.5 或 V5。',
    hint: '单张细化，重绘强度 0.4。',
  },
  { id: 'vary', name: '变体', mode: 'img2img', hint: '使用新种子生成 3 个变体。' },
  { id: 'upscale', name: '超分', mode: 'upscale', hint: '点击即以 2× 超分放大，结果存入作品历史。' },
  { id: 'inpaint', name: '重绘', mode: 'inpaint', hint: '在当前成图上绘制重绘蒙版。' },
]
const extra = [
  {
    id: 'max',
    icon: 'enhance',
    name: 'Max Enhance',
    mode: 'img2img',
    models: /^nai-diffusion-5-/,
    requires: 'Max Enhance 需要 V5。',
    hint: '使用 V5 的增强放大。',
  },
  ...Object.entries(TOOLS).map(([id, name]) => ({
    id,
    name,
    mode: 'augment',
    hint: name + '，使用当前成图作为源图。',
  })),
]
const actions = new Map([...primary, ...extra].map((a) => [a.id, a]))

function svg(name) {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  icon.setAttribute('viewBox', '0 0 24 24')
  icon.setAttribute('aria-hidden', 'true')
  icon.innerHTML = icons[name]
  return icon
}
function textNode(tag, cls, text = '') {
  const node = document.createElement(tag)
  node.className = cls
  node.textContent = text
  return node
}
function inputSize(image, mode) {
  if (!image?.width || !image?.height) return null
  const { width, height } = image,
    limit = mode === 'upscale' ? 2250000 : 3145728
  const k = Math.min(1, Math.sqrt(limit / (width * height)), 4096 / Math.max(width, height))
  const snap =
    mode === 'augment' || mode === 'upscale'
      ? (n) => Math.max(1, Math.floor(n * k))
      : (n) => Math.max(64, Math.floor((n * k) / 64) * 64)
  return { width: snap(width), height: snap(height) }
}

function settingsPatch(action, size) {
  const patch = { mode: action.mode, width: size.width, height: size.height, mask: null }
  if (action.mode === 'augment') return { ...patch, tool: action.id }
  if (action.mode === 'upscale') return patch
  if (action.id === 'vary')
    return {
      ...patch,
      seed: null,
      batch: Math.min(3, maxBatch(size.width, size.height)),
      strength: 0.8,
      noise: 0.1,
      enhance: 'off',
    }
  if (action.id === 'inpaint') return { ...patch, batch: 1, focusInpaint: false, strength: 1 }
  return { ...patch, batch: 1, enhance: action.id === 'max' ? 'max' : 'normal', strength: 0.4, noise: 0 }
}
function plan(action, image, settings, account) {
  if (!image?.source) return { reason: '请先生成图像，或从历史中选择一张作品。' }
  if (!settings) return { reason: '正在准备工作台。' }
  if (action.models && !action.models.test(settings.model)) return { reason: action.requires }
  if (action.mode === 'upscale' && image.width * image.height > 2250000)
    return { reason: '独立放大输入上限为 225 万像素，请先缩小原图。' }
  if (image.source instanceof Blob && image.source.size > 24 * 1024 * 1024)
    return { reason: '当前图像超过工作台的 24 MB 导入上限。' }
  const size = inputSize(image, action.mode)
  if (!size) return { price: '载入后估算', detail: '载入图像后读取尺寸并估算费用。' }
  const quote = estimateAnlas({ ...settings, ...settingsPatch(action, size), source: size }, account)
  if (quote.min === null) return { reason: quote.reason }
  const price = (quote.min === quote.max ? quote.min : quote.min + '–' + quote.max) + ' Anlas'
  const detail =
    (account?.provider === 'relay' ? '官方参考价约 ' : account?.connected ? '预计 ' : '标准价约 ') +
    price +
    (quote.quota ? '，另约占 ' + quote.quota.toFixed(3) + '% V5 额度' : '')
  return { price, detail }
}

export function mountProofActions(
  host,
  { getControls, getImage, getAccount, getBusy, onReady, onExecute, notify },
) {
  const group = document.createElement('div')
  group.className = 'pa-strip'
  group.setAttribute('role', 'toolbar')
  group.setAttribute('aria-label', '成图操作')
  const status = textNode('span', 'pa-state', '待选图')
  group.append(status)
  const buttons = new Map()
  function button(action, isMenu = false) {
    const b = textNode('button', isMenu ? 'pa-item' : 'pa-button')
    b.type = 'button'
    b.dataset.proofAction = action.id
    if (isMenu) b.setAttribute('role', 'menuitem')
    b.append(svg(action.icon || action.id), textNode('span', 'pa-label', action.name))
    if (isMenu) b.append(textNode('small', 'pa-price'))
    else if (['enhance', 'vary', 'upscale'].includes(action.id)) {
      const cost = textNode('small', 'pa-inline-cost')
      cost.hidden = true
      cost.setAttribute('aria-hidden', 'true')
      b.append(cost)
    }
    buttons.set(action.id, b)
    return b
  }
  for (const action of primary) group.append(button(action))
  const more = textNode('button', 'pa-button pa-more')
  more.type = 'button'
  more.setAttribute('aria-label', '更多成图操作与导演工具')
  more.setAttribute('aria-haspopup', 'menu')
  more.setAttribute('aria-expanded', 'false')
  more.title = '更多成图操作与导演工具'
  more.append(svg('more'), textNode('span', 'pa-label', '更多'))
  group.append(more)
  host.replaceChildren(group)
  const menu = textNode('div', 'pa-menu')
  menu.id = 'folio-proof-menu-' + crypto.randomUUID()
  more.setAttribute('aria-controls', menu.id)
  more.setAttribute('popovertarget', menu.id)
  menu.setAttribute('popover', 'auto')
  menu.setAttribute('role', 'menu')
  menu.setAttribute('aria-label', '更多成图操作')
  menu.append(
    textNode('p', 'pa-menu-title', '成图操作'),
    button(extra[0], true),
    textNode('p', 'pa-menu-title', '导演工具'),
  )
  for (const action of extra.slice(1)) menu.append(button(action, true))
  const menuFoot = textNode('p', 'pa-menu-foot')
  menu.append(menuFoot)
  document.body.append(menu)
  let opened = false,
    busy = false
  const account = () => getAccount?.() || null
  function refresh() {
    const image = getImage(),
      settings = getControls()?.billingSettings()
    status.hidden = !!image && !busy && !getBusy?.()
    status.textContent = getBusy?.() ? '处理中' : busy ? '准备中' : '待选图'
    menuFoot.textContent = !image
      ? '请先生成或选择一张作品。'
      : account()?.connected
        ? '预计 Anlas · 应用后可更改参数。'
        : '标准价估算 · 连接账户后按权益更新。'
    for (const [id, b] of buttons) {
      const action = actions.get(id),
        info = plan(action, image, settings, account())
      const reason = getBusy?.() ? '当前任务正在处理。' : busy ? '正在准备底图。' : info.reason
      b.setAttribute('aria-disabled', String(!!reason))
      b.title = action.name + ' · ' + (reason || action.hint + ' ' + info.detail)
      b.setAttribute('aria-label', b.title)
      const tag = b.querySelector('.pa-price')
      if (tag) tag.textContent = reason ? (image ? '不可用' : '—') : '≈ ' + info.price
      const inlineCost = b.querySelector('.pa-inline-cost')
      if (inlineCost) {
        inlineCost.hidden = !!reason || !info.price?.endsWith(' Anlas')
        inlineCost.textContent = inlineCost.hidden ? '' : '≈ ' + info.price.slice(0, -6)
      }
    }
  }
  function closeMenu() {
    if (!opened) return
    if (menu.matches(':popover-open')) menu.hidePopover()
    opened = false
    more.setAttribute('aria-expanded', 'false')
  }
  function positionMenu() {
    if (!opened) return
    const r = more.getBoundingClientRect()
    if (r.width === 0) {
      closeMenu()
      return
    }
    const h = Math.min(menu.offsetHeight, innerHeight - 16),
      w = menu.offsetWidth
    const top =
      r.bottom + 7 + h <= innerHeight - 8
        ? r.bottom + 7
        : Math.max(8, Math.min(r.top - h - 7, innerHeight - h - 8))
    menu.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + 'px'
    menu.style.top = top + 'px'
  }
  function showMenu() {
    refresh()
    menu.showPopover()
    opened = true
    more.setAttribute('aria-expanded', 'true')
    positionMenu()
  }
  menu.addEventListener('toggle', () => {
    opened = menu.matches(':popover-open')
    more.setAttribute('aria-expanded', String(opened))
    if (opened) positionMenu()
  })
  more.addEventListener('click', (e) => {
    e.preventDefault()
    if (menu.matches(':popover-open')) closeMenu()
    else showMenu()
  })
  more.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      showMenu()
      menu.querySelector('button').focus()
    }
  })
  menu.addEventListener('keydown', (e) => {
    const entries = [...menu.querySelectorAll('button')],
      i = entries.indexOf(document.activeElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      closeMenu()
      more.focus()
      return
    }
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key]
    if (!step) return
    e.preventDefault()
    entries[(i + step + entries.length) % entries.length].focus()
  })
  async function choose(event) {
    const btn = event.target.closest('[data-proof-action]')
    if (!btn || busy) return
    const op = actions.get(btn.dataset.proofAction),
      img = getImage(),
      controls = getControls()
    const cfg = controls?.billingSettings()
    const { reason } = plan(op, img, cfg, account())
    if (reason) {
      notify?.(reason)
      return
    }
    closeMenu()
    busy = true
    refresh()
    try {
      const accountSession = op.id === 'upscale' ? controls.captureSession() : undefined
      const src = await sourceImage(img.source, img.name, op.mode)
      src.origin = { workId: img.id }
      if (getImage()?.id !== img.id) throw Error('所选作品已更换，请重新选择操作。')
      const choice = plan(op, img, controls.billingSettings(), account())
      if (choice.reason) throw Error(choice.reason)
      const patch = settingsPatch(op, src)
      if (op.id === 'upscale') {
        await onExecute?.({ ...patch, source: src, batch: 1 }, accountSession)
        return
      }
      controls.restore({ ...controls.getSettings({ includeMedia: true }), ...patch, source: src })
      onReady?.(op.id)
      notify?.('已载入' + op.name + '设置。' + choice.detail + '。')
      if (op.mode === 'inpaint') {
        await editMask(src, null, (mask) => {
          const now = controls.getSettings({ includeMedia: true })
          if (now.mode === 'inpaint' && now.source?.data === src.data) controls.restore({ ...now, mask })
        })
      }
    } catch (error) {
      notify?.(error.message)
    } finally {
      busy = false
      refresh()
    }
  }
  group.addEventListener('click', choose)
  menu.addEventListener('click', choose)
  window.addEventListener('resize', positionMenu)
  document.addEventListener('scroll', positionMenu, true)
  refresh()
  return {
    refresh,
    destroy() {
      closeMenu()
      window.removeEventListener('resize', positionMenu)
      document.removeEventListener('scroll', positionMenu, true)
      menu.remove()
      group.remove()
    },
  }
}
