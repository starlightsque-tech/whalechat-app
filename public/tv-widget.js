/* =========================================================================
   WhaleChat · TradingView symbol-overview widget  (wc-tv-widget)

   Installed on the B2B-Investing stock trade views. The widget is only a
   renderer: the symbol is chosen by the page (marketplace card, asset page or
   the buy/sell ticket) and re-mounted when the user picks another stock, so the
   chart always shows that stock's real-time price and movement.

   The original React component is reproduced here as a framework-free module
   because the app bundle has no React runtime.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || window.__wcTvWidget) return;
  window.__wcTvWidget = true;
  var TV = window.WC_TV = window.WC_TV || {};
  var seq = 0;

  /* ticker → TradingView exchange:symbol */
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
    if (!t || t === 'WC') return '';
    if (MAP[t]) return MAP[t];
    var k = String(kind || '').toLowerCase();
    if (/crypto|meme|usdt|coin/.test(k) || /USDT$/.test(t)) return 'BINANCE:' + t;
    if (/forex|currency/.test(k) || /^[A-Z]{6}$/.test(t)) return '';
    /* use the listing's real exchange (NYSE/NASDAQ/OTC) — defaulting every
       stock to NASDAQ made 45 of the 140 catalogue symbols invalid on TradingView */
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
      '@media(max-width:520px){.wc-tv-box{height:360px}}'
    ].join('\n');
    document.head.appendChild(st);
  }

  TV.mount = function (host, ticker, kind, exchange) {
    if (!host) return;
    styles();
    var sym = TV.symbol(ticker, kind, exchange);
    host.innerHTML = '';
    if (!sym) {
      host.innerHTML = '<div class="wc-tv-note">TradingView does not publish this symbol. The WhaleChat live candle chart above is used instead.</div>';
      host.setAttribute('data-tv-symbol', '');
      return;
    }
    var id = 'wctv-' + (++seq);
    var wrap = document.createElement('div');
    wrap.className = 'wc-tv';
    wrap.innerHTML = '<div class="wc-tv-box" id="' + id + '">' +
        '<div class="tradingview-widget-container" style="height:100%;width:100%">' +
          '<div class="tradingview-widget-container__widget" style="height:100%;width:100%"></div>' +
        '</div>' +
      '</div>' +
      '<div class="wc-tv-copy"><a href="https://www.tradingview.com/markets/" rel="noopener nofollow" target="_blank"><span class="blue-text">World markets</span></a><span class="trademark">&nbsp;by TradingView</span></div>';
    host.appendChild(wrap);
    host.setAttribute('data-tv-symbol', sym);
    var container = wrap.querySelector('.tradingview-widget-container');
    var script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-symbol-overview.js';
    script.type = 'text/javascript';
    script.async = true;
    script.innerHTML = JSON.stringify(config(sym));
    container.appendChild(script);
  };

  TV.html = function (ticker, kind, opts) {
    opts = opts || {};
    var sym = TV.symbol(ticker, kind);
    var title = opts.title || 'Real-time chart';
    return '<div class="card wc-tv-card" style="margin-top:10px">' +
      '<div class="between" style="align-items:flex-start"><div><div class="card-title" style="margin:0">' + title + '</div>' +
      '<div class="tiny muted">' + (sym ? sym + ' · live price and movement' : 'WhaleChat live candle chart') + '</div></div></div>' +
      '<div class="wc-tv-host" data-wc-tv="' + String(ticker || '').toUpperCase() + '" data-wc-tv-kind="' + String(kind || '') + '"></div>' +
    '</div>';
  };

  TV.mountAll = function (root) {
    (root || document).querySelectorAll('[data-wc-tv]').forEach(function (host) {
      var t = host.getAttribute('data-wc-tv');
      var k = host.getAttribute('data-wc-tv-kind');
      var ex = host.getAttribute('data-wc-tv-exchange');
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
})();
