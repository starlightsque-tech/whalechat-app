/* =========================================================================
   WhaleChat · WC-Investing server source of truth (wc-wc-server-sync)
   -------------------------------------------------------------------------
   The /api/wc/state endpoint settles daily interest on the server. This module
   makes that state the page's source of truth:

     · server wallet (capital / profit / leftover) replaces the local copy
     · server plan records win when they are ahead (more priceLog days, matured)
     · plans created locally while offline are kept and never overwritten
     · profit is REPLACED, never added, so an accrual cannot be counted twice

   It also registers the service worker's engine tick so bots + interest keep
   settling while the app is closed (see public/sw.js).
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcWcServerSync) return;
  window.__wcWcServerSync = true;

  var API = '';
  try { API = (window.WC_BUILD_CONFIG && window.WC_BUILD_CONFIG.syncServer) || 'https://whalechat-api.appwrite.network'; } catch (e) { API = 'https://whalechat-api.appwrite.network'; }
  var BUSY = false;
  var LAST_AT = 0;
  var LAST_SIG = '';

  function uid() { try { var u = me(); return u && u.id; } catch (e) { return ''; } }
  function wallet(u) {
    if (!u.investAcct) u.investAcct = { usd: 0, payout: 0, portfolios: { stock: 0, wc: 0, b2b: 0, bot: 0 } };
    var a = u.investAcct;
    if (!a.wcInvest || typeof a.wcInvest !== 'object') a.wcInvest = { capital: 0, profit: 0, leftover: 0, autoReinvest: false, plans: [], history: [] };
    if (!Array.isArray(a.wcInvest.plans)) a.wcInvest.plans = [];
    if (!Array.isArray(a.wcInvest.history)) a.wcInvest.history = [];
    return a.wcInvest;
  }
  function r2(v) { return Math.round((Number(v) || 0) * 100) / 100; }

  /* pure merge — exported for tests */
  function merge(local, server) {
    if (!server || !server.ok) return { changed: false, local: local };
    var w = local;
    var before = JSON.stringify({ c: w.capital, p: w.profit, l: w.leftover, n: (w.plans || []).length });
    var localPlans = Array.isArray(w.plans) ? w.plans : [];
    var byId = {};
    localPlans.forEach(function (p) { if (p && p.id) byId[p.id] = p; });
    var serverPlans = Array.isArray(server.investments) ? server.investments : [];
    var merged = [];
    var seen = {};
    serverPlans.forEach(function (sp) {
      if (!sp || !sp.id) return;
      seen[sp.id] = true;
      var lp = byId[sp.id];
      if (!lp) { merged.push(Object.assign({}, sp)); return; }
      var serverAhead = (sp.status === 'completed' && lp.status !== 'completed') ||
        ((sp.priceLog || []).length > (lp.priceLog || []).length) ||
        (Number(sp.accruedUsd) || 0) > 0 && (Number(lp.accruedUsd) || 0) === 0;
      merged.push(serverAhead ? Object.assign({}, lp, sp) : lp);
    });
    /* keep plans that only exist locally (created offline, not synced yet) */
    var localOnly = localPlans.filter(function (p) { return p && p.id && !seen[p.id] && p.status === 'active'; });
    merged = merged.concat(localOnly);
    w.plans = merged;

    var sw = server.wallet || {};
    if (!localOnly.length) {
      /* nothing unsynced: the server wallet is authoritative (REPLACE, no add) */
      w.capital = r2(sw.capitalUsd);
      w.profit = r2(sw.profitUsd);
      w.leftover = r2(sw.leftoverUsd);
      if (typeof sw.autoReinvest === 'boolean') w.autoReinvest = sw.autoReinvest;
    } else {
      /* keep the locally reserved capital for the unsynced plans */
      var reserved = localOnly.reduce(function (a, p) { return a + (Number(p.capitalUsd) || 0); }, 0);
      w.capital = r2((Number(sw.capitalUsd) || 0) - reserved);
      if (w.capital < 0) w.capital = 0;
      w.profit = r2(sw.profitUsd);
      w.leftover = r2(sw.leftoverUsd);
    }
    if (Array.isArray(server.history) && server.history.length) {
      var ids = {};
      w.history.forEach(function (h) { if (h && h.id) ids[h.id] = 1; });
      server.history.forEach(function (h) { if (h && h.id && !ids[h.id]) w.history.unshift(h); });
      if (w.history.length > 200) w.history.length = 200;
    }
    w.lastServerSyncAt = Date.now();
    var after = JSON.stringify({ c: w.capital, p: w.profit, l: w.leftover, n: (w.plans || []).length });
    return { changed: before !== after, local: w };
  }

  function save() {
    try { if (typeof persist === 'function') persist(); } catch (e) {}
    try { if (typeof render === 'function' && /^#\/invest\/shares/.test(location.hash || '')) render(); } catch (e) {}
  }

  async function sync(force) {
    var u = null;
    try { u = me(); } catch (e) {}
    if (!u) return false;
    if (BUSY) return false;
    if (!force && Date.now() - LAST_AT < 8000) return false;
    BUSY = true;
    LAST_AT = Date.now();
    try {
      var ctrl = new AbortController();
      var to = setTimeout(function () { ctrl.abort(); }, 12000);
      var r = await fetch(API + '/api/wc/state?userId=' + encodeURIComponent(u.id), { signal: ctrl.signal, cache: 'no-store', headers: { accept: 'application/json' } });
      var d = await r.json();
      clearTimeout(to);
      var w = wallet(u);
      var out = merge(w, d);
      var sig = JSON.stringify({ c: w.capital, p: w.profit, n: (w.plans || []).length, s: w.lastServerSyncAt });
      if (sig !== LAST_SIG) {
        LAST_SIG = sig;
        save();
      }
      return !!out.changed;
    } catch (e) {
      return false;
    } finally {
      BUSY = false;
    }
  }

  /* service worker periodic sync keeps the engine ticking while app is shut */
  function registerEngineSync() {
    try {
      if (!('serviceWorker' in navigator)) return;
      navigator.serviceWorker.ready.then(function (reg) {
        if (!reg) return;
        if (reg.periodicSync && reg.periodicSync.register) {
          reg.periodicSync.register('wc-engine-tick', { minInterval: 60000 }).catch(function () {});
        }
        if (reg.sync && reg.sync.register) reg.sync.register('wc-engine-tick').catch(function () {});
      }).catch(function () {});
    } catch (e) {}
  }

  /* while a tab is open, one silent tick per minute keeps bots/interest warm */
  setInterval(function () { sync(false); }, 12000);
  setInterval(function () {
    try { fetch(API + '/api/engine/tick', { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(function () {}); } catch (e) {}
  }, 60000);
  window.addEventListener('online', function () { sync(true); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) sync(true); });
  registerEngineSync();
  setTimeout(function () { sync(true); }, 1500);

  window.WC_WC_SYNC = { sync: sync, merge: merge, wallet: wallet };
})();
