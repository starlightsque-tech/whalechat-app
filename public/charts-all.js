/* =========================================================================
   WhaleChat unified wave chart everywhere  (wc-charts-all)

   Stock trading and portfolio/bot charts are switched to the same smooth
   green-rise / red-fall wave used on the B2B and WC-investing pages. The
   TradingView-style grid, right-hand price scale and live dot stay; only the
   drawing engine is shared, so every chart in the app looks and behaves alike.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcChartsAll) return;
  window.__wcChartsAll = true;

  function route() { try { return String(location.hash || ''); } catch (e) { return ''; } }
  function tickerFromRoute() {
    try { return String((route().split('/')[3] || '').split('?')[0]).toUpperCase(); } catch (e) { return ''; }
  }
  function seriesPoints(ticker) {
    var now = Date.now(), vals = [];
    try { vals = INV.series(ticker, '1D') || []; } catch (e) {}
    var pts = vals.filter(function (v) { return isFinite(Number(v)); }).map(function (v, i) {
      return { t: now - (vals.length - 1 - i) * 60000, v: Number(v) };
    });
    try { var q = INV.quote(ticker); if (q && q.price > 0) pts.push({ t: now, v: Number(q.price) }); } catch (e) {}
    return pts;
  }

  function killMarketChart() {
    try {
      if (window.WC_MARKET && WC_MARKET.chart) {
        try { WC_MARKET.chart.chart.remove(); } catch (e) {}
        WC_MARKET.chart = null;
      }
    } catch (e) {}
  }

  function stockHost() {
    var all = Array.prototype.slice.call(document.querySelectorAll('.inv-chart'));
    var pref = all.find(function (h) { return h.hasAttribute('data-lt-live-chart') || h.hasAttribute('data-chart'); });
    var visible = all.find(function (h) { return h.offsetParent !== null; });
    return pref || visible || all[0] || null;
  }

  function mountStock() {
    var host = stockHost();
    if (!host || !window.WC_LIVE_CHART) return;
    var ticker = tickerFromRoute();
    if (!ticker) return;
    if (host.getAttribute('data-wc-wave') === ticker && host.classList.contains('wclc')) return;
    if (host.querySelector('canvas')) killMarketChart();
    host.setAttribute('data-wc-wave', ticker);
    host.removeAttribute('data-chart');
    host.style.height = '240px';
    WC_LIVE_CHART.mount(host, {
      height: 240, unit: 'usd', points: seriesPoints(ticker),
      getLive: function () { try { var q = INV.quote(ticker); return q && q.price > 0 ? q.price : null; } catch (e) { return null; } }
    });
  }

  function mountPortfolio() {
    var host = document.getElementById('ltDashChart');
    if (!host || !window.WC_LIVE_CHART) return;
    if (host.getAttribute('data-wc-wave') === 'portfolio' && host.classList.contains('wclc')) return;
    if (host.querySelector('canvas')) killMarketChart();
    var u = null; try { u = me(); } catch (e) {}
    if (!u || typeof LT === 'undefined' || !LT.seriesWithTrades) return;
    var tf = host.getAttribute('data-ltd-chart') || '1M';
    var vals = [];
    try { vals = LT.seriesWithTrades(tf, u.id) || []; } catch (e) {}
    var now = Date.now();
    var pts = vals.map(function (v, i) { return { t: now - (vals.length - 1 - i) * 3600000, v: Number(v) || 0 }; });
    if (!pts.length) { try { var s = LT.summary(u.id); if (s && s.valueUsd > 0) pts = [{ t: now - 3600000, v: s.valueUsd }, { t: now, v: s.valueUsd }]; } catch (e) {} }
    if (pts.length < 2) return;
    host.setAttribute('data-wc-wave', 'portfolio');
    host.style.height = '240px';
    WC_LIVE_CHART.mount(host, {
      height: 240, unit: 'usd', points: pts,
      getLive: function () { try { return LT.summary(u.id).valueUsd; } catch (e) { return null; } }
    });
  }

  function tick() {
    try {
      var r = route();
      if (r.indexOf('#/invest/stock/') === 0) mountStock();
      if (r === '#/invest' || r.indexOf('#/invest?') === 0 || r.indexOf('#/invest/bots') === 0) mountPortfolio();
    } catch (e) {}
  }

  setInterval(tick, 1500);
  window.addEventListener('hashchange', function () { setTimeout(tick, 500); });
  setTimeout(tick, 2000);
})();
