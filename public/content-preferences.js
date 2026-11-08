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
