/* =========================================================================
   WhaleChat · extended market universe (wc-market-universe)
   -------------------------------------------------------------------------
   Guarantees the app always lists 300+ tradable instruments, even when:
     · the device is offline,
     · the sync server was redeployed with an empty state, or
     · the admin never enabled markets by hand.

   The catalogue in wc-market-universe-data.js is merged into DB.stocks:
     - existing rows keep their admin-edited price and settings
     - missing rows are added with the provider they are fed by
     - every crypto row is 24/7; forex is 24/5; stocks follow market hours
   Live quotes from Binance / Finnhub / Twelve Data overwrite the fallback
   price as soon as they arrive (see wc-market-feed.js).
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcMarketUniverse) return;
  window.__wcMarketUniverse = true;

  var COLORS = window.WC_UNIVERSE_COLORS || ['#2ee6c9'];
  var CATALOG = window.WC_UNIVERSE || [];

  function ready() {
    try { return typeof DB !== 'undefined' && DB && typeof INV !== 'undefined' && INV && typeof INV.db === 'function'; }
    catch (e) { return false; }
  }

  function colorFor(ticker) {
    var h = 0;
    for (var i = 0; i < ticker.length; i++) h = (h * 31 + ticker.charCodeAt(i)) >>> 0;
    return COLORS[h % COLORS.length];
  }

  function merge() {
    if (!ready()) return false;
    try { INV.db(); } catch (e) { return false; }
    if (!Array.isArray(DB.stocks)) DB.stocks = [];

    /* If the previous seed flag survived but the list was wiped (server
       redeploy / cleared cache), the old code never re-seeded — repair that. */
    if (!DB.stocks.length) {
      try { DB.invest && (DB.invest.seededAt = 0); } catch (e) {}
      try { if (typeof INV.SEED !== 'undefined') { INV.db(); } } catch (e) {}
      try { INV.db(); } catch (e) {}
    }

    var byTicker = {};
    DB.stocks.forEach(function (s) {
      if (s && s.ticker) byTicker[String(s.ticker).toUpperCase()] = s;
    });

    var added = 0, fixed = 0;
    CATALOG.forEach(function (row) {
      var t = String(row.ticker || '').toUpperCase();
      if (!t) return;
      var s = byTicker[t];
      var isCrypto = row.assetClass === 'crypto';
      var disp = row.displayTicker || (isCrypto ? t.replace(/USDT$/, '/USDT') : t);
      if (!s) {
        s = {
          id: 'st_' + t.toLowerCase().replace(/[^a-z0-9]/g, ''),
          ticker: t,
          displayTicker: disp,
          finnhubSymbol: isCrypto ? 'BINANCE:' + t : disp,
          assetClass: row.assetClass || 'us',
          name: row.name || t,
          exchange: row.exchange || (isCrypto ? 'Binance' : 'US'),
          currency: isCrypto ? 'USDT' : 'USD',
          color: colorFor(t),
          sector: row.sector || (isCrypto ? 'Crypto' : 'Stock'),
          provider: row.provider || (isCrypto ? 'binance' : 'finnhub'),
          price: Number(row.price) || 0,
          prevClose: Number(row.price) || 0,
          pe: 0, mcap: 0, div: 0, vol: 10,
          crypto: isCrypto,
          synthetic: false,
          paused: false, custom: false,
          twentyFourSeven: isCrypto || row.sector === 'Indices',
          createdAt: Date.now()
        };
        DB.stocks.push(s);
        byTicker[t] = s;
        added++;
        return;
      }
      /* enrich, never clobber admin edits */
      var changed = false;
      if (!s.assetClass) { s.assetClass = row.assetClass || 'us'; changed = true; }
      if (!s.provider) { s.provider = row.provider || (isCrypto ? 'binance' : 'finnhub'); changed = true; }
      if (!s.name) { s.name = row.name || t; changed = true; }
      if (!s.sector) { s.sector = row.sector || (isCrypto ? 'Crypto' : 'Stock'); changed = true; }
      if (!s.exchange) { s.exchange = row.exchange || (isCrypto ? 'Binance' : 'US'); changed = true; }
      if (!s.displayTicker) { s.displayTicker = disp; changed = true; }
      if (!s.currency) { s.currency = isCrypto ? 'USDT' : 'USD'; changed = true; }
      if (!s.color) { s.color = colorFor(t); changed = true; }
      if (isCrypto && s.crypto !== true) { s.crypto = true; changed = true; }
      if (isCrypto && s.twentyFourSeven !== true) { s.twentyFourSeven = true; changed = true; }
      /* a wiped / zero price would hide the row behind a 0.00 quote */
      if (!(Number(s.price) > 0) && Number(row.price) > 0) {
        s.price = Number(row.price); s.prevClose = Number(row.price); changed = true;
      }
      if (changed) fixed++;
    });

    /* WhaleCoin (WC) company stock must always exist */
    if (!byTicker.WC) {
      DB.stocks.push({
        id: 'st_wc', ticker: 'WC', displayTicker: 'WC', finnhubSymbol: 'WC',
        assetClass: 'us', name: 'WhaleChat (WC)', exchange: 'WhaleChat', currency: 'USD',
        color: '#2ee6c9', sector: 'Company', price: 12.5, prevClose: 12.5,
        div: 0, vol: 5, pe: 0, mcap: 0, paused: false, custom: false,
        synthetic: true, twentyFourSeven: true, createdAt: Date.now()
      });
      byTicker.WC = true;
    }

    /* Market classes must be switched on — an empty class list means every
       tab renders empty and the app says "no markets enabled". */
    try {
      var inv = INV.db();
      if (!inv.classes || typeof inv.classes !== 'object') inv.classes = {};
      ['us', 'global', 'forex', 'crypto'].forEach(function (k) {
        if (inv.classes[k] === false && !inv.__wcClassesForced) inv.classes[k] = true;
      });
      if (!inv.classes.us && !inv.classes.global && !inv.classes.forex && !inv.classes.crypto) {
        inv.classes = { us: true, global: true, forex: true, crypto: true };
      }
    } catch (e) {}

    window.__wcUniverseCount = DB.stocks.length;
    if ((added || fixed) && typeof persist === 'function') {
      try { persist(); } catch (e) {}
    }
    if (added) {
      console.log('[market-universe] +' + added + ' instruments · ' + DB.stocks.length + ' listed');
      try { if (typeof render === 'function' && /#\/invest/.test(location.hash || '')) render(); } catch (e) {}
    }
    return true;
  }

  /* the app boots asynchronously (state sync, login) and a failed state pull
     can replace DB wholesale — so keep guarding the catalogue, not just at
     boot. merge() is cheap when everything is already present. */
  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    var d = null;
    try { d = DB; } catch (e) {}
    if (!d) return;
    var n = Array.isArray(d.stocks) ? d.stocks.length : 0;
    if (n < Math.min(300, CATALOG.length) || !d.stocks.some(function (s) { return String(s.ticker).toUpperCase() === 'WC'; })) {
      merge();
    }
    if (tries > 240) clearInterval(timer);
  }, 2000);
  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(merge, 0);
  window.WCMarketUniverse = { merge: merge, count: function () { return CATALOG.length; } };
})();
