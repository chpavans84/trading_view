// Service Worker — Trading Dashboard PWA
// Network-first for everything — app updates frequently so we never serve stale assets.
// Offline fallback: serve cached HTML shell if network is unavailable.

const CACHE = 'trading-v3';
const SHELL_URL = '/';

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.add(SHELL_URL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // Skip API calls — always network
  if (url.pathname.startsWith('/api/')) return;

  // Network-first for everything: try network, fall back to cache only for HTML
  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Cache the HTML shell for offline fallback only
        if (url.pathname === '/' || url.pathname === '/index.html') {
          caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
