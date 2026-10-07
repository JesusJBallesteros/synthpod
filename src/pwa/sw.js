// Service worker. vite.config.ts copies this file to dist/sw.js and fills in the two placeholders,
// so every build produces a different file and browsers pick up the new version.
//
// It does two jobs:
//  1. Offline: keeps a copy of the app's own files, the speech runtime and the voice catalogue.
//  2. Cross-origin isolation: adds the headers that allow multi-threaded WASM on hosts that
//     cannot send them (GitHub Pages).

const BUILD = '__BUILD_ID__';
const FILES = __PRECACHE_FILES__;
const SHELL = 'synthpod-shell';
const RUNTIME = 'synthpod-runtime';
let running = null;

// The browser stops and restarts this worker at will, so "finished" has to be read from the cache
// itself (the build-id entry is written last), never remembered in a variable.
async function isComplete() {
  const stamp = await (await caches.open(SHELL)).match('build-id');
  return Boolean(stamp) && (await stamp.text()) === BUILD;
}

async function announce(ready) {
  for (const client of await self.clients.matchAll()) client.postMessage({ type: 'offline', ready });
}

/** Finish (or resume) saving the app, unless that is already under way. */
function ensurePrecached() {
  running ??= (async () => {
    if (!(await isComplete())) await precache();
    await announce(await isComplete());
  })().finally(() => (running = null));
  return running;
}

async function precache() {
  const cache = await caches.open(SHELL);
  const wanted = new Map(FILES.map((file) => [new URL(file, self.registration.scope).href, file]));
  const stamp = await cache.match('build-id');
  const sameBuild = stamp && (await stamp.text()) === BUILD;
  for (const request of await cache.keys()) {
    // File names contain a content hash, so anything not in the list belongs to an old build.
    if (!wanted.has(request.url) && !request.url.endsWith('/build-id')) await cache.delete(request);
  }
  const results = await Promise.allSettled(
    [...wanted.keys()].map(async (url) => {
      const unhashed = !/-[\w-]{8}\.\w+$/.test(url);
      if (!(await cache.match(url)) || (unhashed && !sameBuild)) await cache.add(new Request(url, { cache: 'reload' }));
    }),
  );
  if (results.every((r) => r.status === 'fulfilled')) await cache.put('build-id', new Response(BUILD));
}

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      await ensurePrecached();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'offline-status') event.waitUntil(ensurePrecached());
});

/** Same-origin responses get the isolation headers. */
async function isolated(responsePromise) {
  const response = await responsePromise;
  if (response.status === 0) return response;
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

async function networkFirst(request, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const hit = (await cache.match(request)) ?? (fallbackUrl && (await cache.match(fallbackUrl)));
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    const index = new URL('index.html', self.registration.scope).href;
    // The page itself is fetched fresh when online so updates arrive; everything else is hashed.
    event.respondWith(isolated(request.mode === 'navigate' ? networkFirst(request, SHELL, index) : cacheFirst(request, SHELL)));
  } else if (url.hostname === 'cdn.jsdelivr.net') {
    event.respondWith(cacheFirst(request, RUNTIME)); // versioned runtime files for Kokoro
  } else if (url.hostname === 'huggingface.co' && url.pathname.endsWith('/voices.json')) {
    event.respondWith(networkFirst(request, RUNTIME));
  }
  // Voice models are stored by the engines themselves and are not handled here.
});
