/* =========================================================================
   WhaleChat admin · Connections  (wc-connections-admin)
   One page to connect and test: Binance (REST + websocket), Finnhub
   (REST + websocket), Brevo email, and to see where the settings are stored.
   Everything saved here is durable — a new release does not clear it.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || window.__wcConnAdmin) return;
  window.__wcConnAdmin = true;

  var C = window.WC_CONN = window.WC_CONN || {};
  var STATE = { status: null, busy: '', note: '' };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function me2() { try { return me(); } catch (e) { return null; } }
  function tmsg(m, t) { try { if (typeof toast === 'function') toast(m, t || 'ok'); } catch (e) {} }
  function url(p) {
    try { if (typeof Remote !== 'undefined' && Remote && Remote.url) return Remote.url(p); } catch (e) {}
    return p;
  }
  function dot(ok) { return '<i class="cn-dot ' + (ok ? 'ok' : 'off') + '"></i>'; }
  function kv(k, v) { return '<div class="cn-kv"><span>' + esc(k) + '</span><b>' + v + '</b></div>'; }

  C.load = async function () {
    var u = me2();
    try {
      var r = await fetch(url('/api/connections?adminId=' + encodeURIComponent(u && u.id)), { headers: { accept: 'application/json' } });
      var d = await r.json();
      if (d && d.ok) STATE.status = d;
      else STATE.note = (d && d.error) || 'Could not read the connection status';
    } catch (e) { STATE.note = e.message; }
    return STATE.status;
  };

  /* Load at most once at a time, and never re-render on failure: an offline
     device used to load → render → load … until the tab ran out of memory. */
  C.view = function () {
    if (!STATE.status && !STATE.loading && Date.now() > (STATE.retryAfter || 0)) {
      STATE.loading = true;
      C.load().then(function (status) {
        STATE.loading = false;
        if (status) { try { if (typeof render === 'function') render(); } catch (e) {} }
        else STATE.retryAfter = Date.now() + 15000;
      }).catch(function () { STATE.loading = false; STATE.retryAfter = Date.now() + 15000; });
    }
    var s = STATE.status;
    if (!s) {
      return '<div class="page-head"><div class="section-title" style="margin:0">Connections</div></div>' +
        '<div class="card"><div class="tiny muted">' + esc(STATE.note || 'Reading the connection status…') + '</div></div>';
    }
    var fin = s.finnhub || {}, bin = s.binance || {}, bre = s.brevo || {}, smtp = s.smtp || {}, st = s.storage || {};
    var finWs = fin.websocket || {};
    var binWs = bin.websocket || {};

    return '<div class="page-head"><div class="between"><div>' +
        '<div class="section-title" style="margin:0">Connections</div>' +
        '<div class="tiny muted">Price feeds, email and websockets · saved to ' + esc(st.database || 'file') + ' so a new release keeps them</div></div>' +
        '<button class="btn btn-sm btn-ghost" data-act="cn-reload">Refresh</button></div></div>' +

      /* Finnhub */
      '<div class="card cn-card"><div class="between"><div class="card-title" style="margin:0">' + dot(fin.configured) + ' Finnhub · stocks &amp; charts</div>' +
        '<span class="badge ' + (fin.configured ? 'badge-success' : '') + '">' + esc(fin.mode || 'simulated') + '</span></div>' +
        '<div class="cn-grid">' + kv('API key', esc(fin.key) || '—') + kv('Source', esc(fin.source || '—')) +
          kv('Websocket', finWs.connected ? 'connected' : finWs.state || 'idle') + kv('Chart history', 'Finnhub series') + '</div>' +
        '<div class="field" style="margin-top:10px"><label class="label">Finnhub API key</label>' +
          '<input class="input" id="cnFinnhubKey" type="password" placeholder="paste the key — stored on the server"/></div>' +
        '<div class="row" style="gap:8px"><button class="btn btn-primary btn-sm grow" data-act="cn-save-finnhub">Save Finnhub</button>' +
          '<button class="btn btn-ghost btn-sm grow" data-act="cn-test" data-which="finnhub">Test</button></div></div>' +

      /* Binance */
      '<div class="card cn-card"><div class="between"><div class="card-title" style="margin:0">' + dot(bin.enabled) + ' Binance · crypto &amp; meme coins</div>' +
        '<span class="badge ' + (bin.source === 'binance-ws' || bin.source === 'binance' ? 'badge-success' : 'badge-warn') + '">' + esc(bin.source || 'offline') + '</span></div>' +
        '<div class="cn-grid">' + kv('API key', esc(bin.key) || 'not required for public prices') +
          kv('Symbols', String(bin.symbols || 0)) + kv('Host', esc(bin.host || '—')) +
          kv('Websocket', binWs.connected ? 'connected · ' + (binWs.ticks || 0) + ' ticks' : 'reconnecting') + '</div>' +
        '<div class="field" style="margin-top:10px"><label class="label">Binance API key (optional)</label>' +
          '<input class="input" id="cnBinanceKey" type="password" placeholder="stored on the server, never shown again"/></div>' +
        '<label class="row" style="gap:8px;align-items:center;font-size:12px"><input type="checkbox" id="cnBinanceOn" ' + (bin.enabled ? 'checked' : '') + '/> Keep the Binance feed running</label>' +
        '<div class="row" style="gap:8px;margin-top:8px"><button class="btn btn-primary btn-sm grow" data-act="cn-save-binance">Save Binance</button>' +
          '<button class="btn btn-ghost btn-sm grow" data-act="cn-test" data-which="binance">Test</button></div></div>' +

      /* Brevo */
      '<div class="card cn-card"><div class="between"><div class="card-title" style="margin:0">' + dot(bre.configured) + ' Brevo · transactional email</div>' +
        '<span class="badge ' + (bre.configured ? 'badge-success' : 'badge-warn') + '">' + esc(bre.provider || 'none') + '</span></div>' +
        '<div class="cn-grid">' + kv('API key', esc(bre.key) || '—') + kv('Sender', esc(bre.from || '—')) +
          kv('SMTP fallback', smtp.configured ? 'configured' : 'not set') + kv('Alert emails', bre.configured ? 'sending' : 'paused') + '</div>' +
        '<div class="field" style="margin-top:10px"><label class="label">Brevo API key</label>' +
          '<input class="input" id="cnBrevoKey" type="password" placeholder="xkeysib-…"/></div>' +
        '<div class="field"><label class="label">Verified sender</label>' +
          '<input class="input" id="cnBrevoFrom" type="email" value="' + esc(bre.from || 'whalechat1@gmail.com') + '"/></div>' +
        '<div class="row" style="gap:8px"><button class="btn btn-primary btn-sm grow" data-act="cn-save-brevo">Save Brevo</button>' +
          '<button class="btn btn-ghost btn-sm grow" data-act="cn-test-email">Send test email</button></div></div>' +

      /* storage / persistence */
      '<div class="card cn-card"><div class="card-title" style="margin:0">Where these settings live</div>' +
        '<div class="cn-grid">' + kv('Backend', esc(st.database || 'file')) + kv('File copy', esc(st.file || '—')) +
          kv('Last saved', st.updatedAt ? new Date(st.updatedAt).toLocaleString() : '—') + kv('On new release', 'kept') + '</div>' +
        '<div class="tiny muted" style="margin-top:8px">Connections, user accounts and balances are written to the app database and mirrored to a file on the mounted disk. The build only regenerates the web bundle — it never clears data or settings.</div></div>' +
      (STATE.note ? '<div class="card"><div class="tiny down">' + esc(STATE.note) + '</div></div>' : '');
  };

  if (typeof App !== 'undefined') {
    App.cnReload = function () { C.load().then(function () { try { render(); } catch (e) {} }); };

    App.cnSaveFinnhub = async function () {
      await C.save({ finnhub: { apiKey: (document.getElementById('cnFinnhubKey') || {}).value || '', mode: 'hybrid' } });
    };
    App.cnSaveBinance = async function () {
      await C.save({ binance: { apiKey: (document.getElementById('cnBinanceKey') || {}).value || '', enabled: !!(document.getElementById('cnBinanceOn') || {}).checked } });
    };
    App.cnSaveBrevo = async function () {
      await C.save({ brevo: {
        apiKey: (document.getElementById('cnBrevoKey') || {}).value || '',
        from: (document.getElementById('cnBrevoFrom') || {}).value || 'whalechat1@gmail.com'
      } });
    };

    C.save = async function (body) {
      var u = me2();
      body.adminId = u && u.id;
      try {
        var r = await fetch(url('/api/connections'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        var d = await r.json();
        if (!d.ok) return tmsg(d.error || 'Could not save', 'err');
        STATE.status = d.status || STATE.status;
        tmsg('Saved · applied ' + ((d.applied || []).join(', ') || 'server defaults'), 'ok');
        try { render(); } catch (e) {}
      } catch (e) { tmsg('Save failed: ' + e.message, 'err'); }
    };

    App.cnTest = async function (id, ds) {
      var u = me2();
      var which = (ds && ds.which) || 'all';
      tmsg('Testing ' + which + '…', 'ok');
      try {
        var r = await fetch(url('/api/connections/test'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ adminId: u && u.id, which: which }) });
        var d = await r.json();
        var res = (d && d.results && d.results[which]) || {};
        var ok = which === 'binance' ? res.source === 'binance' || res.source === 'binance-ws' : (which === 'finnhub' ? !!res.hasKey || !!res.live : true);
        tmsg(ok ? which + ' is live' : which + ' is not reachable — check the key', ok ? 'ok' : 'err');
        await C.load();
        try { render(); } catch (e) {}
      } catch (e) { tmsg('Test failed: ' + e.message, 'err'); }
    };

    App.cnTestEmail = async function () {
      var u = me2();
      var to = (u && u.email) || '';
      try {
        var r = await fetch(url('/api/connections/test'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ adminId: u && u.id, which: 'brevo', to: to }) });
        var d = await r.json();
        var e = (d && d.results && d.results.email) || {};
        if (e.configured) tmsg('Test email queued to ' + to, 'ok');
        else tmsg('Email is not configured yet — save the Brevo key first', 'err');
      } catch (e) { tmsg('Test failed: ' + e.message, 'err'); }
    };
  }

  /* route: #/admin/connections */
  function patch() {
    if (typeof VIEWS === 'undefined' || !VIEWS.admin) return false;
    if (VIEWS.__wcConnAdmin) return true;
    var base = VIEWS.admin;
    VIEWS.admin = function (parts, params) {
      if ((parts[1] || '') === 'connections') return C.view();
      return base.apply(this, arguments);
    };
    VIEWS.__wcConnAdmin = true;
    return true;
  }
  var tries = 0;
  (function boot() {
    if (!patch()) { if (tries++ < 80) return setTimeout(boot, 400); return; }
    try {
      var nav = window.ADMIN_NAV;
      if (Array.isArray(nav) && !nav.some(function (n) { return n && n.key === 'admin-connections'; })) {
        nav.splice(Math.max(0, nav.length - 2), 0, { key: 'admin-connections', label: 'Connections', icon: 'shield', href: '#/admin/connections' });
      }
    } catch (e) {}
    C.load();
    setInterval(function () { C.load(); }, 30000);
  })();

  (function styles() {
    if (document.getElementById('cn-style')) return;
    var st = document.createElement('style'); st.id = 'cn-style';
    st.textContent = `
    .cn-card{margin-bottom:10px}
    .cn-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:9px}
    .cn-kv{display:flex;flex-direction:column;gap:1px;min-width:0}
    .cn-kv span{font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-2);font-weight:700}
    .cn-kv b{font-size:11.5px;overflow-wrap:anywhere}
    .cn-dot{display:inline-block;width:8px;height:8px;border-radius:99px;margin-right:6px;vertical-align:middle}
    .cn-dot.ok{background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.18)}
    .cn-dot.off{background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.16)}
    @media(max-width:520px){.cn-grid{grid-template-columns:1fr}}
    `;
    document.head.appendChild(st);
  })();
})();
