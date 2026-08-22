/*
 * App-shell cache. Offline is a bonus here, not a requirement: the
 * database is local, so the log works with no network either way. What
 * this buys is a cold start that does not wait on a round trip.
 *
 * Speech recognition itself may still need the network depending on the
 * browser — that is a known limit of the Web Speech API, and the reason
 * the brief names React Native with on-device STT as the fallback.
 */
const CACHE = 'log-shell-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/index.html', '/manifest.webmanifest'])));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  e.respondWith(
    caches.match(e.request).then((hit) =>
      hit ?? fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match('/index.html'))),
  );
});
