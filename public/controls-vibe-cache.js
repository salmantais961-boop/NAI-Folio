let database
// The store contains only image encodings. Keep API credentials out of persistent storage.
function db() {
  if (!database)
    database = new Promise((resolve, reject) => {
      const req = indexedDB.open('folio-vibe-cache', 1)
      req.onupgradeneeded = () => req.result.createObjectStore('encodings', { keyPath: 'key' })
      req.onsuccess = () => {
        req.result.onversionchange = () => {
          req.result.close()
          database = null
        }
        resolve(req.result)
      }
      req.onerror = () => reject(req.error)
    }).catch((err) => {
      database = null
      throw err
    })
  return database
}
export function encodingKey(ref, model) {
  const base = model + '@' + ref.information
  return ref.mask ? base + '#' + ref.maskId + '.' + (ref.cropToMask ? 1 : 0) : base
}
export async function cacheId(data) {
  const blob = await (await fetch(data)).blob()
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}
export async function recall(ref) {
  if (ref.kind !== 'vibe' || !ref.data) return
  ref.cacheId = await cacheId(ref.data)
  const prefix = ref.cacheId + '/',
    store = (await db()).transaction('encodings').objectStore('encodings')
  const req = store.getAll(IDBKeyRange.bound(prefix, prefix + '\uffff'))
  const rows = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  rows.forEach((row) => {
    ref.encodings[row.key.slice(prefix.length)] = row.encoding
  })
}
export async function remember(ref, modelKey, encoding) {
  if (!ref.cacheId) ref.cacheId = await cacheId(ref.data)
  const tr = (await db()).transaction('encodings', 'readwrite')
  tr.objectStore('encodings').put({ key: ref.cacheId + '/' + modelKey, encoding })
  await new Promise((resolve, reject) => {
    tr.oncomplete = resolve
    tr.onerror = () => reject(tr.error)
    tr.onabort = () => reject(tr.error)
  })
}
