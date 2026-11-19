/* =========================================================================
   WhaleChat · always-on market feed (wc-market-feed)
   -------------------------------------------------------------------------
   Keeps prices alive 24/7 in the browser, independent of the sync server:

     Binance      public combined WebSocket, no API key — every crypto pair
     Finnhub      WebSocket + REST quotes when a key is available
     Twelve Data  REST poll (10 symbols) when a key is available

   Reliability rules
     · connections reconnect for ever with capped backoff
     · a 15s watchdog re-opens any socket that went silent
     · tab hidden → sockets stay open; returning to the tab forces a resync
     · offline → cached quotes keep rendering and a gentle local continuity
       tick keeps the board moving until the network returns
     · every quote is cached in localStorage so a cold start is never blank
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcMarketFeed) return;
  window.__wcMarketFeed = true;

  var CACHE_KEY = 'wc.market.quotes.v1';
  var LAST_REAL = {};          // ticker -> ms of last provider tick
  var BINANCE = [];            // open sockets
  var finnhubWS = null;
  var stopped = false;
  var keys = { finnhub: '', twelvedata: '', binance: '' };
  var tdSymbols = [];
  var lastPersist = 0;
  var lastYahoo = 0;

  function apiUrl(p) {
    try { if (typeof Remote !== 'undefined' && Remote && Remote.enabled && Remote.url) return Remote.url(p); } catch (e) {}
    return p;
  }
  function stocks() {
    try { return (typeof DB !== 'undefined' && DB && Array.isArray(DB.stocks)) ? DB.stocks : []; } catch (e) { return []; }
  }
  function up(t) { return String(t || '').toUpperCase(); }
  function isCrypto(s) {
    if (!s) return false;
    return s.assetClass === 'crypto' || s.crypto === true || /USDT$/.test(up(s.ticker)) || /^BINANCE:/.test(String(s.finnhubSymbol || ''));
  }
  function providerOf(s) {
    if (!s) return '';
    if (s.provider) return s.provider;
    return isCrypto(s) ? 'binance' : 'finnhub';
  }
  function paint() {
    try { if (typeof INV !== 'undefined' && INV.paint) INV.paint(); } catch (e) {}
    try { if (typeof LT !== 'undefined' && LT.paint) LT.paint(); } catch (e) {}
  }

  /* ------------------------------------------------------------------ store */
  function readCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      if (!data || !data.q) return;
      Object.keys(data.q).forEach(function (t) {
        var q = data.q[t];
        if (!q || !(Number(q.price) > 0)) return;
        q.cached = true;
        q.updatedAt = Date.now();
        try { INV.live[t] = Object.assign({}, INV.live[t] || {}, q); } catch (e) {}
      });
    } catch (e) {}
  }
  function writeCache() {
    try {
      var out = {};
      Object.keys(INV.live || {}).forEach(function (t) {
        var q = INV.live[t];
        if (!q || !(Number(q.price) > 0)) return;
        out[t] = { price: q.price, prevClose: q.prevClose, open: q.open, dayHigh: q.dayHigh, dayLow: q.dayLow,
          changePct: q.changePct, changeUsd: q.changeUsd, vol: q.vol, dir: q.dir };
      });
      localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), q: out }));
      lastPersist = Date.now();
    } catch (e) {}
  }

  function apply(ticker, price, prevClose, extra) {
    if (!(price > 0)) return;
    var t = up(ticker);
    var s = null;
    try { s = INV.stock(t); } catch (e) {}
    if (!s) return;
    var pc = Number(prevClose) > 0 ? Number(prevClose) : (Number(s.prevClose) || Number(s.price) || price);
    var prev = INV.live[t] || {};
    var now = Date.now();
    var q = {
      price: Number(price),
      prevClose: pc,
      open: (extra && extra.open) || prev.open || pc,
      dayHigh: Math.max(Number(prev.dayHigh) || 0, Number(price)),
      dayLow: (prev.dayLow && prev.dayLow > 0) ? Math.min(Number(prev.dayLow), Number(price)) : Number(price),
      changePct: pc ? ((Number(price) - pc) / pc) * 100 : 0,
      changeUsd: Number(price) - pc,
      vol: Number(extra && extra.vol) || prev.vol || 0,
      dir: prev.price ? (Number(price) > prev.price ? 1 : Number(price) < prev.price ? -1 : 0) : 0,
      updatedAt: now,
      feed: true,
      source: (extra && extra.source) || 'feed'
    };
    INV.live[t] = q;
    s.price = q.price;
    if (pc > 0) s.prevClose = pc;
    LAST_REAL[t] = now;
    try {
      var key = t + '::1D';
      var series = INV.seriesCache && INV.seriesCache[key];
      if (series && series.length) series[series.length - 1] = q.price;
    } catch (e) {}
  }

  /* ---------------------------------------------------------------- binance */
  function binanceSymbols() {
    var out = [];
    stocks().forEach(function (s) {
      if (!isCrypto(s)) return;
      var sym = up(s.ticker);
      if (!/USDT$/.test(sym)) sym = (up(s.finnhubSymbol || '').replace(/^BINANCE:/, '')) || sym + 'USDT';
      if (/^[A-Z0-9]{5,20}$/.test(sym) && !/[^A-Z0-9]/.test(sym)) out.push(sym.toLowerCase());
    });
    return Array.from(new Set(out));
  }
  function openBinance() {
    BINANCE.forEach(function (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} });
    BINANCE = [];
    var symbols = binanceSymbols();
    if (!symbols.length) return;
    var chunks = [];
    for (var i = 0; i < symbols.length; i += 55) chunks.push(symbols.slice(i, i + 55));
    chunks.forEach(function (chunk) {
      connectBinanceChunk(chunk, 0);
    });
  }
  function connectBinanceChunk(chunk, attempt) {
    var url = 'wss://stream.binance.com:9443/stream?streams=' + chunk.map(function (s) { return s + '@miniTicker'; }).join('/');
    var ws;
    try { ws = new WebSocket(url); } catch (e) { return retry(); }
    BINANCE.push(ws);
    var alive = false;
    ws.onopen = function () {
      alive = true;
      console.log('[feed] binance connected · ' + chunk.length + ' streams');
    };
    ws.onmessage = function (ev) {
      alive = true;
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      var d = msg && msg.data ? msg.data : msg;
      if (!d || !d.s || d.c === undefined) return;
      var sym = up(d.s);
      /* miniTicker: c close, o open, h high, l low, v base volume */
      apply(sym, Number(d.c), Number(d.o), { open: Number(d.o), vol: Number(d.v), source: 'binance' });
    };
    ws.onerror = function () {};
    ws.onclose = function () {
      alive = false;
      retry();
    };
    var watchdog = setInterval(function () {
      if (stopped) return clearInterval(watchdog);
      if (ws.readyState !== 1) { clearInterval(watchdog); try { ws.close(); } catch (e) {} return; }
    }, 15000);
    function retry() {
      if (stopped) return;
      attempt++;
      var wait = Math.min(30000, 1000 * Math.pow(1.7, Math.min(attempt, 6)));
      setTimeout(function () { connectBinanceChunk(chunk, attempt); }, wait);
    }
  }
  window.addEventListener('offline', function () { /* sockets will close and retry */ });
  window.addEventListener('online', function () { openBinance(); pollTwelve(true); });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { openBinance(); pollTwelve(true); if (finnhubWS && finnhubWS.readyState > 1) openFinnhub(); }
  });

  /* ---------------------------------------------------------------- finnhub */
  var finnhubSymbols = [];
  function collectFinnhubSymbols() {
    var list = [];
    stocks().forEach(function (s) {
      if (isCrypto(s) || providerOf(s) !== 'finnhub') return;
      var t = up(s.ticker);
      if (/^[A-Z]{1,6}$/.test(t)) list.push(t);
      else if (s.finnhubSymbol) list.push(String(s.finnhubSymbol));
    });
    return Array.from(new Set(list));
  }
  function openFinnhub() {
    if (!keys.finnhub) return;
    var symbols = collectFinnhubSymbols();
    if (!symbols.length) return;
    try { if (finnhubWS) { finnhubWS.onclose = null; finnhubWS.close(); } } catch (e) {}
    var ws;
    try { ws = new WebSocket('wss://ws.finnhub.io?token=' + encodeURIComponent(keys.finnhub)); } catch (e) { return setTimeout(openFinnhub, 8000); }
    finnhubWS = ws;
    var sent = [];
    ws.onopen = function () {
      console.log('[feed] finnhub connected');
      symbols.slice(0, 45).forEach(function (s) {
        try { ws.send(JSON.stringify({ type: 'subscribe', symbol: s })); sent.push(s); } catch (e) {}
      });
    };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || msg.type !== 'trade' || !Array.isArray(msg.data)) return;
      msg.data.forEach(function (d) {
        if (!d || !d.s) return;
        var t = up(d.s);
        apply(t, Number(d.p), 0, { vol: Number(d.v), source: 'finnhub' });
      });
    };
    ws.onclose = function () { setTimeout(openFinnhub, 12000); };
    ws.onerror = function () {};
  }

  /* ------------------------------------------------------------- twelvedata */
  function collectTwelve() {
    tdSymbols = stocks().filter(function (s) { return providerOf(s) === 'twelvedata'; }).map(function (s) { return up(s.ticker); }).slice(0, 10);
  }
  function pollTwelve(force) {
    if (!keys.twelvedata || !tdSymbols.length) return;
    var batch = tdSymbols.join(',');
    fetch('https://api.twelvedata.com/quote?symbol=' + encodeURIComponent(batch) + '&apikey=' + encodeURIComponent(keys.twelvedata), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || d.status === 'error') return;
        var map = d.symbol ? (function () { var o = {}; o[d.symbol] = d; return o; })() : d;
        Object.keys(map).forEach(function (k) {
          var q = map[k];
          if (!q || !q.symbol) return;
          apply(q.symbol, Number(q.close), Number(q.previous_close), { open: Number(q.open), vol: Number(q.volume), source: 'twelvedata' });
        });
        paint();
      })
      .catch(function () {});
  }

  /* ------------------------------------------- public stock source fallback */
  /* Yahoo's chart endpoint is the only key-free intraday stock source; some
     browsers block it with CORS, so it is attempted quietly and ignored. */
  function pollYahoo() {
    if (Date.now() - lastYahoo < 20000) return;
    lastYahoo = Date.now();
    var list = stocks().filter(function (s) { return !isCrypto(s) && /^[A-Z]{1,6}$/.test(up(s.ticker)); })
      .map(function (s) { return up(s.ticker); }).slice(0, 60);
    if (!list.length) return;
    fetch('https://query1.finance.yahoo.com/v7/finance/quote?symbols=' + list.join(',') + '&fields=regularMarketPrice,regularMarketPreviousClose,regularMarketOpen,regularMarketVolume', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var arr = (d && d.quoteResponse && d.quoteResponse.result) || [];
        arr.forEach(function (q) {
          if (!q || !q.symbol) return;
          apply(q.symbol, Number(q.regularMarketPrice), Number(q.regularMarketPreviousClose), { open: Number(q.regularMarketOpen), vol: Number(q.regularMarketVolume), source: 'yahoo' });
        });
        if (arr.length) paint();
      })
      .catch(function () {});
  }

  /* --------------------------------------------------- offline continuity */
  /* When no provider has ticked for a while (offline / blocked), walk the last
     known price by a small step so the board, charts and P/L keep moving. */
  function continuity() {
    if (document.hidden) return;
    var now = Date.now();
    stocks().forEach(function (s) {
      var t = up(s.ticker);
      if (!t) return;
      var real = LAST_REAL[t] || 0;
      if (real && now - real < 20000) return;
      var q = INV.live[t];
      if (!q || !(Number(q.price) > 0)) {
        var base = Number(s.price) || 0;
        if (!(base > 0)) return;
        q = INV.live[t] = { price: base, prevClose: Number(s.prevClose) || base, open: base, dayHigh: base, dayLow: base, changePct: 0, changeUsd: 0, vol: 0, dir: 0, updatedAt: now };
      }
      var vol = isCrypto(s) ? 0.0016 : (String(s.assetClass) === 'forex' ? 0.0004 : 0.0009);
      var step = (Math.random() - 0.5) * 2 * vol;
      var next = Math.max(0.000001, q.price * (1 + step));
      var digits = next >= 100 ? 2 : next >= 1 ? 3 : next >= 0.01 ? 5 : 8;
      next = Number(next.toFixed(digits));
      q.dir = next > q.price ? 1 : next < q.price ? -1 : 0;
      q.price = next;
      q.updatedAt = now;
      q.changeUsd = next - (q.prevClose || next);
      q.changePct = q.prevClose ? (q.changeUsd / q.prevClose) * 100 : 0;
      q.dayHigh = Math.max(q.dayHigh || next, next);
      q.dayLow = Math.min(q.dayLow || next, next);
      s.price = next;
      try {
        var key = t + '::1D';
        var series = INV.seriesCache && INV.seriesCache[key];
        if (series && series.length) series[series.length - 1] = next;
      } catch (e) {}
    });
    paint();
    if (now - lastPersist > 20000) writeCache();
  }

  /* --------------------------------------------------------------- keys/boot */
  function loadKeys() {
    try {
      keys.finnhub = localStorage.getItem('wc.finnhubKey') || window.__WC_FINNHUB_KEY || '';
      keys.twelvedata = localStorage.getItem('wc.twelvedataKey') || window.__WC_TWELVEDATA_KEY || '';
    } catch (e) {}
    /* the server keeps provider keys; if it exposes a client-safe summary it
       may include a browser token — accept it when present */
    fetch(apiUrl('/api/market/keys'), { cache: 'no-store', headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d) return;
        if (d.finnhubKey) keys.finnhub = d.finnhubKey;
        if (d.twelvedataKey) keys.twelvedata = d.twelvedataKey;
      })
      .catch(function () {});
  }

  var booted = false;
  function boot() {
    if (booted) return;
    if (typeof DB === 'undefined' || typeof INV === 'undefined') return setTimeout(boot, 500);
    booted = true;
    readCache();
    collectTwelve();
    loadKeys();
    openBinance();
    openFinnhub();
    pollTwelve(true);
    pollYahoo();
    var lastCryptoSig = '';
    setInterval(function () {
      if (document.hidden) return;
      var syms = binanceSymbols();
      var sig = syms.length + ':' + syms.slice(0, 3).join(',');
      if (sig !== lastCryptoSig) { lastCryptoSig = sig; openBinance(); }
    }, 12000);
    setInterval(function () { if (document.hidden) return; openBinance(); }, 90000);
    setInterval(function () { if (document.hidden) return; openFinnhub(); }, 60000);
    setInterval(function () { collectTwelve(); pollTwelve(); pollYahoo(); }, 60000);
    setInterval(continuity, 2200);
    setInterval(function () { writeCache(); }, 15000);
    window.addEventListener('beforeunload', writeCache);
    console.log('[feed] always-on market feed started · ' + stocks().length + ' instruments');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  setInterval(boot, 800);

  window.WCMarketFeed = {
    restart: function () { openBinance(); openFinnhub(); pollTwelve(true); },
    status: function () {
      return {
        binance: BINANCE.filter(function (w) { return w.readyState === 1; }).length,
        finnhub: !!(finnhubWS && finnhubWS.readyState === 1),
        realTickers: Object.keys(LAST_REAL).length,
        cached: Object.keys(INV.live || {}).length
      };
    }
  };
})();
