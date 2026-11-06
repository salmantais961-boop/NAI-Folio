import { listChunks, readChunks, watchChunks, saveChunk, removeChunk, updateChunkLink } from './chunks.js';

export const ATLAS_TYPES = Object.freeze({ material: '素材', oc: 'OC', example: '例图' });
export const DEFAULT_CATEGORIES = Object.freeze(Object.values(ATLAS_TYPES));
const events = new EventTarget();
const channel =
  typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('nai-folio-atlas')
    : null;
let opening,
  queue = Promise.resolve(),
  synchronizing,
  mutingChunks = false,
  syncTimer;
const clone = (value) => structuredClone(value);
const clean = (value) => String(value ?? '').trim();

export function atlasTags(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(/[,，\n]+/u);
  const seen = new Set();
  return values
    .map(clean)
    .filter((tag) => {
      if (!tag || tag.length > 80 || seen.has(tag.toLocaleLowerCase())) return false;
      seen.add(tag.toLocaleLowerCase());
      return true;
    })
    .slice(0, 64);
}
export function normalizeAtlasEntry(data, previous = {}) {
  const entry = { ...previous, ...data };
  entry.type = entry.type || 'material';
  if (!Object.hasOwn(ATLAS_TYPES, entry.type)) throw Error('请选择素材、OC 或例图类型。');
  entry.name = clean(entry.name);
  if (!entry.name || entry.name.length > (entry.type === 'oc' ? 55 : 60))
    throw Error(entry.type === 'oc' ? 'OC 名称应为 1–55 个字符。' : '名称应为 1–60 个字符。');
  if (/[!\r\n]/u.test(entry.name)) throw Error('名称不能包含换行或感叹号。');
  entry.category = clean(entry.category) || ATLAS_TYPES[entry.type];
  if (entry.category.length > 30) throw Error('分类名最多 30 个字符。');
  entry.prompt = clean(entry.prompt);
  if (entry.prompt.length > 100000) throw Error('提示词不能超过 100,000 个字符。');
  if (entry.type !== 'material' && !entry.prompt) throw Error('请填写 OC 外貌或例图的固定提示词。');
  entry.tags = atlasTags(entry.tags);
  entry.id ||= crypto.randomUUID();
  entry.created = Number(previous.created || entry.created) || Date.now();
  entry.updated = Date.now();
  if (entry.blob != null && !(entry.blob instanceof Blob)) throw Error('请选择有效的图像文件。');
  entry.blob ??= null;
  return entry;
}

function database() {
  return (opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('nai-folio-atlas', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('entries', { keyPath: 'id' });
      db.createObjectStore('categories', { keyPath: 'name' });
      db.createObjectStore('meta');
    };
    request.onerror = () => {
      opening = null;
      reject(request.error);
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        opening = null;
      };
      resolve(request.result);
    };
  }));
}
function mutate(task) {
  const result = queue.then(task, task);
  queue = result.catch(() => {});
  return result;
}
function withMutedChunks(task) {
  const previous = mutingChunks;
  mutingChunks = true;
  try {
    return task();
  } finally {
    mutingChunks = previous;
  }
}
async function read(store, key) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const object = db.transaction(store).objectStore(store);
    const request = key === undefined ? object.getAll() : object.get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function changed(detail = {}, broadcast = true) {
  events.dispatchEvent(new CustomEvent('change', { detail }));
  if (broadcast) channel?.postMessage(detail);
}
channel?.addEventListener('message', (event) => changed(event.data, false));
export function watchAtlas(fn) {
  events.addEventListener('change', fn);
  return () => events.removeEventListener('change', fn);
}
export const getEntry = (id) => read('entries', id);

