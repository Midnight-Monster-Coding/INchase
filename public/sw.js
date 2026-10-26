/* INchase service worker — Developed by IAB
   - HTML: network first, falls back to cache when offline
   - Same-origin files (js, png, json): stale-while-revalidate
   - Tailwind CDN + Google Fonts: stale-while-revalidate so the game can open offline
   - Everything else (Firebase auth incl. /__/auth/*, Firestore, Google APIs, POST requests) is never touched
   Bump CACHE_VERSION to force every device to drop old caches. */

const CACHE_VERSION = 'v6';
const CACHE = 'inchase-' + CACHE_VERSION;

const PRECACHE = [
  '/',
  '/manifest.json',
  '/favicon.png',
  '/apple-touch-icon.png',
  '/inchase-perf.js'
];

const CDN_HOSTS = [
  'cdn.tailwindcss.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // one missing file must not break the install
      .then((cache) => Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('inchase-') && k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

function staleWhileRevalidate(request) {
  return caches.open(CACHE).then((cache) =>
    cache.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // Firebase auth handler / email-link pages (/__/auth/..., /__/firebase/...): never touch them, never cache them
  if (sameOrigin && url.pathname.startsWith('/__/')) return;

  // The Android APK download (3+ MB): straight to the network, never cached, and never stored as the cached home page
  if (sameOrigin && url.pathname.endsWith('.apk')) return;

  // Page loads: network first, cache fallback
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req, { cache: 'no-cache' })   // ask the server every time: Firebase Hosting's default 1h HTTP cache must not serve an old page
        .then((res) => {
          if (sameOrigin && res && res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('/', copy)); }
          return res;
        })
        .catch(() => caches.match('/').then((r) => r || caches.match(req)))
    );
    return;
  }

  // Never cache the service worker itself
  if (sameOrigin && url.pathname === '/sw.js') return;

  // Your own scripts: network first, so a new auth.js is used on the very next load (not the one after)
  if (sameOrigin && url.pathname.endsWith('.js')) {
    event.respondWith(
      fetch(req, { cache: 'no-cache' })
        .then((res) => {
          if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  if (sameOrigin || CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(req));
  }
  // anything else (Firebase, Google APIs) goes straight to the network
});