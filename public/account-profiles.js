const storageKey = 'folio.connection.profiles.v1'

export function normalizeBase(value, required = false) {
  const raw = String(value || '').trim()
  if (!raw && !required) return ''
  let url
  try {
    url = new URL(raw)
  } catch {
    throw Error('请输入完整的 API 地址，例如 https://relay.example/novelai。')
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    throw Error('API 地址需要使用 HTTPS，本机服务也支持 HTTP。')
  if (url.username || url.password || raw.includes('?') || raw.includes('#'))
    throw Error('API 地址不能包含登录信息、查询参数或 # 片段。')
  return url.href.replace(/\/+$/, '')
}

export function normalizeProfile(input, { allowEnvironment = false } = {}) {
  const provider = input.provider === 'relay' ? 'relay' : 'official'
  const token = String(input.token || '')
    .trim()
    .replace(/^Bearer\s+/i, '')
  if (!token && !(allowEnvironment && provider === 'official')) throw Error('请输入 API Key。')
  if (/[\r\n]/.test(token)) throw Error('API Key 中不能包含换行。')
  return {
    id: typeof input.id === 'string' ? input.id : '',
    name:
      String(input.name || '')
        .trim()
        .slice(0, 80) || (provider === 'relay' ? '中转站账户' : 'NovelAI 账户'),
    provider,
    token,
    imageBase: provider === 'relay' ? normalizeBase(input.imageBase, true) : '',
    accountBase: provider === 'relay' ? normalizeBase(input.accountBase) : '',
  }
}

export function readProfiles() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}')
    const profiles = Array.isArray(saved.profiles)
      ? saved.profiles.flatMap((item) => {
          try {
            const profile = normalizeProfile(item)
            return profile.id ? [profile] : []
          } catch {
            return []
          }
        })
      : []
    return {
      profiles,
      activeId: profiles.some((p) => p.id === saved.activeId) ? saved.activeId : null,
      allowEnvironment: !Object.hasOwn(saved, 'activeId'),
    }
  } catch {
    return { profiles: [], activeId: null, allowEnvironment: true }
  }
}

export function writeProfiles(profiles, activeId) {
  try {
    localStorage.setItem(storageKey, JSON.stringify({ profiles, activeId }))
  } catch {
    throw Error('浏览器未能保存账户，请检查本地存储权限。')
  }
}

export function profileHeaders(profile) {
  const headers = {}
  if (profile?.token) headers.Authorization = 'Bearer ' + profile.token
  if (profile?.provider === 'relay') {
    headers['X-NAI-Provider'] = 'relay'
    headers['X-NAI-Image-Base'] = profile.imageBase
    if (profile.accountBase) headers['X-NAI-Account-Base'] = profile.accountBase
  }
  return headers
}
