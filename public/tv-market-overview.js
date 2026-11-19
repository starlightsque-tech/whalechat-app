/* =========================================================================
   WhaleChat × TradingView — Market Overview widget
   -------------------------------------------------------------------------
   ONE shared TradingView market-overview widget for every trade view:
     · Stock trading dashboard      (#/invest)
     · Stock trade view             (#/invest/stock/<TICKER>)
     · Live trade dashboard         (#/invest live terminal)
     · B2B-Investing desk           (#/investment/b2b)
     · B2B buy / trade view         (#/investment/b2b/buy)

   TradingView ships this as a Web Component (closed shadow root):
       <script type="module"
               src="https://widgets.tradingview-widget.com/w/en/tv-market-overview.js">
       <tv-market-overview symbol-sectors='[…]' time-frame="ALL">
   The script is loaded once, lazily, the first time a card scrolls into view.
   The widget is re-mounted after every SPA re-render (the app replaces #app).

   Public API
     WC_TV_OVERVIEW.card(opts)   -> card markup with a mount placeholder
     WC_TV_OVERVIEW.mountAll()   -> mount every placeholder currently in the DOM
     WC_TV_OVERVIEW.sections     -> the symbol configuration sent to the widget
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__wcTvOverview) return;
  window.__wcTvOverview = true;

  var TV = (window.WC_TV_OVERVIEW = window.WC_TV_OVERVIEW || {});
  var SCRIPT_SRC = 'https://widgets.tradingview-widget.com/w/en/tv-market-overview.js';
  var TAG = 'tv-market-overview';

  /* ------------------------------------------------------------------------
     Symbol configuration — every instrument from the desk's market-overview
     config, grouped into tabs so the board stays compact instead of one
     endless list.

     Two clean-ups were applied to the original config:
       · duplicate entries removed (FX:XAUUSD ×2, CRYPTO:BTCUSD ×3, …)
       · symbols TradingView will not stream in an embedded widget replaced by
         a widget-supported equivalent, or dropped when the desk already lists
         the same market through another provider:
           SP:SPX            → dropped (FOREXCOM:SPXUSD already listed)
           CME_MINI:ES1!/MES1!/NQ1!/MNQ1! → dropped (index proxies already listed)
           COMEX:GC1!/MGC1!  → dropped (TVC:GOLD + OANDA:XAUUSD already listed)
           CME:6E1!          → dropped (EURUSD pairs already listed)
           TVC:DXY           → CAPITALCOM:DXY
           TVC:VIX           → AMEX:VXX
           NSE:NIFTY         → BSE:SENSEX
     ---------------------------------------------------------------------- */
  TV.sections = [
    {
      sectionName: 'Indices',
      symbols: ['FOREXCOM:SPXUSD', 'FOREXCOM:NSXUSD', 'FOREXCOM:DJI', 'FOREXCOM:UKXGBP',
        'CAPITALCOM:NAS100', 'CAPITALCOM:DXY', 'AMEX:VXX', 'BSE:SENSEX',
        'TVC:GOLD', 'TVC:SILVER']
    },
    {
      sectionName: 'Stocks',
      symbols: ['AMEX:SPY', 'NASDAQ:QQQ', 'NASDAQ:AAPL', 'NASDAQ:TSLA', 'NASDAQ:AMD',
        'NASDAQ:MU', 'NASDAQ:MSFT', 'NASDAQ:META', 'NASDAQ:GOOGL', 'NASDAQ:SPCX']
    },
    {
      sectionName: 'Crypto',
      symbols: ['BINANCE:BTCUSDT', 'BITSTAMP:BTCUSD', 'CRYPTO:BTCUSD', 'BINANCE:BTCUSDT.P',
        'BINANCE:ETHUSDT', 'COINBASE:ETHUSD', 'BINANCE:SOLUSDT', 'COINBASE:SOLUSD',
        'BINANCE:XRPUSDT', 'CRYPTOCAP:USDT.D', 'CRYPTOCAP:BTC.D', 'CRYPTOCAP:TOTAL',
        'BINANCE:BNBUSDT', 'BINANCE:NEARUSDT', 'BINANCE:AVAXUSDT', 'BINANCE:SUIUSDT',
        'BINANCE:HYPEUSDT.P', 'BINANCE:ZECUSDT.P', 'BINANCE:SOXLUSDT.P',
        'BINANCE:PIEVERSEUSDT.P', 'BINANCE:STRY', 'BINANCE:BLESSUSDT.P',
        'OKX:PIEUR', 'MEXC:BTCUSDT', 'PYTH:COIN']
    },
    {
      sectionName: 'FX',
      symbols: ['OANDA:EURUSD', 'PEPPERSTONE:EURUSD', 'TICKMILL:EURUSD',
        'FX:GBPUSD', 'OANDA:GBPUSD', 'FX:USDJPY', 'OANDA:CADJPY', 'OANDA:GBPJPY',
        'FX:NZDUSD', 'FX:AUDJPY', 'FX:GBPNZD', 'FX_IDC:USDBRL',
        'FX:XAUUSD', 'OANDA:XAUUSD', 'PEPPERSTONE:XAUUSD']
    },
    {
      sectionName: 'B3',
      symbols: ['BMFBOVESPA:BBAS3', 'BMFBOVESPA:PETR4', 'BMFBOVESPA:VALE3',
        'BMFBOVESPA:ITUB4', 'BMFBOVESPA:BBDC4', 'BMFBOVESPA:BBDC3', 'BMFBOVESPA:MGLU3',
        'BMFBOVESPA:BBSE3', 'BMFBOVESPA:ITSA4', 'BMFBOVESPA:WEGE3', 'BMFBOVESPA:B3SA3',
        'BMFBOVESPA:PRIO3', 'BMFBOVESPA:CXSE3', 'BMFBOVESPA:NVDC34', 'BMFBOVESPA:EMBJ3',
        'BMFBOVESPA:AXIA3', 'BMFBOVESPA:CMIG4', 'BMFBOVESPA:SUZB3', 'BMFBOVESPA:BEEF3',
        'BMFBOVESPA:PSSA3', 'BMFBOVESPA:VIVT3', 'BMFBOVESPA:KLBN4', 'BMFBOVESPA:OBTC3',
        'BMFBOVESPA:BRAV3', 'BMFBOVESPA:NATU3', 'BMFBOVESPA:UNIP6', 'BMFBOVESPA:EZTC3',
        'BMFBOVESPA:PGMN3']
    }
  ];
  TV.timeframe = 'ALL';
  TV.symbolCount = TV.sections.reduce(function (n, s) { return n + s.symbols.length; }, 0);

  /* ---------------------------------------------------------------- styles */
  function ensureStyles() {
    if (document.getElementById('wc-tv-style')) return;
    var st = document.createElement('style');
    st.id = 'wc-tv-style';
    st.textContent = [
      '.wc-tv-card{position:relative;z-index:2;padding:12px}',
      '.wc-tv-card .wc-tv-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:8px}',
      '.wc-tv-card .wc-tv-title{font-family:var(--display,"Sora",sans-serif);font-weight:700;font-size:14px;letter-spacing:-.01em}',
      '.wc-tv-card .wc-tv-sub{font-size:10.5px;color:var(--muted,#8ba4b6);margin-top:1px}',
      '.wc-tv-card .wc-tv-badge{display:inline-block;flex:0 0 auto;align-self:flex-start;width:auto;',
      '  font-size:9px;font-weight:800;letter-spacing:.09em;color:#2ee6c9;line-height:1.5;',
      '  border:1px solid rgba(46,230,201,.35);border-radius:999px;padding:3px 8px;white-space:nowrap}',
      '.wc-tv-body{position:relative;border-radius:12px;overflow:auto;overscroll-behavior:contain;',
      '  -webkit-overflow-scrolling:touch;max-height:min(78vh,640px);min-height:380px;background:#07090e;',
      '  border:1px solid var(--border,rgba(255,255,255,.08));color-scheme:dark}',
      '.wc-tv-body ' + TAG + '{display:block;width:100%;min-width:300px}',
      '.wc-tv-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;',
      '  font-size:12px;color:#8ba4b6;background:#07090e;z-index:1;text-align:center;padding:16px}',
      '.wc-tv-fail{position:absolute;inset:0;display:flex;flex-direction:column;gap:6px;align-items:center;',
      '  justify-content:center;text-align:center;padding:18px;font-size:12px;color:#8ba4b6;background:#07090e}',
      '.wc-tv-fail a{color:#2ee6c9;text-decoration:none;font-weight:600}',
      /* TradingView design tokens tuned to the WhaleChat dark deck */
      '.wc-tv-body{--tv-widget-font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
      '  --tv-widget-background-color:#07090e;--tv-widget-text-color:#e9f4f9;',
      '  --tv-widget-accent-color:#2ee6c9;--tv-widget-price-text-color:#e9f4f9;',
      '  --tv-widget-positive-color:#22c55e;--tv-widget-negative-color:#ef4444;',
      '  --tv-widget-scales-font-color:#8ba4b6;--tv-widget-popup-background-color:#0b1520;',
      '  --tv-widget-tooltip-background-color:#0b1520;--tv-widget-tooltip-text-color:#e9f4f9}',
      '.wc-tv-note{font-size:10px;color:var(--muted,#8ba4b6);margin-top:6px;text-align:center}',
      '@media(max-width:520px){.wc-tv-body{max-height:70vh;min-height:340px}.wc-tv-card{padding:10px}}'
    ].join('\n');
    document.head.appendChild(st);
  }

  /* --------------------------------------------------------------- markup */
  var seq = 0;
  TV.card = function (opts) {
    opts = opts || {};
    ensureStyles();
    var uid = 'wc-tv-' + (++seq);
    return '<section class="card wc-tv-card" data-wc-tv-card>' +
      '<div class="wc-tv-head">' +
        '<div>' +
          '<div class="wc-tv-title">' + (opts.title || 'Market overview') + '</div>' +
          '<div class="wc-tv-sub">' + (opts.sub || ('Live ' + TV.symbolCount + ' instruments · TradingView')) + '</div>' +
        '</div>' +
        '<span class="wc-tv-badge">TRADINGVIEW</span>' +
      '</div>' +
      '<div class="wc-tv-body" data-wc-tv-overview="' + uid + '" data-wc-tv-state="pending">' +
        '<div class="wc-tv-loading">Loading live market overview…</div>' +
      '</div>' +
    '</section>';
  };

  /* ----------------------------------------------------------- script load */
  var scriptPromise = null;
  function loadScript() {
    if (scriptPromise) return scriptPromise;
    scriptPromise = new Promise(function (resolve, reject) {
      if (window.customElements && window.customElements.get(TAG)) return resolve(true);
      var existing = document.querySelector('script[data-wc-tv-src]');
      var s = existing || document.createElement('script');
      if (!existing) {
        s.type = 'module';
        s.async = true;
        s.src = SCRIPT_SRC;
        s.setAttribute('data-wc-tv-src', '1');
      }
      s.addEventListener('load', function () { resolve(true); });
      s.addEventListener('error', function () { reject(new Error('TradingView widget script failed to load')); });
      if (!existing) document.head.appendChild(s);
    });
    return scriptPromise;
  }

  function fail(body, err) {
    body.setAttribute('data-wc-tv-state', 'failed');
    body.innerHTML = '<div class="wc-tv-fail"><b>Live market overview unavailable</b>' +
      '<span>The TradingView widget could not be loaded' + (err && err.message ? ' (' + String(err.message).slice(0, 80) + ')' : '') + '.</span>' +
      '<a href="https://www.tradingview.com/markets/" target="_blank" rel="noopener">Open TradingView markets →</a></div>';
  }

  /* ---------------------------------------------------------------- mount */
  var configured = false;
  function buildWidget() {
    var el = document.createElement(TAG);
    el.setAttribute('theme', 'dark');
    el.setAttribute('time-frame', TV.timeframe);
    try { el.setAttribute('symbol-sectors', JSON.stringify(TV.sections)); } catch (e) {}
    el.style.display = 'block';
    el.style.width = '100%';
    return el;
  }

  function mount(body) {
    if (!body || !document.body.contains(body)) return;
    if (body.getAttribute('data-wc-tv-state') === 'mounted' || body.getAttribute('data-wc-tv-state') === 'mounting') return;
    body.setAttribute('data-wc-tv-state', 'mounting');
    loadScript().then(function () {
      function attach() {
        if (!document.body.contains(body)) return;
        var old = body.querySelector(TAG);
        if (old) old.remove();
        configured = true;
        body.appendChild(buildWidget());
        body.setAttribute('data-wc-tv-state', 'mounted');
        var loading = body.querySelector('.wc-tv-loading');
        if (loading) loading.remove();
      }
      if (window.customElements && window.customElements.get(TAG)) return attach();
      if (window.customElements && window.customElements.whenDefined) {
        window.customElements.whenDefined(TAG).then(attach).catch(function (e) { fail(body, e); });
        /* safety net: some browsers resolve whenDefined late after a cached hit */
        setTimeout(function () {
          if (body.getAttribute('data-wc-tv-state') === 'mounting') attach();
        }, 6000);
      } else attach();
    }).catch(function (e) { fail(body, e); });
  }

  /* Only pay for the widget when the card is actually near the viewport. */
  var io = null;
  function observe(body) {
    if (!('IntersectionObserver' in window)) return mount(body);
    if (!io) {
      io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) {
            io.unobserve(en.target);
            mount(en.target);
          }
        });
      }, { rootMargin: '250px 0px' });
    }
    io.observe(body);
  }

  TV.mountAll = function (root) {
    var scope = root && root.querySelectorAll ? root : document;
    var nodes = scope.querySelectorAll('[data-wc-tv-overview]');
    for (var i = 0; i < nodes.length; i++) {
      var body = nodes[i];
      if (body.getAttribute('data-wc-tv-state') === 'pending') {
        body.setAttribute('data-wc-tv-state', 'queued');
        observe(body);
      }
    }
  };

  /* ------------------------------------------------------ SPA re-rendering */
  var timer = null;
  function schedule() {
    if (timer) return;
    timer = setTimeout(function () { timer = null; TV.mountAll(); }, 120);
  }

  function boot() {
    ensureStyles();
    TV.mountAll();
    var root = document.getElementById('app') || document.body;
    if (root && window.MutationObserver) {
      new MutationObserver(schedule).observe(root, { childList: true, subtree: true });
    }
    window.addEventListener('hashchange', schedule);
    /* pre-warm the script once the app is idle so the first card feels instant */
    var warm = function () { loadScript().catch(function () {}); };
    if ('requestIdleCallback' in window) window.requestIdleCallback(warm, { timeout: 6000 });
    else setTimeout(warm, 3000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
