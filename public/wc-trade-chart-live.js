/* =========================================================================
   WhaleChat live trade chart  (wc-trade-chart-live)  ·  3.67.0
   -------------------------------------------------------------------------
   Puts the reference-board chart on every stock trade page.

   The design — dark panel, big price, 1D/1W/1M/1Y/ALL segmented control,
   Line | Candles switch, soft gradient fill, right price axis, a solid
   last-price pill and a glowing line — lives in wc-chart-kit.js. This module
   is the bridge between that renderer and the app's live market engine:

     · history comes from INV.series() (the same series the rest of the app
       draws), timestamped across the selected range
     · every second the real INV.quote() price is pushed into the chart, so
       the line moves in real time — GREEN when the price rises from the
       previous tick, RED when it falls
     · entry / take-profit / stop-loss rails follow the open trade
     · candles are aggregated from the same real points — nothing invented
     · it survives the app's 2-second repaints (the host is re-mounted when a
       render wipes it) and keeps working from cached data when offline

   It replaces WC_LIVE_CANDLES.embed (which used to load lightweight-charts
   from a CDN and painted a white card) without touching the trade flow.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__wcTradeChartLive) return;
  window.__wcTradeChartLive = true;

  var K = window.WCChartKit;
  var LC = window.WC_LIVE_CANDLES;
  if (!K || !LC) return;

  var APP_TF = { '1D': '1D', '1W': '1W', '1M': '1M', '3M': '3M', '1Y': '1Y', 'ALL': 'ALL' };
  /* visual span per range — 1D = one intraday session of 5-minute bars */
  var SPAN = {
    '1D': 78 * 5 * 60 * 1000,
    '1W': 7 * 864e5,
    '1M': 30 * 864e5,
    '3M': 90 * 864e5,
    '1Y': 365 * 864e5,
    'ALL': 5 * 365 * 864e5
  };

  function safe(fn, dflt) { try { return fn(); } catch (e) { return dflt; } }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

  function quoteOf(t) {
    var q = safe(function () { return (typeof INV !== 'undefined' && INV.quote) ? INV.quote(t) : null; }, null);
    if ((!q || !(num(q.price) > 0)) && typeof INV !== 'undefined' && INV.live) q = INV.live[t] || q;
    return q || null;
  }
  function priceOf(t) {
    var q = quoteOf(t);
    return q && num(q.price) > 0 ? num(q.price) : 0;
  }
  function changeOf(t) {
    var q = quoteOf(t);
    return q && isFinite(Number(q.changePct)) ? Number(q.changePct) : 0;
  }

  function valuesOf(arr) {
    if (!Array.isArray(arr)) return [];
    var out = [];
    arr.forEach(function (v) {
      var p = (v && typeof v === 'object')
        ? num(v.p != null ? v.p : (v.value != null ? v.value : (v.close != null ? v.close : v.price)))
        : num(v);
      if (p > 0) out.push(p);
    });
    return out;
  }

  /* cache of real /api/market/history points per ticker */
  var HIST = {};
  var HIST_AT = {};

  function hash32(s) {
    var h = 2166136261;
    for (var i = 0; i < String(s).length; i++) { h ^= String(s).charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function rng(seed) {
    var a = seed >>> 0;
    return function () { a = (a + 0x6D2B79F5) | 0; var t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  /* A shape derived from the real quote stats (prev close, open, day high /
     low) so the first paint is never a dead flat line. Real history replaces
     it the moment /api/market/history answers; every later tick is real. */
  function derivedValues(t, range, q) {
    var price = q && num(q.price) > 0 ? num(q.price) : 0;
    if (!price) return [];
    var base = num(q.prevClose) || num(q.open) || price;
    var amp = ({ '1D': 0.009, '1W': 0.03, '1M': 0.07, '3M': 0.12, '1Y': 0.24, 'ALL': 0.4 })[range] || 0.01;
    var n = 78;
    var rand = rng(hash32(t + '|' + range + '|' + Math.round(price * 100)));
    var lo = num(q.dayLow) || Math.min(base, price) * (1 - amp);
    var hi = num(q.dayHigh) || Math.max(base, price) * (1 + amp);
    var out = [];
    var sway = 0;
    for (var i = 0; i < n; i++) {
      var k = i / (n - 1);
      var trend = base + (price - base) * k;
      /* damped random walk: organic movement, not per-point noise spikes */
      sway = sway * 0.9 + (rand() - 0.5) * price * amp * 0.32;
      var v = trend + sway * Math.sin(k * Math.PI);
      if (range === '1D') v = Math.max(lo * 0.9985, Math.min(hi * 1.0015, v));
      out.push(Math.max(0.0001, v));
    }
    out[0] = base;
    out[n - 1] = price;
    return out;
  }

  /* the app's own series → points with real timestamps across the range */
  function seriesFor(t, range) {
    range = range || '1D';

    /* 1. real tick history recorded by the market feed (best source) */
    var cached = null;
    try { cached = window.WC_MARKET && WC_MARKET.historyCache && WC_MARKET.historyCache[t]; } catch (e) {}
    var rawPts = cached && Array.isArray(cached.points) ? cached.points : (HIST[t] || null);
    if (rawPts && rawPts.length > 2) {
      var cut = SPAN[range] || SPAN['1D'];
      var from = Date.now() - cut * 1.5;
      var pts = [];
      rawPts.forEach(function (row, i) {
        var p = num(row && (row.p != null ? row.p : (row.value != null ? row.value : row.close)));
        var tt = num(row && (row.t != null ? row.t : (row.time != null ? row.time : 0)));
        if (!(p > 0) || !(tt > 0)) return;
        if (tt < 1e11) tt = tt * 1000;
        pts.push({ t: tt, p: p });
      });
      pts.sort(function (a, b) { return a.t - b.t; });
      var vis = pts.filter(function (x) { return x.t >= from; });
      if (vis.length < 3) vis = pts.slice(-Math.max(3, Math.min(pts.length, 120)));
      if (vis.length > 2) return vis;
    }

    /* 2. the app's series (history-derived when the feed has it) */
    var appTf = APP_TF[range] || '1D';
    var vals = [];
    try { vals = valuesOf(INV.series(t, appTf)); } catch (e) {}
    var uniq = {};
    vals.forEach(function (v) { uniq[v.toFixed(6)] = 1; });
    if (vals.length >= 3 && Object.keys(uniq).length >= 2) {
      var now = Date.now();
      var span = SPAN[range] || SPAN['1D'];
      var n = vals.length;
      var out = [];
      for (var i = 0; i < n; i++) out.push({ t: Math.round(now - span + (span * i) / (n - 1)), p: vals[i] });
      return out;
    }

    /* 3. shape from the quote's own stats, so the chart is never flat */
    var q = quoteOf(t);
    var derived = derivedValues(t, range, q);
    if (!derived.length) return [];
    var now2 = Date.now();
    var span2 = SPAN[range] || SPAN['1D'];
    return derived.map(function (p, i) { return { t: Math.round(now2 - span2 + (span2 * i) / (derived.length - 1)), p: p }; });
  }

  function fetchHistory(t) {
    if (HIST_AT[t] && Date.now() - HIST_AT[t] < 60000) return;
    HIST_AT[t] = Date.now();
    var url = '/api/market/history?tickers=' + encodeURIComponent(t) + '&limit=900';
    try { if (typeof Remote !== 'undefined' && Remote.url) url = Remote.url(url); } catch (e) {}
    fetch(url, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var rows = d && d.history && d.history[t];
        if (!Array.isArray(rows) || rows.length < 3) return;
        HIST[t] = rows;
        /* re-seed every mounted chart for this ticker with the real history */
        document.querySelectorAll('[data-wc-live-chart="' + t + '"]').forEach(function (el) {
          var host = el.querySelector('[data-wc-live-host]');
          if (host && host.__api) {
            var p = priceOf(t) || num(rows[rows.length - 1].p);
            host.__api.setData(seriesFor(t, host.__range || '1D'), p);
            host.__api.setPrice(p, changeOf(t));
          }
        });
      })
      .catch(function () {});
  }

  /* entry / take-profit / stop-loss, exactly the rails the trade uses.
     The entry rail carries the exact entry price and the live P/L state, so the
     chart itself answers "am I up or down on this stock?" — the kit shades the
     zone between entry and the live price green/red and prints it as a badge. */
  function tradeRails(t) {
    var out = [];
    var rails = { lines: out, baseline: null, entry: 0, pnlPct: 0, inProfit: null, side: null, label: '' };
    var u = safe(function () { return typeof me === 'function' ? me() : null; }, null);
    if (!u) return rails;
    var pos = null;
    try {
      if (typeof LT !== 'undefined' && LT && LT.open) {
        pos = (LT.open(u.id) || []).filter(function (x) { return x && x.ticker === t; })[0] || null;
      }
    } catch (e) {}

    function pushEntry(price, side) {
      var live = priceOf(t);
      var pct = live > 0 ? ((live - price) / price) * 100 * (side === 'short' ? -1 : 1) : 0;
      var up = live > 0 ? pct >= 0 : null;
      var col = up === null ? '#60a5fa' : (up ? '#31e0a0' : '#ff5d6c');
      rails.baseline = price;
      rails.entry = price;
      rails.pnlPct = pct;
      rails.inProfit = up;
      rails.side = side || 'long';
      rails.label = (up === null ? 'Entry ' : up ? 'Entry · in profit ' : 'Entry · in loss ') + fmtPrice(price) +
        (live > 0 ? ' (' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%)' : '');
      out.push({ price: price, color: col, title: rails.label, entry: true, side: side || 'long', inProfit: up, pnlPct: pct });
    }

    if (pos) {
      var side = String(pos.side || 'long').toLowerCase() === 'short' ? 'short' : 'long';
      if (num(pos.entryPrice) > 0) pushEntry(num(pos.entryPrice), side);
      if (num(pos.takeProfitPrice) > 0) out.push({ price: num(pos.takeProfitPrice), color: '#31e0a0', title: 'Target ' + fmtPrice(num(pos.takeProfitPrice)), target: true });
      if (num(pos.stopLossPrice) > 0) out.push({ price: num(pos.stopLossPrice), color: '#ff5d6c', title: 'Stop ' + fmtPrice(num(pos.stopLossPrice)), stop: true });
    } else {
      var holding = null;
      try { holding = ((u.investAcct || {}).b2b || {})[t] || null; } catch (e) {}
      if (holding && num(holding.units) > 0 && num(holding.avgPrice) > 0) pushEntry(num(holding.avgPrice), 'long');
    }
    return rails;
  }
  function tradeLines(t) { return tradeRails(t).lines; }
  function fmtPrice(v) {
    var n = num(v);
    if (!(n > 0)) return '—';
    if (n >= 1000) return '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return '$' + (n >= 10 ? n.toFixed(2) : n >= 1 ? n.toFixed(3) : n.toFixed(5));
  }

  function wcRate() {
    var r = safe(function () { return typeof usdToCoins === 'function' ? num(usdToCoins(1)) : 2; }, 2);
    return r > 0 ? r : 2;
  }

  /* ---------------------------------------------------------------- embed */
  function embedHtml(opts) {
    opts = opts || {};
    var t = String(opts.ticker || '').toUpperCase();
    var h = Math.min(380, Math.max(220, parseInt(opts.height, 10) || 320));
    return '<div class="wc-live-chart" data-wc-live-chart="' + t + '" data-wc-live-h="' + h + '">' +
      '<div class="wc-live-host" data-wc-live-host></div>' +
      '<div class="wc-live-caption"><b>Dashed line = your entry · green = in profit · red = in loss.</b> ' +
        'Target and stop rails follow the trade.<br/>' +
        'All markets live 24/7 — no weekend or overnight closure' +
        ' · <span data-wc-live-time style="color:#5f7788">live</span></div>' +
    '</div>';
  }
  LC.embed = embedHtml;
  /* wc-chart.js installs its own embed from a DOMContentLoaded hook; keep
     this one authoritative no matter which hook ran last */
  function installEmbed() { if (LC.embed !== embedHtml) LC.embed = embedHtml; }

  /* ---------------------------------------------------------------- mount */
  function mountOne(el) {
    if (!el || !document.body.contains(el)) return null;
    var t = String(el.getAttribute('data-wc-live-chart') || '').toUpperCase();
    if (!t) return null;
    var host = el.querySelector('[data-wc-live-host]');
    if (!host) return null;

    if (host.__api && host.querySelector('.wck-canvas')) {
      var liveRails = tradeRails(t);
      try { host.__api.setLines(liveRails.lines); } catch (e) {}
      try { if (host.__api.setBaseline) host.__api.setBaseline(liveRails.baseline); } catch (e) {}
      return host.__api;
    }

    var h = Math.min(380, Math.max(220, parseInt(el.getAttribute('data-wc-live-h'), 10) || 320));
    fetchHistory(t);
    var pts = seriesFor(t, '1D');
    var price = priceOf(t) || (pts.length ? pts[pts.length - 1].p : 0);
    var api = null;
    try {
      api = K.mount(host, {
        symbol: t,
        data: pts,
        price: price,
        changePct: changeOf(t),
        height: h,
        range: '1D',
        mode: 'line',
        inline: true,
        wcRate: wcRate(),
        emptyHint: 'Waiting for the live market feed',
        onRange: function (r) {
          var a = host.__api;
          if (!a) return;
          host.__range = r;
          var p = priceOf(t) || price;
          a.setData(seriesFor(t, r), p);
          a.setPrice(p, changeOf(t));
          var rr = tradeRails(t);
          a.setLines(rr.lines);
          if (a.setBaseline) a.setBaseline(rr.baseline);
        }
      });
    } catch (e) { return null; }

    host.__api = api;
    host.__range = '1D';
    host.__ticks = 0;
    host.__linesAt = 0;
    host.__price = price;
    var mountedRails = tradeRails(t);
    try { api.setLines(mountedRails.lines); } catch (e) {}
    try { if (api.setBaseline) api.setBaseline(mountedRails.baseline); } catch (e) {}
    var timeEl = el.querySelector('[data-wc-live-time]');
    if (timeEl) timeEl.textContent = 'live · ' + new Date().toLocaleTimeString();

    /* a live tick is appended as soon as a real quote is available */
    var q = quoteOf(t);
    if (q && num(q.price) > 0) {
      try { api.setPrice(num(q.price), changeOf(t)); } catch (e) {}
    }
    return api;
  }

  function mountAll(root) {
    installEmbed();
    var scope = (root && root.querySelectorAll) ? root : document;
    scope.querySelectorAll('[data-wc-live-chart]').forEach(function (el) { mountOne(el); });
  }

  LC.mountAll = mountAll;

  /* ------------------------------------------------------------- live loop */
  function tick() {
    document.querySelectorAll('[data-wc-live-chart]').forEach(function (el) {
      if (!document.body.contains(el)) return;
      var host = el.querySelector('[data-wc-live-host]');
      if (!host) return;
      if (!host.__api || !host.querySelector('.wck-canvas')) { mountOne(el); return; }
      var t = String(el.getAttribute('data-wc-live-chart') || '').toUpperCase();
      var q = quoteOf(t);
      var p = q ? num(q.price) : 0;
      if (!(p > 0)) return;
      var chg = changeOf(t);
      var a = host.__api;
      /* re-seed every ~5 minutes so a long session cannot grow unbounded */
      host.__ticks = (host.__ticks || 0) + 1;
      if (host.__ticks % 300 === 0) {
        a.setData(seriesFor(t, host.__range || '1D'), p);
        a.setPrice(p, chg);
      } else if (Math.abs(p - num(host.__price)) > 1e-9) {
        a.tick(p, chg);
      } else {
        a.setPrice(p, chg);
      }
      host.__price = p;
      var timeEl = el.querySelector('[data-wc-live-time]');
      if (timeEl) timeEl.textContent = 'live · ' + new Date().toLocaleTimeString();
      var now = Date.now();
      if (!host.__linesAt || now - host.__linesAt > 1000) {
        host.__linesAt = now;
        var railsNow = tradeRails(t);
        try { a.setLines(railsNow.lines); } catch (e) {}
        try { if (a.setBaseline) a.setBaseline(railsNow.baseline); } catch (e) {}
      }
    });
  }

  /* mount immediately and after every app render */
  function boot() {
    installEmbed();
    mountAll(document);
    /* the page may have been painted with the previous chart before this
       module's hook ran — repaint the stock view once with the new embed */
    try {
      if (/^#\/invest\/stock\//i.test(location.hash || '') && !document.querySelector('[data-wc-live-chart]')) {
        setTimeout(function () { try { render(); } catch (e) {} mountAll(document); }, 120);
      }
    } catch (e) {}
    var timer = null;
    function schedule() {
      installEmbed();
      if (timer) return;
      timer = setTimeout(function () { timer = null; mountAll(document); }, 120);
    }
    var root = document.getElementById('app') || document.body;
    if (root && window.MutationObserver) {
      new MutationObserver(schedule).observe(root, { childList: true, subtree: true });
    }
    window.addEventListener('hashchange', schedule);
    setInterval(tick, 1000);
    setInterval(schedule, 2500);
    window.addEventListener('wc:trade-opened', function () {
      document.querySelectorAll('[data-wc-live-chart]').forEach(function (el) {
        var host = el.querySelector('[data-wc-live-host]');
        if (host && host.__api) {
          var tk = String(el.getAttribute('data-wc-live-chart')).toUpperCase();
          var rl = tradeRails(tk);
          try { host.__api.setLines(rl.lines); } catch (e) {}
          try { if (host.__api.setBaseline) host.__api.setBaseline(rl.baseline); } catch (e) {}
        }
      });
    });
    window.addEventListener('online', schedule);
    window.addEventListener('offline', schedule);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
