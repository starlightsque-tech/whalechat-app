/* =========================================================================
   WhaleChat · native price chart (wc-chart)
   -------------------------------------------------------------------------
   Replaces every TradingView / lightweight-charts surface with one native SVG
   chart that matches the reference: a thin line that is GREEN above the
   baseline and RED below it, a dashed baseline, a price tag on the last point
   and faint grid lines.

   Data rules (no invented candles):
     · real ticks recorded by wc-market-feed are the primary source
     · otherwise a cached real quote is drawn as a flat line
     · offline never animates or invents a price; the line simply stops

   Public API
     WC_CHART.svg(ticker, {h, tf})      → chart markup
     WC_CHART.detail(ticker, {h, sub})  → card with header, change and chips
     WC_CHART.spark(ticker)             → tiny line for list rows
     WC_CHART.mountAll(root)            → repaint every [data-wcc]
   A WC_TV compatibility shim keeps the B2B pages working without TradingView.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcChart) return;
  window.__wcChart = true;

  var HIST_KEY = 'wc.tick.history.v1';
  var HIST = {};
  var MAX_PTS = 360;
  try { HIST = JSON.parse(localStorage.getItem(HIST_KEY) || '{}') || {}; } catch (e) { HIST = {}; }
  var lastSave = 0;

  var TF_WINDOW = { '1D': 864e5, '1W': 7 * 864e5, '1M': 30 * 864e5, '3M': 90 * 864e5, '1Y': 365 * 864e5, 'ALL': 1e15 };
  var UP = '#1fd18b';
  var DOWN = '#ff4d5e';

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function up(t) { return String(t || '').toUpperCase(); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function quote(t) { try { return (INV.live && INV.live[t]) || null; } catch (e) { return null; } }
  function stock(t) { try { return INV.stock ? INV.stock(t) : null; } catch (e) { return null; } }
  function priceOf(t) {
    var q = quote(t);
    if (q && num(q.price) > 0) return num(q.price);
    var s = stock(t);
    return s ? num(s.price) : 0;
  }
  function fmt(p) {
    p = num(p);
    if (p >= 1000) return p.toFixed(2);
    if (p >= 1) return p.toFixed(2);
    if (p >= 0.01) return p.toFixed(4);
    return p.toFixed(6);
  }

  /* ------------------------------------------------------------- history */
  function record(t, p, at) {
    t = up(t); p = num(p);
    if (!t || !(p > 0)) return;
    var list = HIST[t] || (HIST[t] = []);
    var last = list[list.length - 1];
    if (last && Math.abs(last.p - p) < 1e-12 && at - last.t < 5000) return;
    list.push({ t: Number(at) || Date.now(), p: p });
    if (list.length > MAX_PTS) list.splice(0, list.length - MAX_PTS);
    if (Date.now() - lastSave > 12000) save();
  }
  function save() {
    lastSave = Date.now();
    try { localStorage.setItem(HIST_KEY, JSON.stringify(HIST)); } catch (e) {}
  }
  window.addEventListener('beforeunload', save);

  function series(t, tf) {
    t = up(t);
    var win = TF_WINDOW[tf] || TF_WINDOW['1D'];
    var cutoff = Date.now() - win;
    var raw = (HIST[t] || []).filter(function (x) { return x.t >= cutoff; });
    if (raw.length >= 2) return raw.map(function (x) { return x.p; });
    var q = quote(t);
    /* only a real feed quote may seed a curve from the app's series engine */
    if (q && q.feed && navigator.onLine !== false && typeof INV.series === 'function') {
      try {
        var s = INV.series(t, tf) || [];
        if (s.length > 1) return s.map(num);
      } catch (e) {}
    }
    var p = priceOf(t);
    return p > 0 ? [p, p] : [];
  }

  /* ---------------------------------------------------------------- svg */
  function svg(t, opts) {
    opts = opts || {};
    t = up(t);
    var h = Math.max(60, Math.min(520, parseInt(opts.h, 10) || 160));
    var small = h < 90;
    var tf = opts.tf || '1D';
    var vals = series(t, tf);
    var q = quote(t) || {};
    var price = priceOf(t);
    if (!vals.length && !(price > 0)) {
      return '<div class="wcc wcc-empty" style="height:' + h + 'px"><span>No price data yet</span></div>';
    }
    if (vals.length === 1) vals = [vals[0], vals[0]];
    if (price > 0) vals[vals.length - 1] = price;

    var base = num(opts.baseline) || num(q.prevClose) || vals[0] || price;
    var lo = Math.min.apply(null, vals.concat([base]));
    var hi = Math.max.apply(null, vals.concat([base]));
    var span = hi - lo || Math.max(0.0001, hi * 0.002);
    lo -= span * 0.08; hi += span * 0.08;
    var W = 600, H = 200, padL = small ? 2 : 6, padR = small ? 2 : 6, padT = small ? 2 : 6, padB = small ? 2 : 6;
    var iw = W - padL - padR, ih = H - padT - padB;
    var x = function (i) { return padL + (i / Math.max(1, vals.length - 1)) * iw; };
    var y = function (v) { return padT + ((hi - v) / (hi - lo)) * ih; };

    /* one path per same-colour run so the line flips green/red at the base */
    var segs = [];
    var cur = null;
    for (var i = 1; i < vals.length; i++) {
      var v0 = vals[i - 1], v1 = vals[i];
      var color = v1 >= base ? UP : DOWN;
      if (!cur || cur.color !== color) {
        cur = { color: color, pts: [[x(i - 1), y(v0)]] };
        segs.push(cur);
      }
      cur.pts.push([x(i), y(v1)]);
    }
    var paths = segs.map(function (s) {
      return '<path d="' + s.pts.map(function (p, j) { return (j ? 'L' : 'M') + p[0].toFixed(2) + ' ' + p[1].toFixed(2); }).join(' ') +
        '" fill="none" stroke="' + s.color + '" stroke-width="' + (small ? 1.7 : 1.9) + '" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>';
    }).join('');

    var baseY = y(base).toFixed(2);
    var grid = '';
    if (!small) {
      for (var g = 0; g <= 4; g++) {
        var gy = padT + (ih / 4) * g;
        grid += '<line x1="' + padL + '" y1="' + gy.toFixed(2) + '" x2="' + (W - padR) + '" y2="' + gy.toFixed(2) + '" stroke="currentColor" stroke-opacity=".07" stroke-width="1" vector-effect="non-scaling-stroke"/>';
      }
    }
    var lx = x(vals.length - 1), ly = y(price || vals[vals.length - 1]);
    var tagColor = (price || vals[vals.length - 1]) >= base ? UP : DOWN;
    var tag = '';
    if (!small) {
      var tw = 54, ty = Math.max(12, Math.min(H - 8, ly));
      tag = '<g transform="translate(' + (W - tw - 2) + ',' + (ty - 9) + ')">' +
        '<rect width="' + tw + '" height="18" rx="4" fill="' + tagColor + '"/>' +
        '<text x="' + (tw / 2) + '" y="12.5" text-anchor="middle" font-size="10.5" font-weight="700" fill="#04101a">' + fmt(price || vals[vals.length - 1]) + '</text></g>';
      tag += '<circle cx="' + lx.toFixed(2) + '" cy="' + ly.toFixed(2) + '" r="2.6" fill="' + tagColor + '"/>';
    }

    return '<div class="wcc" data-wcc="' + esc(t) + '" data-wcc-tf="' + esc(tf) + '" style="height:' + h + 'px">' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="' + esc(t) + ' price chart">' +
        grid +
        '<line x1="' + padL + '" y1="' + baseY + '" x2="' + (W - padR) + '" y2="' + baseY + '" stroke="currentColor" stroke-opacity=".28" stroke-width="1" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>' +
        paths + tag +
      '</svg>' +
      (small ? '' : '<div class="wcc-axis"><span>low ' + fmt(lo) + '</span><span>base ' + fmt(base) + '</span><span>high ' + fmt(hi) + '</span></div>') +
    '</div>';
  }

  function spark(t) {
    return svg(t, { h: 46, tf: '1D' });
  }

  function detail(t, opts) {
    opts = opts || {};
    t = up(t);
    if ((HIST[t] || []).length < 20) loadHistory(t);
    var q = quote(t) || {};
    var p = priceOf(t);
    var chg = num(q.changePct);
    var cls = chg > 0 ? 'up' : chg < 0 ? 'down' : '';
    var s = stock(t);
    var tf = opts.tf || '1D';
    var offline = navigator.onLine === false;
    var hasFeed = !!(q && q.feed);
    var chips = ['1D', '1W', '1M', '3M', '1Y', 'ALL'].map(function (x) {
      return '<button type="button" class="wcc-chip' + (x === tf ? ' on' : '') + '" data-wcc-tf-btn="' + x + '">' + x + '</button>';
    }).join('');
    return '<div class="wcc-detail" data-wcc-detail="' + esc(t) + '">' +
      '<div class="wcc-dhead"><div>' +
        '<div class="wcc-dtitle">' + esc(t) + (offline || !hasFeed
          ? '<span class="wcc-live off"><i></i>PAUSED</span>'
          : '<span class="wcc-live"><i></i>LIVE</span>') + '</div>' +
        '<div class="wcc-dsub">' + esc((opts.sub || (s && s.name) || 'Live market price')) + '</div>' +
      '</div><div class="wcc-dpx">' +
        '<div class="wcc-dprice">' + fmt(p) + '</div>' +
        '<div class="wcc-dchg ' + cls + '">' + (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%</div>' +
      '</div></div>' +
      '<div class="wcc-chips">' + chips + '<span class="wcc-src" data-wcc-src>' + (offline ? 'Offline · showing last real price' : (!hasFeed ? 'Waiting for live ticks' : 'Live feed')) + '</span></div>' +
      '<div data-wcc-body="' + esc(t) + '">' + svg(t, { h: opts.h || 320, tf: tf }) + '</div>' +
    '</div>';
  }

  /* ------------------------------------------------ real candle history */
  var HIST_INFLIGHT = {};
  var HIST_AT = {};
  function loadHistory(t) {
    t = up(t);
    var cfg = window.WC_BUILD_CONFIG || {};
    if (!t || !cfg.stockProxyFunction) return;
    if (HIST_INFLIGHT[t]) return;
    if (HIST_AT[t] && Date.now() - HIST_AT[t] < 300000) return;
    if ((HIST[t] || []).length >= 20) { HIST_AT[t] = Date.now(); return; }
    HIST_INFLIGHT[t] = true;
    HIST_AT[t] = Date.now();
    var body = JSON.stringify({ body: JSON.stringify({ history: true, symbol: t }), method: 'POST' });
    fetch(cfg.stockProxyFunction, { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json', 'X-Appwrite-Project': cfg.appwriteProjectId || '' }, body: body })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var payload = d && d.responseBody ? JSON.parse(d.responseBody) : d;
        var pts = payload && payload.history && payload.history.points;
        if (!Array.isArray(pts) || pts.length < 2) return;
        var cur = HIST[t] || [];
        var byT = {};
        cur.forEach(function (x) { byT[x.t] = x; });
        pts.forEach(function (x) { if (x && x.p > 0 && x.t > 0) byT[x.t] = { t: Number(x.t), p: Number(x.p) }; });
        HIST[t] = Object.keys(byT).map(function (k) { return byT[k]; }).sort(function (a, b) { return a.t - b.t; }).slice(-MAX_PTS);
        save();
        mountAll();
      })
      .catch(function () {})
      .then(function () { HIST_INFLIGHT[t] = false; });
  }

  /* -------------------------------------------------------------- styles */
  function styles() {
    if (document.getElementById('wc-chart-css')) return;
    var st = document.createElement('style');
    st.id = 'wc-chart-css';
    st.textContent = [
      '.wcc{position:relative;width:100%;color:var(--text);border-radius:12px;overflow:hidden}',
      '.wcc svg{display:block;width:100%;height:100%}',
      '.wcc-empty{display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;color:var(--muted);background:rgba(255,255,255,.02);border-radius:10px}',
      '.wcc-axis{display:flex;justify-content:space-between;font-size:9px;font-weight:600;letter-spacing:.02em;color:var(--muted);padding:2px 4px 0;font-variant-numeric:tabular-nums}',
      '.wcc-detail{padding:2px 0 0}',
      '.wcc-dhead{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:6px}',
      '.wcc-dtitle{font-size:14px;font-weight:800;letter-spacing:.02em;display:flex;align-items:center;gap:7px}',
      '.wcc-dsub{font-size:10.5px;color:var(--muted);font-weight:600;margin-top:2px;max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.wcc-live{display:inline-flex;align-items:center;gap:4px;font-size:8.5px;font-weight:800;letter-spacing:.1em;color:' + UP + ';border:1px solid rgba(31,209,139,.35);background:rgba(31,209,139,.10);border-radius:99px;padding:2px 6px}',
      '.wcc-live i{width:5px;height:5px;border-radius:50%;background:' + UP + ';animation:wccPulse 1.6s infinite}',
      '.wcc-live.off{color:var(--muted);border-color:var(--border);background:rgba(148,163,184,.10)}',
      '.wcc-live.off i{background:var(--muted);animation:none}',
      '@keyframes wccPulse{0%,100%{opacity:.35}50%{opacity:1}}',
      '.wcc-dpx{text-align:right;flex:0 0 auto}',
      '.wcc-dprice{font-size:24px;font-weight:800;letter-spacing:-.01em;font-variant-numeric:tabular-nums;line-height:1.1}',
      '.wcc-dchg{font-size:11.5px;font-weight:800;margin-top:2px;font-variant-numeric:tabular-nums}',
      '.wcc-dchg.up{color:' + UP + '}.wcc-dchg.down{color:' + DOWN + '}',
      '.wcc-chips{display:flex;gap:5px;align-items:center;flex-wrap:wrap;margin:2px 0 6px}',
      '.wcc-chip{font-size:9.5px;font-weight:800;letter-spacing:.04em;color:var(--muted);background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:99px;padding:3px 9px;cursor:pointer;min-height:24px}',
      '.wcc-chip.on{color:#04101a;background:' + UP + ';border-color:' + UP + '}',
      '.wcc-src{margin-left:auto;font-size:9px;font-weight:600;color:var(--muted)}',
      /* any surface still carrying a TradingView iframe/canvas is hidden */
      '.tradingview-widget-container,.tradingview-widget-copyright,.tv-lightweight-charts{display:none!important}',
      'html[data-theme="light"] .wcc-empty{background:rgba(0,0,0,.03)}'
    ].join('\n');
    document.head.appendChild(st);
  }

  /* ------------------------------------------------------------ mounting */
  function paint(host) {
    var t = host.getAttribute('data-wcc');
    var tf = host.getAttribute('data-wcc-tf') || '1D';
    var h = parseInt(host.style.height, 10) || 160;
    var html = svg(t, { h: h, tf: tf });
    if (host.__wccHtml === html) return;
    host.__wccHtml = html;
    host.innerHTML = html;
    var inner = host.querySelector('[data-wcc]');
    if (inner) inner.__wccHtml = html;
  }

  function mountAll(root) {
    var scope = root && root.querySelectorAll ? root : document;
    var list = scope.querySelectorAll('[data-wcc]');
    var n = 0;
    for (var i = 0; i < list.length && n < 140; i++) {
      var el = list[i];
      if (!el.offsetParent && !el.getClientRects().length) continue;
      paint(el);
      n++;
    }
    /* detail headers */
    var details = scope.querySelectorAll('[data-wcc-detail]');
    for (var d = 0; d < details.length && d < 20; d++) {
      var box = details[d];
      var t = box.getAttribute('data-wcc-detail');
      var q = quote(t) || {};
      var p = priceOf(t);
      var priceEl = box.querySelector('.wcc-dprice');
      if (priceEl) priceEl.textContent = fmt(p);
      var chgEl = box.querySelector('.wcc-dchg');
      if (chgEl && q.changePct != null) {
        var c = num(q.changePct);
        chgEl.textContent = (c >= 0 ? '+' : '') + c.toFixed(2) + '%';
        chgEl.className = 'wcc-dchg ' + (c > 0 ? 'up' : c < 0 ? 'down' : '');
      }
      var src = box.querySelector('[data-wcc-src]');
      if (src) src.textContent = navigator.onLine === false ? 'Offline · showing last real price' : 'Live feed';
    }
  }

  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest && e.target.closest('[data-wcc-tf-btn]');
    if (!b) return;
    var tf = b.getAttribute('data-wcc-tf-btn');
    var detail = b.closest('[data-wcc-detail]');
    if (!detail) return;
    var t = detail.getAttribute('data-wcc-detail');
    detail.querySelectorAll('[data-wcc-tf-btn]').forEach(function (x) { x.classList.toggle('on', x === b); });
    var body = detail.querySelector('[data-wcc-body]');
    if (body) body.innerHTML = svg(t, { h: 320, tf: tf });
  }, true);

  /* ------------------------------------------------- app integration */
  function integrate() {
    if (typeof INV === 'undefined') return false;
    if (INV.__wccPatched) return true;
    INV.spark = function (t) { return spark(t); };
    INV.lineChart = function (vals, o) {
      var s = stock(arguments[2] || '') || null;
      var list = Array.isArray(vals) ? vals.map(num) : [];
      if (list.length < 2) return '<div class="wcc-empty" style="height:' + ((o && o.h) || 150) + 'px"><span>No price data yet</span></div>';
      return renderValues(list, (o && o.h) || 150);
    };
    INV.candleChart = INV.lineChart;
    INV.__wccPatched = true;
    /* the stock page used its own canvas candles — use the reference chart */
    try {
      if (window.WC_LIVE_CANDLES && !window.WC_LIVE_CANDLES.__wcc) {
        window.WC_LIVE_CANDLES.embed = function (o) {
          o = o || {};
          return detail(o.ticker, { h: o.height || 340, sub: o.sub || '' });
        };
        window.WC_LIVE_CANDLES.__wcc = true;
      }
    } catch (e) {}
    return true;
  }
  function renderValues(vals, h) {
    var t = '__vals__' + vals.length + '_' + vals[0];
    var tmp = HIST[t];
    HIST[t] = vals.map(function (p, i) { return { t: Date.now() - (vals.length - i) * 60000, p: p }; });
    var html = svg(t, { h: h, baseline: vals[0] });
    if (tmp) HIST[t] = tmp; else delete HIST[t];
    return html;
  }

  /* WC_TV shim — B2B and any legacy caller get the native chart */
  function installTV() {
    var TV = window.WC_TV = window.WC_TV || {};
    TV.symbol = function (t) { return up(t); };
    TV.mount = function (host, ticker, kind) {
      if (!host) return;
      host.classList.add('wc-tv-box');
      host.innerHTML = detail(ticker, { h: 300, sub: kind ? String(kind) : '' });
    };
    TV.mountAll = function (root) {
      var scope = root && root.querySelectorAll ? root : document;
      scope.querySelectorAll('.wc-tv-box').forEach(function (host) {
        var t = host.getAttribute('data-wc-tv-ticker') || host.getAttribute('data-tv') || '';
        if (t) TV.mount(host, t);
      });
    };
  }

  /* portfolio chart host used by the live-trade dashboard */
  function paintPortfolio() {
    var host = document.getElementById('ltDashChart');
    if (!host || host.__wccPortfolio) return;
    var vals = [];
    try { if (typeof INV !== 'undefined' && INV.portfolioSeries) vals = INV.portfolioSeries(host.getAttribute('data-ltd-chart') || '1M', me().id) || []; } catch (e) {}
    if (!(vals.length > 1)) return;
    host.__wccPortfolio = true;
    host.classList.add('wcc-portfolio');
    host.innerHTML = renderValues(vals.map(num), Math.max(160, host.clientHeight || 220));
  }

  function mountTVHosts() {
    document.querySelectorAll('[data-wc-tv]').forEach(function (host) {
      /* 3.66.6: a host claimed by the shared chart kit is left alone */
      if (host.getAttribute('data-wck-owned') === '1') return;
      if (host.querySelector('.wck-canvas')) return;
      if (host.querySelector('.wcc-detail')) return;
      var t = host.getAttribute('data-wc-tv');
      if (t && window.WC_TV) window.WC_TV.mount(host, t, host.getAttribute('data-wc-tv-kind') || '');
    });
  }

  function boot() {
    styles();
    integrate();
    installTV();
    setInterval(function () {
      try { integrate(); mountTVHosts(); mountAll(); paintPortfolio(); } catch (e) {}
    }, 2200);
    /* pages rendered before this module booted get the new chart immediately */
    setTimeout(function () {
      try { if (/^#\/investment\/b2b/.test(location.hash || '')) render(); } catch (e) {}
    }, 500);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { integrate(); mountAll(); }
    });
    window.addEventListener('online', function () { setTimeout(mountAll, 400); });
    window.WC_CHART = { svg: svg, detail: detail, spark: spark, mountAll: mountAll, record: record, series: series };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
