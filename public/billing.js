import { estimateAnlas } from './billing-estimate.js'

const tierNames = ['Paper', 'Tablet', 'Scroll', 'Opus']
const integer = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 })
const fmt = (n) => (Number.isFinite(n) ? integer.format(n) : '未返回')
const time = (t) =>
  new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

function element(tag, text, cls) {
  const n = document.createElement(tag)
  if (text !== null && text !== undefined) n.textContent = text
  if (cls) n.className = cls
  return n
}
function row(title, value) {
  const r = element('div', null, 'bill-row')
  r.append(element('span', title), element('b', value))
  return r
}
function duration(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60))
  if (minutes < 60) return minutes + ' 分钟'
  if (minutes < 1440)
    return Math.floor(minutes / 60) + ' 小时' + (minutes % 60 ? ' ' + (minutes % 60) + ' 分钟' : '')
  const hours = Math.floor((minutes % 1440) / 60)
  return Math.floor(minutes / 1440) + ' 天' + (hours ? ' ' + hours + ' 小时' : '')
}
function action(label, handler) {
  const btn = element('button', label, 'bill-action')
  btn.type = 'button'
  btn.addEventListener('click', handler)
  return btn
}
function meter(label, amount, max) {
  const wrap = element('div', null, 'bill-meter')
  wrap.append(row(label, Number.isFinite(amount) ? fmt(amount) + '%' : '未返回'))
  if (Number.isFinite(amount)) {
    const track = element('span', null, 'bill-track'),
      fill = element('i')
    fill.style.width = Math.min(100, Math.max(0, (amount / max) * 100)) + '%'
    track.append(fill)
    wrap.append(track)
  }
  return wrap
}

export function paintAccountDetails(target, account) {
  target.replaceChildren()
  if (!account?.connected) {
    target.append(element('span', '尚未连接 NovelAI。', 'bill-note'))
    return
  }
  if (account.provider === 'relay' && account.accountAvailable === false) {
    target.append(row('连接', '中转站 · 已配置'), row('余额与 V5 额度', '未知'))
    target.append(
      element('p', account.accountNotice || '中转站未提供兼容的余额接口，可继续生成图像。', 'bill-note'),
    )
    return
  }
  const tier = tierNames[account.tier] || '未知订阅'
  const entitled = account.entitled ?? account.active
  target.append(row('方案', tier + (entitled || account.tier === 0 ? '' : ' · 到期')))
  target.append(
    row('订阅 Anlas', fmt(account.subscriptionAnlas)),
    row('购买 Anlas', fmt(account.purchasedAnlas)),
  )
  if (account.expiresAt > 0)
    target.append(
      row(
        '本期到期',
        new Date(account.expiresAt * 1000).toLocaleString('zh-CN', {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }),
      ),
    )
  if (account.tier >= 3 && entitled) {
    const u = account.usage
    if (!u) target.append(element('p', '本次账户响应未提供 V5 额度。', 'bill-note'))
    else {
      const percent = u.isNegative === true ? 0 : u.percent
      target.append(meter('V5 基础额度剩余', percent, 100), meter('V5 购买额度剩余', u.purchasedPercent, 400))
      if (u.isNegative === true) target.append(element('p', 'NovelAI 当前标记额度不可用。', 'bill-note'))
      if (Number.isFinite(percent) && Number.isFinite(u.purchasedPercent)) {
        const n = Math.round(17.3 * (Math.max(0, percent) + Math.max(0, u.purchasedPercent)))
        target.append(row('约可生成 · 1 MP / 23 步', fmt(n) + ' 张'))
      }
      if (u.timeUntilNextPercent > 0) {
        target.append(row('每恢复 1% 约需', duration(u.timeUntilNextPercent)))
        if (Number.isFinite(percent) && percent < 100 && !u.isNegative)
          target.append(
            row('基础额度回满约需', duration((100 - Math.max(0, percent)) * u.timeUntilNextPercent)),
          )
      } else if (u.timeUntilNextPercent === 0) target.append(element('p', '当前未补充基础额度。', 'bill-note'))
    }
  }
  if (account.checkedAt)
    target.append(
      element(
        'small',
        (account.provider === 'relay' ? '中转站读数 · ' : '官方读数 · ') + time(account.checkedAt),
        'bill-note',
      ),
    )
}

