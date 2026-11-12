/* =========================================================================
   WhaleChat market feed + TradingView lightweight-charts
   - loads lightweight-charts from the public CDN
   - stock detail chart is a themed BaselineSeries: baseline = trade entry
     price, green above / red below (inverted for Short trades)
   - quotes and historical bars come from the WhaleChat backend, which owns
     the Alpaca API keys (REST snapshots/bars + IEX WebSocket)
   - admin -> stocks gets Alpaca keys, sync schedule and price overrides
   ========================================================================= */
'use strict';

(function () {
  if (typeof window === 'undefined') return;
  const MK = window.WC_MARKET = window.WC_MARKET || {};
  MK.feed = null;
  MK.lastPollAt = 0;
  MK.chart = null;
  MK.chartLoading = null;
  MK.adminLoaded = false;
  MK.historyCache = {};

  const LWC_URL = 'https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js';

  function apiPath(p) {
    try { if (typeof Remote !== 'undefined' && Remote && Remote.enabled) return Remote.url(p); } catch (e) {}
    return p;
  }

  async function getJSON(pathname, opts, timeout) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout || 8000);
    try {
      const res = await fetch(apiPath(pathname), Object.assign({
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json' }
      }, opts || {}));
      const data = await res.json().catch(() => null);
      return { res, data };
    } finally { clearTimeout(timer); }
  }

  /* ------------------------------ feed polling ------------------------------ */
  function applyQuotes(data) {
    if (!data || !data.ok || !data.quotes || typeof INV === 'undefined') return;
    if (typeof DB === 'undefined' || !DB) return;
    MK.feed = data;
    const now = Date.now();
    Object.keys(data.quotes).forEach((ticker) => {
      const q = data.quotes[ticker];
      if (!q || !(Number(q.price) > 0)) return;
      const prev = INV.live[ticker];
      INV.live[ticker] = {
        price: Number(q.price),
        rawPrice: Number(q.rawPrice) || Number(q.price),
        overridePct: Number(q.overridePct) || 0,
        prevClose: Number(q.prevClose) || Number(q.price),
        open: Number(q.open) || Number(q.price),
        dayHigh: Number(q.dayHigh) || Number(q.price),
        dayLow: Number(q.dayLow) || Number(q.price),
        changePct: Number(q.changePct) || 0,
        changeUsd: Number(q.changeUsd) || 0,
        vol: Number(q.vol) || 0,
        dir: prev ? (q.price > prev.price ? 1 : q.price < prev.price ? -1 : 0) : (Number(q.dir) || 0),
        updatedAt: Number(q.updatedAt) || now,
        source: q.source || data.source,
        feed: true
      };
      const s = INV.stock(ticker);
      if (s) {
        s.price = Number(q.price);
        s.prevClose = Number(q.prevClose) || s.prevClose;
      }
      const key = ticker + '::1D';
      const cached = INV.seriesCache && INV.seriesCache[key];
      if (cached && cached.length) cached[cached.length - 1] = Number(q.price);
    });
    try { INV.paint(); } catch (e) {}
    try { if (typeof LT !== 'undefined' && LT.paint) LT.paint(); } catch (e) {}
    paintNotice();
    paintAdminStatus();
    updateChart();
    try { checkSettledToasts(); } catch (e) {}
  }

  async function poll() {
    if (document.hidden) return;
    try {
      const r = await getJSON('/api/market/quotes', {}, 7000);
      if (r.res && r.res.ok && r.data && r.data.ok) {
        MK.lastPollAt = Date.now();
        applyQuotes(r.data);
      }
    } catch (e) { /* local mode / offline: cached Alpaca prices remain */ }
  }

  function feedFresh() {
    if (!MK.feed || !MK.feed.quotes || !MK.lastPollAt) return false;
    const refresh = (MK.feed.status && Number(MK.feed.status.refreshSec)) || 15;
    return Date.now() - MK.lastPollAt < Math.max(10000, refresh * 2500);
  }
  MK.feedFresh = feedFresh;

  /* No browser-side price generator: the backend Alpaca feed is the only source. */
  function patchTick() {
    if (typeof INV === 'undefined' || INV.__mkTickPatched) return;
    INV.tick = function () {
      const now = Date.now();
      INV.checkAlerts();
      INV.runLimitOrders();
      INV.paint();
      if (!INV._lastPersist || now - INV._lastPersist > 45000) {
        INV._lastPersist = now;
        try { persist(); } catch (e) {}
      }
    };
    INV.__mkTickPatched = true;
    /* Replace the old random-walk chart series with real backend history. */
    if (!INV.__mkSeriesPatched) {
      INV.series = function (ticker, tf) {
        const key = String(ticker || '').toUpperCase();
        const cached = MK.historyCache && MK.historyCache[key];
        if (cached && cached.points && cached.points.length > 1) {
          const pts = cleanPoints(cached.points, key, 900);
          if (pts.length > 1) return pts.map((p) => p.value);
        }
        let q = null;
        try { q = INV.quote(key); } catch (e) {}
        const price = (q && q.price > 0) ? Number(q.price) : 0;
        return [price, price];
      };
      INV.__mkSeriesPatched = true;
    }
  }

  async function prefetchHistories(tickers) {
    const list = Array.from(new Set((tickers || []).filter(Boolean)));
    for (let i = 0; i < list.length; i += 20) {
      const chunk = list.slice(i, i + 20);
      try {
        const r = await getJSON('/api/market/history?tickers=' + encodeURIComponent(chunk.join(',')) + '&limit=240', {}, 10000);
        const hist = (r.data && r.data.history) || {};
        Object.keys(hist).forEach((t) => {
          if (Array.isArray(hist[t]) && hist[t].length) {
            MK.historyCache[t] = { at: Date.now(), points: hist[t] };
          }
        });
      } catch (e) {}
    }
  }

  /* ------------------------------ market notice ----------------------------- */
  function noticeText() {
    if (MK.feed && MK.feed.notice) return MK.feed.notice;
    return 'Add Alpaca API keys in Admin → Stocks';
  }

  function noticeLive() {
    return !!(MK.feed && MK.feed.source === 'live');
  }

  function paintNotice() {
    const txt = noticeText();
    const live = noticeLive();
    document.querySelectorAll('[data-market-notice]').forEach((el) => {
      el.textContent = txt;
      el.classList.toggle('live', live);
      el.classList.toggle('sim', !live);
    });
    document.querySelectorAll('.inv-note').forEach((el) => {
      if (!/market data|market mode|Alpaca|Simulated market|simulated feed/i.test(el.textContent || '')) return;
      el.setAttribute('data-market-notice', '1');
      el.innerHTML = `<span class="wc-feed-dot ${live ? 'live' : 'sim'}"></span><span>${escMarket(txt)}</span>`;
    });
  }

  /* server-settled trades -> immediate toast on the user's screen */
  function checkSettledToasts() {
    if (typeof LT === 'undefined' || !LT.open || typeof DB === 'undefined' || !DB) return;
    const open = new Set(LT.open().map((t) => t.id));
    if (!MK.knownOpen) { MK.knownOpen = open; return; }
    for (const tid of Array.from(MK.knownOpen)) {
      if (open.has(tid)) continue;
      const t = (DB.trades || []).find((x) => x.id === tid);
      if (!t || t.status === 'Open') continue;
      if (Date.now() - (Number(t.closedAt) || 0) > 120000) continue;
      const reason = t.closeReason || 'Trade closed';
      const win = /Take Profit/i.test(reason) || Number(t.pnlCoins) > 0;
      const pnl = Number(t.pnlCoins) || 0;
      if (typeof toast === 'function') {
        toast(`${t.ticker} · ${reason} · ${pnl >= 0 ? '+' : '−'}${Math.abs(pnl)} WC`, win ? 'ok' : 'err', 4200);
      }
    }
    MK.knownOpen = open;
  }

  function escMarket(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* 1 WC = $0.50 — every chart label shows both currencies */
  function wcText(usdValue) {
    const wc = Math.round((Number(usdValue) / 0.5) * 100) / 100;
    return (Number.isInteger(wc) ? String(wc) : wc.toFixed(2)) + ' WC';
  }
  function priceBoth(usdValue) {
    return '$' + (Number(usdValue) || 0).toFixed(2) + ' (' + wcText(usdValue) + ')';
  }
  function spotHolding(ticker) {
    try { return (typeof INV !== 'undefined' && INV.holding) ? INV.holding(ticker, me().id) : null; } catch (e) { return null; }
  }

  /* --------------------------- lightweight-charts --------------------------- */
  function loadLWC() {
    if (window.LightweightCharts) return Promise.resolve(window.LightweightCharts);
    if (MK.chartLoading) return MK.chartLoading;
    MK.chartLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = LWC_URL;
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.onload = () => window.LightweightCharts ? resolve(window.LightweightCharts) : reject(new Error('lightweight-charts did not initialise'));
      s.onerror = () => reject(new Error('Could not load lightweight-charts'));
      document.head.appendChild(s);
    });
    return MK.chartLoading;
  }

  function currentTicker() {
    const m = (location.hash || '').match(/^#\/invest\/stock\/([A-Z0-9.]+)/i);
    return m ? m[1].toUpperCase() : '';
  }

  function openPosition(ticker) {
    try {
      if (typeof LT === 'undefined' || !LT.open) return null;
      return LT.open().filter((t) => t.ticker === ticker && t.status === 'Open')[0] || null;
    } catch (e) { return null; }
  }

  function positionFor(ticker) {
    return openPosition(ticker);
  }

  function fallbackData(ticker, tf) {
    let vals = [];
    try { vals = INV.series(ticker, tf || '1D') || []; } catch (e) {}
    if (!vals.length) {
      try { vals = INV.series(ticker, '1W') || []; } catch (e) {}
    }
    if (!vals.length) vals = [100, 100];
    const now = Math.floor(Date.now() / 1000);
    const step = 60;
    return vals.map((v, i) => ({ time: now - (vals.length - 1 - i) * step, value: Math.max(0.0001, Number(v) || 0) }));
  }

  async function fetchHistory(ticker) {
    let ovKey = 0;
    try { const lq = INV.quote(ticker); ovKey = Number(lq && lq.overridePct) || 0; } catch (e) {}
    const cacheKey = ticker + '|ov' + ovKey;
    const cached = MK.historyCache && MK.historyCache[cacheKey];
    if (cached && Date.now() - cached.at < 45000) return cached.points;
    try {
      /* Alpaca 1-minute bars, already multiplied by the admin Override % server-side */
      const r = await getJSON('/api/market/bars?ticker=' + encodeURIComponent(ticker) + '&limit=900&timeframe=1Min', {}, 15000);
      const d = r.data || {};
      let points = [];
      if (d.ok && Array.isArray(d.bars) && d.bars.length) {
        points = d.bars.map((b) => ({ t: Number(b.t) || 0, p: Number(b.c) || 0 }));
      }
      if (!points.length) {
        const fb = await getJSON('/api/market/history?tickers=' + encodeURIComponent(ticker) + '&limit=900', {}, 7000);
        const h = (fb.data && fb.data.history) || {};
        points = Array.isArray(h[ticker]) ? h[ticker] : [];
      }
      MK.historyCache = MK.historyCache || {};
      MK.historyCache[cacheKey] = { at: Date.now(), points };
      return points;
    } catch (e) { return []; }
  }

  function cleanPoints(points, ticker, limit) {
    const out = [];
    (points || []).forEach((pt) => {
      const time = Math.floor((Number(pt.t) || 0) / 1000);
      const value = Number(pt.p);
      if (!(time > 0) || !(value > 0)) return;
      const prev = out[out.length - 1];
      if (prev && time <= prev.time) return;
      out.push({ time, value: Math.max(0.0001, value) });
    });
    if (out.length > (limit || 900)) out.splice(0, out.length - (limit || 900));
    return out;
  }

  async function stockData(ticker) {
    const pts = cleanPoints(await fetchHistory(ticker), ticker, 900);
    let data = pts.length >= 2 ? pts : fallbackData(ticker, '1D');
    let q = null;
    try { q = INV.quote(ticker); } catch (e) {}
    if (q && q.price > 0) {
      const now = Math.floor(Date.now() / 1000);
      const last = data[data.length - 1];
      if (!last || now > last.time + 1 || Math.abs(last.value - q.price) > 0.0001) {
        if (last && now <= last.time) {
          last.value = Number(q.price);
        } else {
          data = data.concat([{ time: Math.max(now, (last ? last.time + 1 : now)), value: Number(q.price) }]);
        }
      }
    }
    return data.length >= 2 ? data : [{ time: Math.floor(Date.now() / 1000) - 60, value: 100 }, { time: Math.floor(Date.now() / 1000), value: 100 }];
  }

  function destroyChart() {
    if (!MK.chart) return;
    try { MK.chart.chart.remove(); } catch (e) {}
    MK.chart = null;
  }

  function applyBaselineColors(series, side) {
    const green = '#22c55e';
    const red = '#ef4444';
    series.applyOptions(side === 'short' ? {
      topLineColor: red, topFillColor1: 'rgba(239,68,68,.28)', topFillColor2: 'rgba(239,68,68,.02)',
      bottomLineColor: green, bottomFillColor1: 'rgba(34,197,94,.02)', bottomFillColor2: 'rgba(34,197,94,.28)'
    } : {
      topLineColor: green, topFillColor1: 'rgba(34,197,94,.28)', topFillColor2: 'rgba(34,197,94,.02)',
      bottomLineColor: red, bottomFillColor1: 'rgba(239,68,68,.02)', bottomFillColor2: 'rgba(239,68,68,.28)'
    });
  }

  function makeChart(host, cfg) {
    return loadLWC().then((LWC) => {
      if (!document.body.contains(host)) return null;
      host.classList.add('wc-chart-host');
      host.__wcLwc = true;
      host.removeAttribute('data-chart');
      host.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.className = 'wc-lwc';
      wrap.id = 'wcLwcHost';
      host.appendChild(wrap);
      const data = cfg.data && cfg.data.length >= 2 ? cfg.data : [{ time: Math.floor(Date.now() / 1000) - 60, value: 100 }, { time: Math.floor(Date.now() / 1000), value: 100 }];
      const defaultBase = Number(cfg.baseline) > 0 ? Number(cfg.baseline) : Number(data[0].value) || 100;
      const side = cfg.side === 'short' ? 'short' : 'long';
      const chart = LWC.createChart(wrap, {
        width: wrap.clientWidth || host.clientWidth || 320,
        height: 240,
        layout: {
          background: { type: LWC.ColorType.Solid, color: 'transparent' },
          textColor: '#8ba4b6',
          fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
          fontSize: 11
        },
        grid: {
          vertLines: { color: 'rgba(255,255,255,.035)', style: LWC.LineStyle.Dotted },
          horzLines: { color: 'rgba(255,255,255,.055)', style: LWC.LineStyle.Dotted }
        },
        rightPriceScale: { borderColor: 'rgba(255,255,255,.10)', scaleMargins: { top: 0.12, bottom: 0.12 } },
        timeScale: {
          borderColor: 'rgba(255,255,255,.10)',
          timeVisible: true,
          secondsVisible: true,
          rightOffset: 4,
          barSpacing: 5,
          fixLeftEdge: false
        },
        crosshair: {
          mode: LWC.CrosshairMode.Normal,
          vertLine: { color: 'rgba(46,230,201,.45)', width: 1, style: LWC.LineStyle.Dashed, labelBackgroundColor: '#0f2333' },
          horzLine: { color: 'rgba(46,230,201,.45)', width: 1, style: LWC.LineStyle.Dashed, labelBackgroundColor: '#0f2333' }
        },
        localization: { priceFormatter: (p) => (cfg.mode === 'portfolio' ? Number(p).toFixed(2) + ' WC' : priceBoth(p)) },
        handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
        handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true }
      });
      const series = chart.addBaselineSeries({
        baseValue: { type: 'price', price: defaultBase },
        topLineColor: '#22c55e', topFillColor1: 'rgba(34,197,94,.28)', topFillColor2: 'rgba(34,197,94,.02)',
        bottomLineColor: '#ef4444', bottomFillColor1: 'rgba(239,68,68,.02)', bottomFillColor2: 'rgba(239,68,68,.28)',
        lineWidth: 2, priceLineVisible: false, lastValueVisible: true,
        crosshairMarkerVisible: true, crosshairMarkerRadius: 4,
        crosshairMarkerBorderColor: '#04101a', crosshairMarkerBackgroundColor: side === 'short' ? '#ef4444' : '#22c55e'
      });
      applyBaselineColors(series, side);
      series.setData(data);
      chart.timeScale().fitContent();

      /* USD + WC crosshair tooltip */
      const tip = document.createElement('div');
      tip.className = 'wc-chart-tip';
      tip.style.display = 'none';
      wrap.appendChild(tip);
      const moveTip = (param) => {
        if (!param || !param.point || !param.seriesData || !param.seriesData.get(series)) { tip.style.display = 'none'; return; }
        const val = Number(param.seriesData.get(series).value) || 0;
        const tm = param.time ? new Date(Number(param.time) * 1000) : new Date();
        const timeTxt = tm.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        tip.innerHTML = cfg.mode === 'portfolio'
          ? '<b>' + val.toFixed(2) + ' WC</b><span>$' + (val * 0.5).toFixed(2) + ' USD · ' + timeTxt + '</span>'
          : '<b>' + priceBoth(val) + '</b><span>' + timeTxt + '</span>';
        const x = Math.max(6, Math.min(wrap.clientWidth - 150, param.point.x + 12));
        const y = Math.max(6, param.point.y - 40);
        tip.style.left = x + 'px';
        tip.style.top = y + 'px';
        tip.style.display = 'block';
      };
      chart.subscribeCrosshairMove(moveTip);
      wrap.addEventListener('mouseleave', () => { tip.style.display = 'none'; });

      /* live position banner (spot holding) */
      const banner = document.createElement('div');
      banner.className = 'wc-pos-banner';
      banner.style.display = 'none';
      wrap.appendChild(banner);

      MK.chart = {
        mode: cfg.mode || 'stock', ticker: cfg.ticker || '', chart, series, host, wrap, LWC,
        basePrice: defaultBase, defaultBase, side, banner,
        lastTime: data[data.length - 1].time,
        points: data.length, lines: [], lineKey: ''
      };
      syncPriceLines();
      try {
        const q0 = (typeof INV !== 'undefined' && INV.quote) ? INV.quote(cfg.ticker) : null;
        updatePositionBanner(MK.chart, (q0 && q0.price) || defaultBase);
      } catch (e) {}
      if (typeof ResizeObserver !== 'undefined') {
        MK.chart.ro = new ResizeObserver(() => {
          if (!MK.chart || MK.chart.chart !== chart) return;
          const width = wrap.clientWidth;
          if (width > 0) chart.applyOptions({ width });
        });
        MK.chart.ro.observe(wrap);
      }
      return MK.chart;
    });
  }

  function updatePositionBanner(c, price) {
    if (!c || !c.banner) return;
    if (c.mode !== 'stock') { c.banner.style.display = 'none'; return; }
    const h = spotHolding(c.ticker);
    if (!h || !(Number(h.shares) > 0) || !(Number(price) > 0)) { c.banner.style.display = 'none'; return; }
    const shares = Number(h.shares) || 0;
    const px = Number(price) || 0;
    const investedUsd = Number(h.investedUsd) > 0 ? Number(h.investedUsd) : shares * (Number(h.avgPrice) || px);
    const valueUsd = shares * px;
    const pnlUsd = valueUsd - investedUsd;
    const pnlCoins = pnlUsd / 0.5;
    const up = pnlUsd >= 0;
    c.banner.innerHTML = '<div class="wc-pos-line"><span>Position value</span><b>' + usd(valueUsd) + ' <i>(' + (Math.round((valueUsd / 0.5) * 100) / 100).toFixed(2) + ' WC)</i></b></div>' +
      '<div class="wc-pos-line"><span>Unrealized P&amp;L</span><b class="' + (up ? 'up' : 'down') + '">' + (up ? '+' : '−') + usd(Math.abs(pnlUsd)) + ' <i>(' + (up ? '+' : '−') + Math.abs(pnlCoins).toFixed(2) + ' WC)</i></b></div>';
    c.banner.style.display = 'block';
  }

  function syncPriceLines() {
    const c = MK.chart;
    if (!c || c.mode !== 'stock') return;
    const pos = positionFor(c.ticker);
    const key = pos ? [pos.id, pos.entryPrice, pos.takeProfitPrice, pos.stopLossPrice, pos.trailingActive, pos.trailingStopPct].join('|') : 'none';
    if (c.lineKey === key) return;
    (c.lines || []).forEach((line) => { try { c.series.removePriceLine(line); } catch (e) {} });
    c.lines = [];
    c.lineKey = key;
    if (!pos) return;
    const add = (price, color, title, style) => {
      if (!(Number(price) > 0)) return;
      try {
        c.lines.push(c.series.createPriceLine({
          price: Number(price), color, lineWidth: 1, lineStyle: style,
          axisLabelVisible: true, title
        }));
      } catch (e) {}
    };
    add(pos.entryPrice, '#60a5fa', 'Entry ' + priceBoth(pos.entryPrice), 2);
    add(pos.takeProfitPrice, '#22c55e', 'TP ' + priceBoth(pos.takeProfitPrice), 0);
    add(pos.stopLossPrice, '#ef4444', (pos.trailingActive ? 'TSL ' : 'SL ') + priceBoth(pos.stopLossPrice), 0);
  }

  async function mountChart() {
    const host = document.querySelector('.inv-chart[data-lt-live-chart], .inv-chart[data-chart]');
    if (!host) { destroyChart(); return; }
    const ticker = (host.getAttribute('data-lt-live-chart') || (host.getAttribute('data-chart') || '').split('|')[0] || currentTicker()).toUpperCase();
    if (!ticker) return;
    if (MK.chart && MK.chart.mode === 'stock' && MK.chart.ticker === ticker && document.body.contains(MK.chart.host)) {
      host.__wcLwc = true;
      updateChart();
      return;
    }
    destroyChart();
    host.innerHTML = '<div class="wc-lwc-loading">Loading live chart…</div>';
    const data = await stockData(ticker);
    const pos = positionFor(ticker);
    try {
      await makeChart(host, {
        mode: 'stock', ticker, data,
        baseline: pos ? Number(pos.entryPrice) : Number(data[0].value),
        side: pos ? pos.side : 'long'
      });
    } catch (e) {
      MK.chartLoading = null;
      try { host.classList.remove('wc-chart-host'); host.innerHTML = INV.lineChart(INV.series(ticker, '1D'), { h: 150 }); } catch (err) {}
    }
  }

  function portfolioTimeline(vals, tf) {
    const windows = { '1D': 864e5, '1W': 7 * 864e5, '1M': 30 * 864e5, '3M': 90 * 864e5, '1Y': 365 * 864e5, 'ALL': 730 * 864e5 };
    const win = (windows[tf] || windows['1M']) / 1000;
    const now = Math.floor(Date.now() / 1000);
    const n = vals.length;
    const step = n > 1 ? win / (n - 1) : 3600;
    return vals.map((v, i) => ({ time: Math.floor(now - (n - 1 - i) * step), value: Math.max(0, Number(v) || 0) }));
  }

  function portfolioSig() {
    try {
      if (typeof LT === 'undefined' || !LT.positions) return '';
      return (LT.positions(me().id) || []).map((p) => [p.kind, p.ticker, p.trade ? p.trade.id : (p.holding ? p.holding.id : '')].join(':')).join('|');
    } catch (e) { return ''; }
  }
  MK.portfolioSig = '';

  async function mountPortfolioChart(force) {
    const host = document.getElementById('ltDashChart');
    if (!host || typeof LT === 'undefined' || !LT.seriesWithTrades) return;
    const sig = portfolioSig();
    if (!force && MK.chart && MK.chart.mode === 'portfolio' && MK.chart.host === host && MK.chart.portfolioSig === sig) { updateChart(); return; }
    let vals = [];
    const tf = host.getAttribute('data-ltd-chart') || '1M';
    try { vals = LT.seriesWithTrades(tf, me().id) || []; } catch (e) {}
    if (vals.length < 2) {
      if (MK.chart && MK.chart.mode === 'portfolio') destroyChart();
      host.__wcLwc = false;
      host.classList.remove('wc-chart-host');
      return;
    }
    destroyChart();
    try {
      await makeChart(host, {
        mode: 'portfolio', ticker: '__portfolio__',
        data: portfolioTimeline(vals, tf),
        baseline: Number(vals[0]) || 0, side: 'long'
      });
      if (MK.chart) { MK.chart.portfolioSig = sig; MK.portfolioSig = sig; }
    } catch (e) { /* legacy chart remains if the CDN is unavailable */ }
  }

  window.addEventListener('wc:trade-opened', () => {
    MK.portfolioSig = '';
    if (document.getElementById('ltDashChart')) setTimeout(() => mountPortfolioChart(true), 250);
  });
  window.addEventListener('wc:trade-closed', () => {
    MK.portfolioSig = '';
    if (document.getElementById('ltDashChart')) setTimeout(() => mountPortfolioChart(true), 250);
  });

  function appendPoint(c, time, value) {
    try {
      c.series.update({ time, value: Number(value) });
      c.lastTime = time;
      c.points += 1;
    } catch (e) { /* out-of-order tick */ }
  }

  function updateChart() {
    const c = MK.chart;
    if (!c) return;
    if (!document.body.contains(c.host)) { destroyChart(); return; }
    if (c.mode === 'portfolio') {
      const sig = portfolioSig();
      if (c.portfolioSig !== sig) { mountPortfolioChart(true); return; }
      let s = null;
      try { s = LT.summary(me().id); } catch (e) { return; }
      if (!s) return;
      const now = Math.floor(Date.now() / 1000);
      const time = now > c.lastTime ? now : c.lastTime + 1;
      appendPoint(c, time, s.valueCoins);
      return;
    }
    const ticker = c.ticker;
    let q;
    try { q = INV.quote(ticker); } catch (e) { return; }
    if (!q || !(q.price > 0)) return;
    const pos = positionFor(ticker);
    const targetBase = pos ? Number(pos.entryPrice) : c.defaultBase;
    const targetSide = pos ? (pos.side === 'short' ? 'short' : 'long') : 'long';
    if (Math.abs(targetBase - c.basePrice) > 0.000001 || targetSide !== c.side) {
      c.basePrice = targetBase;
      c.side = targetSide;
      c.series.applyOptions({ baseValue: { type: 'price', price: targetBase } });
      applyBaselineColors(c.series, targetSide);
    }
    syncPriceLines();
    updatePositionBanner(c, q.price);
    const now = Math.floor(Date.now() / 1000);
    const time = now > c.lastTime ? now : c.lastTime + 1;
    appendPoint(c, time, q.price);
    if (c.points > 900) {
      stockData(ticker).then((fresh) => {
        if (!MK.chart || MK.chart !== c) return;
        c.series.setData(fresh);
        c.lastTime = fresh[fresh.length - 1].time;
        c.points = fresh.length;
      });
    }
  }

  /* ------------------------------ admin panel ------------------------------- */
  function dividendSettingsHTML() {
    const inv = (typeof DB !== 'undefined' && DB && DB.invest) || {};
    const stocks = (typeof INV !== 'undefined' && INV.stocks) ? INV.stocks().sort((a, b) => a.ticker.localeCompare(b.ticker)) : [];
    const ys = inv.dividendYields || {};
    const ov = inv.dividendOverrides || {};
    const mult = Number(inv.dividendMultiplier) > 0 ? Number(inv.dividendMultiplier) : 1;
    const rule = inv.dividendPayoutMode || 'all';
    const synced = inv.dividendSyncedAt ? new Date(inv.dividendSyncedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'not synced';
    return `<div class="card" id="divSettingsCard">
      <div class="between" style="align-items:flex-start;gap:10px">
        <div><div class="card-title" style="margin:0">Dividends &amp; duration bonus</div>
          <div class="tiny muted" style="margin-top:3px">Synced from Alpaca Corporate Actions · paid only when a timer trade completes.</div></div>
        <span class="badge ${inv.dividendSource === 'alpaca' ? 'badge-success' : 'badge-warn'}">${inv.dividendSource === 'alpaca' ? 'Alpaca' : (inv.dividendSource || 'Not synced')}</span>
      </div>
      <div class="div-settings-grid">
        <div class="field"><label class="label">Dividend bonus multiplier</label>
          <input class="input" id="divMultiplier" type="number" step="0.1" min="0" max="10" value="${mult}"/>
          <div class="tiny muted mt6">1× = exact yield proration</div></div>
        <div class="field"><label class="label">Payout rule (timer closes)</label>
          <select class="input" id="divPayoutMode">
            <option value="all" ${rule === 'all' ? 'selected' : ''}>Pay on all completed timer trades</option>
            <option value="wins" ${rule === 'wins' ? 'selected' : ''}>Pay on winning timer trades only</option>
          </select>
          <div class="tiny muted mt6">TP/SL/manual exits do not earn the dividend.</div></div>
      </div>
      <div class="div-yield-head"><span>Symbol</span><span>Synced yield</span><span>Override %</span></div>
      <div class="div-yield-list">
        ${stocks.map(s => {
          const auto = ys[s.ticker] != null ? Number(ys[s.ticker]) : 0;
          const o = ov[s.ticker];
          return `<div class="div-yield-row">
            <b>${escMarket(s.ticker)}</b>
            <span class="${auto > 0 ? 'up' : 'muted'}">${auto.toFixed(2)}%</span>
            <input class="input div-ov" data-div-ticker="${escMarket(s.ticker)}" type="number" step="0.01" min="0" max="100" value="${o != null ? o : ''}" placeholder="${auto.toFixed(2)}"/>
          </div>`;
        }).join('')}
      </div>
      <div class="tiny muted" style="margin-top:8px">Last sync: ${escMarket(synced)} · source: ${escMarket(inv.dividendSource || 'not synced')} · floor 0.01 WC on dividend-paying symbols.</div>
      <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
        <button class="btn btn-primary" data-act="div-save">Save dividend settings</button>
        <button class="btn btn-soft" data-act="div-sync">Sync dividends now</button>
        <button class="btn btn-ghost" data-act="div-reset">Reset overrides</button>
      </div>
      <div class="tiny muted mt6" id="divSyncNote">Leave an override blank to use the Alpaca-synced annual yield. Overrides are locked at trade entry.</div>
    </div>`;
  }

  function tradingGuideHTML() {
    return `<div class="card admin-guide" id="tradingGuideCard">
      <div class="between" style="align-items:flex-start;gap:10px">
        <div><div class="card-title" style="margin:0">Trading guide for admins</div>
          <div class="tiny muted" style="margin-top:3px">Alpaca live data · USD spot trading · WC settlement</div></div>
        <span class="badge badge-accent">Admin only</span>
      </div>
      <div class="guide-facts">
        <div><b>1 WC</b><span>$0.50</span></div>
        <div><b>Feed</b><span>Alpaca IEX</span></div>
        <div><b>Loss cap</b><span>Invested USD</span></div>
        <div><b>Settlement</b><span>Every second</span></div>
      </div>
      <details class="guide-sec" open>
        <summary>1 · Spot Buy / Sell</summary>
        <ol class="guide-steps">
          <li><b>Quote.</b> The effective price is <code>Raw Alpaca price × (1 + Override % / 100)</code>. The ticket shows USD and WC.</li>
          <li><b>Buy.</b> USD amount ÷ effective price = shares. WC cost = USD ÷ 0.50. TP, SL and due time are optional.</li>
          <li><b>Close.</b> Manual sell, TP, SL or due time closes the position at the live effective price. Payout = shares × exit price ÷ 0.50.</li>
        </ol>
        <div class="guide-note">The backend settles every second even when no browser is open. One atomic guard prevents a manual sell and an automatic trigger from double-paying.</div>
      </details>
      <details class="guide-sec">
        <summary>2 · Price Override %</summary>
        <p>Each stock can carry its own override. <b>+5%</b> makes a $200 raw quote show and trade at $210 (420 WC). Overrides apply to live ticks, chart bars, TP/SL and payouts. Use <b>0</b> for the raw Alpaca price.</p>
      </details>
      <details class="guide-sec">
        <summary>3 · Alpaca connection &amp; sync</summary>
        <ul class="guide-list">
          <li>Keys are stored only on the server (file mode 0600 and Postgres), never in the synced database or browsers.</li>
          <li><b>Paper / Sandbox</b> uses the paper trading host for assets and corporate actions; <b>Live Data</b> uses the live host.</li>
          <li>Sync pulls tradable US equities, snapshots, 1-minute bars and trailing dividends. Scheduled sync defaults to every 60 minutes and can be turned off.</li>
        </ul>
      </details>
    </div>`;
  }

  function adminCardHTML() {
    const syncOptions = [5, 15, 30, 60, 240, 720, 1440];
    return `<div class="card" id="mktFeedCard">
      <div class="between" style="align-items:flex-start;gap:10px">
        <div><div class="card-title" style="margin:0">Market data · Alpaca</div>
          <div class="tiny muted" style="margin-top:3px">Server-side REST + IEX WebSocket. Keys never reach a browser.</div></div>
        <span class="badge badge-warn" id="mktModeBadge">Loading…</span>
      </div>
      <div class="field" style="margin-top:12px"><label class="label">Alpaca API Key ID</label>
        <input class="input" id="alpKeyId" autocomplete="off" placeholder="AK…"/>
        <div class="tiny muted mt6" id="alpKeyHint">Stored only on the server (file mode 0600 + Postgres), never in the synced app database.</div></div>
      <div class="field"><label class="label">Alpaca Secret Key</label>
        <input class="input" id="alpSecret" type="password" autocomplete="new-password" placeholder="Paste the secret key"/>
        <div class="tiny muted mt6">Leave blank to keep the saved secret. Get both keys at
          <a href="https://app.alpaca.markets/paper/dashboard/overview" target="_blank" rel="noopener" style="color:var(--accent)">app.alpaca.markets → API Keys</a>.</div></div>
      <div class="mkt-endpoint">
        <div><span class="tiny muted">API endpoint</span>
          <code id="alpEndpoint">https://paper-api.alpaca.markets/v2</code></div>
        <div class="tiny muted">Set automatically from the environment — paper keys use the paper host, live keys use <code>api.alpaca.markets</code>. Data is always read from <code>data.alpaca.markets</code>.</div>
      </div>
      <div class="row" style="gap:8px;flex-wrap:wrap;align-items:flex-end">
        <div class="field grow" style="margin:0;min-width:180px"><label class="label">Environment</label>
          <select class="input" id="alpMode">
            <option value="paper">Paper / Sandbox</option>
            <option value="live">Live Data</option>
          </select></div>
        <div class="field" style="margin:0;min-width:150px"><label class="label">Feed</label>
          <select class="input" id="alpFeed">
            <option value="iex">IEX (free)</option>
            <option value="sip">SIP (subscription)</option>
          </select></div>
        <div class="field" style="margin:0;width:150px"><label class="label">Refresh (seconds)</label>
          <input class="input" id="alpRefresh" type="number" min="5" max="300" step="1" value="15"/></div>
      </div>
      <div class="row" style="gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:8px">
        <div class="field grow" style="margin:0;min-width:180px"><label class="label">Sync schedule</label>
          <div class="row" style="gap:8px;align-items:center">
            <label class="checkline tiny muted" style="margin:0"><input type="checkbox" id="alpSyncEnabled"/> Auto-sync</label>
            <select class="input" id="alpSyncInterval" style="width:auto">
              ${syncOptions.map((m) => `<option value="${m}">${m < 60 ? 'Every ' + m + ' min' : 'Every ' + (m / 60) + ' hour' + (m === 60 ? '' : 's')}</option>`).join('')}
            </select>
          </div>
          <div class="tiny muted mt6">Assets, prices and dividends refresh in the background.</div></div>
      </div>
      <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
        <button class="btn btn-primary" data-act="mkt-save">Test Connection &amp; Save</button>
        <button class="btn btn-soft" data-act="mkt-sync-all">Sync Now from Alpaca</button>
        <label class="checkline tiny muted" style="margin-left:auto"><input type="checkbox" id="alpClearKeys"/> Clear saved keys</label>
      </div>
      <div class="mkt-status" id="mktStatus">Reading Alpaca status…</div>
      <div class="tiny muted" style="margin-top:6px;line-height:1.6">
        Live trades arrive on <b>wss://stream.data.alpaca.markets/v2/iex</b>; history uses Alpaca 1-minute bars.
        Override %, TP/SL and WC payouts are applied by this server, so every browser and every closed app sees the same effective price.
      </div>
    </div>`;
  }

  function stockOverridesHTML() {
    return `<div class="card" id="stockOverridesCard">
      <div class="between" style="align-items:flex-start;gap:10px">
        <div><div class="card-title" style="margin:0">Stocks · raw price, override &amp; effective price</div>
          <div class="tiny muted" style="margin-top:3px">Effective = Raw Alpaca price × (1 + Override % / 100). Applies to ticks, charts, TP/SL and payouts.</div></div>
        <span class="badge badge-accent">Admin</span>
      </div>
      <div id="stockOverridesBody"><div class="tiny muted" style="margin-top:10px">Loading stocks…</div></div>
      <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
        <button class="btn btn-primary" data-act="stock-overrides-save">Save overrides</button>
        <button class="btn btn-ghost" data-act="stock-overrides-reload">Reload table</button>
      </div>
    </div>`;
  }

  function paintAdminStatus() {
    const card = document.getElementById('mktFeedCard');
    if (!card) return;
    if (!MK.adminLoaded) loadAdminConfig();
    const badge = document.getElementById('mktModeBadge');
    const box = document.getElementById('mktStatus');
    const st = (MK.feed && MK.feed.status) || (MK.config && MK.config.status) || {};
    if (badge) {
      const live = st.source === 'live' && st.hasKeys;
      badge.className = 'badge ' + (live ? 'badge-success' : 'badge-warn');
      badge.textContent = live
        ? (st.wsConnected ? 'Live · Alpaca WS' : 'Connected · REST')
        : (st.hasKeys ? 'Alpaca · connecting' : 'Alpaca keys missing');
    }
    if (!box) return;
    const when = (ms) => ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
    box.innerHTML = `
      <div class="mkt-stat"><span>Notice</span><b>${escMarket(st.notice || noticeText())}</b></div>
      <div class="mkt-stat"><span>Environment</span><b>${escMarket(st.environment || (st.mode === 'live' ? 'Live Data' : 'Paper / Sandbox'))}</b></div>
      <div class="mkt-stat"><span>Alpaca WebSocket</span><b class="${st.wsConnected ? 'up' : 'down'}">${st.wsConnected ? (st.wsAuthed ? 'authenticated' : 'connecting') : 'offline'}</b></div>
      <div class="mkt-stat"><span>Market</span><b>${st.marketOpen ? 'US session open' : 'US market closed'}</b></div>
      <div class="mkt-stat"><span>Last real tick</span><b>${when(st.lastRealAt)}</b></div>
      <div class="mkt-stat"><span>Last stream tick</span><b>${when(st.lastWsTickAt)}</b></div>
      <div class="mkt-stat"><span>Rate limit</span><b class="${st.rateLimitedUntil ? 'down' : 'up'}">${st.rateLimitedUntil ? 'cooling down' : 'clear'}</b></div>
      <div class="mkt-stat"><span>Unpriced assets</span><b class="${(st.unpriced || 0) ? 'down' : 'up'}">${st.unpriced || 0}</b></div>
      <div class="mkt-stat"><span>Live stock prices</span><b class="${(st.seed && !st.seed.failed) ? 'up' : 'down'}">${(st.seed ? st.seed.live : 0)} / ${st.tickers || 0}</b></div>
      <div class="mkt-stat"><span>Dividend sync</span><b class="${(st.dividends && !st.dividends.failed) ? 'up' : 'down'}">${(st.dividends ? st.dividends.live : 0)} / ${(st.dividends ? st.dividends.tickers : 0)}</b></div>
      <div class="mkt-stat"><span>API calls / min</span><b class="${st.apiCallsLastMin > (st.apiBudgetPerMin || 180) ? 'down' : 'up'}">${st.apiCallsLastMin || 0} / ${st.apiBudgetPerMin || 180}</b></div>
      <div class="mkt-stat"><span>Auto sync</span><b class="${st.sync && st.sync.enabled ? 'up' : 'down'}">${st.sync && st.sync.enabled ? 'every ' + st.sync.intervalMin + ' min' : 'off'}</b></div>
      <div class="mkt-stat"><span>Last full sync</span><b>${st.sync && st.sync.lastSyncAt ? when(st.sync.lastSyncAt) : 'never'}</b></div>
      ${st.dividends && st.dividends.failed ? `<div class="mkt-stat"><span>Dividend retry queue</span><b class="down">${escMarket((st.dividends.failedTickers || []).join(', '))}</b></div>` : ''}
      ${st.lastError ? `<div class="mkt-stat"><span>Last error</span><b class="down">${escMarket(st.lastError)}</b></div>` : ''}`;
    const body = document.getElementById('stockOverridesBody');
    if (body && !body.dataset.loaded && !MK.stockLoading) loadStockOverrides();
  }

  async function loadAdminConfig(force) {
    const card = document.getElementById('mktFeedCard');
    if (!card || (MK.adminLoaded && !force) || MK.adminLoading) return;
    if (typeof Remote === 'undefined' || !Remote.enabled) return;
    MK.adminLoading = true;
    try {
      const meId = (typeof me === 'function' && me()) ? me().id : '';
      const r = await getJSON('/api/market/config?adminId=' + encodeURIComponent(meId), {}, 7000);
      if (!r.res || !r.res.ok || !r.data || !r.data.ok) return;
      MK.config = r.data;
      MK.adminLoaded = true;
      const keyId = document.getElementById('alpKeyId');
      const secret = document.getElementById('alpSecret');
      const mode = document.getElementById('alpMode');
      const feed = document.getElementById('alpFeed');
      const refresh = document.getElementById('alpRefresh');
      const syncOn = document.getElementById('alpSyncEnabled');
      const syncMin = document.getElementById('alpSyncInterval');
      const hint = document.getElementById('alpKeyHint');
      if (keyId) keyId.placeholder = r.data.hasKeys ? 'Saved key ' + r.data.keyIdMasked + ' — leave blank to keep' : 'AK…';
      if (secret) secret.placeholder = r.data.hasKeys ? 'Saved secret — leave blank to keep' : 'Paste the secret key';
      if (mode) mode.value = r.data.mode;
      paintEndpoint(r.data.mode);
      if (feed) feed.value = r.data.feed;
      if (refresh) refresh.value = r.data.refreshSec;
      if (syncOn) syncOn.checked = r.data.syncEnabled !== false;
      if (syncMin) syncMin.value = String(r.data.syncIntervalMin || 60);
      if (hint) hint.textContent = r.data.hasKeys
        ? 'Keys are saved on the server (' + r.data.keyIdMasked + '). Leave both blank to keep them.'
        : 'No Alpaca keys saved yet. Add the Key ID and Secret Key, then Test Connection & Save.';
      paintAdminStatus();
    } catch (e) { /* keep static card */ }
    finally { MK.adminLoading = false; }
  }

  function paintEndpoint(mode) {
    const el = document.getElementById('alpEndpoint');
    if (!el) return;
    el.textContent = String(mode || (document.getElementById('alpMode') || {}).value || 'paper') === 'live'
      ? 'https://api.alpaca.markets/v2'
      : 'https://paper-api.alpaca.markets/v2';
  }

  function adminToast(msg, type) { if (typeof toast === 'function') toast(msg, type || 'ok'); }

  async function loadStockOverrides(force) {
    const body = document.getElementById('stockOverridesBody');
    if (!body || MK.stockLoading) return;
    if (!force && body.dataset.loaded) return;
    if (typeof Remote === 'undefined' || !Remote.enabled) return;
    MK.stockLoading = true;
    try {
      const meId = (typeof me === 'function' && me()) ? me().id : '';
      const r = await getJSON('/api/market/admin/stocks?adminId=' + encodeURIComponent(meId), {}, 15000);
      if (!r.res || !r.res.ok || !r.data || !r.data.ok) throw new Error((r.data && r.data.error) || 'Could not load stocks');
      MK.stocks = r.data.stocks || [];
      body.innerHTML = stockTableHTML(MK.stocks);
      body.dataset.loaded = '1';
    } catch (e) {
      body.innerHTML = '<div class="tiny muted" style="margin-top:10px">' + escMarket(e.message) + '</div>';
    } finally { MK.stockLoading = false; }
  }

  function stockTableHTML(stocks) {
    if (!stocks.length) return '<div class="tiny muted" style="margin-top:10px">No stocks yet. Use Sync Now from Alpaca.</div>';
    return `<div class="table-wrap"><table class="tbl ov-table"><thead><tr>
      <th>Symbol</th><th>Company</th><th>Raw Alpaca</th><th>Override %</th><th>Effective price</th><th>Dividend</th><th>Active</th>
    </tr></thead><tbody>
      ${stocks.map((s) => `<tr data-ov-row="${escMarket(s.ticker)}">
        <td style="font-weight:700">${escMarket(s.symbol)}</td>
        <td class="ellipsis" style="max-width:150px">${escMarket(s.name)}</td>
        <td class="num">$${Number(s.rawPrice || 0).toFixed(2)}</td>
        <td><input class="input ov-input" data-ov="override" type="number" step="0.01" value="${Number(s.overridePct) || 0}" style="width:78px"/></td>
        <td class="num"><b data-ov-effective>$${Number(s.price || 0).toFixed(2)}</b><div class="tiny muted">${(Number(s.price || 0) / 0.5).toFixed(2)} WC</div></td>
        <td class="num">${Number(s.dividendYield || 0).toFixed(2)}%</td>
        <td><label class="checkline" style="margin:0"><input type="checkbox" data-ov="active" ${s.active !== false ? 'checked' : ''}/></label></td>
      </tr>`).join('')}
    </tbody></table></div>
    <div class="tiny muted" style="margin-top:6px">Raw ${stocks.length} symbol${stocks.length === 1 ? '' : 's'} · every effective price is shown in USD and WC.</div>`;
  }

  if (typeof App !== 'undefined') {
    App.mktSave = async function () {
      if (typeof Remote === 'undefined' || !Remote.enabled) return adminToast('Connect the sync server first — market data runs on the backend', 'err');
      const btn = document.querySelector('[data-act="mkt-save"]');
      if (btn) { btn.disabled = true; btn.textContent = 'Testing…'; }
      try {
        const meId = (typeof me === 'function' && me()) ? me().id : '';
        const body = {
          adminId: meId,
          mode: (document.getElementById('alpMode') || {}).value || 'paper',
          feed: (document.getElementById('alpFeed') || {}).value || 'iex',
          refreshSec: Number((document.getElementById('alpRefresh') || {}).value) || 15,
          syncEnabled: !!((document.getElementById('alpSyncEnabled') || {}).checked),
          syncIntervalMin: Number((document.getElementById('alpSyncInterval') || {}).value) || 60,
          clearKeys: !!((document.getElementById('alpClearKeys') || {}).checked)
        };
        const keyId = ((document.getElementById('alpKeyId') || {}).value || '').trim();
        const secret = ((document.getElementById('alpSecret') || {}).value || '').trim();
        if (keyId) body.keyId = keyId;
        if (secret) body.secret = secret;
        const r = await getJSON('/api/market/config', { method: 'POST', body: JSON.stringify(body) }, 20000);
        if (!r.res || !r.res.ok || !r.data || !r.data.ok) {
          return adminToast((r.data && (r.data.message || r.data.error)) || 'Could not save Alpaca settings', 'err');
        }
        MK.config = r.data;
        MK.adminLoaded = false;
        try {
          const t = await getJSON('/api/market/test', { method: 'POST', body: JSON.stringify({ adminId: meId }) }, 20000);
          const td = (t.data || {});
          adminToast(td.ok ? 'Alpaca connection OK · AAPL $' + Number(td.price).toFixed(2) : ('Saved, but: ' + (td.message || 'connection test failed')), td.ok ? 'ok' : 'err');
        } catch (e) { adminToast('Settings saved — connection test unavailable', 'err'); }
        try { await poll(); } catch (e) {}
        loadStockOverrides(true);
        loadAudit(true);
        loadHealth();
        if (typeof render === 'function') render();
      } catch (e) {
        adminToast('Save failed: ' + e.message, 'err');
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = 'Test Connection &amp; Save'; }
      }
    };

    App.mktSyncAll = async function () {
      if (typeof Remote === 'undefined' || !Remote.enabled) return adminToast('Connect the sync server first', 'err');
      const btn = document.querySelector('[data-act="mkt-sync-all"]');
      if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }
      try {
        const meId = (typeof me === 'function' && me()) ? me().id : '';
        const r = await getJSON('/api/market/sync-all', { method: 'POST', body: JSON.stringify({ adminId: meId }) }, 20000);
        if (!r.res || !r.res.ok || !r.data || !r.data.ok) return adminToast((r.data && r.data.error) || 'Sync could not start', 'err');
        adminToast('Alpaca sync started — assets, prices and dividends', 'ok');
        setTimeout(() => { try { poll(); paintAdminStatus(); loadStockOverrides(true); loadAudit(true); loadHealth(); } catch (e) {} }, 5000);
        setTimeout(() => { try { poll(); paintAdminStatus(); loadStockOverrides(true); loadAudit(true); loadHealth(); } catch (e) {} }, 15000);
      } catch (e) {
        adminToast('Sync failed: ' + e.message, 'err');
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Sync Now from Alpaca'; }
      }
    };

    App.stockOverridesReload = function () { loadStockOverrides(true); };

    App.stockOverridesSave = async function () {
      if (typeof Remote === 'undefined' || !Remote.enabled) return adminToast('Connect the sync server first', 'err');
      const meId = (typeof me === 'function' && me()) ? me().id : '';
      const updates = [];
      document.querySelectorAll('[data-ov-row]').forEach((row) => {
        const ticker = row.getAttribute('data-ov-row');
        const ov = row.querySelector('[data-ov="override"]');
        const active = row.querySelector('[data-ov="active"]');
        updates.push({ ticker, overridePct: Number(ov && ov.value) || 0, paused: !(active && active.checked) });
      });
      try {
        const r = await getJSON('/api/market/admin/stocks', { method: 'POST', body: JSON.stringify({ adminId: meId, updates }) }, 20000);
        if (!r.res || !r.res.ok || !r.data || !r.data.ok) return adminToast((r.data && r.data.error) || 'Save failed', 'err');
        MK.stocks = r.data.stocks || [];
        const body = document.getElementById('stockOverridesBody');
        if (body) body.innerHTML = stockTableHTML(MK.stocks);
        try { await Remote.refresh(true); } catch (e) {}
        try { await poll(); } catch (e) {}
        adminToast('Price overrides saved and applied to live ticks', 'ok');
        loadAudit(true);
        loadHealth();
      } catch (e) { adminToast('Save failed: ' + e.message, 'err'); }
    };

    App.mktTest = async function () {
      if (typeof Remote === 'undefined' || !Remote.enabled) return adminToast('Connect the sync server first', 'err');
      const meId = (typeof me === 'function' && me()) ? me().id : '';
      try {
        const r = await getJSON('/api/market/test', { method: 'POST', body: JSON.stringify({ adminId: meId }) }, 20000);
        const d = r.data || {};
        adminToast(d.ok ? `Alpaca OK · AAPL $${Number(d.price).toFixed(2)}` : (d.message || 'Alpaca test failed'), d.ok ? 'ok' : 'err');
        loadHealth();
        loadAudit(true);
      } catch (e) { adminToast('Test failed: ' + e.message, 'err'); }
    };
  }

  if (typeof App !== 'undefined') {
    App.divSave = function () {
      const multEl = document.getElementById('divMultiplier');
      const modeEl = document.getElementById('divPayoutMode');
      const mult = Number(multEl && multEl.value);
      if (!(mult >= 0 && mult <= 10)) return adminToast('Multiplier must be between 0 and 10', 'err');
      const overrides = {};
      let bad = '';
      document.querySelectorAll('[data-div-ticker]').forEach((inp) => {
        const v = String(inp.value || '').trim();
        if (!v) return;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 100) bad = inp.getAttribute('data-div-ticker');
        else overrides[inp.getAttribute('data-div-ticker')] = Math.round(n * 100) / 100;
      });
      if (bad) return adminToast('Yield for ' + bad + ' must be between 0 and 100%', 'err');
      if (!DB.invest) DB.invest = {};
      DB.invest.dividendMultiplier = mult;
      DB.invest.dividendPayoutMode = modeEl && modeEl.value === 'wins' ? 'wins' : 'all';
      DB.invest.dividendOverrides = overrides;
      try { sync(); } catch (e) {}
      persist();
      adminToast('Dividend settings saved', 'ok');
      render();
    };

    App.divReset = function () {
      if (!DB.invest) DB.invest = {};
      DB.invest.dividendOverrides = {};
      try { sync(); } catch (e) {}
      persist();
      adminToast('Dividend overrides cleared — using Alpaca-synced yields', 'ok');
      render();
    };

    App.divSync = async function () {
      if (typeof Remote === 'undefined' || !Remote.enabled) return adminToast('Connect the sync server first', 'err');
      const btn = document.querySelector('[data-act="div-sync"]');
      if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }
      try {
        const meId = (typeof me === 'function' && me()) ? me().id : '';
        const r = await getJSON('/api/market/dividends/sync', { method: 'POST', body: JSON.stringify({ adminId: meId }) }, 60000);
        if (!r.res || !r.res.ok || !r.data || !r.data.ok) return adminToast((r.data && r.data.error) || 'Dividend sync failed', 'err');
        try { await Remote.refresh(true); } catch (e) {}
        try { await poll(); } catch (e) {}
        adminToast('Dividends synced from Alpaca', 'ok');
        loadAudit(true);
        loadHealth();
        render();
      } catch (e) {
        adminToast('Dividend sync failed: ' + e.message, 'err');
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Sync dividends now'; }
      }
    };
  }

  /* ---------------------- Alpaca health + audit log ----------------------- */
  MK.health = null;
  MK.healthLoading = false;
  MK.audit = [];
  MK.auditTotal = 0;
  MK.auditLoaded = false;
  MK.auditLoading = false;
  MK.auditCategory = 'all';
  MK.auditLimit = 100;

  const AUDIT_LABELS = {
    'connection.saved': 'Connection saved',
    'connection.test': 'Connection test',
    'sync.completed': 'Full data sync',
    'sync.failed': 'Sync failed',
    'sync.dividends': 'Dividend sync',
    'overrides.saved': 'Overrides saved'
  };

  function healthHTML() {
    return `<div class="card" id="mktHealthCard">
      <div class="between" style="align-items:flex-start;gap:10px">
        <div><div class="card-title" style="margin:0">Alpaca health</div>
          <div class="tiny muted" style="margin-top:3px">Credentials, REST, IEX stream, rate budget, scheduled sync and price coverage.</div></div>
        <span class="mkt-health-pill" id="mktHealthPill"><i></i><b>Checking…</b></span>
      </div>
      <div class="mkt-health-top">
        <div class="mkt-health-ring" id="mktHealthRing"><span><b id="mktHealthScore">—</b><i>score</i></span></div>
        <div class="mkt-health-meta" id="mktHealthMeta"><div class="mkt-stat"><span>Status</span><b>Reading Alpaca health…</b></div></div>
      </div>
      <div class="mkt-health-list" id="mktHealthList"><div class="tiny muted">Loading checks…</div></div>
      <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
        <button class="btn btn-xs btn-soft" data-act="mkt-health-refresh">Refresh health</button>
        <button class="btn btn-xs btn-ghost" data-act="mkt-test">Test Alpaca</button>
        <span class="tiny muted" style="margin-left:auto" id="mktHealthStamp"></span>
      </div>
    </div>`;
  }

  function auditHTML() {
    const cats = [['all', 'All'], ['override', 'Overrides'], ['sync', 'Data sync'], ['connection', 'Connection']];
    return `<div class="card" id="mktAuditCard">
      <div class="between" style="align-items:flex-start;gap:10px">
        <div><div class="card-title" style="margin:0">Override &amp; data sync audit log</div>
          <div class="tiny muted" style="margin-top:3px">Durable server-side trail of every override change, sync run and connection update.</div></div>
        <span class="badge badge-accent" id="mktAuditCount">0 entries</span>
      </div>
      <div class="row mkt-audit-tabs" style="gap:6px;margin-top:10px;flex-wrap:wrap">
        ${cats.map((c) => `<button class="btn btn-xs ${MK.auditCategory === c[0] ? 'btn-primary' : 'btn-ghost'}" data-act="mkt-audit-filter" data-cat="${c[0]}">${c[1]}</button>`).join('')}
        <button class="btn btn-xs btn-ghost" data-act="mkt-audit-refresh" style="margin-left:auto">Refresh</button>
        <button class="btn btn-xs btn-ghost" data-act="mkt-audit-csv">CSV</button>
      </div>
      <div id="mktAuditList" class="mkt-audit-list"><div class="tiny muted" style="margin-top:10px">Loading audit trail…</div></div>
      <div class="row" style="margin-top:10px">
        <button class="btn btn-xs btn-soft" data-act="mkt-audit-more" id="mktAuditMore" style="display:none">Load more</button>
      </div>
    </div>`;
  }

  function adminStackHTML() {
    return healthHTML() + adminCardHTML() + stockOverridesHTML() + auditHTML() + tradingGuideHTML();
  }

  function healthStateClass(state) {
    return state === 'ok' ? 'ok' : state === 'warn' ? 'warn' : state === 'error' ? 'err' : 'info';
  }

  function paintHealth(data) {
    const card = document.getElementById('mktHealthCard');
    if (!card || !data) return;
    MK.health = data;
    const score = Math.max(0, Math.min(100, Number(data.score) || 0));
    const grade = String(data.grade || 'unknown');
    const pill = document.getElementById('mktHealthPill');
    if (pill) {
      pill.className = 'mkt-health-pill ' + healthStateClass(score >= 90 ? 'ok' : score >= 70 ? 'warn' : 'error');
      pill.innerHTML = '<i></i><b>' + escMarket(grade) + '</b>';
    }
    const ring = document.getElementById('mktHealthRing');
    if (ring) {
      const color = score >= 90 ? '#22c55e' : score >= 70 ? '#ffb020' : '#ef4444';
      ring.style.background = 'conic-gradient(' + color + ' ' + (score * 3.6) + 'deg, rgba(255,255,255,.07) 0deg)';
    }
    const scoreEl = document.getElementById('mktHealthScore');
    if (scoreEl) scoreEl.textContent = String(score);

    const st = data.status || {};
    const meta = document.getElementById('mktHealthMeta');
    if (meta) {
      const when = (ms) => ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
      const latency = data.latencyMs != null ? data.latencyMs + ' ms' : '—';
      meta.innerHTML = `
        <div class="mkt-stat"><span>Environment</span><b>${escMarket(st.environment || '—')} · ${escMarket(String(st.feed || '').toUpperCase())}</b></div>
        <div class="mkt-stat"><span>REST latency</span><b class="${data.latencyMs != null && data.latencyMs < 1200 ? 'up' : 'down'}">${escMarket(latency)}</b></div>
        <div class="mkt-stat"><span>Last real tick</span><b>${when(st.lastRealAt)}</b></div>
        <div class="mkt-stat"><span>Stream ticks</span><b>${Number(st.wsTicks) || 0}</b></div>
        <div class="mkt-stat"><span>Last connection test</span><b class="${data.lastTestOk === true ? 'up' : data.lastTestOk === false ? 'down' : ''}">${data.lastTestAt ? when(data.lastTestAt) + (data.lastTestOk === true ? ' · OK' : data.lastTestOk === false ? ' · failed' : '') : 'never'}</b></div>
        <div class="mkt-stat"><span>Server uptime</span><b>${Math.floor((Number(data.uptimeSec) || 0) / 60)} min</b></div>`;
    }

    const list = document.getElementById('mktHealthList');
    if (list) {
      list.innerHTML = (data.checks || []).map((c) => `<div class="mkt-health-row">
        <i class="mkt-dot ${healthStateClass(c.state)}"></i>
        <span class="mkt-health-name">${escMarket(c.label)}</span>
        <span class="mkt-health-detail">${escMarket(c.detail)}</span>
      </div>`).join('') || '<div class="tiny muted">No checks returned.</div>';
    }
    const stamp = document.getElementById('mktHealthStamp');
    if (stamp) stamp.textContent = 'Updated ' + new Date(data.at || Date.now()).toLocaleTimeString();
  }

  async function loadHealth() {
    const card = document.getElementById('mktHealthCard');
    if (!card || MK.healthLoading) return;
    MK.healthLoading = true;
    try {
      const r = await getJSON('/api/market/health', {}, 9000);
      if (r.data && r.data.ok) paintHealth(r.data);
      else throw new Error((r.data && r.data.error) || 'Health endpoint unavailable');
    } catch (e) {
      paintHealth({ at: Date.now(), score: 0, grade: 'offline', checks: [{ key: 'api', label: 'Health check', state: 'error', detail: e.message }], status: {} });
    } finally { MK.healthLoading = false; }
  }

  function fmtChange(c) {
    const field = String(c.field || '');
    const f = c.from, t = c.to;
    if (field === 'overridePct') return escMarket(c.ticker || '') + ' ' + (Number(f) || 0).toFixed(2) + '% → ' + (Number(t) || 0).toFixed(2) + '%';
    if (field === 'active') return escMarket(c.ticker || '') + ' ' + (f ? 'active' : 'paused') + ' → ' + (t ? 'active' : 'paused');
    if (field === 'apiKeys') return 'API keys ' + escMarket(f) + ' → ' + escMarket(t);
    if (f == null && t != null) return field + ' ' + escMarket(t);
    return field + ' ' + escMarket(f) + ' → ' + escMarket(t);
  }

  function paintAudit() {
    const box = document.getElementById('mktAuditList');
    if (!box) return;
    const count = document.getElementById('mktAuditCount');
    if (count) count.textContent = (MK.auditTotal || MK.audit.length) + ' entr' + ((MK.auditTotal || MK.audit.length) === 1 ? 'y' : 'ies');
    if (!MK.audit.length) {
      box.innerHTML = '<div class="mkt-audit-empty">No entries yet. Save an override, run a sync or update the connection.</div>';
    } else {
      box.innerHTML = MK.audit.map((e) => {
        const label = AUDIT_LABELS[e.action] || e.action || 'Event';
        const ok = e.result !== 'error';
        const cats = e.category || 'system';
        const changes = (e.changes || []).slice(0, 6).map((c) => `<span class="mkt-audit-chip">${fmtChange(c)}</span>`).join('');
        const more = (e.changes || []).length > 6 ? `<span class="tiny muted">+${e.changes.length - 6} more</span>` : '';
        const dur = e.durationMs != null ? ` · ${(e.durationMs / 1000).toFixed(2)}s` : '';
        return `<div class="mkt-audit-row">
          <div class="mkt-audit-main">
            <div class="mkt-audit-head">
              <b>${escMarket(label)}</b>
              <span class="badge ${ok ? 'badge-success' : 'badge-warn'}">${ok ? 'ok' : 'error'}</span>
              <span class="badge" style="text-transform:uppercase;font-size:9px">${escMarket(cats)}</span>
            </div>
            <div class="tiny muted">${escMarket(e.actor || 'system')} · ${new Date(e.at).toLocaleString()}${dur}</div>
            ${e.summary ? `<div class="small" style="margin-top:3px">${escMarket(e.summary)}</div>` : ''}
            ${changes ? `<div class="mkt-audit-changes">${changes}${more}</div>` : ''}
          </div>
          <div class="mkt-audit-target tiny muted">${escMarket(e.target || '')}</div>
        </div>`;
      }).join('');
    }
    const more = document.getElementById('mktAuditMore');
    if (more) more.style.display = MK.audit.length < (MK.auditTotal || 0) && MK.audit.length >= MK.auditLimit ? '' : 'none';
  }

  async function loadAudit(force) {
    const box = document.getElementById('mktAuditList');
    if (!box || MK.auditLoading) return;
    if (MK.auditLoaded && !force) { paintAudit(); return; }
    if (typeof Remote === 'undefined' || !Remote.enabled) {
      box.innerHTML = '<div class="tiny muted">Connect the sync server to read the server-side audit trail.</div>';
      return;
    }
    MK.auditLoading = true;
    try {
      const meId = (typeof me === 'function' && me()) ? me().id : '';
      const r = await getJSON('/api/market/audit?adminId=' + encodeURIComponent(meId) + '&limit=' + MK.auditLimit + '&category=' + encodeURIComponent(MK.auditCategory), {}, 15000);
      if (!r.res || !r.res.ok || !r.data || !r.data.ok) throw new Error((r.data && (r.data.message || r.data.error)) || 'Could not load audit log');
      MK.audit = Array.isArray(r.data.entries) ? r.data.entries : [];
      MK.auditTotal = Number(r.data.total) || MK.audit.length;
      MK.auditLoaded = true;
      paintAudit();
    } catch (e) {
      box.innerHTML = '<div class="tiny muted">' + escMarket(e.message) + '</div>';
    } finally { MK.auditLoading = false; }
  }

  if (typeof App !== 'undefined') {
    App.mktHealthRefresh = function () { loadHealth(); };
    App.mktAuditRefresh = function () { loadAudit(true); };
    App.mktAuditFilter = function (id, ds) {
      MK.auditCategory = (ds && ds.cat) || 'all';
      MK.auditLimit = 100;
      MK.auditLoaded = false;
      document.querySelectorAll('.mkt-audit-tabs [data-act="mkt-audit-filter"]').forEach((b) => {
        b.className = 'btn btn-xs ' + (b.getAttribute('data-cat') === MK.auditCategory ? 'btn-primary' : 'btn-ghost');
      });
      loadAudit(true);
    };
    App.mktAuditMore = function () {
      MK.auditLimit = Math.min(500, MK.auditLimit + 100);
      loadAudit(true);
    };
    App.mktAuditCsv = function () {
      if (!MK.audit.length) return adminToast('Nothing to export yet', 'err');
      const rows = [['time', 'action', 'category', 'actor', 'target', 'summary', 'result', 'duration_ms', 'changes']];
      MK.audit.forEach((e) => rows.push([
        new Date(e.at).toISOString(), e.action || '', e.category || '', e.actor || '', e.target || '', e.summary || '', e.result || '',
        e.durationMs != null ? e.durationMs : '',
        (e.changes || []).map((c) => c.field + ':' + c.from + '->' + c.to).join(' | ')
      ]));
      const csv = rows.map((r) => r.map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\r\n');
      try {
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'whalechat-market-audit-' + new Date().toISOString().slice(0, 10) + '.csv';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        adminToast('Audit log exported', 'ok');
      } catch (err) { adminToast('Export failed', 'err'); }
    };
  }

  function mountAdminStack() {
    if (!/^#\/admin\/stocks/.test(location.hash || '')) return;
    if (document.getElementById('mktHealthCard')) return;
    const nav = document.querySelector('.admin-nav');
    if (!nav || !nav.parentNode) return;
    const wrap = document.createElement('div');
    wrap.id = 'mktAdminStack';
    wrap.innerHTML = adminStackHTML();
    const firstCard = nav.parentNode.querySelector('.card');
    if (firstCard && firstCard !== wrap) nav.parentNode.insertBefore(wrap, firstCard);
    else nav.parentNode.appendChild(wrap);
    const modeSel = document.getElementById('alpMode');
    if (modeSel) modeSel.addEventListener('change', () => paintEndpoint(modeSel.value));
    paintEndpoint();
    loadHealth();
  }

  /* ------------------------------- mounting -------------------------------- */
  function enhance() {
    paintNotice();
    paintAdminStatus();
    const h = location.hash || '';
    let tickers = [];
    try {
      if (h.startsWith('#/invest/market')) tickers = INV.stocks().map((s) => s.ticker);
      else if (h === '#/invest' || h.startsWith('#/invest?')) tickers = (LT.positions ? LT.positions(me().id).map((p) => p.ticker) : []).concat((DB.watchlist || []).filter((w) => w.userId === me().id).map((w) => w.ticker));
      else if (h.startsWith('#/invest/watchlist')) tickers = (DB.watchlist || []).filter((w) => w.userId === me().id).map((w) => w.ticker);
    } catch (e) {}
    if (tickers.length) prefetchHistories(tickers).then(() => { try { INV.paint(); if (MK.chart) updateChart(); } catch (e) {} });
    if (document.getElementById('ltDashChart')) setTimeout(mountPortfolioChart, 60);
    if (currentTicker()) {
      const host = document.querySelector('.inv-chart[data-lt-live-chart], .inv-chart[data-chart]');
      if (host) setTimeout(mountChart, 40);
    }
    try { checkSettledToasts(); } catch (e) {}
  }

  if (typeof AFTER === 'object' && AFTER.admin) {
    const baseAfterAdmin = AFTER.admin;
    AFTER.admin = function (parts, params) {
      try { if (baseAfterAdmin) baseAfterAdmin(parts, params); } catch (e) {}
      if ((parts[1] || '') === 'stocks') {
        MK.adminLoaded = false;
        setTimeout(() => { mountAdminStack(); paintAdminStatus(); loadAdminConfig(); loadHealth(); loadAudit(); }, 60);
      }
    };
  } else if (typeof AFTER === 'object') {
    AFTER.admin = function (parts) {
      if ((parts[1] || '') === 'stocks') setTimeout(() => { mountAdminStack(); paintAdminStatus(); loadAdminConfig(); loadHealth(); loadAudit(); }, 60);
    };
  }

  if (typeof AFTER === 'object') {
    const baseAfter = AFTER.invest;
    AFTER.invest = function (parts, params) {
      try { if (baseAfter) baseAfter(parts, params); } catch (e) {}
      setTimeout(enhance, 60);
    };
  }

  /* styles */
  (function styles() {
    if (document.getElementById('wc-market-style')) return;
    const st = document.createElement('style');
    st.id = 'wc-market-style';
    st.textContent = `
    .inv-chart.wc-chart-host{height:240px !important}
    .wc-lwc{width:100%;height:240px;position:relative}
    .inv-chart.wc-chart-host{position:relative}
    .wc-chart-tip{position:absolute;z-index:9;pointer-events:none;padding:6px 8px;border-radius:8px;
      background:rgba(4,16,26,.94);border:1px solid rgba(46,230,201,.35);box-shadow:0 8px 22px rgba(0,0,0,.45);
      font-size:10.5px;line-height:1.45;max-width:180px}
    .wc-chart-tip b{display:block;font-size:11.5px;color:#e9f4f9;font-variant-numeric:tabular-nums}
    .wc-chart-tip span{display:block;color:#8ba4b6;font-size:9.5px}
    .wc-pos-banner{position:absolute;left:8px;top:8px;z-index:8;pointer-events:none;padding:7px 9px;border-radius:9px;
      background:rgba(4,16,26,.86);border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(6px);
      box-shadow:0 8px 20px rgba(0,0,0,.35);min-width:168px}
    .wc-pos-line{display:flex;justify-content:space-between;gap:10px;font-size:10px;line-height:1.7;color:#8ba4b6}
    .wc-pos-line b{color:#e9f4f9;font-size:10.5px;font-variant-numeric:tabular-nums;white-space:nowrap}
    .wc-pos-line b i{font-style:normal;color:#8ba4b6;font-size:9.5px}
    .wc-pos-line b.up{color:#22c55e} .wc-pos-line b.down{color:#ef4444}
    .wc-lwc-loading{height:240px;display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--muted)}
    .wc-feed-notice{margin-top:5px;display:flex;align-items:center;justify-content:center;gap:6px}
    .wc-feed-dot{width:7px;height:7px;border-radius:50%;display:inline-block;flex:0 0 auto}
    .wc-feed-dot.live{background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.15)}
    .wc-feed-dot.sim{background:#ffb020;box-shadow:0 0 0 3px rgba(255,176,32,.14)}
    .inv-note[data-market-notice]{display:flex;align-items:center;gap:7px}
    .mkt-status{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:7px;margin-top:12px;
      padding:10px;border:1px solid var(--border);border-radius:12px;background:var(--surface-2)}
    .mkt-stat{display:flex;flex-direction:column;gap:2px;min-width:0}
    .mkt-stat span{font-size:9.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted-2);font-weight:700}
    .mkt-stat b{font-size:11.5px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .mkt-stat b.up{color:var(--success)} .mkt-stat b.down{color:var(--danger)}
    .ov-table td{padding:5px 7px;font-size:11px;vertical-align:middle}
    .ov-input{height:28px;padding:2px 5px;font-size:10.5px;text-align:right}
    .ov-table .num{font-variant-numeric:tabular-nums}
    .admin-guide .guide-facts{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin:11px 0 4px}
    .admin-guide .guide-facts div{display:flex;flex-direction:column;gap:1px;padding:8px;border-radius:9px;
      border:1px solid var(--border);background:var(--surface-2)}
    .admin-guide .guide-facts b{font-size:11px;color:var(--text)}
    .admin-guide .guide-facts span{font-size:10px;color:var(--muted)}
    .guide-sec{margin-top:8px;border:1px solid var(--border);border-radius:11px;background:var(--surface-2);overflow:hidden}
    .guide-sec summary{min-height:44px;display:flex;align-items:center;cursor:pointer;padding:11px 12px;
      font-size:12.5px;font-weight:700;color:var(--text);list-style:none}
    .guide-sec summary::-webkit-details-marker{display:none}
    .guide-sec summary:before{content:'▸';margin-right:8px;color:var(--accent);transition:transform .15s}
    .guide-sec[open] summary:before{transform:rotate(90deg)}
    .guide-sec p,.guide-sec ul,.guide-sec ol{margin:0 12px 10px;font-size:12px;line-height:1.65;color:var(--muted)}
    .guide-sec ul,.guide-sec ol{padding-left:17px}
    .guide-sec li{margin:3px 0}
    .guide-sec b{color:var(--text)}
    .guide-sec code{background:rgba(255,255,255,.06);border-radius:4px;padding:1px 4px;color:var(--text);word-break:break-word}
    .guide-steps li{margin:5px 0}
    .guide-formula{margin:0 12px 9px;padding:9px 10px;border-radius:9px;border:1px solid var(--border);
      background:#04101a;color:#bfe9ff;font-size:11.5px;line-height:1.6;overflow-wrap:anywhere}
    .guide-examples{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin:0 12px 10px}
    .guide-example{display:flex;flex-direction:column;gap:1px;border-radius:9px;padding:8px;font-size:10.5px;line-height:1.45;
      border:1px solid var(--border);background:var(--surface)}
    .guide-example b{font-size:11px} .guide-example span{color:var(--muted)}
    .guide-example strong{font-size:12px}
    .guide-example.win{border-color:rgba(34,197,94,.25)} .guide-example.win strong{color:var(--success)}
    .guide-example.loss{border-color:rgba(239,68,68,.25)} .guide-example.loss strong{color:var(--danger)}
    .guide-scenarios{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:0 12px 10px}
    .guide-scenario{border:1px solid var(--border);border-radius:10px;background:var(--surface);padding:9px}
    .guide-sc-head{display:flex;justify-content:space-between;gap:8px;align-items:baseline;margin-bottom:5px}
    .guide-sc-head b{font-size:11.5px} .guide-sc-head span{font-size:9.5px;color:var(--muted)}
    .guide-kv{display:flex;justify-content:space-between;gap:8px;padding:3px 0;border-bottom:1px dashed var(--border);font-size:10.5px}
    .guide-kv span{color:var(--muted)} .guide-kv b{color:var(--text)}
    .guide-outcome{margin-top:6px;padding:6px 7px;border-radius:7px;font-size:10.5px;line-height:1.45;font-weight:600}
    .guide-outcome.win{color:var(--success);background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.22)}
    .guide-outcome.loss{color:var(--danger);background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.20)}
    .guide-sc-note{font-size:9.5px;color:var(--muted);line-height:1.5;margin-top:4px}
    .guide-table{margin:0 12px 10px;border:1px solid var(--border);border-radius:9px;overflow:hidden}
    .guide-tr{display:grid;grid-template-columns:1.35fr 1fr 1fr;gap:6px;padding:7px 9px;font-size:11px;color:var(--muted);
      border-top:1px solid var(--border)}
    .guide-tr:first-child{border-top:none}
    .guide-th{background:var(--surface);color:var(--text);font-weight:700;font-size:10px;text-transform:uppercase;letter-spacing:.04em}
    .guide-note,.guide-tip{margin:0 12px 10px;padding:8px 9px;border-radius:8px;font-size:11px;line-height:1.55;
      color:var(--muted);background:rgba(46,230,201,.06);border:1px solid rgba(46,230,201,.16)}
    .guide-tip{margin:0 12px 10px}
    .guide-controls{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin:0 12px 10px}
    .guide-controls div{display:flex;flex-direction:column;gap:1px;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--surface)}
    .guide-controls b{font-size:11px} .guide-controls span{font-size:10.5px;color:var(--muted)}
    .guide-warn{margin:0 12px 12px;padding:9px 10px;border-radius:8px;font-size:11px;line-height:1.6;
      color:var(--danger);background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.22)}
    @media(max-width:560px){
      .admin-guide .guide-facts{grid-template-columns:1fr 1fr}
      .guide-examples,.guide-controls,.guide-scenarios{grid-template-columns:1fr}
      .guide-sec p,.guide-sec ul,.guide-sec ol{font-size:11.5px}
      .guide-tr{font-size:10.5px;padding:7px}
    }
    .div-settings-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:11px}
    .div-yield-head,.div-yield-row{display:grid;grid-template-columns:1fr 90px 110px;gap:8px;align-items:center}
    .div-yield-head{margin-top:10px;font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-2);font-weight:700;padding:0 2px}
    .div-yield-list{max-height:300px;overflow:auto;border:1px solid var(--border);border-radius:10px;margin-top:4px;background:var(--surface-2)}
    .div-yield-row{padding:7px 9px;border-top:1px solid var(--border);font-size:11px}
    .div-yield-row:first-child{border-top:none}
    .div-yield-row b{font-size:11px} .div-yield-row span{font-variant-numeric:tabular-nums}
    .div-yield-row .up{color:var(--success)} .div-yield-row .muted{color:var(--muted)}
    .div-ov{height:29px;padding:3px 6px;font-size:10.5px;text-align:right}
    @media(max-width:560px){
      .div-settings-grid{grid-template-columns:1fr}
      .div-yield-head,.div-yield-row{grid-template-columns:1fr 75px 90px;gap:6px}
      .div-yield-row{padding:7px 8px}
    }
    .lt-live-badge{display:inline-flex;align-items:center;gap:5px;font-size:9px;font-weight:800;letter-spacing:.08em;
      color:var(--success);border:1px solid rgba(34,197,94,.30);background:rgba(34,197,94,.10);border-radius:99px;padding:2px 7px}
    .lt-live-badge i{width:6px;height:6px;border-radius:50%;background:#22c55e;animation:ltPulse 1.2s ease-in-out infinite}
    @keyframes ltPulse{0%,100%{opacity:.35;transform:scale(.8)}50%{opacity:1;transform:scale(1.15)}}
    .mkt-health-pill{display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:99px;
      border:1px solid var(--border);background:var(--surface-2);font-size:10px;font-weight:800;
      text-transform:uppercase;letter-spacing:.06em;white-space:nowrap}
    .mkt-health-pill i{width:7px;height:7px;border-radius:50%;background:#8ba4b6}
    .mkt-health-pill.ok{color:var(--success);border-color:rgba(34,197,94,.28)}
    .mkt-health-pill.ok i{background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.15)}
    .mkt-health-pill.warn{color:#ffb020;border-color:rgba(255,176,32,.3)}
    .mkt-health-pill.warn i{background:#ffb020;box-shadow:0 0 0 3px rgba(255,176,32,.14)}
    .mkt-health-pill.err{color:var(--danger);border-color:rgba(239,68,68,.3)}
    .mkt-health-pill.err i{background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.14)}
    .mkt-health-top{display:flex;gap:14px;align-items:center;margin-top:12px;flex-wrap:wrap}
    .mkt-health-ring{width:86px;height:86px;border-radius:50%;flex:0 0 auto;display:grid;place-items:center;
      background:conic-gradient(#22c55e 360deg,rgba(255,255,255,.07) 0);position:relative;transition:background .4s}
    .mkt-health-ring:after{content:'';position:absolute;inset:7px;border-radius:50%;background:var(--surface-2)}
    .mkt-health-ring span{position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;line-height:1}
    .mkt-health-ring b{font-size:21px;font-variant-numeric:tabular-nums}
    .mkt-health-ring i{font-style:normal;font-size:8.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-top:3px}
    .mkt-health-meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:8px;flex:1;min-width:200px}
    .mkt-health-list{margin-top:12px;border:1px solid var(--border);border-radius:12px;overflow:hidden;background:var(--surface-2)}
    .mkt-health-row{display:flex;align-items:center;gap:8px;padding:8px 10px;border-top:1px solid var(--border);min-width:0}
    .mkt-health-row:first-child{border-top:none}
    .mkt-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto}
    .mkt-dot.ok{background:#22c55e} .mkt-dot.warn{background:#ffb020} .mkt-dot.err{background:#ef4444} .mkt-dot.info{background:#3aa0ff}
    .mkt-health-name{font-size:11.5px;font-weight:650;flex:0 0 136px}
    .mkt-health-detail{font-size:10.5px;color:var(--muted);line-height:1.45;flex:1;min-width:0;overflow-wrap:anywhere}
    .mkt-audit-tabs .btn{min-height:26px}
    .mkt-audit-list{border:1px solid var(--border);border-radius:12px;background:var(--surface-2);margin-top:10px;max-height:460px;overflow:auto}
    .mkt-audit-row{display:flex;gap:10px;justify-content:space-between;padding:9px 11px;border-top:1px solid var(--border)}
    .mkt-audit-row:first-child{border-top:none}
    .mkt-audit-main{min-width:0;flex:1}
    .mkt-audit-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
    .mkt-audit-head b{font-size:12px}
    .mkt-audit-changes{display:flex;gap:5px;flex-wrap:wrap;margin-top:4px}
    .mkt-audit-chip{font-size:10px;padding:2px 6px;border-radius:6px;background:rgba(46,230,201,.08);
      border:1px solid rgba(46,230,201,.18);color:var(--text);font-variant-numeric:tabular-nums}
    .mkt-audit-target{text-align:right;max-width:130px;flex:0 0 auto}
    .mkt-audit-empty{padding:16px;font-size:11.5px;color:var(--muted);text-align:center;line-height:1.6}
    .mkt-endpoint{margin:2px 0 10px;padding:9px 10px;border:1px solid var(--border);border-radius:10px;
      background:var(--surface-2);display:flex;flex-direction:column;gap:4px}
    .mkt-endpoint code{font-size:11px;color:var(--text);background:rgba(255,255,255,.05);border-radius:5px;padding:1px 5px;overflow-wrap:anywhere}
    .mkt-endpoint>div:first-child{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    @media(max-width:560px){
      .mkt-health-name{flex-basis:106px;font-size:11px}
      .mkt-audit-target{display:none}
      .mkt-health-top{gap:10px}
    }
    `;
    document.head.appendChild(st);
  })();

  /* boot */
  function boot() {
    if (typeof DB === 'undefined') return setTimeout(boot, 400);
    patchTick();
    poll();
    setInterval(poll, 1200);
    setInterval(() => { try { paintNotice(); paintAdminStatus(); } catch (e) {} }, 3000);
    setInterval(() => { try { if (document.getElementById('mktHealthCard')) loadHealth(); } catch (e) {} }, 10000);
    setInterval(() => { try { if (MK.chart && MK.chart.mode === 'portfolio') updateChart(); } catch (e) {} }, 1000);
    setInterval(() => { try { if (MK.chart) updateChart(); checkSettledToasts(); } catch (e) {} }, 2000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
