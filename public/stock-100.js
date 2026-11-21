/* =========================================================================
   WhaleChat 100-stock catalogue  (wc-stock-100)

   Adds the shared 100-stock universe to the synced catalogue once, so every
   surface that reads INV.stocks() — Market, stock lists, Stock trading,
   portfolio and the B2B desk — offers the same 100 instruments. Existing
   symbols (and any admin-added ones) are never touched or duplicated.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  if (window.__wcStock100) return;
  window.__wcStock100 = true;

  function hash(s) {
    var h = 0;
    s = String(s || '');
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100000;
    return h;
  }

  function seed() {
    try {
      if (typeof DB === 'undefined' || !DB) return false;
      var universe = window.WC_STOCK_UNIVERSE || [];
      if (!universe.length) return false;
      if (!Array.isArray(DB.stocks)) DB.stocks = [];
      var have = new Set(DB.stocks.map(function (s) { return s && String(s.ticker).toUpperCase(); }));
      var added = 0;
      universe.forEach(function (a) {
        var ticker = String(a.t).toUpperCase();
        if (have.has(ticker)) return;
        var base = 18 + (hash(ticker) % 48000) / 100;   /* believable seed, replaced by the live feed */
        base = Math.round(base * 100) / 100;
        DB.stocks.push({
          id: 'st_' + ticker.toLowerCase().replace(/[^a-z0-9]/g, ''),
          ticker: ticker,
          displayTicker: ticker.replace('_', '.'),
          finnhubSymbol: ticker.replace('_', '.'),
          assetClass: 'us',
          name: a.name || ticker,
          exchange: 'US',
          currency: 'USD',
          sector: a.sector || 'Stock',
          color: a.c || '#2ee6c9',
          price: base,
          prevClose: base,
          open: base,
          dayHigh: base,
          dayLow: base,
          vol: 1000 + (hash(ticker) % 90000),
          div: 0,
          paused: false,
          custom: false,
          crypto: false,
          createdAt: Date.now()
        });
        have.add(ticker);
        added++;
      });
      if (added) {
        console.log('[stock-100] catalogue expanded by', added, 'stocks');
        try { if (typeof persist === 'function') persist(true); } catch (e) {}
        try { if (typeof sync === 'function') sync(); } catch (e) {}
        try { if (typeof render === 'function') render(); } catch (e) {}
      }
      return true;
    } catch (e) { return false; }
  }

  if (!seed()) {
    var tries = 0;
    var t = setInterval(function () {
      if (seed() || ++tries > 40) clearInterval(t);
    }, 500);
  }
  window.addEventListener('load', seed);
  window.addEventListener('hashchange', function () { setTimeout(seed, 300); });
})();
