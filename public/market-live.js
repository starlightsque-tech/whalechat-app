/* =========================================================================
   WhaleChat market feed + TradingView lightweight-charts
   - loads lightweight-charts from the public CDN
   - stock detail chart is a themed BaselineSeries: baseline = trade entry
     price, green above / red below (inverted for Short trades)
   - quotes come only from the WhaleChat backend, which own the Finnhub key
   - admin -> stocks gets Finnhub key / data mode / refresh controls
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
    } catch (e) { /* local mode / offline: cached Finnhub prices remain */ }
  }

  function feedFresh() {
    if (!MK.feed || !MK.feed.quotes || !MK.lastPollAt) return false;
    const refresh = (MK.feed.status && Number(MK.feed.status.refreshSec)) || 15;
    return Date.now() - MK.lastPollAt < Math.max(10000, refresh * 2500);
  }
  MK.feedFresh = feedFresh;

  /* No browser-side price generator: the backend Finnhub feed is the only source. */
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
    return 'Connect Finnhub in Admin → Markets';
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
      if (!/market data|market mode|Finnhub|Simulated market|simulated feed/i.test(el.textContent || '')) return;
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
    const cached = MK.historyCache && MK.historyCache[ticker];
    if (cached && Date.now() - cached.at < 30000) return cached.points;
    try {
      const r = await getJSON('/api/market/history?tickers=' + encodeURIComponent(ticker) + '&limit=900', {}, 7000);
      const d = r.data || {};
      const points = (d.ok && d.history && Array.isArray(d.history[ticker])) ? d.history[ticker] : [];
      MK.historyCache = MK.historyCache || {};
      MK.historyCache[ticker] = { at: Date.now(), points };
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
        localization: { priceFormatter: (p) => (cfg.mode === 'portfolio' ? Number(p).toFixed(2) + ' WC' : '$' + Number(p).toFixed(2)) },
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
      MK.chart = {
        mode: cfg.mode || 'stock', ticker: cfg.ticker || '', chart, series, host, wrap, LWC,
        basePrice: defaultBase, defaultBase, side,
        lastTime: data[data.length - 1].time,
        points: data.length, lines: [], lineKey: ''
      };
      syncPriceLines();
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
    add(pos.entryPrice, '#60a5fa', 'Entry $' + Number(pos.entryPrice).toFixed(2), 2);
    add(pos.takeProfitPrice, '#22c55e', 'TP $' + Number(pos.takeProfitPrice).toFixed(2), 0);
    add(pos.stopLossPrice, '#ef4444', (pos.trailingActive ? 'TSL $' : 'SL $') + Number(pos.stopLossPrice).toFixed(2), 0);
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
      const rows = (LT.positions(me().id) || []).map((p) => [p.kind, p.ticker, p.trade ? p.trade.id : (p.holding ? p.holding.id : '')].join(':'));
      try {
        const b = window.WC_BOTS && WC_BOTS.state && WC_BOTS.state.session;
        if (b) rows.push(['bot', b.id, b.poolCoins, b.tradeCount, b.status].join(':'));
      } catch (e) {}
      return rows.join('|');
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
          <div class="tiny muted" style="margin-top:3px">Auto-synced from Finnhub every 24h · paid only when the trade timer completes.</div></div>
        <span class="badge ${inv.dividendSource === 'finnhub' ? 'badge-success' : 'badge-warn'}">${inv.dividendSource === 'finnhub' ? 'Finnhub' : 'Fallback'}</span>
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
          const auto = ys[s.ticker] != null ? Number(ys[s.ticker]) : (LT.DIV_FALLBACK[s.ticker] || 0);
          const o = ov[s.ticker];
          return `<div class="div-yield-row">
            <b>${escMarket(s.ticker)}</b>
            <span class="${auto > 0 ? 'up' : 'muted'}">${auto.toFixed(2)}%</span>
            <input class="input div-ov" data-div-ticker="${escMarket(s.ticker)}" type="number" step="0.01" min="0" max="100" value="${o != null ? o : ''}" placeholder="${auto.toFixed(2)}"/>
          </div>`;
        }).join('')}
      </div>
      <div class="tiny muted" style="margin-top:8px">Last sync: ${escMarket(synced)} · source: ${escMarket(inv.dividendSource || 'fallback')} · floor 0.01 WC on dividend-paying symbols.</div>
      <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
        <button class="btn btn-primary" data-act="div-save">Save dividend settings</button>
        <button class="btn btn-soft" data-act="div-sync">Sync from Finnhub now</button>
        <button class="btn btn-ghost" data-act="div-reset">Reset overrides</button>
      </div>
      <div class="tiny muted mt6" id="divSyncNote">Leave an override blank to use the synced annual yield. Overrides are locked at trade entry.</div>
    </div>`;
  }

  function tradingGuideHTML() {
    return `<div class="card admin-guide" id="tradingGuideCard">
      <div class="between" style="align-items:flex-start;gap:10px">
        <div><div class="card-title" style="margin:0">Trading guide for admins</div>
          <div class="tiny muted" style="margin-top:3px">Virtual trading · read before changing leverage, fees or payouts.</div></div>
        <span class="badge badge-accent">Admin only</span>
      </div>

      <div class="guide-facts">
        <div><b>1 WC</b><span>$0.50</span></div>
        <div><b>Min stake</b><span>5 WC</span></div>
        <div><b>Loss cap</b><span>Stake only</span></div>
        <div><b>Settlement</b><span>Every second</span></div>
      </div>

      <details class="guide-sec" open>
        <summary>1 · Trade flow</summary>
        <ol class="guide-steps">
          <li><b>Open.</b> User picks a stock, Rise or Fall, a stake and optional TP/SL. The stake plus entry fee is deducted; the entry price becomes the baseline.</li>
          <li><b>Track.</b> P&amp;L moves with the shared price feed. The chart, active-trade card and portfolio performance update live.</li>
          <li><b>Settle.</b> A TP, SL, trailing stop, total loss or the duration ends the trade. Payout is credited server-side and logged.</li>
        </ol>
        <div class="guide-note">Fee is charged once at entry. Closing does not charge again.</div>
      </details>

      <details class="guide-sec">
        <summary>2 · Profit, loss and worked examples</summary>
        <div class="guide-formula"><code>pnl WC = stake × leverage × price move × direction</code></div>
        <p><code>direction</code> is <b>+1 for Rise</b>, <b>−1 for Fall</b>. Payout is <code>max(0, stake + pnl)</code>.</p>
        <div class="guide-scenarios">
          <div class="guide-scenario rise">
            <div class="guide-sc-head"><b>Rise example</b><span>100 WC · 5×</span></div>
            <div class="guide-kv"><span>Entry</span><b>$100.00</b></div>
            <div class="guide-kv"><span>Take Profit</span><b>$110.00</b></div>
            <div class="guide-kv"><span>Stop Loss</span><b>$95.00</b></div>
            <div class="guide-kv"><span>Trailing</span><b>3%</b></div>
            <div class="guide-kv"><span>Exit (TSL)</span><b>$104.76</b></div>
            <div class="guide-outcome win">Win: +23.80 WC · payout 123.80 WC</div>
            <div class="guide-outcome loss">Loss cap: 20% gap = −100 WC · payout 0</div>
            <div class="guide-sc-note">Price peaked at $108, then the 3% trail exited before TP.</div>
          </div>
          <div class="guide-scenario fall">
            <div class="guide-sc-head"><b>Fall example</b><span>100 WC · 5×</span></div>
            <div class="guide-kv"><span>Entry</span><b>$100.00</b></div>
            <div class="guide-kv"><span>Take Profit</span><b>$90.00</b></div>
            <div class="guide-kv"><span>Stop Loss</span><b>$105.00</b></div>
            <div class="guide-kv"><span>Trailing</span><b>3%</b></div>
            <div class="guide-kv"><span>Exit (TSL)</span><b>$94.76</b></div>
            <div class="guide-outcome win">Win: +26.20 WC · payout 126.20 WC</div>
            <div class="guide-outcome loss">Loss cap: 20% gap = −100 WC · payout 0</div>
            <div class="guide-sc-note">Price fell to $92, then the 3% trail exited before TP.</div>
          </div>
        </div>
        <p class="guide-tip"><b>Rule of thumb:</b> a leveraged trade is wiped out by a <code>100 ÷ leverage</code>% adverse move. Losses can never exceed the stake.</p>
      </details>

      <details class="guide-sec">
        <summary>3 · TP, SL and trailing stop</summary>
        <div class="guide-table">
          <div class="guide-tr guide-th"><span>Level</span><span>Rise</span><span>Fall</span></div>
          <div class="guide-tr"><span>Take Profit</span><span>above entry</span><span>below entry</span></div>
          <div class="guide-tr"><span>Stop Loss</span><span>below entry</span><span>above entry</span></div>
        </div>
        <ul class="guide-list">
          <li><b>WC mode</b> — user enters the target profit/loss in WC; the app converts it to a price using stake × leverage.</li>
          <li><b>Trailing stop</b> — follows the best price by the chosen % and only tightens. It never moves backwards.</li>
          <li><b>Editing</b> — users can change or clear TP/SL from Active Trades. Changes apply on the next price tick.</li>
        </ul>
      </details>

      <details class="guide-sec">
        <summary>4 · Settlement and real market data</summary>
        <ul class="guide-list">
          <li>The server checks open trades at least once per second and settles on the tick that hits a level.</li>
          <li>Close reasons: <code>Take Profit Hit</code>, <code>Stop Loss Hit</code>, <code>Trailing Stop Hit</code>, <code>Time limit reached</code>.</li>
          <li>Payout, transaction, notification and toast are produced even if the user's browser is closed.</li>
          <li><b>Hybrid:</b> Finnhub REST seeds every listed stock, forex pair and crypto pair; one backend WebSocket streams live ticks.</li>
          <li><b>No fake ticks:</b> closed stock exchanges hold the last real print. Crypto streams 24/7 and Forex 24/5 through Finnhub.</li>
        </ul>
      </details>

      <details class="guide-sec">
        <summary>5 · Admin controls</summary>
        <div class="guide-controls">
          <div><b>Fee</b><span>0–5%, charged at entry</span></div>
          <div><b>Leverage</b><span>1×–20×, magnifies P&amp;L</span></div>
          <div><b>Pause</b><span>blocks new trades only</span></div>
          <div><b>Balance</b><span>manual support adjustment</span></div>
        </div>
        <p class="guide-warn"><b>Important:</b> payouts are deterministic and audited. Do not use leverage or manual balance edits to hide losses — every settlement records its reason and amount.</p>
      </details>
    </div>`;
  }

  function adminCardHTML() {
    return `<div class="card" id="mktFeedCard">
      <div class="between" style="align-items:flex-start;gap:10px">
        <div><div class="card-title" style="margin:0">Market data · Finnhub</div>
          <div class="tiny muted" style="margin-top:3px">Server-side feed shared by every user. The API key never reaches a browser.</div></div>
        <span class="badge badge-warn" id="mktModeBadge">Loading…</span>
      </div>
      <div class="field" style="margin-top:12px"><label class="label">Finnhub API Key</label>
        <input class="input" id="mktKey" type="password" autocomplete="new-password" placeholder="Paste a key from finnhub.io/register"/>
        <div class="tiny muted mt6" id="mktKeyHint">Stored only on the server data volume (file mode 0600), never in the synced app database.</div></div>
      <div class="row" style="gap:8px;flex-wrap:wrap;align-items:flex-end">
        <div class="field grow" style="margin:0;min-width:200px"><label class="label">Data mode</label>
          <select class="input" id="mktMode">
            <option value="hybrid">Live Finnhub (real prices only)</option>
          </select></div>
        <div class="field" style="margin:0;width:170px"><label class="label">Refresh interval (seconds)</label>
          <input class="input" id="mktRefresh" type="number" min="5" max="300" step="1" value="15"/></div>
      </div>
      <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
        <button class="btn btn-primary" data-act="mkt-save">Save settings</button>
        <button class="btn btn-ghost" data-act="mkt-test">Test Finnhub</button>
        <label class="checkline tiny muted" style="margin-left:auto"><input type="checkbox" id="mktClear"/> Clear saved key</label>
      </div>
      <div class="mkt-status" id="mktStatus">Reading feed status…</div>
      <div class="tiny muted" style="margin-top:6px;line-height:1.6">
        Hybrid mode seeds every listed asset from Finnhub REST, then keeps one shared WebSocket open for
        second-by-second ticks. Crypto streams 24/7 and Forex 24/5; closed stock venues hold the last real
        print instead of generating fake movement. All browser prices come from this backend cache.
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
      const live = st.source === 'live';
      badge.className = 'badge ' + (live ? 'badge-success' : 'badge-warn');
      badge.textContent = live ? 'Live · Finnhub' : (st.mode === 'hybrid' ? 'Offline / limited' : 'No Finnhub key');
    }
    if (!box) return;
    const when = (ms) => ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
    box.innerHTML = `
      <div class="mkt-stat"><span>Notice</span><b>${escMarket(st.notice || noticeText())}</b></div>
      <div class="mkt-stat"><span>Market</span><b>${st.marketOpen ? 'US session open' : 'US market closed'}</b></div>
      <div class="mkt-stat"><span>WebSocket</span><b class="${st.wsConnected ? 'up' : 'down'}">${st.wsConnected ? 'connected' : 'offline'}</b></div>
      <div class="mkt-stat"><span>Last real tick</span><b>${when(st.lastRealAt)}</b></div>
      <div class="mkt-stat"><span>Server price tick</span><b>${when(st.lastTickAt)}</b></div>
      <div class="mkt-stat"><span>Rate limit</span><b class="${st.rateLimitedUntil ? 'down' : 'up'}">${st.rateLimitedUntil ? '429 · cooling down' : 'clear'}</b></div>
      <div class="mkt-stat"><span>Unpriced assets</span><b class="${(st.unpriced || 0) ? 'down' : 'up'}">${st.unpriced || 0}</b></div>
      ${st.lastError ? `<div class="mkt-stat"><span>Last error</span><b class="down">${escMarket(st.lastError)}</b></div>` : ''}`;
  }

  async function loadAdminConfig() {
    const card = document.getElementById('mktFeedCard');
    if (!card || MK.adminLoaded || MK.adminLoading) return;
    if (typeof Remote === 'undefined' || !Remote.enabled) return;
    MK.adminLoading = true;
    try {
      const meId = (typeof me === 'function' && me()) ? me().id : '';
      const r = await getJSON('/api/market/config?adminId=' + encodeURIComponent(meId), {}, 7000);
      if (!r.res || !r.res.ok || !r.data || !r.data.ok) return;
      MK.config = r.data;
      MK.adminLoaded = true;
      const key = document.getElementById('mktKey');
      const mode = document.getElementById('mktMode');
      const refresh = document.getElementById('mktRefresh');
      const hint = document.getElementById('mktKeyHint');
      if (key) key.placeholder = r.data.hasKey ? 'Saved key ' + r.data.keyMasked + ' — leave blank to keep' : 'Paste a key from finnhub.io/register';
      if (mode) mode.value = r.data.mode;
      if (refresh) refresh.value = r.data.refreshSec;
      if (hint) hint.textContent = r.data.hasKey
        ? 'A key is saved on the server (' + r.data.keyMasked + '). Leave blank to keep it, or paste a new one to replace it.'
        : 'No key saved yet. Hybrid mode needs a Finnhub key; without it quotes stay offline.';
      paintAdminStatus();
    } catch (e) { /* keep static card */ }
    finally { MK.adminLoading = false; }
  }

  function adminToast(msg, type) {
    if (typeof toast === 'function') toast(msg, type || 'ok');
  }

  if (typeof App !== 'undefined') {
    App.mktSave = async function () {
      if (typeof Remote === 'undefined' || !Remote.enabled) return adminToast('Connect the sync server first — market data runs on the backend', 'err');
      const btn = document.querySelector('[data-act="mkt-save"]');
      if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
      try {
        const meId = (typeof me === 'function' && me()) ? me().id : '';
        const body = {
          adminId: meId,
          mode: (document.getElementById('mktMode') || {}).value || 'simulated',
          refreshSec: Number((document.getElementById('mktRefresh') || {}).value) || 15,
          clearKey: !!((document.getElementById('mktClear') || {}).checked)
        };
        const key = ((document.getElementById('mktKey') || {}).value || '').trim();
        if (key) body.apiKey = key;
        const r = await getJSON('/api/market/config', { method: 'POST', body: JSON.stringify(body) }, 12000);
        if (!r.res || !r.res.ok || !r.data || !r.data.ok) {
          return adminToast((r.data && (r.data.message || r.data.error)) || 'Could not save market settings', 'err');
        }
        MK.config = r.data;
        MK.adminLoaded = false;
        try { await poll(); } catch (e) {}
        adminToast('Market data settings saved · Live Finnhub mode', 'ok');
        if (typeof render === 'function') render();
      } catch (e) {
        adminToast('Save failed: ' + e.message, 'err');
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Save settings'; }
      }
    };

    App.mktTest = async function () {
      if (typeof Remote === 'undefined' || !Remote.enabled) return adminToast('Connect the sync server first', 'err');
      const btn = document.querySelector('[data-act="mkt-test"]');
      if (btn) { btn.disabled = true; btn.textContent = 'Testing…'; }
      try {
        const meId = (typeof me === 'function' && me()) ? me().id : '';
        const r = await getJSON('/api/market/test', { method: 'POST', body: JSON.stringify({ adminId: meId }) }, 15000);
        const d = r.data || {};
        adminToast(d.ok ? `Finnhub OK · AAPL $${Number(d.price).toFixed(2)}` : (d.message || 'Finnhub test failed'), d.ok ? 'ok' : 'err');
      } catch (e) {
        adminToast('Test failed: ' + e.message, 'err');
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Test Finnhub'; }
      }
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
      adminToast('Dividend overrides cleared — using synced yields', 'ok');
      render();
    };

    App.divSync = async function () {
      if (typeof Remote === 'undefined' || !Remote.enabled) return adminToast('Connect the sync server first', 'err');
      const btn = document.querySelector('[data-act="div-sync"]');
      if (btn) { btn.disabled = true; btn.textContent = 'Syncing all assets…'; }
      try {
        const meId = (typeof me === 'function' && me()) ? me().id : '';
        const r = await getJSON('/api/market/dividends/sync', { method: 'POST', body: JSON.stringify({ adminId: meId }) }, 45000);
        if (!r.res || !r.res.ok || !r.data || !r.data.ok) return adminToast((r.data && r.data.error) || 'Dividend sync failed', 'err');
        try { await Remote.refresh(true); } catch (e) {}
        adminToast('Dividends synced from Finnhub', 'ok');
        render();
      } catch (e) {
        adminToast('Dividend sync failed: ' + e.message, 'err');
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Sync from Finnhub now'; }
      }
    };
  }

  /* append the feed card to Admin → Stocks */
  if (typeof INV !== 'undefined' && INV.viewAdminStocks && !INV.__mkAdminPatched) {
    const baseAdmin = INV.viewAdminStocks;
    INV.viewAdminStocks = function () {
      const html = baseAdmin.apply(this, arguments);
      if (/Admin access only/.test(html)) return html;
      return html + adminCardHTML() + dividendSettingsHTML() + tradingGuideHTML();
    };
    INV.__mkAdminPatched = true;
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
        setTimeout(() => { paintAdminStatus(); loadAdminConfig(); }, 60);
      }
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
    `;
    document.head.appendChild(st);
  })();

  /* boot */
  function boot() {
    if (typeof DB === 'undefined') return setTimeout(boot, 400);
    patchTick();
    poll();
    setInterval(poll, 2500);
    setInterval(() => { try { paintNotice(); paintAdminStatus(); } catch (e) {} }, 3000);
    setInterval(() => { try { if (MK.chart && MK.chart.mode === 'portfolio') updateChart(); } catch (e) {} }, 1000);
    setInterval(() => { try { if (MK.chart) updateChart(); checkSettledToasts(); } catch (e) {} }, 2000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
