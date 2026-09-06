// DGC Job Planner — Service Worker
// Versioned cache + update-on-demand: when a new version is deployed, the app
// shows an "Update ready" banner; tapping it activates the new SW and reloads.
// No cache clearing needed by the user, and the app works offline.

const PLANNER_CACHE = 'dgc-planner-v41';
const PRECACHE = [
  './',
  'index.html',
  'manifest.json',
  '../icon-192.png',
  '../icon-512.png',
  '../apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(PLANNER_CACHE).then(cache => cache.addAll(PRECACHE)).catch(() => {})
  );
  // NOTE: no skipWaiting() here — the page shows the update banner and the
  // user chooses when to switch. skipWaiting happens on message below.
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('dgc-planner-') && k !== PLANNER_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // Network-first, cache fallback: always fresh when online, still works offline
  e.respondWith(
    fetch(e.request).then(response => {
      const clone = response.clone();
      caches.open(PLANNER_CACHE).then(cache => cache.put(e.request, clone)).catch(() => {});
      return response;
    }).catch(() => caches.match(e.request).then(c => c || new Response('Offline — reconnect and try again.', { status: 503 })))
  );
});
