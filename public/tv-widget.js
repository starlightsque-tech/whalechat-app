/* =========================================================================
   WhaleChat · TradingView live chart + entry marker  (wc-tv-widget)

   Restored 3.56.1: the B2B marketplace, asset page and buy ticket use the
   TradingView symbol-overview widget from the supplied install code (the chart
   in the reference screenshot). The native candle chart is now only the
   fallback for symbols TradingView does not publish (the WhaleChat company
   stock, SpaceX), so those still show live price movement.

   TradingView runs in a cross-origin iframe, so a price line cannot be drawn
   inside it. The user's entry is therefore rendered as a live entry strip
   directly above the widget: entry price, current price and live P/L, kept in
   sync with the WhaleChat feed every 2 seconds.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || window.__wcTvWidget) return;
  window.__wcTvWidget = true;
  var TV = window.WC_TV = window.WC_TV || {};
  var seq = 0;

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
    if (!t || t === 'WC' || t === 'SPACEX') return '';
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

  function config(sym) {
    return {
      lineWidth: 2,
      lineType: 0,
      chartType: 'candlesticks',
      showVolume: true,
      fontColor: 'rgb(106, 109, 120)',
      gridLineColor: 'rgba(46, 46, 46, 0.06)',
      volumeUpColor: 'rgba(34, 171, 148, 0.5)',
      volumeDownColor: 'rgba(247, 82, 95, 0.5)',
      backgroundColor: '#ffffff',
      widgetFontColor: '#0F0F0F',
      upColor: '#22ab94',
      downColor: '#f7525f',
      borderUpColor: '#22ab94',
      borderDownColor: '#f7525f',
      wickUpColor: '#22ab94',
      wickDownColor: '#f7525f',
      colorTheme: 'light',
      isTransparent: false,
      locale: 'en',
      chartOnly: false,
      scalePosition: 'right',
      scaleMode: 'Normal',
      fontFamily: '-apple-system, BlinkMacSystemFont, Trebuchet MS, Roboto, Ubuntu, sans-serif',
      valuesTracking: '1',
      changeMode: 'price-and-percent',
      symbols: [[sym + '|1D']],
      dateRanges: ['1d|1', '1m|30', '3m|60', '12m|1D', '60m|1W', 'all|1M'],
      fontSize: '10',
      headerFontSize: 'medium',
      autosize: true,
      lineColor: 'rgba(41, 98, 255, 1)',
      topColor: 'rgba(76, 175, 80, 1)',
      bottomColor: 'rgba(242, 54, 69, 1)',
      width: '100%',
      height: '100%',
      noTimeScale: false,
      hideDateRanges: false,
      showMA: true,
      maLength: 9,
      maLineColor: '#2962FF',
      maLineWidth: 1,
      hideMarketStatus: false,
      hideSymbolLogo: false
    };
  }

  function styles() {
    if (document.getElementById('wc-tv-style')) return;
    var st = document.createElement('style');
    st.id = 'wc-tv-style';
    st.textContent = [
      '.wc-tv{width:100%;min-width:0}',
      '.wc-tv-box{position:relative;width:100%;height:420px;background:#fff;border:1px solid #E3E9EC;border-radius:12px;overflow:hidden}',
      '.wc-tv-box .tradingview-widget-container{height:100%;width:100%}',
      '.wc-tv-box .tradingview-widget-container__widget{height:100%;width:100%}',
      '.wc-tv-copy{font-size:9.5px;color:#8ba4b6;padding:6px 2px 0;text-align:right}',
      '.wc-tv-copy a{color:#2962FF;text-decoration:none}',
      '.wc-tv-note{font-size:10.5px;color:#8ba4b6;padding:10px}',
      '.wc-tv-entry{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;margin-bottom:8px;',
      '  border:1px solid #E3E9EC;border-radius:10px;background:#F7FAFB;font-size:11px;line-height:1.3}',
      '.wc-tv-entry b{font-variant-numeric:tabular-nums}',
      '.wc-tv-entry .lbl{font-size:8.5px;letter-spacing:.05em;text-transform:uppercase;color:#8ba4b6;font-weight:800;display:block}',
      '.wc-tv-entry .up{color:#0f9d6b}.wc-tv-entry .down{color:#e11d48}',
      '.wc-tv-entry .sep{width:1px;height:24px;background:#E3E9EC}',
      '.wc-tv-entry .muted{color:#8ba4b6}',
      '.wc-tv-live{display:inline-flex;align-items:center;gap:4px;font-size:8px;font-weight:800;letter-spacing:.08em;',
      '  color:#0f9d6b;border:1px solid rgba(15,157,107,.4);border-radius:999px;padding:2px 6px;background:rgba(15,157,107,.07)}',
      '.wc-tv-live i{width:5px;height:5px;border-radius:50%;background:#0f9d6b;animation:wcTvPulse 1.6s ease-in-out infinite}',
      '@keyframes wcTvPulse{0%,100%{opacity:1}50%{opacity:.25}}',
      '@media(max-width:520px){.wc-tv-box{height:320px}.wc-tv-entry{font-size:10.5px;gap:6px}.wc-tv-entry .sep{display:none}}'
    ].join('\n');
    document.head.appendChild(st);
  }

  function money(v) {
    v = Number(v) || 0;
    var d = Math.abs(v) >= 1000 ? 2 : Math.abs(v) >= 1 ? 2 : 4;
    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function me2() { try { return me(); } catch (e) { return null; } }
  function priceOf(t) {
    try { var q = INV.quote(t); if (q && Number(q.price) > 0) return Number(q.price); } catch (e) {}
    try { if (INV.live && INV.live[t] && Number(INV.live[t].price) > 0) return Number(INV.live[t].price); } catch (e) {}
    return 0;
  }
  function entryOf(t) {
    var u = me2();
    try {
      var h = u && u.investAcct && u.investAcct.b2b && u.investAcct.b2b[t];
      if (h && Number(h.units) > 0 && Number(h.avgPrice) > 0) {
        return { entry: Number(h.avgPrice), units: Number(h.units), source: 'B2B holding' };
      }
    } catch (e) {}
    try {
      if (typeof LT !== 'undefined' && LT && LT.open) {
        var p = (LT.open(u && u.id) || []).filter(function (x) { return x.ticker === t; })[0];
        if (p && Number(p.entryPrice) > 0) return { entry: Number(p.entryPrice), units: Number(p.qty) || 0, source: 'open trade' };
      }
    } catch (e) {}
    return null;
  }

  function paintEntry(host, t) {
    var el = host.querySelector('[data-wc-tv-entry]');
    if (!el) return;
    var e = entryOf(t);
    var px = priceOf(t);
    if (!e) {
      el.innerHTML = '<span class="lbl">Your entry</span><b class="muted">No position yet</b>' +
        '<span class="sep"></span><span class="muted">Buy this asset and your entry price appears here live.</span>';
      return;
    }
    var pl = (px > 0 ? px - e.entry : 0) * (e.units || 0);
    var pct = e.entry > 0 && px > 0 ? ((px - e.entry) / e.entry) * 100 : 0;
    el.innerHTML = '<span><span class="lbl">Your entry · ' + e.source + '</span><b>' + money(e.entry) + '</b></span>' +
      '<span class="sep"></span><span><span class="lbl">Live price</span><b>' + (px > 0 ? money(px) : '—') + '</b></span>' +
      '<span class="sep"></span><span><span class="lbl">P/L</span><b class="' + (pl >= 0 ? 'up' : 'down') + '">' +
      (pl >= 0 ? '+' : '−') + money(Math.abs(pl)) + ' (' + (pct >= 0 ? '+' : '−') + Math.abs(pct).toFixed(2) + '%)</b></span>' +
      '<span class="sep"></span><span class="wc-tv-live"><i></i>LIVE</span>';
  }

  function stopTimer(host) {
    if (host && host.__tvTimer) { clearInterval(host.__tvTimer); host.__tvTimer = null; }
  }

  /* Native fallback for symbols TradingView does not publish (WC, SpaceX). */
  function mountNative(host, t, kind, exchange) {
    var LC = window.WC_LIVE_CANDLES;
    if (!LC || !LC.embed) {
      host.innerHTML = '<div class="wc-tv-note">Chart is still loading. Refresh if it does not appear.</div>';
      return;
    }
    try { if (LC.teardown) LC.teardown(host); } catch (e) {}
    host.innerHTML = LC.embed({ ticker: t, kind: kind || '', sub: String(t).replace('USDT', '/USDT') + ' · live price action' });
    try { LC.mountAll(host); } catch (e) {}
    host.setAttribute('data-tv-symbol', 'native:' + t);
  }

  TV.mount = function (host, ticker, kind, exchange) {
    if (!host) return;
    styles();
    var t = String(ticker || '').toUpperCase();
    if (!t) return;
    stopTimer(host);
    try { if (window.WC_LIVE_CANDLES && WC_LIVE_CANDLES.teardown) WC_LIVE_CANDLES.teardown(host); } catch (e) {}
    var sym = TV.symbol(t, kind, exchange);
    if (!sym) { mountNative(host, t, kind, exchange); return; }

    var id = 'wctv-' + (++seq);
    host.innerHTML = '<div class="wc-tv-entry" data-wc-tv-entry></div>' +
      '<div class="wc-tv">' +
        '<div class="wc-tv-box" id="' + id + '">' +
          '<div class="tradingview-widget-container" style="height:100%;width:100%">' +
            '<div class="tradingview-widget-container__widget" style="height:100%;width:100%"></div>' +
          '</div>' +
        '</div>' +
        '<div class="wc-tv-copy"><a href="https://www.tradingview.com/markets/" rel="noopener nofollow" target="_blank"><span class="blue-text">World markets</span></a><span class="trademark">&nbsp;by TradingView</span></div>' +
      '</div>';
    host.setAttribute('data-tv-symbol', sym);
    paintEntry(host, t);
    host.__tvTimer = setInterval(function () {
      if (!document.body.contains(host)) { stopTimer(host); return; }
      paintEntry(host, t);
    }, 2000);

    var container = host.querySelector('.tradingview-widget-container');
    var script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-symbol-overview.js';
    script.type = 'text/javascript';
    script.async = true;
    script.innerHTML = JSON.stringify(config(sym));
    container.appendChild(script);

    /* If the embed is blocked or fails, keep the page useful with the native chart. */
    setTimeout(function () {
      if (!document.body.contains(host)) return;
      if (!host.querySelector('iframe')) mountNative(host, t, kind, exchange);
    }, 9000);
  };

  TV.html = function (ticker, kind) {
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
      var want = TV.symbol(t, k, ex) || ('native:' + t);
      if (host.getAttribute('data-tv-symbol') === want && host.childElementCount) return;
      TV.mount(host, t, k, ex);
    });
  };

  var timer = null;
  function schedule() {
    if (timer) return;
    timer = setTimeout(function () { timer = null; try { TV.mountAll(); } catch (e) {} }, 150);
  }
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
})();
