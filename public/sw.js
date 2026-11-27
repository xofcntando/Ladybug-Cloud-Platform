/* Ladybug Cloud service worker: makes the site installable and keeps the whole app shell
   available offline so the installed app exposes every feature, not just a subset.

   Rules:
   - API calls are NEVER cached (always live data).
   - The shell is precached ONE URL AT A TIME, so a single missing/renamed file can never
     abort the whole install (the old code used addAll(), which is all-or-nothing).
   - Every page module in public/js is listed below; keep this list in sync with index.html.
*/
const VERSION = 'ladybug-v10';

const SHELL = [
  '/',
  '/css/style.css',
  '/manifest.webmanifest',
  '/img/logo.png',
  '/img/icon-192.png',
  '/img/icon-512.png',
  '/img/icon-maskable-512.png',
  // core
  '/js/terms.js',
  '/js/app.js',
  '/js/pwa.js',
  '/js/appmode.js',
  '/js/activity.js',
  '/js/palette.js',
  // WhatsApp web console modules
  '/js/wa-extras.js',
  '/js/wa-accounts.js',
  '/js/wa-rich.js',
  '/js/wa-labels.js',
  '/js/wa-gallery.js',
  '/js/wa-contacts.js',
  '/js/wa-groups.js',
  '/js/wa-undo.js',
  '/js/wa-radar.js',
  '/js/wa-status.js',
  '/js/wa-channels.js',
  '/js/wa-auto.js',
  '/js/wa-digest.js',
  '/js/wa-crm.js',
  '/js/wa-translate.js',
  '/js/wa-pro.js',
  '/js/wa-ai.js',
  '/js/wa-flows.js'
];

// Cache each shell URL on its own so one 404 cannot break the install.
function precache() {
  return caches.open(VERSION).then((cache) =>
    Promise.all(
      SHELL.map((url) =>
        cache.add(new Request(url, { cache: 'reload' })).catch((err) => {
          // Log but never fail the install: the runtime fetch handler will fill the gap.
          console.warn('[sw] skipped precache for', url, err && err.message);
        })
      )
    )
  );
}

self.addEventListener('install', (e) => {
  e.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// The page can ask the worker to take over immediately after an update.
self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting' || (e.data && e.data.type === 'SKIP_WAITING')) self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return; // live data only

  // Pages: network first, fall back to the cached shell when offline
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
      .catch(() => caches.match(req).then((hit) => hit || caches.match('/')))
  );
});