async function imageInfo(blob) {
  if (blob == null) return { blob: null, width: undefined, height: undefined };
  if (!(blob instanceof Blob) || !blob.size || blob.size > 96 * 1024 * 1024)
    throw Error('请选择 96 MB 以内的图像。');
  let image;
  try {
    image = await createImageBitmap(blob);
  } catch {
    throw Error('无法读取这张图片，请使用 PNG、JPG、WebP 或浏览器支持的图像格式。');
  }
  const { width, height } = image;
  image.close();
  if (!width || !height || width * height > 64_000_000)
    throw Error('图片尺寸过大，请使用 6400 万像素以内的图像。');
  return { blob, width, height };
}
async function putEntry(entry, prepare) {
  const db = await database();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(['entries', 'categories', 'meta'], 'readwrite');
    let failure;
    const fail = (error) => {
      failure = error;
      transaction.abort();
    };
    transaction.oncomplete = resolve;
    transaction.onerror = transaction.onabort = () =>
      reject(failure || transaction.error || Error('无法保存条目。'));
    // Wait until this transaction owns the write lock before publishing the
    // chunk change. Other tabs cannot reconcile a half-restored suppressed ID.
    const entries = transaction.objectStore('entries'),
      ready = entries.get(entry.id);
    ready.onsuccess = () => {
      try {
        prepare?.();
        entries.put(entry);
        if (!DEFAULT_CATEGORIES.includes(entry.category))
          transaction.objectStore('categories').put({ name: entry.category, created: Date.now() });
        const meta = transaction.objectStore('meta'),
          request = meta.get('suppressed');
        request.onsuccess = () => {
          try {
            if (entry.chunkId && request.result?.includes(entry.chunkId))
              meta.put(
                request.result.filter((id) => id !== entry.chunkId),
                'suppressed',
              );
          } catch (error) {
            fail(error);
          }
        };
      } catch (error) {
        fail(error);
      }
    };
  });
}
async function persistEntry(data, restoredChunk) {
  const previous = data.id ? await getEntry(data.id) : undefined;
  const entry = normalizeAtlasEntry(data, previous);
  if (Object.hasOwn(data, 'blob') && data.blob !== previous?.blob)
    Object.assign(entry, await imageInfo(data.blob));
  let beforeChunk, writtenChunk;
  const prepareChunk = () => {
    if (entry.type === 'material') return;
    const linked = readChunks().find((chunk) => chunk.id === entry.chunkId || chunk.atlasId === entry.id);
    if (
      restoredChunk &&
      linked &&
      (linked.id !== restoredChunk.id ||
        linked.name !== restoredChunk.name ||
        linked.text !== restoredChunk.text)
    )
      throw Error('关联词块刚被更新，未覆盖新内容；请刷新后再撤销。');
    beforeChunk = linked && clone(linked);
    const name = entry.type === 'oc' ? 'OC · ' + entry.name : entry.name;
    withMutedChunks(() => {
      saveChunk(linked?.name || '', {
        id: linked?.id || entry.chunkId,
        atlasId: entry.id,
        kind: entry.type,
        name,
        text: entry.prompt,
        category: restoredChunk?.category || linked?.category || entry.category,
      });
    });
    const chunk = listChunks().find((chunk) => chunk.name === name);
    writtenChunk = clone(chunk);
    entry.chunkId = chunk.id;
    entry.chunkName = chunk.name;
  };
  try {
    await putEntry(entry, prepareChunk);
  } catch (error) {
    if (writtenChunk) {
      try {
        withMutedChunks(() => {
          const current = readChunks().find((chunk) => chunk.id === writtenChunk.id);
          // Never overwrite a newer edit or a replacement with the same name.
          if (!current || current.name !== writtenChunk.name || current.text !== writtenChunk.text) return;
          if (beforeChunk) saveChunk(current.name, beforeChunk);
          else removeChunk(current.name, current.id, writtenChunk.text);
        });
      } catch (restoreError) {
        throw new Error('条目未保存，词块同步恢复失败，请重试保存。', { cause: restoreError });
      }
    }
    throw error;
  }
  changed({ type: 'save', ids: [entry.id] });
  return clone(entry);
}
export function saveEntry(data) {
  return mutate(() => persistEntry(data));
}

