/**
 * Thin promise wrapper over the IndexedDB store that holds the IMDb dump.
 *
 * One object store, `titles`, keyed by the numeric part of the tconst, with a
 * multiEntry index over the normalised title keys. That index is the whole point
 * of the dataset route: a lookup is one indexed getAll, no network, no quota.
 */

import { DB_NAME, DB_VERSION, INDEX_KEYS, STORE_META, STORE_TITLES } from '../shared/constants.js';

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_TITLES)) {
        const store = db.createObjectStore(STORE_TITLES, { keyPath: 'id' });
        store.createIndex(INDEX_KEYS, 'k', { multiEntry: true });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'name' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
  });
  return dbPromise;
}

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** All dataset rows whose title normalises to `key`. */
export async function findByKey(key) {
  const db = await openDb();
  const tx = db.transaction(STORE_TITLES, 'readonly');
  const index = tx.objectStore(STORE_TITLES).index(INDEX_KEYS);
  return promisify(index.getAll(key));
}

export async function getMeta(name) {
  const db = await openDb();
  const tx = db.transaction(STORE_META, 'readonly');
  return promisify(tx.objectStore(STORE_META).get(name));
}

export async function setMeta(name, value) {
  const db = await openDb();
  const tx = db.transaction(STORE_META, 'readwrite');
  tx.objectStore(STORE_META).put({ name, ...value });
  return txDone(tx);
}

export function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

/** Write a batch of records in one transaction. Batching is what makes the import bearable. */
export async function putTitles(records) {
  if (!records.length) return;
  const db = await openDb();
  const tx = db.transaction(STORE_TITLES, 'readwrite');
  const store = tx.objectStore(STORE_TITLES);
  for (const record of records) store.put(record);
  await txDone(tx);
}

export async function clearTitles() {
  const db = await openDb();
  const tx = db.transaction([STORE_TITLES, STORE_META], 'readwrite');
  tx.objectStore(STORE_TITLES).clear();
  tx.objectStore(STORE_META).delete('dataset');
  await txDone(tx);
}

export async function countTitles() {
  const db = await openDb();
  const tx = db.transaction(STORE_TITLES, 'readonly');
  return promisify(tx.objectStore(STORE_TITLES).count());
}
