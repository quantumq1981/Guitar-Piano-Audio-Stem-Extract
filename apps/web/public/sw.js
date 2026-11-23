/*
 * Service worker — caching strategy (see docs/ARCHITECTURE.md §5):
 *
 *   navigation        network-first → cached shell (offline)
 *   <base>assets/*    cache-first (content-hashed, immutable; includes ORT's .wasm)
 *   /v1/* (API)       never intercepted (cross-origin, and job state must never be stale)
 *   model weights     NOT handled here: the page writes them to the "models-*" cache itself
 *                     after sha256 verification, and reads them back with progress.
 *   POST share-target Web Share Target: stash the shared file, redirect into the app.
 *   sync "flush-outbox" ask open clients to submit queued server jobs (Chromium Background Sync).
 *
 * Cross-origin isolation shim: static hosts such as GitHub Pages cannot set
 * response headers, so every same-origin response passing through this worker
 * gets COOP/COEP added. That makes the page crossOriginIsolated (SharedArrayBuffer
 * → multithreaded WASM) after the first reload under SW control. `require-corp`
 * rather than `credentialless` because Safari only implements the former; all of
 * our cross-origin fetches (model, API) are CORS-mode, which require-corp allows.
 *
 * Every path is relative to the registration scope, so the app works at a
 * subpath (https://<user>.github.io/<repo>/) as well as at a domain root.
 */
const BASE = new URL(self.registration.scope).pathname; // always ends with '/'
const SHELL_CACHE = 'shell-v2';
const RUNTIME_CACHE = 'runtime-v2';
const SHARE_CACHE = 'share-inbox';
const KEEP = new Set([SHELL_CACHE, RUNTIME_CACHE, SHARE_CACHE]);

const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function withIsolation(res) {
  // Opaque/error responses cannot be rewrapped; redirects must stay untouched.
  if (!res || res.status === 0 || res.type === 'opaqueredirect') return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(ISOLATION_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => c.addAll([BASE, `${BASE}manifest.webmanifest`, `${BASE}icon.svg`]))
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

  if (req.method === 'POST' && url.pathname === `${BASE}share-target`) {
    event.respondWith(handleShare(req));
    return;
  }
  if (req.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(BASE)) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            void caches.open(SHELL_CACHE).then((c) => c.put(BASE, copy));
          }
          return withIsolation(res);
        })
        .catch(() => caches.match(BASE).then((r) => withIsolation(r ?? Response.error()))),
    );
    return;
  }

  if (url.pathname.startsWith(`${BASE}assets/`)) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return withIsolation(hit);
        const res = await fetch(req);
        if (res.ok) await cache.put(req, res.clone());
        return withIsolation(res);
      }),
    );
    return;
  }

  // Everything else same-origin (manifest, icon, sw-adjacent files): pass through with isolation headers.
  event.respondWith(fetch(req).then(withIsolation));
});

async function handleShare(req) {
  const form = await req.formData();
  const file = form.get('audio');
  if (file instanceof File) {
    const cache = await caches.open(SHARE_CACHE);
    await cache.put(`${BASE}shared-file`, new Response(file, { headers: { 'content-type': file.type, 'x-filename': encodeURIComponent(file.name) } }));
  }
  return Response.redirect(`${BASE}?shared=1`, 303);
}

self.addEventListener('sync', (event) => {
  if (event.tag !== 'flush-outbox') return;
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      for (const c of clients) c.postMessage({ type: 'flush-outbox' });
    }),
  );
});
