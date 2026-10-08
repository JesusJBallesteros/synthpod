import type { PCM } from '../engines/types';

const DB_NAME = 'synthpod';
const STORE = 'chunks';
// The size of each chunk in bytes, kept apart so that adding them up does not read the audio.
const SIZES = 'sizes';

interface Stored {
  samples: Int16Array;
  sampleRate: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      const chunks = d.objectStoreNames.contains(STORE) ? req.transaction!.objectStore(STORE) : d.createObjectStore(STORE);
      if (d.objectStoreNames.contains(SIZES)) return;
      // Chunks saved by an earlier version: measure them once.
      const sizes = d.createObjectStore(SIZES);
      const walk = chunks.openCursor();
      walk.onsuccess = () => {
        const cursor = walk.result;
        if (!cursor) return;
        sizes.put((cursor.value as Stored).samples.byteLength, cursor.key);
        cursor.continue();
      };
    };
    req.onsuccess = () => {
      // Step aside when a newer version of the app, in another tab, needs to upgrade the store.
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
    // An older version of the app is open in another tab: work without the cache this time.
    req.onblocked = () => reject(new Error('The cache is in use by another tab'));
  });
  return dbPromise;
}

/** Run requests on both stores in one transaction and wait for it to complete. */
function transact<T>(mode: IDBTransactionMode, fn: (chunks: IDBObjectStore, sizes: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const tx = d.transaction([STORE, SIZES], mode);
        const req = fn(tx.objectStore(STORE), tx.objectStore(SIZES));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = tx.onabort = () => reject(tx.error ?? req.error);
      }),
  );
}

export async function chunkKey(engine: string, voice: string, speed: number, text: string): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify([engine, voice, speed, text]));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Rendered chunks are cached as 16-bit PCM so a re-render only synthesises what changed. */
export async function getChunk(key: string): Promise<PCM | null> {
  try {
    const hit = await transact<Stored | undefined>('readonly', (chunks) => chunks.get(key));
    if (!hit) return null;
    const pcm = new Float32Array(hit.samples.length);
    for (let i = 0; i < pcm.length; i++) pcm[i] = hit.samples[i] / 32768;
    return { pcm, sampleRate: hit.sampleRate };
  } catch {
    return null;
  }
}

export async function putChunk(key: string, audio: PCM): Promise<void> {
  const samples = new Int16Array(audio.pcm.length);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.max(-32768, Math.min(32767, Math.round(audio.pcm[i] * 32768)));
  }
  try {
    await transact('readwrite', (chunks, sizes) => {
      sizes.put(samples.byteLength, key);
      return chunks.put({ samples, sampleRate: audio.sampleRate } satisfies Stored, key);
    });
  } catch {
    // the cache is best-effort (quota, private mode)
  }
}

export async function clearChunks(): Promise<void> {
  await transact('readwrite', (chunks, sizes) => {
    sizes.clear();
    return chunks.clear();
  });
}

/** How many bytes of audio the cache holds, or null where the browser gives no storage. */
export async function chunkBytes(): Promise<number | null> {
  try {
    const all = await transact<number[]>('readonly', (_chunks, sizes) => sizes.getAll());
    return all.reduce((sum, bytes) => sum + bytes, 0);
  } catch {
    return null;
  }
}
