/* =========================================================================
   WhaleChat · offline → online trade reconciliation (client, wc-recon)
   -------------------------------------------------------------------------
   The device half of the reconciliation engine.

     · holds the local portfolio snapshot the offline desk trades against
     · pushes `pending_sync` orders FIFO as soon as the installed app is back
       online (window 'online', service-worker Background Sync, focus, and a
       60 s retry loop while anything is queued)
     · applies the server verdict to local state:
         RECONCILED / ADJUSTED → keep the fill, adopt the server balance
         OPEN                  → limit/stop converted to a live open order
         FAILED*               → roll the optimistic balance back
     · shows the "Syncing X offline trades…" banner and the summary toast
     · exposes the order-history badge markup used by the desk

   Public API
     WC_RECON.bootstrap()            hydrate local portfolio from server/DB
     WC_RECON.flush({silent})        → Promise<summary>
     WC_RECON.queueStats()           → Promise<{pending,open,failed}>
     WC_RECON.badge(status)          → HTML string
     WC_RECON.onEvent(fn)
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.WC_RECON) return;

  var D = window.WC_DEVICE;
  var listeners = [];
  var flushing = false;
  var attempts = 0;
  var stats = { pending: 0, open: 0, failed: 0, synced: 0, lastSyncAt: 0, lastError: '' };

  function servers() { return window.WC_SERVERS || { tolerancePct: 2, api: function (p) { return p; } }; }
  function api(path) { return servers().api(path); }
  function emit(type, data) {
    stats.lastEvent = type;
    listeners.forEach(function (fn) { try { fn(Object.assign({ type: type }, data || {}), stats); } catch (e) {} });
    try { window.dispatchEvent(new CustomEvent('wc:sync', { detail: Object.assign({ type: type }, data || {}) })); } catch (e) {}
  }

  function toast(msg, kind) {
    try { if (typeof toast === 'function') return toast(msg, kind || 'ok'); } catch (e) {}
    var el = document.getElementById('wc-recon-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'wc-recon-toast';
      el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:calc(12px + env(safe-area-inset-top));z-index:99999;max-width:92vw;padding:10px 16px;border-radius:12px;font-size:12.5px;font-weight:700;box-shadow:0 10px 28px rgba(0,0,0,.45);transition:opacity .25s';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.background = kind === 'warn' ? '#3a2a05' : kind === 'err' ? '#3b0f16' : '#0b2a33';
    el.style.color = kind === 'warn' ? '#ffd47a' : kind === 'err' ? '#ffb3bd' : '#98f2e2';
    el.style.border = '1px solid ' + (kind === 'warn' ? '#f5b544' : kind === 'err' ? '#ff5c6e' : '#2ee6c9');
    el.style.opacity = '1';
    clearTimeout(el.__t);
    el.__t = setTimeout(function () { el.style.opacity = '0'; }, 4200);
  }

  function banner(text) {
    var el = document.getElementById('wc-sync-banner');
    if (!text) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'wc-sync-banner';
      el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99997;background:#0b2a33;color:#98f2e2;font-size:11.5px;font-weight:800;letter-spacing:.02em;text-align:center;padding:calc(7px + env(safe-area-inset-top)) 12px 7px;border-bottom:1px solid #2ee6c955';
      document.body.appendChild(el);
    }
    el.textContent = text;
  }

  function currentUserId() {
    try {
      if (typeof SESSION !== 'undefined' && SESSION && SESSION.userId) return SESSION.userId;
    } catch (e) {}
    try {
      if (typeof DB !== 'undefined' && DB && DB.session && DB.session.userId) return DB.session.userId;
    } catch (e) {}
    try {
      var raw = JSON.parse(localStorage.getItem('wc.session.v1') || 'null');
      if (raw && raw.userId) return raw.userId;
    } catch (e) {}
    return '';
  }

  function userName() {
    try { if (typeof DB !== 'undefined' && DB && Array.isArray(DB.users)) { var u = DB.users.find(function (x) { return x.id === currentUserId(); }); if (u) return u.fullName || u.username || ''; } } catch (e) {}
    return '';
  }

  /* ------------------------------------------------------------- bootstrap */
  function localFromDevice() {
    if (!D) return Promise.resolve(null);
    return Promise.all([D.portfolio(), D.holdings()]).then(function (r) {
      return { cashUsd: r[0].cashUsd || 0, reservedUsd: r[0].reservedUsd || 0, holdings: r[1] || [], source: 'device' };
    });
  }

  function serverSnapshot() {
    return fetch(api('/api/state'), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var db = j && (j.db || j);
        if (!db || !Array.isArray(db.users)) return null;
        var id = currentUserId();
        var u = db.users.find(function (x) { return x.id === id; }) || (db.users.length === 1 ? db.users[0] : null);
        if (!u) return null;
        var acct = u.investAcct || {};
        var cash = Number(acct.portfolios && acct.portfolios.stock) || 0;
        var reserved = Number(acct.stockReserved) || 0;
        var holdings = (db.holdings || []).filter(function (h) { return h && h.userId === u.id && Number(h.shares) > 0 && h.status !== 'closed'; }).map(function (h) {
          return { ticker: String(h.ticker).toUpperCase(), qty: Number(h.shares) || 0, avgPrice: Number(h.avgPrice) || 0, userId: u.id };
        });
        return { cashUsd: cash, reservedUsd: reserved, holdings: holdings, source: 'server', userId: u.id };
      })
      .catch(function () { return null; });
  }

  function adopt(snap) {
    if (!D || !snap) return Promise.resolve(snap);
    return D.savePortfolio({ cashUsd: snap.cashUsd, reservedUsd: snap.reservedUsd, userId: snap.userId || currentUserId(), source: snap.source })
      .then(function () {
        return D.all('holdings').then(function (rows) {
          var have = {};
          (snap.holdings || []).forEach(function (h) { have[h.ticker] = true; });
          var writes = (rows || []).filter(function (r) { return !have[r.ticker]; }).map(function (r) { return D.del('holdings', r.ticker); });
          (snap.holdings || []).forEach(function (h) { writes.push(D.saveHolding(h.ticker, h)); });
          return Promise.all(writes);
        });
      })
      .then(function () { return snap; });
  }

  function bootstrap() {
    var online = navigator.onLine !== false;
    return (online ? serverSnapshot() : Promise.resolve(null)).then(function (snap) {
      if (snap) return adopt(snap);
      return localFromDevice();
    }).then(function (snap) { emit('bootstrap', { portfolio: snap }); return snap; });
  }

  /* ----------------------------------------------------------------- flush */
  function queueStats() {
    if (!D) return Promise.resolve(stats);
    return Promise.all([D.all('pending_sync'), D.all('orders')]).then(function (r) {
      var pend = r[0] || [];
      stats.pending = pend.filter(function (o) { return o.syncStatus === 'PENDING' || o.syncStatus === 'SYNCING' || o.syncStatus === 'FAILED_RETRY'; }).length;
      stats.open = pend.filter(function (o) { return o.syncStatus === 'OPEN'; }).length;
      stats.failed = pend.filter(function (o) { return /^FAILED/.test(o.syncStatus || ''); }).length;
      stats.synced = pend.filter(function (o) { return o.syncStatus === 'RECONCILED' || o.syncStatus === 'ADJUSTED'; }).length;
      return stats;
    });
  }

  function applyResults(results) {
    var jobs = [];
    (results || []).forEach(function (r) {
      if (!r || !r.clientOrderId) return;
      var status = r.status || 'FAILED';
      jobs.push(D.markSynced(r.clientOrderId, status, {
        executedPrice: r.executedPrice,
        executedQuantity: r.quantity,
        livePrice: r.livePrice,
        trigger: r.trigger,
        reason: r.reason,
        priceDiffPct: r.priceDiffPct
      }));
      jobs.push(D.get('orders', r.clientOrderId).then(function (o) {
        if (!o) return null;
        return D.saveOrder(Object.assign({}, o, {
          syncStatus: status,
          executedPrice: r.executedPrice,
          livePrice: r.livePrice,
          adjusted: status === 'ADJUSTED',
          openOrder: status === 'OPEN',
          failed: /^FAILED/.test(status),
          note: r.reason || o.note || ''
        }));
      }));
      if (/^FAILED/.test(status)) jobs.push(rollback(r.clientOrderId));
    });
    return Promise.all(jobs);
  }

  /* a failed order never happened: put the optimistic money/units back */
  function rollback(clientOrderId) {
    return Promise.all([D.get('orders', clientOrderId), D.get('pending_sync', clientOrderId)]).then(function (r) {
      var rec = r[0] || r[1];
      if (!rec) return null;
      if (rec.rollbackApplied) return null;
      var jobs = [];
      if (rec.preCashUsd != null) jobs.push(D.savePortfolio({ cashUsd: Number(rec.preCashUsd) || 0 }));
      if (rec.preHoldingQty != null && rec.assetSymbol) jobs.push(D.saveHolding(rec.assetSymbol, { qty: Number(rec.preHoldingQty) || 0, avgPrice: Number(rec.preAvgPrice) || 0 }));
      return Promise.all(jobs).then(function () {
        return D.saveOrder(Object.assign({}, rec, { rollbackApplied: true }));
      });
    });
  }

  function flush(opts) {
    opts = opts || {};
    if (flushing) return Promise.resolve({ ok: false, busy: true });
    if (navigator.onLine === false) { emit('offline'); return Promise.resolve({ ok: false, offline: true }); }
    if (!D) return Promise.resolve({ ok: false, noStore: true });

    flushing = true;
    var userId = currentUserId();
    if (!userId) { flushing = false; return Promise.resolve({ ok: false, noUser: true }); }

    return D.pending().then(function (rows) {
      if (!rows.length) {
        flushing = false;
        return queueStats().then(function (s) { emit('idle', { stats: s }); return { ok: true, pushed: 0, stats: s }; });
      }
      banner('Syncing ' + rows.length + ' offline trade' + (rows.length === 1 ? '' : 's') + '…');
      emit('syncing', { count: rows.length });
      /* FIFO — the server also enforces the order */
      var batch = rows.slice(0, 25).map(function (o) { return { clientOrderId: o.clientOrderId, assetSymbol: o.assetSymbol, assetName: o.assetName, assetType: o.assetType, side: o.side, orderType: o.orderType, quantity: o.quantity, notionalAmount: o.notionalAmount, offlineSimulatedPrice: o.offlineSimulatedPrice, offlineTimestamp: o.offlineTimestamp, triggerPrice: o.triggerPrice }; });
      return fetch(api('/api/orders/offline/push'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: userId, email: '', orders: batch })
      }).then(function (res) {
        if (!res.ok) throw new Error('http_' + res.status);
        return res.json();
      }).then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || 'sync_failed');
        return applyResults(j.results).then(function () {
          /* the server is authoritative for cash + reservation */
          return D.savePortfolio({ cashUsd: Number(j.balanceUsd) || 0, reservedUsd: Number(j.reservedUsd) || 0, lastSyncAt: Date.now() });
        }).then(function () { return j.results || []; });
      }).then(function (results) {
        attempts = 0;
        stats.lastSyncAt = Date.now();
        stats.lastError = '';
        return queueStats().then(function (s) {
          banner('');
          var ok = results.filter(function (r) { return r.status === 'RECONCILED'; }).length;
          var adj = results.filter(function (r) { return r.status === 'ADJUSTED'; }).length;
          var open = results.filter(function (r) { return r.status === 'OPEN'; }).length;
          var bad = results.filter(function (r) { return /^FAILED/.test(r.status); }).length;
          var msg = [];
          if (ok) msg.push(ok + ' synced');
          if (adj) msg.push(adj + ' price-adjusted');
          if (open) msg.push(open + ' open limit/stop');
          if (bad) msg.push(bad + ' failed');
          if (msg.length) toast('Offline trades: ' + msg.join(' · '), bad ? 'warn' : 'ok');
          emit('synced', { results: results, stats: s, summary: msg.join(' · ') });
          return { ok: true, pushed: batch.length, results: results, stats: s, summary: msg.join(' · ') };
        });
      }).then(function (out) {
        flushing = false;
        return serverSnapshot().then(function (snap) { if (snap) return adopt(snap); return null; }).then(function () { return out; });
      }).catch(function (e) {
        flushing = false;
        attempts++;
        stats.lastError = e.message;
        banner('');
        if (!opts.silent) toast('Offline trades waiting to sync — will retry', 'warn');
        emit('error', { error: e.message });
        return { ok: false, error: e.message };
      });
    });
  }

  /* ------------------------------------------------------------- badges */
  function badge(status) {
    var map = {
      RECONCILED: ['Synced', '#2ee6c9'],
      ADJUSTED: ['Price adjusted', '#f5b544'],
      OPEN: ['Active limit order', '#7ab6ff'],
      FAILED_INSUFFICIENT_FUNDS: ['Failed · funds', '#ff5c6e'],
      FAILED: ['Failed', '#ff5c6e'],
      SYNCING: ['Syncing…', '#8ba7b8'],
      PENDING: ['Queued offline', '#f5b544']
    };
    var m = map[status] || null;
    if (!m) return '';
    return '<span class="wc-sync-tag" style="display:inline-block;font-size:9.5px;font-weight:800;letter-spacing:.03em;padding:2px 6px;border-radius:5px;color:' + m[1] + ';border:1px solid ' + m[1] + '55;background:' + m[1] + '12">' + m[0] + '</span>';
  }

  function decorateOrderRows(root) {
    (root || document).querySelectorAll('[data-client-order]').forEach(function (el) {
      if (el.__wcTagged) return;
      el.__wcTagged = true;
      var id = el.getAttribute('data-client-order');
      D.get('orders', id).then(function (o) {
        if (!o) return;
        var html = badge(o.syncStatus);
        if (html) el.insertAdjacentHTML('beforeend', ' ' + html);
      });
    });
  }

  /* --------------------------------------------------------------- wiring */
  function wire() {
    window.addEventListener('online', function () {
      setTimeout(function () { flush({ silent: false }); }, 900);
      bootstrap();
    });
    window.addEventListener('offline', function () { emit('offline'); });
    window.addEventListener('focus', function () { if (navigator.onLine !== false) flush({ silent: true }); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && navigator.onLine !== false) flush({ silent: true });
    });
    /* service worker Background Sync */
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.addEventListener) {
        navigator.serviceWorker.addEventListener('message', function (e) {
          var d = e.data || {};
          if (d.type === 'wc-sync-now' || d.type === 'wc-flush-pending') flush({ silent: true });
        });
      }
    } catch (e) {}

    setInterval(function () {
      if (navigator.onLine === false) return;
      queueStats().then(function (s) { if (s.pending > 0 && !flushing) flush({ silent: true }); });
    }, 60000);

    setInterval(function () { decorateOrderRows(); }, 4000);
  }

  function requestBackgroundSync() {
    try {
      if (!navigator.serviceWorker || !navigator.serviceWorker.ready) return;
      navigator.serviceWorker.ready.then(function (reg) {
        if (reg.sync && reg.sync.register) return reg.sync.register('wc-offline-trades');
        if (reg.periodicSync && reg.periodicSync.register) return reg.periodicSync.register('wc-offline-trades', { minInterval: 15 * 60 * 1000 });
        return null;
      }).catch(function () {});
    } catch (e) {}
  }

  window.WC_RECON = {
    bootstrap: bootstrap,
    requestBackgroundSync: requestBackgroundSync,
    flush: flush,
    queueStats: queueStats,
    adopt: adopt,
    badge: badge,
    decorate: decorateOrderRows,
    stats: function () { return stats; },
    onEvent: function (fn) { if (typeof fn === 'function') listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; },
    toast: toast,
    banner: banner
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { wire(); setTimeout(function () { bootstrap(); flush({ silent: true }); }, 2500); });
  else { wire(); setTimeout(function () { bootstrap(); flush({ silent: true }); }, 2500); }
})();
