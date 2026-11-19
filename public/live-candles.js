/* =========================================================================
   WhaleChat Live Trade Chart — real-time candlesticks
   -------------------------------------------------------------------------
   Implements the TradingView Lightweight Charts streaming-candlestick view:

       container (flex column) → chart element (flex:1, minHeight:0)
       createChart(chartElement, { layout, grid, autoSize:true })
       chart.addSeries(CandlestickSeries, { upColor:'#26a69a', … })
       series.setData(candles) → fitContent() → scrollToPosition(5)
       setInterval(…, 100) → series.update(nextPoint)
       "Go to realtime" button → chart.timeScale().scrollToRealTime()

   The difference from the demo: there is no generateData()/samplePoint()
   synthetic walk. Every number on this chart comes from the WhaleChat market
   engine:

     · history  GET /api/market/history?tickers=<T>  → the ticks the backend
                actually recorded, bucketed into OHLC candles for the chosen
                timeframe
     · fallback GET /api/market/candles?symbol=<T>   → provider candles when a
                provider supplies them
     · live     INV.live[<T>] / INV.quote(<T>)       → the same real quotes the
                rest of the app paints, eased between server ticks so the
                candle grows continuously (the app's own animateQuote pattern)

   It never invents a price: with no ticks yet the chart says so and waits.

   Public API
     WC_LIVE_CANDLES.embed({ ticker, sub, height }) -> chart markup
     WC_LIVE_CANDLES.mountAll()                     -> mount pending charts
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__wcLiveCandles) return;
  window.__wcLiveCandles = true;

  var LC = (window.WC_LIVE_CANDLES = window.WC_LIVE_CANDLES || {});
  var LIB_URL = 'https://esm.sh/lightweight-charts@5.3.0';
  var TF_SEC = { '1m': 60, '5m': 300, '15m': 900, '1H': 3600, '1D': 86400 };
  var TF_ORDER = ['1m', '5m', '15m', '1H', '1D'];
  var TICK_MS = 100;          /* the demo's streaming cadence */
  var instances = [];
  var libPromise = null;

  function loadLib() {
    if (libPromise) return libPromise;
    libPromise = import(LIB_URL).then(function (m) {
      if (!m || !m.createChart || !m.CandlestickSeries) throw new Error('lightweight-charts v5 missing exports');
      return m;
    });
    return libPromise;
  }

  function apiPath(p) {
    try { if (typeof Remote !== 'undefined' && Remote && Remote.enabled) return Remote.url(p); } catch (e) {}
    return p;
  }
  function getJSON(pathname, timeout) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeout || 9000);
    return fetch(apiPath(pathname), { signal: ctrl.signal, headers: { 'content-type': 'application/json' } })
      .then(function (r) { return r.json().catch(function () { return null; }); })
      .finally(function () { clearTimeout(timer); });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function fmt(v) {
    var n = Number(v);
    if (!isFinite(n)) return '—';
    var d = Math.abs(n) >= 1000 ? 2 : Math.abs(n) >= 1 ? 2 : 5;
    return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  /* ---------------------------------------------------------------- styles */
  function ensureStyles() {
    if (document.getElementById('wc-lc-style')) return;
    var st = document.createElement('style');
    st.id = 'wc-lc-style';
    st.textContent = [
      '.wc-lc{display:flex;flex-direction:column;gap:8px;min-width:0}',
      '.wc-lc-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap}',
      '.wc-lc-title{display:flex;align-items:center;gap:8px;font-family:var(--display,"Sora",sans-serif);',
      '  font-weight:700;font-size:14px;letter-spacing:-.01em;color:#06202c}',
      '.wc-lc-live{display:inline-flex;align-items:center;gap:4px;font-size:8.5px;font-weight:800;letter-spacing:.09em;',
      '  color:#0f9d6b;border:1px solid rgba(15,157,107,.4);border-radius:999px;padding:2px 7px;background:rgba(15,157,107,.07)}',
      '.wc-lc-live i{width:5px;height:5px;border-radius:50%;background:#0f9d6b;animation:wcLcPulse 1.6s ease-in-out infinite}',
      '@keyframes wcLcPulse{0%,100%{opacity:1}50%{opacity:.25}}',
      '.wc-lc-sub{font-size:10.5px;color:#8ba4b6;margin-top:1px}',
      '.wc-lc-px{text-align:right;min-width:110px}',
      '.wc-lc-price{font-size:21px;font-weight:800;line-height:1.1;color:#06202c;font-variant-numeric:tabular-nums}',
      '.wc-lc-chg{font-size:11px;font-weight:700;font-variant-numeric:tabular-nums}',
      '.wc-lc-chg.up{color:#0f9d6b}.wc-lc-chg.down{color:#e11d48}',
      '.wc-lc-tfs{display:flex;align-items:center;gap:5px;flex-wrap:wrap}',
      '.wc-lc-chip{border:1px solid #E1E8EC;background:#fff;color:#43606f;border-radius:8px;',
      '  font:600 11px/1 Inter,-apple-system,sans-serif;padding:6px 9px;cursor:pointer}',
      '.wc-lc-chip:hover{background:#F3F7F9}',
      '.wc-lc-chip[aria-pressed="true"]{background:#06202c;border-color:#06202c;color:#fff}',
      '.wc-lc-src{margin-left:auto;font-size:9.5px;color:#8ba4b6;white-space:nowrap}',
      '.wc-lc-src b{color:#0f9d6b;font-weight:700}',
      '.wc-lc-body{position:relative;height:380px;min-height:220px;background:#fff;',
      '  border:1px solid #E3E9EC;border-radius:12px;overflow:hidden;display:flex;flex-direction:column}',
      '.wc-lc-canvas{flex:1;min-height:0}',
      '.wc-lc-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;',
      '  text-align:center;padding:18px;font-size:12px;color:#8ba4b6;background:#fff;z-index:2;line-height:1.6}',
      '.wc-lc-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}',
      '.wc-lc-btn{all:initial;font-family:-apple-system,BlinkMacSystemFont,"Trebuchet MS",Roboto,Ubuntu,sans-serif;',
      '  font-size:14px;font-weight:510;line-height:20px;letter-spacing:-.32px;padding:7px 18px;',
      '  color:rgba(19,23,34,1);background-color:rgba(240,243,250,1);border-radius:8px;cursor:pointer}',
      '.wc-lc-btn:hover{background-color:rgba(224,227,235,1)}',
      '.wc-lc-btn:active{background-color:rgba(209,212,220,1)}',
      '.wc-lc-note{font-size:9.5px;color:#8ba4b6;line-height:1.5}',
      /* the stock card already shows the big live price above the chart */
      '.inv-pricecard .wc-lc-px{display:none}',
      '@media(max-width:520px){.wc-lc-body{height:300px}.wc-lc-price{font-size:18px}}'
    ].join('\n');
    document.head.appendChild(st);
  }

  /* ---------------------------------------------------------------- markup */
  LC.embed = function (opts) {
    opts = opts || {};
    ensureStyles();
    var t = String(opts.ticker || '').toUpperCase();
    var tf = TF_SEC[opts.tf] ? opts.tf : 'auto';
    var chips = TF_ORDER.map(function (x) {
      return '<button type="button" class="wc-lc-chip" data-lc-tf-btn="' + x + '" aria-pressed="false">' + x + '</button>';
    }).join('');
    return '<div class="wc-lc" data-wc-lc>' +
      '<div class="wc-lc-head">' +
        '<div>' +
          '<div class="wc-lc-title">' + esc(t) + '<span class="wc-lc-live"><i></i>LIVE</span></div>' +
          '<div class="wc-lc-sub">' + esc(opts.sub || 'Real-time price action') + '</div>' +
        '</div>' +
        '<div class="wc-lc-px">' +
          '<div class="wc-lc-price" data-lc-price>—</div>' +
          '<div class="wc-lc-chg" data-lc-chg>—</div>' +
        '</div>' +
      '</div>' +
      '<div class="wc-lc-tfs">' + chips +
        '<span class="wc-lc-src" data-lc-src>Connecting to the live feed…</span>' +
      '</div>' +
      '<div class="wc-lc-body" data-wc-lc-chart="' + esc(t) + '" data-lc-tf="' + tf + '"' +
        (opts.height ? ' style="height:' + parseInt(opts.height, 10) + 'px"' : '') + '>' +
        '<div class="wc-lc-empty">Loading real market candles…</div>' +
      '</div>' +
      '<div class="wc-lc-foot">' +
        '<button type="button" class="wc-lc-btn" data-lc-realtime>Go to realtime</button>' +
        '<span class="wc-lc-note" data-lc-note>Prices come from the WhaleChat live market feed.</span>' +
      '</div>' +
    '</div>';
  };

  /* ------------------------------------------------------------ data prep */
  function bucketTicks(ticks, sec) {
    var map = new Map();
    (ticks || []).forEach(function (x) {
      var p = Number(x.p != null ? x.p : x.price);
      var ms = Number(x.t != null ? x.t : x.time);
      if (!(p > 0) || !(ms > 0)) return;
      if (ms < 1e12) ms = ms * 1000;                       /* seconds → ms */
      var time = Math.floor(ms / 1000 / sec) * sec;
      var c = map.get(time);
      if (!c) map.set(time, { time: time, open: p, high: p, low: p, close: p });
      else { c.high = Math.max(c.high, p); c.low = Math.min(c.low, p); c.close = p; }
    });
    return Array.from(map.values()).sort(function (a, b) { return a.time - b.time; });
  }
  function cleanCandles(list) {
    var seen = new Set(), out = [];
    (list || []).forEach(function (c) {
      var t = Number(c.time), o = Number(c.open), h = Number(c.high), l = Number(c.low), cl = Number(c.close);
      if (!(t > 0) || ![o, h, l, cl].every(function (v) { return isFinite(v) && v > 0; })) return;
      if (seen.has(t)) return;
      seen.add(t);
      out.push({ time: t, open: o, high: Math.max(h, o, cl), low: Math.min(l, o, cl), close: cl });
    });
    return out.sort(function (a, b) { return a.time - b.time; });
  }

  function historyFor(ticker) {
    return getJSON('/api/market/history?tickers=' + encodeURIComponent(ticker) + '&limit=1500')
      .then(function (d) {
        var h = (d && d.history) ? (d.history[ticker] || h0(d.history)) : [];
        return { ticks: h || [], source: (d && d.source) || '' };
      })
      .catch(function () { return { ticks: [], source: '' }; });
  }
  function h0(h) { var k = Object.keys(h); return k.length ? h[k[0]] : []; }

  function providerCandles(ticker, tf) {
    return getJSON('/api/market/candles?symbol=' + encodeURIComponent(ticker) + '&tf=' + tf)
      .then(function (d) { return (d && d.candles && d.candles.length) ? { candles: d.candles, source: d.source || '' } : null; })
      .catch(function () { return null; });
  }

  /* --------------------------------------------------------------- mount */
  /* INV and LT are script-scoped globals in this bundle — not window properties —
     so they are read through `typeof` guards, exactly like the other modules. */
  function livePrice(ticker) {
    var q = null;
    try { if (typeof INV !== 'undefined' && INV && INV.quote) q = INV.quote(ticker); } catch (e) {}
    if (!q || !(Number(q.price) > 0)) {
      try { if (typeof INV !== 'undefined' && INV.live && INV.live[ticker]) q = INV.live[ticker]; } catch (e) {}
    }
    return q;
  }

  function mount(body) {
    if (!body || body.__lc || !document.body.contains(body)) return;
    var ticker = body.getAttribute('data-wc-lc-chart');
    if (!ticker) return;
    body.__lc = { ticker: ticker, tf: body.getAttribute('data-lc-tf') || 'auto' };
    var sheet = body.closest('[data-wc-lc]');
    var priceEl = sheet && sheet.querySelector('[data-lc-price]');
    var chgEl = sheet && sheet.querySelector('[data-lc-chg]');
    var srcEl = sheet && sheet.querySelector('[data-lc-src]');
    var noteEl = sheet && sheet.querySelector('[data-lc-note]');

    function note(msg) { if (noteEl) noteEl.textContent = msg; }
    function src(html) { if (srcEl) srcEl.innerHTML = html; }

    loadLib().then(function (LWC) {
      if (!document.body.contains(body)) return;

      /* the demo's container layout: flex column, chart flexes, min-height 0 */
      body.innerHTML = '';
      body.style.display = 'flex';
      body.style.flexDirection = 'column';
      var chartElement = document.createElement('div');
      chartElement.className = 'wc-lc-canvas';
      chartElement.style.flex = '1';
      chartElement.style.minHeight = '0';
      body.appendChild(chartElement);

      var chartOptions = {
        layout: { textColor: 'black', background: { type: 'solid', color: 'white' } },
        grid: { vertLines: { color: '#D6DCDE' }, horzLines: { color: '#D6DCDE' } },
        autoSize: true,
        timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 5 },
        crosshair: { mode: 0 }
      };
      var chart = LWC.createChart(chartElement, chartOptions);
      var series = chart.addSeries(LWC.CandlestickSeries, {
        upColor: '#26a69a',
        downColor: '#ef5350',
        borderVisible: false,
        wickUpColor: '#26a69a',
        wickDownColor: '#ef5350'
      });

      var state = {
        chart: chart, series: series, LWC: LWC, body: body, ticker: ticker, tf: body.getAttribute('data-lc-tf') || 'auto',
        last: null, target: 0, shown: 0, timer: 0, dead: false, lines: [], ticks: 0, quote: null
      };
      body.__lcState = state;
      instances.push(state);

      /* header price from the real quote */
      function paintHeader() {
        var q = livePrice(ticker);
        if (q && Number(q.price) > 0) state.quote = q;
        var p = state.quote ? Number(state.quote.price) : (state.last ? state.last.close : 0);
        if (!(p > 0)) return;
        var pc = state.quote ? (Number(state.quote.prevClose) || p) : p;
        var ch = state.quote ? Number(state.quote.changePct) : 0;
        if (!isFinite(ch)) ch = pc ? ((p - pc) / pc) * 100 : 0;
        if (priceEl) priceEl.textContent = fmt(p);
        if (chgEl) {
          chgEl.textContent = (ch >= 0 ? '+' : '') + ch.toFixed(2) + '%';
          chgEl.className = 'wc-lc-chg ' + (ch >= 0 ? 'up' : 'down');
        }
      }

      /* entry / TP / SL from the account's open trade on this ticker */
      function drawTradeLines() {
        var pos = null;
        try {
          var u = (typeof me === 'function') ? me() : null;
          if (u && typeof LT !== 'undefined' && LT && LT.open) {
            pos = (LT.open(u.id) || []).filter(function (t) { return t.ticker === ticker; })[0] || null;
          }
        } catch (e) {}
        if (!pos) return;
        var add = function (price, color, title) {
          var p = Number(price);
          if (!(p > 0)) return;
          try {
            state.lines.push(series.createPriceLine({
              price: p, color: color, lineWidth: 1, lineStyle: 2,
              axisLabelVisible: true, title: title
            }));
          } catch (e) {}
        };
        add(pos.entryPrice, '#2f6feb', 'Entry');
        add(pos.takeProfitPrice, '#0f9d6b', 'TP');
        add(pos.stopLossPrice, '#e11d48', 'SL');
      }

      function setEmpty(msg) {
        if (!document.body.contains(body)) return;
        var el = body.querySelector('.wc-lc-empty');
        if (!el) {
          el = document.createElement('div');
          el.className = 'wc-lc-empty';
          body.appendChild(el);
        }
        el.textContent = msg;
      }
      function clearEmpty() {
        var el = body.querySelector('.wc-lc-empty');
        if (el) el.remove();
      }

      function applyData(candles, source, tfUsed) {
        candles = cleanCandles(candles);
        if (candles.length < 2) return false;
        series.setData(candles);
        chart.timeScale().fitContent();
        chart.timeScale().scrollToPosition(5);
        state.last = candles[candles.length - 1];
        state.shown = state.last.close;
        state.target = state.last.close;
        state.tf = tfUsed || state.tf;
        clearEmpty();
        drawTradeLines();
        paintHeader();
        return true;
      }

      function pickTf(ticks) {
        var fallback = '1m';
        for (var i = 0; i < TF_ORDER.length; i++) {
          var tt = TF_ORDER[i];
          var n = bucketTicks(ticks, TF_SEC[tt]).length;
          if (n >= 2) fallback = tt;
          if (n >= 40) return tt;             /* finest timeframe with a full screen of candles */
        }
        return fallback;                       /* otherwise the coarsest one that still has data */
      }
      function markChip(tf) {
        if (!sheet) return;
        sheet.querySelectorAll('[data-lc-tf-btn]').forEach(function (b) {
          b.setAttribute('aria-pressed', String(b.getAttribute('data-lc-tf-btn') === tf));
        });
      }

      function load(tf, auto) {
        state.tf = tf;
        return historyFor(ticker).then(function (h) {
          if (state.dead) return;
          if (auto || tf === 'auto') tf = pickTf(h.ticks);
          state.tf = tf;
          markChip(tf);
          var sec = TF_SEC[tf] || 3600;
          var candles = bucketTicks(h.ticks, sec);
          if (applyData(candles, h.source, tf)) {
            var real = (h.ticks || []).some(function (x) { return x && (x.real === true || x.source === 'live'); });
            src(real ? '<b>LIVE</b> · ' + candles.length + ' ' + tf + ' candles' : 'Feed · ' + candles.length + ' ' + tf + ' candles');
            note(real
              ? 'Ticks recorded by the WhaleChat market engine, bucketed into ' + tf + ' candles.'
              : 'Live feed is caching — candles form from the ticks this session records.');
            return;
          }
          return providerCandles(ticker, tf).then(function (p) {
            if (state.dead) return;
            if (p && applyData(p.candles, p.source, tf)) {
              src('<b>' + String(p.source || 'PROVIDER').toUpperCase() + '</b> · ' + p.candles.length + ' ' + tf + ' candles');
              note('Candles supplied by ' + (p.source || 'the market provider') + '.');
              return;
            }
            /* not enough history for this timeframe yet */
            if (tf !== '1m') {
              note('Not enough ' + tf + ' history yet — showing the finest timeframe instead.');
              return load(fallbackTf(tf));
            }
            setEmpty('Waiting for the first real ticks on ' + ticker + '…');
            src('Feed · waiting for ticks');
            note('The chart draws itself from live ticks — no synthetic prices.');
          });
        });
      }

      function fallbackTf(tf) {
        var i = TF_ORDER.indexOf(tf);
        return i > 0 ? TF_ORDER[i - 1] : '1m';
      }

      /* ---- streaming: 100ms, exactly like the demo, but real ------------ */
      function push(price) {
        if (!(price > 0)) return;
        var sec = TF_SEC[state.tf] || 3600;
        var time = Math.floor(Date.now() / 1000 / sec) * sec;
        var c = state.last;
        if (!c || time > c.time) {
          var next = { time: time, open: price, high: price, low: price, close: price };
          state.last = next;
          try { series.update(next); } catch (e) { try { series.update({ time: c ? c.time + 1 : time, open: price, high: price, low: price, close: price }); } catch (e2) {} }
          return;
        }
        if (time < c.time) return;
        c.close = price;
        c.high = Math.max(c.high, price);
        c.low = Math.min(c.low, price);
        try { series.update({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }); } catch (e) {}
      }

      state.timer = setInterval(function () {
        if (state.dead) return;
        state.ticks++;
        if (!document.body.contains(body)) { teardown(); return; }
        var q = livePrice(ticker);
        if (q && Number(q.price) > 0) {
          state.target = Number(q.price);
          if (!state.shown) state.shown = state.target;
          var diff = state.target - state.shown;
          state.shown = Math.abs(diff) < 1e-9 ? state.target : state.shown + diff * 0.30;
          push(state.shown);
          paintHeader();
        }
      }, TICK_MS);

      /* timeframe chips + "Go to realtime" */
      if (sheet) {
        sheet.addEventListener('click', function (ev) {
          var chip = ev.target.closest('[data-lc-tf-btn]');
          if (chip) {
            var tf = chip.getAttribute('data-lc-tf-btn');
            sheet.querySelectorAll('[data-lc-tf-btn]').forEach(function (b) {
              b.setAttribute('aria-pressed', String(b === chip));
            });
            state.lines.forEach(function (l) { try { series.removePriceLine(l); } catch (e) {} });
            state.lines = [];
            load(tf);
            return;
          }
          if (ev.target.closest('[data-lc-realtime]')) {
            try { chart.timeScale().scrollToRealTime(); } catch (e) {}
          }
        });
      }

      function teardown() {
        if (state.dead) return;
        state.dead = true;
        clearInterval(state.timer);
        try { chart.remove(); } catch (e) {}
        var i = instances.indexOf(state);
        if (i >= 0) instances.splice(i, 1);
      }
      state.teardown = teardown;
      window.addEventListener('pagehide', teardown);

      paintHeader();
      load(state.tf, state.tf === 'auto');
    }).catch(function (err) {
      if (!document.body.contains(body)) return;
      body.innerHTML = '<div class="wc-lc-empty">Live chart engine could not load (' +
        esc(String(err && err.message || err).slice(0, 90)) + ').</div>';
      src('Offline');
    });
  }

  /* ------------------------------------------------------------- mounting */
  LC.mountAll = function (root) {
    var scope = (root && root.querySelectorAll) ? root : document;
    scope.querySelectorAll('[data-wc-lc-chart]').forEach(function (b) {
      if (!b.__lc) mount(b);
    });
  };

  var timer = null;
  function schedule() {
    if (timer) return;
    timer = setTimeout(function () { timer = null; LC.mountAll(); }, 120);
  }

  function boot() {
    ensureStyles();
    LC.mountAll();
    var root = document.getElementById('app') || document.body;
    if (root && window.MutationObserver) {
      new MutationObserver(schedule).observe(root, { childList: true, subtree: true });
    }
    window.addEventListener('hashchange', schedule);
    /* reap charts whose markup the SPA replaced */
    setInterval(function () {
      instances.slice().forEach(function (s) {
        if (s.dead) return;
        if (!document.body.contains(s.body)) { try { s.teardown(); } catch (e) {} }
      });
    }, 4000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
