/* =========================================================================
   WhaleChat service worker — offline shell, in-place updates, Web Push
   -------------------------------------------------------------------------
   3.48.0: the whole app (every module + asset listed in offline-manifest.json)
   is pre-cached after the first load, GET /api/* answers are cached so the
   installed app still shows the last prices / portfolio / alerts with the
   network switched off, and the worker can raise buy/sell notifications from
   its periodic background sync when the page is closed.
   ========================================================================= */
const VERSION = 'wc-v3.48.0-1';
const API_CACHE = 'wc-api-v3.48.0';
const APP_CACHE = VERSION;

const SHELL = [
  './',
  './index.html',
  './whalechat.html',
  './manifest.webmanifest',
  './offline-first.js',
  './assets/logo.png',
  './assets/logo-192.png',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/favicon.png',
  './assets/apple-touch-icon.png',
  './assets/badge-72.png',
  './assets/hero.jpg',
  './assets/whale.jpg'
];

/* ------------------------------------------------------------ IndexedDB */
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('wc-offline', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('api')) d.createObjectStore('api');
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
      if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function readMeta(key) {
  return openDb().then((d) => new Promise((resolve) => {
    try {
      const tx = d.transaction('meta', 'readonly');
      const r = tx.objectStore('meta').get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  })).catch(() => null);
}
function writeMeta(key, val) {
  return openDb().then((d) => new Promise((resolve) => {
    try {
      const tx = d.transaction('meta', 'readwrite');
      tx.objectStore('meta').put(val, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch (e) { resolve(false); }
  })).catch(() => false);
}

/* --------------------------------------------------------------- install */
async function precache(urls) {
  const cache = await caches.open(APP_CACHE);
  const list = Array.from(new Set(urls || []));
  for (let i = 0; i < list.length; i += 16) {
    const chunk = list.slice(i, i + 16);
    await Promise.allSettled(chunk.map((u) => cache.add(new Request(u, { cache: 'reload' }))));
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    await Promise.allSettled(SHELL.map((u) => cache.add(new Request(u, { cache: 'reload' }))));
    /* pull the full build manifest so nothing is missing offline */
    try {
      const res = await fetch('./offline-manifest.json', { cache: 'no-store' });
      if (res.ok) {
        const m = await res.json();
        if (m && Array.isArray(m.assets)) await precache(m.assets);
      }
    } catch (e) {}
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => k !== VERSION && k !== API_CACHE)
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  if (data.type === 'CLEAR_CACHE') {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))));
  }
  if (data.type === 'PRECACHE_ALL' && Array.isArray(data.urls)) {
    event.waitUntil(precache(data.urls).then(() => {
      const port = event.ports && event.ports[0];
      if (port) port.postMessage({ ok: true, count: data.urls.length });
    }));
  }
});

/* ----------------------------------------------------------------- fetch */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;       // fonts, CDN, trackers: straight to network

  /* --- API: network first, device cache as the offline answer ------------ */
  if (url.pathname.startsWith('/api/')) {
    event.respondWith((async () => {
      const cache = await caches.open(API_CACHE);
      try {
        const res = await fetch(req);
        if (res && res.ok) {
          const copy = res.clone();
          cache.put(req, copy).catch(() => {});
        }
        return res;
      } catch (err) {
        const hit = await cache.match(req, { ignoreSearch: false }) || await cache.match(req, { ignoreSearch: true });
        if (hit) {
          const body = await hit.clone().blob();
          return new Response(body, {
            status: 200,
            headers: {
              'content-type': hit.headers.get('content-type') || 'application/json',
              'x-wc-offline': '1',
              'x-wc-cached-at': hit.headers.get('date') || ''
            }
          });
        }
        return new Response(JSON.stringify({ ok: false, offline: true, error: 'offline_no_cache' }), {
          status: 503,
          headers: { 'content-type': 'application/json', 'x-wc-offline': '1' }
        });
      }
    })());
    return;
  }

  /* --- HTML: network-first so a new release is picked up immediately ----- */
  if (req.mode === 'navigate' || /\.html?$/.test(url.pathname) || url.pathname === '/' || url.pathname === './') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(APP_CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req)
          .then((hit) => hit || caches.match('./whalechat.html') || caches.match('./index.html'))
          .then((hit) => hit || new Response('<h1>WhaleChat</h1><p>Offline. Reopen the installed app.</p>', { headers: { 'content-type': 'text/html' }, status: 200 })))
    );
    return;
  }

  /* --- static assets: stale-while-revalidate ---------------------------- */
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(APP_CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});

/* ------------------------------------------------------------ Web Push */
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

/* ------------------------------ periodic / one-off background alert check */
async function alertCheck() {
  const snap = await readMeta('alertSnapshot');
  if (!snap || !Array.isArray(snap.alerts) || !snap.alerts.length) return 0;
  const quotes = snap.quotes || {};
  const hits = (await readMeta('alertHits')) || {};
  let sent = 0;

  for (const a of snap.alerts) {
    const t = String(a.ticker || '').toUpperCase();
    const price = Number(quotes[t]) || 0;
    if (!(price > 0)) continue;
    const buy = Number(a.buy) || 0;
    const sell = Number(a.sell) || 0;
    if (buy > 0 && price <= buy && !a.buyHit) {
      const k = 'buy|' + (a.id || t) + '|' + buy;
      if (!hits[k]) {
        hits[k] = Date.now();
        await self.registration.showNotification('Buy target reached · ' + t, {
          body: t + ' is at ' + price + ' — your estimated buy was ' + buy + ' (checked on your device)',
          icon: './assets/logo-192.png',
          badge: './assets/badge-72.png',
          tag: 'wc-buy-' + t,
          renotify: true,
          requireInteraction: true,
          vibrate: [140, 70, 140],
          data: { url: './whalechat.html#/investment/b2b', offline: true }
        });
        sent++;
      }
    }
    if (sell > 0 && price >= sell && !a.sellHit) {
      const k = 'sell|' + (a.id || t) + '|' + sell;
      if (!hits[k]) {
        hits[k] = Date.now();
        await self.registration.showNotification('Sell target reached · ' + t, {
          body: t + ' is at ' + price + ' — your estimated sell was ' + sell + ' (checked on your device)',
          icon: './assets/logo-192.png',
          badge: './assets/badge-72.png',
          tag: 'wc-sell-' + t,
          renotify: true,
          requireInteraction: true,
          vibrate: [140, 70, 140],
          data: { url: './whalechat.html#/investment/b2b', offline: true }
        });
        sent++;
      }
    }
  }
  await writeMeta('alertHits', hits);
  return sent;
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'wc-alert-check') event.waitUntil(alertCheck());
});
self.addEventListener('sync', (event) => {
  if (event.tag === 'wc-alert-check') {
    event.waitUntil((async () => {
      await alertCheck();
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      all.forEach((c) => c.postMessage({ type: 'WC_FLUSH' }));
    })());
  }
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
