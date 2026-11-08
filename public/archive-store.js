import { pruneLineage } from './lineage-core.js';
import { parseWorkTags } from './archive-tags.js';
import { classifyWorkNSFW, NSFW_RULES_VERSION } from './nsfw-tags.js';
let opening;
const unsavedRatings = new Map();
function withSavedRating(work) {
  const tags = unsavedRatings.get(work?.id);
  return tags ? { ...work, sourceNsfwTags: tags } : work;
}

// An old pixel edit can have an empty caption. Follow only direct editing
// parents, in order, so an upscale of a Director Tools result inherits both.
function upgradeEditRatings(works, parents, traces) {
  const changed = new Map(), visited = new Set();
  for (const id of parents.keys()) {
    const path = [], ancestors = new Set();
    let cursor = id;
    while (parents.has(cursor) && !visited.has(cursor) && !ancestors.has(cursor)) {
      ancestors.add(cursor);
      path.push(cursor);
      cursor = parents.get(cursor);
    }
    for (const child of path.reverse()) {
      visited.add(child);
      if (ancestors.has(cursor)) continue; // Malformed cyclic lineage is not evidence.
      const sourceId = parents.get(child), trace = traces.get(sourceId);
      const source = works.get(sourceId) || (trace?.external && trace);
      const work = works.get(child);
      if (!work || !source) continue;
      const previous = Array.isArray(work.sourceNsfwTags) ? work.sourceNsfwTags : [];
      const added = classifyWorkNSFW(source).matches.filter(tag => !previous.includes(tag));
      if (!added.length) continue;
      work.sourceNsfwTags = [...previous, ...added];
      changed.set(child, work);
    }
  }
  return changed;
}

function migrateEditRatings(db) {
  return new Promise(resolve => {
    const txn = db.transaction(['works', 'lineage', 'recipes'], 'readwrite');
    const recipes = txn.objectStore('recipes'), works = txn.objectStore('works');
    const key = 'folio.content.edit-rules', version = recipes.get(key);
    txn.oncomplete = () => { unsavedRatings.clear(); resolve(); };
    // The gallery can still use this session's merged ratings if storage is full.
    txn.onabort = () => resolve();
    version.onsuccess = () => {
      if (version.result >= NSFW_RULES_VERSION) return;
      const rows = txn.objectStore('lineage').getAll();
      rows.onsuccess = () => {
        const traces = new Map(rows.result.map(row => [row.id, row]));
        const parents = new Map();
        for (const row of rows.result) {
          if (!['upscale', 'augment'].includes(row.mode || row.settings?.mode)) continue;
          const edge = row.edges?.find(e => e.type === 'edit' && e.target === row.id && e.source !== row.id);
          if (edge) parents.set(row.id, edge.source);
        }
        const ids = new Set([...parents.keys(), ...parents.values()]);
        if (!ids.size) { recipes.put(NSFW_RULES_VERSION, key); return; }
        const related = new Map();
        for (const id of ids) {
          const read = works.get(id);
          read.onsuccess = () => {
            related.set(id, read.result);
            if (related.size !== ids.size) return;
            for (const [workId, work] of upgradeEditRatings(related, parents, traces)) {
              unsavedRatings.set(workId, work.sourceNsfwTags);
              works.put(work);
            }
            recipes.put(NSFW_RULES_VERSION, key);
          };
        }
      };
    };
  });
}
function database() {
  return (opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('nai-folio', 3);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('works'))
        request.result.createObjectStore('works', { keyPath: 'id' });
      if (!request.result.objectStoreNames.contains('recipes')) request.result.createObjectStore('recipes');
      if (!request.result.objectStoreNames.contains('lineage'))
        request.result.createObjectStore('lineage', { keyPath: 'id' });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => migrateEditRatings(request.result).then(() => resolve(request.result), reject);
  }));
}
export async function listWorks() {
  const db = await database();
  return new Promise((resolve, reject) => {
    const req = db.transaction('works').objectStore('works').getAll();
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result.map(withSavedRating).sort((a, b) => b.created - a.created || a.sequence - b.sequence));
  });
}
export async function getWork(id) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction('works').objectStore('works').get(id);
    request.onsuccess = () => resolve(withSavedRating(request.result));
    request.onerror = () => reject(request.error);
  });
}

