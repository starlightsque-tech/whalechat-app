/* =========================================================================
   WhaleChat unified live charts + market breadth  (wc-charts-unify)

   - B2B asset pages use the shared green/red segmented live chart.
   - Market and stock pages show a live rising/falling count that follows the
     real quotes (green when price is up, red when it is down).
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcChartsUnify) return;
  window.__wcChartsUnify = true;

  var mounted = null;

  function route() { try { return String(location.hash || ''); } catch (e) { return ''; } }
  function usd(v) { return '$' + (Number(v) || 0).toFixed(2); }

  function seriesPoints(ticker, quote) {
    var vals = [];
    try { vals = INV.series(ticker, '1D') || []; } catch (e) { vals = []; }
    var now = Date.now();
    var pts = vals.filter(function (v) { return isFinite(Number(v)); }).map(function (v, i) {
      return { t: now - (vals.length - 1 - i) * 60000, v: Number(v) };
    });
    if (quote && quote.price > 0) {
      if (!pts.length) pts = [{ t: now - 60000, v: quote.price }, { t: now, v: quote.price }];
      else if (now - pts[pts.length - 1].t < 1000) pts[pts.length - 1].v = quote.price;
      else pts.push({ t: now, v: quote.price });
    }
    return pts;
  }

  function mountB2B() {
    var host = document.querySelector('[data-wc-b2b-chart]');
    if (!host) return;
    var ticker = host.getAttribute('data-wc-b2b-chart');
    if (mounted && mounted.host === host && mounted.ticker === ticker) return;
    if (mounted) { try { mounted.inst.destroy(); } catch (e) {} mounted = null; }
    if (!window.WC_LIVE_CHART) return;
    var q = null; try { q = INV.quote(ticker); } catch (e) {}
    var inst = WC_LIVE_CHART.mount(host, {
      height: 220,
      unit: 'usd',
      points: seriesPoints(ticker, q),
      getLive: function () {
        try { var x = INV.quote(ticker); return x && x.price > 0 ? x.price : null; } catch (e) { return null; }
      }
    });
    mounted = { host: host, ticker: ticker, inst: inst };
  }

  function replaceB2BChart() {
    var svg = document.querySelector('svg.b2bm-bigchart');
    if (!svg) return;
    var poly = svg.querySelector('[data-b2bm-bigspark]');
    var t = (poly && poly.getAttribute('data-b2bm-bigspark')) || svg.getAttribute('data-b2bm-bigspark');
    if (!t) return;
    var host = document.createElement('div');
    host.setAttribute('data-wc-b2b-chart', t);
    host.style.margin = '8px 0 4px';
    svg.parentNode.replaceChild(host, svg);
    var note = host.nextElementSibling;
    if (note && /Live chart/i.test(note.textContent || '')) note.textContent = 'Live chart · green = rising · red = falling · updates every second';
    mountB2B();
  }

  /* rising / falling count strip */
  function counts() {
    var up = 0, down = 0, flat = 0;
    try {
      var list = (typeof INV.visibleStocks === 'function') ? INV.visibleStocks() : INV.stocks();
      list.forEach(function (s) {
        var q = INV.quote(s.ticker);
        if (!q) { return; }
        var d = Number(q.dir) || (Number(q.changePct) > 0 ? 1 : Number(q.changePct) < 0 ? -1 : 0);
        if (d > 0) up++; else if (d < 0) down++; else flat++;
      });
    } catch (e) {}
    return { up: up, down: down, flat: flat };
  }

  function ensureBreadth() {
    var r = route();
    var isMarket = r.indexOf('#/invest/market') === 0 || r.indexOf('#/invest/stock/') === 0 || r.indexOf('#/investment/b2b') === 0;
    if (!isMarket) { var old = document.getElementById('wcBreadth'); if (old) old.remove(); return; }
    if (document.getElementById('wcBreadth')) return;
    var anchor = document.querySelector('.page-head') || document.querySelector('.content .card');
    if (!anchor) return;
    var el = document.createElement('div');
    el.id = 'wcBreadth';
    el.style.cssText = 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:2px 0 12px;padding:9px 12px;border-radius:12px;background:rgba(255,255,255,.03);border:1px solid var(--border);font-size:11.5px;font-weight:700';
    el.innerHTML = '<span style="color:#2ee6a8">▲ <b data-wcb-up>0</b> rising</span>' +
      '<span style="color:#ff5d7a">▼ <b data-wcb-down>0</b> falling</span>' +
      '<span class="tiny muted" style="font-weight:500"><b data-wcb-flat>0</b> unchanged · live count</span>' +
      '<span class="grow"></span><span class="tiny muted" data-wcb-bar style="height:6px;width:90px;border-radius:6px;overflow:hidden;display:flex;background:rgba(255,255,255,.06)"><i style="height:100%;background:#2ee6a8"></i><i style="height:100%;background:#ff5d7a"></i></span>';
    anchor.parentNode.insertBefore(el, anchor.nextSibling);
  }

  function paintBreadth() {
    var el = document.getElementById('wcBreadth');
    if (!el) return;
    var c = counts();
    var u = el.querySelector('[data-wcb-up]'), d = el.querySelector('[data-wcb-down]'), f = el.querySelector('[data-wcb-flat]');
    var bar = el.querySelector('[data-wcb-bar]');
    if (u) u.textContent = c.up;
    if (d) d.textContent = c.down;
    if (f) f.textContent = c.flat;
    if (bar && bar.children.length === 2) {
      var total = Math.max(1, c.up + c.down + c.flat);
      bar.children[0].style.width = (c.up / total * 100).toFixed(1) + '%';
      bar.children[1].style.width = (c.down / total * 100).toFixed(1) + '%';
    }
  }

  function tick() {
    try {
      if (route().indexOf('#/investment/b2b/asset') === 0) { replaceB2BChart(); mountB2B(); }
      ensureBreadth();
      paintBreadth();
    } catch (e) {}
  }

  setInterval(tick, 1200);
  window.addEventListener('hashchange', function () { setTimeout(tick, 350); });
  setTimeout(tick, 1200);
})();
