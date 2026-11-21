/* WhaleChat extras (module wc-extras): server URL field, admin guide notes,
   service-worker notifications, share-as-Whalechat.apk */
'use strict';
(function () {
  if (typeof window === 'undefined' || window.__wcExtras) return;
  window.__wcExtras = true;
  var HIST = 'wc_server_history';
  function hist() { try { return JSON.parse(localStorage.getItem(HIST) || '[]'); } catch (e) { return []; } }
  function addHist(u) { try { var h = hist().filter(function (x) { return x !== u; }); if (u) h.unshift(u); localStorage.setItem(HIST, JSON.stringify(h.slice(0, 5))); } catch (e) {} }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function hash() { return location.hash || ''; }

  /* 1. New server URL card on Admin > Servers */
  function serverCard() {
    var cur = (typeof Remote !== 'undefined' && Remote.base) || '';
    var h = hist();
    return '<div class="card" id="wcNewServer"><div class="card-title">New server URL</div>' +
      '<div class="tiny muted" style="margin:4px 0 10px">Moved hosts or got a new address? Paste it here. The app checks it is a WhaleChat server, then switches. Your data on this device stays; the server is seeded or synced as usual.</div>' +
      '<div class="row gap8"><input class="input" id="wcNewSrvUrl" placeholder="https://new-address.onrender.com" value="' + esc(cur) + '" style="flex:1"/>' +
      '<button class="btn btn-primary btn-sm" id="wcNewSrvGo">Connect</button></div>' +
      '<div class="tiny muted mt6" id="wcNewSrvMsg">' + (cur ? 'Current: ' + esc(cur) : 'Using the server that served this page.') + '</div>' +
      (h.length ? '<div class="tiny muted mt10">Recent: ' + h.map(function (u) { return '<a href="#" data-wcsrv="' + esc(u) + '">' + esc(u) + '</a>'; }).join(' · ') + '</div>' : '') + '</div>';
  }
  async function connectTo(url) {
    var msg = document.getElementById('wcNewSrvMsg');
    url = (url || '').trim();
    if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
    url = url.replace(/\/+$/, '');
    if (msg) msg.textContent = 'Checking server…';
    var ok = false;
    try { ok = await Remote.connect(url, { initFromLocal: true }); } catch (e) {}
    if (ok) { addHist(url); if (msg) msg.textContent = 'Connected to ' + (url || 'this origin'); try { toast('Server connected', 'ok'); } catch (e) {} }
    else if (msg) msg.textContent = 'Could not connect: ' + ((Remote && Remote.lastError) || 'not a WhaleChat server');
  }
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t && t.id === 'wcNewSrvGo') { connectTo(document.getElementById('wcNewSrvUrl').value); }
    var a = t && t.closest && t.closest('[data-wcsrv]');
    if (a) { e.preventDefault(); connectTo(a.getAttribute('data-wcsrv')); }
    var sh = t && t.closest && t.closest('[data-wcshare]');
    if (sh) { e.preventDefault(); shareApk(sh); }
  });

  /* 2. Admin trade guide notes */
  function guideNotes() {
    return '<details class="guide-sec" id="wcGuideData"><summary>Market data &amp; connections</summary><div class="guide-body" style="padding:10px 12px;line-height:1.7">' +
      '<p><b>Admin &gt; Markets</b> has three cards: Finnhub, Binance (API key) and Alpaca (key ID + secret). Press <b>Connect</b>, then <b>Test</b>. Keys are stored on the server only, never sent back to browsers, and re-applied after every restart or deploy.</p>' +
      '<p><b>Alpaca</b> supplies live US stock prices, refreshed about every 10 seconds. If no key is connected, prices shown may be simulated: say so to users.</p>' +
      '<p><b>Honest labelling:</b> trading here is virtual (Whale Coins). Do not tell users trades use real capital unless real money actually moves.</p></div></details>' +
      '<details class="guide-sec" id="wcGuideOffline"><summary>Offline use, alerts &amp; server address</summary><div class="guide-body" style="padding:10px 12px;line-height:1.7">' +
      '<p>Once installed, the app opens offline from its cache and shows the last saved data. Live prices, sync and push need a connection. Alerts triggered inside the app appear as device notifications when the app is in the background; alerts while fully closed need the server push (enable it in Admin &gt; Servers).</p>' +
      '<p>If the host address changes, paste it under <b>Admin &gt; Servers &gt; New server URL</b>.</p></div></details>';
  }

  /* 3. Share as Whalechat.apk */
  async function shareApk(btn) {
    var old = btn.textContent; btn.textContent = 'Preparing…';
    try {
      var r = await fetch('/whalechat.apk'); if (!r.ok) throw new Error('apk');
      var f = new File([await r.blob()], 'Whalechat.apk', { type: 'application/vnd.android.package-archive' });
      if (navigator.canShare && navigator.canShare({ files: [f] })) await navigator.share({ files: [f], title: 'Whalechat' });
      else { var a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = 'Whalechat.apk'; a.click(); }
    } catch (e) { if (e && e.name !== 'AbortError') { try { toast('Could not share the app file', 'err'); } catch (x) {} } }
    btn.textContent = old;
  }
  function shareCard() {
    return '<div class="card" id="wcShareApp"><div class="card-title">Share Whalechat</div><div class="tiny muted" style="margin:4px 0 10px">Sends the app file named Whalechat.apk.</div><button class="btn btn-primary btn-sm" data-wcshare="1">Share app file</button></div>';
  }

  /* 4. Notifications through the service worker (works on Android) */
  function patchNotify() {
    if (typeof window.notify !== 'function' || window.notify.__wc) return;
    var orig = window.notify;
    window.notify = function (userId, title, body) {
      var r = orig.apply(this, arguments);
      try {
        if (document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted' && SESSION && SESSION.userId === userId && navigator.serviceWorker) {
          navigator.serviceWorker.ready.then(function (reg) {
            reg.showNotification(title, { body: body, icon: LOGO, badge: LOGO, tag: 'wc-' + userId, renotify: true, vibrate: [120, 60, 120] });
          });
        }
      } catch (e) {}
      return r;
    };
    window.notify.__wc = true;
  }
  if ('serviceWorker' in navigator && !navigator.serviceWorker.controller) { try { navigator.serviceWorker.register('./sw.js'); } catch (e) {} }

  /* 5. Fallback: if saved server is unreachable, try recent ones */
  setTimeout(async function () {
    try {
      if (typeof Remote === 'undefined' || Remote.enabled || !navigator.onLine) return;
      var h = hist();
      for (var i = 0; i < h.length; i++) { if (await Remote.connect(h[i], { silent: true, initFromLocal: true })) return; }
    } catch (e) {}
  }, 9000);
  setInterval(function () { try { if (Remote && Remote.enabled && Remote.base) addHist(Remote.base); } catch (e) {} }, 15000);

  /* DOM injection after each route render */
  function inject() {
    patchNotify();
    var h = hash(), c = document.getElementById('content');
    if (!c) return;
    if (/^#\/admin\/servers/.test(h) && document.getElementById('ltServersWrap') && !document.getElementById('wcNewServer') && c.querySelector('.page-head')) {
      c.querySelector('.page-head').insertAdjacentHTML('afterend', serverCard());
    }
    if (/^#\/admin\/(trade-guide|markets)/.test(h) || /^#\/how-it-works/.test(h) === false) {
      var g = document.getElementById('tradingGuideCard') || (/^#\/admin\/trade-guide/.test(h) ? c.querySelector('.guide-sec') && c.querySelector('.guide-sec').parentNode : null);
      if (g && !document.getElementById('wcGuideData')) g.insertAdjacentHTML('beforeend', guideNotes());
    }
    if (/^#\/(how-it-works|profile|account|settings)/.test(h) && !document.getElementById('wcShareApp') && !window.__WC_NATIVE__) {
      c.insertAdjacentHTML('beforeend', shareCard());
    }
  }
  new MutationObserver(function () { clearTimeout(inject.t); inject.t = setTimeout(inject, 120); }).observe(document.documentElement, { childList: true, subtree: true });
})();