export function mountBilling({ summary, cost, badge, openAccount, refreshAccount }) {
  let account = null,
    settings = null,
    lastCost = ''
  const usage = element('details', null, 'bill-usage'),
    head = element('summary'),
    usageBody = element('div', null, 'bill-details')
  const indicator = element('i', null, 'bill-indicator'),
    title = element('span', '账户用量'),
    balance = element('strong'),
    chevron = element('span', '⌄', 'bill-chevron')
  head.append(indicator, title, balance, chevron)
  usage.append(head, usageBody)
  summary.replaceChildren(usage)
  const details = element('details', null, 'bill-cost'),
    quote = element('summary'),
    quoteLabel = element('span', '本次预计'),
    total = element('strong'),
    costChevron = element('span', '⌄', 'bill-chevron')
  const breakdown = element('div', null, 'bill-breakdown')
  quote.append(quoteLabel, total, costChevron)
  details.append(quote, breakdown)
  cost.replaceChildren(details)
  function paintAccount() {
    usage.classList.toggle('is-connected', account?.connected === true)
    const isOpus = account?.connected && account.tier >= 3 && (account.entitled ?? account.active)
    const quota = isOpus ? (account.usage?.isNegative === true ? 0 : account.usage?.percent) : null
    title.textContent = account?.connected
      ? account.provider === 'relay'
        ? '中转站用量'
        : '账户用量'
      : '余额与 V5 额度'
    const balanceText =
      account?.accountAvailable === false
        ? '余额未知'
        : account?.anlas != null
          ? fmt(account.anlas) + ' Anlas'
          : tierNames[account?.tier] || '已连接'
    balance.textContent = account?.connected
      ? (isOpus ? 'V5 剩余 ' + (Number.isFinite(quota) ? fmt(quota) + '%' : '未知') + ' · ' : '') + balanceText
      : '未连接'
    paintAccountDetails(usageBody, account)
    if (account?.connected) {
      const status = element('span', null, 'bill-note')
      const refresh = action('刷新用量', async () => {
        refresh.disabled = true
        status.textContent = '读取中…'
        try {
          await refreshAccount?.()
          status.textContent = '已更新'
        } catch (e) {
          status.textContent = e.message
        } finally {
          refresh.disabled = false
        }
      })
      usageBody.append(refresh, status)
    } else usageBody.append(action('连接 NovelAI ↗', () => openAccount?.()))
  }
  function paintCost() {
    const p = estimateAnlas(settings, account)
    const signature = JSON.stringify([p, account?.connected, account?.anlas, account?.provider])
    if (signature === lastCost) return
    lastCost = signature
    const known = p.min !== null,
      range = known && p.min !== p.max
    const label = known ? (range ? p.min + '–' + p.max : String(p.min)) + ' Anlas' : p.reason
    quoteLabel.textContent =
      account?.provider === 'relay' ? '官方参考价' : known && !account?.connected ? '标准价预估' : '本次预计'
    total.textContent = label + (p.quota ? ' · 约 ' + p.quota.toFixed(3) + '% 额度' : '')
    badge.textContent = known ? '≈ ' + label : '待估价'
    badge.title = known ? quoteLabel.textContent + ' ' + label : p.reason
    breakdown.replaceChildren(...p.lines.map((line) => element('p', line)))
    if (known && account?.connected && Number.isFinite(account.anlas)) {
      breakdown.append(row('当前余额', fmt(account.anlas) + ' Anlas'))
      if (p.min > account.anlas) breakdown.append(element('p', '预计费用高于当前余额。', 'bill-low'))
    }
    if (!known) breakdown.append(element('p', p.reason + '，可估算后会在这里显示明细。'))
    else
      breakdown.append(
        element(
          'small',
          account?.provider === 'relay'
            ? '按 NovelAI 规则展示参考价，中转站可能使用不同费率，实际扣费以中转站为准。'
            : '按 NovelAI 当前公开网页规则估算，实际扣费以账户为准。',
          'bill-note',
        ),
      )
  }
  paintAccount()
  paintCost()
  return {
    setAccount(value) {
      account = value
      paintAccount()
      paintCost()
    },
    setSettings(value) {
      settings = value
      paintCost()
    },
    refresh: () => refreshAccount?.(),
  }
}
