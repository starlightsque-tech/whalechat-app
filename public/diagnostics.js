/* =========================================================================
   WhaleChat diagnostics  (wc-diagnostics)
   -------------------------------------------------------------------------
   A hidden, read-only health panel. It is deliberately not linked anywhere in
   the UI. Reach it by:

     · opening  #/diagnostics         (or #/diag)
     · tapping the WhaleChat logo 5 times quickly
     · Ctrl/Cmd + Shift + D
     · from code: WC_DIAGNOSTICS.open()

   It reports: service-worker registration + cache contents and file count,
   IndexedDB API cache size and age, the local data mirror, outbox depth, the
   last alert evaluation, notification permission and push subscription,
   storage quota and the cached build manifest.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcDiagnostics) return;
  window.__wcDiagnostics = true;

  var OF = window.WC_OFFLINE;
  var OD = window.WC_OFFLINE_DATA;
  var D = window.WC_DIAGNOSTICS = { version: '3.49.0', open: open, close: close, report: null };

  function safe(fn, dflt) { try { return fn(); } catch (e) { return dflt; } }
  function kb(n) { n = Number(n) || 0; return n > 1048576 ? (n / 1048576).toFixed(2) + ' MB' : n > 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B'; }
  function ago(ts) {
    if (!ts) return 'never';
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  /* ------------------------------------------------------------- collectors */
  async function collect() {
    var out = {
      at: Date.now(),
      online: navigator.onLine,
      conn: (navigator.connection && (navigator.connection.effectiveType || navigator.connection.type)) || 'unknown',
      ua: navigator.userAgent,
      sw: { supported: 'serviceWorker' in navigator, state: 'unsupported', controller: false, scope: '', script: '' },
      caches: [],
      cacheFileCount: 0,
      api: { entries: 0, bytes: 0, newest: 0, oldest: 0 },
      mirror: {},
      outbox: 0,
      alerts: { lastRun: 0, checked: 0, notified: 0, error: '' },
      notifications: { permission: 'unsupported', push: 'unknown' },
      storage: { usage: 0, quota: 0 },
      manifest: { version: '', assets: 0 },
      version: safe(function () { return APP_VERSION; }, '?'),
      build: safe(function () { return APP_BUILD; }, '?')
    };

    /* service worker */
    try {
      if ('serviceWorker' in navigator) {
        var reg = await navigator.serviceWorker.getRegistration();
        if (reg) {
          var w = reg.active || reg.waiting || reg.installing;
          out.sw.state = w ? w.state : 'none';
          out.sw.scope = reg.scope;
          out.sw.controller = !!navigator.serviceWorker.controller;
          out.sw.script = (w && w.scriptURL) || '';
        } else {
          out.sw.state = 'not-registered';
        }
      }
    } catch (e) {}

    /* caches / file count */
    try {
      var names = await caches.keys();
      for (var i = 0; i < names.length; i++) {
        var c = await caches.open(names[i]);
        var keys = await c.keys();
        out.caches.push({ name: names[i], entries: keys.length });
        out.cacheFileCount += keys.length;
      }
      out.caches.sort(function (a, b) { return b.entries - a.entries; });
    } catch (e) {}

    /* IndexedDB API cache */
    try {
      if (OF && OF.all) {
        var api = await OF.all('api');
        out.api.entries = api.length;
        api.forEach(function (v) {
          if (!v) return;
          out.api.bytes += (v.body ? v.body.length : 0);
          if (v.at > out.api.newest) out.api.newest = v.at;
          if (!out.api.oldest || v.at < out.api.oldest) out.api.oldest = v.at;
        });
        var stores = ['messages', 'chats', 'profiles', 'products', 'cart', 'orders', 'txs', 'outbox'];
        for (var s = 0; s < stores.length; s++) {
          out.mirror[stores[s]] = await OF.count(stores[s]);
        }
        out.outbox = out.mirror.outbox || 0;
      }
    } catch (e) {}

    /* alerts */
    out.alerts.lastRun = (OF && OF.lastAlertRun) || 0;
    out.alerts.checked = (OF && OF.alertsChecked) || 0;
    out.alerts.notified = (OF && OF.notifications) || 0;
    var acct = safe(function () { return me() && me().investAcct; }, null);
    out.alerts.configured = !!(acct && Array.isArray(acct.b2bAlerts) && acct.b2bAlerts.length);
    out.alerts.count = (acct && acct.b2bAlerts && acct.b2bAlerts.length) || 0;

    /* notifications */
    out.notifications.permission = (typeof Notification !== 'undefined') ? Notification.permission : 'unsupported';
    try {
      if ('serviceWorker' in navigator && 'PushManager' in window) {
        var reg2 = await navigator.serviceWorker.ready;
        var sub = await reg2.pushManager.getSubscription();
        out.notifications.push = sub ? 'subscribed' : 'not-subscribed';
      }
    } catch (e) { out.notifications.push = 'unavailable'; }

    /* storage quota */
    try {
      if (navigator.storage && navigator.storage.estimate) {
        var est = await navigator.storage.estimate();
        out.storage.usage = est.usage || 0;
        out.storage.quota = est.quota || 0;
      }
    } catch (e) {}

    /* build manifest */
    try {
      var r = await fetch('./offline-manifest.json', { cache: 'no-store' });
      if (r.ok) {
        var m = await r.json();
        out.manifest.version = m.version || '';
        out.manifest.assets = (m.assets || []).length;
        out.manifest.builtAt = m.builtAt || '';
      }
    } catch (e) {}

    D.report = out;
    return out;
  }

  /* -------------------------------------------------------------------- UI */
  function row(label, value, kind) {
    return '<div class="wc-dg-row"><span>' + esc(label) + '</span><b class="' + (kind || '') + '">' + esc(value) + '</b></div>';
  }
  function section(title, body) {
    return '<div class="wc-dg-sec"><h4>' + esc(title) + '</h4>' + body + '</div>';
  }

  function paint(r) {
    var body = document.getElementById('wcDiagBody');
    if (!body) return;
    var okCls = function (cond) { return cond ? 'good' : 'bad'; };
    var html = '';

    html += section('App', [
      row('Version', r.version + ' (' + r.build + ')'),
      row('Connectivity', r.online ? 'online' : 'OFFLINE', r.online ? 'good' : 'warn'),
      row('Network type', r.conn),
      row('Build manifest', r.manifest.version + ' · ' + r.manifest.assets + ' files')
    ].join(''));

    html += section('Service worker', [
      row('Supported', r.sw.supported ? 'yes' : 'no'),
      row('State', r.sw.state, r.sw.state === 'activated' ? 'good' : 'warn'),
      row('Controlling page', r.sw.controller ? 'yes' : 'no', okCls(r.sw.controller)),
      row('Offline files cached', String(r.cacheFileCount), okCls(r.cacheFileCount > 50)),
      r.caches.map(function (c) { return row('cache ' + c.name, c.entries + ' entries'); }).join('')
    ].join(''));

    html += section('IndexedDB · API cache', [
      row('Entries', String(r.api.entries), okCls(r.api.entries > 0)),
      row('Size', kb(r.api.bytes)),
      row('Newest', r.api.newest ? ago(r.api.newest) : 'empty'),
      row('Oldest', r.api.oldest ? ago(r.api.oldest) : 'empty')
    ].join(''));

    html += section('IndexedDB · device data', [
      row('Messages', String(r.mirror.messages || 0)),
      row('Chats', String(r.mirror.chats || 0)),
      row('Profiles', String(r.mirror.profiles || 0)),
      row('Products', String(r.mirror.products || 0)),
      row('Cart lines', String(r.mirror.cart || 0)),
      row('Orders', String(r.mirror.orders || 0)),
      row('Outbox / sync queue', String(r.outbox), r.outbox ? 'warn' : 'good')
    ].join(''));

    html += section('Price alerts', [
      row('Last evaluation', ago(r.alerts.lastRun), r.alerts.lastRun ? 'good' : 'bad'),
      row('Alerts configured', r.alerts.configured ? r.alerts.count + ' active' : 'none'),
      row('Targets evaluated', String(r.alerts.checked)),
      row('Device notifications sent', String(r.alerts.notified))
    ].join(''));

    html += section('Notifications', [
      row('Permission', r.notifications.permission, r.notifications.permission === 'granted' ? 'good' : 'warn'),
      row('Push subscription', r.notifications.push, r.notifications.push === 'subscribed' ? 'good' : 'warn')
    ].join(''));

    html += section('Storage', [
      row('Used', kb(r.storage.usage)),
      row('Quota', r.storage.quota ? kb(r.storage.quota) : 'unknown')
    ].join(''));

    body.innerHTML = html;
    var stamp = document.getElementById('wcDiagStamp');
    if (stamp) stamp.textContent = 'checked ' + new Date(r.at).toLocaleTimeString();
  }

  async function refresh() {
    try { paint(await collect()); } catch (e) {}
  }

  function open() {
    if (document.getElementById('wcDiag')) { refresh(); return; }
    var wrap = document.createElement('div');
    wrap.id = 'wcDiag';
    wrap.className = 'wc-dg';
    wrap.innerHTML =
      '<div class="wc-dg-card" role="dialog" aria-label="WhaleChat diagnostics">' +
        '<div class="wc-dg-head"><div><b>Diagnostics</b><span id="wcDiagStamp">reading…</span></div>' +
          '<button class="wc-dg-x" id="wcDiagClose" aria-label="Close">✕</button></div>' +
        '<div class="wc-dg-body" id="wcDiagBody"></div>' +
        '<div class="wc-dg-foot">' +
          '<button id="wcDiagRefresh">Re-check</button>' +
          '<button id="wcDiagAlerts">Run alert check</button>' +
          '<button id="wcDiagCopy">Copy report</button>' +
          '<button id="wcDiagClear" class="danger">Clear API cache</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);
    document.getElementById('wcDiagClose').onclick = close;
    document.getElementById('wcDiagRefresh').onclick = refresh;
    document.getElementById('wcDiagAlerts').onclick = function () {
      safe(function () { if (OF && OF.evaluateAlerts) OF.evaluateAlerts(); });
      setTimeout(refresh, 400);
    };
    document.getElementById('wcDiagCopy').onclick = function () {
      var txt = JSON.stringify(D.report || {}, null, 2);
      try {
        navigator.clipboard.writeText(txt);
        toastSafe('Report copied');
      } catch (e) { console.log(txt); }
    };
    document.getElementById('wcDiagClear').onclick = async function () {
      if (!confirm('Clear the offline API cache? Cached prices, chats and portfolios will be fetched again on next connection.')) return;
      if (OF && OF.clear) await OF.clear('api');
      try {
        var names = await caches.keys();
        await Promise.all(names.filter(function (n) { return n.indexOf('wc-api') === 0; }).map(function (n) { return caches.delete(n); }));
      } catch (e) {}
      toastSafe('Offline API cache cleared');
      refresh();
    };
    refresh();
    setInterval(function () { if (!document.getElementById('wcDiag')) return; refresh(); }, 4000);
  }

  function close() {
    var el = document.getElementById('wcDiag');
    if (el) el.remove();
  }

  function toastSafe(m) { safe(function () { if (typeof toast === 'function') toast(m, 'ok'); }); }

  /* ---------------------------------------------------------------- styles */
  function styles() {
    if (document.getElementById('wc-dg-styles')) return;
    var st = document.createElement('style');
    st.id = 'wc-dg-styles';
    st.textContent =
      '.wc-dg{position:fixed;inset:0;z-index:10050;display:flex;align-items:flex-end;justify-content:center;' +
      'background:rgba(2,10,16,.72);backdrop-filter:blur(6px);font:13px/1.45 Inter,-apple-system,Segoe UI,Roboto,sans-serif}' +
      '.wc-dg-card{width:100%;max-width:520px;max-height:88vh;display:flex;flex-direction:column;background:#07141d;' +
      'border:1px solid rgba(46,230,201,.2);border-radius:18px 18px 0 0;box-shadow:0 -20px 60px rgba(0,0,0,.55);overflow:hidden}' +
      '.wc-dg-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.07)}' +
      '.wc-dg-head b{font-size:15px;color:#e9f4f9;display:block}' +
      '.wc-dg-head span{font-size:11px;color:#63798a}' +
      '.wc-dg-x{background:transparent;border:0;color:#63798a;font-size:15px;cursor:pointer;padding:6px}' +
      '.wc-dg-body{overflow-y:auto;padding:6px 16px 12px;-webkit-overflow-scrolling:touch}' +
      '.wc-dg-sec{margin:12px 0 4px}' +
      '.wc-dg-sec h4{margin:0 0 6px;font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:#5d7a8c}' +
      '.wc-dg-row{display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.045)}' +
      '.wc-dg-row span{color:#8ba4b6;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.wc-dg-row b{color:#e9f4f9;font-weight:600;text-align:right;word-break:break-word}' +
      '.wc-dg-row b.good{color:#2ee6c9}.wc-dg-row b.bad{color:#ff6b6b}.wc-dg-row b.warn{color:#ffc400}' +
      '.wc-dg-foot{display:flex;gap:8px;flex-wrap:wrap;padding:12px 16px calc(env(safe-area-inset-bottom,0px) + 14px);border-top:1px solid rgba(255,255,255,.07)}' +
      '.wc-dg-foot button{flex:1 1 auto;padding:9px 12px;border-radius:10px;border:1px solid rgba(46,230,201,.25);' +
      'background:rgba(46,230,201,.08);color:#bff5ec;font-weight:600;font-size:11.5px;cursor:pointer}' +
      '.wc-dg-foot button.danger{border-color:rgba(255,107,107,.3);background:rgba(255,107,107,.08);color:#ffb3b3}' +
      '@media(min-width:640px){.wc-dg{align-items:center}.wc-dg-card{border-radius:18px;max-height:82vh}}';
    document.head.appendChild(st);
  }

  /* ----------------------------------------------------------- hidden access */
  function bind() {
    styles();
    /* hash route */
    var checkHash = function () {
      var h = String(location.hash || '');
      if (h === '#/diagnostics' || h === '#/diag') open();
    };
    window.addEventListener('hashchange', checkHash);
    setTimeout(checkHash, 1200);

    /* five quick taps on the logo */
    var taps = [];
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      var isLogo = t.closest('img[src*="logo"], .brand, [data-logo]');
      if (!isLogo) return;
      var now = Date.now();
      taps = taps.filter(function (x) { return now - x < 3000; });
      taps.push(now);
      if (taps.length >= 5) { taps = []; open(); }
    }, true);

    /* keyboard */
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && String(e.key).toLowerCase() === 'd') {
        e.preventDefault();
        open();
      }
      if (String(e.key) === 'Escape') close();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
