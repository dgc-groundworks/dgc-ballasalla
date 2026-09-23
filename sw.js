// DGC Control Panel — Service Worker v225
// NUCLEAR CACHE CLEAR: on activate, wipe ALL caches and force reload all clients

const CACHE = 'dgc-v1790189053';

self.addEventListener('install', () => {
  self.skipWaiting(); // activate immediately
});

self.addEventListener('activate', e => {
  e.waitUntil(
    // Wipe every cache that exists (not just our old ones)
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => {
        // Force ALL open tabs to reload with fresh content
        return self.clients.matchAll({ type: 'window' }).then(clients => {
          return Promise.all(clients.map(client => client.navigate(client.url)));
        });
      })
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  const isHTML = url.pathname.endsWith('.html') || url.pathname === '/dgc-ballasalla/' || url.pathname === '/dgc-ballasalla';

  if (isHTML) {
    // NETWORK ONLY for HTML — never serve from cache, always get latest
    e.respondWith(
      fetch(e.request).catch(() => new Response('Offline — please reconnect and refresh.', { status: 503 }))
    );
  } else {
    // Cache-first for assets (PDFs, manifests, icons)
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(response => {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, clone));
          return response;
        });
      })
    );
  }
});
