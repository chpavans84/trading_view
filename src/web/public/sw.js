// Service Worker — Trading Dashboard PWA
// Network-first for everything — app updates frequently so we never serve stale assets.
// Offline fallback: serve cached HTML shell if network is unavailable.
// Phase 5: web-push notifications + notificationclick deep-link.

const CACHE = 'trading-v5';
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

// ── Push notifications ────────────────────────────────────────────────────────
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data?.json() || {}; } catch (_) { data = { title: e.data?.text() || 'Alert' }; }
  const title   = data.title   || 'Trading Alert';
  const options = {
    body:    data.body    || '',
    icon:    '/icons/icon-192.png',
    badge:   '/icons/icon-72.png',
    tag:     data.key     || 'trading-alert',
    renotify: true,
    data:    { url: data.url || '/mobile.html', alert_id: data.alert_id || null },
    vibrate: [200, 100, 200],
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = (e.notification.data?.url || '/mobile.html');
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(wins => {
      const existing = wins.find(w => w.url.includes('/mobile.html') || w.url === target);
      if (existing) return existing.focus();
      return clients.openWindow(target);
    })
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