export function ensureChunkEntries() {
  if (synchronizing) return synchronizing;
  synchronizing = mutate(async () => {
    const db = await database(),
      updates = [];
    const result = await new Promise((resolve, reject) => {
      // One write transaction prevents an older reconciliation snapshot from
      // overwriting an image or a restored entry committed by another tab.
      const transaction = db.transaction(['entries', 'meta'], 'readwrite');
      const store = transaction.objectStore('entries'),
        entriesRequest = store.getAll();
      const suppressedRequest = transaction.objectStore('meta').get('suppressed');
      let entriesReady = false,
        suppressedReady = false,
        result,
        failure;
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = transaction.onabort = () =>
        reject(failure || transaction.error || Error('词块同步失败，请稍后重试。'));
      function reconcile() {
        if (!entriesReady || !suppressedReady) return;
        try {
          const entries = entriesRequest.result,
            blocked = new Set(suppressedRequest.result || []);
          const byChunk = new Map(
            entries.filter((entry) => entry.chunkId).map((entry) => [entry.chunkId, entry]),
          );
          const byId = new Map(entries.map((entry) => [entry.id, entry]));
          const links = [];
          // Earlier versions hid the entry but left its block active. Retire
          // only those exact IDs, never a newly created same-name replacement.
          withMutedChunks(() => {
            for (const chunk of readChunks())
              if (blocked.has(chunk.id) && !byChunk.has(chunk.id))
                removeChunk(chunk.name, chunk.id, chunk.text);
          });
          for (const chunk of listChunks()) {
            if (!chunk.id || blocked.has(chunk.id)) continue;
            const previous = byChunk.get(chunk.id) || byId.get(chunk.atlasId);
            const type = chunk.kind === 'oc' || previous?.type === 'oc' ? 'oc' : 'example';
            const name = type === 'oc' ? chunk.name.replace(/^OC · /u, '') : chunk.name;
            const entry = previous
              ? { ...previous, name, prompt: chunk.text, chunkName: chunk.name, chunkId: chunk.id }
              : {
                  id: chunk.atlasId || 'chunk:' + chunk.id,
                  type,
                  name,
                  prompt: chunk.text,
                  category: ATLAS_TYPES[type],
                  tags: [],
                  blob: null,
                  chunkId: chunk.id,
                  chunkName: chunk.name,
                  created: Date.now(),
                  updated: Date.now(),
                };
            if (
              !previous ||
              previous.name !== name ||
              previous.prompt !== chunk.text ||
              previous.chunkName !== chunk.name
            ) {
              entry.updated = Date.now();
              updates.push(entry);
              store.put(entry);
            }
            byId.set(entry.id, entry);
            if (chunk.atlasId !== entry.id || chunk.kind !== type)
              links.push({ id: chunk.id, atlasId: entry.id, kind: type });
          }
          withMutedChunks(() => {
            for (const { id, ...link } of links) updateChunkLink(id, link);
          });
          result = [...byId.values()].sort((a, b) => b.updated - a.updated);
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      }
      entriesRequest.onsuccess = () => {
        entriesReady = true;
        reconcile();
      };
      suppressedRequest.onsuccess = () => {
        suppressedReady = true;
        reconcile();
      };
    });
    if (updates.length) changed({ type: 'chunks', ids: updates.map((entry) => entry.id) });
    return result;
  }).finally(() => {
    synchronizing = null;
  });
  return synchronizing;
}
watchChunks(() => {
  if (mutingChunks || typeof indexedDB === 'undefined') return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    void ensureChunkEntries().catch(() => {});
  }, 30);
});
export async function listEntries() {
  return ensureChunkEntries();
}

export function deleteEntry(id) {
  return mutate(async () => {
    const db = await database();
    let snapshot,
      removedChunk = false;
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(['entries', 'meta'], 'readwrite');
        const entries = transaction.objectStore('entries'),
          meta = transaction.objectStore('meta');
        let failure;
        const fail = (error) => {
          failure = error;
          transaction.abort();
        };
        const request = entries.get(id);
        request.onsuccess = () => {
          const entry = request.result;
          if (!entry) return;
          try {
            const chunk = entry.chunkId && readChunks().find((item) => item.id === entry.chunkId);
            snapshot = { entry: clone(entry), chunk: chunk ? clone(chunk) : null };
            if (chunk) {
              removedChunk = withMutedChunks(() => removeChunk(chunk.name, chunk.id, chunk.text));
              if (!removedChunk) throw Error('关联词块已在其他窗口更改，请刷新后重试。');
            }
            entries.delete(id);
            if (entry.chunkId) {
              const suppressed = meta.get('suppressed');
              suppressed.onsuccess = () => {
                try {
                  meta.put([...new Set([...(suppressed.result || []), entry.chunkId])], 'suppressed');
                } catch (error) {
                  fail(error);
                }
              };
            }
          } catch (error) {
            fail(error);
          }
        };
        transaction.oncomplete = resolve;
        transaction.onerror = transaction.onabort = () =>
          reject(failure || transaction.error || Error('无法移除条目。'));
      });
    } catch (error) {
      if (removedChunk && snapshot?.chunk) {
        try {
          const original = snapshot.chunk;
          withMutedChunks(() => {
            const active = readChunks();
            if (active.some((chunk) => chunk.id === original.id)) return;
            if (active.some((chunk) => chunk.name === original.name))
              throw Error('同名词块已经存在，未覆盖新内容。');
            saveChunk('', original);
          });
        } catch (restoreError) {
          throw new Error('条目未删除，关联词块恢复失败；原提示词正文仍保留，请重试。', {
            cause: restoreError,
          });
        }
      }
      throw error;
    }
    changed({ type: 'delete', ids: [id] });
    return snapshot;
  });
}
export function restoreEntry(snapshot) {
  return mutate(async () => {
    if (!snapshot?.entry?.id) throw Error('这次移除已无法撤销。');
    const current = await getEntry(snapshot.entry.id);
    if (current) return current;
    const entry = clone(snapshot.entry),
      chunk = snapshot.chunk;
    if (chunk) {
      const active = readChunks().find((item) => item.id === chunk.id || item.name === chunk.name);
      if (active && (active.id !== chunk.id || active.name !== chunk.name || active.text !== chunk.text))
        throw Error('已有新建或更新的同名词块，未覆盖它；请先更名该词块后再撤销。');
      entry.chunkId = chunk.id;
      entry.chunkName = chunk.name;
      entry.name = entry.type === 'oc' ? chunk.name.replace(/^OC · /u, '') : chunk.name;
      entry.prompt = chunk.text;
    }
    return persistEntry(entry, chunk);
  });
}
export function setEntryImage(id, blob, { origin = 'manual', workId } = {}) {
  return mutate(async () => {
    const image = await imageInfo(blob),
      db = await database();
    const entry = await new Promise((resolve, reject) => {
      const transaction = db.transaction('entries', 'readwrite'),
        store = transaction.objectStore('entries');
      let saved;
      const request = store.get(id);
      request.onsuccess = () => {
        if (!request.result) {
          transaction.abort();
          return;
        }
        saved = {
          ...request.result,
          ...image,
          imageOrigin: origin,
          sourceWorkId: workId || undefined,
          updated: Date.now(),
        };
        store.put(saved);
      };
      transaction.oncomplete = () => resolve(saved);
      transaction.onerror = transaction.onabort = () =>
        reject(transaction.error || Error('这条收藏已被移除。'));
    });
    changed({ type: 'image', ids: [id] });
    return clone(entry);
  });
}
export function adoptWork(work, options = {}) {
  if (!(work?.blob instanceof Blob)) return Promise.reject(Error('这张作品没有可收藏的图像。'));
  return saveEntry({
    type: 'material',
    name: (work.prompt || work.filename || '未命名收藏').slice(0, 45),
    prompt: work.prompt || '',
    blob: work.blob,
    width: work.width,
    height: work.height,
    imageOrigin: 'manual',
    sourceWorkId: work.id,
    ...options,
  });
}
export function captureGenerated(work, usageIds) {
  const ids = [...new Set((usageIds || []).filter((id) => typeof id === 'string'))];
  if (!ids.length || !(work?.blob instanceof Blob)) return Promise.resolve([]);
  return mutate(async () => {
    const image = await imageInfo(work.blob),
      db = await database(),
      captured = [];
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('entries', 'readwrite'),
        store = transaction.objectStore('entries');
      for (const id of ids) {
        const request = store.get(id);
        request.onsuccess = () => {
          const entry = request.result;
          if (!entry || entry.blob || !['oc', 'example'].includes(entry.type)) return;
          const saved = {
            ...entry,
            ...image,
            imageOrigin: 'generated',
            sourceWorkId: work.id,
            updated: Date.now(),
          };
          store.put(saved);
          captured.push(saved);
        };
      }
      transaction.oncomplete = resolve;
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
    if (captured.length) changed({ type: 'capture', ids: captured.map((entry) => entry.id) });
    return captured;
  });
}

