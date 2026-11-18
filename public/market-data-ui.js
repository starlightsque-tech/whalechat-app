/* =========================================================================
   WhaleChat · Market data UI
   - #/admin/market-data : provider keys (Binance, Finnhub, Twelve Data)
   - #/markets           : Crypto / US Stocks / Forex tabs, refresh every 3s
   - #/trade/:symbol     : Lightweight Charts candles + volume, live price line
   The browser only talks to this server (/api/market/*, /ws/market).
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || window.__wcMarketDataUi) return;
  window.__wcMarketDataUi = true;

  function url(p) { try { if (typeof Remote !== 'undefined' && Remote && Remote.enabled && Remote.url) return Remote.url(p); } catch (e) {} return p; }
  function adminId() { try { var u = me(); return u && u.id; } catch (e) { return ''; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function toastMsg(m, t) { try { if (typeof toast === 'function') toast(m, t || 'ok'); } catch (e) {} }
  function jget(p) { return fetch(url(p), { headers: { accept: 'application/json' } }).then(function (r) { return r.json(); }); }
  function jpost(p, b) { b.adminId = adminId(); return fetch(url(p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(function (r) { return r.json(); }); }
  function fmt(n) { n = +n; if (!isFinite(n)) return '--'; return n >= 100 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n >= 1 ? n.toFixed(4) : n.toFixed(6); }
  function sourceLabel(q) {
    if (!q) return '';
    if (q.delayed) return 'Delayed Data';
    return 'Live · ' + ({ binance: 'Binance', finnhub: 'Finnhub', twelvedata: 'Twelve Data' }[q.source] || q.source);
  }
  function $id(i) { return document.getElementById(i); }

  /* ---------------- admin page ---------------- */
  function badge(st) {
    var s = (st && st.state) || 'not_connected';
    var cls = s === 'connected' ? 'badge-ok' : s === 'error' ? 'badge-danger' : 'badge-warn';
    var txt = s === 'connected' ? 'Connected' : s === 'error' ? 'Error' : 'Not Connected';
    return '<span class="badge ' + cls + '" title="' + esc((st && st.error) || (st && st.note) || '') + '">' + txt + '</span>';
  }
  function card(id, title, sub, inner, st) {
    return '<div class="card" style="margin-top:12px"><div class="between" style="align-items:flex-start;gap:10px"><div><div class="card-title" style="margin:0">' + title + '</div><div class="tiny muted" style="margin-top:3px">' + sub + '</div></div><span id="' + id + 'Bd">' + badge(st) + '</span></div>' + inner +
      '<div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap"><button class="btn btn-primary" data-mdsave="' + id + '">Save</button><button class="btn" data-mdtest="' + id + '">Test Connection</button></div><div class="tiny muted mt6" id="' + id + 'Msg"></div></div>';
  }
  function inp(id, label, ph, has, type) {
    return '<div class="field" style="margin-top:10px"><label class="label">' + label + '</label><input class="input" id="' + id + '" type="' + (type || 'password') + '" autocomplete="new-password" placeholder="' + (has ? '•••••••• saved (leave empty to keep)' : ph) + '"/></div>';
  }
  function adminHtml(p) {
    return '<div class="card"><div class="card-title" style="margin:0">Market Data Providers</div><div class="tiny muted" style="margin-top:4px">Keys are stored on the server only. The app never calls these providers directly, and saved keys are never shown again.</div></div>' +
      card('mdBin', 'Binance', 'Crypto prices and candles. Public data works without a key.',
        inp('mdBinKey', 'API Key', 'Binance API key', p.binance.hasKey) + inp('mdBinSec', 'Secret Key', 'Binance secret key', p.binance.hasSecret) +
        '<label class="row" style="gap:8px;margin-top:10px"><input type="checkbox" id="mdBinTest"' + (p.binance.testnet ? ' checked' : '') + '/> <span class="tiny">Use Binance Testnet</span></label>', p.binance.status) +
      card('mdFin', 'Finnhub', 'US stock quotes (and candles where your plan allows).', inp('mdFinKey', 'API Key', 'Finnhub API key', p.finnhub.hasKey), p.finnhub.status) +
      card('mdTwd', 'Twelve Data', 'Forex and stock candles.', inp('mdTwdKey', 'API Key', 'Twelve Data API key', p.twelvedata.hasKey), p.twelvedata.status) +
      '<div class="card" style="margin-top:12px"><div class="tiny muted">Without a Finnhub key, stock symbols show clearly labelled demo data. Use the Alpaca and other connection cards in Admin &gt; Markets for the trading price cache.</div></div>';
  }
  function bodyFor(id) {
    var v = function (i) { var e = $id(i); return e ? e.value.trim() : ''; };
    if (id === 'mdBin') return { binance: { apiKey: v('mdBinKey'), secret: v('mdBinSec'), testnet: !!($id('mdBinTest') || {}).checked } };
    if (id === 'mdFin') return { finnhub: { apiKey: v('mdFinKey') } };
    return { twelvedata: { apiKey: v('mdTwdKey') } };
  }
  var WHICH = { mdBin: 'binance', mdFin: 'finnhub', mdTwd: 'twelvedata' };
  function mountAdmin() {
    var el = $id('mdAdminWrap'); if (!el) return;
    jget('/api/market/providers?adminId=' + encodeURIComponent(adminId())).then(function (d) {
      if (!d.ok) { el.innerHTML = '<div class="card"><div class="tiny muted">Could not load providers.</div></div>'; return; }
      el.innerHTML = adminHtml(d.providers);
      el.querySelectorAll('[data-mdsave]').forEach(function (b) { b.onclick = function () {
        var id = b.getAttribute('data-mdsave');
        jpost('/api/market/providers', bodyFor(id)).then(function (r) { $id(id + 'Msg').textContent = r.ok ? 'Saved on the server.' : 'Save failed.'; if (r.ok) { ['mdBinKey', 'mdBinSec', 'mdFinKey', 'mdTwdKey'].forEach(function (k) { var e = $id(k); if (e && bodyFor(id)) e.value = ''; }); $id(id + 'Bd').innerHTML = badge(r.providers[WHICH[id]].status); } });
      }; });
      el.querySelectorAll('[data-mdtest]').forEach(function (b) { b.onclick = function () {
        var id = b.getAttribute('data-mdtest'); $id(id + 'Msg').textContent = 'Testing…';
        jpost('/api/market/providers/test', { which: WHICH[id] }).then(function (r) { var st = r.result || {}; $id(id + 'Bd').innerHTML = badge(st); $id(id + 'Msg').textContent = st.state === 'connected' ? 'Connection works.' : ('Failed: ' + (st.error || 'unknown')); });
      }; });
    }).catch(function () { el.innerHTML = '<div class="card"><div class="tiny muted">Could not load providers.</div></div>'; });
  }

  /* ---------------- markets list ---------------- */
  var mTab = 'crypto', mTimer = null;
  function mountMarkets() {
    var el = $id('mdMarkets'); if (!el) return;
    el.querySelectorAll('[data-mdtab]').forEach(function (b) { b.onclick = function () { mTab = b.getAttribute('data-mdtab'); document.getElementById('mdMarketsRoot').outerHTML = marketsHtml(); mountMarkets(); }; });
    clearInterval(mTimer);
    function load() {
      if (!$id('mdRows')) { clearInterval(mTimer); return; }
      jget('/api/market/symbols?type=' + mTab).then(function (d) {
        return Promise.all((d.symbols || []).map(function (s) { return jget('/api/market/quote?symbol=' + s.symbol).then(function (q) { return q.quote; }).catch(function () { return null; }); }));
      }).then(function (qs) {
        var box = $id('mdRows'); if (!box) return;
        box.innerHTML = qs.filter(Boolean).map(function (q) {
          var up = +q.changePct >= 0;
          return '<div class="row between" style="padding:10px 0;border-bottom:1px solid var(--line,#2a2a2a);cursor:pointer" data-nav="#/trade/' + esc(q.symbol) + '"><div><b>' + esc(q.symbol) + '</b><div class="tiny muted">' + esc(sourceLabel(q)) + '</div></div><div style="text-align:right"><div>' + fmt(q.price) + '</div><div class="tiny" style="color:' + (up ? '#16a34a' : '#dc2626') + '">' + (isFinite(+q.changePct) ? (up ? '+' : '') + (+q.changePct).toFixed(2) + '%' : '') + '</div></div></div>';
        }).join('') || '<div class="tiny muted">No data.</div>';
        box.querySelectorAll('[data-nav]').forEach(function (n) { n.onclick = function () { location.hash = n.getAttribute('data-nav'); }; });
      });
    }
    load(); mTimer = setInterval(load, 3000);
  }
  function marketsHtml() {
    var tabs = [['crypto', 'Crypto'], ['stocks', 'US Stocks'], ['forex', 'Forex']].map(function (t) { return '<button class="btn ' + (mTab === t[0] ? 'btn-primary' : '') + '" data-mdtab="' + t[0] + '">' + t[1] + '</button>'; }).join(' ');
    return '<div id="mdMarketsRoot"><div class="card" id="mdMarkets"><div class="card-title">Markets</div><div class="row" style="gap:8px;margin:8px 0">' + tabs + '</div><div id="mdRows"><div class="tiny muted">Loading…</div></div><div class="tiny muted mt6">Refreshes every 3 seconds.</div></div></div>';
  }

  /* ---------------- trade / chart page ---------------- */
  var chartState = null;
  function loadLib() {
    return new Promise(function (res, rej) {
      if (window.LightweightCharts) return res();
      var s = document.createElement('script'); s.src = 'https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js';
      s.onload = res; s.onerror = function () { rej(new Error('chart library failed to load')); }; document.head.appendChild(s);
    });
  }
  function tradeHtml(sym) {
    var tfs = ['1m', '5m', '15m', '1H', '4H', '1D'].map(function (t) { return '<button class="btn ' + (t === '1H' ? 'btn-primary' : '') + '" data-mdtf="' + t + '">' + t + '</button>'; }).join(' ');
    return '<div class="card" id="mdTrade" data-sym="' + esc(sym) + '"><div class="between"><div><div class="card-title" style="margin:0">' + esc(sym) + '</div><div class="tiny muted" id="mdSrc">Price source: …</div></div><div style="text-align:right"><div id="mdPx" style="font-size:22px;font-weight:700">--</div><div class="tiny" id="mdChg"></div></div></div>' +
      '<div class="row" style="gap:6px;margin:10px 0;flex-wrap:wrap">' + tfs + '</div><div id="mdChart" style="width:100%;height:360px"></div><div class="tiny muted mt6" id="mdNote"></div>' +
      '<div class="row" style="gap:8px;margin-top:10px"><button class="btn" data-nav="#/markets">All markets</button><button class="btn btn-primary" data-nav="#/market">Open Invest &amp; trade</button></div></div>';
  }
  function showQuote(q) {
    if (!q || !$id('mdPx')) return;
    $id('mdPx').textContent = fmt(q.price);
    var up = +q.changePct >= 0; var c = $id('mdChg'); c.style.color = up ? '#16a34a' : '#dc2626'; c.textContent = isFinite(+q.changePct) ? (up ? '+' : '') + (+q.changePct).toFixed(2) + '%' : '';
    $id('mdSrc').textContent = 'Price source: ' + sourceLabel(q);
    if (chartState && chartState.line) { try { chartState.line.applyOptions({ price: q.price }); } catch (e) {} }
    if (chartState && chartState.series && chartState.last && q.price) {
      var l = chartState.last; l.close = q.price; l.high = Math.max(l.high, q.price); l.low = Math.min(l.low, q.price);
      try { chartState.series.update(l); } catch (e) {}
    }
    if (chartState) { try { if (chartState.pl) chartState.series.removePriceLine(chartState.pl); chartState.pl = chartState.series.createPriceLine({ price: +q.price, color: '#f59e0b', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'live' }); } catch (e) {} }
  }
  function mountTrade() {
    var root = $id('mdTrade'); if (!root) return;
    var sym = root.getAttribute('data-sym'), tf = '1H';
    if (chartState && chartState.ws) { try { chartState.ws.close(); } catch (e) {} }
    if (chartState && chartState.timer) clearInterval(chartState.timer);
    chartState = {};
    function drawCandles() {
      jget('/api/market/candles?symbol=' + sym + '&tf=' + tf).then(function (d) {
        if (!$id('mdChart') || !d.candles) return;
        var box = $id('mdChart'); box.innerHTML = '';
        var chart = LightweightCharts.createChart(box, { height: 360, width: box.clientWidth || 320, layout: { background: { color: 'transparent' }, textColor: '#9ca3af' }, grid: { vertLines: { color: '#1f2937' }, horzLines: { color: '#1f2937' } }, timeScale: { timeVisible: true } });
        var series = chart.addCandlestickSeries();
        var vol = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: '' });
        vol.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
        series.setData(d.candles.map(function (c) { return { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }; }));
        vol.setData(d.candles.map(function (c) { return { time: c.time, value: c.volume || 0, color: c.close >= c.open ? '#16a34a55' : '#dc262655' }; }));
        chartState.chart = chart; chartState.series = series; chartState.last = d.candles[d.candles.length - 1];
        $id('mdNote').textContent = d.source === 'demo' ? 'Demo data: no provider key is connected for this market.' : d.delayed ? 'Delayed Data: provider unavailable, showing last cached candles.' : 'Candles: ' + sourceLabel({ source: d.source });
      }).catch(function () { var n = $id('mdNote'); if (n) n.textContent = 'Chart data unavailable.'; });
    }
    root.querySelectorAll('[data-mdtf]').forEach(function (b) { b.onclick = function () {
      tf = b.getAttribute('data-mdtf'); root.querySelectorAll('[data-mdtf]').forEach(function (x) { x.classList.toggle('btn-primary', x === b); }); drawCandles();
    }; });
    root.querySelectorAll('[data-nav]').forEach(function (n) { n.onclick = function () { location.hash = n.getAttribute('data-nav'); }; });
    loadLib().then(function () {
      drawCandles();
      function poll() { jget('/api/market/quote?symbol=' + sym).then(function (d) { showQuote(d.quote); }).catch(function () {}); }
      poll();
      try {
        var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
        var base = url('/ws/market'); var wsUrl = /^https?:/.test(base) ? base.replace(/^http/, 'ws') : proto + location.host + '/ws/market';
        var ws = new WebSocket(wsUrl); chartState.ws = ws;
        ws.onopen = function () { ws.send(JSON.stringify({ sub: sym })); };
        ws.onmessage = function (m) { try { var d = JSON.parse(m.data); if (d.type === 'quote') showQuote(d.quote); } catch (e) {} };
        ws.onerror = function () { chartState.timer = setInterval(poll, 5000); };
        ws.onclose = function () { if (!chartState.timer && $id('mdTrade')) chartState.timer = setInterval(poll, 5000); };
      } catch (e) { chartState.timer = setInterval(poll, 5000); }
    }).catch(function (e) { var n = $id('mdNote'); if (n) n.textContent = e.message; });
  }

  /* ---------------- wiring ---------------- */
  function adminOnly() { return '<div class="card empty"><h3>Admin access only</h3></div>'; }
  function wire() {
    if (typeof VIEWS === 'undefined') return false;
    /* 3.46: the admin provider page moved to Admin -> Market Controls
       (market-admin-ui.js), which stores keys encrypted and logs changes */
    VIEWS.markets = function () { setTimeout(mountMarkets, 0); return marketsHtml(); };
    VIEWS.trade = function (parts) { var s = decodeURIComponent(parts[1] || 'BTCUSDT').toUpperCase().replace(/[^A-Z0-9.]/g, ''); setTimeout(mountTrade, 0); return tradeHtml(s); };
    return true;
  }
  if (!wire()) { var n = 0, t = setInterval(function () { if (wire() || ++n > 40) clearInterval(t); }, 250); }
})();
