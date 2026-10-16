// Durable recording library in IndexedDB.
//
// Recordings are written chunk by chunk while they are being made (one chunk
// per second), so a crash or a closed tab loses at most the last second. A
// recording whose `complete` flag never got set is recovered on next load.

const DB_NAME = 'freq-recorder';
const DB_VERSION = 2;
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        if (e.oldVersion < 1) {
          db.createObjectStore('recordings', { keyPath: 'id' });
          const chunks = db.createObjectStore('chunks', { keyPath: ['recId', 'seq'] });
          chunks.createIndex('recId', 'recId');
        }
        // Small key/value store, e.g. the folder chosen for auto-saving.
        if (e.oldVersion < 2) db.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode, { durability: 'strict' });
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
    result = fn(t);
  });
}

const done = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export async function putRecording(rec) {
  await tx(['recordings'], 'readwrite', (t) => { t.objectStore('recordings').put(rec); });
}

export async function updateRecording(id, patch) {
  await tx(['recordings'], 'readwrite', (t) => {
    const store = t.objectStore('recordings');
    store.get(id).onsuccess = (e) => {
      if (e.target.result) store.put({ ...e.target.result, ...patch });
    };
  });
}

export async function putChunk(recId, seq, blob) {
  await tx(['chunks'], 'readwrite', (t) => { t.objectStore('chunks').put({ recId, seq, blob }); });
}

export async function listRecordings() {
  const db = await open();
  const all = await done(db.transaction('recordings').objectStore('recordings').getAll());
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getChunks(recId) {
  const db = await open();
  const index = db.transaction('chunks').objectStore('chunks').index('recId');
  const rows = await done(index.getAll(IDBKeyRange.only(recId)));
  return rows.sort((a, b) => a.seq - b.seq).map((r) => r.blob);
}

export async function getChunkRows(recId) {
  const db = await open();
  const index = db.transaction('chunks').objectStore('chunks').index('recId');
  const rows = await done(index.getAll(IDBKeyRange.only(recId)));
  return rows.sort((a, b) => a.seq - b.seq);
}

export async function getBlob(rec) {
  const chunks = await getChunks(rec.id);
  return new Blob(chunks, { type: (rec.mime || '').split(';')[0] });
}

export async function deleteRecording(recId) {
  await tx(['recordings', 'chunks'], 'readwrite', (t) => {
    t.objectStore('recordings').delete(recId);
    const index = t.objectStore('chunks').index('recId');
    index.openKeyCursor(IDBKeyRange.only(recId)).onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        t.objectStore('chunks').delete(cursor.primaryKey);
        cursor.continue();
      }
    };
  });
}

export async function getValue(key) {
  const db = await open();
  return done(db.transaction('kv').objectStore('kv').get(key));
}

export async function setValue(key, value) {
  await tx(['kv'], 'readwrite', (t) => {
    if (value === undefined) t.objectStore('kv').delete(key);
    else t.objectStore('kv').put(value, key);
  });
}

// Ask the browser not to evict our data when disk space runs low.
export async function requestPersistence() {
  if (!navigator.storage || !navigator.storage.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}

export async function storageInfo() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
  return { usage, quota, persisted };
}
