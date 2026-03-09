const CACHE = 'taskflow-v2';
const STATIC = ['/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(
    ks.filter(k => k !== CACHE).map(k => caches.delete(k))
  )));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // HTML pages and API: always network (auth must be checked server-side)
  if (url.pathname === '/' || url.pathname.startsWith('/api/')) return;
  // Static assets only: cache first
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
