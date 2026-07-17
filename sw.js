// Sire Selector service worker.
// Strategy:
//  - App shell (HTML/manifest/icons) and the ~2,233-bull bulls_1.json: cached
//    on install, served cache-first so the app opens instantly and works
//    offline. Falls back to network if something's missing from cache.
//  - bulls_additional.json (the large lazily-loaded "search everyone else"
//    file): NOT precached, since most sessions never touch it and it's
//    several MB. It's cached the first time it's actually fetched
//    (stale-while-revalidate), so repeat searches work offline too without
//    penalizing first load.
const CACHE_VERSION = 'v12';
const APP_SHELL_CACHE = `sire-selector-shell-${CACHE_VERSION}`;
const DATA_CACHE = `sire-selector-data-${CACHE_VERSION}`;

const APP_SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './apple-touch-icon.png',
  './bulls_1.json',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE)
      .then(cache => cache.addAll(APP_SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys
        .filter(key => key !== APP_SHELL_CACHE && key !== DATA_CACHE)
        .map(key => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // The big lazily-loaded additional-bulls file: stale-while-revalidate.
  if (url.pathname.endsWith('bulls_additional.json')) {
    event.respondWith(
      caches.open(DATA_CACHE).then(async cache => {
        const cached = await cache.match(req);
        const networkFetch = fetch(req).then(res => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        }).catch(() => null);
        return cached || (await networkFetch) || new Response(
          JSON.stringify({ error: 'offline and not yet cached' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    return;
  }

  // Everything else (app shell, bulls_1.json): cache-first, network fallback.
  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => {
      // Opportunistically cache newly-seen same-origin GETs.
      if (res.ok && url.origin === self.location.origin) {
        caches.open(APP_SHELL_CACHE).then(cache => cache.put(req, res.clone()));
      }
      return res;
    }).catch(() => cached))
  );
});
