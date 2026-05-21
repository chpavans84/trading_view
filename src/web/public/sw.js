// Service Worker — Trading Dashboard PWA
// Phase 6: full offline support.
// - Static shell (mobile.html, manifest.json, icons): cache-first
// - /api/dashboard, /api/forecast, /api/uw/flow-alerts: stale-while-revalidate
// - Other /api/*: network-first (5 s timeout), fall back to cache
// - Trade POSTs: background-sync queue while offline
// - Push notifications + notificationclick deep-link (Phase 5)

const CACHE = 'trading-v23';

const STATIC_PRECACHE = [
  '/mobile.html',
  '/manifest.json',
];

const SWR_PATTERNS = [
  '/api/dashboard',
  '/api/forecast',
  '/api/uw/flow-alerts',
];

// ── Install: precache shell ───────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(STATIC_PRECACHE))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: purge old caches ────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: routing strategy ───────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return;   // let non-GET pass through

  const url = new URL(request.url);

  // Skip cross-origin requests
  if (url.origin !== self.location.origin) return;

  // Stale-while-revalidate for key dashboard APIs
  const isSWR = SWR_PATTERNS.some(p => url.pathname.startsWith(p));
  if (isSWR) {
    e.respondWith(_swrFetch(request));
    return;
  }

  // Network-first (5 s) for other API calls, cache fallback
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(_networkFirst(request, 5000));
    return;
  }

  // Network-first for main HTML — always fetch fresh so JS/CSS updates land immediately
  if (url.pathname === '/' || url.pathname === '/index.html') {
    e.respondWith(_networkFirst(request, 5000));
    return;
  }

  // Cache-first for other static assets (manifest, icons, CSS, JS)
  e.respondWith(_cacheFirst(request));
});

async function _cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok) {
      const c = await caches.open(CACHE);
      c.put(req, res.clone());
    }
    return res;
  } catch {
    // Completely offline and not cached — return offline shell
    return caches.match('/mobile.html') || new Response('Offline', { status: 503 });
  }
}

async function _swrFetch(req) {
  const cache   = await caches.open(CACHE);
  const cached  = await cache.match(req);
  const fetchP  = fetch(req).then(res => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);

  // Return cached immediately; update cache in background
  return cached || fetchP || new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } });
}

async function _networkFirst(req, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(req, { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) {
      const c = await caches.open(CACHE);
      c.put(req, res.clone());
    }
    return res;
  } catch {
    clearTimeout(timer);
    const cached = await caches.match(req);
    return cached || new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
}

// ── Background Sync: queue trade POSTs while offline ─────────────────────────
const TRADE_QUEUE_KEY = 'trade-queue';

self.addEventListener('sync', e => {
  if (e.tag === 'trade-sync') {
    e.waitUntil(_flushTradeQueue());
  }
});

async function _flushTradeQueue() {
  const db = await _openIDB();
  const queue = await _idbGetAll(db, TRADE_QUEUE_KEY);
  for (const item of queue) {
    try {
      const res = await fetch(item.url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(item.body),
        credentials: 'include',
      });
      if (res.ok) await _idbDelete(db, TRADE_QUEUE_KEY, item.id);
    } catch { /* retry next sync */ }
  }
}

// ── Minimal IndexedDB helpers (no dep) ───────────────────────────────────────
function _openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('trade-sw', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(TRADE_QUEUE_KEY, { keyPath: 'id', autoIncrement: true });
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = () => reject(req.error);
  });
}
function _idbGetAll(db, store) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });
}
function _idbDelete(db, store, id) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

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
