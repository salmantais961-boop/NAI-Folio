import { paintAccountDetails } from './billing.js'
import { normalizeProfile, readProfiles, writeProfiles, profileHeaders } from './account-profiles.js'

export function connection({ onAccount, notify }) {
  const saved = readProfiles()
  let profiles = saved.profiles,
    current = profiles.find((p) => p.id === saved.activeId) || null,
    account = null,
    env = false,
    allowEnvironment = saved.allowEnvironment,
    panel = null,
    paintPanel = null,
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

  function openAccount() {
    if (panel) {
      panel.querySelector('[data-close]').focus({ preventScroll: true })
      return
    }
    const returnFocus = document.activeElement
    const d = document.createElement('aside')
    panel = d
    d.className = 'ap-panel'
    d.setAttribute('role', 'dialog')
    d.setAttribute('aria-modal', 'false')
    d.setAttribute('aria-labelledby', 'ap-title')
    d.innerHTML = `<header class="ap-header"><div><small>FOLIO / CONNECTIONS</small><h2 id="ap-title">账户与连接</h2></div><button type="button" data-close aria-label="关闭账户面板">×</button></header>
      <div class="ap-body"><div class="ap-current" aria-live="polite"></div><details class="ap-usage"><summary>账户用量</summary><div class="bill-account-detail"></div></details>
      <section class="ap-collection"><div class="ap-section-head"><h3>已保存的账户</h3><button type="button" data-new>＋ 添加账户</button></div><div class="ap-profiles"></div></section>
      <form class="ap-form"><div class="ap-section-head"><h3 class="ap-editor-title">添加账户</h3><span class="ap-edit-marker">01 / CONNECTION</span></div>
      <label class="ap-field"><span>账户名称</span><input name="name" maxlength="80" autocomplete="off" placeholder="例如 主账号 / 备用账号"></label>
      <label class="ap-field"><span>连接方式</span><select name="provider"><option value="official">NovelAI 官方</option><option value="relay">NAI API 中转站</option></select></label>
      <div class="ap-relay" hidden><label class="ap-field"><span>生图 API 地址</span><input name="imageBase" type="url" autocomplete="off" spellcheck="false" placeholder="https://relay.example/novelai"></label>
      <label class="ap-field"><span>账户 API 地址 <small>可选</small></span><input name="accountBase" type="url" autocomplete="off" spellcheck="false" placeholder="留空则与生图地址一致"></label>
      <p class="ap-hint">填写支持 NovelAI 原生接口的站点根地址或路径前缀。账户查询不可用时，仍可生成图像。</p></div>
      <label class="ap-field"><span>API Key</span><div class="ap-secret"><input name="token" type="password" autocomplete="off" spellcheck="false" autocapitalize="none" placeholder="pst-… 或中转站密钥"><button type="button" data-reveal aria-label="显示 API Key" aria-pressed="false">显示</button></div></label>
      <p class="ap-hint ap-storage-note">保存后，密钥仅存于此浏览器的本地存储，刷新后可继续使用。</p>
      <div class="ap-error" role="status" aria-live="polite"></div>
      <div class="ap-submit"><button type="button" data-once>仅本次使用</button><button type="submit" class="ap-primary">保存并使用 <span aria-hidden="true">↗</span></button></div>
      <div class="ap-delete-line" hidden><button type="button" data-delete>删除此账户</button><button type="button" data-cancel-delete hidden>取消</button></div></form></div>
      <footer class="ap-footer"><span>LOCAL / PRIVATE WORKSPACE</span><button type="button" data-disconnect>断开当前连接</button></footer>`
    document.body.append(d)
    const form = d.querySelector('form'),
      field = (name) => form.elements.namedItem(name),
      note = d.querySelector('.ap-error'),
      list = d.querySelector('.ap-profiles'),
      submit = form.querySelector('[type=submit]'),
      once = form.querySelector('[data-once]'),
      detail = d.querySelector('.bill-account-detail')
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
      d.querySelector('.ap-editor-title').textContent = editing
        ? '编辑账户'
        : profile
          ? '保存当前连接'
          : '添加账户'
      showProviderFields()
      d.querySelector('.ap-delete-line').hidden = !editing
      note.textContent = ''
      resetDelete()
    }
    function paint() {
      const status = d.querySelector('.ap-current')
      status.replaceChildren()
      const dot = document.createElement('i'),
        text = document.createElement('span'),
        caption = document.createElement('small')
      dot.className = account ? 'is-connected' : ''
      text.textContent = current?.name || '尚未连接'
      caption.textContent = checking
        ? '正在核对连接…'
        : account?.accountAvailable === false
          ? '中转站已选择 · 余额未提供'
          : account
            ? '连接正常'
            : current
              ? '等待连接验证'
              : '选择一个账户，开始创作'
      status.append(dot, text, caption)
      d.querySelector('.ap-usage').hidden = !account
      if (account) paintAccountDetails(detail, { ...account, connected: true })
      list.replaceChildren()
      if (!profiles.length) {
        const empty = document.createElement('p')
        empty.className = 'ap-empty'
        empty.textContent = '把常用连接收在这里。'
        list.append(empty)
      }
      profiles.forEach((profile, index) => {
        const row = document.createElement('div'),
          choose = document.createElement('button'),
          number = document.createElement('span'),
          title = document.createElement('strong'),
          meta = document.createElement('small'),
          content = document.createElement('span'),
          edit = document.createElement('button')
        row.className = 'ap-profile'
        row.classList.toggle('is-current', current?.id === profile.id)
        choose.type = edit.type = 'button'
        choose.className = 'ap-choose'
        choose.setAttribute('aria-label', '使用账户 ' + profile.name)
        choose.setAttribute('aria-pressed', String(current?.id === profile.id))
        choose.disabled = edit.disabled = working
        number.className = 'ap-number'
        number.textContent = String(index + 1).padStart(2, '0')
        title.textContent = profile.name
        meta.textContent =
          (profile.provider === 'relay' ? new URL(profile.imageBase).host : 'NovelAI 官方') +
          (current?.id === profile.id ? ' · 当前' : '')
        content.append(title, meta)
        choose.append(number, content)
        edit.className = 'ap-edit'
        edit.textContent = '编辑'
        edit.setAttribute('aria-label', '编辑账户 ' + profile.name)
        choose.onclick = async () => {
          loadForm(profile)
          await run(() => activate(profile, true))
        }
        edit.onclick = () => {
          loadForm(profile)
          field('name').focus({ preventScroll: true })
        }
        row.append(choose, edit)
        list.append(row)
      })
      d.querySelector('[data-disconnect]').hidden = !current
    }
    async function run(action) {
      if (working) return
      working = true
      submit.disabled = once.disabled = true
      d.querySelector('[data-new]').disabled = true
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
        note.textContent = error.message
      } finally {
        working = false
        submit.disabled = once.disabled = false
        d.querySelector('[data-new]').disabled = false
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
    d.querySelector('[data-new]').onclick = () => {
      loadForm(null)
      field('name').focus({ preventScroll: true })
    }
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
      loadForm(null)
      report()
      note.textContent = '账户与密钥已从本机删除。'
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
      document.removeEventListener('keydown', escape)
      d.remove()
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
    paintPanel = paint
    loadForm(current)
    paint()
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
