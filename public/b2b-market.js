/* =========================================================================
   WhaleChat B2B marketplace  (wc-b2b-market)

   A named marketplace over the real price feed: company stocks (Shopify,
   Tesla, Microsoft, Google, Amazon, Apple, Samsung), WhaleChat itself, the
   major crypto (BTC, ETH, BNB, Solana) and meme coins (Doge, Trump).

   - live price grid with movement + sparkline per asset
   - asset detail page with real live data and the live chart
   - multi-select alert setup: an estimated BUY price and an estimated SELL
     price per asset; the server watcher emails + notifies with a Buy now /
     Sell now button when a target is reached
   - Binance crypto prices are merged into the quote engine, so charts,
     alerts and valuations all use the real market price
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || window.__wcB2bMarket) return;
  window.__wcB2bMarket = true;
  var M = window.WC_B2B_MARKET = window.WC_B2B_MARKET || {};

  var CATALOG = [
    { t: 'BTCUSDT', name: 'Bitcoin', kind: 'Crypto', sym: 'BTCUSDT', c: '#f7931a' },
    { t: 'ETHUSDT', name: 'Ethereum', kind: 'Crypto', sym: 'ETHUSDT', c: '#627eea' },
    { t: 'BNBUSDT', name: 'BNB', kind: 'Crypto', sym: 'BNBUSDT', c: '#f3ba2f' },
    { t: 'SOLUSDT', name: 'Solana', kind: 'Crypto', sym: 'SOLUSDT', c: '#14f195' },
    { t: 'XRPUSDT', name: 'XRP', kind: 'Crypto', sym: 'XRPUSDT', c: '#23292f' },
    { t: 'ADAUSDT', name: 'Cardano', kind: 'Crypto', sym: 'ADAUSDT', c: '#0033ad' },
    { t: 'DOGEUSDT', name: 'Dogecoin', kind: 'Meme', sym: 'DOGEUSDT', c: '#c2a633' },
    { t: 'TRUMPUSDT', name: 'Official Trump', kind: 'Meme', sym: 'TRUMPUSDT', c: '#b8860b' },
    { t: 'WC', name: 'WhaleChat (WC)', kind: 'Company', sym: null, c: '#2ee6c9' },
    { t: 'SHOP', name: 'Shopify', kind: 'Stock', sym: null, c: '#96bf48' },
    { t: 'TSLA', name: 'Tesla', kind: 'Stock', sym: null, c: '#e82127' },
    { t: 'MSFT', name: 'Microsoft', kind: 'Stock', sym: null, c: '#00a4ef' },
    { t: 'GOOGL', name: 'Google (Alphabet)', kind: 'Stock', sym: null, c: '#4285f4' },
    { t: 'AMZN', name: 'Amazon', kind: 'Stock', sym: null, c: '#ff9900' },
    { t: 'AAPL', name: 'Apple', kind: 'Stock', sym: null, c: '#a2aaad' },
    { t: 'SSNLF', name: 'Samsung', kind: 'Stock', sym: null, c: '#1428a0' },
    { t: 'SPACEX', name: 'SpaceX', kind: 'Pre-IPO', sym: null, c: '#005288' }
  ];

  var WC_USD = 0.50;             /* WhaleChat token value */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function money(v) { return '$' + (Math.round((Number(v) || 0) * 100) / 100).toFixed(2); }
  function pct(v) { v = Number(v) || 0; return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; }
  function ic(n, s) { try { return typeof window.ic === 'function' ? window.ic(n, s) : ''; } catch (e) { return ''; } }
  function me2() { try { return me(); } catch (e) { return null; } }
  function acct() {
    var u = me2(); if (!u) return null;
    if (!u.investAcct) u.investAcct = { usd: 0, payout: 0, wcBalance: 0, portfolios: { stock: 0, wc: 0, b2b: 0, bot: 0 }, tools: {}, b2b: {}, b2bFav: [], b2bAlerts: [], b2bProfit: 0, disputes: [], requests: [], ledger: [] };
    var a = u.investAcct;
    if (!a.b2b) a.b2b = {}; if (!Array.isArray(a.b2bFav)) a.b2bFav = []; if (!Array.isArray(a.b2bAlerts)) a.b2bAlerts = [];
    return a;
  }
  function save() { try { if (typeof persist === 'function') persist(); } catch (e) {} try { if (typeof sync === 'function') sync(); } catch (e) {} }
  function repaint() { try { if (typeof render === 'function') render(); } catch (e) {} }
  function tmsg(m, t) { try { if (typeof toast === 'function') toast(m, t || 'ok'); } catch (e) {} }

  /* ---- the asset has to exist in the price engine to be tradeable -------- */
  M.ensureAssets = function () {
    try {
      if (typeof DB === 'undefined' || !DB) return;
      DB.stocks = DB.stocks || [];
      CATALOG.forEach(function (a) {
        if (DB.stocks.some(function (s) { return s.ticker === a.t; })) return;
        DB.stocks.push({
          ticker: a.t, name: a.name, displayTicker: a.t.replace('USDT', '/USDT'),
          sector: a.kind === 'Meme' ? 'Meme' : a.kind, color: a.c, crypto: a.kind === 'Crypto' || a.kind === 'Meme',
          price: a.t === 'WC' ? WC_USD : 100, prevClose: a.t === 'WC' ? WC_USD : 100, vol: 10,
          synthetic: a.t === 'SPACEX' || a.t === 'WC'
        });
      });
    } catch (e) {}
  };

  /* ---- Binance live prices → merged into the quote engine ---------------- */
  var BIN = { at: 0, prices: {}, ok: false };
  M.binance = function () { return BIN; };
  function fetchBinance() {
    if (typeof Remote === 'undefined' || !Remote || !Remote.enabled) return;
    var url = '/api/market/binance';
    try { url = Remote.url ? Remote.url(url) : url; } catch (e) {}
    fetch(url, { headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.prices) return;
        BIN.prices = d.prices; BIN.at = Date.now(); BIN.ok = true;
        applyBinance();
      })
      .catch(function () {});
  }
  function applyBinance() {
    try {
      if (typeof INV === 'undefined' || !INV.live) return;
      CATALOG.forEach(function (a) {
        if (!a.sym) return;
        var p = BIN.prices[a.sym];
        if (!p || !(Number(p.price) > 0)) return;
        var prev = INV.live[a.t];
        INV.live[a.t] = {
          price: Number(p.price),
          prevClose: Number(p.openPrice) || Number(p.price),
          open: Number(p.openPrice) || Number(p.price),
          dayHigh: Number(p.high) || Number(p.price),
          dayLow: Number(p.low) || Number(p.price),
          changePct: Number(p.changePct) || 0,
          changeUsd: 0,
          vol: Number(p.quoteVolume) || 0,
          dir: 0, updatedAt: Number(p.at) || Date.now(),
          source: 'binance'
        };
        if (!prev || !prev.__realTick) INV.live[a.t].__realTick = true;
      });
    } catch (e) {}
  }

  M.price = function (ticker) {
    if (String(ticker).toUpperCase() === 'WC') return WC_USD;
    try { var q = INV.quote(String(ticker).toUpperCase()); if (q && Number(q.price) > 0) return Number(q.price); } catch (e) {}
    return 0;
  };
  M.quote = function (ticker) {
    if (String(ticker).toUpperCase() === 'WC') return { price: WC_USD, changePct: 0 };
    try { return INV.quote(String(ticker).toUpperCase()) || { price: 0, changePct: 0 }; } catch (e) { return { price: 0, changePct: 0 }; }
  };
  M.entry = function (ticker) {
    var found = null;
    CATALOG.forEach(function (a) { if (a.t === String(ticker).toUpperCase()) found = a; });
    if (found) return found;
    var s = null; try { s = INV.stock(String(ticker).toUpperCase()); } catch (e) {}
    return { t: String(ticker).toUpperCase(), name: (s && s.name) || String(ticker).toUpperCase(), kind: (s && s.sector) || 'Asset', c: (s && s.color) || '#2ee6c9' };
  };

  /* ---- live price history per asset (drives the sparklines) -------------- */
  var HIST = {};
  function hist(ticker) {
    if (HIST[ticker] && HIST[ticker].length > 2) return HIST[ticker];
    var seed = [];
    try { seed = (INV.series(ticker, '1D') || []).slice(-40); } catch (e) {}
    var p = M.price(ticker);
    if (!seed.length && p > 0) seed = [p, p];
    HIST[ticker] = seed.map(function (v, i) { return { x: i, p: v }; });
    return HIST[ticker];
  }
  function sample(tickers) {
    tickers.forEach(function (t) {
      var h = hist(t); var p = M.price(t);
      if (!(p > 0)) return;
      var last = h[h.length - 1];
      if (last && last.p === p && h.length > 2) return;
      h.push({ x: Date.now(), p: p });
      if (h.length > 48) h.shift();
    });
  }
  function spark(ticker, w, h) {
    var vals = hist(ticker).map(function (x) { return x.p; }).filter(function (v) { return v > 0; });
    if (vals.length < 2) return { points: '', up: true };
    var W = w || 120, H = h || 34, pad = 2;
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    var span = (max - min) || (max * 0.0005) || 1;
    var pts = vals.map(function (v, i) {
      return (pad + (i / (vals.length - 1)) * (W - pad * 2)).toFixed(1) + ',' + ((H - pad) - ((v - min) / span) * (H - pad * 2)).toFixed(1);
    }).join(' ');
    return { points: pts, up: vals[vals.length - 1] >= vals[0], W: W, H: H };
  }

  /* ---- shared bits ------------------------------------------------------- */
  function head(title, sub, back) {
    return '<div class="page-head"><div class="row" style="gap:10px;align-items:center">' +
      (back ? '<a href="' + back + '" class="btn-icon">' + ic('back', 18) + '</a>' : '') +
      '<div><h1 style="margin:0">' + esc(title) + '</h1><p class="muted" style="margin:2px 0 0">' + esc(sub) + '</p></div></div></div>';
  }
  function holding(ticker) { var a = acct(); var h = a && a.b2b[ticker]; return h && Number(h.units) > 0 ? h : null; }

  /* ---- live ticker strip for the B2B dashboard --------------------------- */
  M.strip = function () {
    return '<div class="b2bm-strip" id="b2bmStrip">' + CATALOG.slice(0, 10).map(function (a) {
      var q = M.quote(a.t);
      return '<a class="b2bm-stripitem" href="#/investment/b2b/asset?t=' + encodeURIComponent(a.t) + '">' +
        '<span class="b2bm-sym" style="color:' + a.c + '">' + esc(a.t.replace('USDT', '')) + '</span>' +
        '<b data-b2bm-price="' + esc(a.t) + '">' + (q.price > 0 ? money(q.price) : '—') + '</b>' +
        '<i class="' + ((q.changePct || 0) >= 0 ? 'up' : 'down') + '" data-b2bm-chg="' + esc(a.t) + '">' + pct(q.changePct) + '</i>' +
      '</a>';
    }).join('') + '</div>';
  };

  /* ---- 1. marketplace ---------------------------------------------------- */
  M.viewMarket = function (params) {
    M.ensureAssets();
    var a = acct();
    var kind = (params && params.kind) || 'All';
    var list = CATALOG.filter(function (x) { return kind === 'All' || x.kind === kind; });
    var kinds = ['All', 'Crypto', 'Meme', 'Stock', 'Company', 'Pre-IPO'];
    var favs = (a && a.b2bFav) || [];
    return head('B2B marketplace', 'Real market prices · buy from the WhaleChat contract · sell back to the company contract', '#/investment/b2b') +
      '<div class="row b2b-cats" style="gap:6px;flex-wrap:wrap;margin-bottom:8px">' +
        kinds.map(function (k) { return '<a class="chip b2b-cat ' + (k === kind ? 'on' : '') + '" href="#/investment/b2b/market?kind=' + encodeURIComponent(k) + '">' + k + '</a>'; }).join('') +
        '<a class="chip b2b-cat" href="#/investment/b2b/alerts">Price alerts</a>' +
      '</div>' +
      '<div class="b2bm-grid">' + list.map(function (x) {
        var q = M.quote(x.t); var sp = spark(x.t, 140, 40); var h = holding(x.t);
        var fav = favs.indexOf(x.t) >= 0;
        return '<div class="b2bm-card" data-b2bm-card="' + esc(x.t) + '">' +
          '<div class="between" style="align-items:flex-start">' +
            '<a class="b2bm-name" href="#/investment/b2b/asset?t=' + encodeURIComponent(x.t) + '">' +
              '<i class="b2bm-dot" style="background:' + x.c + '"></i>' + esc(x.name) + '</a>' +
            '<button class="b2b-star ' + (fav ? 'on' : '') + '" data-act="wcbm-fav" data-t="' + esc(x.t) + '" title="Pin">' + (fav ? '★' : '☆') + '</button>' +
          '</div>' +
          '<div class="tiny muted">' + esc(x.kind) + ' · ' + esc(x.t.replace('USDT', '/USDT')) + (h ? ' · holding ' + Number(h.units).toFixed(6) : '') + '</div>' +
          '<div class="b2bm-row"><b data-b2bm-price="' + esc(x.t) + '">' + (q.price > 0 ? money(q.price) : '—') + '</b>' +
            '<i class="' + ((q.changePct || 0) >= 0 ? 'up' : 'down') + '" data-b2bm-chg="' + esc(x.t) + '">' + pct(q.changePct) + '</i></div>' +
          '<svg viewBox="0 0 140 40" class="b2bm-spark" preserveAspectRatio="none"><polyline data-b2bm-spark="' + esc(x.t) + '" points="' + sp.points + '" fill="none" stroke="' + (sp.up ? '#22c55e' : '#ef4444') + '" stroke-width="1.5"/></svg>' +
          '<div class="b2bm-actions">' +
            '<a class="btn btn-xs btn-primary" href="#/investment/b2b/buy?asset=' + encodeURIComponent(x.t) + '">Buy</a>' +
            '<a class="btn btn-xs btn-ghost" href="#/investment/b2b/sell?asset=' + encodeURIComponent(x.t) + '">Sell</a>' +
            '<a class="btn btn-xs btn-ghost" href="#/investment/b2b/asset?t=' + encodeURIComponent(x.t) + '">Data</a>' +
          '</div></div>';
      }).join('') + '</div>';
  };

  /* ---- 2. asset data page ------------------------------------------------ */
  M.viewAsset = function (params) {
    M.ensureAssets();
    var t = String((params && params.t) || (params && params.asset) || 'BTCUSDT').toUpperCase();
    var e = M.entry(t);
    var q = M.quote(t);
    var a = acct();
    var h = holding(t);
    var bin = BIN.prices[e.sym || ''];
    var sp = spark(t, 300, 110);
    var alert = ((a && a.b2bAlerts) || []).filter(function (x) { return x.ticker === t; })[0] || {};
    var fav = ((a && a.b2bFav) || []).indexOf(t) >= 0;
    var series = [];
    try { series = INV.series(t, '1D') || []; } catch (err) {}
    var open = Number(q.prevClose) || 0;
    var dayPct = Number(q.changePct) || 0;

    return head(e.name + ' · live', 'Real market data · ' + (bin ? 'Binance feed' : 'market feed'), '#/investment/b2b/market') +
      '<div class="card b2bm-hero">' +
        '<div class="between" style="align-items:flex-start">' +
          '<div><div class="tiny muted">' + esc(e.kind) + ' · ' + esc(t.replace('USDT', '/USDT')) + '</div>' +
            '<div class="b2bm-big" data-b2bm-price="' + esc(t) + '">' + (q.price > 0 ? money(q.price) : '—') + '</div>' +
            '<div class="' + (dayPct >= 0 ? 'up' : 'down') + '" data-b2bm-chg="' + esc(t) + '">' + pct(dayPct) + ' today</div></div>' +
          '<button class="b2b-star ' + (fav ? 'on' : '') + '" data-act="wcbm-fav" data-t="' + esc(t) + '">' + (fav ? '★' : '☆') + '</button>' +
        '</div>' +
        '<div class="b2bm-statgrid">' +
          '<div><span>Open</span><b>' + (open ? money(open) : '—') + '</b></div>' +
          '<div><span>24h high</span><b>' + (q.dayHigh ? money(q.dayHigh) : '—') + '</b></div>' +
          '<div><span>24h low</span><b>' + (q.dayLow ? money(q.dayLow) : '—') + '</b></div>' +
          '<div><span>24h volume</span><b>' + (q.vol ? Number(q.vol).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—') + '</b></div>' +
        '</div>' +
        '<svg viewBox="0 0 300 110" class="b2bm-bigchart" preserveAspectRatio="none"><polyline data-b2bm-bigspark="' + esc(t) + '" points="' + sp.points + '" fill="none" stroke="' + (sp.up ? '#22c55e' : '#ef4444') + '" stroke-width="1.8"/></svg>' +
        '<div class="tiny muted center">Live chart · updates every 2 seconds</div>' +
      '</div>' +
      (h ? '<div class="card"><div class="between"><span class="tiny muted">Your holding</span><b>' + Number(h.units).toFixed(6) + ' units</b></div>' +
        '<div class="between"><span class="tiny muted">Entry price</span><b>' + money(h.avgPrice) + '</b></div>' +
        '<div class="between"><span class="tiny muted">Market value</span><b>' + money(h.units * (q.price || h.avgPrice)) + '</b></div>' +
        '<div class="between"><span class="tiny muted">Unrealised P/L</span><b class="' + ((q.price || h.avgPrice) >= h.avgPrice ? 'up' : 'down') + '">' +
          ((q.price || h.avgPrice) >= h.avgPrice ? '+' : '') + money(h.units * ((q.price || h.avgPrice) - h.avgPrice)) + '</b></div>' +
        '<a class="btn btn-sm btn-primary" href="#/investment/b2b/sell?asset=' + encodeURIComponent(t) + '" style="width:100%;margin-top:8px">Sell ' + esc(e.name) + '</a></div>' : '') +
      '<div class="card"><div class="card-title">Buy at market</div>' +
        '<div class="tiny muted">Paid from your B2B capital · filled at the live price above.</div>' +
        '<a class="btn btn-primary" href="#/investment/b2b/buy?asset=' + encodeURIComponent(t) + '" style="width:100%;margin-top:8px">Buy ' + esc(e.name) + '</a></div>' +
      '<div class="card"><div class="card-title">Alert me on this asset</div>' +
        '<div class="row" style="gap:8px"><div class="field grow"><label class="label">Buy when price ≤ ($)</label>' +
          '<input class="input" id="b2bmBuy_' + esc(t) + '" type="number" step="0.0001" value="' + (alert.buy || '') + '"/></div>' +
        '<div class="field grow"><label class="label">Sell when price ≥ ($)</label>' +
          '<input class="input" id="b2bmSell_' + esc(t) + '" type="number" step="0.0001" value="' + (alert.sell || '') + '"/></div></div>' +
        '<button class="btn btn-soft" data-act="wcbm-alert-one" data-t="' + esc(t) + '" style="width:100%">Save alert</button>' +
        '<a class="btn btn-ghost btn-sm" href="#/investment/b2b/alerts" style="width:100%;margin-top:6px">Set alerts for several assets</a></div>';
  };

  /* ---- 3. multi-asset alert setup ---------------------------------------- */
  M.viewAlerts = function () {
    M.ensureAssets();
    var a = acct();
    var saved = (a && a.b2bAlerts) || [];
    return head('Price alerts', 'Pick one or many assets and set your estimated buy and sell prices.', '#/investment/b2b') +
      '<div class="card"><div class="between"><div class="card-title" style="margin:0">Choose assets</div>' +
        '<button class="btn btn-xs btn-ghost" data-act="wcbm-select-all">Select all</button></div>' +
        '<div class="b2bm-picklist">' + CATALOG.map(function (x) {
          var q = M.quote(x.t);
          var al = saved.filter(function (s) { return s.ticker === x.t; })[0] || {};
          return '<div class="b2bm-pick" data-b2bm-row="' + esc(x.t) + '">' +
            '<label class="b2bm-pickhead"><input type="checkbox" data-b2bm-pick value="' + esc(x.t) + '"' + (al.id ? ' checked' : '') + '/>' +
              '<i class="b2bm-dot" style="background:' + x.c + '"></i><b>' + esc(x.name) + '</b>' +
              '<span class="tiny muted">' + (q.price > 0 ? money(q.price) : '—') + '</span></label>' +
            '<div class="b2bm-pickfields">' +
              '<div class="field"><label class="label">Est. buy price ($)</label><input class="input" id="b2bmA_buy_' + esc(x.t) + '" type="number" step="0.0001" value="' + (al.buy || '') + '" placeholder="' + (q.price > 0 ? (q.price * 0.97).toFixed(4) : '') + '"/></div>' +
              '<div class="field"><label class="label">Est. sell price ($)</label><input class="input" id="b2bmA_sell_' + esc(x.t) + '" type="number" step="0.0001" value="' + (al.sell || '') + '" placeholder="' + (q.price > 0 ? (q.price * 1.03).toFixed(4) : '') + '"/></div>' +
            '</div></div>';
        }).join('') + '</div></div>' +
      '<div class="card b2b-buybar"><div class="between"><b><span id="b2bmPicked">0</span> asset(s) selected</b>' +
        '<label class="row" style="gap:6px;align-items:center;font-size:11px"><input type="checkbox" id="b2bmEmail" checked/> Email me</label></div>' +
        '<button class="btn btn-primary" data-act="wcbm-alert-save" style="width:100%;margin-top:8px">Save alerts</button>' +
        '<div class="tiny muted mt6">When a buy target is reached you get a notification and an email with a <b>Buy now</b> button; a sell target sends a <b>Sell now</b> button.</div></div>' +
      (saved.length ? '<div class="card"><div class="card-title">Your alerts</div><div class="ih-list">' + saved.map(function (x) {
        return '<div class="ih-row"><span class="grow">' + esc(x.ticker) + '<div class="tiny muted">buy ≤ ' + money(x.buy || 0) + ' · sell ≥ ' + money(x.sell || 0) + (x.email === false ? '' : ' · email') + '</div></span>' +
          '<button class="btn btn-xs btn-ghost" data-act="ih-b2b-alert-clear" data-t="' + esc(x.ticker) + '">Remove</button></div>';
      }).join('') + '</div></div>' : '');
  };

  /* ---- actions ----------------------------------------------------------- */
  if (typeof App !== 'undefined') {
    App.wcbmFav = function (id, ds) {
      var a = acct(); if (!a) return;
      var t = String((ds && ds.t) || '').toUpperCase();
      var i = a.b2bFav.indexOf(t);
      if (i >= 0) a.b2bFav.splice(i, 1); else a.b2bFav.push(t);
      save(); tmsg(i >= 0 ? 'Unpinned' : 'Pinned to favourites', 'ok'); repaint();
    };

    App.wcbmAlertOne = function (id, ds) {
      var a = acct(); if (!a) return;
      var t = String((ds && ds.t) || '').toUpperCase();
      var buy = Number((document.getElementById('b2bmBuy_' + t) || {}).value) || 0;
      var sell = Number((document.getElementById('b2bmSell_' + t) || {}).value) || 0;
      if (buy <= 0 && sell <= 0) return tmsg('Enter a buy or sell price', 'err');
      var ex = a.b2bAlerts.filter(function (x) { return x.ticker === t; })[0];
      if (ex) { ex.buy = buy; ex.sell = sell; ex.buyHit = false; ex.sellHit = false; ex.buyHitAt = 0; ex.sellHitAt = 0; ex.buyEmailAt = 0; ex.sellEmailAt = 0; }
      else a.b2bAlerts.push({ id: 'al_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ticker: t, buy: buy, sell: sell, email: true, createdAt: Date.now() });
      save(); tmsg('Alert saved for ' + t, 'ok'); repaint();
    };

    App.wcbmAlertSave = function () {
      var a = acct(); if (!a) return;
      var boxes = document.querySelectorAll('[data-b2bm-pick]');
      var emailEl = document.getElementById('b2bmEmail');
      var byEmail = emailEl ? !!emailEl.checked : true;
      var savedCount = 0;
      Array.prototype.forEach.call(boxes, function (b) {
        var t = String(b.value || '').toUpperCase();
        var buy = Number((document.getElementById('b2bmA_buy_' + t) || {}).value) || 0;
        var sell = Number((document.getElementById('b2bmA_sell_' + t) || {}).value) || 0;
        var ex = a.b2bAlerts.filter(function (x) { return x.ticker === t; })[0];
        if (!b.checked) {
          if (ex) a.b2bAlerts = a.b2bAlerts.filter(function (x) { return x.ticker !== t; });
          return;
        }
        if (buy <= 0 && sell <= 0) return;
        if (ex) { ex.buy = buy; ex.sell = sell; ex.email = byEmail; ex.buyHit = false; ex.sellHit = false; ex.buyHitAt = 0; ex.sellHitAt = 0; ex.buyEmailAt = 0; ex.sellEmailAt = 0; }
        else a.b2bAlerts.push({ id: 'al_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ticker: t, buy: buy, sell: sell, email: byEmail, createdAt: Date.now() });
        savedCount++;
      });
      save();
      tmsg(savedCount ? savedCount + ' alert' + (savedCount === 1 ? '' : 's') + ' saved' + (byEmail ? ' · email on' : '') : 'Select an asset and set a price', savedCount ? 'ok' : 'err');
      repaint();
    };

    App.wcbmSelectAll = function () {
      var boxes = document.querySelectorAll('[data-b2bm-pick]');
      var allOn = Array.prototype.every.call(boxes, function (b) { return b.checked; });
      Array.prototype.forEach.call(boxes, function (b) { b.checked = !allOn; });
      App.wcbmCount();
    };
    App.wcbmCount = function () {
      var n = document.querySelectorAll('[data-b2bm-pick]:checked').length;
      var el = document.getElementById('b2bmPicked'); if (el) el.textContent = String(n);
    };
  }

  /* ---- live painting ----------------------------------------------------- */
  function paint() {
    var tk = [];
    document.querySelectorAll('[data-b2bm-price],[data-b2bm-spark],[data-b2bm-bigspark]').forEach(function (el) {
      var t = el.getAttribute('data-b2bm-price') || el.getAttribute('data-b2bm-spark') || el.getAttribute('data-b2bm-bigspark');
      if (t && tk.indexOf(t) < 0) tk.push(t);
    });
    if (!tk.length) return;
    sample(tk);
    document.querySelectorAll('[data-b2bm-price]').forEach(function (el) {
      var t = el.getAttribute('data-b2bm-price'); var p = M.price(t);
      if (p > 0) el.textContent = money(p);
    });
    document.querySelectorAll('[data-b2bm-chg]').forEach(function (el) {
      var t = el.getAttribute('data-b2bm-chg'); var q = M.quote(t);
      var v = Number(q.changePct) || 0;
      el.textContent = pct(v);
      el.className = (el.className || '').replace(/\b(up|down)\b/g, '').trim() + ' ' + (v >= 0 ? 'up' : 'down');
    });
    document.querySelectorAll('[data-b2bm-spark]').forEach(function (el) {
      var g = spark(el.getAttribute('data-b2bm-spark'), 140, 40);
      if (g.points) el.setAttribute('points', g.points);
      el.setAttribute('stroke', g.up ? '#22c55e' : '#ef4444');
    });
    document.querySelectorAll('[data-b2bm-bigspark]').forEach(function (el) {
      var g = spark(el.getAttribute('data-b2bm-bigspark'), 300, 110);
      if (g.points) el.setAttribute('points', g.points);
      el.setAttribute('stroke', g.up ? '#22c55e' : '#ef4444');
    });
  }
  M.paint = paint;

  /* ---- routes ------------------------------------------------------------ */
  function patch() {
    if (typeof VIEWS === 'undefined' || !VIEWS.investment) return false;
    if (VIEWS.__wcB2bMarket) return true;
    var base = VIEWS.investment;
    VIEWS.investment = function (parts, params) {
      if ((parts[1] || '') === 'b2b') {
        var sub = parts[2] || '';
        if (sub === 'market' || sub === 'marketplace') return M.viewMarket(params);
        if (sub === 'asset') return M.viewAsset(params);
        if (sub === 'alerts') return M.viewAlerts(params);
      }
      return base.apply(this, arguments);
    };
    VIEWS.__wcB2bMarket = true;
    return true;
  }

  var tries = 0;
  (function boot() {
    if (!patch()) {
      if (tries++ < 80) return setTimeout(boot, 400);
      return;
    }
    M.ensureAssets();
    fetchBinance();
    setInterval(fetchBinance, 15000);
    setInterval(function () {
      var h = String(location.hash || '');
      if (h.indexOf('#/investment/b2b') !== 0) return;
      paint();
    }, 2000);
    document.addEventListener('change', function (ev) {
      var t = ev.target;
      if (t && t.matches && t.matches('[data-b2bm-pick]')) { try { App.wcbmCount(); } catch (e) {} }
    }, false);
  })();

  /* ---- admin: Binance connection ----------------------------------------- */
  M.adminCard = function () {
    var st = BIN;
    return '<div class="card"><div class="card-title">Binance price feed</div>' +
      '<div class="tiny muted" style="margin-bottom:8px">Crypto and meme prices come from Binance in real time; stocks keep using Finnhub. Charts still render from the existing Finnhub series.</div>' +
      '<div class="ih-list">' +
        '<div class="ih-row"><span>Feed</span><b class="' + (st.ok ? 'up' : 'down') + '">' + (st.ok ? 'connected' : 'not reachable from this session') + '</b></div>' +
        '<div class="ih-row"><span>Last tick</span><b>' + (st.at ? new Date(st.at).toLocaleTimeString() : '—') + '</b></div>' +
        '<div class="ih-row"><span>Symbols</span><b>' + Object.keys(st.prices || {}).length + '</b></div>' +
      '</div>' +
      '<div class="field" style="margin-top:10px"><label class="label">Binance API key (optional)</label>' +
        '<input class="input" id="binanceKey" type="password" placeholder="stored on the server, never shown again"/></div>' +
      '<div class="row" style="gap:8px"><button class="btn btn-primary btn-sm grow" data-act="wcbm-binance-save">Save and test</button>' +
        '<button class="btn btn-ghost btn-sm grow" data-act="wcbm-binance-test">Test now</button></div>' +
      '<div class="tiny muted mt6" id="binanceStatus">Public Binance prices need no key — a key is only kept for rate limits.</div></div>';
  };

  if (typeof App !== 'undefined') {
    App.wcbmBinanceSave = async function () {
      var key = (document.getElementById('binanceKey') || {}).value || '';
      var u = me2();
      var body = { adminId: u && u.id, enabled: true };
      if (key) body.apiKey = key;
      try {
        var url = '/api/market/binance/config';
        if (typeof Remote !== 'undefined' && Remote && Remote.enabled && Remote.url) url = Remote.url(url);
        var r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        var d = await r.json();
        if (!d.ok) return tmsg(d.error || 'Could not save', 'err');
        fetchBinance();
        tmsg('Binance feed saved · ' + (d.symbols || 0) + ' symbols', 'ok');
        repaint();
      } catch (e) { tmsg('Binance: ' + e.message, 'err'); }
    };
    App.wcbmBinanceTest = function () {
      fetchBinance();
      setTimeout(function () {
        var el = document.getElementById('binanceStatus');
        if (el) el.textContent = BIN.ok ? 'Binance reachable · ' + Object.keys(BIN.prices || {}).length + ' symbols live' : 'Binance not reachable right now';
        tmsg(BIN.ok ? 'Binance feed is live — ' + Object.keys(BIN.prices || {}).length + ' symbols' : 'Binance feed unreachable', BIN.ok ? 'ok' : 'err');
      }, 1500);
    };
  }

  /* ---- styles ------------------------------------------------------------ */
  (function styles() {
    if (document.getElementById('b2bm-style')) return;
    var st = document.createElement('style'); st.id = 'b2bm-style';
    st.textContent = `
    .b2bm-strip{display:flex;gap:8px;overflow-x:auto;padding:8px 2px;margin-bottom:10px;border-bottom:1px solid var(--border)}
    .b2bm-stripitem{display:flex;flex-direction:column;gap:1px;min-width:78px;text-decoration:none;color:var(--text)}
    .b2bm-stripitem b{font-size:12px;font-variant-numeric:tabular-nums}
    .b2bm-stripitem i{font-size:9.5px;font-style:normal}
    .b2bm-stripitem i.up{color:#22c55e}.b2bm-stripitem i.down{color:#ef4444}
    .b2bm-sym{font-size:9.5px;font-weight:800;letter-spacing:.03em}
    .b2bm-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));gap:8px}
    .b2bm-card{padding:10px;border:1px solid var(--border);border-radius:12px;background:var(--surface-2);min-width:0}
    .b2bm-name{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:700;color:var(--text);text-decoration:none;min-width:0}
    .b2bm-dot{width:8px;height:8px;border-radius:99px;flex:none;display:inline-block}
    .b2bm-row{display:flex;justify-content:space-between;align-items:baseline;margin-top:4px}
    .b2bm-row b{font-size:14px;font-variant-numeric:tabular-nums}
    .b2bm-row i{font-size:10px;font-style:normal}
    .b2bm-row i.up{color:#22c55e}.b2bm-row i.down{color:#ef4444}
    .b2bm-spark{width:100%;height:40px;display:block;margin-top:4px}
    .b2bm-actions{display:flex;gap:4px;margin-top:7px;flex-wrap:wrap}
    .b2bm-hero{padding:12px}
    .b2bm-big{font-size:26px;font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
    .b2bm-statgrid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
    .b2bm-statgrid span{display:block;font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-2);font-weight:700}
    .b2bm-statgrid b{font-size:12.5px;font-variant-numeric:tabular-nums}
    .b2bm-bigchart{width:100%;height:110px;display:block;margin-top:10px}
    .b2bm-picklist{display:flex;flex-direction:column;gap:6px;max-height:62vh;overflow:auto}
    .b2bm-pick{border:1px solid var(--border);border-radius:11px;padding:8px 10px;background:var(--surface-2)}
    .b2bm-pickhead{display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12.5px}
    .b2bm-pickhead input{width:16px;height:16px;accent-color:var(--accent)}
    .b2bm-pickfields{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:6px}
    @media(max-width:520px){.b2bm-pickfields{grid-template-columns:1fr}.b2bm-grid{grid-template-columns:1fr 1fr}}
    `;
    document.head.appendChild(st);
  })();
})();
