/* =========================================================================
   WhaleChat · native candlestick / line chart (wc-native-chart)
   -------------------------------------------------------------------------
   A completely in-app chart. No TradingView widget, no iframe, no external
   library — one <canvas> with:

     · candlesticks (green/red) and a line mode, volume histogram
     · price + time axes, last-price tag, crosshair with OHLC readout
     · 1m / 5m / 15m / 1H / 1D timeframes, scroll-free auto-scale
     · the header status badge:  LIVE MARKET (green) when the bars come from
       Finnhub / Twelve Data / Binance, OFFLINE SIMULATED (amber) when they
       come from WC_SIM inside the installed app with no connection.

   Data sources, in order
     online   1. GET /api/market/candles?symbol&tf   (provider OHLCV)
              2. GET /api/market/history?tickers     (recorded ticks → bars)
              3. IndexedDB candle cache (last session)
     offline  WC_SIM ticks seeded from the last cached real close
   Every fetched series is written back to IndexedDB so the next cold start
   has history before the network answers.

   Public API
     WC_NCHART.mount(el, {symbol, tf, height})   → controller
     WC_NCHART.open(symbol)                      → full-screen chart sheet
     WC_NCHART.candles(symbol, tf)               → Promise<bars>
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || !window.document) return;
  if (window.WC_NCHART) return;

  var TF_SEC = { '1m': 60, '5m': 300, '15m': 900, '1H': 3600, '1D': 86400 };
  var controllers = [];

  function device() { return window.WC_DEVICE || null; }
  function sim() { return window.WC_SIM || null; }
  function mode() { return window.WC_MODE || { installed: false, online: navigator.onLine !== false }; }
  function apiBase() {
    try { return window.WC_SERVERS ? WC_SERVERS.api : function (p) { return p; }; } catch (e) { return function (p) { return p; }; }
  }

  function fetchJSON(path, ms) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms || 9000);
    return fetch(apiBase()(path), { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .finally(function () { clearTimeout(timer); });
  }

  function norm(bars) {
    return (bars || []).map(function (b) {
      return {
        t: Number(b.t || b.time || 0) * (Number(b.t) > 1e12 ? 1 : 1000),
        o: Number(b.o != null ? b.o : b.open) || 0,
        h: Number(b.h != null ? b.h : b.high) || 0,
        l: Number(b.l != null ? b.l : b.low) || 0,
        c: Number(b.c != null ? b.c : b.close) || 0,
        v: Number(b.v != null ? b.v : b.volume) || 0
      };
    }).filter(function (b) { return b.c > 0 && b.t > 0; });
  }

  /* ticks → OHLC bars */
  function aggregate(ticks, stepSec) {
    var buckets = {};
    (ticks || []).forEach(function (tk) {
      var t = Number(tk.t || tk.time || 0);
      if (t < 1e12) t *= 1000;
      var p = Number(tk.p != null ? tk.p : tk.price) || 0;
      if (!(p > 0) || !t) return;
      var key = Math.floor(t / (stepSec * 1000)) * stepSec * 1000;
      var b = buckets[key];
      if (!b) buckets[key] = { t: key, o: p, h: p, l: p, c: p, v: 1 };
      else { b.c = p; if (p > b.h) b.h = p; if (p < b.l) b.l = p; b.v++; }
    });
    return Object.keys(buckets).map(function (k) { return buckets[k]; }).sort(function (a, b) { return a.t - b.t; });
  }

  function store(symbol, tf, bars) {
    try { if (device()) device().saveCandles(symbol, tf, bars); } catch (e) {}
  }

  function candles(symbol, tf) {
    var sym = String(symbol || '').toUpperCase();
    var step = TF_SEC[tf] || 60;
    var cached = device() ? device().getCandles(sym, tf) : Promise.resolve([]);

    if (!mode().online && !navigator.onLine) {
      return cached.then(function (rows) { return rows && rows.length ? rows : []; });
    }

    return fetchJSON('/api/market/candles?symbol=' + encodeURIComponent(sym) + '&tf=' + encodeURIComponent(tf))
      .then(function (j) {
        var bars = norm(j && j.candles);
        if (bars.length) { store(sym, tf, bars); return bars; }
        return fetchJSON('/api/market/history?tickers=' + encodeURIComponent(sym) + '&limit=1200')
          .then(function (h) {
            var ticks = (h && (h[sym] || h.tickers && h.tickers[sym])) || [];
            var agg = aggregate(ticks, step);
            if (agg.length) { store(sym, tf, agg); return agg; }
            return cached;
          });
      })
      .then(function (rows) { return rows || []; })
      .catch(function () { return cached; });
  }

  /* ------------------------------------------------------------- renderer */
  function Chart(host, opts) {
    opts = opts || {};
    this.host = host;
    this.symbol = String(opts.symbol || 'AAPL').toUpperCase();
    this.tf = opts.tf || '1H';
    this.mode = 'candle';
    this.bars = [];
    this.hover = -1;
    this.live = mode().online !== false;
    this.source = '';
    this.destroyed = false;
    this.build();
    this.setSymbol(this.symbol, this.tf);
  }

  Chart.prototype.build = function () {
    var self = this;
    var h = Number(this.host.getAttribute('data-height')) || 300;
    this.host.innerHTML =
      '<div class="wcnc" style="position:relative;border-radius:16px;overflow:hidden;background:linear-gradient(180deg,#071722,#04101a);border:1px solid rgba(255,255,255,.08)">' +
        '<div class="wcnc-head" style="display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.06)">' +
          '<div style="min-width:0;flex:1">' +
            '<div style="display:flex;align-items:center;gap:7px">' +
              '<b class="wcnc-sym" style="font-size:15px;letter-spacing:-.01em;color:#e9f4f9">' + this.symbol + '</b>' +
              '<span class="wcnc-badge" style="font-size:9.5px;font-weight:800;letter-spacing:.07em;padding:3px 7px;border-radius:6px;border:1px solid #2ee6c955;color:#2ee6c9;background:#2ee6c912">LIVE MARKET</span>' +
            '</div>' +
            '<div class="wcnc-px" style="font-size:20px;font-weight:800;color:#e9f4f9;line-height:1.25">—</div>' +
            '<div class="wcnc-chg" style="font-size:11.5px;font-weight:700;color:#8ba7b8">—</div>' +
          '</div>' +
          '<div style="display:flex;gap:4px;align-items:center">' +
            '<button class="wcnc-tf" data-tf="1m">1m</button><button class="wcnc-tf" data-tf="5m">5m</button>' +
            '<button class="wcnc-tf" data-tf="15m">15m</button><button class="wcnc-tf" data-tf="1H">1H</button>' +
            '<button class="wcnc-tf" data-tf="1D">1D</button>' +
          '</div>' +
        '</div>' +
        '<canvas class="wcnc-cv" style="display:block;width:100%;height:' + h + 'px;touch-action:pan-y"></canvas>' +
        '<div class="wcnc-src" style="position:absolute;right:10px;bottom:6px;font-size:9.5px;color:#4f6b7c;letter-spacing:.04em"></div>' +
      '</div>';

    this.root = this.host.firstElementChild;
    this.canvas = this.root.querySelector('.wcnc-cv');
    this.ctx = this.canvas.getContext('2d');
    this.head = this.root.querySelector('.wcnc-head');
    this.badge = this.root.querySelector('.wcnc-badge');
    this.pxEl = this.root.querySelector('.wcnc-px');
    this.chgEl = this.root.querySelector('.wcnc-chg');
    this.srcEl = this.root.querySelector('.wcnc-src');
    this.tfBtns = Array.prototype.slice.call(this.root.querySelectorAll('.wcnc-tf'));

    this.tfBtns.forEach(function (b) {
      b.style.cssText = 'border:1px solid rgba(255,255,255,.1);background:transparent;color:#8ba7b8;font-size:10px;font-weight:700;padding:4px 6px;border-radius:7px';
      b.addEventListener('click', function () { self.setTf(b.getAttribute('data-tf')); });
    });

    this.canvas.addEventListener('pointermove', function (e) {
      var r = self.canvas.getBoundingClientRect();
      self.hover = e.clientX - r.left;
      self.paint();
    });
    this.canvas.addEventListener('pointerleave', function () { self.hover = -1; self.paint(); });

    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(function () { self.paint(); });
      this.ro.observe(this.canvas);
    }
    window.addEventListener('orientationchange', function () { setTimeout(function () { self.paint(); }, 250); });
  };

  Chart.prototype.setSymbol = function (symbol, tf) {
    var self = this;
    this.symbol = String(symbol || this.symbol).toUpperCase();
    if (tf) this.tf = tf;
    this.host.setAttribute('data-symbol', this.symbol);
    var symEl = this.root.querySelector('.wcnc-sym');
    if (symEl) symEl.textContent = this.symbol;
    this.tfBtns.forEach(function (b) {
      var on = b.getAttribute('data-tf') === self.tf;
      b.style.color = on ? '#04101a' : '#8ba7b8';
      b.style.background = on ? '#2ee6c9' : 'transparent';
      b.style.borderColor = on ? '#2ee6c9' : 'rgba(255,255,255,.1)';
    });
    this.load();
    return this;
  };

  Chart.prototype.setTf = function (tf) {
    if (!TF_SEC[tf]) return;
    this.setSymbol(this.symbol, tf);
  };

  Chart.prototype.load = function () {
    var self = this;
    var token = (this._token = (this._token || 0) + 1);
    var offline = !navigator.onLine || (window.WC_MODE && !WC_MODE.online);
    this.source = offline ? 'sim' : 'loading';
    this.paintBadge();
    candles(this.symbol, this.tf).then(function (bars) {
      if (self.destroyed || token !== self._token) return;
      self.bars = bars || [];
      self.ms = (TF_SEC[self.tf] || 60) * 1000;
      if (offline) self.startSim();
      else self.attachLive();
      self.paint();
      if (!self.bars.length && !offline) self.source = 'no-data';
      self.paintBadge();
    });
  };

  Chart.prototype.startSim = function () {
    var S = sim();
    if (!S) return;
    var self = this;
    var last = this.bars.length ? this.bars[this.bars.length - 1] : null;
    var q = S.start(this.symbol, {
      seedPrice: last ? last.c : 0,
      candles: this.bars,
      assetType: /USDT$/.test(this.symbol) ? 'crypto' : 'stock'
    });
    this.source = q ? 'sim' : 'sim-empty';
    if (this._unsub) this._unsub();
    this._unsub = S.subscribe(function (st) {
      if (self.destroyed || st.symbol !== self.symbol) return;
      var cur = st.bar;
      if (!cur) return;
      var lastBar = self.bars[self.bars.length - 1];
      if (lastBar && Math.floor(lastBar.t / 60000) === Math.floor(cur.t / 60000)) self.bars[self.bars.length - 1] = Object.assign({}, cur);
      else self.bars.push(Object.assign({}, cur));
      self.quote = st.quote;
      self.paint();
    });
    self.quote = q;
    this.paintBadge();
  };

  Chart.prototype.attachLive = function () {
    var self = this;
    if (this._timer) clearInterval(this._timer);
    if (this._unsub) { this._unsub(); this._unsub = null; }
    this._timer = setInterval(function () {
      if (self.destroyed) return;
      if (!navigator.onLine) { clearInterval(self._timer); self._timer = null; self.load(); return; }
      var p = 0;
      try {
        if (typeof INV !== 'undefined' && INV.live && INV.live[self.symbol]) p = Number(INV.live[self.symbol].price) || 0;
      } catch (e) {}
      if (!p) { var q = sim() && sim().realQuote(self.symbol); p = Number(q) || 0; }
      if (p > 0) self.pushTick(p, Date.now());
    }, 2000);
  };

  Chart.prototype.pushTick = function (price, at) {
    var step = this.ms || 3600000;
    var key = Math.floor(at / step) * step;
    var last = this.bars[this.bars.length - 1];
    if (last && last.t === key) {
      last.c = price;
      if (price > last.h) last.h = price;
      if (price < last.l) last.l = price;
      last.v = (last.v || 0) + 1;
    } else if (!last || last.t < key) {
      this.bars.push({ t: key, o: price, h: price, l: price, c: price, v: 1 });
      if (this.bars.length > 2000) this.bars.shift();
    }
    this.quote = { price: price, simulated: false, asOf: at };
    if (!this._paintQ) {
      this._paintQ = true;
      var self = this;
      requestAnimationFrame(function () { self._paintQ = false; self.paint(); });
    }
  };

  Chart.prototype.paintBadge = function () {
    if (!this.badge) return;
    var live = this.source !== 'sim' && this.source !== 'sim-empty' && navigator.onLine;
    this.badge.textContent = live ? (this.source === 'loading' ? 'CONNECTING' : 'LIVE MARKET') : 'OFFLINE SIMULATED';
    this.badge.style.color = live ? '#2ee6c9' : '#f5b544';
    this.badge.style.borderColor = live ? '#2ee6c955' : '#f5b54455';
    this.badge.style.background = live ? '#2ee6c912' : '#f5b54414';
    if (this.srcEl) {
      this.srcEl.textContent = live
        ? (this.source === 'loading' ? 'connecting…' : 'Finnhub · Twelve Data · Binance')
        : 'device simulator · seeded from last real close';
    }
  };

  Chart.prototype.paint = function () {
    if (this.destroyed || !this.canvas) return;
    var cv = this.canvas;
    var rect = cv.getBoundingClientRect();
    var dpr = Math.min(3, window.devicePixelRatio || 1);
    var W = Math.max(240, Math.round(rect.width || 340));
    var H = Math.max(140, Math.round(rect.height || 300));
    if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
    var g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    var bars = this.bars;
    var padR = 58, padB = 22, padT = 8, padL = 6;
    var plotW = W - padL - padR, plotH = H - padT - padB;

    if (!bars.length) {
      g.fillStyle = '#5d7a8c';
      g.font = '600 12px -apple-system, Segoe UI, Roboto, sans-serif';
      g.textAlign = 'center';
      g.fillText(this.source === 'sim-empty' ? 'No cached price for this asset yet' : 'Loading candles…', W / 2, H / 2);
      this.paintHeader();
      return;
    }

    var hi = -Infinity, lo = Infinity;
    bars.forEach(function (b) { if (b.h > hi) hi = b.h; if (b.l < lo) lo = b.l; });
    var span = hi - lo || hi * 0.01 || 1;
    hi += span * 0.06; lo -= span * 0.06;
    var y = function (v) { return padT + (hi - v) / (hi - lo) * plotH; };
    var n = Math.min(bars.length, Math.floor(plotW / 5) || bars.length);
    var view = bars.slice(-n);
    var bw = plotW / view.length;
    var x = function (i) { return padL + i * bw + bw / 2; };

    /* grid + price axis */
    g.strokeStyle = 'rgba(255,255,255,.055)';
    g.fillStyle = '#5d7a8c';
    g.font = '10px -apple-system, Segoe UI, Roboto, sans-serif';
    g.lineWidth = 1;
    for (var i = 0; i <= 4; i++) {
      var v = lo + (hi - lo) * (i / 4);
      var yy = Math.round(y(v)) + 0.5;
      g.beginPath(); g.moveTo(padL, yy); g.lineTo(W - padR, yy); g.stroke();
      g.textAlign = 'left';
      g.fillText(fmt(v), W - padR + 6, yy + 3);
    }

    /* volume, bottom 18% */
    var maxV = 1;
    view.forEach(function (b) { if ((b.v || 0) > maxV) maxV = b.v; });
    view.forEach(function (b, i) {
      var vh = Math.max(1, (b.v || 0) / maxV * plotH * 0.16);
      g.fillStyle = b.c >= b.o ? 'rgba(46,230,201,.16)' : 'rgba(255,92,110,.16)';
      g.fillRect(padL + i * bw + bw * 0.15, padT + plotH - vh, Math.max(1, bw * 0.7), vh);
    });

    if (this.mode === 'line') {
      g.beginPath();
      view.forEach(function (b, i) { var xx = x(i), yy = y(b.c); if (i === 0) g.moveTo(xx, yy); else g.lineTo(xx, yy); });
      g.strokeStyle = '#2ee6c9'; g.lineWidth = 2; g.stroke();
    } else {
      view.forEach(function (b, i) {
        var cx = padL + i * bw + bw / 2;
        var up = b.c >= b.o;
        g.strokeStyle = up ? '#2ee6c9' : '#ff5c6e';
        g.fillStyle = up ? '#2ee6c9' : '#ff5c6e';
        g.lineWidth = Math.max(1, Math.min(3, bw * 0.16));
        g.beginPath(); g.moveTo(cx, y(b.h)); g.lineTo(cx, y(b.l)); g.stroke();
        var top = y(Math.max(b.o, b.c)), bot = y(Math.min(b.o, b.c));
        g.fillRect(cx - Math.max(1, bw * 0.32), top, Math.max(1.5, bw * 0.64), Math.max(1, bot - top));
      });
    }

    /* last price tag */
    var last = view[view.length - 1];
    var ly = y(last.c);
    g.setLineDash([4, 4]);
    g.strokeStyle = 'rgba(46,230,201,.45)';
    g.beginPath(); g.moveTo(padL, ly); g.lineTo(W - padR, ly); g.stroke();
    g.setLineDash([]);
    var tagTxt = fmt(last.c);
    g.fillStyle = '#2ee6c9';
    var tw = g.measureText(tagTxt).width + 12;
    g.fillRect(W - padR + 2, ly - 8, Math.min(padR - 4, tw), 16);
    g.fillStyle = '#04101a';
    g.font = '700 10px -apple-system, Segoe UI, Roboto, sans-serif';
    g.fillText(tagTxt, W - padR + 8, ly + 3);

    /* crosshair */
    if (this.hover > padL && this.hover < W - padR) {
      var idx = Math.max(0, Math.min(view.length - 1, Math.floor((this.hover - padL) / bw)));
      var hb = view[idx];
      g.strokeStyle = 'rgba(255,255,255,.2)';
      g.beginPath(); g.moveTo(x(idx), padT); g.lineTo(x(idx), padT + plotH); g.stroke();
      g.fillStyle = 'rgba(4,16,26,.9)';
      g.fillRect(padL + 2, padT + 2, 168, 14);
      g.fillStyle = '#cfe3ee';
      g.font = '9.5px ui-monospace, Menlo, monospace';
      g.textAlign = 'left';
      g.fillText('O ' + fmt(hb.o) + '  H ' + fmt(hb.h) + '  L ' + fmt(hb.l) + '  C ' + fmt(hb.c), padL + 6, padT + 12);
    }

    this.paintHeader(view);
  };

  Chart.prototype.paintHeader = function (view) {
    var last = view && view.length ? view[view.length - 1] : this.bars[this.bars.length - 1];
    if (!last) return;
    var first = view && view.length > 1 ? view[0] : last;
    var chg = first.o ? (last.c - first.o) / first.o * 100 : 0;
    this.pxEl.textContent = (last.c >= 1000 ? fmt(last.c) : '$' + last.c.toFixed(4));
    this.chgEl.textContent = (chg >= 0 ? '▲ ' : '▼ ') + Math.abs(chg).toFixed(2) + '%  ·  ' + this.tf;
    this.chgEl.style.color = chg >= 0 ? '#2ee6c9' : '#ff5c6e';
  };

  function fmt(v) {
    var n = Number(v) || 0;
    if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    if (Math.abs(n) >= 1) return n.toFixed(2);
    return n.toPrecision(4);
  }

  Chart.prototype.destroy = function () {
    this.destroyed = true;
    if (this._timer) clearInterval(this._timer);
    if (this._unsub) this._unsub();
    if (this.ro) this.ro.disconnect();
    var idx = controllers.indexOf(this);
    if (idx >= 0) controllers.splice(idx, 1);
  };

  /* ----------------------------------------------------------------- api */
  var N = {};

  N.mount = function (el, opts) {
    if (!el) return null;
    var c = new Chart(el, opts || {});
    controllers.push(c);
    return c;
  };

  N.candles = candles;

  N.open = function (symbol) {
    var sym = String(symbol || 'AAPL').toUpperCase();
    var old = document.getElementById('wcnc-sheet');
    if (old) old.remove();
    var wrap = document.createElement('div');
    wrap.id = 'wcnc-sheet';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:99998;background:#04101a;display:flex;flex-direction:column;padding:calc(10px + env(safe-area-inset-top)) 10px calc(10px + env(safe-area-inset-bottom))';
    wrap.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 4px 10px">' +
        '<b style="font-size:16px;color:#e9f4f9">' + sym + ' · chart</b>' +
        '<button id="wcnc-close" style="border:1px solid rgba(255,255,255,.14);background:transparent;color:#cfe3ee;font-weight:700;font-size:12px;padding:7px 12px;border-radius:9px">Close</button>' +
      '</div>' +
      '<div id="wcnc-host" style="flex:1;min-height:0"></div>' +
      '<div id="wcnc-ticket" style="margin-top:10px"></div>';
    document.body.appendChild(wrap);
    wrap.querySelector('#wcnc-close').addEventListener('click', function () {
      ifcdestroy();
      wrap.remove();
    });
    var ctrl = N.mount(wrap.querySelector('#wcnc-host'), { symbol: sym, height: Math.max(240, Math.round(window.innerHeight * 0.5)) });
    var host = wrap.querySelector('#wcnc-host');
    var cv = host.querySelector('.wcnc-cv');
    if (cv) cv.style.height = '100%';
    function ifcdestroy() { if (ctrl) ctrl.destroy(); }
    if (window.WC_DESK && WC_DESK.ticket) {
      try { WC_DESK.ticket(wrap.querySelector('#wcnc-ticket'), sym); } catch (e) {}
    }
    return ctrl;
  };

  N.mountAll = function (root) {
    (root || document).querySelectorAll('[data-wcnc]').forEach(function (el) {
      if (el.__wcncMounted) return;
      el.__wcncMounted = true;
      N.mount(el, { symbol: el.getAttribute('data-symbol') || 'AAPL', tf: el.getAttribute('data-tf') || '1H' });
    });
  };

  window.WC_NCHART = N;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { N.mountAll(); });
  else N.mountAll();

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') controllers.forEach(function (c) { c.paint(); });
  });
})();
