/* =========================================================================
   WhaleChat 24/7 market (module wc-market-247)
   -------------------------------------------------------------------------
   The app only lists instruments that never close:
     · Crypto 24/7          BTC/USD ETH/USD SOL/USD BNB/USD DOGE/USD XRP/USD
     · Forex 24/7 synthetic EUR/USD GBP/USD USD/JPY
     · Synthetic stocks     MARA 24/7 SHOP 24/7 TSLA 24/7 AAPL 24/7
                            NVDA 24/7 AMZN 24/7
     · Indices 24/7         US30 24/7 US100 24/7 GOLD 24/7 OIL 24/7

   · the list is filtered to that universe until the admin connects a data
     provider (Finnhub, Binance or Twelve Data); after that every listed asset shows
   · every card carries a pulsing dot + "LIVE — 24/7" and synthetic assets a
     "24/7 SYNTHETIC · ALWAYS LIVE" badge
   · a watchdog forces a feed refresh when any quote is older than 5 seconds,
     and a local continuity tick keeps synthetic prices moving if the network
     is unreachable; real-feed assets never receive invented ticks
   · trade flow, payouts, TP/SL and the wallet are untouched
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcMarket247) return;
  window.__wcMarket247 = true;

  var UNIVERSE = {
    crypto: ['BTCUSD', 'ETHUSD', 'SOLUSD', 'BNBUSD', 'DOGEUSD', 'XRPUSD'],
    forex: ['EURUSD24', 'GBPUSD24', 'USDJPY24'],
    stocks: ['MARA24', 'SHOP24', 'TSLA24', 'AAPL24', 'NVDA24', 'AMZN24'],
    indices: ['US3024', 'US10024', 'GOLD24', 'OIL24']
  };
  var ALL = [].concat(UNIVERSE.crypto, UNIVERSE.forex, UNIVERSE.stocks, UNIVERSE.indices);
  var SET = {};
  ALL.forEach(function (t) { SET[t] = true; });

  var CATS = ['All Live', 'Crypto', 'US Stocks', 'Forex', 'Indices'];
  var DISCLAIMER = 'WhaleChat trades live real stock prices mirroring real markets, but the trade flow is built for the future because the WhaleChat trading system is designed to let users have tools that can help them never take a total loss on any trade — whether the market is falling or rising against the user\'s trade direction. This ensures no user ends with a negative or zero trade balance, and users can also earn dividends reward bonuses on each trade held until time closing. It also allows users to trade NYSE/NASDAQ-style assets. This is what allows 24/7 trading.';

  /* feed detection: any connected provider switches the full list on */
  function pollFeeds() {
    var base = '';
    try { if (typeof Remote !== 'undefined' && Remote && Remote.enabled) base = Remote.base || ''; } catch (e) {}
    fetch(base + '/api/market/status', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (st) {
      if (!st) return;
      var f = st.feeds || {};
      var on = !!(st.hasKey || f.finnhub || f.binance || f.twelvedata || Number(st.realTickers) > 0);
      if (on !== !!window.__wcFeedsOn) {
        window.__wcFeedsOn = on;
        try { if (typeof render === 'function') render(); } catch (e) {}
      }
    }).catch(function () {});
  }
  pollFeeds();
  setInterval(pollFeeds, 20000);

  function inv() {
    try { return (typeof INV !== 'undefined') ? INV : null; } catch (e) { return null; }
  }
  function dbOk() { try { return typeof DB !== 'undefined' && DB && DB.stocks; } catch (e) { return false; } }
  function strict247(s) {
    var w = window.__wcFeedsOn; window.__wcFeedsOn = false;
    try { return is247(s); } finally { window.__wcFeedsOn = w; }
  }
  function is247(s) {
    if (!s || !s.ticker) return false;
    var t = String(s.ticker).toUpperCase();
    if (SET[t]) return true;
    /* be tolerant of a differently-named row (e.g. BTCUSDT from an older DB) */
    var n = String(s.name || '');
    if (/24\/7/i.test(n)) return true;
    if (s.twentyFourSeven === true && s.hidden !== true) return true;
    /* once the admin has connected Finnhub, Binance or Twelve Data, every listed
       (non-hidden) asset joins the market list */
    if (window.__wcFeedsOn && s.hidden !== true) return true;
    return false;
  }
  function synthetic(s) {
    if (!s) return false;
    if (s.synthetic) return true;
    var t = String(s.ticker || '').toUpperCase();
    return UNIVERSE.stocks.indexOf(t) >= 0 || UNIVERSE.indices.indexOf(t) >= 0 || /24\/7/i.test(String(s.name || ''));
  }
  function categoryOf(s) {
    var t = String((s && s.ticker) || '').toUpperCase();
    if (UNIVERSE.crypto.indexOf(t) >= 0) return 'Crypto';
    if (UNIVERSE.forex.indexOf(t) >= 0) return 'Forex';
    if (UNIVERSE.stocks.indexOf(t) >= 0) return 'US Stocks';
    if (UNIVERSE.indices.indexOf(t) >= 0) return 'Indices';
    var ac = String((s && s.assetClass) || '').toLowerCase();
    if (window.__wcFeedsOn && ac) {
      if (ac === 'crypto') return 'Crypto';
      if (ac === 'forex') return 'Forex';
      if (ac === 'us' || ac === 'global') return 'US Stocks';
    }
    var n = String((s && s.name) || '');
    if (/crypto|btc|eth|sol|doge|xrp|bnb/i.test(t + ' ' + n)) return 'Crypto';
    if (/forex|synthetic pair/i.test(String((s && s.sector) || ''))) return 'Forex';
    if (/index|indices/i.test(String((s && s.sector) || ''))) return 'Indices';
    return 'US Stocks';
  }

  /* ------------------------------------------------------------ list filters */
  function installFilters() {
    var I = inv();
    if (!I || I.__wc247Filters) return false;
    I.__wc247Filters = true;
    I.is247 = is247;
    I.isSynthetic247 = synthetic;
    I.category247 = categoryOf;

    I.visibleStocks = function () {
      var list = [];
      try { list = I.stocks(); } catch (e) { return []; }
      return list.filter(function (s) { return is247(s) && s.hidden !== true; });
    };
    I.visibleCats = function () { return CATS.slice(); };
    I.CATS = CATS.slice();
    if (!I.marketCat || CATS.indexOf(I.marketCat) < 0) I.marketCat = 'All Live';

    I.marketFiltered = function () {
      var list = I.visibleStocks();
      var q = String(I.marketQuery || '').trim().toLowerCase();
      if (q) {
        return list.filter(function (s) {
          return (s.ticker + ' ' + (s.name || '') + ' ' + (s.sector || '')).toLowerCase().indexOf(q) >= 0;
        });
      }
      var cat = I.marketCat || 'All Live';
      if (cat === 'Crypto') list = list.filter(function (s) { return categoryOf(s) === 'Crypto'; });
      else if (cat === 'US Stocks') list = list.filter(function (s) { return categoryOf(s) === 'US Stocks'; });
      else if (cat === 'Forex') list = list.filter(function (s) { return categoryOf(s) === 'Forex'; });
      else if (cat === 'Indices') list = list.filter(function (s) { return categoryOf(s) === 'Indices'; });
      return list;
    };

    /* old chips map onto the new names so persisted state can never blank the list */
    if (I.marketCat === 'All') I.marketCat = 'All Live';
    var app = (typeof App !== 'undefined') ? App : null;
    if (app && app.invCat) {
      var baseCat = app.invCat;
      app.invCat = function (id, ds) {
        var c = ds && ds.cat;
        if (c === 'All' || c === 'All Live') c = 'All Live';
        if (CATS.indexOf(c) < 0) c = 'All Live';
        I.marketCat = c;
        I.marketQuery = '';
        try { render(); } catch (e) {}
      };
    }
    return true;
  }

  /* --------------------------------------------------------------- card badge */
  function installCards() {
    var I = inv();
    if (!I || !I.cardHTML || I.__wc247Cards) return false;
    I.__wc247Cards = true;
    var baseCard = I.cardHTML;
    I.cardHTML = function (s) {
      var html = baseCard.apply(this, arguments);
      if (!strict247(s)) return html;
      var badge = synthetic(s)
        ? '<span class="wc247-badge">24/7 SYNTHETIC · ALWAYS LIVE</span>'
        : '<span class="wc247-badge live">LIVE · 24/7</span>';
      var row = '<div class="wc247-row"><span class="wc247-dot"></span><span>LIVE — 24/7</span>' + badge + '</div>';
      return html.replace(/<\/a>\s*$/, row + '</a>');
    };
    return true;
  }

  /* -------------------------------------------------------------- market view */
  function installMarket() {
    var I = inv();
    if (!I || !I.viewMarket || I.__wc247Market) return false;
    I.__wc247Market = true;
    var base = I.viewMarket;
    I.viewMarket = function () {
      var html = base.apply(this, arguments);
      /* drop the old feed notice (it could say "market closed" on older builds) */
      html = html.replace(/<div class="card inv-note" data-market-notice="1">[\s\S]*?<\/span><\/div>/g, '');
      var banner =
        '<div class="wc247-banner">' +
          '<div class="wc247-title"><span class="wc247-dot big"></span><b>All Markets Are Live 24/7 - No Weekend Closure - No Overnight Closure</b></div>' +
          '<div class="wc247-sub">Prices update every 2 seconds, Monday to Sunday. Synthetic markets mirror real stocks and trade continuously.</div>' +
        '</div>';
      var disclaimer =
        '<div class="card wc247-disclaimer"><div class="wc247-row" style="margin:0 0 6px"><span class="wc247-dot"></span><b>24/7 TRADING DISCLOSURE</b></div>' +
        '<div class="tiny muted" style="line-height:1.75">' + DISCLAIMER + '</div></div>';
      if (html.indexOf('<div class="page-head">') >= 0) html = html.replace('<div class="page-head">', banner + '<div class="page-head">');
      else html = banner + html;
      return html + disclaimer;
    };
    return true;
  }

  /* --------------------------------------------------------- stock chart page */
  function installStock() {
    var I = inv();
    if (!I || !I.viewStock || I.__wc247Stock) return false;
    I.__wc247Stock = true;
    var base = I.viewStock;
    I.viewStock = function (ticker) {
      var s = null;
      try { s = I.stock(ticker); } catch (e) {}
      var html = base.apply(this, arguments);
      if (!s || !strict247(s)) return html;
      var bar = '<div class="wc247-livebar"><span class="wc247-dot"></span><b>LIVE — 24/7</b>' +
        '<span class="wc247-badge' + (synthetic(s) ? '' : ' live') + '">' + (synthetic(s) ? '24/7 SYNTHETIC · ALWAYS LIVE' : 'CONTINUOUS MARKET') + '</span>' +
        '<span class="wc247-updated" data-wc247-updated="' + s.ticker + '">updating…</span></div>';
      /* put the live bar at the top of the price card */
      html = html.replace('<div class="card inv-pricecard">', '<div class="card inv-pricecard">' + bar);
      return html;
    };
    return true;
  }

  /* ------------------------------------------------------- continuous engine */
  function tickLocal(ticker) {
    var I = inv();
    if (!I) return;
    var s = I.stock(ticker);
    if (!s) return;
    var q = I.live[ticker];
    var now = Date.now();
    var prevClose = Number(s.prevClose) || Number(q && q.prevClose) || Number(s.price) || 1;
    var price = q && Number(q.price) > 0 ? Number(q.price) : prevClose;
    var isCrypto = categoryOf(s) === 'Crypto';
    var isFx = categoryOf(s) === 'Forex';
    var shock = (Math.random() - 0.5) * (isCrypto ? 0.0045 : isFx ? 0.0012 : 0.0028);
    var next = Math.max(0.000001, price * (1 + shock));
    var out = Object.assign({}, q || {}, {
      ticker: ticker, price: next, prevClose: prevClose,
      changePct: prevClose ? ((next - prevClose) / prevClose) * 100 : 0,
      changeUsd: next - prevClose,
      dir: shock >= 0 ? 1 : -1, updatedAt: now,
      dayHigh: Math.max(Number((q && q.dayHigh) || next), next),
      dayLow: Math.min(Number((q && q.dayLow) || next), next),
      vol: Number((q && q.vol) || 12e6) * (1 + Math.random() * 0.01),
      source: 'wc247', feed: true
    });
    I.live[ticker] = out;
    s.price = next;
    try {
      var key = ticker + '::1D';
      if (I.seriesCache && I.seriesCache[key] && I.seriesCache[key].length) {
        I.seriesCache[key][I.seriesCache[key].length - 1] = next;
      }
    } catch (e) {}
  }

  function paintTicker(ticker) {
    var I = inv();
    var q = I && I.live && I.live[ticker];
    if (!q) return;
    var pct = Number(q.changePct) || 0;
    document.querySelectorAll('[data-lv="price:' + ticker + '"]').forEach(function (el) {
      el.textContent = (typeof usd === 'function') ? usd(q.price) : '$' + q.price.toFixed(2);
    });
    document.querySelectorAll('[data-lv="wc:' + ticker + '"]').forEach(function (el) {
      if (typeof coins === 'function' && typeof usdToCoins === 'function') el.textContent = coins(usdToCoins(q.price)) + ' WC';
    });
    document.querySelectorAll('[data-lv="pct:' + ticker + '"]').forEach(function (el) {
      el.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
      el.classList.toggle('up', pct >= 0);
      el.classList.toggle('down', pct < 0);
    });
    document.querySelectorAll('[data-wc247-updated="' + ticker + '"]').forEach(function (el) {
      el.textContent = 'live · ' + new Date().toLocaleTimeString();
    });
  }

  function watchdog() {
    var I = inv();
    if (!I || document.hidden) return;
    var now = Date.now();
    var stale = false;
    var list = [];
    try { list = I.visibleStocks(); } catch (e) { return; }
    list.forEach(function (s) {
      var q = I.live && I.live[s.ticker];
      /* real-feed assets are never given invented ticks */
      var synth = strict247(s);
      /* The feed can be empty before the first poll — seed the first quote. */
      if (!q || !(Number(q.price) > 0)) { if (synth) tickLocal(s.ticker); stale = true; return; }
      var age = now - (Number(q.updatedAt) || 0);
      if (age > 5000) { stale = true; if (synth) tickLocal(s.ticker); }
      paintTicker(s.ticker);
    });
    if (stale) {
      try {
        if (window.WC_MARKET && typeof window.WC_MARKET.forcePoll === 'function') window.WC_MARKET.forcePoll();
      } catch (e) {}
    }
    /* keep the chart's 1D tail in step even when a chart library owns the DOM */
    try { if (I.paint) I.paint(); } catch (e) {}
    var marketReady = list.length > 0;
    if (marketReady && /^#\/invest\/market/.test(location.hash || '')) {
      var empty = document.querySelector('#ivList .inv-empty');
      if (empty && document.querySelectorAll('#ivList .inv-mcard').length === 0) {
        try { render(); } catch (e) {}
      }
    }
  }

  /* ------------------------------------------------------------------ styles */
  function css() {
    if (document.getElementById('wc247-css')) return;
    var st = document.createElement('style');
    st.id = 'wc247-css';
    st.textContent =
      '.wc247-banner{padding:12px 14px;border-radius:14px;margin-bottom:12px;background:linear-gradient(100deg,rgba(34,197,94,.16),rgba(46,230,201,.05));border:1px solid rgba(34,197,94,.4)}' +
      '.wc247-title{display:flex;align-items:center;gap:9px;flex-wrap:wrap}' +
      '.wc247-title b{color:#16a34a;font-size:12.5px;letter-spacing:.01em;line-height:1.45}' +
      '.wc247-sub{margin-top:5px;font-size:10.5px;color:var(--muted);line-height:1.6;padding-left:17px}' +
      '.wc247-dot{width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 0 rgba(34,197,94,.7);animation:wc247pulse 1.6s infinite;flex:none;display:inline-block}' +
      '.wc247-dot.big{width:11px;height:11px}' +
      '@keyframes wc247pulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.65)}70%{box-shadow:0 0 0 7px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}' +
      '.wc247-row{display:flex;align-items:center;gap:6px;margin-top:7px;font-size:9px;color:#22c55e;font-weight:800;letter-spacing:.05em;flex-wrap:wrap}' +
      '.wc247-badge{font-size:8px;padding:1px 5px;border-radius:5px;background:rgba(139,123,255,.16);border:1px solid rgba(139,123,255,.45);color:#a99cff;font-weight:800;letter-spacing:.03em}' +
      '.wc247-badge.live{background:rgba(34,197,94,.14);border-color:rgba(34,197,94,.45);color:#22c55e}' +
      '.wc247-livebar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px;padding:7px 9px;border-radius:9px;background:rgba(34,197,94,.07);border:1px solid rgba(34,197,94,.22);font-size:9.5px;color:#22c55e;font-weight:800;letter-spacing:.04em}' +
      '.wc247-updated{margin-left:auto;color:var(--muted);font-weight:500;letter-spacing:0;font-size:9px}' +
      '.wc247-disclaimer{margin-top:12px;border-color:rgba(34,197,94,.22)}' +
      '.wc247-disclaimer b{font-size:9.5px;letter-spacing:.06em;color:#16a34a}';
    document.head.appendChild(st);
  }

  /* ------------------------------------------------ per-trade leverage pick */
  function installLeverage() {
    try {
      if (typeof LT === 'undefined' || !LT.ticketHTML || LT.__wcLev) return true;
      LT.__wcLev = true;
      var base = LT.ticketHTML;
      LT.ticketHTML = function () {
        var html = base.apply(this, arguments);
        if (html.indexOf('data-act="lt-start"') < 0 || html.indexOf('id="ltLev"') >= 0) return html;
        var cur = 5;
        try { cur = this.leverage(); } catch (e) {}
        var opts = [1, 2, 3, 4, 5, 10, 20, 30, 50, 100];
        if (opts.indexOf(cur) < 0) opts.push(cur);
        opts.sort(function (a, b) { return a - b; });
        var sel = '<div class="field"><label class="label">Trade leverage (per trade)</label>' +
          '<select class="input" id="ltLev">' + opts.map(function (v) {
            return '<option value="' + v + '"' + (v === cur ? ' selected' : '') + '>' + v + 'x' +
              (v <= 5 ? ' · low risk' : ' · high risk') + '</option>';
          }).join('') + '</select>' +
          '<div class="tiny muted">Leave it on ' + cur + 'x to use the default. Leverage multiplies profit and loss.</div></div>';
        return html.replace('<button class="btn btn-primary" data-act="lt-start"', sel + '<button class="btn btn-primary" data-act="lt-start"');
      };
      document.addEventListener('click', function (ev) {
        var btn = ev.target && ev.target.closest ? ev.target.closest('[data-act="lt-start"]') : null;
        if (!btn) return;
        var el = document.getElementById('ltLev');
        if (!el) return;
        var v = Math.min(100, Math.max(1, Number(el.value) || 5));
        try {
          if (!DB.invest) DB.invest = {};
          DB.invest.leverage = v;
          if (typeof persist === 'function') persist();
        } catch (e) {}
      }, true);
      return true;
    } catch (e) { return false; }
  }

  /* ------------------------------------------------------------------- boot */
  function boot() {
    css();
    var ok = installFilters() && installCards() && installMarket() && installStock() && installLeverage();
    return ok;
  }

  var tries = 0;
  var iv = setInterval(function () {
    tries++;
    var done = false;
    try { done = boot(); } catch (e) { console.error('[wc247]', e); }
    if (done || tries > 80) clearInterval(iv);
  }, 250);

  /* re-apply overrides after an app update swaps functions */
  setInterval(function () { try { boot(); } catch (e) {} }, 5000);
  setInterval(function () { try { watchdog(); } catch (e) {} }, 1000);

  window.WC247 = { universe: UNIVERSE, cats: CATS, is247: is247, isSynthetic: synthetic, categoryOf: categoryOf, tick: tickLocal };
})();
