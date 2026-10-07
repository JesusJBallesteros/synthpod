import type { PCM } from '../engines/types';

const DB_NAME = 'synthpod';
const STORE = 'chunks';

interface Stored {
  samples: Int16Array;
  sampleRate: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function request<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(d.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
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
    const hit = await request<Stored | undefined>('readonly', (s) => s.get(key));
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
    await request('readwrite', (s) => s.put({ samples, sampleRate: audio.sampleRate } satisfies Stored, key));
  } catch {
    // the cache is best-effort (quota, private mode)
  }
}

export async function clearChunks(): Promise<void> {
  await request('readwrite', (s) => s.clear());
}
