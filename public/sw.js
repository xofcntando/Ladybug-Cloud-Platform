/* Ladybug Cloud service worker: makes the site installable and keeps the app shell available offline.
   API calls are NEVER cached (always live data). */
const VERSION = 'ladybug-v5';
const SHELL = ['/', '/css/style.css', '/js/app.js', '/js/wa-extras.js', '/js/wa-accounts.js', '/js/wa-rich.js', '/js/wa-labels.js', '/js/wa-gallery.js', '/js/wa-contacts.js', '/js/wa-status.js', '/js/wa-channels.js', '/js/wa-auto.js', '/js/pwa.js', '/img/logo.png', '/img/icon-192.png', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return; // live data only

  // Pages: network first, fall back to cached shell when offline
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/')));
    return;
  }
  // Static assets: network first (so deploys show up), cache as fallback
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
