/* =========================================================================
   WhaleChat · live price chart host  (wc-tv-widget)

   The TradingView iframe widget was removed in 3.56.0. Every B2B / stock chart
   host is now rendered by the app's own price-scale candle engine
   (WC_LIVE_CANDLES → Lightweight Charts v5), which draws from the WhaleChat
   live feed and can paint the entry / sell / admin-buy price lines that an
   iframe can never show.

   The module keeps its old public name (window.WC_TV) so the marketplace, the
   asset page and the buy ticket all keep working: mount() replaces the old
   embed script with the native chart, and symbol() still resolves the real
   exchange for the chart subtitle.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || window.__wcTvWidget) return;
  window.__wcTvWidget = true;
  var TV = window.WC_TV = window.WC_TV || {};
  var seq = 0;

  /* ticker → exchange:symbol (kept for labels/back-compat only) */
  var MAP = {
    TSLA: 'NASDAQ:TSLA', MSFT: 'NASDAQ:MSFT', GOOGL: 'NASDAQ:GOOGL', GOOG: 'NASDAQ:GOOG',
    AMZN: 'NASDAQ:AMZN', AAPL: 'NASDAQ:AAPL', NVDA: 'NASDAQ:NVDA', META: 'NASDAQ:META',
    NFLX: 'NASDAQ:NFLX', AMD: 'NASDAQ:AMD', SHOP: 'NYSE:SHOP', SPOT: 'NYSE:SPOT',
    SSNLF: 'OTC:SSNLF', SPACEX: 'NASDAQ:SPCX', SPCX: 'NASDAQ:SPCX',
    BTCUSDT: 'BINANCE:BTCUSDT', ETHUSDT: 'BINANCE:ETHUSDT', BNBUSDT: 'BINANCE:BNBUSDT',
    SOLUSDT: 'BINANCE:SOLUSDT', XRPUSDT: 'BINANCE:XRPUSDT', ADAUSDT: 'BINANCE:ADAUSDT',
    DOGEUSDT: 'BINANCE:DOGEUSDT', TRUMPUSDT: 'BINANCE:TRUMPUSDT'
  };

  TV.symbol = function (ticker, kind, exchange) {
    var t = String(ticker || '').toUpperCase().trim();
    if (!t) return '';
    if (t === 'WC') return 'WHALECHAT:WC';
    if (MAP[t]) return MAP[t];
    var k = String(kind || '').toLowerCase();
    if (/crypto|meme|usdt|coin/.test(k) || /USDT$/.test(t)) return 'BINANCE:' + t;
    if (/forex|currency/.test(k) || /^[A-Z]{6}$/.test(t)) return '';
    var ex = String(exchange || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (/^(NASDAQ|NYSE|AMEX|NYSEARCA|OTC|CBOE|BATS)$/.test(ex)) {
      if (ex === 'NYSEARCA') ex = 'AMEX';
      return ex + ':' + t;
    }
    return 'NASDAQ:' + t;
  };

  TV.symbolOnly = function (ticker) {
    var s = TV.symbol(ticker);
    return s ? s.split(':').pop() : String(ticker || '').toUpperCase();
  };

  function subtitle(ticker, kind, exchange) {
    var sym = TV.symbol(ticker, kind, exchange);
    var label = String(ticker || '').toUpperCase().replace('USDT', '/USDT');
    return (sym ? sym + ' · ' : '') + label + ' · live price action';
  }

  /* Replace the host contents with the native price-scale chart. The chart
     itself paints the entry, sell and admin-buy lines from the account state
     and follows every live tick, so a tapped stock re-renders in place. */
  TV.mount = function (host, ticker, kind, exchange) {
    if (!host) return;
    var t = String(ticker || '').toUpperCase();
    if (!t) return;
    var LC = (typeof window !== 'undefined') ? window.WC_LIVE_CANDLES : null;
    if (!LC || !LC.embed) {
      host.innerHTML = '<div class="wc-tv-note">The live candle chart is still loading. Pull to refresh if it does not appear.</div>';
      return;
    }
    try { if (LC.teardown) LC.teardown(host); } catch (e) {}
    host.innerHTML = LC.embed({ ticker: t, kind: kind || '', sub: subtitle(t, kind, exchange) });
    host.setAttribute('data-tv-symbol', TV.symbol(t, kind, exchange));
    try { LC.mountAll(host); } catch (e) {}
  };

  TV.html = function (ticker, kind, opts) {
    opts = opts || {};
    return '<div class="card wc-tv-card" style="margin-top:10px">' +
      '<div class="wc-tv-host" data-wc-tv="' + String(ticker || '').toUpperCase() + '" data-wc-tv-kind="' + String(kind || '') + '"></div>' +
    '</div>';
  };

  TV.mountAll = function (root) {
    (root || document).querySelectorAll('[data-wc-tv]').forEach(function (host) {
      var t = host.getAttribute('data-wc-tv');
      var k = host.getAttribute('data-wc-tv-kind');
      var ex = host.getAttribute('data-wc-tv-exchange');
      if (!t) return;
      /* a host that already carries this chart is left alone so background
         re-renders do not restart the live stream */
      if (host.getAttribute('data-tv-symbol') === TV.symbol(t, k, ex) && host.childElementCount) return;
      TV.mount(host, t, k, ex);
    });
  };

  var timer = null;
  function schedule() {
    if (timer) return;
    timer = setTimeout(function () { timer = null; try { TV.mountAll(); } catch (e) {} }, 150);
  }
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });

  /* keep the tap target free of a stray seq counter warning */
  TV.seq = function () { return ++seq; };
})();
