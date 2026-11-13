/* =========================================================================
   WhaleChat · TradeView app adapter (module wc-terminal-app)
   -------------------------------------------------------------------------
   1. Opens ONE direct Finnhub WebSocket for the whole page
      (wss://ws.finnhub.io?token=…) — the token is fetched from
      GET /api/market/stream, which only hands it out when the admin keeps
      browser streaming enabled. Every terminal (stock chart, live-trade
      chart, portfolio performance) multiplexes over that socket and renders
      tick-by-tick through pushTick().
      If streaming is unavailable the adapter falls back to the app quote feed,
      and the module itself falls back to its simulator.
   2. Downstream: /api/market/history for backfill, the spot book for orders.
   3. Mounts the terminal on the stock page (full ticket), the live-trade chart
      (compact) and the portfolio performance cards (equity layout).
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || !window.WC_TERMINAL) return;
  const A = window.WC_TERMINAL_APP = window.WC_TERMINAL_APP || {};
  A.mounted = A.mounted || [];
  A.feedMode = 'starting';

  const TF = { '1m': 900, '5m': 700, '15m': 700, '1H': 800, '1D': 900 };
  const EQ_TF = ['1D', '1W', '1M', '1Y', 'ALL'];
  const EQ_WINDOW = { '1D': 864e5, '1W': 7 * 864e5, '1M': 30 * 864e5, '3M': 90 * 864e5, '1Y': 365 * 864e5, 'ALL': 3 * 365 * 864e5 };
  const APP_TO_TERMINAL_TF = { '1D': '5m', '1W': '15m', '1M': '1H', '3M': '1H', '1Y': '1D', 'ALL': '1D' };

  /* ---------------------------------------------------------------- plumbing */
  function apiPath(p) {
    try { if (typeof Remote !== 'undefined' && Remote && Remote.enabled) return Remote.url(p); } catch (e) {}
    return p;
  }
  async function getJSON(pathname, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms || 12000);
    try {
      const r = await fetch(apiPath(pathname), { signal: ctrl.signal, headers: { 'content-type': 'application/json' } });
      return await r.json().catch(() => null);
    } finally { clearTimeout(timer); }
  }
  async function postJSON(pathname, body, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms || 25000);
    try {
      const r = await fetch(apiPath(pathname), {
        method: 'POST', signal: ctrl.signal, headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      return { ok: r.ok, data: await r.json().catch(() => null) };
    } finally { clearTimeout(timer); }
  }
  function meId() { try { return (typeof me === 'function' && me()) ? me().id : null; } catch (e) { return null; } }
  function notify(msg, type) { try { if (typeof toast === 'function') toast(msg, type || 'ok'); } catch (e) {} }
  function price(ticker) {
    try { const q = INV.quote(ticker); return q && q.price > 0 ? Number(q.price) : 0; } catch (e) { return 0; }
  }

  /* --------------------------------------------------- direct Finnhub socket */
  async function initStream() {
    let info = null;
    try { info = await getJSON('/api/market/stream', 8000); } catch (e) { info = null; }
    A.streamInfo = info;
    if (info && info.enabled && info.url) {
      A.streamInst = WC_TERMINAL.stream({ url: info.url, maxSymbols: info.maxSymbols || 50, symbolMap: info.symbolMap || {} });
      A.feedMode = 'finnhub';
      A.streamInst.onStatus((st, extra) => {
        A.feedStatus = st;
        if (st === 'live') A.feedMode = 'finnhub';
        else if (st === 'reconnecting' || st === 'error') A.feedMode = 'finnhub-reconnecting';
      });
      console.log('[tradeview] Finnhub WebSocket stream enabled', extra(info));
    } else {
      A.feedMode = 'app-feed';
    }
    A.ready = true;
    schedule();
  }
  function extra(info) { return { symbols: (info.symbols || []).length, at: info.at }; }

  /* reconnect instantly when the network comes back */
  window.addEventListener('beforeunload', () => {
    try { if (A.streamInst) A.streamInst.close(); } catch (e) {}
  });
  window.addEventListener('online', () => {
    try { if (A.streamInst && A.streamInst.status !== 'live') A.streamInst._open(); } catch (e) {}
  });

  /* -------------------------------------------------------------------- data */
  async function history(ticker, tf) {
    const limit = TF[tf] || 700;
    const d = await getJSON('/api/market/history?tickers=' + encodeURIComponent(ticker) + '&limit=' + limit);
    const raw = (d && d.history && d.history[ticker]) || [];
    let pts = raw.map((p) => ({ time: Math.floor((Number(p.t) || 0) / 1000), value: Number(p.p) || 0 }))
      .filter((p) => p.time > 0 && p.value > 0);
    if (pts.length < 40) {
      /* too thin to draw (no Finnhub candles, market closed or a just-booted
         server) — synthesise
         a drift-corrected walk so the tape still lands exactly on the live price */
      const live = price(ticker) || 100;
      const now = Math.floor(Date.now() / 1000);
      const step = { '1m': 10, '5m': 30, '15m': 60, '1H': 180, '1D': 900 }[tf] || 30;
      const n = 320;
      const walk = [0];
      for (let i = 1; i < n; i++) walk.push(walk[i - 1] + (Math.random() - 0.5) * live * 0.0022);
      const drift = walk[n - 1];
      pts = [];
      for (let i = 0; i < n; i++) {
        const v = live + walk[i] - drift * (i / (n - 1));
        pts.push({ time: now - (n - 1 - i) * step, value: Math.round(v * 100) / 100 });
      }
      pts[pts.length - 1].value = live;
    }
    const clean = [];
    pts.sort((a, b) => a.time - b.time).forEach((p) => {
      if (!clean.length || p.time > clean[clean.length - 1].time) clean.push(p);
      else clean[clean.length - 1].value = p.value;
    });
    const live = price(ticker);
    if (live > 0 && clean.length) {
      const last = clean[clean.length - 1].value;
      if (last > 0 && Math.abs(live / last - 1) > 0.0005) {
        const k = Math.min(45, clean.length);
        const factor = live / last;
        for (let i = 0; i < k; i++) {
          const w = (i + 1) / k;
          clean[clean.length - k + i].value = Math.round(clean[clean.length - k + i].value * (1 + (factor - 1) * w) * 100) / 100;
        }
      }
      clean[clean.length - 1].value = live;
    }
    return clean;
  }

  /* fallback feed: the app's own quote bridge (backend polls Finnhub) */
  function pollFeed(ticker, cb) {
    let last = price(ticker);
    const id = setInterval(() => {
      const p = price(ticker);
      if (p > 0 && p !== last) { last = p; cb({ time: Date.now() / 1000, price: p }); }
    }, 900);
    return function () { clearInterval(id); };
  }

  function symbols() {
    try {
      return INV.stocks().slice(0, 50).map((s) => ({
        ticker: s.ticker, name: s.name || s.ticker, base: Number(s.price) || price(s.ticker) || 100
      }));
    } catch (e) { return null; }
  }

  function stats(ticker) {
    try {
      const s = INV.stock(ticker) || {};
      const q = INV.quote(ticker) || {};
      const open = Number(q.prevClose || s.prevClose || 0) || 0;
      return { open, price: Number(q.price) || 0, changePct: Number(q.changePct) || 0 };
    } catch (e) { return null; }
  }

  /* --------------------------------------------------------------- portfolio */
  const EQ_TO_HIST = { '1D': '5m', '1W': '15m', '1M': '1H', '3M': '1H', '1Y': '1D', 'ALL': '1D' };

  function holdingsList() {
    try { return INV.holdings(meId()) || []; } catch (e) { return []; }
  }

  /* Portfolio equity curve = weighted holdings history + cash, so the live
     value continues exactly where the historical curve ends. */
  async function equity(tf) {
    const key = EQ_WINDOW[tf] ? tf : '1M';
    const hist = EQ_TO_HIST[key] || '1H';
    const hs = holdingsList();
    if (!hs.length) {
      const v = portfolioValue();
      return [
        { time: Math.floor(Date.now() / 1000) - 600, value: v },
        { time: Math.floor(Date.now() / 1000), value: v }
      ];
    }
    const series = await Promise.all(hs.map(async (h) => {
      let pts = [];
      try { pts = await history(h.ticker, hist); } catch (e) { pts = []; }
      return { h, pts };
    }));
    const len = Math.max.apply(null, series.map((s) => s.pts.length).concat([2]));
    const now = Math.floor(Date.now() / 1000);
    const winSec = (EQ_WINDOW[key] || EQ_WINDOW['1M']) / 1000;
    const out = [];
    for (let i = 0; i < len; i++) {
      let v = 0;
      series.forEach(({ h, pts }) => {
        const p = pts.length ? pts[Math.min(i, pts.length - 1)].value : (price(h.ticker) || Number(h.avgPrice) || 0);
        v += (Number(h.shares) || 0) * (Number(p) || 0);
      });
      const src = series[0].pts;
      const t = src.length ? src[Math.min(i, src.length - 1)].time : now - (len - 1 - i) * (winSec / len);
      out.push({ time: t, value: Math.round(v * 100) / 100 });
    }
    /* keep time strictly increasing and end at "now" with the live value */
    const clean = [];
    out.forEach((p) => { if (!clean.length || p.time > clean[clean.length - 1].time) clean.push(p); });
    const live = portfolioValue();
    if (live > 0 && clean.length) {
      const last = clean[clean.length - 1].value;
      if (last > 0 && Math.abs(live / last - 1) > 0.0005) {
        const k = Math.min(24, clean.length);
        const factor = live / last;
        for (let i = 0; i < k; i++) {
          const w = (i + 1) / k;
          clean[clean.length - k + i].value = Math.round(clean[clean.length - k + i].value * (1 + (factor - 1) * w) * 100) / 100;
        }
      }
      clean[clean.length - 1].value = Math.round(live * 100) / 100;
    }
    return clean;
  }

  function portfolioValue() {
    try {
      if (window.LT && typeof LT.summary === 'function') {
        const s = LT.summary(meId());
        if (s && Number(s.valueUsd) > 0) return Number(s.valueUsd);
      }
    } catch (e) {}
    try {
      const hs = INV.holdings(meId()) || [];
      return hs.reduce((a, h) => a + (Number(h.shares) || 0) * (price(h.ticker) || Number(h.avgPrice) || 0), 0);
    } catch (e) { return 0; }
  }
  function liveValue() { return portfolioValue(); }

  /* ------------------------------------------------------------------ orders */
  function position(ticker) {
    try {
      const h = INV.holding(ticker, meId());
      if (!h || !(h.shares > 0)) return null;
      return {
        side: 'long', entry: Number(h.avgPrice) || price(ticker),
        qty: Number(h.shares) || 0, amountUsd: (Number(h.shares) || 0) * (Number(h.avgPrice) || 0),
        tp: Number(h.takeProfitPrice || h.tpPrice) || 0,
        sl: Number(h.stopLossPrice || h.slPrice) || 0
      };
    } catch (e) { return null; }
  }
  async function buy(o) {
    if (o.side === 'short') throw new Error('Short positions are not live on the WhaleChat spot book yet — switch to Buy / Long.');
    const body = { userId: meId(), ticker: o.symbol, amountUsd: o.amountUsd };
    if (o.tpPrice) body.tpPrice = Math.round(o.tpPrice * 10000) / 10000;
    if (o.slPrice) body.slPrice = Math.round(o.slPrice * 10000) / 10000;
    const r = await postJSON('/api/market/spot/buy', body, 30000);
    const d = r.data || {};
    if (!r.ok || !d.ok) throw new Error(d.error || 'Buy failed');
    notify('Bought ' + o.symbol + ' · ' + Number((d.order && d.order.shares) || 0).toFixed(4) + ' sh', 'ok');
    refreshApp();
    return { ok: true, entry: Number(d.order && d.order.entryPrice) || price(o.symbol), order: d.order };
  }
  async function sell(o) {
    const r = await postJSON('/api/market/spot/sell', { userId: meId(), ticker: o.symbol }, 30000);
    const d = r.data || {};
    if (!r.ok || !d.ok) throw new Error(d.error || 'Sell failed');
    notify('Sold ' + o.symbol + ' · ' + Number(d.payout || 0).toFixed(2) + ' WC credited', 'ok');
    refreshApp();
    return { ok: true };
  }
  function refreshApp() {
    try { if (typeof Remote !== 'undefined' && Remote && Remote.enabled) Remote.refresh(true).catch(function () {}); } catch (e) {}
  }
  function balance() {
    try { const u = me(); return u ? Math.max(0, Number(u.balance) || 0) * 0.5 : 0; } catch (e) { return 0; }
  }

  A.adapter = { history, subscribe: pollFeed, symbols, stats, position, buy, sell, balance, equity, liveValue };

  /* ---------------------------------------------------------------- styling */
  (function styleOnce() {
    if (document.getElementById('wc-terminal-app-css')) return;
    const st = document.createElement('style');
    st.id = 'wc-terminal-app-css';
    st.textContent =
      '.inv-chart[data-wc-terminal]{height:auto!important;min-height:620px;margin:12px 0 4px!important;background:transparent}' +
      '.inv-chart[data-wc-terminal] .wc-terminal-host{height:100%}' +
      '.inv-chart[data-wc-terminal] .wt{min-height:600px}' +
      '.inv-chart[data-wc-terminal][data-wc-kind=equity],.inv-chart[data-wc-terminal][data-wc-kind=compact]{min-height:340px}' +
      '.inv-chart[data-wc-terminal][data-wc-kind=equity] .wt,.inv-chart[data-wc-terminal][data-wc-kind=compact] .wt{min-height:320px}' +
      '.inv-chart[data-wc-terminal][data-wc-kind=equity] .wt-head,.inv-chart[data-wc-terminal][data-wc-kind=compact] .wt-head{padding:8px 10px}' +
      '.inv-chart[data-wc-terminal][data-wc-kind=equity] .wt-stage,.inv-chart[data-wc-terminal][data-wc-kind=compact] .wt-stage{min-height:240px}' +
      '.inv-chartcard:has([data-wc-terminal]) .inv-seg{display:none}' +
      '.inv-chartcard:has([data-wc-terminal]) [data-market-notice]{display:none}' +
      '@media(max-width:820px){.inv-chart[data-wc-terminal]{min-height:0}.inv-chart[data-wc-terminal] .wt{min-height:0}}';
    document.head.appendChild(st);
  })();

  /* the legacy stock chart module must not fight the terminal for the same host */
  function retireLegacy() {
    try {
      if (window.WC_PRO_CHART && window.WC_PRO_CHART.mountStock && !window.WC_PRO_CHART.__retired) {
        window.WC_PRO_CHART.__retired = true;
        window.WC_PRO_CHART.mountStock = function () { return null; };
      }
      if (window.WC_PRO_CHART && window.WC_PRO_CHART.mountPortfolio && !window.WC_PRO_CHART.__retiredEq) {
        window.WC_PRO_CHART.__retiredEq = true;
        window.WC_PRO_CHART.mountPortfolio = function () { return null; };
      }
    } catch (e) {}
  }
  retireLegacy();
  setTimeout(retireLegacy, 400);
  setTimeout(retireLegacy, 1600);

  /* --------------------------------------------------------------- mounting */
  function kindOf(node) {
    const chartSpec = (node.getAttribute('data-chart') || '').split('|');
    const ltSpec = (node.getAttribute('data-lt-live-chart') || '').split('|');
    const ltdTf = node.getAttribute('data-ltd-chart');
    if (chartSpec[0] === '__portfolio__' || node.id === 'ltDashChart' || ltdTf) {
      return { kind: 'equity', tf: ltdTf || chartSpec[1] || '1M' };
    }
    const ticker = String(ltSpec[0] || chartSpec[0] || '').toUpperCase();
    if (!ticker || ticker.startsWith('__')) return null;
    if (node.hasAttribute('data-lt-live-chart')) return { kind: 'compact', ticker, timeframe: APP_TO_TERMINAL_TF[String(ltSpec[1] || '1D').toUpperCase()] || '5m' };
    return {
      kind: 'full', ticker,
      timeframe: APP_TO_TERMINAL_TF[String(chartSpec[1] || '1D').toUpperCase()] || '5m',
      mode: String(chartSpec[2] || '').toLowerCase() === 'candle' ? 'candle' : 'line'
    };
  }

  function mountAll() {
    const nodes = document.querySelectorAll('.inv-chart[data-chart], .inv-chart[data-lt-live-chart], #ltDashChart');
    Array.prototype.forEach.call(nodes, (host) => {
      const spec = kindOf(host);
      if (!spec) return;
      const sig = spec.kind + ':' + (spec.ticker || '') + ':' + (spec.timeframe || spec.tf || '');
      if (host.__wcTerminal && host.__wcSig === sig && document.body.contains(host.__wcTerminal.root)) return;
      if (host.__wcTerminal) { try { host.__wcTerminal.destroy(); } catch (e) {} }

      const wrap = document.createElement('div');
      wrap.className = 'wc-terminal-host';
      wrap.style.cssText = 'margin:2px 0 6px';
      host.innerHTML = '';
      host.appendChild(wrap);
      host.setAttribute('data-wc-terminal', '1');
      host.setAttribute('data-wc-kind', spec.kind);
      ['data-chart', 'data-lt-live-chart', 'data-lt-tf', 'data-lt-mode', 'data-ltd-chart'].forEach((a) => host.removeAttribute(a));

      const opts = {
        adapter: A.adapter,
        theme: WC_TERMINAL.style || 'obsidian',
        storage: true,
        stylePicker: spec.kind === 'full',
        onNotify: notify
      };
      if (spec.kind === 'equity') {
        opts.kind = 'equity';
        opts.timeframes = EQ_TF;
        opts.timeframe = spec.tf || '1M';
        opts.equityLabel = host.closest('.card') ? 'Portfolio performance' : 'Portfolio';
        opts.simulate = false;
      } else {
        opts.symbol = spec.ticker;
        opts.timeframe = spec.timeframe || '5m';
        opts.mode = spec.mode || 'line';
        opts.modeLocked = spec.kind === 'full';
        opts.showExec = spec.kind === 'full';
        opts.balance = balance();
        if (A.streamInst) opts.feed = A.streamInst;
      }

      let inst;
      try { inst = WC_TERMINAL.mount(wrap, opts); }
      catch (e) { console.error('[tradeview] mount failed', e); return; }

      /* the app's own patchers skip hosts flagged with __wcLwc — set it so it
         never overwrites the terminal with the legacy SVG sparkline */
      host.__wcLwc = true;
      host.__wcTerminal = inst;
      host.__wcSig = sig;
      A.mounted.push(inst);
      if (spec.kind !== 'equity') setTimeout(() => { try { inst.setPosition(position(spec.ticker)); } catch (e) {} }, 900);
    });
  }

  function sweep() {
    A.mounted.slice().forEach((i) => {
      if (!document.body.contains(i.root)) {
        try { i.destroy(); } catch (e) {}
        const k = A.mounted.indexOf(i);
        if (k >= 0) A.mounted.splice(k, 1);
      }
    });
  }

  let scheduled = false;
  function schedule() {
    if (!A.ready || scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      try { sweep(); mountAll(); } catch (e) { console.error('[tradeview] mount pass failed', e); }
    }, 260);
  }

  window.addEventListener('hashchange', schedule);
  document.addEventListener('click', () => setTimeout(schedule, 320), true);
  setInterval(schedule, 2500);

  /* live balance / position refresh while a terminal is on screen */
  setInterval(() => {
    A.mounted.forEach((i) => {
      if (!document.body.contains(i.root)) return;
      if (i.o.kind === 'equity') return;
      try { i.setBalance(balance()); } catch (e) {}
      try { i.setPosition(position(i.symbol)); } catch (e) {}
    });
  }, 5000);

  initStream();
})();
