// Minimal offline-shell service worker.
//
// Caches the static app shell so a browser without network can still
// land on a friendly offline page rather than the default chrome
// "no internet" stub. Live data (AppSync queries, audio playback)
// still requires network — caching mutable Message rows here would
// just mask staleness from the user.
//
// Cache name is versioned via the deploy id baked into the SW at
// build time when serwist (or the Amplify Next adapter) lands; the
// raw v1 SW uses a date string to force re-installation on each
// hard reload.

const CACHE_NAME = 'sentinel-shell-v1';
const SHELL_ASSETS = ['/', '/messages', '/skykings', '/skybird', '/stats', '/about', '/sign-in'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS).catch(() => undefined)),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Only handle GET navigations + same-origin same-origin static
  // requests. AppSync (cross-origin POST) and S3 audio fetches
  // (cross-origin GET) skip the cache.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match(request).then((res) => res ?? caches.match('/'))),
    );
    return;
  }
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ??
        fetch(request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return res;
        }),
    ),
  );
});
