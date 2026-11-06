import { pruneLineage } from './lineage-core.js';
let opening;
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
    request.onsuccess = () => resolve(request.result);
  }));
}
export async function listWorks() {
  const db = await database();
  return new Promise((resolve, reject) => {
    const req = db.transaction('works').objectStore('works').getAll();
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result.sort((a, b) => b.created - a.created || a.sequence - b.sequence));
  });
}
export async function getWork(id) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction('works').objectStore('works').get(id);
    request.onsuccess = () => resolve(request.result);
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
