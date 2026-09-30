// The old Control Panel service worker, retired 30 Sep 2026 when the old
// pages came off the site. This replacement removes itself from any browser
// that still has it, and clears only the old Control Panel caches (dgc-v...),
// never the Job Planner's (dgc-planner-...).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (/^dgc-v\d/.test(k)) await caches.delete(k);
  await self.registration.unregister();
})()));
