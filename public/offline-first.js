/* =========================================================================
   WhaleChat offline-first runtime  (wc-offline-first)
   -------------------------------------------------------------------------
   Makes the installed app usable with no connection at all:

     1. every app module is pre-cached after first load, so the app opens
        from the device with the network off
     2. GET /api/* answers are kept in IndexedDB and replayed when the network
        is gone — prices, portfolios, alerts and chat history survive offline
     3. price alerts are evaluated ON THE DEVICE against the last known quotes
        and delivered as home-screen / lock-screen notifications even with no
        connection (the server watcher cannot reach a device with no network)
     4. the alert + quote snapshot is handed to the service worker so its
        periodic background sync can raise the same notifications while the
        app is closed
     5. a periodic state flush runs as soon as the network returns

   Notes on the hard limits (also shown in the app's Offline card):
     · a browser/PWA can only raise a notification without a network while its
       process is alive; Android may kill a backgrounded PWA. The Chrome
       periodic background sync path (Android) keeps checking alerts while the
       app is closed. The bundled Android APK does not have this limit.
     · live prices cannot move without a network. Offline the app shows the
       last quote it received, clearly stamped, and still lets the user trade
       on that cached book locally; the normal server sync resumes on reconnect.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcOfflineFirst) return;
  window.__wcOfflineFirst = true;

  var VERSION = '3.48.0';
  var API_STORE = 'api';
  var META_STORE = 'meta';
  var OUTBOX_STORE = 'outbox';
  var DB_NAME = 'wc-offline';
  var DB_VER = 3;
  var MAX_CACHE_BYTES = 1500000;
  var API_TTL = 7 * 24 * 3600 * 1000;      /* last-known data stays a week */

  /* local-first data layer stores (v2) */
  var STORES = {
    api: null,
    meta: null,
    outbox: null,
    messages: null,
    chats: null,
    profiles: null,
    products: null,
    cart: null,
    orders: null,
    txs: null
  };

  var OF = window.WC_OFFLINE = {
    version: VERSION,
    online: navigator.onLine !== false,
    cachedAt: 0,
    alertsChecked: 0,
    notifications: 0,
    lastError: ''
  };

  /* ------------------------------------------------------------ IndexedDB */
  var dbp = null;
  function idb() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error('no indexedDB'));
      var r = indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = function () {
        var d = r.result;
        /* v1 */
        if (!d.objectStoreNames.contains(API_STORE)) d.createObjectStore(API_STORE);
        if (!d.objectStoreNames.contains(META_STORE)) d.createObjectStore(META_STORE);
        if (!d.objectStoreNames.contains(OUTBOX_STORE)) {
          var ob = d.createObjectStore(OUTBOX_STORE, { keyPath: 'id', autoIncrement: true });
          ob.createIndex('status', 'status', { unique: false });
        }
        /* v2 — local-first chat / shop data ---------------------------------- */
        if (!d.objectStoreNames.contains('messages')) {
          var ms = d.createObjectStore('messages', { keyPath: 'id' });
          ms.createIndex('chatId', 'chatId', { unique: false });
          ms.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (!d.objectStoreNames.contains('chats')) {
          var cs = d.createObjectStore('chats', { keyPath: 'id' });
          cs.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
        if (!d.objectStoreNames.contains('profiles')) d.createObjectStore('profiles', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('products')) {
          var ps = d.createObjectStore('products', { keyPath: 'id' });
          ps.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
        if (!d.objectStoreNames.contains('cart')) d.createObjectStore('cart', { keyPath: 'productId' });
        if (!d.objectStoreNames.contains('orders')) {
          var os2 = d.createObjectStore('orders', { keyPath: 'id' });
          os2.createIndex('createdAt', 'createdAt', { unique: false });
        }
        /* v3 — wallet history */
        if (!d.objectStoreNames.contains('txs')) {
          var txs = d.createObjectStore('txs', { keyPath: 'id' });
          txs.createIndex('createdAt', 'createdAt', { unique: false });
          txs.createIndex('userId', 'userId', { unique: false });
        }
      };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error || new Error('idb open failed')); };
    });
    return dbp;
  }
  function idbTx(store, mode, fn) {
    return idb().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(store, mode);
        var os = tx.objectStore(store);
        var out;
        try { out = fn(os); } catch (e) { reject(e); return; }
        tx.oncomplete = function () { resolve(out && out.__req ? out.__req.result : out); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('tx aborted')); };
      });
    });
  }
  function idbGet(store, key) {
    return idbTx(store, 'readonly', function (os) { return { __req: os.get(key) }; }).catch(function () { return null; });
  }
  function idbPut(store, val, key) {
    return idbTx(store, 'readwrite', function (os) { if (key === undefined) os.put(val); else os.put(val, key); })
      .catch(function (e) { OF.lastError = String(e && e.message || e); return null; });
  }
  function idbDel(store, key) {
    return idbTx(store, 'readwrite', function (os) { os.delete(key); }).catch(function () {});
  }
  /* read every record, optionally through an index */
  function idbAll(store, indexName, query) {
    return idbTx(store, 'readonly', function (os) {
      var src = indexName ? os.index(indexName) : os;
      return { __req: query === undefined ? src.getAll() : src.getAll(query) };
    }).catch(function () { return []; });
  }
  function idbCount(store) {
    return idbTx(store, 'readonly', function (os) { return { __req: os.count() }; }).catch(function () { return 0; });
  }
  function idbClear(store) {
    return idbTx(store, 'readwrite', function (os) { os.clear(); }).catch(function () {});
  }
  /* one transaction across several puts — used by the mirror */
  function idbBulk(store, records) {
    if (!records || !records.length) return Promise.resolve(0);
    return idb().then(function (d) {
      return new Promise(function (resolve) {
        var tx = d.transaction(store, 'readwrite');
        var os = tx.objectStore(store);
        try { records.forEach(function (r) { if (r && r.id != null) os.put(r); }); } catch (e) {}
        tx.oncomplete = function () { resolve(records.length); };
        tx.onerror = function () { resolve(0); };
        tx.onabort = function () { resolve(0); };
      });
    }).catch(function () { return 0; });
  }

  /* ------------------------------------------------------------- helpers */
  function safe(fn, dflt) { try { return fn(); } catch (e) { return dflt; } }
  function nowTag() { return new Date().toISOString(); }
  function toastSafe(msg, kind) { try { if (typeof toast === 'function') toast(msg, kind || 'ok'); } catch (e) {} }
  function meSafe() { return safe(function () { return (typeof me === 'function') ? me() : null; }, null); }
  function acctSafe() {
    var u = meSafe();
    if (!u) return null;
    if (!u.investAcct) u.investAcct = {};
    if (!Array.isArray(u.investAcct.b2bAlerts)) u.investAcct.b2bAlerts = [];
    return u.investAcct;
  }
  function persistSafe() {
    safe(function () { if (typeof persist === 'function') persist(); });
    safe(function () { if (typeof sync === 'function') sync(); });
  }
  function renderSafe() { safe(function () { if (typeof render === 'function') render(); }); }

  /* -------------------------------------------------- 1. full precache */
  function precache() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.ready.then(function (reg) {
      var target = reg.active || navigator.serviceWorker.controller;
      fetch('./offline-manifest.json', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (m) {
          if (!m || !Array.isArray(m.assets) || !target) return;
          target.postMessage({ type: 'PRECACHE_ALL', urls: m.assets, version: m.version || VERSION });
        })
        .catch(function () {});

      /* periodic background alert checks (Android / Chromium) */
      try {
        if (reg.periodicSync && reg.periodicSync.register) {
          reg.periodicSync.register('wc-alert-check', { minInterval: 15 * 60 * 1000 }).catch(function () {});
        }
      } catch (e) {}
      try { if (reg.sync && reg.sync.register) reg.sync.register('wc-alert-check'); } catch (e) {}
    }).catch(function () {});
    /* ask the browser to keep the cache instead of evicting it */
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {}); } catch (e) {}
  }

  /* ---------------------------------------------- 2. API cache + fetch */
  var originalFetch = window.fetch ? window.fetch.bind(window) : null;

  function cacheKey(url) { return url.pathname + url.search; }

  async function readApiCache(url) {
    var hit = await idbGet(API_STORE, cacheKey(url));
    if (!hit || !hit.body) return null;
    if (Date.now() - hit.at > API_TTL) return null;
    return hit;
  }

  function wrapFetch(input, init) {
    if (!originalFetch) return Promise.reject(new Error('fetch unavailable'));
    var req;
    try { req = (typeof input === 'string' || input instanceof URL) ? new Request(String(input), init || {}) : input; }
    catch (e) { return originalFetch(input, init); }

    var url;
    try { url = new URL(req.url, location.href); } catch (e) { return originalFetch(input, init); }
    var sameOrigin = url.origin === location.origin;
    var isApi = sameOrigin && url.pathname.indexOf('/api/') === 0;
    /* SSE / streaming endpoints must never be buffered into the cache */
    var isStream = /\/api\/(events|market\/stream)\b/.test(url.pathname);

    if (!isApi || isStream || req.method !== 'GET') return originalFetch(input, init);

    /* offline → answer straight from the device, never wait for a timeout */
    if (!navigator.onLine) {
      return readApiCache(url).then(function (hit) {
        if (hit) {
          OF.cachedAt = hit.at;
          return new Response(hit.body, {
            status: 200,
            headers: { 'content-type': hit.type || 'application/json', 'x-wc-offline': '1', 'x-wc-cached-at': String(hit.at) }
          });
        }
        throw new TypeError('Failed to fetch');
      });
    }

    return originalFetch(input, init).then(function (res) {
      if (res && res.ok) {
        var ctype = res.headers.get('content-type') || '';
        if (ctype.indexOf('text/event-stream') === -1) {
          res.clone().text().then(function (body) {
            if (body && body.length <= MAX_CACHE_BYTES) {
              idbPut(API_STORE, { at: Date.now(), body: body, type: ctype || 'application/json' }, cacheKey(url));
            }
          }).catch(function () {});
        }
      }
      return res;
    }).catch(function (err) {
      return readApiCache(url).then(function (hit) {
        if (hit) {
          OF.cachedAt = hit.at;
          return new Response(hit.body, {
            status: 200,
            headers: { 'content-type': hit.type || 'application/json', 'x-wc-offline': '1', 'x-wc-cached-at': String(hit.at) }
          });
        }
        throw err;
      });
    });
  }
  if (originalFetch) {
    try { window.fetch = wrapFetch; } catch (e) {}
  }

  /* --------------------------------------------- 3. price + alert engine */
  function quoteEnginePrice(ticker) {
    ticker = String(ticker || '').toUpperCase();
    if (ticker === 'WC') {
      var wc = safe(function () { return WC_B2B_MARKET && WC_B2B_MARKET.price('WC'); }, 0);
      if (Number(wc) > 0) return Number(wc);
    }
    var p = safe(function () { return INV.quote(ticker).price; }, 0);
    return Number(p) > 0 ? Number(p) : 0;
  }

  var quoteSnapshot = {};      /* ticker -> last price seen on this device */
  function rememberQuotes(src) {
    try {
      if (!src) return;
      Object.keys(src).forEach(function (k) {
        var q = src[k];
        var v = q && (typeof q === 'number' ? q : Number(q.price));
        if (Number(v) > 0) quoteSnapshot[String(k).toUpperCase()] = Number(v);
      });
    } catch (e) {}
  }
  function collectQuotes() {
    try { rememberQuotes(window.INV && INV.live); } catch (e) {}
    try {
      if (window.WC_MARKET && WC_MARKET.feed && WC_MARKET.feed.quotes) rememberQuotes(WC_MARKET.feed.quotes);
    } catch (e) {}
    var acct = acctSafe();
    if (acct && Array.isArray(acct.b2bAlerts)) {
      acct.b2bAlerts.forEach(function (a) {
        if (!a || !a.ticker) return;
        var p = quoteEnginePrice(a.ticker);
        if (p > 0) quoteSnapshot[String(a.ticker).toUpperCase()] = p;
      });
    }
    return quoteSnapshot;
  }

  var hitMemory = {};
  function hitKey(a, side, price) {
    return String((a && (a.id || a.ticker)) || '') + '|' + side + '|' + String(price);
  }

  function notifyDevice(title, body, link, opts) {
    opts = opts || {};
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;
    if (!navigator.serviceWorker) { OF.lastError = 'no service worker'; return; }
    navigator.serviceWorker.ready.then(function (reg) {
      return reg.showNotification(title, {
        body: body,
        icon: './assets/logo-192.png',
        badge: './assets/badge-72.png',
        tag: opts.tag || 'wc-alert',
        renotify: true,
        requireInteraction: !!opts.requireInteraction,
        vibrate: [140, 70, 140],
        timestamp: Date.now(),
        data: { url: link || './whalechat.html#/notifications', offline: !!opts.offline },
        actions: [{ action: 'open', title: 'Open WhaleChat' }]
      });
    }).then(function () { OF.notifications++; }).catch(function (e) { OF.lastError = String(e && e.message || e); });
  }

  /* evaluate the user's B2B alerts against the best price this device has */
  function evaluateAlerts() {
    OF.lastAlertRun = Date.now();
    var acct = acctSafe();
    if (!acct || !Array.isArray(acct.b2bAlerts) || !acct.b2bAlerts.length) return;
    var changed = false;
    var offline = !navigator.onLine;
    var hidden = document.hidden;

    acct.b2bAlerts.forEach(function (a) {
      if (!a || !a.ticker || a.paused) return;
      var t = String(a.ticker).toUpperCase();
      var price = quoteEnginePrice(t) || quoteSnapshot[t] || 0;
      if (!(price > 0)) return;
      quoteSnapshot[t] = price;

      var buy = Number(a.buy) || 0;
      var sell = Number(a.sell) || 0;

      if (buy > 0 && price <= buy && !a.buyHit) {
        var bk = hitKey(a, 'buy', price);
        if (!hitMemory[bk]) {
          hitMemory[bk] = 1;
          a.buyHit = true; a.buyHitAt = Date.now(); a.buyHitPrice = price; changed = true;
          OF.alertsChecked++;
          /* when online and the app is in front, the in-app toast covers it */
          if (offline || hidden) {
            notifyDevice('Buy target reached · ' + t,
              t + ' is at ' + price + ' — your estimated buy was ' + buy + (offline ? ' (checked on your device while offline)' : ''),
              './whalechat.html#/investment/b2b', { tag: 'wc-buy-' + t, requireInteraction: true, offline: offline });
          }
        }
      }
      if (sell > 0 && price >= sell && !a.sellHit) {
        var sk = hitKey(a, 'sell', price);
        if (!hitMemory[sk]) {
          hitMemory[sk] = 1;
          a.sellHit = true; a.sellHitAt = Date.now(); a.sellHitPrice = price; changed = true;
          OF.alertsChecked++;
          if (offline || hidden) {
            notifyDevice('Sell target reached · ' + t,
              t + ' is at ' + price + ' — your estimated sell was ' + sell + (offline ? ' (checked on your device while offline)' : ''),
              './whalechat.html#/investment/b2b', { tag: 'wc-sell-' + t, requireInteraction: true, offline: offline });
          }
        }
      }
    });

    if (changed) { persistSafe(); renderSafe(); }
    snapshotForWorker();
  }

  /* hand alerts + quotes to the service worker so its background sync can act */
  function snapshotForWorker() {
    var acct = acctSafe();
    var alerts = [];
    if (acct && Array.isArray(acct.b2bAlerts)) {
      alerts = acct.b2bAlerts.slice(0, 200).map(function (a) {
        return {
          id: a.id || a.ticker, ticker: String(a.ticker || '').toUpperCase(),
          buy: Number(a.buy) || 0, sell: Number(a.sell) || 0,
          buyHit: !!a.buyHit, sellHit: !!a.sellHit, email: a.email !== false
        };
      });
    }
    idbPut(META_STORE, { at: Date.now(), alerts: alerts, quotes: quoteSnapshot, userId: safe(function () { return SESSION && SESSION.userId; }, null) }, 'alertSnapshot');
  }

  /* --------------------------------------------- 4. connectivity handling */
  function onOnline() {
    OF.online = true;
    document.documentElement.classList.remove('wc-is-offline');
    toastSafe('Back online — syncing', 'ok');
    persistSafe();
    snapshotForWorker();
    evaluateAlerts();
    collectQuotes();
  }
  function onOffline() {
    OF.online = false;
    document.documentElement.classList.add('wc-is-offline');
    toastSafe('Offline — the app keeps working from your device', 'warn');
  }

  /* --------------------------------------------- 5. notification prompt */
  function notificationPrompt() {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted' || Notification.permission === 'denied') return;
    if (document.getElementById('wcNotifyPrompt')) return;
    var box = document.createElement('div');
    box.id = 'wcNotifyPrompt';
    box.className = 'wc-notify-prompt';
    box.innerHTML =
      '<div class="wc-np-text"><b>Turn on price alerts</b>' +
      '<span>Buy/sell alerts reach your home screen and lock screen — even when WhaleChat is closed or offline.</span></div>' +
      '<button type="button" class="wc-np-btn" id="wcNotifyEnable">Turn on</button>' +
      '<button type="button" class="wc-np-x" id="wcNotifyLater" aria-label="Not now">✕</button>';
    document.body.appendChild(box);
    document.getElementById('wcNotifyEnable').onclick = function () {
      Notification.requestPermission().then(function (p) {
        box.remove();
        if (p === 'granted') {
          toastSafe('Alerts enabled', 'ok');
          notifyDevice('WhaleChat alerts are on', 'Buy and sell alerts will appear on your home and lock screen.', './whalechat.html', { tag: 'wc-welcome' });
          try { if (window.WC_PUSH && WC_PUSH.enable) WC_PUSH.enable(); } catch (e) {}
        } else {
          toastSafe('Alerts stay off until you allow notifications', 'warn');
        }
      });
    };
    document.getElementById('wcNotifyLater').onclick = function () { box.remove(); };
  }

  function installStyles() {
    if (document.getElementById('wc-of-styles')) return;
    var st = document.createElement('style');
    st.id = 'wc-of-styles';
    st.textContent =
      '.wc-notify-prompt{position:fixed;left:12px;right:12px;bottom:14px;z-index:9996;display:flex;gap:10px;align-items:center;' +
      'padding:12px 14px;border-radius:14px;background:rgba(9,26,38,.97);border:1px solid rgba(46,230,201,.28);' +
      'box-shadow:0 18px 40px rgba(0,0,0,.45);font:13px/1.4 Inter,-apple-system,Segoe UI,Roboto,sans-serif;color:#e9f4f9}' +
      '.wc-notify-prompt .wc-np-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}' +
      '.wc-notify-prompt .wc-np-text span{color:#8ba4b6;font-size:11.5px}' +
      '.wc-notify-prompt .wc-np-btn{padding:9px 14px;border:0;border-radius:10px;font-weight:700;color:#03221d;' +
      'background:linear-gradient(135deg,#2ee6c9,#3aa0ff);cursor:pointer;white-space:nowrap}' +
      '.wc-notify-prompt .wc-np-x{background:transparent;border:0;color:#63798a;font-size:14px;cursor:pointer;padding:4px}' +
      'html.wc-is-offline body::after{content:"Offline · device mode";position:fixed;right:10px;top:calc(env(safe-area-inset-top,0px) + 8px);' +
      'z-index:9995;padding:4px 9px;border-radius:999px;background:rgba(30,24,6,.9);color:#ffc400;' +
      'font:600 10.5px Inter,-apple-system,Segoe UI,Roboto,sans-serif;border:1px solid rgba(255,196,0,.3)}';
    document.head.appendChild(st);
  }

  /* ------------------------------------------------------------ 6. boot */
  function start() {
    installStyles();
    if (!navigator.onLine) document.documentElement.classList.add('wc-is-offline');
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    precache();

    /* give the worker a first snapshot as soon as the app has data */
    setTimeout(function () { collectQuotes(); snapshotForWorker(); }, 2500);
    setTimeout(notificationPrompt, 6000);

    setInterval(function () {
      collectQuotes();
      evaluateAlerts();
      snapshotForWorker();
    }, 15000);

    /* re-check the moment the app is brought back to the foreground */
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { collectQuotes(); evaluateAlerts(); snapshotForWorker(); }
    });
    window.addEventListener('focus', function () { collectQuotes(); evaluateAlerts(); });
    /* other modules can force a check after saving an alert */
    window.addEventListener('wc-alert-saved', function () { collectQuotes(); evaluateAlerts(); snapshotForWorker(); });
    window.addEventListener('wc-quotes-updated', function () { collectQuotes(); evaluateAlerts(); });
  }

  OF.evaluateAlerts = evaluateAlerts;
  OF.snapshot = snapshotForWorker;
  OF.notify = notifyDevice;
  OF.quotes = function () { return quoteSnapshot; };
  /* shared local database handle for the chat/shop/outbox modules */
  OF.db = idb;
  OF.get = idbGet;
  OF.put = idbPut;
  OF.del = idbDel;
  OF.all = idbAll;
  OF.count = idbCount;
  OF.clear = idbClear;
  OF.bulk = idbBulk;
  OF.stores = STORES;
  OF.apiTtl = API_TTL;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
