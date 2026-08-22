/*
 * App-shell service worker.
 *
 * Offline is a bonus here, not a requirement — the database is local, so
 * the log works without a network either way. What this buys is a cold
 * start that does not wait on a round trip.
 *
 * Strategy matters more than it looks:
 *  - navigations are NETWORK-FIRST. A cache-first shell pins the old
 *    index.html — which references old hashed assets — forever, so the
 *    app would simply never update after a redeploy.
 *  - /assets/ is CACHE-FIRST. Vite content-hashes those filenames, so a
 *    cached copy is immutable by construction.
 *  - everything else same-origin is network-first with cache fallback.
 */
const CACHE = 'log-shell-v2';
const PRECACHE = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

const put = (req, res) => {
  const copy = res.clone();
  caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
  return res;
};

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then((res) => put(e.request, res))
        .catch(() => caches.match(e.request).then((hit) => hit ?? caches.match('/index.html'))),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(
      caches.match(e.request).then((hit) => hit ?? fetch(e.request).then((res) => put(e.request, res))),
    );
    return;
  }

  e.respondWith(
    fetch(e.request).then((res) => put(e.request, res))
      .catch(() => caches.match(e.request)),
  );
});
