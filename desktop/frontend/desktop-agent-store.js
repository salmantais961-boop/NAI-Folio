// Keep conversations in the desktop WebView's own storage. A completed turn and its
// image references survive screen changes without storing a second copy of an image.
let opening;
function database() {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const request = indexedDB.open('folio-desktop-agent', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('threads', { keyPath: 'id' });
        db.createObjectStore('turns', { keyPath: 'id' }).createIndex('thread', 'threadId');
        db.createObjectStore('settings');
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          opening = null;
        };
        resolve(db);
      };
    }).catch((error) => {
      opening = null;
      throw error;
    });
  }
  return opening;
}

async function read(store, query) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = query(db.transaction(store).objectStore(store));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function write(stores, change) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite');
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || Error('无法保存到本地工作区。'));
    change(tx);
  });
}
export function getPreferences() {
  return read('settings', (store) => store.get('connections'));
}
export function savePreferences(value) {
  return write('settings', (tx) => tx.objectStore('settings').put(value, 'connections'));
}
export async function listThreads() {
  const items = await read('threads', (store) => store.getAll());
  return items.sort((a, b) => b.updated - a.updated);
}
export const getThread = (id) => read('threads', (store) => store.get(id));
export async function getTurns(id) {
  const turns = await read('turns', (store) => store.index('thread').getAll(id));
  return turns.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
}
export function emptyThread() {
  const time = Date.now();
  return { id: crypto.randomUUID(), title: '', created: time, updated: time, locks: [], draft: '' };
}
export async function newThread(thread = emptyThread()) {
  await write('threads', (tx) => tx.objectStore('threads').add(thread));
  return thread;
}
export function editThread(id, changes) {
  return write('threads', (tx) => {
    const store = tx.objectStore('threads');
    const req = store.get(id);
    req.onsuccess = () => {
      if (req.result) store.put({ ...req.result, ...changes });
    };
  });
}
export function deleteThread(id) {
  return write(['threads', 'turns'], (tx) => {
    tx.objectStore('threads').delete(id);
    const request = tx.objectStore('turns').index('thread').openCursor(id);
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
  });
}
export function startTurn(turn) {
  return write(['turns', 'threads'], (tx) => {
    const threads = tx.objectStore('threads'),
      request = threads.get(turn.threadId);
    request.onsuccess = () => {
      const thread = request.result;
      if (!thread) {
        tx.abort();
        return;
      }
      thread.title ||= Array.from(turn.text.replace(/\s+/g, ' ').trim()).slice(0, 32).join('');
      thread.updated = turn.created;
      thread.draft = '';
      threads.put(thread);
      tx.objectStore('turns').add(turn);
    };
  });
}
// Regenerating an earlier answer gets its own continuation. Commit the visible
// history and new question together so deleting or interrupting a branch is safe.
export async function startBranch(parentId, branch, prefix, turn) {
  const copied = prefix.map((row) => ({ ...row, id: crypto.randomUUID(), threadId: branch.id }));
  await write(['threads', 'turns'], (tx) => {
    const threads = tx.objectStore('threads');
    const parent = threads.get(parentId);
    parent.onsuccess = () => {
      if (!parent.result) {
        tx.abort();
        return;
      }
      threads.add(branch);
      const history = tx.objectStore('turns');
      for (const row of copied) history.add(row);
      history.add(turn);
    };
  });
  return copied;
}
export function finishTurn(turn) {
  return write(['threads', 'turns'], (tx) => {
    const threads = tx.objectStore('threads'),
      request = threads.get(turn.threadId);
    request.onsuccess = () => {
      // A history entry may have been removed in another window during an API call.
      if (!request.result) return;
      threads.put({ ...request.result, updated: Date.now() });
      tx.objectStore('turns').put(turn);
    };
  });
}

export function checkpointTools(turnId, tools) {
  const rows = structuredClone(tools);
  return write('turns', (tx) => {
    const turns = tx.objectStore('turns');
    const request = turns.get(turnId);
    request.onsuccess = () => {
      if (request.result?.state === 'pending') turns.put({ ...request.result, tools: rows });
    };
  });
}
