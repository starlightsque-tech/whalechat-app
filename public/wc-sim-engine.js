/* =========================================================================
   WhaleChat · offline market simulator engine (wc-sim-engine)
   -------------------------------------------------------------------------
   Runs ONLY inside the installed app while the device has no connection.

   It never invents a market from nothing: it starts at the LAST REAL price
   the device received (Finnhub / Twelve Data / Binance tick, or the last
   cached candle close) and then produces continuous micro-ticks with:

     · geometric brownian motion scaled by the asset's own historical
       volatility (stdev of log returns from the cached candles), falling back
       to a per-asset-class volatility when there is no history
     · a sane bid/ask spread (2–18 bps by asset class, wider when volatile)
     · mean reversion toward the anchor so a long offline session cannot drift
       to absurd prices (max ±35% of the anchor)
     · one-minute OHLCV candles persisted to IndexedDB, so the chart looks
       identical whether it is fed by the live feed or by the simulator

   Downtime continuity: on start the engine replays the ticks that "would"
   have happened since the last real tick (bounded to 900 ticks) so a chart
   never shows a gap.

   Public API
     WC_SIM.start(symbol, {seedPrice, assetType, candles, anchor})
     WC_SIM.stop()
     WC_SIM.price(symbol)             → current simulated price
     WC_SIM.quote(symbol)             → {price,bid,ask,spreadBps,simulated,asOf}
     WC_SIM.subscribe(fn)             → unsubscribe
     WC_SIM.candles(symbol)           → [{t,o,h,l,c,v}]
     WC_SIM.status()
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.WC_SIM) return;

  var TICK_MS = 1000;
  var BAR_MS = 60 * 1000;
  var MAX_BARS = 2000;
  var MAX_DRIFT = 0.35;

  var CLASS_VOL = { crypto: 0.045, stock: 0.017, etf: 0.011, index: 0.009, forex: 0.0055, commodity: 0.014, default: 0.017 };
  var CLASS_SPREAD = { crypto: 0.0009, stock: 0.0004, etf: 0.0003, index: 0.0003, forex: 0.00018, commodity: 0.0006, default: 0.0005 };

  var state = {
    active: false,
    symbol: '',
    assetType: 'stock',
    anchor: 0,
    price: 0,
    sigmaTick: 0.0005,
    spreadBps: 4,
    ticks: 0,
    startedAt: 0,
    lastTickAt: 0,
    seedSource: 'cache',
    candles: [],
    bar: null
  };

  var subs = [];
  var timer = null;
  var saveTimer = null;

  function emit(evt) {
    subs.forEach(function (fn) { try { fn(state, evt || {}); } catch (e) {} });
  }

  function normal() {
    var u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function stdev(arr) {
    if (arr.length < 3) return 0;
    var mean = arr.reduce(function (a, b) { return a + b; }, 0) / arr.length;
    var v = arr.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / (arr.length - 1);
    return Math.sqrt(v);
  }

  /* volatility from the cached candles, per 1-minute bar */
  function volFromCandles(candles) {
    var closes = (candles || []).map(function (c) { return Number(c.c) || 0; }).filter(function (v) { return v > 0; });
    if (closes.length < 8) return 0;
    var rets = [];
    for (var i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
    return stdev(rets);
  }

  function volatility(assetType, candles) {
    var fromData = volFromCandles(candles);
    var fallback = (CLASS_VOL[String(assetType || '').toLowerCase()] || CLASS_VOL.default) / Math.sqrt(390);
    var sigmaBar = fromData > 0 ? Math.min(fromData, 0.05) : fallback;
    /* one bar = 60 one-second ticks */
    return Math.max(0.00002, sigmaBar / Math.sqrt(60));
  }

  function seedPriceFor(symbol) {
    var t = String(symbol || '').toUpperCase();
    try { if (window.WC_SIM && WC_SIM.realQuote) { var q = WC_SIM.realQuote(t); if (q && q > 0) return { price: q, source: 'feed' }; } } catch (e) {}
    try { if (typeof INV !== 'undefined' && INV.live && INV.live[t] && Number(INV.live[t].price) > 0) return { price: Number(INV.live[t].price), source: 'live' }; } catch (e) {}
    try {
      var raw = JSON.parse(localStorage.getItem('wc.market.quotes.v1') || '{}');
      var row = raw[t] || (raw.quotes && raw.quotes[t]);
      var p = Number(row && (row.price || row.last || row.usdPrice));
      if (p > 0) return { price: p, source: 'cache' };
    } catch (e) {}
    return { price: 0, source: 'none' };
  }

  /* last cached real price anywhere on the device */
  function findSeed(symbol, opts) {
    if (opts && Number(opts.seedPrice) > 0) return { price: Number(opts.seedPrice), source: 'arg' };
    var s = seedPriceFor(symbol);
    if (s.price > 0) return s;
    var rows = (opts && opts.candles) || [];
    if (rows.length) {
      var last = rows[rows.length - 1];
      var p = Number(last.c || last.close);
      if (p > 0) return { price: p, source: 'candle' };
    }
    return { price: 0, source: 'none' };
  }

  function barFor(t) {
    var start = Math.floor(t / BAR_MS) * BAR_MS;
    if (!state.bar || state.bar.t !== start) {
      if (state.bar) {
        state.candles.push(state.bar);
        if (state.candles.length > MAX_BARS) state.candles.splice(0, state.candles.length - MAX_BARS);
      }
      state.bar = { t: start, o: state.price, h: state.price, l: state.price, c: state.price, v: 0 };
    }
    return state.bar;
  }

  function tick(silent) {
    if (!state.active) return;
    var now = Date.now();
    var steps = 1;
    if (!silent && state.lastTickAt) {
      var missed = Math.floor((now - state.lastTickAt) / TICK_MS);
      steps = Math.max(1, Math.min(120, missed));
    }
    for (var i = 0; i < steps; i++) {
      /* GBM + soft mean reversion toward the anchor */
      var drift = (state.anchor / state.price - 1) * 0.0025;
      var shock = state.sigmaTick * normal();
      var p = state.price * Math.exp(drift + shock - 0.5 * state.sigmaTick * state.sigmaTick);
      var dev = state.anchor > 0 ? (p / state.anchor - 1) : 0;
      if (Math.abs(dev) > MAX_DRIFT) p = state.anchor * (1 + (dev > 0 ? MAX_DRIFT : -MAX_DRIFT));
      if (p > 0) state.price = p;
      var b = barFor(now);
      b.c = state.price;
      if (state.price > b.h) b.h = state.price;
      if (state.price < b.l) b.l = state.price;
      b.v += Math.round(Math.random() * 900 + 100);
      state.ticks++;
    }
    state.lastTickAt = now;

    var spread = state.sigmaTick * 2 + state.spreadBps / 10000;
    state.quote = {
      price: state.price,
      bid: state.price * (1 - spread / 2),
      ask: state.price * (1 + spread / 2),
      spreadBps: Math.round(spread * 10000),
      simulated: true,
      asOf: now,
      symbol: state.symbol
    };
    emit('tick');

    if (!saveTimer) {
      saveTimer = setTimeout(function () {
        saveTimer = null;
        try {
          var rows = state.candles.slice(-MAX_BARS);
          if (state.bar) rows = rows.concat([state.bar]);
          if (window.WC_DEVICE && WC_DEVICE.saveCandles) WC_DEVICE.saveCandles(state.symbol, '1m', rows);
        } catch (e) {}
      }, 15000);
    }
  }

  function start(symbol, opts) {
    opts = opts || {};
    var sym = String(symbol || '').toUpperCase();
    if (!sym) return null;
    stop(true);

    var seed = findSeed(sym, opts);
    if (!(seed.price > 0)) {
      state.active = false;
      state.symbol = sym;
      state.startedAt = Date.now();
      state.seedSource = 'none';
      emit('refused');
      return null;      /* nothing real to start from — never invent a listing */
    }

    state.symbol = sym;
    state.assetType = String(opts.assetType || 'stock').toLowerCase();
    state.candles = (opts.candles || []).slice(-MAX_BARS);
    state.anchor = Number(opts.anchor) > 0 ? Number(opts.anchor) : seed.price;
    state.price = seed.price;
    state.seedSource = seed.source;
    state.sigmaTick = volatility(state.assetType, state.candles);
    state.spreadBps = Math.round((CLASS_SPREAD[state.assetType] || CLASS_SPREAD.default) * 10000);
    state.ticks = 0;
    state.startedAt = Date.now();
    state.lastTickAt = 0;
    state.bar = null;
    state.active = true;

    /* continuity: replay what would have happened since the last saved bar */
    var lastT = state.candles.length ? Number(state.candles[state.candles.length - 1].t) || 0 : 0;
    var gapTicks = lastT ? Math.min(900, Math.floor((Date.now() - lastT) / TICK_MS)) : 0;
    state.lastTickAt = Date.now() - gapTicks * TICK_MS;
    tick(false);
    timer = setInterval(function () { tick(false); }, TICK_MS);
    emit('start');
    return state.quote;
  }

  function stop(silent) {
    if (timer) { clearInterval(timer); timer = null; }
    state.active = false;
    if (!silent) emit('stop');
  }

  function quote(symbol) {
    var sym = String(symbol || '').toUpperCase();
    if (state.active && state.symbol === sym && state.quote) return state.quote;
    var seed = seedPriceFor(sym);
    if (seed.price > 0) {
      return { price: seed.price, bid: seed.price, ask: seed.price, spreadBps: 0, simulated: false, asOf: 0, symbol: sym, stale: true };
    }
    return null;
  }

  function price(symbol) {
    var q = quote(symbol);
    return q ? q.price : 0;
  }

  WC_SIM = {
    start: start,
    stop: stop,
    quote: quote,
    price: price,
    candles: function () { return state.candles.concat(state.bar ? [state.bar] : []); },
    subscribe: function (fn) {
      if (typeof fn === 'function') subs.push(fn);
      return function () { subs = subs.filter(function (f) { return f !== fn; }); };
    },
    seed: function (symbol, p) {
      try { localStorage.setItem('wc.sim.seed.' + String(symbol).toUpperCase(), String(p)); } catch (e) {}
    },
    realQuote: function (symbol) {
      try {
        var raw = JSON.parse(localStorage.getItem('wc.market.quotes.v1') || '{}');
        var row = raw[String(symbol).toUpperCase()];
        var p = Number(row && (row.price || row.last || row.usdPrice));
        return p > 0 ? p : 0;
      } catch (e) { return 0; }
    },
    status: function () {
      return {
        active: state.active,
        symbol: state.symbol,
        ticks: state.ticks,
        seedSource: state.seedSource,
        sigmaTick: state.sigmaTick,
        spreadBps: state.spreadBps,
        price: state.price,
        candles: state.candles.length + (state.bar ? 1 : 0),
        since: state.startedAt
      };
    }
  };

  /* pause the simulator when the app is torn down */
  window.addEventListener('pagehide', function () { stop(true); });
})();
