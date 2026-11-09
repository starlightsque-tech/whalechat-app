/* =========================================================================
   WhaleChat service worker — offline shell, in-place updates, Web Push
   ========================================================================= */
const VERSION = 'wc-v3.5.2-1';
const SHELL = [
  './',
  './index.html',
  './whalechat.html',
  './manifest.webmanifest',
  './assets/logo.png',
  './assets/logo-192.png',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/favicon.png',
  './assets/apple-touch-icon.png',
  './assets/hero.jpg',
  './assets/whale.jpg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => Promise.allSettled(SHELL.map((u) => cache.add(new Request(u, { cache: 'reload' })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  if (type === 'SKIP_WAITING') self.skipWaiting();
  if (type === 'CLEAR_CACHE') {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))));
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;       // fonts, CDN, trackers: straight to network
  if (url.pathname.startsWith('/api/')) return;          // never cache live data

  // HTML: network-first so a new release is picked up immediately, cache as offline fallback
  if (req.mode === 'navigate' || /\.html?$/.test(url.pathname) || url.pathname === '/' ) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('./whalechat.html')).then((hit) => hit || Response.error()))
    );
    return;
  }

  // Static assets: stale-while-revalidate
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});

/* ------------------------------- Web Push ------------------------------- */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { data = { body: event.data ? event.data.text() : '' }; }

  const title = data.title || 'WhaleChat';
  const link = data.link || './whalechat.html#/notifications';
  const options = {
    body: data.body || 'You have a new update',
    icon: data.icon || './assets/logo-192.png',
    badge: './assets/badge-72.png',
    image: data.image || undefined,
    tag: data.tag || 'wc-push',
    renotify: true,
    requireInteraction: !!data.requireInteraction,
    vibrate: [120, 60, 120],
    timestamp: Date.now(),
    data: { url: link },
    actions: [{ action: 'open', title: 'Open' }]
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './whalechat.html#/notifications';
  const absolute = new URL(target, self.location.origin).href;

  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if (client.url.includes(self.location.origin)) {
        await client.focus();
        if ('navigate' in client) { try { await client.navigate(absolute); } catch (e) {} }
        return;
      }
    }
    await self.clients.openWindow(absolute);
  })());
});

self.addEventListener('notificationclose', () => {});
