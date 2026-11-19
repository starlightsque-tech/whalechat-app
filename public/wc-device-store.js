/* =========================================================================
   WhaleChat · local-first device database (wc-device-store)
   -------------------------------------------------------------------------
   IndexedDB (native, no library, no network) — the single source of truth
   while the installed app is offline:

     portfolio      { id:'main', userId, cashUsd, reservedUsd, updatedAt }
     holdings       { ticker, qty, avgPrice, userId, updatedAt }
     orders         local trade ledger (FILLED_LOCAL / RECONCILED / ADJUSTED …)
     pending_sync   the offline trade queue, FIFO on offlineTimestamp
     candles        { symbol, tf, rows:[{t,o,h,l,c,v}] }   last 2 000 bars
     watchlist      { symbol, addedAt }
     meta           key/value (last sync, schema, device id)

   Everything is promise-based and every call is wrapped so a blocked or
   cleared IndexedDB (private mode) degrades to an in-memory Map instead of
   breaking the app.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.WC_DEVICE) return;

  var DB_NAME = 'wc-device';
  var DB_VER = 1;
  var STORES = [
    { name: 'portfolio', key: 'id' },
    { name: 'holdings', key: 'ticker' },
    { name: 'orders', key: 'clientOrderId' },
    { name: 'pending_sync', key: 'clientOrderId' },
    { name: 'candles', key: 'key' },
    { name: 'watchlist', key: 'symbol' },
    { name: 'meta', key: 'key' }
  ];

  var dbPromise = null;
  var memory = {};
  var usingMemory = false;
  STORES.forEach(function (s) { memory[s.name] = new Map(); });

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve) {
      if (typeof indexedDB === 'undefined') { usingMemory = true; return resolve(null); }
      var req;
      try { req = indexedDB.open(DB_NAME, DB_VER); } catch (e) { usingMemory = true; return resolve(null); }
      req.onupgradeneeded = function () {
        var db = req.result;
        STORES.forEach(function (s) {
          if (!db.objectStoreNames.contains(s.name)) db.createObjectStore(s.name, { keyPath: s.key });
        });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { usingMemory = true; resolve(null); };
      req.onblocked = function () { usingMemory = true; resolve(null); };
    });
    return dbPromise;
  }

  /* Direct request-level helpers: resolve from the request's own success event
     (fakes and real browsers agree there) with an in-memory fallback so a
     blocked/quota-exceeded IndexedDB never breaks the trading desk. */
  function openTx(store, mode, fn, fallback) {
    return open().then(function (db) {
      return new Promise(function (resolve) {
        if (!db) { usingMemory = true; return resolve(fallback()); }
        var t;
        try { t = db.transaction(store, mode); } catch (e) { usingMemory = true; return resolve(fallback()); }
        var req;
        try { req = fn(t.objectStore(store)); } catch (e) { usingMemory = true; return resolve(fallback()); }
        if (req && typeof req === 'object' && 'onsuccess' in req) {
          req.onsuccess = function () { resolve(req.result === undefined ? null : req.result); };
          req.onerror = function () { usingMemory = true; resolve(fallback()); };
          t.onabort = function () { usingMemory = true; resolve(fallback()); };
        } else {
          t.oncomplete = function () { resolve(req === undefined ? null : req); };
          t.onerror = function () { usingMemory = true; resolve(fallback()); };
          t.onabort = function () { usingMemory = true; resolve(fallback()); };
        }
      });
    });
  }

  var D = {};

  D.ready = function () { return open().then(function () { return !usingMemory; }); };
  D.backend = function () { return usingMemory ? 'memory' : 'indexeddb'; };

  D.put = function (store, value) {
    var keyField = (STORES.filter(function (s) { return s.name === store; })[0] || { key: 'id' }).key;
    return openTx(store, 'readwrite', function (os) { os.put(value); return value; }, function () { memPut(store, value); return value; });
  };
  D.get = function (store, key) {
    return openTx(store, 'readonly', function (os) { return os.get(key); }, function () { return memory[store].get(key) || null; });
  };
  D.all = function (store) {
    return openTx(store, 'readonly', function (os) { return os.getAll(); }, function () { return Array.from(memory[store].values()); })
      .then(function (rows) { return rows || []; });
  };
  D.del = function (store, key) {
    return openTx(store, 'readwrite', function (os) { os.delete(key); return true; }, function () { memory[store].delete(key); return true; });
  };

  /* ------------------------------------------------------------ portfolio */
  D.portfolio = function () {
    return D.get('portfolio', 'main').then(function (p) {
      return p || { id: 'main', userId: '', cashUsd: 0, reservedUsd: 0, updatedAt: 0, source: 'empty' };
    });
  };

  D.savePortfolio = function (patch) {
    return D.portfolio().then(function (p) {
      var next = Object.assign({}, p, patch || {}, { id: 'main', updatedAt: Date.now() });
      return D.put('portfolio', next);
    });
  };

  D.holdings = function () { return D.all('holdings').then(function (rows) { return (rows || []).filter(function (h) { return h && h.qty > 1e-9; }); }); };

  D.saveHolding = function (ticker, patch) {
    var t = String(ticker || '').toUpperCase();
    return D.get('holdings', t).then(function (h) {
      var next = Object.assign({ ticker: t, qty: 0, avgPrice: 0, userId: '' }, h || {}, patch || {}, { ticker: t, updatedAt: Date.now() });
      if (next.qty <= 1e-9) return D.del('holdings', t);
      return D.put('holdings', next);
    });
  };

  /* --------------------------------------------------------------- orders */
  D.saveOrder = function (order) { return D.put('orders', order); };
  D.orders = function () {
    return D.all('orders').then(function (rows) {
      return (rows || []).sort(function (a, b) { return (b.offlineTimestamp || b.createdAt || 0) - (a.offlineTimestamp || a.createdAt || 0); });
    });
  };

  /* ---------------------------------------------------------- pending sync */
  D.queue = function (order) {
    var rec = Object.assign({ syncStatus: 'PENDING', queuedAt: Date.now() }, order);
    return D.put('pending_sync', rec).then(function () { return rec; });
  };
  D.pending = function () {
    return D.all('pending_sync').then(function (rows) {
      return (rows || [])
        .filter(function (r) { return r && (r.syncStatus === 'PENDING' || r.syncStatus === 'SYNCING' || r.syncStatus === 'FAILED_RETRY'); })
        .sort(function (a, b) { return (a.offlineTimestamp || 0) - (b.offlineTimestamp || 0); });
    });
  };
  D.pendingCount = function () { return D.pending().then(function (r) { return r.length; }); };
  D.markSynced = function (clientOrderId, status, extra) {
    return D.get('pending_sync', clientOrderId).then(function (rec) {
      if (!rec) return null;
      var next = Object.assign({}, rec, extra || {}, { syncStatus: status, syncedAt: Date.now() });
      return D.put('pending_sync', next).then(function () { return next; });
    });
  };

  /* --------------------------------------------------------------- candles */
  D.candlesKey = function (symbol, tf) { return String(symbol || '').toUpperCase() + '|' + (tf || '1m'); };
  D.saveCandles = function (symbol, tf, rows) {
    var key = D.candlesKey(symbol, tf);
    var trimmed = (rows || []).slice(-2000);
    return D.put('candles', { key: key, symbol: String(symbol || '').toUpperCase(), tf: tf || '1m', rows: trimmed, savedAt: Date.now() });
  };
  D.getCandles = function (symbol, tf) {
    return D.get('candles', D.candlesKey(symbol, tf)).then(function (rec) { return (rec && rec.rows) || []; });
  };

  /* ------------------------------------------------------------ watchlist */
  D.watch = function (symbol) {
    return D.put('watchlist', { symbol: String(symbol || '').toUpperCase(), addedAt: Date.now() });
  };
  D.unwatch = function (symbol) { return D.del('watchlist', String(symbol || '').toUpperCase()); };
  D.watched = function () { return D.all('watchlist').then(function (rows) { return (rows || []).map(function (r) { return r.symbol; }); }); };

  /* ----------------------------------------------------------------- meta */
  D.meta = function (key, value) {
    if (value === undefined) return D.get('meta', key).then(function (r) { return r ? r.value : null; });
    return D.put('meta', { key: key, value: value, at: Date.now() });
  };

  D.uuid = function () {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    var b = new Uint8Array(16);
    try { crypto.getRandomValues(b); } catch (e) { for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256); }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  };

  /* one-time device id so two installs never share a queue identity */
  D.deviceId = function () {
    return D.meta('deviceId').then(function (v) {
      if (v) return v;
      var id = D.uuid();
      return D.meta('deviceId', id).then(function () { return id; });
    });
  };

  window.WC_DEVICE = D;

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') open();
  });
})();
