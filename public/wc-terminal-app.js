/* =========================================================================
   WhaleChat · TradeView app adapter (module wc-terminal-app)
   Mounts WC_TERMINAL on the stock detail page and feeds it real app data:
   quotes from the WhaleChat backend (Finnhub stays server-side), history from
   /api/market/history, and the spot book for buy / sell.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || !window.WC_TERMINAL) return;
  const A = window.WC_TERMINAL_APP = window.WC_TERMINAL_APP || {};
  A.mounted = A.mounted || [];

  const TF = { '1m': 900, '5m': 700, '15m': 700, '1H': 800, '1D': 900 };
  const PCT = 0.001;

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

  /* ------------------------------------------------------------------ data */
  async function history(ticker, tf) {
    const limit = TF[tf] || 700;
    const d = await getJSON('/api/market/history?tickers=' + encodeURIComponent(ticker) + '&limit=' + limit);
    const raw = (d && d.history && d.history[ticker]) || [];
    let pts = raw.map((p) => ({ time: Math.floor((Number(p.t) || 0) / 1000), value: Number(p.p) || 0 }))
      .filter((p) => p.time > 0 && p.value > 0);
    if (!pts.length) {
      /* offline fallback: synthesise a walk that ends on the live quote */
      const live = price(ticker) || 100;
      const now = Math.floor(Date.now() / 1000);
      const step = { '1m': 10, '5m': 30, '15m': 60, '1H': 180, '1D': 900 }[tf] || 30;
      const n = 320;
      const walk = [0];
      for (let i = 1; i < n; i++) walk.push(walk[i - 1] + (Math.random() - 0.5) * live * 0.0022);
      const drift = walk[n - 1];                    /* remove drift so the tape lands exactly on the live price */
      pts = [];
      for (let i = 0; i < n; i++) {
        const v = live + walk[i] - drift * (i / (n - 1));
        pts.push({ time: now - (n - 1 - i) * step, value: Math.round(v * 100) / 100 });
      }
      pts[pts.length - 1].value = live;
    }
    /* strictly increasing time, no duplicates */
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
          const w = (i + 1) / k;                     /* 0 at the far end → 1 at the tip */
          clean[clean.length - k + i].value = Math.round(clean[clean.length - k + i].value * (1 + (factor - 1) * w) * 100) / 100;
        }
      }
      clean[clean.length - 1].value = live;
    }
    return clean;
  }

  function subscribe(ticker, cb) {
    let last = price(ticker);
    const tick = () => {
      const p = price(ticker);
      if (p > 0 && p !== last) { last = p; cb({ time: Date.now() / 1000, price: p }); }
    };
    const id = setInterval(tick, 900);
    return function () { clearInterval(id); };
  }

  function stats(ticker) {
    try {
      const s = INV.stock(ticker) || {};
      const q = INV.quote(ticker) || {};
      const open = Number(q.prevClose || s.prevClose || 0) || 0;
      return { open, price: Number(q.price) || 0, changePct: Number(q.changePct) || 0 };
    } catch (e) { return null; }
  }

  function symbols() {
    try {
      return INV.stocks().slice(0, 60).map((s) => ({
        ticker: s.ticker, name: s.name || s.ticker, base: Number(s.price) || price(s.ticker) || 100
      }));
    } catch (e) { return null; }
  }

  function position(ticker) {
    try {
      const h = INV.holding(ticker, meId());
      if (!h || !(h.shares > 0)) return null;
      return {
        side: 'long', entry: Number(h.avgPrice) || price(ticker),
        qty: Number(h.shares) || 0, amountUsd: (Number(h.shares) || 0) * (Number(h.avgPrice) || 0),
        tp: Number(h.tpPrice) || 0, sl: Number(h.slPrice) || 0
      };
    } catch (e) { return null; }
  }

  async function buy(o) {
    if (o.side === 'short') {
      throw new Error('Short positions are not live on the WhaleChat spot book yet — switch to Buy / Long.');
    }
    const body = { userId: meId(), ticker: o.symbol, amountUsd: o.amountUsd };
    if (o.tpPrice) body.tpPrice = Math.round(o.tpPrice * 10000) / 10000;
    if (o.slPrice) body.slPrice = Math.round(o.slPrice * 10000) / 10000;
    const r = await postJSON('/api/market/spot/buy', body, 30000);
    const d = r.data || {};
    if (!r.ok || !d.ok) throw new Error(d.error || 'Buy failed');
    notify('Bought ' + o.symbol + ' · ' + Number(d.order && d.order.shares || 0).toFixed(4) + ' sh', 'ok');
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
    try {
      if (typeof Remote !== 'undefined' && Remote && Remote.enabled) Remote.refresh(true).catch(function () {});
    } catch (e) {}
  }

  function balance() {
    try { const u = me(); return u ? Math.max(0, Number(u.balance) || 0) * 0.5 : 0; } catch (e) { return 0; }
  }

  A.adapter = { history, subscribe, symbols, position, buy, sell, balance, stats };

  /* the stock page host is a 150px mini-chart box — let the terminal breathe */
  (function styleOnce() {
    if (document.getElementById('wc-terminal-app-css')) return;
    const st = document.createElement('style');
    st.id = 'wc-terminal-app-css';
    st.textContent =
      '.inv-chart[data-wc-terminal]{height:auto!important;min-height:620px;margin:12px 0 4px!important;background:transparent}' +
      '.inv-chart[data-wc-terminal] .wc-terminal-host{height:100%}' +
      '.inv-chart[data-wc-terminal] .wt{min-height:600px}' +
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
    } catch (e) {}
  }
  retireLegacy();
  setTimeout(retireLegacy, 400);
  setTimeout(retireLegacy, 1600);

  /* --------------------------------------------------------------- mounting */
  function findHost() {
    const h = document.querySelector('.inv-chart[data-chart], .inv-chart[data-lt-live-chart]');
    if (!h) return null;
    const spec = (h.getAttribute('data-chart') || h.getAttribute('data-lt-live-chart') || '').split('|');
    const ticker = String(spec[0] || '').toUpperCase();
    if (!ticker || ticker === '__PORTFOLIO__' || ticker === '__LTD__') return null;
    const map = { '1D': '5m', '1W': '15m', '1M': '1H', '3M': '1H', '1Y': '1D', 'ALL': '1D' };
    return {
      host: h, ticker,
      timeframe: map[String(spec[1] || '1D').toUpperCase()] || '5m',
      mode: String(spec[2] || '').toLowerCase() === 'candle' ? 'candle' : 'line'
    };
  }

  function mountOne() {
    const found = findHost();
    if (!found) return;
    const host = found.host;
    if (host.__wcTerminal && host.__wcTerminalTicker === found.ticker && document.body.contains(host.__wcTerminal.root)) return;
    if (host.__wcTerminal) { try { host.__wcTerminal.destroy(); } catch (e) {} }

    /* the app's own chart fills the host — give the terminal its own wrapper */
    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin:2px 0 6px';
    wrap.className = 'wc-terminal-host';
    host.setAttribute('data-wc-terminal', '1');
    host.removeAttribute('data-chart');
    host.removeAttribute('data-lt-live-chart');
    host.removeAttribute('data-lt-tf');
    host.removeAttribute('data-lt-mode');
    host.innerHTML = '';
    host.appendChild(wrap);

    let inst;
    try {
      inst = WC_TERMINAL.mount(wrap, {
        adapter: A.adapter,
        symbol: found.ticker,
        theme: WC_TERMINAL.style || 'obsidian',
        timeframe: found.timeframe || '5m',
        mode: found.mode || 'line',
        modeLocked: true,
        stylePicker: true,
        storage: true,
        onNotify: notify
      });
    } catch (e) {
      console.error('[wc-terminal] mount failed', e);
      return;
    }
    host.__wcTerminal = inst;
    host.__wcTerminalTicker = found.ticker;
    A.mounted.push(inst);
    setTimeout(() => {
      try { inst.setBalance(balance()); } catch (e) {}
      try { inst.setPosition(position(found.ticker)); } catch (e) {}
    }, 900);
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
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      try { sweep(); mountOne(); } catch (e) {}
    }, 260);
  }

  schedule();
  window.addEventListener('hashchange', schedule);
  document.addEventListener('click', () => setTimeout(schedule, 320), true);
  setInterval(schedule, 2500);

  /* live balance / position refresh while a terminal is on screen */
  setInterval(() => {
    A.mounted.forEach((i) => {
      if (!document.body.contains(i.root)) return;
      try { i.setBalance(balance()); } catch (e) {}
      try { i.setPosition(position(i.symbol)); } catch (e) {}
    });
  }, 5000);
})();
