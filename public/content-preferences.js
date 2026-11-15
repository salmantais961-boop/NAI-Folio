function readPreference(key) {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function preference(key, eventName, property) {
  let value = readPreference(key)
  function update(next) {
    if (next === value) return
    value = next
    window.dispatchEvent(new CustomEvent(eventName, { detail: { [property]: value } }))
  }
  globalThis.window?.addEventListener('storage', (event) => {
    if (event.key === key || event.key === null) update(readPreference(key))
  })
  return {
    get: () => value,
    set(next) {
      update(Boolean(next))
      try {
        localStorage.setItem(key, next ? '1' : '0')
        return true
      } catch {
        return false
      }
    },
  }
}

export const { get: getHideNSFW, set: setHideNSFW } =
  preference('folio.content.hide-nsfw', 'folio:content-preferences', 'hideNSFW')
export const { get: getShowOpening, set: setShowOpening } =
  preference('folio.show-opening', 'folio:opening-preference', 'showOpening')
export const { get: getShowHeaderUsage, set: setShowHeaderUsage } =
  preference('folio.show-header-usage', 'folio:header-usage-preference', 'showHeaderUsage')

// Desktop shell only: what the window's close button does.
const CLOSE_ACTION_KEY = 'folio.close-action'
export function getCloseAction() {
  try {
    return localStorage.getItem(CLOSE_ACTION_KEY) === 'tray' ? 'tray' : 'quit'
  } catch {
    return 'quit'
  }
}
export function setCloseAction(action) {
  const value = action === 'tray' ? 'tray' : 'quit'
  try {
    localStorage.setItem(CLOSE_ACTION_KEY, value)
  } catch {
    return false
  }
  window.dispatchEvent(new CustomEvent('folio:close-action', { detail: { action: value } }))
  return true
}
export function isDesktopShell() {
  try {
    return Boolean(window.__FOLIO_DESKTOP__ || (window.parent !== window && window.parent.__FOLIO_DESKTOP__))
  } catch {
    return false
  }
}