// Merge the score into the latest stored image, so a rating never overwrites
// a recipe, lineage change or other metadata read by an earlier gallery view.
export async function setWorkScore(id, score) {
  if (score !== null && (!Number.isInteger(score) || score < 0 || score > 5))
    throw new RangeError('评分应为 0–5 的整数，或清除评分。');
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('works', 'readwrite'),
      store = transaction.objectStore('works');
    let updated, failure;
    const request = store.get(id);
    request.onsuccess = () => {
      if (!request.result) {
        failure = Error('这张作品已被移除，无法保存评分。');
        transaction.abort();
        return;
      }
      try {
        updated = { ...request.result };
        if (score === null) {
          delete updated.score;
          delete updated.scoreUpdated;
        } else {
          updated.score = score;
          updated.scoreUpdated = Date.now();
        }
        store.put(updated);
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
    transaction.oncomplete = () => resolve(updated);
    transaction.onerror = transaction.onabort = () =>
      reject(failure || transaction.error || Error('评分暂时无法保存。'));
  });
}
export async function addWorkTags(ids, input) {
  const targets = [...new Set(ids)];
  const tags = parseWorkTags(input);
  if (!targets.length) throw Error('请先选择作品。');
  if (!tags.length) throw Error('请至少输入一个标签。');
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('works', 'readwrite');
    const store = transaction.objectStore('works');
    const updated = [];
    let failure;
    transaction.oncomplete = () => resolve(updated);
    transaction.onabort = () => reject(failure || transaction.error || Error('暂时无法保存作品标签。'));

    // Read one original at a time so a large selection never queues all its blobs in JS.
    function updateNext() {
      const id = targets[updated.length];
      const request = store.get(id);
      request.onsuccess = () => {
        const work = request.result;
        if (!work) {
          failure = Error('所选作品中有图片已被移除，请重新选择。');
          transaction.abort();
          return;
        }
        const previous = work.galleryTags || [];
        const galleryTags = parseWorkTags([...previous, ...tags]);
        updated.push({ id, galleryTags });
        const changed = galleryTags.length !== previous.length || galleryTags.some((tag, i) => tag !== previous[i]);
        const next = () => {
          if (updated.length < targets.length) updateNext();
        };
        if (changed) {
          work.galleryTags = galleryTags;
          store.put(work).onsuccess = next;
        } else next();
      };
    }
    updateNext();
  });
}

export async function loadRecipe(key) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const req = db.transaction('recipes').objectStore('recipes').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function listLineage() {
  const db = await database();
  return new Promise((resolve, reject) => {
    const req = db.transaction('lineage').objectStore('lineage').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function writeDraft(recipe) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const t = db.transaction('recipes', 'readwrite');
    t.objectStore('recipes').put(recipe, 'draft');
    t.oncomplete = resolve;
    t.onerror = t.onabort = () => reject(t.error);
  });
}
export async function writeWorks(records, removeId, recipe, removeRecipe, lineage = []) {
  if (removeId) return removeWork(removeId);
  const db = await database();
  return new Promise((resolve, reject) => {
    const txn = db.transaction(['works', 'recipes', 'lineage'], 'readwrite'),
      store = txn.objectStore('works'),
      recipes = txn.objectStore('recipes');
    if (removeId) store.delete(removeId);
    else records.forEach((record) => store.put(record));
    if (recipe && records.length) recipes.put(recipe, records[0].recipeId);
    if (removeRecipe) recipes.delete(removeRecipe);
    if (lineage.length) {
      const traces = txn.objectStore('lineage');
      // Resolve source validity inside the same transaction as the generated work.
      // A queued deletion may have committed after the request captured its parents.
      const liveKeys = store.getAllKeys(),
        savedTraces = traces.getAll();
      let keys, saved;
      const persist = () => {
        if (!keys || !saved) return;
        const live = new Set(keys),
          combined = new Map(saved.map((node) => [node.id, node]));
        for (const node of lineage) {
          if (!live.has(node.id) && !node.external) continue;
          const old = combined.get(node.id);
          const edges = new Map([...(old?.edges || []), ...(node.edges || [])].map((edge) => [edge.id, edge]));
          combined.set(node.id, { ...node, edges: [...edges.values()] });
        }
        const allowed = new Set([
          ...live,
          ...[...combined.values()].filter((node) => node.external).map((node) => node.id),
        ]);
        for (const node of combined.values()) {
          if (!allowed.has(node.id)) {
            traces.delete(node.id);
            continue;
          }
          traces.put({
            ...node,
            edges: (node.edges || []).filter((edge) => allowed.has(edge.source) && allowed.has(edge.target)),
          });
        }
      };
      liveKeys.onsuccess = () => {
        keys = liveKeys.result;
        persist();
      };
      savedTraces.onsuccess = () => {
        saved = savedTraces.result;
        persist();
      };
    }
    txn.oncomplete = resolve;
    txn.onabort = txn.onerror = () => reject(txn.error);
  });
}

