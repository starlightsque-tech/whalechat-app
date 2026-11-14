/* =========================================================================
   WhaleChat Pro Chart — TradingView Lightweight Charts v5 (5.3.0)
   Used for BOTH the stock trading view and the portfolio equity curve.

   - v5 API only: chart.addSeries(CandlestickSeries | BaselineSeries | AreaSeries, …)
     createSeriesMarkers(series, markers), series.createPriceLine(…)
   - ResizeObserver + full teardown (chart.remove()) on unmount
   - Neon glass UI: obsidian canvas, cyan/magenta series, glassmorphic HUD,
     entry / TP / SL price lines, BUY/SELL execution markers
   - Live tick engine: pushTick({ time, price, volume }) from any WebSocket,
     plus an internal mock generator (500–1000 ms) until real ticks arrive
   - Timeframes 1m / 5m / 15m / 1H / 1D / ALL, and Price ↔ Portfolio switch
   - Buy / Sell buttons pinned to the chart
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;

  const LWC_VERSION = '5.3.0';
  const LWC_URL = 'https://unpkg.com/lightweight-charts@' + LWC_VERSION + '/dist/lightweight-charts.standalone.production.js';
  const CYAN = '#00F5D4';
  const MAGENTA = '#FF2A85';
  const OBSIDIAN = '#07090E';

  /* timeframe table: bucket seconds + lookback window (ms) */
  const TF = {
    '1m': { bucket: 60, back: 6 * 3600e3, limit: 900 },
    '5m': { bucket: 300, back: 2 * 864e5, limit: 900 },
    '15m': { bucket: 900, back: 7 * 864e5, limit: 900 },
    '1H': { bucket: 3600, back: 30 * 864e5, limit: 900 },
    '1D': { bucket: 86400, back: 365 * 864e5, limit: 900 },
    'ALL': { bucket: 604800, back: 5 * 365 * 864e5, limit: 900 }
  };

  const PC = (window.WC_PRO_CHART = window.WC_PRO_CHART || {});
  PC.version = LWC_VERSION;
  /* The stock trading view stays on the Finnhub price chart (market-live.js).
     Pro-chart is only used for equity/ROI curves (portfolio, plans, bots). */
  PC.disableStock = true;
  PC.mock = true;              /* mock ticks while no real movement arrives */
  PC.instances = PC.instances || [];

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const usd = (v) => '$' + (Number(v) || 0).toFixed(2);
  const pct = (v) => (v >= 0 ? '+' : '−') + Math.abs(Number(v) || 0).toFixed(2) + '%';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function loadLWC() {
    if (window.LightweightCharts && window.LightweightCharts.createChart) return Promise.resolve(window.LightweightCharts);
    if (PC._lwc) return PC._lwc;
    PC._lwc = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = LWC_URL;
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.onload = () => window.LightweightCharts ? resolve(window.LightweightCharts) : reject(new Error('lightweight-charts v5 failed to initialise'));
      s.onerror = () => reject(new Error('Could not load lightweight-charts v5'));
      document.head.appendChild(s);
    });
    return PC._lwc;
  }

  function apiPath(p) {
    try { if (typeof Remote !== 'undefined' && Remote && Remote.enabled) return Remote.url(p); } catch (e) {}
    return p;
  }
  async function getJSON(pathname, timeout) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout || 12000);
    try {
      const res = await fetch(apiPath(pathname), { signal: ctrl.signal, headers: { 'content-type': 'application/json' } });
      return await res.json().catch(() => null);
    } finally { clearTimeout(timer); }
  }
  async function postJSON(pathname, body, timeout) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout || 25000);
    try {
      const res = await fetch(apiPath(pathname), {
        method: 'POST', signal: ctrl.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(() => null);
      return { res, data };
    } finally { clearTimeout(timer); }
  }
  function meId() { try { return me().id; } catch (e) { return ''; } }
  function holding(ticker) { try { return INV.holding(ticker, meId()); } catch (e) { return null; } }
  function quote(ticker) { try { return INV.quote(ticker); } catch (e) { return null; } }
  function toast(msg, type) { if (typeof window.toast === 'function') window.toast(msg, type || 'ok'); }

  function symbolLabel(ticker) {
    let ex = '';
    try { ex = String((INV.stock(ticker) || {}).exchange || '').toUpperCase(); } catch (e) {}
    const known = { NASDAQ: 'NASDAQ', NYSE: 'NYSE', AMEX: 'AMEX', ARCA: 'AMEX', BATS: 'BATS', OTC: 'OTC' };
    return (known[ex] || 'NASDAQ') + ':' + String(ticker).toUpperCase();
  }
  function mapPortfolioTf(tf) {
    return ({ '1m': '1D', '5m': '1D', '15m': '1D', '1H': '1W', '1D': '1M', 'ALL': 'ALL' })[tf] || '1M';
  }

  /* ------------------------------ data layer ------------------------------ */
  const histCache = new Map();
  async function stockHistory(ticker, tfKey, force) {
    const key = ticker + '|' + tfKey;
    const hit = histCache.get(key);
    if (!force && hit && Date.now() - hit.at < 30000) return hit.points;
    try {
      const d = await getJSON('/api/market/history?tickers=' + encodeURIComponent(ticker) + '&limit=' + (TF[tfKey] || TF['1D']).limit, 12000);
      const raw = (d && d.history && d.history[ticker]) || [];
      let points = raw.map((p) => ({ time: Math.floor((Number(p.t) || 0) / 1000), value: Number(p.p) || 0 }))
        .filter((p) => p.time > 0 && p.value > 0);
      if (!points.length) {
        /* offline/demo fallback: synthesise a realistic walk ending at the live quote */
        const q = quote(ticker);
        const last = q && q.price > 0 ? Number(q.price) : 100;
        const now = Math.floor(Date.now() / 1000);
        points = Array.from({ length: 180 }, (_, i) => ({
          time: now - (179 - i) * 60,
          value: last * (1 + Math.sin(i / 9) * 0.004 + (Math.random() - 0.5) * 0.003)
        }));
      }
      const win = (TF[tfKey] || TF['1D']).back / 1000;
      const cut = Math.floor(Date.now() / 1000) - win;
      const trimmed = points.filter((p) => p.time >= cut);
      const out = (trimmed.length > 30 ? trimmed : points).slice(-900);
      histCache.set(key, { at: Date.now(), points: out });
      return out;
    } catch (e) { return hit ? hit.points : []; }
  }

  function toCandles(points, bucketSec) {
    const map = new Map();
    for (const p of points) {
      const t = Math.floor(p.time / bucketSec) * bucketSec;
      const c = map.get(t);
      if (!c) map.set(t, { time: t, open: p.value, high: p.value, low: p.value, close: p.value });
      else { c.high = Math.max(c.high, p.value); c.low = Math.min(c.low, p.value); c.close = p.value; }
    }
    return Array.from(map.values()).sort((a, b) => a.time - b.time);
  }

  function portfolioPoints(tfKey) {
    const uid = meId();
    let vals = [];
    try {
      const ptf = mapPortfolioTf(tfKey);
      vals = (typeof LT !== 'undefined' && LT.seriesWithTrades) ? (LT.seriesWithTrades(ptf, uid) || []) : [];
      if (!vals.length && typeof INV !== 'undefined' && INV.portfolioSeries) vals = INV.portfolioSeries(ptf, uid) || [];
    } catch (e) { vals = []; }
    if (!vals.length) return [];
    const spanMs = Math.max(3600e3, (TF[tfKey] || TF['1D']).back);
    const now = Date.now();
    const step = spanMs / Math.max(1, vals.length - 1);
    return vals.map((v, i) => ({ time: Math.floor((now - (vals.length - 1 - i) * step) / 1000), value: Number(v) || 0 }));
  }

  function tradeMarkers(ticker, fromTime, toTime) {
    const out = [];
    let trades = [];
    try { trades = (DB.trades || []).filter((t) => String(t.ticker).toUpperCase() === ticker); } catch (e) {}
    for (const t of trades) {
      const time = Math.floor((Number(t.createdAt) || 0) / 1000);
      if (!time || time < fromTime || time > toTime) continue;
      const buy = String(t.side).toLowerCase() === 'buy';
      const price = Number(t.priceUsd) || 0;
      const qty = Number(t.shares) || 0;
      out.push({
        time,
        position: buy ? 'belowBar' : 'aboveBar',
        color: buy ? CYAN : MAGENTA,
        shape: buy ? 'arrowUp' : 'arrowDown',
        text: (buy ? 'BUY ' : 'SELL ') + qty.toLocaleString(undefined, { maximumFractionDigits: 4 }) + ' @ ' + usd(price)
      });
    }
    return out.sort((a, b) => a.time - b.time);
  }

  /* ------------------------------ styles --------------------------------- */
  function injectStyles() {
    if (document.getElementById('wc-pro-chart-style')) return;
    const st = document.createElement('style');
    st.id = 'wc-pro-chart-style';
    st.textContent = `
    .pc-wrap{position:relative;width:100%;height:100%;min-height:320px;border-radius:14px;overflow:hidden;
      background:radial-gradient(120% 90% at 10% 0%,rgba(0,245,212,.06),transparent 55%),
                 radial-gradient(120% 90% at 90% 100%,rgba(255,42,133,.05),transparent 55%),#07090E;
      border:1px solid rgba(255,255,255,.08)}
    .pc-canvas{position:absolute;inset:0}
    .pc-hud{position:absolute;left:10px;top:10px;z-index:6;min-width:196px;padding:10px 12px;border-radius:12px;
      background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.10);
      -webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);
      box-shadow:0 18px 40px rgba(0,0,0,.45);pointer-events:none;
      font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace}
    .pc-sym{display:flex;align-items:center;gap:6px;font-size:10px;letter-spacing:.08em;color:#9AA6BF}
    .pc-dot{width:6px;height:6px;border-radius:50%;background:#00F5D4;box-shadow:0 0 0 3px rgba(0,245,212,.16);
      animation:pcPulse 1.4s ease-in-out infinite}
    @keyframes pcPulse{0%,100%{opacity:.45;transform:scale(.85)}50%{opacity:1;transform:scale(1.1)}}
    .pc-price{margin-top:3px;font-size:24px;font-weight:800;letter-spacing:-.02em;color:#EAF2FF;
      font-variant-numeric:tabular-nums}
    .pc-row{display:flex;justify-content:space-between;gap:10px;font-size:10.5px;margin-top:2px;color:#8B93A7}
    .pc-row b{font-weight:700;font-variant-numeric:tabular-nums;color:#EAF2FF}
    .pc-row b.up{color:#00F5D4} .pc-row b.down{color:#FF2A85}
    .pc-hover{margin-top:5px;padding-top:5px;border-top:1px solid rgba(255,255,255,.08);
      font-size:9.5px;color:#6F7A90;letter-spacing:.02em}
    .pc-toolbar{position:absolute;right:10px;top:10px;z-index:7;display:flex;flex-wrap:wrap;gap:6px;
      align-items:center;justify-content:flex-end;max-width:calc(100% - 220px)}
    .pc-pill{padding:5px 9px;border-radius:99px;border:1px solid rgba(255,255,255,.12);
      background:rgba(255,255,255,.04);color:#8B93A7;font-size:10px;font-weight:700;cursor:pointer;
      font-family:'JetBrains Mono',ui-monospace,monospace;transition:all .15s}
    .pc-pill:hover{color:#EAF2FF;border-color:rgba(0,245,212,.4)}
    .pc-pill.on{color:#04140F;background:linear-gradient(135deg,#00F5D4,#00C2A8);border-color:transparent;
      box-shadow:0 6px 18px rgba(0,245,212,.25)}
    .pc-toggle{display:flex;gap:4px;padding:3px;border-radius:99px;background:rgba(255,255,255,.05);
      border:1px solid rgba(255,255,255,.1)}
    .pc-toggle .pc-pill{border:none;background:transparent;padding:4px 9px}
    .pc-toggle .pc-pill.on{background:rgba(0,245,212,.14);color:#00F5D4;box-shadow:none}
    .pc-actions{position:absolute;right:10px;bottom:10px;z-index:8;display:flex;gap:7px}
    .pc-btn{min-width:92px;min-height:38px;padding:0 16px;border-radius:11px;border:1px solid transparent;
      font-size:11.5px;font-weight:800;letter-spacing:.03em;cursor:pointer;font-family:inherit;color:#fff;
      transition:transform .12s,box-shadow .2s,filter .2s}
    .pc-btn:active{transform:translateY(1px)}
    .pc-buy{background:linear-gradient(135deg,#FF3B5C,#C81E3A);box-shadow:0 10px 24px rgba(255,59,92,.28)}
    .pc-buy:hover{filter:brightness(1.08);box-shadow:0 12px 30px rgba(255,59,92,.4)}
    .pc-sell{background:linear-gradient(135deg,#3AA0FF,#1D6FD8);box-shadow:0 10px 24px rgba(58,160,255,.28)}
    .pc-sell:hover{filter:brightness(1.08);box-shadow:0 12px 30px rgba(58,160,255,.4)}
    .pc-sell.loss{background:linear-gradient(135deg,#FF2A85,#B0175C)}
    .pc-btn:disabled{opacity:.4;cursor:not-allowed;box-shadow:none}
    .pc-badge{position:absolute;left:10px;bottom:10px;z-index:6;display:flex;gap:10px;align-items:center;
      padding:5px 9px;border-radius:9px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);
      -webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);font-size:9.5px;color:#8B93A7;
      font-family:'JetBrains Mono',ui-monospace,monospace;pointer-events:none}
    .pc-badge b{color:#EAF2FF;font-weight:700}
    .pc-loading{position:absolute;inset:0;display:grid;place-items:center;font-size:12px;color:#6F7A90;
      font-family:'JetBrains Mono',ui-monospace,monospace;background:#07090E;z-index:5}
    .pc-err{color:#FF2A85;text-align:center;padding:16px;font-size:11.5px;line-height:1.6}
    @media(max-width:560px){
      .pc-toolbar{max-width:calc(100% - 16px);left:10px;justify-content:flex-start;top:auto;bottom:56px}
      .pc-hud{min-width:164px;padding:8px 10px}
      .pc-price{font-size:20px}
      .pc-actions{bottom:8px}
      .pc-badge{display:none}
    }`;
    document.head.appendChild(st);
  }

  /* ------------------------------- instance ------------------------------- */
  class ProChart {
    constructor(host, opts) {
      this.host = host;
      this.opts = opts || {};
      this.mode = this.opts.mode || 'stock';          /* stock | portfolio */
      this.view = this.opts.view || 'price';           /* price | portfolio */
      this.ticker = String(this.opts.ticker || '').toUpperCase();
      this.tf = this.opts.tf || '15m';
      this.seriesType = 'baseline';                    /* baseline | candles */
      this.destroyed = false;
      this._lastPrice = 0;
      this._lastRealQuoteAt = 0;
      this._mockTimer = null;
      this._liveTimer = null;
      this._markers = [];
      this._priceLine = null;
      this._lines = [];
      this._build();
    }

    _build() {
      injectStyles();
      const host = this.host;
      host.__wcLwc = true;
      host.removeAttribute('data-chart');
      host.innerHTML = '';
      host.style.height = host.style.height || '';
      this.wrap = document.createElement('div');
      this.wrap.className = 'pc-wrap';
      const h = Math.round(Math.max(320, Math.min(520, (window.innerHeight || 800) * 0.52)));
      this.wrap.style.height = h + 'px';
      this.wrap.innerHTML =
        '<div class="pc-canvas"></div>' +
        '<div class="pc-loading">Loading chart…</div>' +
        this._hudHTML() +
        this._toolbarHTML() +
        '<div class="pc-actions">' +
          '<button class="pc-btn pc-buy" data-pc="buy">BUY</button>' +
          '<button class="pc-btn pc-sell" data-pc="sell">SELL</button>' +
        '</div>' +
        '<div class="pc-badge"><span>V5</span><b>' + LWC_VERSION + '</b><span>·</span><b>' + esc(this._label()) + '</b></div>';
      host.appendChild(this.wrap);
      this.canvas = this.wrap.querySelector('.pc-canvas');
      this.el = {
        price: this.wrap.querySelector('[data-pc="price"]'),
        chg: this.wrap.querySelector('[data-pc="chg"]'),
        pnl: this.wrap.querySelector('[data-pc="pnl"]'),
        hover: this.wrap.querySelector('[data-pc="hover"]'),
        buy: this.wrap.querySelector('[data-pc="buy"]'),
        sell: this.wrap.querySelector('[data-pc="sell"]')
      };
      this._bindUI();
      this._ready = this._init();
    }

    _label() {
      if (this.view === 'portfolio') return 'PORTFOLIO';
      return symbolLabel(this.ticker);
    }

    _hudHTML() {
      return `<div class="pc-hud" data-pc="hud">
        <div class="pc-sym"><i class="pc-dot"></i><span data-pc="sym">${esc(this._label())}</span></div>
        <div class="pc-price" data-pc="price">—</div>
        <div class="pc-row"><span>24h</span><b data-pc="chg">—</b></div>
        <div class="pc-row"><span>Unrealized</span><b data-pc="pnl">—</b></div>
        <div class="pc-hover" data-pc="hover">Hover the chart for price + time</div>
      </div>`;
    }

    _toolbarHTML() {
      const pills = Object.keys(TF).map((k) => `<button class="pc-pill${k === this.tf ? ' on' : ''}" data-pc="tf" data-tf="${k}">${k}</button>`).join('');
      return `<div class="pc-toolbar">
        <div class="pc-toggle">
          <button class="pc-pill${this.view === 'price' ? ' on' : ''}" data-pc="view" data-view="price">Price</button>
          <button class="pc-pill${this.view === 'portfolio' ? ' on' : ''}" data-pc="view" data-view="portfolio">Portfolio</button>
        </div>
        ${pills}
      </div>`;
    }

    _bindUI() {
      this.wrap.querySelectorAll('[data-pc="tf"]').forEach((b) => {
        b.addEventListener('click', () => this.setTimeframe(b.getAttribute('data-tf')));
      });
      this.wrap.querySelectorAll('[data-pc="view"]').forEach((b) => {
        b.addEventListener('click', () => this.setView(b.getAttribute('data-view')));
      });
      this.el.buy.addEventListener('click', () => this.buy());
      this.el.sell.addEventListener('click', () => this.sell());
    }

    async _init() {
      try {
        const LWC = await loadLWC();
        if (this.destroyed) return;
        const wrap = this.wrap;
        this.chart = LWC.createChart(this.canvas, {
          width: wrap.clientWidth || 320,
          height: wrap.clientHeight || 360,
          layout: {
            background: { type: LWC.ColorType.Solid, color: OBSIDIAN },
            textColor: '#8B93A7',
            fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 10,
            attributionLogo: false
          },
          grid: {
            vertLines: { color: 'rgba(255,255,255,0.03)' },
            horzLines: { color: 'rgba(255,255,255,0.03)' }
          },
          rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)', scaleMargins: { top: 0.14, bottom: 0.12 } },
          timeScale: { borderColor: 'rgba(255,255,255,0.08)', timeVisible: true, secondsVisible: false, rightOffset: 6, barSpacing: 7 },
          crosshair: {
            mode: LWC.CrosshairMode.Normal,
            vertLine: { color: 'rgba(0,245,212,.35)', width: 1, style: LWC.LineStyle.Dashed, labelBackgroundColor: '#00C2A8' },
            horzLine: { color: 'rgba(255,255,255,.18)', width: 1, style: LWC.LineStyle.Dashed, labelBackgroundColor: '#1B2434' }
          },
          localization: { priceFormatter: (p) => '$' + Number(p).toFixed(2) }
        });
        const loading = wrap.querySelector('.pc-loading');
        if (loading) loading.remove();
        this.LWC = LWC;
        this.ro = new ResizeObserver(() => this._resize());
        this.ro.observe(wrap);
        this.chart.subscribeCrosshairMove((param) => this._onCrosshair(param));
        await this._render();
        this._startLive();
      } catch (e) {
        const loading = this.wrap.querySelector('.pc-loading');
        if (loading) loading.innerHTML = '<div class="pc-err">Chart could not load (lightweight-charts v5 CDN blocked).<br>' + esc(e.message) + '</div>';
      }
    }

    _resize() {
      if (!this.chart || this.destroyed) return;
      const w = this.wrap.clientWidth, h = this.wrap.clientHeight;
      if (w > 0 && h > 0) this.chart.applyOptions({ width: w, height: h });
    }

    _priceFormat() { return this.view === 'portfolio' ? 'wc' : 'usd'; }

    async _render() {
      if (!this.chart || this.destroyed) return;
      const token = (this._renderToken = (this._renderToken || 0) + 1);
      this._lastTime = 0;
      const LWC = this.LWC;
      /* tear down the previous series + markers */
      if (this.markersPlugin) { try { this.markersPlugin.setMarkers([]); } catch (e) {} }
      if (this.series) { try { this.chart.removeSeries(this.series); } catch (e) {} this.series = null; }
      this._lines = [];
      this._priceLine = null;

      const tf = TF[this.tf] || TF['15m'];
      const isPortfolio = this.view === 'portfolio';
      let points = isPortfolio ? portfolioPoints(this.tf) : await stockHistory(this.ticker, this.tf);
      if (this.destroyed || token !== this._renderToken) return;

      const seriesOpts = isPortfolio
        ? {
            lineColor: CYAN, lineWidth: 2,
            topColor: 'rgba(0,245,212,.30)', bottomColor: 'rgba(0,245,212,.02)',
            priceLineVisible: false, lastValueVisible: true,
            priceFormat: { type: 'price', precision: 2, minMove: 0.01 }
          }
        : (this.seriesType === 'candles'
          ? {
              upColor: CYAN, downColor: MAGENTA, borderVisible: false,
              wickUpColor: CYAN, wickDownColor: MAGENTA,
              priceLineVisible: false, lastValueVisible: true
            }
          : {
              baseValue: { type: 'price', price: this._baseline(points) },
              topLineColor: CYAN, topFillColor1: 'rgba(0,245,212,.28)', topFillColor2: 'rgba(0,245,212,.01)',
              bottomLineColor: MAGENTA, bottomFillColor1: 'rgba(255,42,133,.01)', bottomFillColor2: 'rgba(255,42,133,.26)',
              lineWidth: 2, priceLineVisible: false, lastValueVisible: true
            });

      const def = isPortfolio ? LWC.AreaSeries : (this.seriesType === 'candles' ? LWC.CandlestickSeries : LWC.BaselineSeries);
      this.series = this.chart.addSeries(def, seriesOpts);

      if (isPortfolio) {
        this.series.setData(points.map((p) => ({ time: p.time, value: p.value })));
      } else if (this.seriesType === 'candles') {
        this.candles = toCandles(points, tf.bucket);
        this.series.setData(this.candles);
      } else {
        this.series.setData(points.map((p) => ({ time: p.time, value: p.value })));
      }

      /* execution markers (stock view only) */
      this.markersPlugin = null;
      if (!isPortfolio && LWC.createSeriesMarkers) {
        const from = points.length ? points[0].time : 0;
        const to = points.length ? points[points.length - 1].time + 86400 : 0;
        const markers = tradeMarkers(this.ticker, from, to);
        this.markersPlugin = LWC.createSeriesMarkers(this.series, markers);
        this._markers = markers;
      }

      /* entry / TP / SL + live price lines */
      if (!isPortfolio) this._drawPositionLines();
      this._drawLivePriceLine();

      if (points.length) this.chart.timeScale().fitContent();
      this._lastPrice = points.length ? Number(points[points.length - 1].value) : 0;
      this._updateHud(this._livePrice() || this._lastPrice);
      this._syncButtons();
    }

    _baseline(points) {
      const h = holding(this.ticker);
      if (h && Number(h.avgPrice) > 0) return Number(h.avgPrice);
      return points.length ? Number(points[0].value) : 100;
    }

    _drawPositionLines() {
      const h = holding(this.ticker);
      const add = (price, color, title, style) => {
        const p = Number(price);
        if (!(p > 0)) return null;
        try {
          return this.series.createPriceLine({
            price: p, color, lineWidth: 1, lineStyle: style,
            axisLabelVisible: true, title
          });
        } catch (e) { return null; }
      };
      if (h) {
        const entry = Number(h.avgPrice) || 0;
        const l1 = add(entry, '#3AA0FF', 'AVG ' + usd(entry), this.LWC.LineStyle.Dashed);
        const l2 = add(h.takeProfitPrice, CYAN, 'TP ' + usd(h.takeProfitPrice), this.LWC.LineStyle.Dotted);
        const l3 = add(h.stopLossPrice, MAGENTA, 'SL ' + usd(h.stopLossPrice), this.LWC.LineStyle.Dotted);
        [l1, l2, l3].forEach((l) => l && this._lines.push(l));
      }
    }

    _drawLivePriceLine() {
      const price = this._livePrice();
      if (!(price > 0)) return;
      try {
        if (this._priceLine) {
          this._priceLine.applyOptions({ price, color: this._dirColor() });
        } else {
          this._priceLine = this.series.createPriceLine({
            price, color: this._dirColor(), lineWidth: 1,
            lineStyle: this.LWC.LineStyle.Solid, axisLabelVisible: true, title: 'LIVE'
          });
        }
      } catch (e) {}
    }

    _dirColor() { return this._dir >= 0 ? CYAN : MAGENTA; }

    _livePrice() {
      if (this.view === 'portfolio') {
        try { return Number(LT.summary(meId()).valueCoins) || this._lastPrice; } catch (e) { return this._lastPrice; }
      }
      const q = quote(this.ticker);
      return q && Number(q.price) > 0 ? Number(q.price) : this._lastPrice;
    }

    _onCrosshair(param) {
      if (!this.el.hover) return;
      if (!param || !param.time || !param.point) { this.el.hover.textContent = 'Hover the chart for price + time'; return; }
      let value = null;
      try {
        const d = param.seriesData && param.seriesData.get(this.series);
        if (d) value = d.value != null ? d.value : d.close;
      } catch (e) {}
      const tm = new Date(Number(param.time) * 1000);
      const stamp = tm.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + tm.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const val = this.view === 'portfolio'
        ? (Number(value) || 0).toFixed(2) + ' WC'
        : value != null ? usd(value) : '—';
      this.el.hover.textContent = stamp + ' · ' + val;
    }

    _updateHud(price) {
      if (!this.el.price) return;
      if (this.view === 'portfolio') {
        const v = Number(price) || 0;
        this.el.price.textContent = v.toFixed(2) + ' WC';
        let pnl = 0;
        try { pnl = Number(LT.summary(meId()).pnl) || 0; } catch (e) {}
        const up = pnl >= 0;
        this.el.chg.textContent = 'Portfolio';
        this.el.chg.className = '';
        this.el.pnl.textContent = (up ? '+' : '−') + Math.abs(pnl).toFixed(2) + ' WC';
        this.el.pnl.className = up ? 'up' : 'down';
        return;
      }
      const q = quote(this.ticker);
      this.el.price.textContent = usd(price || (q && q.price) || 0);
      const chg = q ? Number(q.changePct) || 0 : 0;
      this.el.chg.textContent = pct(chg);
      this.el.chg.className = chg >= 0 ? 'up' : 'down';
      const h = holding(this.ticker);
      if (h) {
        const shares = Number(h.shares) || 0;
        const entry = Number(h.avgPrice) || 0;
        const inv = Number(h.investedUsd) > 0 ? Number(h.investedUsd) : shares * entry;
        const val = shares * (Number(price) || entry);
        const pnl = val - inv;
        const pnlPct = inv > 0 ? (pnl / inv) * 100 : 0;
        this.el.pnl.textContent = (pnl >= 0 ? '+' : '−') + usd(Math.abs(pnl)) + ' (' + (pnl >= 0 ? '+' : '−') + Math.abs(pnlPct).toFixed(2) + '%)';
        this.el.pnl.className = pnl >= 0 ? 'up' : 'down';
        this._pnl = pnl;
      } else {
        this.el.pnl.textContent = '—';
        this.el.pnl.className = '';
        this._pnl = 0;
      }
    }

    _syncButtons() {
      const canTrade = this.view !== 'portfolio' && !!this.ticker;
      if (this.el.buy) this.el.buy.disabled = !canTrade;
      if (this.el.sell) {
        const h = canTrade ? holding(this.ticker) : null;
        this.el.sell.disabled = !h;
        const up = (this._pnl || 0) >= 0;
        this.el.sell.className = 'pc-btn pc-sell' + (h ? (up ? '' : ' loss') : '');
      }
      const badge = this.wrap.querySelector('.pc-badge b:last-child');
      if (badge) badge.textContent = this._label();
      const sym = this.wrap.querySelector('[data-pc="sym"]');
      if (sym) sym.textContent = this._label();
    }

    /* --------------------------- live tick engine --------------------------- */
    _startLive() {
      this._liveTimer = setInterval(() => {
        if (this.destroyed) return;
        if (this.view === 'portfolio') {
          const p = this._livePrice();
          if (p > 0) this._applyTick({ time: Math.floor(Date.now() / 1000), price: p, volume: 0, synthetic: false });
          return;
        }
        const q = quote(this.ticker);
        if (q && Number(q.price) > 0) {
          const prev = this._lastPrice;
          if (Math.abs(Number(q.price) - prev) > 1e-9) this._lastRealQuoteAt = Date.now();
          this._applyTick({ time: Math.floor(Date.now() / 1000), price: Number(q.price), volume: Number(q.volume) || 0, synthetic: false, changePct: q.changePct });
        }
      }, 1000);

      if (PC.mock !== false) {
        this._mockTimer = setInterval(() => {
          if (this.destroyed) return;
          const quiet = Date.now() - (this._lastRealQuoteAt || 0) > 6000;
          if (!quiet) return;
          const base = this._lastPrice || this._livePrice() || 100;
          const drift = (Math.random() - 0.5) * base * 0.0012;
          const price = Math.max(0.01, base + drift);
          this._applyTick({ time: Math.floor(Date.now() / 1000), price, volume: Math.round(Math.random() * 900 + 100), synthetic: true });
        }, 500 + Math.random() * 500);
      }
    }

    /** Public: feed a real tick from any WebSocket: { time, price, volume } */
    pushTick(tick) {
      if (this.destroyed || !tick) return;
      const price = Number(tick.price);
      if (!(price > 0)) return;
      const time = Number(tick.time) || Math.floor(Date.now() / 1000);
      this._lastRealQuoteAt = Date.now();
      this._applyTick({ time, price, volume: Number(tick.volume) || 0, synthetic: false });
    }

    _applyTick(tick) {
      if (!this.chart || !this.series) return;
      const price = Number(tick.price);
      if (!(price > 0)) return;
      const prev = this._lastPrice;
      this._dir = prev ? (price > prev ? 1 : price < prev ? -1 : this._dir || 0) : 1;

      if (this.view === 'portfolio') {
        const now = Math.floor(Date.now() / 1000);
        const t = now > this._lastTime ? now : this._lastTime + 1;
        try { this.series.update({ time: t, value: price }); this._lastTime = t; } catch (e) {}
      } else if (this.seriesType === 'candles') {
        const bucket = (TF[this.tf] || TF['15m']).bucket;
        const t = Math.floor(tick.time / bucket) * bucket;
        const last = this.candles && this.candles[this.candles.length - 1];
        if (!last) { this.candles = [{ time: t, open: price, high: price, low: price, close: price }]; try { this.series.setData(this.candles); } catch (e) {} }
        else if (t > last.time) {
          const c = { time: t, open: price, high: price, low: price, close: price };
          this.candles.push(c);
          try { this.series.update(c); } catch (e) {}
        } else {
          last.close = price;
          last.high = Math.max(last.high, price);
          last.low = Math.min(last.low, price);
          try { this.series.update({ time: last.time, open: last.open, high: last.high, low: last.low, close: last.close }); } catch (e) {}
        }
        if (this.candles && this.candles.length > 1200) this.candles = this.candles.slice(-900);
      } else {
        const now = Math.floor(Date.now() / 1000);
        const t = now > (this._lastTime || 0) ? now : this._lastTime + 1;
        try { this.series.update({ time: t, value: price }); this._lastTime = t; } catch (e) {}
      }
      this._lastPrice = price;
      this._drawLivePriceLine();
      this._updateHud(price);
      this._syncButtons();
    }

    setTimeframe(tf) {
      if (!TF[tf] || tf === this.tf) return;
      this.tf = tf;
      this.wrap.querySelectorAll('[data-pc="tf"]').forEach((b) => b.classList.toggle('on', b.getAttribute('data-tf') === tf));
      this._render();
    }

    setView(view) {
      if (view === this.view) return;
      this.view = view === 'portfolio' ? 'portfolio' : 'price';
      this.wrap.querySelectorAll('[data-pc="view"]').forEach((b) => b.classList.toggle('on', b.getAttribute('data-view') === this.view));
      this._syncButtons();
      this._render();
    }

    toggleSeriesType() {
      this.seriesType = this.seriesType === 'candles' ? 'baseline' : 'candles';
      this._render();
    }

    /* ------------------------------ trading -------------------------------- */
    async buy() {
      if (this.view === 'portfolio' || !this.ticker) return;
      if (typeof Remote === 'undefined' || !Remote.enabled) return toast('Connect the sync server to trade', 'err');
      const q = quote(this.ticker);
      const live = q && Number(q.price) > 0 ? Number(q.price) : 0;
      if (!live) return toast('Waiting for a live quote', 'err');
      const last = Number(PC.lastUsd) > 0 ? Number(PC.lastUsd) : 100;
      if (typeof openModal !== 'function' || typeof modalShell !== 'function') {
        if (typeof App !== 'undefined' && App.spotBuy) return App.spotBuy();
        return;
      }
      openModal(modalShell('Buy ' + this.ticker, `
        <div class="tiny muted" style="margin-bottom:10px">Live ${usd(live)} · ${(live * 2).toFixed(2)} WC · 1 WC = $0.50</div>
        <div class="field"><label class="label">Amount in USD</label>
          <div class="input-wrap"><span class="inv-prefix">$</span>
            <input class="input" id="pcBuyUsd" type="number" min="1" step="0.01" value="${last}"/></div>
          <div class="tiny muted" id="pcBuyPreview" style="margin-top:5px"></div></div>
        <div class="row" style="gap:8px">
          <div class="field grow"><label class="label">Take profit %</label><input class="input" id="pcBuyTp" type="number" min="0" step="0.1" placeholder="optional"/></div>
          <div class="field grow"><label class="label">Stop loss %</label><input class="input" id="pcBuySl" type="number" min="0" step="0.1" placeholder="optional"/></div>
        </div>`,
        `<button class="btn btn-ghost" data-close style="flex:1">Cancel</button>
         <button class="btn btn-primary" id="pcBuyGo" style="flex:1">Buy now</button>`), { locked: false });
      const amountEl = document.getElementById('pcBuyUsd');
      const preview = () => {
        const v = Number(amountEl && amountEl.value) || 0;
        const el = document.getElementById('pcBuyPreview');
        if (el) el.innerHTML = v > 0 ? '<b>' + usd(v) + '</b> = <b>' + (v / 0.5).toFixed(2) + ' WC</b> · ' + (v / live).toFixed(6) + ' shares' : 'Enter a USD amount.';
      };
      if (amountEl) amountEl.addEventListener('input', preview);
      preview();
      document.getElementById('pcBuyGo').onclick = async () => {
        const amountUsd = Number((document.getElementById('pcBuyUsd') || {}).value) || 0;
        if (!(amountUsd >= 1)) return toast('Enter at least $1', 'err');
        const tpPct = Number((document.getElementById('pcBuyTp') || {}).value) || 0;
        const slPct = Number((document.getElementById('pcBuySl') || {}).value) || 0;
        const body = { userId: meId(), ticker: this.ticker, amountUsd };
        if (tpPct > 0) body.tpPrice = Math.round(live * (1 + tpPct / 100) * 10000) / 10000;
        if (slPct > 0) body.slPrice = Math.round(live * (1 - slPct / 100) * 10000) / 10000;
        try {
          const r = await postJSON('/api/market/spot/buy', body, 30000);
          if (!r.res || !r.res.ok || !r.data || !r.data.ok) return toast((r.data && r.data.error) || 'Buy failed', 'err');
          PC.lastUsd = amountUsd;
          closeModal();
          try { await Remote.refresh(true); } catch (e) {}
          toast('Bought ' + Number(r.data.order.shares).toLocaleString(undefined, { maximumFractionDigits: 6 }) + ' ' + this.ticker, 'ok');
          if (typeof render === 'function') render();
        } catch (e) { toast('Buy failed: ' + e.message, 'err'); }
      };
    }

    async sell() {
      const h = this.view === 'portfolio' ? null : holding(this.ticker);
      if (!h) return toast('No open position', 'err');
      if (typeof App !== 'undefined' && App.spotSell) return App.spotSell(null, { t: this.ticker });
      if (typeof Remote === 'undefined' || !Remote.enabled) return toast('Connect the sync server to sell', 'err');
      try {
        const r = await postJSON('/api/market/spot/sell', { userId: meId(), ticker: this.ticker }, 30000);
        if (!r.res || !r.res.ok || !r.data || !r.data.ok) return toast((r.data && r.data.error) || 'Sell failed', 'err');
        try { await Remote.refresh(true); } catch (e) {}
        toast('Sold · ' + Number(r.data.payout).toFixed(2) + ' WC credited', 'ok');
        if (typeof render === 'function') render();
      } catch (e) { toast('Sell failed: ' + e.message, 'err'); }
    }

    destroy() {
      this.destroyed = true;
      clearInterval(this._liveTimer);
      clearInterval(this._mockTimer);
      try { if (this.ro) this.ro.disconnect(); } catch (e) {}
      try { if (this.chart) this.chart.remove(); } catch (e) {}
      try { if (this.wrap && this.wrap.parentNode) this.wrap.parentNode.removeChild(this.wrap); } catch (e) {}
      this.chart = null;
      this.series = null;
      const i = PC.instances.indexOf(this);
      if (i >= 0) PC.instances.splice(i, 1);
    }
  }

  /* ---------------------------- equity / ROI chart -------------------------
     Used by the WhaleChat investment plans: principal + accrued profit over
     time, with invested/target price lines, ROI HUD and a live 1s loop. */
  class EquityChart {
    constructor(host, opts) {
      this.host = host;
      this.opts = opts || {};
      this.key = this.opts.key || 'default';
      this.unit = this.opts.unit || 'wc';
      this.points = (this.opts.points || []).slice();
      this.destroyed = false;
      this._build();
    }

    _build() {
      injectStyles();
      const host = this.host;
      host.__wcLwc = true;
      if (host.hasAttribute('data-chart')) host.removeAttribute('data-chart');
      host.innerHTML = '';
      this.wrap = document.createElement('div');
      this.wrap.className = 'pc-wrap';
      this.wrap.style.height = (this.opts.height || 300) + 'px';
      const hud = this.opts.hud || {};
      this.wrap.innerHTML =
        '<div class="pc-canvas"></div>' +
        '<div class="pc-loading">Loading plan chart…</div>' +
        `<div class="pc-hud" data-pe="hud">
          <div class="pc-sym"><i class="pc-dot"></i><span data-pe="title">${esc(hud.title || 'WhaleChat plans')}</span></div>
          <div class="pc-price" data-pe="value">—</div>
          <div class="pc-row"><span>ROI</span><b data-pe="roi">—</b></div>
          <div class="pc-row"><span>Earnings</span><b data-pe="earn">—</b></div>
          <div class="pc-row"><span>Matures</span><b data-pe="matures">—</b></div>
          <div class="pc-hover" data-pe="hover">Hover the chart for value + time</div>
        </div>`;
      host.appendChild(this.wrap);
      this.canvas = this.wrap.querySelector('.pc-canvas');
      this.el = {
        title: this.wrap.querySelector('[data-pe="title"]'),
        value: this.wrap.querySelector('[data-pe="value"]'),
        roi: this.wrap.querySelector('[data-pe="roi"]'),
        earn: this.wrap.querySelector('[data-pe="earn"]'),
        matures: this.wrap.querySelector('[data-pe="matures"]'),
        hover: this.wrap.querySelector('[data-pe="hover"]')
      };
      this._ready = this._init();
    }

    async _init() {
      try {
        const LWC = await loadLWC();
        if (this.destroyed) return;
        this.LWC = LWC;
        this.chart = LWC.createChart(this.canvas, {
          width: this.wrap.clientWidth || 320,
          height: this.wrap.clientHeight || 300,
          layout: {
            background: { type: LWC.ColorType.Solid, color: OBSIDIAN },
            textColor: '#8B93A7',
            fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 10,
            attributionLogo: false
          },
          grid: { vertLines: { color: 'rgba(255,255,255,0.03)' }, horzLines: { color: 'rgba(255,255,255,0.03)' } },
          rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)', scaleMargins: { top: 0.16, bottom: 0.12 } },
          timeScale: { borderColor: 'rgba(255,255,255,0.08)', timeVisible: true, secondsVisible: false, rightOffset: 4, barSpacing: 8 },
          crosshair: {
            mode: LWC.CrosshairMode.Normal,
            vertLine: { color: 'rgba(0,245,212,.35)', style: LWC.LineStyle.Dashed, labelBackgroundColor: '#00C2A8' },
            horzLine: { color: 'rgba(255,255,255,.18)', style: LWC.LineStyle.Dashed, labelBackgroundColor: '#1B2434' }
          },
          localization: { priceFormatter: (p) => this.unit === 'wc' ? Number(p).toFixed(2) : '$' + Number(p).toFixed(2) }
        });
        const loading = this.wrap.querySelector('.pc-loading');
        if (loading) loading.remove();
        this.ro = new ResizeObserver(() => {
          if (!this.chart || this.destroyed) return;
          const w = this.wrap.clientWidth, h = this.wrap.clientHeight;
          if (w > 0 && h > 0) this.chart.applyOptions({ width: w, height: h });
        });
        this.ro.observe(this.wrap);
        this.chart.subscribeCrosshairMove((param) => {
          if (!this.el.hover) return;
          if (!param || !param.time || !param.point) { this.el.hover.textContent = 'Hover the chart for value + time'; return; }
          let v = 0;
          try { const d = param.seriesData.get(this.series); if (d) v = d.value; } catch (e) {}
          const tm = new Date(Number(param.time) * 1000);
          this.el.hover.textContent = tm.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
            tm.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' · ' +
            (this.unit === 'wc' ? Number(v).toFixed(2) + ' WC' : usd(v));
        });
        this.series = this.chart.addSeries(LWC.AreaSeries, {
          lineColor: CYAN, lineWidth: 2,
          topColor: 'rgba(0,245,212,.30)', bottomColor: 'rgba(0,245,212,.02)',
          priceLineVisible: false, lastValueVisible: true
        });
        this._applyData();
        this._startLive();
        this.paint();
      } catch (e) {
        const loading = this.wrap.querySelector('.pc-loading');
        if (loading) loading.innerHTML = '<div class="pc-err">Plan chart could not load.<br>' + esc(e.message) + '</div>';
      }
    }

    _stablePoints() {
      /* strictly increasing unique seconds required by lightweight-charts */
      const out = [];
      (this.points || []).forEach((p) => {
        const t = Math.floor((Number(p.t) || 0) / 1000);
        const v = Number(p.v);
        if (!(t > 0) || !Number.isFinite(v)) return;
        const last = out[out.length - 1];
        if (last && t <= last.time) last.value = v;
        else out.push({ time: t, value: v });
      });
      return out;
    }

    _applyData() {
      if (!this.series || !this.LWC) return;
      const data = this._stablePoints();
      this.data = data;
      try { this.series.setData(data); } catch (e) {}
      (this._lines || []).forEach((l) => { try { this.series.removePriceLine(l); } catch (e) {} });
      this._lines = [];
      (this.opts.lines || []).forEach((ln) => {
        const price = Number(ln.price);
        if (!(price > 0)) return;
        try {
          this._lines.push(this.series.createPriceLine({
            price, color: ln.color || '#8B93A7', lineWidth: 1,
            lineStyle: ln.style != null ? ln.style : this.LWC.LineStyle.Dashed,
            axisLabelVisible: true, title: ln.title || ''
          }));
        } catch (e) {}
      });
      if (this.chart && data.length) this.chart.timeScale().fitContent();
    }

    setData(points, opts) {
      this.points = (points || []).slice();
      if (opts) {
        this.opts = Object.assign({}, this.opts, opts);
        this.unit = this.opts.unit || this.unit;
        const hud = this.opts.hud || {};
        if (this.el.title) this.el.title.textContent = hud.title || 'WhaleChat plans';
        if (this.el.matures) this.el.matures.textContent = hud.matures || '—';
      }
      this._applyData();
      this.paint();
    }

    _startLive() {
      this.timer = setInterval(() => {
        if (this.destroyed) return;
        this.paint();
        if (!this.opts.getLive) return;
        const live = this.opts.getLive();
        if (!live || !(Number(live.value) >= 0)) return;
        const now = Math.floor(Date.now() / 1000);
        const v = Number(live.value);
        if (!this.data || !this.data.length) { this.data = [{ time: now, value: v }]; try { this.series.setData(this.data); } catch (e) {} return; }
        const last = this.data[this.data.length - 1];
        if (now <= last.time) last.value = v;
        else this.data.push({ time: now, value: v });
        try { this.series.update({ time: now <= last.time ? last.time : now, value: v }); } catch (e) {}
        if (this.data.length > 1200) this.data = this.data.slice(-900);
      }, 1000);
    }

    paint() {
      const live = this.opts.getLive ? (this.opts.getLive() || {}) : (this.opts.hud || {});
      const wc = (v) => (Number(v) || 0).toFixed(2) + ' WC';
      if (this.el.value) this.el.value.textContent = live.value != null ? wc(live.value) : '—';
      if (this.el.roi) {
        const r = Number(live.roiPct) || 0;
        this.el.roi.textContent = (r >= 0 ? '+' : '−') + Math.abs(r).toFixed(2) + '%';
        this.el.roi.className = r >= 0 ? 'up' : 'down';
      }
      if (this.el.earn) {
        const e = Number(live.earnCoins) || 0;
        this.el.earn.textContent = (e >= 0 ? '+' : '−') + Math.abs(e).toFixed(2) + ' WC';
        this.el.earn.className = e >= 0 ? 'up' : 'down';
      }
      if (this.el.matures && live.matures) this.el.matures.textContent = live.matures;
    }

    destroy() {
      this.destroyed = true;
      clearInterval(this.timer);
      try { if (this.ro) this.ro.disconnect(); } catch (e) {}
      try { if (this.chart) this.chart.remove(); } catch (e) {}
      try { if (this.wrap && this.wrap.parentNode) this.wrap.parentNode.removeChild(this.wrap); } catch (e) {}
      this.chart = null; this.series = null;
      const i = PC.equities.indexOf(this);
      if (i >= 0) PC.equities.splice(i, 1);
    }
  }
  PC.equities = PC.equities || [];

  PC.mountEquity = function (host, opts) {
    if (!host) return null;
    const key = (opts && opts.key) || 'default';
    const existing = PC.equities.find((e) => e.host === host);
    if (existing && existing.key === key) {
      existing.setData((opts && opts.points) || [], opts);
      return existing;
    }
    if (existing) existing.destroy();
    const inst = new EquityChart(host, opts || {});
    PC.equities.push(inst);
    return inst;
  };

  /* ------------------------------- mounting ------------------------------- */
  function findStockHost() {
    return document.querySelector('.inv-chart[data-lt-live-chart], .inv-chart[data-chart]:not([data-chart^="__portfolio__"])');
  }
  function findPortfolioHosts() {
    const out = [];
    const dash = document.querySelector('.inv-chart[data-chart^="__portfolio__"]');
    if (dash) out.push(dash);
    const lt = document.getElementById('ltDashChart');
    if (lt) out.push(lt);
    return out;
  }
  function destroyOther(host) {
    PC.instances.slice().forEach((inst) => { if (inst.host !== host) inst.destroy(); });
  }

  PC.mountStock = function (explicitHost, explicitTicker) {
    if (PC.disableStock) return null;
    const host = explicitHost || findStockHost();
    if (!host) return null;
    const ticker = String(explicitTicker || host.getAttribute('data-lt-live-chart') || (host.getAttribute('data-chart') || '').split('|')[0] || '').toUpperCase();
    if (!ticker || ticker === '__PORTFOLIO__') return null;
    const tf = ((host.getAttribute('data-chart') || '').split('|')[1] || '').toUpperCase();
    const map = { '1D': '15m', '1W': '1H', '1M': '1D', '3M': '1D', '1Y': '1D', 'ALL': 'ALL' };
    const want = map[tf] || '15m';
    const existing = PC.instances.find((i) => i.host === host && i.mode === 'stock');
    if (existing && existing.ticker === ticker) {
      if (existing.tf !== want) existing.setTimeframe(want);
      return existing;
    }
    destroyOther(host);
    const inst = new ProChart(host, { mode: 'stock', ticker, tf: want, view: 'price' });
    PC.instances.push(inst);
    return inst;
  };

  PC.mountPortfolio = function (explicitHost) {
    const hosts = explicitHost ? [explicitHost] : findPortfolioHosts();
    let last = null;
    hosts.forEach((host) => {
      const existing = PC.instances.find((i) => i.host === host && i.mode === 'portfolio');
      if (existing) {
        existing._render();
        last = existing;
        return;
      }
      const inst = new ProChart(host, { mode: 'portfolio', view: 'portfolio', tf: '1M' });
      PC.instances.push(inst);
      last = inst;
    });
    return last;
  };

  PC.destroyAll = function () {
    PC.instances.slice().forEach((i) => i.destroy());
  };

  /* live tick bridge for real WebSocket feeds */
  PC.feedTick = function (ticker, tick) {
    const t = String(ticker || '').toUpperCase();
    PC.instances.forEach((i) => {
      if (i.mode === 'stock' && i.ticker === t) i.pushTick(tick);
    });
  };

  /* ---------------------------- app integration --------------------------- */
  if (typeof AFTER === 'object') {
    const prev = AFTER.invest;
    AFTER.invest = function (parts, params) {
      try { if (prev) prev(parts, params); } catch (e) {}
      setTimeout(() => {
        try {
          /* clean instances whose host was re-rendered away */
          PC.instances.slice().forEach((i) => { if (!document.body.contains(i.host)) i.destroy(); });
          (PC.equities || []).slice().forEach((e) => { if (!document.body.contains(e.host)) e.destroy(); });
          if (document.getElementById('ltDashChart') || document.querySelector('.inv-chart[data-chart^="__portfolio__"]')) PC.mountPortfolio();
          /* stock pages keep the Finnhub trade chart — no pro-chart mount here */
        } catch (e) { console.error('[pro-chart] mount failed', e); }
      }, 220);
    };
  }

  window.addEventListener('hashchange', () => {
    setTimeout(() => {
      PC.instances.slice().forEach((i) => { if (!document.body.contains(i.host)) i.destroy(); });
      (PC.equities || []).slice().forEach((e) => { if (!document.body.contains(e.host)) e.destroy(); });
    }, 60);
  });
})();
