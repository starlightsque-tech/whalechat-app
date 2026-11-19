/* =========================================================================
   WhaleChat · B2B holdings performance  (wc-b2b-performance)

   A TradingView Lightweight Charts (v5) line chart for the assets a user
   actually holds on the B2B-Investing desk:

     black line  · the real market price movement of the selected holding
     red line    · the admin buy price for that asset
     green line  · the sell price the user set in their price alerts

   Data comes from /api/market/history, which is now backed by the durable
   Postgres tick store, so the chart opens with the full series after a
   restart instead of rebuilding from zero.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || window.__wcB2bPerf) return;
  window.__wcB2bPerf = true;
  var PERF = window.WC_B2B_PERF = window.WC_B2B_PERF || {};
  var LWC_URL = 'https://unpkg.com/lightweight-charts@5.3.0/dist/lightweight-charts.standalone.production.js';
  var instances = {};
  var selected = '';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function money(v) { return '$' + (Math.round((Number(v) || 0) * 100) / 100).toFixed(2); }
  function apiPath(p) { try { if (typeof Remote !== 'undefined' && Remote && Remote.enabled && Remote.url) return Remote.url(p); } catch (e) {} return p; }
  function me2() { try { return me(); } catch (e) { return null; } }

  function loadLWC() {
    if (window.LightweightCharts && window.LightweightCharts.createChart) return Promise.resolve(window.LightweightCharts);
    if (PERF._lwc) return PERF._lwc;
    PERF._lwc = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = LWC_URL; s.async = true; s.crossOrigin = 'anonymous';
      s.onload = function () { window.LightweightCharts ? resolve(window.LightweightCharts) : reject(new Error('Lightweight Charts did not initialise')); };
      s.onerror = function () { reject(new Error('Lightweight Charts CDN blocked')); };
      document.head.appendChild(s);
    });
    return PERF._lwc;
  }

  function holdingsOf(u) {
    var out = [];
    try {
      var a = (u && u.investAcct) || {};
      var map = a.b2b || {};
      Object.keys(map).forEach(function (t) {
        var h = map[t];
        if (h && Number(h.units) > 0) out.push({ ticker: String(t).toUpperCase(), units: Number(h.units), avg: Number(h.avgPrice) || 0 });
      });
    } catch (e) {}
    return out.sort(function (a, b) { return (b.units * (b.avg || 1)) - (a.units * (a.avg || 1)); });
  }
  function alertFor(u, ticker) {
    try {
      var list = (u && u.investAcct && u.investAcct.b2bAlerts) || [];
      return list.filter(function (x) { return x && String(x.ticker).toUpperCase() === ticker; })[0] || {};
    } catch (e) { return {}; }
  }
  function stockRow(ticker) {
    try {
      var list = (typeof DB !== 'undefined' && DB && DB.stocks) || [];
      return list.filter(function (s) { return s && String(s.ticker).toUpperCase() === ticker; })[0] || {};
    } catch (e) { return {}; }
  }
  function priceOf(ticker) {
    try { var q = INV.quote(ticker); if (q && Number(q.price) > 0) return Number(q.price); } catch (e) {}
    try { if (INV.live && INV.live[ticker] && Number(INV.live[ticker].price) > 0) return Number(INV.live[ticker].price); } catch (e) {}
    return 0;
  }

  /* red = admin buy price, green = the user's sell target */
  function targetsOf(u, h) {
    var al = alertFor(u, h.ticker);
    var stock = stockRow(h.ticker);
    var buy = Number(al.adminBuy) || Number(stock.adminBuy) || Number(stock.buy) || Number(al.buy) || h.avg || 0;
    var sell = Number(al.sell) || Number(stock.sell) || 0;
    if (!(sell > 0) && buy > 0) sell = buy * 1.05;
    return { buy: buy, sell: sell, alertId: al.id || '' };
  }

  function getHistory(ticker) {
    return fetch(apiPath('/api/market/history?tickers=' + encodeURIComponent(ticker) + '&limit=400'), { headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var rows = (d && d.history && (d.history[ticker] || Object.values(d.history)[0])) || [];
        return rows;
      })
      .catch(function () { return []; });
  }

  function seriesData(rows, ticker) {
    var seen = {}, out = [];
    (rows || []).forEach(function (r) {
      var t = Number(r.t), p = Number(r.p);
      if (!(t > 0) || !(p > 0)) return;
      var sec = Math.floor(t / 1000 / 300) * 300;   /* 5-minute buckets keep the line readable */
      if (seen[sec]) { out[seen[sec] - 1].value = p; return; }
      seen[sec] = out.length + 1;
      out.push({ time: sec, value: p });
    });
    out.sort(function (a, b) { return a.time - b.time; });
    if (out.length < 8) {
      var px = priceOf(ticker);
      var seed = [];
      try { seed = (INV.series(ticker, '1D') || []).slice(-80); } catch (e) {}
      if (seed.length) {
        out = seed.map(function (v, i) { return { time: Math.floor(Date.now() / 1000) - (seed.length - i) * 300, value: Number(v) }; }).filter(function (x) { return x.value > 0; });
      } else if (px > 0) {
        out = [{ time: Math.floor(Date.now() / 1000) - 300, value: px }, { time: Math.floor(Date.now() / 1000), value: px }];
      }
    }
    return out;
  }

  function chartOptions() {
    return {
      layout: { textColor: 'black', background: { type: 'solid', color: 'white' } },
      grid: { vertLines: { color: '#D6DCDE' }, horzLines: { color: '#D6DCDE' } },
      rightPriceScale: { borderColor: '#D6DCDE' },
      timeScale: { borderColor: '#D6DCDE', timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 }
    };
  }

  function mount(host, ticker) {
    if (!host) return;
    loadLWC().then(function (LWC) {
      var h = holdingsOf(me2()).filter(function (x) { return x.ticker === ticker; })[0] || { ticker: ticker, units: 0, avg: priceOf(ticker) };
      var tg = targetsOf(me2(), h);
      host.innerHTML = '';
      var box = document.createElement('div');
      box.style.width = '100%';
      host.appendChild(box);
      var chart = LWC.createChart(box, chartOptions());
      var series = chart.addSeries(LWC.LineSeries, {
        color: '#111111',
        lineWidth: 2,
        lastValueVisible: false,
        priceLineVisible: false
      });
      /* size from the real container so the 360 px mobile rule is respected
         (a hard-coded 420 canvas overflowed the card on phones) */
      var w0 = host.clientWidth || box.clientWidth || 320;
      var h0 = host.clientHeight || 420;
      chart.resize(w0, h0);
      var ro = null;
      try {
        ro = new ResizeObserver(function () {
          chart.resize(host.clientWidth || w0, host.clientHeight || h0);
        });
        ro.observe(host);
      } catch (e) {}
      instances[ticker] = { chart: chart, series: series, ro: ro, host: host, buy: tg.buy, sell: tg.sell };
      applyLines(instances[ticker]);
      refresh(ticker);
      return series;
    }).catch(function (e) {
      host.innerHTML = '<div class="tiny muted" style="padding:12px">Chart could not load (' + esc(e.message) + ').</div>';
    });
  }

  function applyLines(inst) {
    if (!inst || !inst.series) return;
    if (inst.buyLine) { try { inst.series.removePriceLine(inst.buyLine); } catch (e) {} inst.buyLine = null; }
    if (inst.sellLine) { try { inst.series.removePriceLine(inst.sellLine); } catch (e) {} inst.sellLine = null; }
    if (inst.buy > 0) {
      inst.buyLine = inst.series.createPriceLine({ price: inst.buy, color: '#ef5350', lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: 'Buy · admin' });
    }
    if (inst.sell > 0) {
      inst.sellLine = inst.series.createPriceLine({ price: inst.sell, color: '#26a69a', lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: 'Sell · you' });
    }
  }

  function refresh(ticker) {
    var inst = instances[ticker];
    if (!inst) return;
    getHistory(ticker).then(function (rows) {
      var data = seriesData(rows, ticker);
      if (!data.length) return;
      try { inst.series.setData(data); inst.chart.timeScale().fitContent(); } catch (e) {}
      var h = holdingsOf(me2()).filter(function (x) { return x.ticker === ticker; })[0];
      if (h) {
        var tg = targetsOf(me2(), h);
        if (Number(tg.buy) !== Number(inst.buy) || Number(tg.sell) !== Number(inst.sell)) {
          inst.buy = tg.buy; inst.sell = tg.sell; applyLines(inst);
        }
      }
    });
  }

  function cardHtml(u) {
    var hs = holdingsOf(u);
    if (!hs.length) {
      return '<div class="card" id="b2bPerfCard"><div class="card-title">Holdings performance</div>' +
        '<div class="tiny muted">Buy an asset on the B2B desk and its live performance chart appears here — with your sell target in green and the admin buy price in red.</div></div>';
    }
    if (!selected || !hs.some(function (h) { return h.ticker === selected; })) selected = hs[0].ticker;
    var cur = hs.filter(function (h) { return h.ticker === selected; })[0] || hs[0];
    var tg = targetsOf(u, cur);
    var px = priceOf(cur.ticker) || cur.avg;
    var value = cur.units * px;
    var basis = cur.units * cur.avg;
    var pl = value - basis;
    var pct = basis > 0 ? (pl / basis) * 100 : 0;
    return '<div class="card" id="b2bPerfCard">' +
      '<div class="between" style="align-items:flex-start;gap:10px;flex-wrap:wrap">' +
        '<div><div class="card-title" style="margin:0">Holdings performance</div>' +
        '<div class="tiny muted">Real price movement · <b style="color:#26a69a">green</b> = your sell price · <b style="color:#ef5350">red</b> = admin buy price</div></div>' +
        '<select class="input" id="b2bPerfPick" data-b2b-perf-pick style="max-width:190px">' +
          hs.map(function (h) { return '<option value="' + esc(h.ticker) + '"' + (h.ticker === cur.ticker ? ' selected' : '') + '>' + esc(h.ticker) + ' · ' + money(h.units * (priceOf(h.ticker) || h.avg)) + '</option>'; }).join('') +
        '</select>' +
      '</div>' +
      '<div class="b2b-perf-stats">' +
        '<div><span>Price now</span><b>' + money(px) + '</b></div>' +
        '<div><span>Your value</span><b>' + money(value) + '</b></div>' +
        '<div><span>Unrealised P/L</span><b class="' + (pl >= 0 ? 'up' : 'down') + '">' + (pl >= 0 ? '+' : '') + money(pl) + ' (' + pct.toFixed(2) + '%)</b></div>' +
        '<div><span>Sell target</span><b style="color:#26a69a">' + (tg.sell > 0 ? money(tg.sell) : '—') + '</b></div>' +
        '<div><span>Admin buy</span><b style="color:#ef5350">' + (tg.buy > 0 ? money(tg.buy) : '—') + '</b></div>' +
      '</div>' +
      '<div class="b2b-perf-chart" id="b2bPerfChart" data-b2b-perf-chart="' + esc(cur.ticker) + '"></div>' +
      '<div class="tiny muted" style="margin-top:6px">Live from the WhaleChat market feed · updates every 3 seconds</div>' +
    '</div>';
  }

  function styles() {
    if (document.getElementById('b2b-perf-style')) return;
    var st = document.createElement('style'); st.id = 'b2b-perf-style';
    st.textContent = [
      '#b2bPerfChart{width:100%;height:430px;min-height:240px;margin-top:10px;background:#fff;border-radius:10px;overflow:hidden}',
      '.b2b-perf-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin-top:10px}',
      '.b2b-perf-stats span{display:block;font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-2);font-weight:700}',
      '.b2b-perf-stats b{font-size:12.5px;font-variant-numeric:tabular-nums}',
      '@media(max-width:520px){#b2bPerfChart{height:min(78vw,340px);min-height:230px}}'
    ].join('\n');
    document.head.appendChild(st);
  }

  function mountCard() {
    var host = document.getElementById('b2bPerfChart');
    if (!host) return;
    var t = host.getAttribute('data-b2b-perf-chart');
    if (!t) return;
    if (instances[t] && instances[t].host === host && host.childElementCount) return;
    mount(host, t);
  }

  PERF.mount = mountCard;
  PERF.refreshAll = function () { Object.keys(instances).forEach(refresh); };

  /* append the card to the B2B dashboard, then mount/refresh it */
  function patch() {
    if (typeof VIEWS === 'undefined' || !VIEWS.investment) return false;
    if (VIEWS.__wcB2bPerf) return true;
    var base = VIEWS.investment;
    VIEWS.investment = function (parts, params) {
      var html = base.apply(this, arguments);
      if ((parts && parts[1]) === 'b2b' && !(parts && parts[2])) {
        try { html = html + cardHtml(me()); } catch (e) {}
      }
      return html;
    };
    VIEWS.__wcB2bPerf = true;
    if (typeof AFTER !== 'undefined') {
      var prev = AFTER.investment;
      AFTER.investment = function (parts) {
        if (typeof prev === 'function') { try { prev.apply(this, arguments); } catch (e) {} }
        if ((parts && parts[1]) !== 'b2b' || (parts && parts[2])) return;
        styles();
        mountCard();
      };
    }
    return true;
  }

  var tries = 0;
  (function boot() {
    if (!patch()) { if (tries++ < 100) return setTimeout(boot, 400); return; }
    styles();
    setInterval(function () {
      var h = String(location.hash || '');
      if (h.indexOf('#/investment/b2b') !== 0) return;
      mountCard();
      PERF.refreshAll();
    }, 3000);
    document.addEventListener('change', function (ev) {
      var t = ev.target;
      if (!t || !t.matches || !t.matches('[data-b2b-perf-pick]')) return;
      selected = String(t.value || '').toUpperCase();
      try { render(); } catch (e) {}
    }, false);
  })();
})();