// Read and remove together so images from the same batch retain their shared recipe.
export async function removeWork(id) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const txn = db.transaction(['works', 'recipes', 'lineage'], 'readwrite');
    const store = txn.objectStore('works');
    const recipes = txn.objectStore('recipes');
    const traces = txn.objectStore('lineage');
    const draft = recipes.get('draft');
    draft.onsuccess = () => {
      if (!draft.result) return;
      const saved = draft.result;
      saved.lineageReuse = (saved.lineageReuse || []).filter((entry) => entry.id !== id);
      if (saved.settings?.source?.origin?.workId === id) delete saved.settings.source.origin;
      recipes.put(saved, 'draft');
    };
    let snapshot = null;
    const traceSnapshot = [];
    const allTraces = traces.getAll();
    allTraces.onsuccess = () => {
      const cleaned = new Map(pruneLineage(allTraces.result, [id]).map((node) => [node.id, node]));
      for (const node of allTraces.result) {
        const next = cleaned.get(node.id);
        if (node.id === id || node.edges?.some((edge) => edge.source === id || edge.target === id)) {
          traceSnapshot.push(node);
          if (next) traces.put(next);
          else traces.delete(node.id);
        }
      }
    };
    const all = store.getAll();
    all.onsuccess = () => {
      const work = all.result.find((item) => item.id === id);
      if (!work) return;
      snapshot = { work, recipe: undefined, lineage: traceSnapshot };
      store.delete(id);
      if (work.recipeId) {
        const original = recipes.get(work.recipeId);
        original.onsuccess = () => {
          snapshot.recipe = original.result;
        };
        if (!all.result.some((item) => item.id !== id && item.recipeId === work.recipeId))
          recipes.delete(work.recipeId);
      }
    };
    txn.oncomplete = () => resolve(snapshot);
    txn.onabort = txn.onerror = () => reject(txn.error);
  });
}

export async function restoreWorks(snapshots) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const txn = db.transaction(['works', 'recipes', 'lineage'], 'readwrite');
    for (const { work, recipe } of snapshots) {
      txn.objectStore('works').put(work);
      if (work.recipeId && recipe !== undefined) txn.objectStore('recipes').put(recipe, work.recipeId);
    }
    const traces = txn.objectStore('lineage');
    const all = traces.getAll();
    all.onsuccess = () => {
      const merged = new Map(all.result.map((node) => [node.id, node]));
      for (const snapshot of snapshots)
        for (const node of snapshot.lineage || []) {
          const existing = merged.get(node.id);
          const edges = new Map(
            [...(existing?.edges || []), ...(node.edges || [])].map((edge) => [edge.id, edge]),
          );
          merged.set(node.id, { ...node, ...existing, edges: [...edges.values()] });
        }
      for (const node of merged.values()) traces.put(node);
    };
    txn.oncomplete = resolve;
    txn.onabort = txn.onerror = () => reject(txn.error);
  });
}