export async function listCategories() {
  const saved = await read('categories');
  return [
    ...DEFAULT_CATEGORIES.map((name) => ({ name, fixed: true })),
    ...saved
      .filter((item) => !DEFAULT_CATEGORIES.includes(item.name))
      .sort((a, b) => a.name.localeCompare(b.name)),
  ];
}
export function saveCategory(name, previousName) {
  return mutate(async () => {
    name = clean(name);
    if (!name || name.length > 30) throw Error('分类名称应为 1–30 个字符。');
    if (previousName && DEFAULT_CATEGORIES.includes(previousName)) throw Error('基础分类名称固定。');
    const db = await database();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(['categories', 'entries'], 'readwrite');
      const categories = transaction.objectStore('categories');
      if (!DEFAULT_CATEGORIES.includes(name)) categories.put({ name, created: Date.now() });
      if (previousName && previousName !== name) {
        categories.delete(previousName);
        const request = transaction.objectStore('entries').getAll();
        request.onsuccess = () =>
          request.result
            .filter((entry) => entry.category === previousName)
            .forEach((entry) =>
              transaction.objectStore('entries').put({ ...entry, category: name, updated: Date.now() }),
            );
      }
      transaction.oncomplete = resolve;
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
    changed({ type: 'categories' });
    return { name, fixed: DEFAULT_CATEGORIES.includes(name) };
  });
}
export function deleteCategory(name) {
  return mutate(async () => {
    if (DEFAULT_CATEGORIES.includes(name)) throw Error('基础分类不可删除。');
    const db = await database();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(['categories', 'entries'], 'readwrite');
      transaction.objectStore('categories').delete(name);
      const entries = transaction.objectStore('entries'),
        request = entries.getAll();
      request.onsuccess = () =>
        request.result
          .filter((entry) => entry.category === name)
          .forEach((entry) =>
            entries.put({ ...entry, category: ATLAS_TYPES[entry.type], updated: Date.now() }),
          );
      transaction.oncomplete = resolve;
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
    changed({ type: 'categories' });
  });
}
