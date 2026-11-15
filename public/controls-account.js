import { accountUsageSummary } from './billing.js'
import { normalizeProfile, readProfiles, writeProfiles, profileHeaders } from './account-profiles.js'
import {
  getHideNSFW,
  setHideNSFW,
  getShowOpening,
  setShowOpening,
  getShowHeaderUsage,
  setShowHeaderUsage,
  getCloseAction,
  setCloseAction,
  isDesktopShell,
} from './content-preferences.js'
import { leave, reveal, conceal } from './motion.js'
import { LOCALES, getLocale, setLocale } from './i18n.js'
import { setIcon } from './icons.js'

export function connection({ onAccount, notify }) {
  const saved = readProfiles()
  let profiles = saved.profiles,
    current = profiles.find((p) => p.id === saved.activeId) || null,
    account = null,
    env = false,
    allowEnvironment = saved.allowEnvironment,
    panel = null,
    paintPanel = null,
    closePanel = null,
    version = 0,
    refreshSequence = 0,
    checking = false

  function report() {
    const name = current?.name || 'NovelAI'
    const label = account
      ? account.anlas != null
        ? `${name} · ${account.anlas} Anlas`
        : `${name} · ${account.accountAvailable === false ? '用量未知' : '已连接'}`
      : checking
        ? '正在连接…'
        : current
          ? `${name} · 待连接`
          : '连接 NovelAI'
    onAccount?.({
      ...account,
      connected: !!account,
      label,
      profileName: current?.name,
      provider: current?.provider || 'official',
    })
    paintPanel?.()
  }

  async function fetchApi(path, body, signal, profile = current, requestVersion = version) {
    if (path !== 'status' && !profile) throw Error('请先选择并连接一个账户。')
    const headers = profileHeaders(profile)
    if (body) headers['Content-Type'] = 'application/json'
    const response = await fetch('/api/' + path, {
      method: body ? 'POST' : 'GET',
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal,
      cache: 'no-store',
    })
    if (!response.ok) {
      const error = await response.json().catch(() => ({}))
      if (path !== 'account' && response.status === 401 && requestVersion === version && profile === current) {
        account = null
        report()
      }
      const failure = Error(typeof error.error === 'string' ? error.error : `请求未完成（${response.status}）`)
      failure.status = response.status
      throw failure
    }
    return response
  }

  async function refresh() {
    const requestVersion = version,
      serial = ++refreshSequence,
      profile = current
    let info
    try {
      info = await (await fetchApi('account', null, undefined, profile)).json()
    } catch (error) {
      if (
        error.status === 401 &&
        requestVersion === version &&
        serial === refreshSequence &&
        profile === current
      ) {
        account = null
        report()
      }
      throw error
    }
    if (typeof info !== 'object' || info === null || typeof info.active !== 'boolean')
      throw Error('账户接口返回了无法识别的数据。')
    if (requestVersion === version && serial === refreshSequence && profile === current) {
      account = { ...info, checkedAt: Date.now() }
      report()
    }
    return info
  }

  async function activate(profile, persistent) {
    writeProfiles(profiles, persistent ? profile.id : null)
    current = profile
    allowEnvironment = true
    const requestVersion = ++version
    account = null
    checking = true
    report()
    try {
      const info = await refresh()
      if (requestVersion === version)
        notify?.(
          info.accountAvailable === false ? '已选择中转站，实际连接将在生成时验证' : `${profile.name} 已连接`,
        )
      return info
    } finally {
      if (requestVersion === version) {
        checking = false
        report()
      }
    }
  }

  const ready = (async () => {
    const initialVersion = version
    try {
      env = !!(await (await fetchApi('status')).json()).configured
      if (version !== initialVersion) return
      if (current || (env && allowEnvironment)) {
        if (!current) current = { name: '环境令牌', provider: 'official', token: '', id: '' }
        checking = true
        report()
        await refresh()
      }
    } catch {}
    if (version === initialVersion) {
      checking = false
      report()
    }
  })()

  function openAccount({ toggle = false } = {}) {
    if (panel) {
      if (toggle) closePanel?.()
      else panel.querySelector('[data-close]').focus({ preventScroll: true })
      return
    }
    const opener = document.getElementById('account')
    opener?.setAttribute('aria-expanded', 'true')
    const returnFocus = document.activeElement
    const d = document.createElement('aside')
    panel = d
    d.className = 'ap-panel'
    d.setAttribute('role', 'dialog')
    d.setAttribute('aria-modal', 'false')
    d.setAttribute('aria-labelledby', 'ap-title')
    d.innerHTML = `<header class="ap-header">
      <h2 id="ap-title">设置</h2>
      <button type="button" data-close aria-label="关闭设置"></button>
    </header>
    <div class="ap-body">
      <section class="ap-group" aria-labelledby="ap-general-title">
        <h3 class="ap-group-title" id="ap-general-title">通用</h3>
        <div class="ap-card ap-list">
          <div class="ap-row">
            <span class="ap-row-copy"><strong id="ap-locale-name">语言</strong></span>
            <select class="ap-row-select" data-locale aria-labelledby="ap-locale-name" translate="no">${LOCALES.map(
              ([code, name]) => `<option value="${code}">${name}</option>`,
            ).join('')}</select>
          </div>
          ${isDesktopShell() ? `<div class="ap-row" role="group" aria-labelledby="ap-close-name">
            <span class="ap-row-copy"><strong id="ap-close-name">点击关闭时</strong></span>
            <div class="ap-segment" data-close-action>
              <button type="button" data-value="quit">彻底退出</button><button type="button" data-value="tray">最小化到托盘</button>
            </div>
          </div>` : ''}
          <label class="fc-transport ap-row ap-preference">
            <span class="ap-row-copy"><strong id="ap-nsfw-name">隐藏 NSFW</strong>
              <small id="ap-nsfw-note">隐藏正向提示词或角色提示词命中敏感标签的图像。</small></span>
            <input type="checkbox" role="switch" aria-labelledby="ap-nsfw-name" aria-describedby="ap-nsfw-note" data-hide-nsfw>
            <span class="fc-switch" aria-hidden="true"></span>
          </label>
          ${document.getElementById('cover') ? `<label class="fc-transport ap-row ap-preference">
            <span class="ap-row-copy"><strong id="ap-opening-name">入场时播放封面画刊</strong></span>
            <input type="checkbox" role="switch" aria-labelledby="ap-opening-name" data-show-opening>
            <span class="fc-switch" aria-hidden="true"></span>
          </label>` : ''}
        </div>
      </section>
      <section class="ap-group" aria-labelledby="ap-account-title">
        <h3 class="ap-group-title" id="ap-account-title">账户</h3>
        <div class="ap-card ap-list ap-overview">
          <div class="ap-row ap-current" aria-live="polite">
            <div><strong class="ap-current-name"></strong><small class="ap-current-status"></small></div>
            <button type="button" data-disconnect>断开连接</button>
          </div>
          <div class="ap-row ap-usage" aria-live="polite"><span>账户用量</span><span class="ap-usage-value"></span></div>
          <label class="fc-transport ap-row ap-preference ap-usage-preference">
            <span class="ap-row-copy"><strong id="ap-header-usage-name">在顶栏显示用量概览</strong></span>
            <input type="checkbox" role="switch" aria-labelledby="ap-header-usage-name" data-show-header-usage>
            <span class="fc-switch" aria-hidden="true"></span>
          </label>
        </div>
        <div class="ap-card ap-list ap-collection">
          <div class="ap-subhead"><span>已保存的账户</span><output class="ap-count"></output></div>
          <div class="ap-profiles"></div>
          <div class="ap-profile ap-add-slot"><button type="button" class="ap-add" data-new aria-expanded="false">
            <span class="ap-add-mark" aria-hidden="true"></span><span>添加账户</span></button></div>
        </div>
      </section>
    </div>
    <form class="ap-form" hidden>
      <div class="ap-pair">
        <label class="ap-field"><span>账户名称</span><input name="name" maxlength="80" autocomplete="off" placeholder="如：主账号"></label>
        <label class="ap-field"><span>连接方式</span><select name="provider"><option value="official">NovelAI 官方</option><option value="relay">NAI API 中转站</option></select></label>
      </div>
      <div class="ap-relay" hidden>
        <label class="ap-field"><span>生图 API 地址</span><input name="imageBase" type="url" autocomplete="off" spellcheck="false" placeholder="https://relay.example/novelai"></label>
        <label class="ap-field"><span>账户 API 地址 <small>可选</small></span><input name="accountBase" type="url" autocomplete="off" spellcheck="false" placeholder="留空使用生图地址"></label>
      </div>
      <label class="ap-field"><span>API Key</span><span class="ap-secret"><input name="token" type="password" autocomplete="off" spellcheck="false" autocapitalize="none" placeholder="pst-… 或中转站密钥"><button type="button" data-reveal aria-label="显示 API Key" aria-pressed="false">显示</button></span></label>
      <p class="ap-hint">保存后的密钥仅存于当前浏览器。</p>
      <div class="ap-error" role="status" aria-live="polite"></div>
      <div class="ap-submit"><button type="button" data-once>仅本次使用</button><button type="submit" class="ap-primary">保存并使用 <span aria-hidden="true">↗</span></button></div>
      <div class="ap-delete-line" hidden><button type="button" data-delete>删除此账户</button><button type="button" data-cancel-delete hidden>取消</button></div>
    </form>`
    setIcon(d.querySelector('[data-close]'), 'x')
    document.body.append(d)
    const preferenceListeners = new AbortController()
    for (const [selector, eventName, get, set] of [
      ['[data-hide-nsfw]', 'folio:content-preferences', getHideNSFW, setHideNSFW],
      ['[data-show-opening]', 'folio:opening-preference', getShowOpening, setShowOpening],
      ['[data-show-header-usage]', 'folio:header-usage-preference', getShowHeaderUsage, setShowHeaderUsage],
    ]) {
      const input = d.querySelector(selector)
      if (!input) continue
      const sync = () => { input.checked = get() }
      sync()
      window.addEventListener(eventName, sync, { signal: preferenceListeners.signal })
      input.onchange = () => {
        if (!set(input.checked)) notify?.('设置已用于本页，但浏览器未能记住此选项。')
      }
    }
    const localeSelect = d.querySelector('[data-locale]')
    localeSelect.value = getLocale()
    localeSelect.onchange = () => void setLocale(localeSelect.value)
    window.addEventListener('folio:locale', () => (localeSelect.value = getLocale()), {
      signal: preferenceListeners.signal,
    })
    const closeChoice = d.querySelector('[data-close-action]')
    if (closeChoice) {
      const paintChoice = () => {
        for (const option of closeChoice.querySelectorAll('button'))
          option.setAttribute('aria-pressed', String(option.dataset.value === getCloseAction()))
      }
      paintChoice()
      closeChoice.onclick = (event) => {
        const option = event.target.closest('button[data-value]')
        if (!option) return
        if (!setCloseAction(option.dataset.value)) notify?.('设置已用于本页，但浏览器未能记住此选项。')
        paintChoice()
      }
    }
    const form = d.querySelector('form'),
      field = (name) => form.elements.namedItem(name),
      note = d.querySelector('.ap-error'),
      list = d.querySelector('.ap-profiles'),
      submit = form.querySelector('[type=submit]'),
      once = form.querySelector('[data-once]')
    let editing = current?.id || '',
      editToken = current?.token || '',
      credentialEndpoint = '',
      working = false,
      confirmingDelete = false

    function resetDelete() {
      confirmingDelete = false
      d.querySelector('[data-delete]').textContent = '删除此账户'
      d.querySelector('[data-cancel-delete]').hidden = true
    }
    function loadForm(profile) {
      editing = profile?.id || ''
      editToken = profile?.token || ''
      field('name').value = profile?.name || ''
      field('provider').value = profile?.provider || 'official'
      field('imageBase').value = profile?.imageBase || ''
      field('accountBase').value = profile?.accountBase || ''
      credentialEndpoint = JSON.stringify([
        field('provider').value,
        field('imageBase').value,
        field('accountBase').value,
      ])
      field('token').value = ''
      field('token').type = 'password'
      field('token').placeholder = editToken
        ? '已保留密钥，留空继续使用'
        : profile?.name === '环境令牌'
          ? '使用环境令牌，保存时请粘贴密钥'
          : 'pst-… 或中转站密钥'
      d.querySelector('[data-reveal]').textContent = '显示'
      d.querySelector('[data-reveal]').setAttribute('aria-pressed', 'false')
      d.querySelector('[data-reveal]').setAttribute('aria-label', '显示 API Key')
      showProviderFields()
      d.querySelector('.ap-delete-line').hidden = !editing
      note.textContent = ''
      resetDelete()
    }
    function paint() {
      const status = d.querySelector('.ap-current-status')
      d.querySelector('.ap-current-name').textContent = current?.name || '尚未连接'
      status.classList.toggle('is-connected', !!account)
      status.textContent = checking
        ? '正在核对连接…'
        : account?.accountAvailable === false
          ? '中转站已选择'
          : account
            ? (current?.provider === 'relay' ? 'NAI 中转站' : 'NovelAI 官方') + ' · 已连接'
            : current
              ? '等待连接验证'
              : '选择已保存账户或添加连接'
      d.querySelector('.ap-count').textContent = String(profiles.length)
      const usage = d.querySelector('.ap-usage-value')
      usage.textContent = checking ? '读取中…' : accountUsageSummary({ ...account, connected: !!account })
      usage.title = usage.textContent
      paintProfiles()
      d.querySelector('[data-disconnect]').hidden = !current
    }
    // Rows are reconciled, never rebuilt, so an open editor keeps its focus.
    const rows = new Map()
    let expanded = null
    function makeRow(profile) {
      const row = document.createElement('div'),
        head = document.createElement('div'),
        use = document.createElement('button'),
        indicator = document.createElement('i'),
        choose = document.createElement('button'),
        content = document.createElement('span'),
        title = document.createElement('strong'),
        meta = document.createElement('small'),
        chevron = document.createElement('span')
      row.className = 'ap-profile'
      head.className = 'ap-profile-head'
      use.type = choose.type = 'button'
      use.className = 'ap-use'
      indicator.className = 'ap-selector'
      indicator.setAttribute('aria-hidden', 'true')
      use.append(indicator)
      choose.className = 'ap-choose'
      chevron.className = 'ap-chevron'
      chevron.setAttribute('aria-hidden', 'true')
      content.append(title, meta)
      choose.append(content, chevron)
      head.append(use, choose)
      row.append(head)
      const entry = { row, use, choose, title, meta, profile }
      use.onclick = async () => {
        const target = entry.profile
        if (current?.id === target.id && account) return
        await run(() => activate(target, true), target)
      }
      choose.onclick = () => toggleEditor(entry.profile.id)
      return entry
    }
    function paintProfiles() {
      const seen = new Set()
      let previous = null
      for (const profile of profiles) {
        seen.add(profile.id)
        let entry = rows.get(profile.id)
        if (!entry) rows.set(profile.id, (entry = makeRow(profile)))
        entry.profile = profile
        const isCurrent = current?.id === profile.id
        entry.row.classList.toggle('is-current', isCurrent)
        entry.row.classList.toggle('is-open', expanded === profile.id)
        entry.use.setAttribute('aria-pressed', String(isCurrent))
        entry.use.setAttribute('aria-label', (isCurrent ? '当前账户 ' : '使用账户 ') + profile.name)
        entry.use.title = isCurrent ? '当前账户' : '切换到此账户'
        entry.use.disabled = entry.choose.disabled = working
        entry.choose.setAttribute('aria-expanded', String(expanded === profile.id))
        entry.choose.setAttribute('aria-label', '编辑账户 ' + profile.name)
        entry.title.textContent = profile.name
        entry.meta.textContent =
          (profile.provider === 'relay' ? new URL(profile.imageBase).host : 'NovelAI 官方') +
          (isCurrent ? ' · 当前' : '')
        const place = previous ? previous.nextSibling : list.firstChild
        if (entry.row !== place) list.insertBefore(entry.row, place)
        previous = entry.row
      }
      for (const [id, entry] of rows)
        if (!seen.has(id)) {
          entry.row.remove()
          rows.delete(id)
        }
      list.hidden = !profiles.length
      d.querySelector('.ap-add-slot').classList.toggle('is-open', expanded === 'new')
      d.querySelector('[data-new]').setAttribute('aria-expanded', String(expanded === 'new'))
      d.querySelector('[data-new]').disabled = working
    }
    function hostFor(id) {
      return id === 'new' ? d.querySelector('.ap-add-slot') : rows.get(id)?.row
    }
    function openEditor(id) {
      const host = hostFor(id)
      if (!host) return
      if (expanded === id && !form.hidden) return
      if (!form.hidden) conceal(form)
      expanded = id
      loadForm(id === 'new' ? null : profiles.find((profile) => profile.id === id) || null)
      host.append(form)
      paintProfiles()
      reveal(form)
    }
    function closeEditor() {
      if (form.hidden) return
      conceal(form)
      expanded = null
      paintProfiles()
    }
    function toggleEditor(id) {
      if (expanded === id && !form.hidden) closeEditor()
      else {
        openEditor(id)
        field('name').focus({ preventScroll: true })
        form.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }
    }
    async function run(action, profile) {
      if (working) return
      working = true
      submit.disabled = once.disabled = true
      form.querySelector('[data-delete]').disabled = true
      form.setAttribute('aria-busy', 'true')
      note.textContent = '正在核对连接…'
      paint()
      try {
        const info = await action()
        note.textContent =
          info?.accountAvailable === false
            ? info.accountNotice || '已选择中转站，生成时验证密钥。'
            : '连接已更新。'
      } catch (error) {
        if (profile && (form.hidden || expanded !== profile.id)) openEditor(profile.id)
        note.textContent = error.message
      } finally {
        working = false
        submit.disabled = once.disabled = false
        form.querySelector('[data-delete]').disabled = false
        form.removeAttribute('aria-busy')
        paint()
      }
    }
    async function submitProfile(persist) {
      let profile
      try {
        profile = normalizeProfile(
          {
            id: persist ? editing || crypto.randomUUID() : '',
            name: field('name').value,
            provider: field('provider').value,
            token: field('token').value || editToken,
            imageBase: field('imageBase').value,
            accountBase: field('accountBase').value,
          },
          { allowEnvironment: !persist && env },
        )
      } catch (error) {
        note.textContent = error.message
        return
      }
      await run(async () => {
        if (persist) {
          const next = profiles.filter((p) => p.id !== profile.id)
          const index = profiles.findIndex((p) => p.id === profile.id)
          next.splice(index < 0 ? next.length : index, 0, profile)
          writeProfiles(next, profile.id)
          profiles = next
          if (expanded === 'new') {
            expanded = profile.id
            paintProfiles()
            hostFor(profile.id)?.append(form)
          }
          loadForm(profile)
        }
        const info = await activate(profile, persist)
        if (!persist) loadForm(profile)
        return info
      })
    }
    form.onsubmit = (event) => {
      event.preventDefault()
      void submitProfile(true)
    }
    once.onclick = () => void submitProfile(false)
    function checkCredentialDestination() {
      const destination = JSON.stringify([
        field('provider').value,
        field('imageBase').value,
        field('accountBase').value,
      ])
      if (editToken && destination !== credentialEndpoint) {
        if (field('token').value === editToken) field('token').value = ''
        editToken = ''
        field('token').placeholder = '连接地址已变更，请重新输入密钥'
      }
    }
    function showProviderFields() {
      const relay = field('provider').value === 'relay'
      d.querySelector('.ap-relay').hidden = !relay
      field('imageBase').disabled = field('accountBase').disabled = !relay
    }
    field('provider').onchange = () => {
      showProviderFields()
      checkCredentialDestination()
    }
    field('imageBase').oninput = checkCredentialDestination
    field('accountBase').oninput = checkCredentialDestination
    d.querySelector('[data-reveal]').onclick = (event) => {
      const reveal = field('token').type === 'password'
      if (reveal && !field('token').value && editToken) field('token').value = editToken
      field('token').type = reveal ? 'text' : 'password'
      event.currentTarget.textContent = reveal ? '隐藏' : '显示'
      event.currentTarget.setAttribute('aria-pressed', String(reveal))
      event.currentTarget.setAttribute('aria-label', reveal ? '隐藏 API Key' : '显示 API Key')
    }
    d.querySelector('[data-new]').onclick = () => toggleEditor('new')
    d.querySelector('[data-cancel-delete]').onclick = resetDelete
    d.querySelector('[data-delete]').onclick = () => {
      if (!editing || working) return
      if (!confirmingDelete) {
        confirmingDelete = true
        d.querySelector('[data-delete]').textContent = '确认从本机删除'
        d.querySelector('[data-cancel-delete]').hidden = false
        return
      }
      const next = profiles.filter((p) => p.id !== editing)
      try {
        writeProfiles(next, current?.id === editing ? null : current?.id || null)
      } catch (error) {
        note.textContent = error.message
        return
      }
      profiles = next
      if (current?.id === editing) disconnect()
      closeEditor()
      loadForm(null)
      report()
      notify?.('账户与密钥已从本机删除。')
    }
    function disconnect() {
      writeProfiles(profiles, null)
      version++
      current = null
      account = null
      checking = false
      allowEnvironment = false
      report()
    }
    d.querySelector('[data-disconnect]').onclick = () => {
      try {
        disconnect()
        note.textContent = '当前连接已断开，已保存的账户仍保留。'
      } catch (error) {
        note.textContent = error.message
      }
    }
    function close() {
      if (panel !== d) return
      field('token').value = ''
      editToken = ''
      panel = null
      paintPanel = null
      closePanel = null
      opener?.setAttribute('aria-expanded', 'false')
      preferenceListeners.abort()
      document.removeEventListener('keydown', escape)
      leave(d)
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true })
    }
    function escape(event) {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !event.isComposing &&
        !document.querySelector('dialog[open]')
      ) {
        event.preventDefault()
        close()
      }
    }
    d.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') event.stopPropagation()
      if (event.key === 'Escape' && !event.isComposing && !event.defaultPrevented) {
        event.preventDefault()
        event.stopPropagation()
        close()
      }
    })
    d.querySelector('[data-close]').onclick = close
    document.addEventListener('keydown', escape)
    closePanel = close
    paintPanel = paint
    loadForm(null)
    paint()
    if (!profiles.length) {
      expanded = 'new'
      d.querySelector('.ap-add-slot').append(form)
      form.hidden = false
      paintProfiles()
    }
    d.querySelector('[data-close]').focus({ preventScroll: true })
  }

  async function session() {
    const initialProfile = current,
      requestVersion = version
    await ready
    if (!initialProfile && requestVersion === version && !current && env && allowEnvironment)
      current = { name: '环境令牌', provider: 'official', token: '', id: '' }
    const profile = initialProfile || (requestVersion === version ? current : null),
      connected = requestVersion === version && profile === current && !!account
    const isCurrent = () => requestVersion === version && profile === current
    return {
      async ensure() {
        if (!profile) {
          if (requestVersion !== version) throw Error('提交时的账户连接已改变，请重新提交。')
          openAccount()
          throw Error('请先选择并连接一个账户。')
        }
        if (connected) return
        try {
          if (isCurrent()) await refresh()
          else {
            const info = await (await fetchApi('account', null, undefined, profile, requestVersion)).json()
            if (typeof info?.active !== 'boolean') throw Error('账户接口返回了无法识别的数据。')
          }
        } catch (error) {
          if (isCurrent()) openAccount()
          throw error
        }
      },
      fetchApi: (path, body, signal) => fetchApi(path, body, signal, profile, requestVersion),
      refresh: () => (isCurrent() ? refresh() : Promise.resolve(null)),
    }
  }
  return { openAccount, ensure: async () => (await session()).ensure(), fetchApi, refresh, session }
}

export async function streamResult(response, onPreview) {
  if (!response.body) throw Error('流式响应没有内容。')
  const reader = response.body.getReader(),
    decoder = new TextDecoder()
  let buffer = '',
    result = null
  function line(s) {
    if (!s.trim()) return
    const item = JSON.parse(s)
    if (item.type === 'error') throw Error(item.error || '生成中断。')
    if (item.type === 'preview') onPreview?.(item)
    if (item.type === 'result') result = item
  }
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      let cut
      while ((cut = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, cut))
        buffer = buffer.slice(cut + 1)
      }
    }
    line(buffer + decoder.decode())
    if (!result) throw Error('流式连接已结束，未收到最终图片。')
    return result
  } finally {
    reader.releaseLock()
  }
}
