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
  }

  async function poll() {
    if (document.hidden) return;
    try {
      const r = await getJSON('/api/market/quotes', {}, 7000);
      if (r.res && r.res.ok && r.data && r.data.ok) {
        MK.lastPollAt = Date.now();
        applyQuotes(r.data);
      }
    } catch (e) { /* local mode / offline: the built-in simulator keeps running */ }
  }

  function feedFresh() {
    if (!MK.feed || !MK.feed.quotes || !MK.lastPollAt) return false;
    const refresh = (MK.feed.status && Number(MK.feed.status.refreshSec)) || 15;
    return Date.now() - MK.lastPollAt < Math.max(10000, refresh * 2500);
  }

  /* Keep the client simulation from fighting the authoritative server cache. */
  function patchTick() {
    if (typeof INV === 'undefined' || INV.__mkTickPatched) return;
    const baseTick = INV.tick;
    INV.tick = function () {
      if (!feedFresh()) return baseTick.apply(INV, arguments);
      const now = Date.now();
      /* only tickers Finnhub does not cover keep the local simulator */
      INV.stocks().forEach((s) => {
        if (MK.feed.quotes[s.ticker]) return;
        const q = INV.quote(s.ticker);
        if (!q) return;
        const vol = INV.volatility(s) / 14;
        const shock = (Math.random() - 0.5) * 2 * vol;
        const next = Math.max(0.5, q.price * (1 + shock));
        q.dir = next > q.price ? 1 : next < q.price ? -1 : 0;
        q.price = Math.round(next * 100) / 100;
        q.dayHigh = Math.max(q.dayHigh, q.price);
        q.dayLow = Math.min(q.dayLow, q.price);
        q.changePct = q.prevClose ? ((q.price - q.prevClose) / q.prevClose) * 100 : 0;
        q.changeUsd = q.price - q.prevClose;
        q.updatedAt = now;
        s.price = q.price;
        const key = s.ticker + '::1D';
        if (INV.seriesCache[key]) INV.seriesCache[key][INV.seriesCache[key].length - 1] = q.price;
      });
      INV.checkAlerts();
      INV.runLimitOrders();
      INV.paint();
      if (!INV._lastPersist || now - INV._lastPersist > 45000) {
        INV._lastPersist = now;
        try { persist(); } catch (e) {}
      }
    };
    INV.__mkTickPatched = true;
  }

  /* ------------------------------ market notice ----------------------------- */
  function noticeText() {
    if (MK.feed && MK.feed.notice) return MK.feed.notice;
    return 'Simulated market data · 24/7';
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
      if (!/market data|market mode|Finnhub|Simulated market/i.test(el.textContent || '')) return;
      el.setAttribute('data-market-notice', '1');
      el.innerHTML = `<span class="wc-feed-dot ${live ? 'live' : 'sim'}"></span><span>${escMarket(txt)}</span>`;
    });
    let stock = document.getElementById('wcFeedNotice');
    if (!stock) {
      const chart = document.querySelector('.inv-chart');
      if (chart && chart.parentNode) {
        stock = document.createElement('div');
        stock.id = 'wcFeedNotice';
        stock.className = 'tiny muted center wc-feed-notice';
        stock.setAttribute('data-market-notice', '1');
        chart.parentNode.insertBefore(stock, chart.nextSibling);
      }
    }
    if (stock) {
      stock.innerHTML = `<span class="wc-feed-dot ${live ? 'live' : 'sim'}"></span>${escMarket(txt)} · updates every ${(MK.feed && MK.feed.status && MK.feed.status.refreshSec) || 15}s`;
      stock.classList.toggle('live', live);
      stock.classList.toggle('sim', !live);
    }
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

  function baselineFor(ticker) {
    const pos = openPosition(ticker);
    if (pos && Number(pos.entryPrice) > 0) return { price: Number(pos.entryPrice), side: pos.side === 'short' ? 'short' : 'long', pos };
    let q = null;
    try { q = INV.quote(ticker); } catch (e) {}
    const price = (q && (Number(q.prevClose) || Number(q.open) || Number(q.price))) || 100;
    return { price, side: 'long', pos: null };
  }

  function chartData(ticker) {
    let vals = [];
    try { vals = INV.series(ticker, '1D') || []; } catch (e) {}
    if (!vals.length) {
      try { vals = INV.series(ticker, '1W') || []; } catch (e) {}
    }
    if (!vals.length) vals = [100, 100];
    const now = Math.floor(Date.now() / 1000);
    const step = 60;
    return vals.map((v, i) => ({
      time: now - (vals.length - 1 - i) * step,
      value: Math.max(0.0001, Number(v) || 0)
    }));
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

  async function mountChart() {
    const host = document.querySelector('.inv-chart[data-lt-live-chart], .inv-chart[data-chart]');
    if (!host) { destroyChart(); return; }
    const ticker = (host.getAttribute('data-lt-live-chart') || (host.getAttribute('data-chart') || '').split('|')[0] || currentTicker()).toUpperCase();
    if (!ticker) return;
    if (MK.chart && MK.chart.ticker === ticker && document.body.contains(MK.chart.host)) {
      host.__wcLwc = true;
      updateChart();
      return;
    }
    destroyChart();
    host.innerHTML = '<div class="wc-lwc-loading">Loading live chart…</div>';
    let LWC;
    try { LWC = await loadLWC(); }
    catch (e) {
      MK.chartLoading = null;
      try { host.innerHTML = INV.lineChart(INV.series(ticker, '1D'), { h: 150 }); } catch (err) {}
      return;
    }
    if (!document.body.contains(host)) return;
    host.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'wc-lwc';
    wrap.id = 'wcLwcHost';
    host.appendChild(wrap);
    host.__wcLwc = true;
    host.removeAttribute('data-chart');

    const base = baselineFor(ticker);
    const chart = LWC.createChart(wrap, {
      width: wrap.clientWidth || host.clientWidth || 320,
      height: 230,
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
      localization: { priceFormatter: (p) => '$' + Number(p).toFixed(2) },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true }
    });

    const series = chart.addBaselineSeries({
      baseValue: { type: 'price', price: base.price },
      topLineColor: '#22c55e',
      topFillColor1: 'rgba(34,197,94,.28)',
      topFillColor2: 'rgba(34,197,94,.02)',
      bottomLineColor: '#ef4444',
      bottomFillColor1: 'rgba(239,68,68,.02)',
      bottomFillColor2: 'rgba(239,68,68,.28)',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      crosshairMarkerBorderColor: '#04101a',
      crosshairMarkerBackgroundColor: base.side === 'short' ? '#ef4444' : '#22c55e'
    });
    applyBaselineColors(series, base.side);

    const data = chartData(ticker);
    series.setData(data);
    chart.timeScale().fitContent();

    /* entry price marker line makes the baseline explicit */
    const entryLine = series.createPriceLine({
      price: base.price,
      color: 'rgba(255,255,255,.42)',
      lineWidth: 1,
      lineStyle: LWC.LineStyle.Dashed,
      axisLabelVisible: true,
      title: base.pos ? 'entry' : 'base'
    });

    MK.chart = {
      ticker, chart, series, host, wrap,
      basePrice: base.price, side: base.side,
      entryLine, lastTime: data.length ? data[data.length - 1].time : Math.floor(Date.now() / 1000),
      points: data.length
    };

    if (typeof ResizeObserver !== 'undefined') {
      MK.chart.ro = new ResizeObserver(() => {
        if (!MK.chart || MK.chart.chart !== chart) return;
        const width = wrap.clientWidth;
        if (width > 0) chart.applyOptions({ width });
      });
      MK.chart.ro.observe(wrap);
    }
  }

  function updateChart() {
    if (!MK.chart) return;
    const c = MK.chart;
    const ticker = c.ticker;
    let q;
    try { q = INV.quote(ticker); } catch (e) { return; }
    if (!q || !(q.price > 0)) return;

    /* follow an open Rise/Fall trade: baseline becomes the exact entry price */
    const base = baselineFor(ticker);
    if (Math.abs(base.price - c.basePrice) > 0.000001 || base.side !== c.side) {
      c.basePrice = base.price;
      c.side = base.side;
      c.series.applyOptions({ baseValue: { type: 'price', price: base.price } });
      applyBaselineColors(c.series, base.side);
      if (c.entryLine) {
        try {
          c.series.removePriceLine(c.entryLine);
        } catch (e) {}
        c.entryLine = c.series.createPriceLine({
          price: base.price,
          color: 'rgba(255,255,255,.42)',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: base.pos ? 'entry' : 'base'
        });
      }
    }

    const now = Math.floor(Date.now() / 1000);
    const time = now > c.lastTime ? now : c.lastTime + 1;
    try {
      c.series.update({ time, value: Number(q.price) });
      c.lastTime = time;
      c.points += 1;
      if (c.points > 900) {
        const fresh = chartData(ticker);
        c.series.setData(fresh);
        c.lastTime = fresh.length ? fresh[fresh.length - 1].time : time;
        c.points = fresh.length;
      }
    } catch (e) { /* out-of-order tick */ }
  }

  /* ------------------------------ admin panel ------------------------------- */
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
            <option value="hybrid">Hybrid (Live Finnhub + 24/7 Simulated Fallback)</option>
            <option value="simulated">Simulated Only</option>
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
        Hybrid mode seeds 16 tickers 1.2 seconds apart, then keeps one shared WebSocket open for real-time ticks.
        If Finnhub returns HTTP 429, the US market is closed, or ticks stop, the server keeps trading alive with
        smooth micro-ticks from the last real close — so open Rise/Fall positions never freeze at the weekend.
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
      badge.className = 'badge ' + (live ? 'badge-success' : st.mode === 'hybrid' ? 'badge-warn' : 'badge-accent');
      badge.textContent = st.mode === 'hybrid' ? (live ? 'Live · Finnhub' : 'Fallback · 24/7') : 'Simulated only';
    }
    if (!box) return;
    const when = (ms) => ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
    box.innerHTML = `
      <div class="mkt-stat"><span>Notice</span><b>${escMarket(st.notice || noticeText())}</b></div>
      <div class="mkt-stat"><span>Market</span><b>${st.marketOpen ? 'US session open' : 'US market closed'}</b></div>
      <div class="mkt-stat"><span>WebSocket</span><b class="${st.wsConnected ? 'up' : 'down'}">${st.wsConnected ? 'connected' : 'offline'}</b></div>
      <div class="mkt-stat"><span>Last real tick</span><b>${when(st.lastRealAt)}</b></div>
      <div class="mkt-stat"><span>Server price tick</span><b>${when(st.lastTickAt)}</b></div>
      <div class="mkt-stat"><span>Rate limit</span><b class="${st.rateLimitedUntil ? 'down' : 'up'}">${st.rateLimitedUntil ? '429 · fallback active' : 'clear'}</b></div>
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
        : 'No key saved yet. Hybrid mode needs a key; Simulated Only runs 24/7 without one.';
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
        adminToast('Market data settings saved · ' + (r.data.mode === 'hybrid' ? 'Hybrid' : 'Simulated only'), 'ok');
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

  /* append the feed card to Admin → Stocks */
  if (typeof INV !== 'undefined' && INV.viewAdminStocks && !INV.__mkAdminPatched) {
    const baseAdmin = INV.viewAdminStocks;
    INV.viewAdminStocks = function () {
      const html = baseAdmin.apply(this, arguments);
      if (/Admin access only/.test(html)) return html;
      return html + adminCardHTML();
    };
    INV.__mkAdminPatched = true;
  }

  /* ------------------------------- mounting -------------------------------- */
  function enhance() {
    paintNotice();
    paintAdminStatus();
    if (currentTicker()) {
      const host = document.querySelector('.inv-chart[data-lt-live-chart], .inv-chart[data-chart]');
      if (host) setTimeout(mountChart, 40);
    }
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
    .wc-lwc{width:100%;height:230px;position:relative}
    .wc-lwc-loading{height:230px;display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--muted)}
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
    setInterval(() => { if (currentTicker() && MK.chart) updateChart(); }, 2000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
