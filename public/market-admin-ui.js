/* =========================================================================
   WhaleChat · Admin → Market Controls (3.46)
   #/admin/market-controls
   - global trading controls (pause all, pause new trades, maintenance)
   - providers: enable/disable, Binance testnet, encrypted API keys, test
   - tradable symbols: tradable / visible, min/max amount, leverage, decimals
     (there is deliberately no price field: prices come only from providers)
   - admin audit log (admin_logs)
   Users: a banner on market/trade pages while trading is paused.
   ========================================================================= */
(function () {
  'use strict';
  if (window.__wcMarketAdminUi) return; window.__wcMarketAdminUi = true;

  function url(p) { try { if (typeof Remote !== 'undefined' && Remote && Remote.enabled && Remote.url) return Remote.url(p); } catch (e) {} return p; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function $(id) { return document.getElementById(id); }
  function note(m, t) { try { if (typeof toast === 'function') toast(m, t || 'ok'); } catch (e) {} }
  function jget(p) { return fetch(url(p), { headers: { accept: 'application/json' } }).then(function (r) { return r.json(); }); }
  function jpost(p, b) { return fetch(url(p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }).then(function (r) { return r.json(); }); }
  function isAdminUser() { try { var u = me(); return !!(u && u.role === 'admin'); } catch (e) { return false; } }
  function when(t) { if (!t) return '—'; try { return new Date(t).toLocaleString(); } catch (e) { return String(t); } }
  var NAMES = { binance: 'Binance', twelvedata: 'Twelve Data', finnhub: 'Finnhub' };
  var state = { data: null, type: 'crypto', logFilter: '' };

  /* ------------------------------ admin page ------------------------------ */
  function testBadge(p) {
    var s = p.last_test_status || 'not_tested';
    var cls = s === 'success' ? 'badge-ok' : s === 'failed' ? 'badge-danger' : 'badge-warn';
    var txt = s === 'success' ? 'Test passed' : s === 'failed' ? 'Test failed' : 'Not tested';
    return '<span class="badge ' + cls + '" title="' + esc(p.last_test_error || '') + '">' + txt + '</span>';
  }
  function controlsHtml(c) {
    function tg(id, label, on, hint) { return '<label class="row" style="gap:8px;margin-top:10px;align-items:flex-start"><input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + '/><span><span class="small" style="font-weight:600">' + label + '</span><br><span class="tiny muted">' + hint + '</span></span></label>'; }
    return '<div class="card"><div class="between"><div><div class="card-title" style="margin:0">Trading controls</div><div class="tiny muted" style="margin-top:3px">Pause trading globally. This never changes a price.</div></div>' +
      (c.trading_paused || c.maintenance_mode ? '<span class="badge badge-danger">Paused</span>' : c.new_trades_only_paused ? '<span class="badge badge-warn">New trades paused</span>' : '<span class="badge badge-ok">Trading live</span>') + '</div>' +
      tg('mcPaused', 'Pause all trading', c.trading_paused, 'Blocks opening and closing trades and spot buys/sells.') +
      tg('mcNewOnly', 'Pause new trades only', c.new_trades_only_paused, 'Users can still close open positions.') +
      tg('mcMaint', 'Maintenance mode', c.maintenance_mode, 'Blocks all trading actions during maintenance.') +
      '<div class="field" style="margin-top:10px"><label class="label">Reason shown to users</label><input class="input" id="mcReason" maxlength="500" value="' + esc(c.pause_reason || '') + '" placeholder="e.g. Scheduled maintenance until 22:00 UTC"/></div>' +
      '<div class="row" style="gap:8px;margin-top:10px"><button class="btn btn-primary" data-mc="controls">Save controls</button><span class="tiny muted">Last change: ' + when(c.updated_at) + '</span></div></div>';
  }
  function providerHtml(p, encReady) {
    var n = p.provider_name, keyNote = p.key_source === 'legacy' ? 'Using a key saved before 3.46 (not encrypted). Save it again here to encrypt it.' : p.key_source === 'encrypted' ? 'Key stored encrypted.' : (n === 'binance' ? 'Public market data works without a key.' : 'No key saved.');
    return '<div class="card" style="margin-top:12px"><div class="between" style="align-items:flex-start;gap:10px"><div><div class="card-title" style="margin:0">' + NAMES[n] + '</div><div class="tiny muted" style="margin-top:3px">' + esc(keyNote) + '</div></div>' + testBadge(p) + '</div>' +
      '<label class="row" style="gap:8px;margin-top:10px"><input type="checkbox" data-pf="enabled" data-p="' + n + '"' + (p.is_enabled ? ' checked' : '') + '/> <span class="small">Provider enabled</span></label>' +
      (n === 'binance' ? '<label class="row" style="gap:8px;margin-top:6px"><input type="checkbox" data-pf="testnet" data-p="' + n + '"' + (p.is_testnet ? ' checked' : '') + '/> <span class="small">Use Binance Testnet</span></label>' : '') +
      '<div class="field" style="margin-top:10px"><label class="label">API key</label><input class="input" type="password" autocomplete="new-password" data-pf="key" data-p="' + n + '" placeholder="' + (p.has_key ? '•••••••• saved (leave empty to keep)' : 'Paste API key') + '"' + (encReady ? '' : ' disabled') + '/></div>' +
      (n === 'binance' ? '<div class="field" style="margin-top:8px"><label class="label">Secret key</label><input class="input" type="password" autocomplete="new-password" data-pf="secret" data-p="' + n + '" placeholder="' + (p.has_secret ? '•••••••• saved (leave empty to keep)' : 'Paste secret key') + '"' + (encReady ? '' : ' disabled') + '/></div>' : '') +
      '<div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap"><button class="btn btn-primary" data-mc="provider" data-p="' + n + '">Save</button><button class="btn" data-mc="test" data-p="' + n + '">Test connection</button>' +
      (p.has_key && p.key_source === 'encrypted' ? '<button class="btn btn-ghost" data-mc="clearkey" data-p="' + n + '">Remove key</button>' : '') + '</div>' +
      '<div class="tiny muted mt6">Last test: ' + when(p.last_test_at) + (p.last_test_error ? ' · ' + esc(p.last_test_error) : '') + '</div></div>';
  }
  function symbolRow(s) {
    var k = esc(s.symbol);
    function n(f, v, w, step) { return '<input class="input" style="width:' + w + 'px;padding:4px 6px" type="number" step="' + (step || 'any') + '" data-sf="' + f + '" value="' + esc(v == null ? '' : v) + '"/>'; }
    return '<tr data-sym="' + k + '"><td><b>' + k + '</b><div class="tiny muted">' + esc(s.display_name) + '</div></td>' +
      '<td class="tiny">' + esc(NAMES[s.provider_name] || s.provider_name) + '<div class="muted">' + esc(s.provider_symbol) + '</div></td>' +
      '<td><input type="checkbox" data-sf="is_tradable"' + (s.is_tradable ? ' checked' : '') + '/></td>' +
      '<td><input type="checkbox" data-sf="is_visible"' + (s.is_visible ? ' checked' : '') + '/></td>' +
      '<td>' + n('min_trade_amount', s.min_trade_amount, 80, '0.01') + '</td><td>' + n('max_trade_amount', s.max_trade_amount, 90, '0.01') + '</td>' +
      '<td>' + n('max_leverage', s.max_leverage, 56, '1') + '</td><td>' + n('price_decimals', s.price_decimals, 50, '1') + '</td>' +
      '<td><button class="btn btn-xs btn-primary" data-mc="symbol" data-s="' + k + '">Save</button></td></tr>';
  }
  function symbolsHtml(list) {
    var types = [['crypto', 'Crypto'], ['stock', 'Stocks'], ['forex', 'Forex']];
    var rows = list.filter(function (s) { return s.asset_type === state.type; });
    return '<div class="card" style="margin-top:12px"><div class="card-title" style="margin:0">Tradable symbols</div><div class="tiny muted" style="margin-top:3px">Turn symbols on or off and set trade limits. Prices cannot be edited: they come only from the providers. Keep leverage at 1 unless you are licensed to offer leverage.</div>' +
      '<div class="row" style="gap:6px;margin-top:10px;flex-wrap:wrap">' + types.map(function (t) { return '<button class="btn btn-sm ' + (state.type === t[0] ? 'btn-primary' : '') + '" data-mctype="' + t[0] + '">' + t[1] + '</button>'; }).join('') + '</div>' +
      '<div class="table-wrap" style="margin-top:10px"><table class="tbl"><thead><tr><th>Symbol</th><th>Provider</th><th>Tradable</th><th>Visible</th><th>Min $</th><th>Max $</th><th>Leverage</th><th>Decimals</th><th></th></tr></thead><tbody>' +
      (rows.map(symbolRow).join('') || '<tr><td colspan="9" class="tiny muted">No symbols of this type.</td></tr>') + '</tbody></table></div>' +
      '<details style="margin-top:12px"><summary class="small" style="cursor:pointer;font-weight:600">Add a symbol</summary>' +
      '<div class="row" style="gap:8px;flex-wrap:wrap;margin-top:8px">' +
      '<input class="input" id="mcNewSym" placeholder="Symbol, e.g. BINANCE:ARBUSDT" style="max-width:220px"/>' +
      '<input class="input" id="mcNewName" placeholder="Display name" style="max-width:180px"/>' +
      '<select class="input" id="mcNewType" style="max-width:120px"><option value="crypto">crypto</option><option value="stock">stock</option><option value="forex">forex</option></select>' +
      '<select class="input" id="mcNewProv" style="max-width:140px"><option value="binance">Binance</option><option value="twelvedata">Twelve Data</option><option value="finnhub">Finnhub</option></select>' +
      '<input class="input" id="mcNewPsym" placeholder="Provider symbol, e.g. ARBUSDT" style="max-width:200px"/>' +
      '<button class="btn btn-primary" data-mc="addsym">Add symbol</button></div></details></div>';
  }
  function logsHtml(logs) {
    return '<div class="card" style="margin-top:12px"><div class="between"><div><div class="card-title" style="margin:0">Admin audit log</div><div class="tiny muted" style="margin-top:3px">Every admin change, with the old and new value. Entries cannot be edited or deleted.</div></div>' +
      '<input class="input" id="mcLogFilter" placeholder="Filter by action" value="' + esc(state.logFilter) + '" style="max-width:180px"/></div>' +
      '<div class="table-wrap" style="margin-top:10px;max-height:420px;overflow:auto"><table class="tbl"><thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Entity</th><th>Old → New</th><th>IP</th></tr></thead><tbody>' +
      ((logs || []).map(function (l) {
        return '<tr><td class="tiny">' + esc(when(l.created_at)) + '</td><td class="tiny">' + esc(l.admin_email) + '</td><td class="tiny"><b>' + esc(l.action) + '</b></td><td class="tiny">' + esc((l.entity_type || '') + (l.entity_id ? ' · ' + l.entity_id : '')) + '</td>' +
          '<td class="tiny" style="max-width:340px;word-break:break-word"><span class="muted">' + esc(JSON.stringify(l.old_value)).slice(0, 300) + '</span><br>' + esc(JSON.stringify(l.new_value)).slice(0, 300) + '</td><td class="tiny">' + esc(l.ip_address || '') + '</td></tr>';
      }).join('') || '<tr><td colspan="6" class="tiny muted">No admin changes logged yet.</td></tr>') + '</tbody></table></div></div>';
  }
  function pageHtml(d, logs) {
    var warn = !d.encryptionReady ? '<div class="card" style="border-color:#dc2626"><b>WC_ENCRYPTION_KEY is not set on the server.</b><div class="tiny muted" style="margin-top:4px">API keys cannot be saved until you add this environment variable and restart.</div></div>' : '';
    var mem = d.storage !== 'postgres' ? '<div class="card"><div class="tiny muted">DATABASE_URL is not set: these settings and the audit log live in memory and reset on restart.</div></div>' : '';
    return '<div id="mcRoot">' + warn + mem + controlsHtml(d.controls) +
      '<div class="card" style="margin-top:12px"><div class="card-title" style="margin:0">Market data providers</div><div class="tiny muted" style="margin-top:3px">Prices shown to users come only from these providers, through the server price cache. If a provider fails, users see the last cached price labelled "Delayed Data".</div></div>' +
      d.providers.map(function (p) { return providerHtml(p, d.encryptionReady); }).join('') +
      symbolsHtml(d.symbols) + logsHtml(logs) + '</div>';
  }

  function load() {
    var wrap = $('mcWrap'); if (!wrap) return;
    Promise.all([jget('/api/admin/market/overview'), jget('/api/admin/logs?limit=100' + (state.logFilter ? '&action=' + encodeURIComponent(state.logFilter) : ''))]).then(function (r) {
      if (!r[0] || !r[0].ok) { wrap.innerHTML = '<div class="card"><div class="tiny muted">' + esc((r[0] && (r[0].message || r[0].error)) || 'Could not load market controls') + '. Unlock your admin session and reload.</div><button class="btn btn-primary mt6" data-mc="reload">Reload</button></div>'; bind(); return; }
      state.data = r[0];
      wrap.innerHTML = pageHtml(r[0], (r[1] && r[1].logs) || []);
      bind();
    }).catch(function () { wrap.innerHTML = '<div class="card"><div class="tiny muted">Could not load market controls.</div></div>'; });
  }
  function done(r, okMsg) { if (r && r.ok) { note(okMsg, 'ok'); load(); } else note((r && (r.error || r.message)) || 'Save failed', 'err'); }
  function bind() {
    var root = $('mcWrap'); if (!root) return;
    root.querySelectorAll('[data-mctype]').forEach(function (b) { b.onclick = function () { state.type = b.getAttribute('data-mctype'); load(); }; });
    var lf = $('mcLogFilter'); if (lf) lf.onchange = function () { state.logFilter = lf.value.trim(); load(); };
    root.querySelectorAll('[data-mc]').forEach(function (b) {
      b.onclick = function () {
        var act = b.getAttribute('data-mc'), p = b.getAttribute('data-p');
        if (act === 'reload') return load();
        if (act === 'controls') {
          var body = { trading_paused: $('mcPaused').checked, new_trades_only_paused: $('mcNewOnly').checked, maintenance_mode: $('mcMaint').checked, pause_reason: $('mcReason').value.trim() };
          if ((body.trading_paused || body.maintenance_mode) && !confirm('Pause trading for all users now?')) return;
          return jpost('/api/admin/market/controls', body).then(function (r) { done(r, 'Trading controls saved'); });
        }
        if (act === 'provider' || act === 'test' || act === 'clearkey') {
          var q = function (f) { return root.querySelector('[data-pf="' + f + '"][data-p="' + p + '"]'); };
          if (act === 'test') { b.disabled = true; return jpost('/api/admin/market/provider/test', { provider: p }).then(function (r) { b.disabled = false; done(r, r && r.provider && r.provider.last_test_status === 'success' ? NAMES[p] + ' connection works' : NAMES[p] + ' test failed'); }); }
          if (act === 'clearkey') { if (!confirm('Remove the saved ' + NAMES[p] + ' key?')) return; return jpost('/api/admin/market/provider', { provider: p, clear_key: true }).then(function (r) { done(r, 'Key removed'); }); }
          var body2 = { provider: p, is_enabled: q('enabled').checked };
          if (q('testnet')) body2.is_testnet = q('testnet').checked;
          if (q('key') && q('key').value.trim()) body2.api_key = q('key').value.trim();
          if (q('secret') && q('secret').value.trim()) body2.api_secret = q('secret').value.trim();
          return jpost('/api/admin/market/provider', body2).then(function (r) { done(r, NAMES[p] + ' saved'); });
        }
        if (act === 'symbol') {
          var row = b.closest('tr'), s = b.getAttribute('data-s'), body3 = { symbol: s };
          row.querySelectorAll('[data-sf]').forEach(function (i) { var f = i.getAttribute('data-sf'); body3[f] = i.type === 'checkbox' ? i.checked : i.value; });
          return jpost('/api/admin/market/symbol', body3).then(function (r) { done(r, s + ' saved'); });
        }
        if (act === 'addsym') {
          var body4 = { symbol: $('mcNewSym').value.trim(), display_name: $('mcNewName').value.trim(), asset_type: $('mcNewType').value, provider_name: $('mcNewProv').value, provider_symbol: $('mcNewPsym').value.trim() };
          return jpost('/api/admin/market/symbol', body4).then(function (r) { if (r && r.ok) state.type = body4.asset_type; done(r, body4.symbol + ' added'); });
        }
      };
    });
  }

  /* ------------------------- user trading banner -------------------------- */
  var ts = { at: 0, d: null };
  function bannerTick() {
    var on = /^#\/(markets|trade|market|invest)/.test(location.hash || '');
    var el = $('wcTradeStatusBanner');
    if (!on) { if (el) el.remove(); return; }
    var paint = function () {
      var d = ts.d, blocked = d && (d.trading_paused || d.maintenance_mode || d.new_trades_only_paused);
      el = $('wcTradeStatusBanner');
      if (!blocked) { if (el) el.remove(); return; }
      var msg = d.maintenance_mode ? 'Trading is unavailable during maintenance.' : d.trading_paused ? 'Trading is paused.' : 'New trades are paused. You can still close open positions.';
      if (d.pause_reason) msg += ' ' + d.pause_reason;
      if (!el) { el = document.createElement('div'); el.id = 'wcTradeStatusBanner'; el.setAttribute('style', 'position:sticky;top:0;z-index:50;background:#7c2d12;color:#fff;padding:8px 12px;font-size:13px;font-weight:600;text-align:center'); var main = document.querySelector('main') || document.body; main.insertBefore(el, main.firstChild); }
      el.textContent = msg;
    };
    if (Date.now() - ts.at > 30000) { ts.at = Date.now(); jget('/api/market/trading-status').then(function (d) { ts.d = d; paint(); }).catch(function () {}); } else paint();
  }
  window.addEventListener('hashchange', function () { setTimeout(bannerTick, 300); });
  setInterval(bannerTick, 5000);

  /* -------------------------------- wiring -------------------------------- */
  function wire() {
    if (typeof VIEWS === 'undefined' || !VIEWS.admin) return false;
    if (VIEWS.__wcMarketControls) return true;
    VIEWS.__wcMarketControls = true;
    var prev = VIEWS.admin;
    VIEWS.admin = function (parts, params) {
      var sub = parts[1] || '';
      if (sub === 'market-controls' || sub === 'market-data') {
        if (!isAdminUser()) return '<div class="card empty"><h3>Admin access only</h3></div>';
        setTimeout(load, 0);
        return '<div id="mcWrap"><div class="card"><div class="tiny muted">Loading market controls…</div></div></div>';
      }
      return prev.apply(this, arguments);
    };
    try {
      if (typeof ADMIN_NAV !== 'undefined') {
        for (var i = ADMIN_NAV.length - 1; i >= 0; i--) if (ADMIN_NAV[i] && ADMIN_NAV[i].key === 'admin-market-data') ADMIN_NAV.splice(i, 1);
        if (!ADMIN_NAV.some(function (n) { return n.key === 'admin-market-controls'; })) ADMIN_NAV.push({ key: 'admin-market-controls', label: 'Market Controls', icon: 'shield', href: '#/admin/market-controls' });
      }
    } catch (e) {}
    return true;
  }
  if (!wire()) { var n = 0, t = setInterval(function () { if (wire() || ++n > 80) clearInterval(t); }, 250); }
})();
