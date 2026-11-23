/*
 * Service worker — caching strategy (see docs/ARCHITECTURE.md §4):
 *
 *   navigation        network-first → cached shell (offline)
 *   /assets/*         cache-first (content-hashed, immutable; includes ORT's .wasm)
 *   /v1/*             network-only (job state must never be stale)
 *   model weights     NOT handled here: the page writes them to the "models-*" cache itself
 *                     after sha256 verification, and reads them back with progress.
 *   POST /share-target  Web Share Target: stash the shared file, redirect into the app.
 *   sync "flush-outbox" ask open clients to submit queued server jobs (Background Sync,
 *                     Chromium only; other engines retry on the page's `online` event).
 */
const SHELL_CACHE = 'shell-v1';
const RUNTIME_CACHE = 'runtime-v1';
const SHARE_CACHE = 'share-inbox';
const KEEP = new Set([SHELL_CACHE, RUNTIME_CACHE, SHARE_CACHE]);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => c.addAll(['/', '/manifest.webmanifest', '/icon.svg']))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !KEEP.has(k) && !k.startsWith('models-')).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith(handleShare(req));
    return;
  }
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/v1/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          void caches.open(SHELL_CACHE).then((c) => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/').then((r) => r ?? Response.error())),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) await cache.put(req, res.clone());
        return res;
      }),
    );
  }
});

async function handleShare(req) {
  const form = await req.formData();
  const file = form.get('audio');
  if (file instanceof File) {
    const cache = await caches.open(SHARE_CACHE);
    await cache.put('/shared-file', new Response(file, { headers: { 'content-type': file.type, 'x-filename': encodeURIComponent(file.name) } }));
  }
  return Response.redirect('/?shared=1', 303);
}

self.addEventListener('sync', (event) => {
  if (event.tag !== 'flush-outbox') return;
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      for (const c of clients) c.postMessage({ type: 'flush-outbox' });
    }),
  );
});
