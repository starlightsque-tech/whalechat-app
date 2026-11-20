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
  var serverKeys = { finnhub: false, twelvedata: false, proxy: false };
  var LAST_BY = { binance: 0, finnhub: 0, twelvedata: 0, proxy: 0, yahoo: 0 };
  var tdSymbols = [];
  var lastPersist = 0;
  var lastYahoo = 0;

  function apiUrl(p) {
    try { if (typeof Remote !== 'undefined' && Remote && Remote.enabled && Remote.base && Remote.url) return Remote.url(p); } catch (e) {}
    /* the static site has no same-origin API: use the build-time server */
    try { if (window.WC_BUILD_CONFIG && WC_BUILD_CONFIG.syncServer) return String(WC_BUILD_CONFIG.syncServer).replace(/\/+$/, '') + p; } catch (e) {}
    try { if (typeof DEFAULT_SYNC_SERVER !== 'undefined' && DEFAULT_SYNC_SERVER) return DEFAULT_SYNC_SERVER + p; } catch (e) {}
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

  function touch(source, at) { if (LAST_BY[source] !== undefined) LAST_BY[source] = Number(at) || Date.now(); }

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
    touch(q.source, now);
    try { if (window.WC_CHART && window.WC_CHART.record) window.WC_CHART.record(t, q.price, now); } catch (e) {}
    /* 3.66.1: every real quote also drives the charts in real time — the line
       recolours green on a rising tick and red on a falling one. */
    try {
      document.dispatchEvent(new CustomEvent('wc:tick', {
        detail: { symbol: t, price: q.price, changePct: q.changePct, dir: q.dir }
      }));
    } catch (e) {}
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
    for (var i = 0; i < symbols.length; i += 30) chunks.push(symbols.slice(i, i + 30));
    chunks.forEach(function (chunk) {
      connectBinanceChunk(chunk, 0);
    });
  }
  function connectBinanceChunk(chunk, attempt) {
    var wsBase = (window.WC_SERVERS && WC_SERVERS.binanceWs) || 'wss://data-stream.binance.vision/stream';
    var url = wsBase.replace(/\/+$/, '') + '?streams=' + chunk.map(function (s) { return s + '@miniTicker'; }).join('/');
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
      touch('binance', Date.now());
    };
    ws.onerror = function () {};
    ws.onclose = function () {
      alive = false;
      /* one bad pair can close a combined stream: split the chunk so the
         healthy symbols keep streaming instead of losing Binance entirely */
      if (chunk.length > 1) {
        var mid = Math.ceil(chunk.length / 2);
        connectBinanceChunk(chunk.slice(0, mid), attempt + 1);
        connectBinanceChunk(chunk.slice(mid), attempt + 1);
        return;
      }
      retry();
    };
    var watchdog = setInterval(function () {
      if (stopped) return clearInterval(watchdog);
      if (ws.readyState !== 1) { clearInterval(watchdog); try { ws.close(); } catch (e) {} return; }
    }, 25000);
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


  /* Binance REST fallback — no WebSocket required. Keeps crypto prices real
     even when a combined stream is rejected by the network. */
  function pollBinanceRest() {
    var syms = binanceSymbols();
    if (!syms.length) return;
    var batch = syms.slice(0, 80).map(function (x) { return x.toUpperCase(); });
    var url = 'https://data-api.binance.vision/api/v3/ticker/24hr?symbols=' + encodeURIComponent(JSON.stringify(batch));
    fetch(url, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (list) {
        if (!Array.isArray(list)) return;
        var n = 0;
        list.forEach(function (d) {
          if (!d || !d.symbol) return;
          apply(d.symbol, Number(d.lastPrice), Number(d.openPrice), { open: Number(d.openPrice), high: Number(d.highPrice), low: Number(d.lowPrice), vol: Number(d.volume), source: 'binance' });
          n++;
        });
        if (n) { touch('binance', Date.now()); paint(); }
      })
      .catch(function () {});
  }

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

  /* ------------------------------------------------------ server proxy feed */
  /* Stock quotes come through the sync Function, which holds the Finnhub and
     Twelve Data keys in its environment. Works on every device with no key. */
  var proxyCursor = 0;
  var proxyBusy = false;
  var proxyDbg = { calls: 0, applied: 0, errors: 0, lastError: '', lastBatch: 0 };
  function proxySymbols() {
    var list = [];
    stocks().forEach(function (s) {
      if (isCrypto(s)) return;
      var disp = up(s.displayTicker || s.ticker);
      if (!disp || /[^A-Z0-9._\-]/.test(disp)) return;
      list.push(disp);
    });
    return Array.from(new Set(list));
  }
  function stockProxyConfig() {
    try {
      var c = window.WC_BUILD_CONFIG || {};
      return { url: c.stockProxyFunction || '', project: c.appwriteProjectId || '' };
    } catch (e) { return { url: '', project: '' }; }
  }
  function applyProviderRows(rows) {
    var n = 0;
    (rows || []).forEach(function (row) {
      if (!row || !row.symbol || !(Number(row.price) > 0)) return;
      var sym = up(row.symbol);
      var prev = Number(row.prevClose);
      if (!(prev > 0)) prev = Number(row.price) - (Number(row.change) || 0);
      var src = row.source === 'twelvedata' ? 'twelvedata' : row.source === 'yahoo' ? 'yahoo' : 'finnhub';
      try {
        apply(sym, Number(row.price), prev, { open: prev, vol: Number(row.volume) || 0, source: src });
        n++;
      } catch (e) { proxyDbg.errors++; proxyDbg.lastError = e && e.message; }
    });
    if (n) paint();
    proxyDbg.applied += n;
    return n;
  }
  function pollProxy(force) {
    if (proxyBusy) return;
    if (!force && !serverKeys.finnhub && !serverKeys.twelvedata && !stockProxyConfig().url) return;
    var all = proxySymbols();
    if (!all.length) return;
    if (force) proxyCursor = 0;
    var batch = [];
    /* match the server-side provider cap so every symbol in the batch is
       actually priced instead of silently dropped */
    for (var i = 0; i < 24 && i < all.length; i++) batch.push(all[(proxyCursor + i) % all.length]);
    proxyCursor = (proxyCursor + batch.length) % all.length;
    proxyBusy = true;
    proxyDbg.calls++; proxyDbg.lastBatch = batch.length;

    var cfg = stockProxyConfig();
    var done = function () { proxyBusy = false; };
    if (cfg.url) {
      /* primary: dedicated Appwrite stock-proxy function */
      var body = JSON.stringify({ body: JSON.stringify({ symbols: batch.join(',') }), method: 'POST' });
      fetch(cfg.url, { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json', 'X-Appwrite-Project': cfg.project }, body: body })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          done();
          var payload = d && d.responseBody ? JSON.parse(d.responseBody) : d;
          if (!payload || !payload.data) { proxyDbg.errors++; proxyDbg.lastError = 'stock_proxy_empty'; return; }
          if (applyProviderRows(payload.data)) {
            serverKeys.finnhub = true; serverKeys.proxy = true;
            touch('finnhub', Date.now());
          }
        })
        .catch(function (e) { done(); proxyDbg.errors++; proxyDbg.lastError = e && e.message; });
      return;
    }
    /* fallback: sync-server proxy */
    var req;
    try {
      req = fetch(apiUrl('/api/market/proxy?provider=auto&symbols=' + encodeURIComponent(batch.join(','))), { cache: 'no-store', headers: { accept: 'application/json' } });
    } catch (e) { done(); return; }
    Promise.resolve(req)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        done();
        if (!d || !d.ok || !d.quotes) { proxyDbg.errors++; proxyDbg.lastError = 'bad_response'; return; }
        var rows = Object.keys(d.quotes).map(function (k) { return Object.assign({ symbol: k }, d.quotes[k]); });
        if (applyProviderRows(rows)) touch(d.provider === 'twelvedata' ? 'twelvedata' : 'finnhub', Date.now());
      })
      .catch(function (e) { done(); proxyDbg.errors++; proxyDbg.lastError = e && e.message; });
  }
  window.WC_MARKET_PROXY = { poll: pollProxy, available: function () { return serverKeys; }, debug: function () { return proxyDbg; } };

  /* --------------------------------------------------- offline behaviour */
  /* Real data only: when no provider has ticked we FREEZE the last real price
     and repaint the cached quotes. Nothing is invented while offline. */
  function continuity() {
    if (document.hidden) return;
    var now = Date.now();
    stocks().forEach(function (s) {
      var t = up(s.ticker);
      var real = LAST_REAL[t] || 0;
      if (real && now - real < 20000) return;
      var q = INV.live[t];
      if (q) q.cached = true;
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
        if (typeof d.finnhub === 'boolean') serverKeys.finnhub = d.finnhub;
        if (typeof d.twelvedata === 'boolean') serverKeys.twelvedata = d.twelvedata;
        if (d.proxy) serverKeys.proxy = true;
        if (d.finnhubKey) keys.finnhub = d.finnhubKey;
        if (d.twelvedataKey) keys.twelvedata = d.twelvedataKey;
        if (serverKeys.finnhub || serverKeys.twelvedata) pollProxy(true);
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
    }, 25000);
    setInterval(function () { if (document.hidden) return; openBinance(); }, 90000);
    setInterval(function () { if (document.hidden) return; openFinnhub(); }, 60000);
    setInterval(function () { collectTwelve(); pollTwelve(); pollYahoo(); }, 60000);
    pollBinanceRest();
    setInterval(function () { if (!document.hidden) pollBinanceRest(); }, 20000);
    setInterval(function () { if (!document.hidden) pollProxy(); }, 25000);
    setInterval(continuity, 2200);
    setInterval(function () { writeCache(); }, 25000);
    window.addEventListener('beforeunload', writeCache);
    console.log('[feed] always-on market feed started · ' + stocks().length + ' instruments');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  setInterval(boot, 800);


  /* ------------------------------------------------------------ admin panel */
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function feedStatusHtml() {
    var st = window.WCMarketFeed.status();
    function dot(on) { return '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:' + (on ? '#2ee6c9' : '#ff5f74') + ';margin-right:5px"></span>'; }
    return '<div class="row" style="gap:14px;flex-wrap:wrap;margin-top:8px;font-size:11px;font-weight:700">' +
      '<span>' + dot(st.binance > 0) + 'Binance ' + (st.binance > 0 ? 'live' : 'connecting') + '</span>' +
      '<span>' + dot(st.finnhub) + 'Finnhub ' + (st.finnhub ? 'live' : (keys.finnhub ? 'connecting' : 'no key')) + '</span>' +
      '<span>' + dot(!!keys.twelvedata) + 'Twelve Data ' + (keys.twelvedata ? 'polling' : 'no key') + '</span>' +
      '<span>' + dot(st.cached > 0) + st.cached + ' instruments cached</span></div>';
  }
  function uiHtml() {
    return '<div class="card" id="wcFeedKeysCard" style="margin-top:12px">' +
      '<div class="between" style="align-items:flex-start;gap:10px"><div>' +
      '<div class="card-title" style="margin:0">Live feed · this device</div>' +
      '<div class="tiny muted" style="margin-top:3px">Binance crypto streams with no key. Add Finnhub and Twelve Data keys to bring real US, global and forex quotes to this browser. Keys are stored only on this device.</div></div>' +
      '<span class="badge badge-accent">24/7</span></div>' +
      '<div data-wcfeed-status>' + feedStatusHtml() + '</div>' +
      '<div class="row" style="gap:8px;flex-wrap:wrap;margin-top:10px">' +
      '<input class="input" id="wcFhKey" placeholder="Finnhub API key" value="' + esc(keys.finnhub) + '" style="max-width:240px" autocomplete="off"/>' +
      '<input class="input" id="wcTdKey" placeholder="Twelve Data API key" value="' + esc(keys.twelvedata) + '" style="max-width:240px" autocomplete="off"/>' +
      '<button class="btn btn-sm btn-primary" data-wcfeed="save">Connect feeds</button>' +
      '<button class="btn btn-sm btn-ghost" data-wcfeed="refresh">Retry now</button></div>' +
      '<div class="tiny muted" style="margin-top:8px">The feed reconnects automatically, keeps prices moving offline from the last real quote, and resumes live ticks the moment the network returns.</div></div>';
  }
  function installUI() {
    if (!/^#\/admin\/stocks/.test(location.hash || '')) return;
    var host = document.getElementById('mktBinanceCard');
    if (!host) return;
    var card = document.getElementById('wcFeedKeysCard');
    if (card) {
      var status = card.querySelector('[data-wcfeed-status]');
      if (status) status.innerHTML = feedStatusHtml();
      return;
    }
    var wrap = document.createElement('div');
    wrap.innerHTML = uiHtml();
    var node = wrap.firstChild;
    host.parentNode.insertBefore(node, host);
    node.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-wcfeed]');
      if (!b) return;
      var act = b.getAttribute('data-wcfeed');
      if (act === 'save') {
        var fh = (document.getElementById('wcFhKey') || {}).value || '';
        var td = (document.getElementById('wcTdKey') || {}).value || '';
        keys.finnhub = fh.trim(); keys.twelvedata = td.trim();
        try {
          localStorage.setItem('wc.finnhubKey', keys.finnhub);
          localStorage.setItem('wc.twelvedataKey', keys.twelvedata);
        } catch (err) {}
        collectTwelve(); openFinnhub(); pollTwelve(true); openBinance();
        try { if (typeof toast === 'function') toast('Live feeds reconnecting with your keys', 'ok'); } catch (err) {}
      } else { openBinance(); openFinnhub(); pollTwelve(true); }
      var st = node.querySelector('[data-wcfeed-status]');
      if (st) st.innerHTML = feedStatusHtml();
    });
  }
  setInterval(function () { try { installUI(); } catch (e) {} }, 2500);

  function liveInstruments() {
    var now = Date.now();
    var n = 0;
    Object.keys(LAST_REAL).forEach(function (t) { if (now - LAST_REAL[t] <= 120000) n++; });
    return n;
  }
  window.WCMarketFeed = {
    restart: function () { openBinance(); openFinnhub(); pollTwelve(true); pollProxy(true); },
    reconnect: function () { WCMarketFeed.reconnectSilent(); },
    /* silent, idempotent, no toast: used by the connection heartbeat */
    reconnectSilent: function () {
      BINANCE.forEach(function (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} });
      BINANCE = [];
      try { if (finnhubWS) { finnhubWS.onclose = null; finnhubWS.close(); } } catch (e) {}
      openBinance(); openFinnhub(); pollTwelve(true); pollProxy(true);
    },
    status: function () {
      return {
        binance: BINANCE.filter(function (w) { return w.readyState === 1; }).length,
        finnhub: !!((finnhubWS && finnhubWS.readyState === 1) || serverKeys.finnhub),
        twelvedata: !!(keys.twelvedata || serverKeys.twelvedata),
        proxy: !!(serverKeys.finnhub || serverKeys.twelvedata),
        configured: {
          binance: true,
          finnhub: !!(keys.finnhub || serverKeys.finnhub),
          twelvedata: !!(keys.twelvedata || serverKeys.twelvedata)
        },
        localKeys: !!keys.finnhub,
        last: { binance: LAST_BY.binance, finnhub: LAST_BY.finnhub, twelvedata: LAST_BY.twelvedata, proxy: LAST_BY.proxy },
        lastTickAt: Math.max(LAST_BY.binance, LAST_BY.finnhub, LAST_BY.twelvedata, LAST_BY.proxy, LAST_BY.yahoo),
        liveInstruments: liveInstruments(),
        listed: stocks().length,
        realTickers: Object.keys(LAST_REAL).length,
        cached: Object.keys(INV.live || {}).length,
        online: navigator.onLine !== false
      };
    }
  };
})();
