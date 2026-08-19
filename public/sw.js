/* sprite-lab service worker — hand-rolled, zero deps. Bump VERSION to invalidate. */
const VERSION = 'v8';
const CACHE = `sprite-lab-${VERSION}`;
const PRECACHE = [
  './',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Cache a successful response copy, pass the original through. */
function stash(request, response) {
  if (response && response.ok) {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(request, copy));
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  /* Navigations: network-first, fall back to the cached shell for offline boot. */
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then((res) => stash(request, res)).catch(() => caches.match('./')),
    );
    return;
  }

  /* Hashed build assets: cache-first (content-addressed, safe forever) with a
   * background revalidate; everything else same-origin: cache-first, network fallback. */
  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) {
        if (url.pathname.includes('/assets/')) {
          fetch(request).then((res) => stash(request, res)).catch(() => {});
        }
        return hit;
      }
      return fetch(request).then((res) => stash(request, res));
    }),
  );
});
