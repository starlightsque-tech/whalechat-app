/* =========================================================================
   WhaleChat Shares — share investment dashboard
   Plans are defined by admins; the share price, accruals and maturities are
   simulated server-side (shares.js) so they keep moving while the app is shut.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  const S = window.WC_SHARES = window.WC_SHARES || {};
  S.state = S.state || null;
  S.admin = S.admin || null;
  S.loading = false;
  S.pending = null;
  S.loadedAt = 0;
  S.adminLoading = false;
  S.adminPending = null;
  S.adminLoadedAt = 0;

  function escS(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function num(v, n) { return (Number(v) || 0).toFixed(n == null ? 2 : n); }
  function tinyNum(v) {
    const n = Number(v) || 0;
    if (Math.abs(n) >= 1) return n.toFixed(2);
    return n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0';
  }
  function money(v) { return '$' + num(v, 2); }
  function wc(v) { return num(v) + ' WC'; }
  function both(coins) { return money(Number(coins) * 0.5) + ' USD'; }
  function bothEarn(coins) { return (Math.abs(Number(coins)) < 1 ? '$' + (Number(coins) * 0.5).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') : money(Number(coins) * 0.5)) + ' USD'; }
  function when(ms) { try { return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) { return '—'; } }
  function left(ms) {
    if (!(ms > 0)) return 'Matured';
    const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000), m = Math.floor((ms % 3600000) / 60000);
    if (d > 0) return d + 'd ' + h + 'h left';
    if (h > 0) return h + 'h ' + m + 'm left';
    return Math.max(1, m) + 'm left';
  }
  function tmsg(msg, type) { if (typeof toast === 'function') toast(msg, type || 'ok'); }
  function apiPath(p) { try { if (typeof Remote !== 'undefined' && Remote && Remote.enabled) return Remote.url(p); } catch (e) {} return p; }
  async function api(pathname, opts, timeout) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout || 20000);
    try {
      const res = await fetch(apiPath(pathname), Object.assign({ signal: ctrl.signal, headers: { 'content-type': 'application/json' } }, opts || {}));
      const data = await res.json().catch(() => null);
      return { res, data };
    } finally { clearTimeout(timer); }
  }
  function uidNow() { try { return me().id; } catch (e) { return ''; } }
  function isAdmin() { try { return me() && me().role === 'admin'; } catch (e) { return false; } }

  /* When the Cloudflare worker does not expose the shares engine, the page
     still has to show the user's real WC-Investing capital and let them
     invest. Everything below reads the same investAcct.portfolios.wc field
     that transfers update, so a top-up is visible immediately. */
  function localEngine() {
    try { return window.WC_INVEST || null; } catch (e) { return null; }
  }
  function localState() {
    const P = localEngine();
    if (!P || typeof P.summary !== 'function') return null;
    let u = null;
    try { u = me(); } catch (e) {}
    if (!u) return null;
    const s = P.summary();
    const price = Number(P.sharePrice && P.sharePrice()) || 12.45;
    const plans = (P.catalog ? P.catalog() : []).map((p) => {
      const days = Math.max(1, Number(p.days) || 1);
      return Object.assign({}, p, {
        durationValue: days, durationUnit: 'days', durationDays: days,
        durationLabel: days + (days === 1 ? ' day' : ' days'),
        returnPct: Number(p.ratePct) || 0,
        dailyReturnPct: Number(p.ratePct) || 0,
        totalReturnPct: (Number(p.ratePct) || 0) * days,
        minCoins: (Number(p.minUsd) || 0) * 2,
        maxCoins: (Number(p.maxUsd) || 0) * 2,
        enabled: true
      });
    });
    const active = (s.active || []).map((inv) => {
      const pr = P.progress ? P.progress(inv, price) : {};
      const capUsd = Number(inv.capitalUsd) || 0;
      const accruedUsd = Number(pr.accruedUsd) || 0;
      const targetUsd = Number(inv.projectedRoiUsd) || 0;
      return {
        id: inv.id, planId: inv.planId, planName: inv.planName || inv.planId,
        amountUsd: capUsd, amountCoins: capUsd * 2,
        returnPct: Number(inv.ratePct) || 0, dailyReturnPct: Number(inv.ratePct) || 0,
        durationDays: Number(inv.days) || 1, totalReturnPct: (Number(inv.ratePct) || 0) * (Number(inv.days) || 1),
        durationLabel: (Number(inv.days) || 1) + ' days',
        entryPriceUsd: Number(inv.entryPriceUsd) || price,
        paidFrom: inv.paidFrom || 'capital',
        shares: Number(inv.shares) || (price > 0 ? capUsd / price : 0),
        startAt: Number(inv.startedAt) || Date.now(), endAt: Number(inv.endsAt) || Date.now(),
        status: inv.status, accruedCoins: accruedUsd * 2, accruedUsd,
        targetProfitCoins: targetUsd * 2, targetProfitUsd: targetUsd,
        currentValueCoins: (capUsd + accruedUsd) * 2, currentValueUsd: capUsd + accruedUsd,
        progressPct: Number(pr.pct) || 0, remainingMs: Math.max(0, (Number(inv.endsAt) || 0) - Date.now()),
        completedAt: inv.completedAt || null,
        equityHistory: (function () {
          try {
            return (P.planSeriesUsd ? P.planSeriesUsd(inv, 40) : []).map(function (p) { return { t: p.t, coins: (Number(p.v) || 0) / 0.5 }; });
          } catch (e) { return []; }
        })()
      };
    });
    const investedUsd = active.reduce((a, x) => a + x.amountUsd, 0);
    const accruedUsd = active.reduce((a, x) => a + x.accruedUsd, 0);
    return {
      ok: true, __local: true, enabled: true,
      balance: Number(s.capital) || 0,
      balanceUsd: Number(s.capital) || 0,
      wcUsd: Number(s.capital) || 0,
      payoutUsd: Number(s.profit) || 0,
      coinsPerUsd: 2,
      plans,
      investments: active, completed: [],
      summary: {
        activeCount: active.length, investedCoins: investedUsd * 2, investedUsd,
        accruedCoins: accruedUsd * 2, accruedUsd,
        targetProfitCoins: active.reduce((a, x) => a + x.targetProfitCoins, 0),
        targetProfitUsd: active.reduce((a, x) => a + x.targetProfitUsd, 0),
        completedProfitCoins: 0, completedProfitUsd: 0,
        totalEarnedCoins: accruedUsd * 2, totalEarnedUsd: accruedUsd,
        shares: active.reduce((a, x) => a + x.shares, 0),
        sharePriceUsd: price, sharePriceCoins: price * 2
      },
      shareMarket: {
        priceUsd: price, priceCoins: price * 2, updatedAt: Date.now(),
        history: (function () {
          try {
            var h = (DB && DB.shareMarket && Array.isArray(DB.shareMarket.history)) ? DB.shareMarket.history : [];
            return h.map(function (x) { return { t: Number(x.t || x.time) || 0, p: Number(x.p != null ? x.p : (x.price || x.priceUsd)) || 0 }; })
              .filter(function (x) { return x.t > 0 && x.p > 0; });
          } catch (e) { return []; }
        })()
      },
      serverTime: Date.now()
    };
  }

  S.localState = localState;
  async function load(force) {
    if (S.loading && S.pending) return S.pending;
    /* WC-Investing is the single source of truth: capital, active plans and
       share price come from the same engine the WC-Investing page uses, so
       both pages always agree. */
    const authoritative = localState();
    if (authoritative) { S.state = authoritative; S.loadedAt = Date.now(); return S.state; }
    if (!force && S.state && S.state.__local) { const ls = localState(); if (ls) { S.state = ls; S.loadedAt = Date.now(); return S.state; } }
    if (!force && S.state && Date.now() - S.loadedAt < 4000) return S.state;
    if (typeof Remote === 'undefined' || !Remote.enabled) return S.state;
    S.loading = true;
    S.pending = (async () => {
      try {
        const r = await api('/api/shares/state?userId=' + encodeURIComponent(uidNow()), {}, 12000);
        if (r.data && r.data.ok && r.data.__local) { S.state = r.data; S.loadedAt = Date.now(); }
        else if (r.data && r.data.ok && r.data.enabled !== false && r.data.summary) { S.state = r.data; S.loadedAt = Date.now(); }
        else { const ls = localState(); if (ls) { S.state = ls; S.loadedAt = Date.now(); } }
      } catch (e) { console.error('shares state', e); }
      finally { S.loading = false; S.pending = null; }
      return S.state;
    })();
    return S.pending;
  }

  async function loadAdmin(force) {
    if (!isAdmin()) return null;
    if (typeof Remote === 'undefined' || !Remote.enabled) return null;
    if (S.adminLoading && S.adminPending) return S.adminPending;
    if (!force && S.admin && Date.now() - S.adminLoadedAt < 5000) return S.admin;
    S.adminLoading = true;
    S.adminPending = (async () => {
      try {
        const r = await api('/api/shares/admin?adminId=' + encodeURIComponent(uidNow()), {}, 12000);
        if (r.data && r.data.ok) { S.admin = r.data; S.adminLoadedAt = Date.now(); }
      } catch (e) { console.error('shares admin', e); }
      finally { S.adminLoading = false; S.adminPending = null; }
      return S.admin;
    })();
    return S.adminPending;
  }

  /* --------------------------------- charts -------------------------------- */
  function svgChart(points, opts) {
    const o = opts || {};
    const W = 320, H = o.height || 120;
    const padTop = o.label ? 12 : 4, padBot = 12;
    const pts = (points || []).filter((p) => p && Number(p.v) >= 0);
    if (pts.length < 2) return '<div class="shares-chart-empty">Chart appears after the first data points.</div>';
    let min = Math.min.apply(null, pts.map((p) => p.v)), max = Math.max.apply(null, pts.map((p) => p.v));
    if (max - min < 0.0001) { max += 1; min -= 1; }
    const pad = (max - min) * 0.12; max += pad; min -= pad;
    const innerW = W - 42, innerH = H - padTop - padBot;
    const x = (i) => 4 + (i / (pts.length - 1)) * innerW;
    const y = (v) => padTop + innerH - ((v - min) / (max - min)) * innerH;
    const line = pts.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.v).toFixed(1)).join(' ');
    const area = line + ' L' + x(pts.length - 1).toFixed(1) + ' ' + (padTop + innerH) + ' L4 ' + (padTop + innerH) + ' Z';
    const color = o.color || '#2ee6c9';
    const gid = 'shg' + Math.random().toString(36).slice(2, 8);
    const tLabel = (ms) => { try { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } };
    const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));
    return `<svg class="shares-svg" viewBox="0 0 ${W} ${H}" role="img">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity=".30"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient></defs>
      <line x1="4" y1="${padTop}" x2="${W - 38}" y2="${padTop}" stroke="rgba(255,255,255,.05)"/>
      <line x1="4" y1="${padTop + innerH / 2}" x2="${W - 38}" y2="${padTop + innerH / 2}" stroke="rgba(255,255,255,.05)"/>
      <line x1="4" y1="${padTop + innerH}" x2="${W - 38}" y2="${padTop + innerH}" stroke="rgba(255,255,255,.08)"/>
      <path d="${area}" fill="url(#${gid})"/>
      <path d="${line}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
      <text x="${W - 36}" y="${padTop + 6}" class="shares-axis">${o.prefix || ''}${fmt(max)}</text>
      <text x="${W - 36}" y="${padTop + innerH}" class="shares-axis">${o.prefix || ''}${fmt(min)}</text>
      <text x="4" y="${H - 1}" class="shares-axis">${tLabel(pts[0].t)}</text>
      <text x="${W - 38}" y="${H - 1}" text-anchor="end" class="shares-axis">${tLabel(pts[pts.length - 1].t)}</text>
    </svg>`;
  }

  function priceSeries(hist) { return (hist || []).map((p) => ({ t: Number(p.t) || 0, v: Number(p.p) || 0 })); }
  function equitySeries(hist) { return (hist || []).map((p) => ({ t: Number(p.t) || 0, v: Number(p.coins) || 0 })); }

  /* Two account buttons shown directly below the WhaleChat investment
     dashboard card (cut-out path in the reference screenshot). */
  function quickRowHTML() {
    return `<div class="wc-quick-row" data-wc-quick-row>
      <a href="#/home" class="wc-quick-btn">
        <span class="wc-quick-ic">${ic('chat', 18)}</span>
        <span class="wc-quick-t"><b>Chat</b><small>Open your chat page</small></span>
        ${ic('chevron', 15)}
      </a>
      <a href="#/invest/shares" class="wc-quick-btn wc-quick-inv">
        <span class="wc-quick-ic">${ic('trend', 18)}</span>
        <span class="wc-quick-t"><b>WC-Investing</b><small>Open your WC-Investing account</small></span>
        ${ic('chevron', 15)}
      </a>
    </div>`;
  }

  function marketChartHTML() {
    const st = S.state;
    const hist = priceSeries(st && st.shareMarket && st.shareMarket.history);
    const first = hist.length ? hist[0].v : 0;
    const last = hist.length ? hist[hist.length - 1].v : 0;
    const chg = first > 0 ? ((last / first - 1) * 100) : 0;
    return `<div class="card shares-marketcard">
      <div class="between" style="align-items:flex-start">
        <div><div class="card-title" style="margin:0">WhaleChat share price</div>
          <div class="tiny muted">Live simulated movement · updates every 5 seconds</div></div>
        <span class="badge ${chg >= 0 ? 'badge-success' : 'badge-danger'}">${chg >= 0 ? '+' : '−'}${Math.abs(chg).toFixed(2)}%</span>
      </div>
      <div class="shares-price-row">
        <div class="shares-price">$${num(last, 2)} <span class="tiny muted">USD</span></div>
        <div class="tiny muted" data-share-upd>${st && st.shareMarket ? 'updated ' + when(st.shareMarket.updatedAt) : ''}</div>
      </div>
      <div class="shares-mov" data-share-mov>
        <span class="shares-mov-dot"></span>
        <span class="shares-mov-label">Live movement</span>
        <b data-share-mov-usd>$${num(last, 2)}</b>
        <span class="shares-mov-chg ${chg >= 0 ? 'up' : 'down'}" data-share-mov-chg>${chg >= 0 ? '▲ +' : '▼ '}${Math.abs(chg).toFixed(2)}%</span>
        <span class="tiny muted" data-share-mov-note>updated live</span>
      </div>
      <div class="shares-chart">${svgChart(hist, { height: 130, color: chg >= 0 ? '#22c55e' : '#ef4444', prefix: '$' })}</div>
      <div class="shares-stats">
        <div><span>Share price</span><b data-share-px>$${num(last, 2)}</b></div>
        <div><span>Quote</span><b data-share-pxwc>USD</b></div>
        <div><span>Your shares</span><b>${num(st && st.summary ? st.summary.shares : 0, 4)}</b></div>
        <div><span>Holders' earning</span><b data-share-earn>+${tinyNum(st && st.summary ? st.summary.totalEarnedCoins : 0)} WC</b></div>
      </div>
    </div>` + quickRowHTML();
  }

  /* daily-close history for one plan, straight from the WC-Investing engine */
  function planHistory(id, planObj) {
    try {
      const P = localEngine();
      if (!P || !P.profitLog) return [];
      let plan = planObj || null;
      if (!plan) {
        const w = P.wallet ? P.wallet() : null;
        (w && w.plans || []).forEach((p) => { if (String(p.id) === String(id)) plan = p; });
      }
      return plan ? P.profitLog(plan) : [];
    } catch (e) { return []; }
  }

  /* aggregate plan value (WC) over time — the hero live earnings graph */
  function heroSeries() {
    const list = (S.state && S.state.investments) || [];
    const by = {};
    list.forEach((v) => {
      (v.equityHistory || []).forEach((p) => {
        const t = Math.floor(Number(p.t) / 10000) * 10000;
        if (!(t > 0)) return;
        by[t] = (by[t] || 0) + (Number(p.coins) || 0);
      });
    });
    const pts = Object.keys(by).map((t) => ({ t: Number(t), v: by[t] })).sort((a, b) => a.t - b.t);
    if (pts.length >= 2) return pts;
    /* no history yet: a flat line at the invested principal */
    const invested = list.reduce((a, v) => a + (Number(v.amountCoins) || 0), 0);
    const now = Date.now();
    return [{ t: now - 3600e3, v: invested || 0 }, { t: now, v: invested || 0 }];
  }

  function heroHTML() {
    const st = S.state;
    const s = (st && st.summary) || {};
    return `<div class="shares-hero">
      <div class="between" style="align-items:flex-start">
        <div><div class="tiny muted">Total earnings from WhaleChat shares</div>
          <div class="shares-earn">+<span data-share-earn-big data-share-hero-earn data-completed="${num(s.completedProfitCoins, 6)}">${tinyNum(s.totalEarnedCoins)}</span> <span class="shares-earn-unit">WC</span></div>
          <div class="tiny muted">≈ <span data-share-earn-usd>${money(s.totalEarnedUsd)}</span> accrued + matured</div></div>
        <span class="badge badge-success">Live</span>
      </div>
      <div class="shares-hero-grid">
        <div><span>Active plans</span><b data-hero-count>${s.activeCount || 0}</b></div>
        <div><span>Invested</span><b data-hero-invested>${money(s.investedCoins * 0.5)} USD</b></div>
        <div><span>Accrued</span><b class="up" data-hero-accrued>+${money(s.accruedCoins * 0.5)} USD</b></div>
        <div><span>Share price</span><b data-hero-px>$${num(s.sharePriceUsd, 2)}</b></div>
      </div>
      <div class="shares-hero-ticker" data-share-ticker>
        <span class="sht-dot"></span>
        <span class="sht-label">Whalecoin</span>
        <b data-share-ticker-px>$${num(s.sharePriceUsd || 12.45, 2)}</b>
        <span class="sht-chg up" data-share-ticker-chg>▲ +0.00%</span>
        <span class="tiny muted" data-share-ticker-note>live price</span>
      </div>
      <div class="shares-hero-chart" id="sharesHeroChart">${(function () {
        try {
          if (window.WC_LIVE_CHART) {
            const pts = heroSeries();
            const invested = (S.state && S.state.investments || []).reduce((a, v) => a + (Number(v.amountCoins) || 0), 0);
            return WC_LIVE_CHART.svg(pts, { height: 132, unit: 'wc', wcRate: 0.5, lines: invested > 0 ? [{ price: invested, color: '#3AA0FF', title: 'INVESTED', style: 2 }] : [] });
          }
        } catch (e) {}
        return '';
      })()}</div>
      <div class="tiny muted" style="margin-top:6px">Live earnings graph · principal + accrued profit, updated every second from the Whalecoin price movements.</div>
    </div>`;
  }

  function planCard(p) {
    return `<div class="shares-plan">
      <div class="between" style="align-items:flex-start"><b>${escS(p.name)}</b>
        <span class="badge badge-accent">${num(p.returnPct, 0)}% daily</span></div>
      <div class="tiny muted" style="margin-top:3px;line-height:1.5">${escS(p.blurb || '')}</div>
      <div class="shares-plan-meta">
        <div><span>Duration</span><b>${escS(p.durationLabel || (p.durationValue + ' ' + p.durationUnit))}</b></div>
        <div><span>Min</span><b>$${num(p.minUsd)} <i class="tiny muted">(${num(p.minCoins)} WC)</i></b></div>
        <div><span>Max</span><b>$${num(p.maxUsd)} <i class="tiny muted">(${num(p.maxCoins)} WC)</i></b></div>
      </div>
      <button class="btn btn-primary btn-sm" style="width:100%;margin-top:9px" data-act="shares-open" data-id="${escS(p.id)}">
        Invest in ${escS(p.name)}
      </button>
    </div>`;
  }

  /* profit history block: one row per daily close (price + what the day earned) */
  function planLogHTML(v) {
    const log = planHistory(v.id);
    const rows = log.slice(-14).map((d) => {
      const dt = new Date(Number(d.at) || 0);
      const day = dt.toLocaleDateString([], { month: 'short', day: 'numeric' });
      const up = Number(d.changePct) >= 0;
      return '<div class="plog-row">' +
        '<span class="plog-day">Day ' + d.day + '<em>' + day + '</em></span>' +
        '<span class="plog-px">$' + Number(d.priceUsd).toFixed(2) + '<em class="' + (up ? 'up' : 'down') + '">' + (up ? '▲ +' : '▼ ') + Math.abs(Number(d.changePct)).toFixed(2) + '%</em></span>' +
        '<span class="plog-day-earn">+' + money(d.dailyUsd) + '</span>' +
        '<span class="plog-total">' + money(d.accruedUsd) + '</span>' +
      '</div>';
    }).join('');
    const running = v.status === 'active'
      ? '<div class="plog-row plog-running" data-plog-run="' + escS(v.id) + '">' +
          '<span class="plog-day">Today<em>running</em></span>' +
          '<span class="plog-px"><b data-plog-run-px>$' + Number(v.entryPriceUsd || 12.45).toFixed(2) + '</b></span>' +
          '<span class="plog-day-earn" data-plog-run-day>—</span>' +
          '<span class="plog-total up" data-plog-run-total>—</span>' +
        '</div>'
      : '';
    return '<div class="shares-plog">' +
      '<div class="shares-plog-head"><span>Profit history · daily closes</span>' +
        '<span class="tiny muted">' + (log.length ? log.length + ' day' + (log.length === 1 ? '' : 's') + ' logged' : 'first close at the end of day 1') + '</span></div>' +
      '<div class="plog-cols"><span>Day</span><span>Whalecoin</span><span>Earned</span><span>Total</span></div>' +
      (rows || running ? '<div class="plog-rows">' + rows + running + '</div>'
        : '<div class="plog-empty">No daily close recorded yet — the day 1 entry appears when the first day finishes.</div>') +
    '</div>';
  }

  function investmentCard(v) {
    /* WC-investing payout formula (client display mirrors the server):
       profit = capital(USD) x plan daily % x (share price at activation x days) */
    try {
      const days = Math.max(1, Number(v.durationDays) || 1);
      const dailyPct = Number(v.dailyReturnPct) > 0 ? Number(v.dailyReturnPct) : (Number(v.returnPct) || 0) / days;
      const capUsd = Number(v.amountUsd) > 0 ? Number(v.amountUsd) : (Number(v.amountCoins) || 0) * 0.5;
      const px = Number(v.entryPriceUsd) > 0 ? Number(v.entryPriceUsd) : Number((S.state && S.state.shareMarket && S.state.shareMarket.priceUsd) || 12.5);
      const totalUsd = capUsd * (dailyPct / 100) * px * days;
      const prog = Math.max(0, Math.min(1, (Number(v.progressPct) || 0) / 100));
      v = Object.assign({}, v, {
        amountUsd: capUsd,
        dailyReturnPct: dailyPct,
        targetProfitUsd: totalUsd,
        targetProfitCoins: totalUsd * 2,
        accruedUsd: totalUsd * prog,
        accruedCoins: totalUsd * prog * 2,
        currentValueUsd: capUsd + totalUsd * prog,
        currentValueCoins: (Number(v.amountCoins) || 0) + totalUsd * prog * 2
      });
    } catch (e) {}
    const eq = equitySeries(v.equityHistory);
    /* the same live chart the stock trading view uses (green rise, red fall) */
    const liveChart = (function () {
      try {
        if (window.WC_LIVE_CHART && eq.length >= 2) {
          const eqUsd = eq.map((p) => ({ t: p.t, v: (Number(p.v) || 0) * 0.5 }));
          return '<div class="shares-inv-livechart">' + WC_LIVE_CHART.svg(eqUsd, { height: 118, unit: 'usd' }) + '</div>';
        }
      } catch (e) {}
      return '<div class="shares-chart" style="margin-top:8px">' + svgChart(eq, { height: 80, color: '#2ee6c9' }) + '</div>';
    })();
    return `<div class="shares-inv">
      <div class="between" style="align-items:flex-start">
        <div><b>${escS(v.planName)}</b>
          <div class="tiny muted">${num(v.shares, 4)} shares @ $${num(v.entryPriceUsd)} · ${num(v.dailyReturnPct, 2)}% daily × ${num(v.durationDays, 0)} days = ${num(v.totalReturnPct, 2)}% total</div>
          <div class="tiny" style="margin-top:2px">${v.paidFrom && String(v.paidFrom).indexOf('crypto:') === 0
            ? '<span class="badge">Funded from crypto · ' + escS(String(v.paidFrom).slice(7)) + '</span>'
            : '<span class="badge">Funded from WC-Investing capital</span>'}</div></div>
        <span class="badge badge-warn">${left(v.remainingMs)}</span>
      </div>
      <div class="shares-inv-grid">
        <div><span>Invested</span><b>${both(v.amountCoins)}</b></div>
        <div><span>Earnings</span><b class="up" data-share-inv-earn data-plan="${escS(v.id)}" data-start="${v.startAt}" data-end="${v.endAt}" data-amount="${v.amountCoins}" data-ret="${v.returnPct}" data-value="${v.amountCoins}">+${bothEarn(v.accruedCoins)}</b></div>
        <div><span>Current value</span><b data-share-inv-value data-plan="${escS(v.id)}" data-start="${v.startAt}" data-end="${v.endAt}" data-amount="${v.amountCoins}" data-ret="${v.returnPct}">${both(v.currentValueCoins)}</b></div>
        <div><span>Target profit</span><b>+${bothEarn(v.targetProfitCoins)}</b></div>
      </div>
      <div class="shares-progress"><i style="width:${Math.max(0, Math.min(100, Number(v.progressPct) || 0))}%"></i></div>
      <div class="between tiny muted" style="margin-top:3px">
        <span>${num(v.progressPct, 1)}% complete</span><span>Matures ${when(v.endAt)}</span></div>
      <div class="shares-inv-live" data-inv-live="${escS(v.id)}">
        <span class="sil-dot"></span>
        <span class="sil-label">Live earnings</span>
        <b class="up" data-share-inv-earn-usd>+${money(Number(v.accruedUsd) || 0)}</b>
        <span class="sil-sep">·</span>
        <span class="sil-px">Whalecoin <b data-share-inv-px>$${num((S.state && S.state.shareMarket && S.state.shareMarket.priceUsd) || v.entryPriceUsd || 12.45, 2)}</b>
          <em data-share-inv-chg class="up">+0.00%</em></span>
      </div>
      ${liveChart}
      ${planLogHTML(v)}
    </div>`;
  }

  function activeMountHTML() {
    const list = (S.state && S.state.investments) || [];
    if (!list.length) return '';
    return `<div class="card" id="sharesActiveCard">
      <div class="between"><div class="card-title" style="margin:0">Active WhaleChat investments</div>
        <span class="tiny muted">${list.length} plan${list.length === 1 ? '' : 's'} earning live</span></div>
      <div class="shares-inv-list">${list.map(investmentCard).join('')}</div>
    </div>`;
  }

  /* ------------------- investment plan performance (v5 chart) ------------------- */
  S.perfSel = '__all__';

  function planValueAt(inv, t) {
    const start = Number(inv.startAt) || 0;
    const end = Number(inv.endAt) || 0;
    const amount = Number(inv.amountCoins) || 0;
    const ret = Number(inv.returnPct) || 0;
    if (!(amount > 0)) return 0;
    /* value from the WC-Investing engine: capital + earnings accrued from the
       real Whalecoin price movements, at that moment */
    try {
      const P = localEngine();
      if (P && P.wallet) {
        let raw = null;
        ((P.wallet() || {}).plans || []).forEach((p) => { if (String(p.id) === String(inv.id)) raw = p; });
        if (raw) {
          const at = Math.min(Date.now(), Number(t) || Date.now());
          const pr = P.progress(raw, P.sharePrice(), at);
          return amount + (Number(pr.accruedUsd) || 0) / 0.5;
        }
      }
    } catch (e) {}
    const p = end > start ? Math.max(0, Math.min(1, (t - start) / (end - start))) : 1;
    return amount + (amount * ret / 100) * p;
  }

  function perfPlans() {
    return ((S.state && S.state.investments) || []).filter((v) => v && Number(v.amountCoins) > 0);
  }

  function perfSelection() {
    const all = perfPlans();
    if (S.perfSel === '__all__') return all;
    const one = all.filter((v) => String(v.id) === String(S.perfSel));
    return one.length ? one : all;
  }

  function perfSeries(plans, now) {
    if (!plans.length) return [];
    const start = Math.min.apply(null, plans.map((v) => Number(v.startAt) || now));
    const invested = plans.reduce((a, v) => a + (Number(v.amountCoins) || 0), 0);
    const N = 140;
    const span = Math.max(60000, now - start);
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const t = start + (span * i) / N;
      const v = plans.reduce((a, p) => a + planValueAt(p, t), 0);
      pts.push({ t, v: Number.isFinite(v) ? v : invested });
    }
    pts[pts.length - 1].t = now;
    return pts;
  }

  function perfLive(plans) {
    const now = Date.now();
    const invested = plans.reduce((a, v) => a + (Number(v.amountCoins) || 0), 0);
    const value = plans.reduce((a, v) => a + planValueAt(v, now), 0);
    const earn = value - invested;
    const nextEnd = plans.length ? Math.min.apply(null, plans.map((v) => Number(v.endAt) || Infinity)) : 0;
    return {
      value, invested, earnCoins: earn,
      roiPct: invested > 0 ? (earn / invested) * 100 : 0,
      matures: nextEnd && Number.isFinite(nextEnd) ? when(nextEnd) : '—'
    };
  }

  function planPerfHTML() {
    const plans = perfPlans();
    if (!plans.length) return '';
    const pills = ['<button class="pc-pill' + (S.perfSel === '__all__' ? ' on' : '') + '" data-act="shares-perf" data-id="__all__">All plans</button>']
      .concat(plans.map((v) => '<button class="pc-pill' + (String(S.perfSel) === String(v.id) ? ' on' : '') + '" data-act="shares-perf" data-id="' + escS(v.id) + '">' + escS(v.planName) + '</button>'))
      .join('');
    return `<div class="card shares-perfcard" id="sharesPerfCard">
      <div class="between" style="align-items:flex-start;gap:10px">
        <div><div class="card-title" style="margin:0">Plan performance · ROI progress</div>
          <div class="tiny muted" style="margin-top:3px">Principal + accrued profit, updated live every second from the WhaleChat share price movements.</div></div>
        <span class="badge badge-success">Live</span>
      </div>
      <div class="shares-perf-pills">${pills}</div>
      <div class="shares-perf-chart" id="sharesPerfChart"></div>
      <div class="tiny muted" style="margin-top:6px">Blue dashed line = invested principal · cyan dotted line = target payout at maturity.</div>
    </div>`;
  }

  S.mountPerf = function () {
    const host = document.getElementById('sharesPerfChart');
    if (!host || !window.WC_PRO_CHART || !WC_PRO_CHART.mountEquity) return;
    const plans = perfSelection();
    if (!plans.length) { host.innerHTML = '<div class="shares-chart-empty">No active plans yet.</div>'; return; }
    const now = Date.now();
    const live = perfLive(plans);
    const invested = live.invested;
    const target = plans.reduce((a, v) => a + (Number(v.amountCoins) || 0) * (1 + (Number(v.returnPct) || 0) / 100), 0);
    WC_PRO_CHART.mountEquity(host, {
      key: String(S.perfSel),
      unit: 'wc',
      height: 300,
      points: perfSeries(plans, now),
      hud: {
        title: S.perfSel === '__all__' ? 'All plans · ' + plans.length : (plans[0].planName || 'Plan'),
        matures: live.matures
      },
      lines: [
        { price: invested, color: '#3AA0FF', title: 'INVESTED', style: 2 },
        { price: target, color: '#00F5D4', title: 'TARGET', style: 1 }
      ],
      getLive: () => perfLive(perfSelection())
    });
  };

  function completedHTML() {
    const list = (S.state && S.state.completed) || [];
    if (!list.length) return '';
    return `<div class="card" id="sharesHistoryCard">
      <div class="card-title" style="margin:0 0 6px">Matured investments</div>
      ${list.map((v) => `<div class="shares-hist">
        <div class="grow" style="min-width:0"><b>${escS(v.planName)}</b>
          <div class="tiny muted">${num(v.shares, 4)} shares · matured ${when(v.completedAt || v.endAt)}</div></div>
        <div style="text-align:right"><b class="up">+${bothEarn(v.accruedCoins)}</b>
          <div class="tiny muted">${num(v.amountCoins + v.accruedCoins)} WC returned</div></div>
      </div>`).join('')}
    </div>`;
  }

  function exampleHTML(plans) {
    const p = (plans || [])[0] || { id: '', name: 'Growth plan', returnPct: 10, durationLabel: '3 months' };
    const exRate = Math.max(0, Number(p.returnPct) || 0);
    const exDays = Math.max(1, Number(p.durationDays) || 1);
    const exTotalRate = exRate * exDays;
    const exProfit = 100 * exTotalRate / 100;
    const exPayout = 100 + exProfit;
    return `<div class="card" id="sharesExampleCard">
      <div class="between" style="align-items:flex-start;gap:10px">
        <div><div class="card-title" style="margin:0">How your investment profit is calculated</div>
          <div class="tiny muted" style="margin-top:3px">Principal × plan return % = profit · principal + profit = maturity payout</div></div>
        <span class="badge badge-accent">Worked example</span>
      </div>
      <div class="shares-example-grid">
        <div class="field" style="margin:0"><label class="label">Plan</label>
          <select class="input" id="shareExPlan" onchange="App.sharesExample()">
            ${(plans || []).map((x) => `<option value="${escS(x.id)}">${escS(x.name)} · ${num(x.returnPct, 0)}%</option>`).join('') || `<option value="">${escS(p.name)} · ${num(p.returnPct, 0)}%</option>`}
          </select></div>
        <div class="field" style="margin:0"><label class="label">Example investment (USD)</label>
          <div class="input-wrap"><span class="inv-prefix">$</span><input class="input" id="shareExAmount" type="number" min="1" step="1" value="100" oninput="App.sharesExample()"/></div></div>
      </div>
      <div class="shares-example-steps">
        <div><span>1 · Principal</span><b data-share-ex-principal>$100.00 · 200 WC</b></div>
        <div><span>2 · Daily return</span><b data-share-ex-rate>${num(exRate, 2)}% × ${num(exDays, 0)} days</b></div>
        <div><span>3 · Profit</span><b class="up" data-share-ex-profit>+$${num(exProfit)} · ${num(exProfit * 2)} WC</b></div>
        <div><span>4 · Maturity payout</span><b class="up" data-share-ex-payout>$${num(exPayout)} · ${num(exPayout * 2)} WC</b></div>
      </div>
      <div class="tiny muted" style="margin-top:8px;line-height:1.6">
        Example: invest <b>$100 (200 WC)</b> in a <b data-share-ex-rate-inline>${num(exRate, 2)}% daily</b> plan for
        <b>${escS(p.durationLabel || 'the plan duration')} (${num(exDays, 0)} days)</b>. At maturity the app credits
        <b data-share-ex-profit-inline>+$${num(exProfit)} (${num(exProfit * 2)} WC)</b> profit plus your <b>$100</b> principal —
        total <b data-share-ex-payout-inline>$${num(exPayout)} (${num(exPayout * 2)} WC)</b>. 1 WC = $0.50.
      </div>
      <div class="tiny muted" style="margin-top:4px">Daily profit accrues over the plan duration and is paid automatically at maturity. Example: $100 at 2.5% daily for 7 days earns $2.50/day = $17.50 profit, total payout $117.50 (235 WC).</div>
    </div>`;
  }

  function paintShareExample() {
    const sel = document.getElementById('shareExPlan');
    const amt = document.getElementById('shareExAmount');
    if (!sel || !amt || !S.state) return;
    const plans = S.state.plans || [];
    const plan = plans.find((p) => p.id === sel.value) || plans[0] || { returnPct: 10, durationLabel: 'the plan duration' };
    const usd = Math.max(0, Number(amt.value) || 0);
    const rate = Math.max(0, Number(plan.returnPct) || 0);
    const days = Math.max(1, Number(plan.durationDays) || 1);
    const totalRate = rate * days;
    const profitUsd = usd * totalRate / 100;
    const payoutUsd = usd + profitUsd;
    const set = (sel2, txt) => { const el = document.querySelector(sel2); if (el) el.textContent = txt; };
    set('[data-share-ex-principal]', '$' + num(usd) + ' · ' + num(usd * 2) + ' WC');
    set('[data-share-ex-rate]', num(rate, 2) + '% × ' + num(days, 0) + ' days');
    set('[data-share-ex-rate-inline]', num(rate, 2) + '% daily');
    set('[data-share-ex-profit]', '+$' + num(profitUsd) + ' · ' + num(profitUsd * 2) + ' WC');
    set('[data-share-ex-payout]', '$' + num(payoutUsd) + ' · ' + num(payoutUsd * 2) + ' WC');
    set('[data-share-ex-profit-inline]', '+$' + num(profitUsd) + ' (' + num(profitUsd * 2) + ' WC)');
    set('[data-share-ex-payout-inline]', '$' + num(payoutUsd) + ' (' + num(payoutUsd * 2) + ' WC)');
  }
  S.paintExample = paintShareExample;

  S.view = function () {
    /* keep the local (no server engine) view in step with transfers/plans */
    if (S.state && S.state.__local) { const ls = localState(); if (ls) S.state = ls; }
    if (!S.state) {
      load(false).then(() => { if (S.state) render(); });
      const offline = (typeof Remote !== 'undefined' && !Remote.enabled);
      return `<div class="page-head"><div class="between">
        <div class="row" style="gap:10px;align-items:center"><a href="#/invest" class="btn-icon">${ic('back', 18)}</a>
          <div class="section-title" style="margin:0">WhaleChat Shares</div></div></div></div>
        <div class="card"><div class="tiny muted">${offline ? 'Connect the sync server to buy WhaleChat shares — plans earn on the server.' : 'Loading WhaleChat share plans…'}</div></div>`;
    }
    const plans = S.state.plans || [];
    return `<div class="page-head"><div class="between">
      <div class="row" style="gap:10px;align-items:center"><a href="#/invest" class="btn-icon">${ic('back', 18)}</a>
        <div><div class="section-title" style="margin:0">WhaleChat Shares</div>
          <div class="tiny muted">Buy company shares · fixed-return plans · live earnings</div></div></div>
      <div class="row" style="gap:8px"><span class="badge">$${num(S.state.balanceUsd != null ? S.state.balanceUsd : S.state.balance)} USD capital</span>
        <button class="btn btn-sm btn-ghost" data-act="shares-refresh">${ic('refresh', 14)} Refresh</button></div>
    </div></div>

    <div id="sharesLiveMount">${heroHTML()}${marketChartHTML()}${activeMountHTML()}</div>
    ${planPerfHTML()}
    <div class="card wc-guide-link"><div class="between" style="gap:10px;align-items:center;flex-wrap:wrap">
      <div><div class="card-title" style="margin:0">How is my investment profit calculated?</div>
        <div class="tiny muted" style="margin-top:3px">Worked examples and formulas are in the FAQ &amp; Trade Guide.</div></div>
      <div class="row" style="gap:6px"><a class="btn btn-soft btn-sm" href="#/how-it-works">Trade Guide</a><a class="btn btn-ghost btn-sm" href="#/investment/faq?q=wc-payout">FAQ</a></div>
    </div></div>

    <div class="card" id="sharesPlansCard">
      <div class="between"><div class="card-title" style="margin:0">Investment plans</div>
        <span class="tiny muted">1 WC = $0.50 · fixed return at maturity</span></div>
      <div class="shares-plan-grid">${plans.length ? plans.map(planCard).join('') : '<div class="tiny muted" style="padding:10px 0">No plans are available yet. An administrator can add them in Admin → Stocks.</div>'}</div>
      <div class="shares-note">${ic('shield', 13)} <span>Share investments are a simulated product. The return shown is fixed for the plan duration and is credited automatically to your WC wallet at maturity.</span></div>
    </div>

    <div id="sharesHistoryMount">${completedHTML()}</div>`;
  };

  function dashCard() {
    const st = S.state;
    const s = (st && st.summary) || {};
    const price = st ? s.sharePriceUsd : 12.5;
    return `<a class="card shares-dash" href="#/invest/shares">
      <div class="between" style="align-items:flex-start">
        <div class="row" style="gap:9px;align-items:center">
          <span class="shares-dash-ic">${typeof ic === 'function' ? ic('trend', 16) : ''}</span>
          <div><div class="card-title" style="margin:0">WhaleChat Shares</div>
            <div class="tiny muted">Share price $${num(price)} (${num(price * 2)} WC) · <span data-share-earn>+${tinyNum(s.totalEarnedCoins || 0)} WC</span> earned</div></div>
        </div>
        <span class="badge ${s.activeCount ? 'badge-success' : ''}">${s.activeCount ? s.activeCount + ' active' : 'Invest'}</span>
      </div>
      <div class="tiny" style="margin-top:8px;color:var(--accent);font-weight:650">Open WhaleChat Shares →</div>
    </a>`;
  }

  /* --------------------------------- invest -------------------------------- */
  function investModal(planId) {
    const p = (S.state && S.state.plans || []).find((x) => x.id === planId);
    if (!p) return tmsg('Plan not found', 'err');
    const price = Number((S.state && S.state.shareMarket && S.state.shareMarket.priceUsd) || 12.5);
    openModal(modalShell('Invest in ' + p.name, `
      <div class="tiny muted" style="margin-bottom:10px;line-height:1.6">Share price <b>$${num(price)} (${num(price * 2)} WC)</b> · ${num(p.returnPct, 2)}% daily for ${num(p.durationDays, 0)} days (${num((Number(p.returnPct) || 0) * (Number(p.durationDays) || 1), 2)}% total) · ${escS(p.durationLabel)}.</div>
      <div class="field"><label class="label">Investment amount (USD)</label>
        <div class="input-wrap"><span class="inv-prefix">$</span>
          <input class="input" id="sharesUsd" type="number" min="${p.minUsd}" max="${p.maxUsd}" step="0.01" placeholder="${num(p.minUsd)}"/></div>
        <div class="tiny muted" style="margin-top:4px">Min $${num(p.minUsd)} (${num(p.minCoins)} WC) · Max $${num(p.maxUsd)} (${num(p.maxCoins)} WC)</div></div>
      <div class="shares-calc" id="sharesCalc">
        <div class="between"><span>Cost in WC</span><b id="sharesCost">—</b></div>
        <div class="between"><span>Shares purchased</span><b id="sharesQty">—</b></div>
        <div class="between"><span>Expected profit</span><b id="sharesProfit" class="up">—</b></div>
        <div class="between"><span>Total at maturity</span><b id="sharesTotal">—</b></div>
        <div class="between"><span>Matures</span><b id="sharesMature">—</b></div>
      </div>
      <div class="tiny muted" style="margin-top:6px">Capital balance $${num(S.state.balanceUsd != null ? S.state.balanceUsd : S.state.balance)} USD (${num((Number(S.state.balanceUsd != null ? S.state.balanceUsd : S.state.balance)) * 2)} WC).</div>`,
      `<button class="btn btn-ghost" data-close style="flex:1">Cancel</button>
       <button class="btn btn-primary" data-act="shares-invest" data-id="${escS(p.id)}" style="flex:1">Buy shares</button>`), { width: '480px' });
    const inp = document.getElementById('sharesUsd');
    if (inp) {
      inp.addEventListener('input', () => {
        const usd = Number(inp.value) || 0;
        const cost = usd / 0.5;
        const qty = price > 0 ? usd / price : 0;
        const profit = usd * (Number(p.returnPct) || 0) * (Number(p.durationDays) || 1) / 100;
        const end = Date.now() + durationMs(p.durationValue, p.durationUnit);
        const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
        set('sharesCost', num(cost) + ' WC');
        set('sharesQty', num(qty, 4));
        set('sharesProfit', '+' + money(profit) + ' (+' + num(profit * 2) + ' WC)');
        set('sharesTotal', money(usd + profit) + ' (' + num((usd + profit) * 2) + ' WC)');
        set('sharesMature', new Date(end).toLocaleDateString());
      });
      inp.focus();
    }
  }

  function durationMs(value, unit) {
    const v = Math.max(1, Number(value) || 1);
    if (unit === 'years') return v * 365 * 86400000;
    if (unit === 'months') return v * 30 * 86400000;
    return v * 86400000;
  }

  /* ---------------------------------- admin -------------------------------- */
  function adminCard() {
    return `<div class="card" id="sharesAdminCard">
      <div class="between" style="align-items:flex-start;gap:10px">
        <div><div class="card-title" style="margin:0">WhaleChat share investment plans</div>
          <div class="tiny muted" style="margin-top:3px">Add plans, set min/max investment, duration and percentage return.</div></div>
        <span class="badge badge-accent">Admin</span>
      </div>
      <div id="sharesAdminBody"><div class="tiny muted" style="margin-top:10px">Loading share plans…</div></div>
    </div>`;
  }

  function planRow(p) {
    const id = (p && p.id) || '';
    return `<tr data-share-plan="${escS(id)}">
      <td><input class="input shares-mini" data-f="name" value="${escS(p ? p.name : '')}" placeholder="Plan name"/></td>
      <td><input class="input shares-mini" data-f="minUsd" type="number" min="0.01" step="0.01" value="${p ? p.minUsd : 10}"/></td>
      <td><input class="input shares-mini" data-f="maxUsd" type="number" min="0.01" step="0.01" value="${p ? p.maxUsd : 1000}"/></td>
      <td><div class="row" style="gap:4px"><input class="input shares-mini" data-f="durationValue" type="number" min="1" step="1" value="${p ? p.durationValue : 30}" style="width:60px"/>
        <select class="input shares-mini" data-f="durationUnit" style="width:82px">
          ${['days', 'months', 'years'].map((u) => `<option value="${u}" ${p && p.durationUnit === u ? 'selected' : ''}>${u}</option>`).join('')}
        </select></div></td>
      <td><input class="input shares-mini" data-f="returnPct" type="number" min="0" step="0.1" value="${p ? p.returnPct : 10}" style="width:66px"/></td>
      <td><label class="checkline" style="margin:0"><input type="checkbox" data-f="enabled" ${!p || p.enabled !== false ? 'checked' : ''}/></label></td>
      <td><button class="btn btn-xs btn-ghost" data-act="shares-plan-del" data-id="${escS(id)}">${ic('trash', 11)}</button></td>
    </tr>`;
  }

  function adminBodyHTML(a) {
    if (!a) return '<div class="tiny muted" style="margin-top:10px">Could not load share plans.</div>';
    return `<div class="shares-admin-stats">
      <div><span>Plans</span><b>${a.stats.plans}</b></div>
      <div><span>Active investments</span><b>${a.stats.active}</b></div>
      <div><span>Shareholders</span><b>${a.stats.shareholders}</b></div>
      <div><span>Reserved capital</span><b>${num(a.stats.reservedCoins)} WC</b></div>
      <div><span>Share price</span><b>$${num(a.market.priceUsd)} (${num(a.market.priceCoins)} WC)</b></div>
    </div>
    <div class="table-wrap"><table class="tbl shares-admin-table"><thead><tr>
      <th>Plan</th><th>Min USD</th><th>Max USD</th><th>Duration</th><th>Daily return %</th><th>Live</th><th></th>
    </tr></thead><tbody id="sharesPlanRows">${a.plans.map(planRow).join('')}</tbody></table></div>
    <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
      <button class="btn btn-ghost btn-sm" data-act="shares-plan-add">${ic('plus', 14)} Add plan</button>
      <button class="btn btn-primary btn-sm" data-act="shares-admin-save">${ic('check', 14)} Save plans</button>
      <button class="btn btn-ghost btn-sm" data-act="shares-admin-reload">${ic('refresh', 14)} Reload</button>
    </div>
    <div class="tiny muted" style="margin-top:8px;line-height:1.6">Saved plans appear on every user's <b>WhaleChat Shares</b> page immediately. Minimum/maximum amounts, duration and daily return % are copied into each new investment, and the maturity payout uses daily return × duration days. Example: 100 WC at 2.5% daily for 7 days → 17.5 WC profit, 117.5 WC payout. Duration uses days, months (30 days) or years (365 days). Active investments keep the terms they were purchased under.</div>`;
  }

  async function mountAdmin(force) {
    const body = document.getElementById('sharesAdminBody');
    if (!body) return;
    const a = await loadAdmin(force);
    if (body.isConnected) body.innerHTML = adminBodyHTML(a);
  }

  function readPlanRows() {
    const rows = [];
    document.querySelectorAll('[data-share-plan]').forEach((row) => {
      const get = (f) => row.querySelector('[data-f="' + f + '"]');
      const name = (get('name').value || '').trim();
      if (!name) return;
      rows.push({
        id: row.getAttribute('data-share-plan') || '',
        name,
        minUsd: Number(get('minUsd').value) || 0,
        maxUsd: Number(get('maxUsd').value) || 0,
        durationValue: Number(get('durationValue').value) || 1,
        durationUnit: get('durationUnit').value,
        returnPct: Number(get('returnPct').value) || 0,
        enabled: get('enabled').checked
      });
    });
    return rows;
  }

  /* -------------------------------- actions -------------------------------- */
  if (typeof App !== 'undefined') {
    App.sharesExample = function () { paintShareExample(); };

    App.sharesRefresh = async function () {
      await load(true);
      await loadAdmin(true);
      render();
      tmsg('Share investments refreshed', 'ok');
    };

    App.sharesOpen = function (id) { investModal(id); };

    App.sharesInvest = async function (id) {
      const amt = Number((document.getElementById('sharesUsd') || {}).value) || 0;
      if (!(amt > 0)) return tmsg('Enter a USD amount', 'err');
      /* no shares engine on the sync host: use the local WC-Investing engine */
      const P = localEngine();
      if ((typeof Remote === 'undefined' || !Remote.enabled || (S.state && S.state.__local)) && P && typeof P.activate === 'function') {
        const res = P.activate({ planId: id, capitalUsd: amt });
        if (!res || res.error) return tmsg(res && res.error || 'Investment failed', 'err');
        if (typeof closeModal === 'function') closeModal();
        await load(true);
        tmsg('Bought WhaleChat shares · ' + num(res.investment && res.investment.shares, 4), 'ok');
        render();
        return;
      }
      if (typeof Remote === 'undefined' || !Remote.enabled) return tmsg('Connect the sync server to invest', 'err');
      try {
        const r = await api('/api/shares/invest', { method: 'POST', body: JSON.stringify({ userId: uidNow(), planId: id, amountUsd: amt }) }, 25000);
        if (!r.res || !r.res.ok || !r.data || !r.data.ok) return tmsg((r.data && r.data.error) || 'Investment failed', 'err');
        if (typeof closeModal === 'function') closeModal();
        await Remote.refresh(true);
        await load(true);
        tmsg('Bought ' + num(r.data.shares, 4) + ' WhaleChat shares', 'ok');
        render();
      } catch (e) { tmsg('Investment failed: ' + e.message, 'err'); }
    };

    App.sharesAdminReload = function () { mountAdmin(true); };

    App.sharesPlanAdd = function () {
      const body = document.getElementById('sharesPlanRows');
      if (!body) return;
      body.insertAdjacentHTML('beforeend', planRow(null));
      const rows = body.querySelectorAll('[data-share-plan]');
      const last = rows[rows.length - 1];
      const name = last && last.querySelector('[data-f="name"]');
      if (name) { try { name.focus(); } catch (e) {} }
    };

    App.sharesPerf = function (id, ds) {
      S.perfSel = (ds && ds.id) || '__all__';
      document.querySelectorAll('[data-act="shares-perf"]').forEach((b) => {
        b.classList.toggle('on', b.getAttribute('data-id') === S.perfSel);
      });
      S.mountPerf();
    };

    App.sharesPlanDel = function (id) {
      const row = document.querySelector('[data-share-plan="' + String(id) + '"]');
      if (row) row.remove();
    };

    App.sharesAdminSave = async function () {
      if (!isAdmin()) return tmsg('Admin only', 'err');
      const plans = readPlanRows();
      if (!plans.length) return tmsg('Add at least one plan with a name', 'err');
      const bad = plans.find((p) => !(p.minUsd > 0) || !(p.maxUsd >= p.minUsd) || !(p.durationValue > 0));
      if (bad) return tmsg('Each plan needs a positive minimum, a maximum ≥ minimum and a duration', 'err');
      try {
        const r = await api('/api/shares/admin/plans', { method: 'POST', body: JSON.stringify({ adminId: uidNow(), plans }) }, 20000);
        if (!r.res || !r.res.ok || !r.data || !r.data.ok) return tmsg((r.data && r.data.error) || 'Save failed', 'err');
        S.admin = r.data; S.adminLoadedAt = Date.now(); S.loadedAt = 0;
        mountAdmin(true);
        try { await load(true); } catch (e) {}
        tmsg('WhaleChat share plans saved — live on the user Shares page', 'ok');
      } catch (e) { tmsg('Save failed: ' + e.message, 'err'); }
    };
  }

  /* ----------------------------- mount + polling ---------------------------- */
  function onSharesPage() { return (location.hash || '').startsWith('#/invest/shares'); }

  function patchViews() {
    if (typeof VIEWS === 'undefined' || !VIEWS.invest) return false;
    if (VIEWS.__wcSharesPatched) return true;
    const base = VIEWS.invest;
    VIEWS.invest = function (parts, params) {
      if ((parts[1] || '') === 'shares') return S.view();
      return base.apply(this, arguments);
    };
    VIEWS.__wcSharesPatched = true;
    return true;
  }

  function patchDash() {
    if (typeof INV === 'undefined' || !INV.viewDash) return false;
    if (INV.__wcSharesDash) return true;
    const base = INV.viewDash;
    INV.viewDash = function () {
      const html = base.apply(this, arguments);
      const anchor = '<div class="card inv-chartcard">';
      if (html.indexOf(anchor) === -1) return html;
      return html.replace(anchor, dashCard() + anchor);
    };
    INV.__wcSharesDash = true;
    return true;
  }

  function patchAdmin() {
    if (typeof INV === 'undefined' || !INV.viewAdminStocks) return false;
    if (INV.__wcSharesAdmin) return true;
    const base = INV.viewAdminStocks;
    INV.viewAdminStocks = function () {
      const html = base.apply(this, arguments);
      if (/Admin access only/.test(html)) return html;
      return html + adminCard();
    };
    INV.__wcSharesAdmin = true;
    return true;
  }

  /* live earning counter — recalculated every second between server polls.
     It uses the WC-Investing engine so the number follows the real Whalecoin
     share-price movements, and it also drives the live price counter. */
  function tickEarnings() {
    if (!onSharesPage()) return;
    const now = Date.now();
    const P = localEngine();
    let hero = 0;
    let heroValue = 0;

    document.querySelectorAll('[data-share-inv-earn]').forEach((el) => {
      const start = Number(el.getAttribute('data-start')) || 0;
      const end = Number(el.getAttribute('data-end')) || 0;
      const amount = Number(el.getAttribute('data-amount')) || 0;
      const ret = Number(el.getAttribute('data-ret')) || 0;
      const planId = el.getAttribute('data-plan') || '';
      let accruedCoins = 0, accruedUsd = 0, priceNow = 0, movePct = 0, engine = false;

      if (P && planId) {
        try {
          const active = (P.summary ? (P.summary().active || []) : []);
          let inv = null;
          active.forEach((x) => { if (String(x.id) === String(planId)) inv = x; });
          if (inv) {
            const pr = P.progress(inv, P.sharePrice(), now);
            accruedUsd = Number(pr.accruedUsd) || 0;
            accruedCoins = accruedUsd / 0.5;
            priceNow = Number(pr.priceNow) || Number(P.sharePrice()) || 0;
            movePct = Number(pr.movePct) || 0;
            engine = true;
          }
        } catch (e) {}
      }
      if (!engine) {
        if (!(end > start) || !(amount > 0)) return;
        const target = amount * ret / 100;
        const elapsed = Math.max(0, Math.min(end - start, now - start));
        accruedCoins = target * (elapsed / (end - start));
        accruedUsd = accruedCoins * 0.5;
        priceNow = P && P.sharePrice ? Number(P.sharePrice()) || 0 : 0;
      }
      hero += accruedCoins;
      el.textContent = '+' + bothEarn(accruedCoins);

      const card = el.closest ? el.closest('.shares-inv') : null;
      if (!card) return;
      const val = card.querySelector('[data-share-inv-value]');
      if (val) val.textContent = both(amount + accruedCoins);
      const usdEl = card.querySelector('[data-share-inv-earn-usd]');
      if (usdEl) usdEl.textContent = '+$' + (Math.round(accruedUsd * 100) / 100).toFixed(2);
      const pxEl = card.querySelector('[data-share-inv-px]');
      if (pxEl && priceNow > 0) pxEl.textContent = '$' + priceNow.toFixed(2);
      const chgEl = card.querySelector('[data-share-inv-chg]');
      if (chgEl) {
        chgEl.textContent = (movePct >= 0 ? '▲ +' : '▼ ') + Math.abs(movePct).toFixed(2) + '%';
        chgEl.className = movePct >= 0 ? 'up' : 'down';
      }
      heroValue += amount + accruedCoins;

      /* today's running line in the profit history */
      const run = card.querySelector('[data-plog-run]');
      if (run) {
        const capUsd = amount * 0.5;
        const dayUsd = capUsd * (ret / 100) * (priceNow || 0);
        const rp = run.querySelector('[data-plog-run-px]');
        if (rp && priceNow > 0) rp.textContent = '$' + priceNow.toFixed(2);
        const rd = run.querySelector('[data-plog-run-day]');
        if (rd) rd.textContent = '+$' + (Math.round(dayUsd * 100) / 100).toFixed(2);
        const rt = run.querySelector('[data-plog-run-total]');
        if (rt) rt.textContent = '+$' + (Math.round(accruedUsd * 100) / 100).toFixed(2);
      }
    });

    /* real-time Whalecoin movement counter */
    const mv = document.querySelector('[data-share-mov]');
    if (mv) {
      const price = P && P.sharePrice ? Number(P.sharePrice()) || 0 : 0;
      let ref = price, note = 'live';
      try {
        const hist = (P && P.shareHistory) ? P.shareHistory() : [];
        if (hist.length >= 2) {
          ref = Number(hist[0].p) || price;
          const mins = Math.max(1, Math.round((Date.now() - Number(hist[0].t)) / 60000));
          note = mins >= 60 ? 'last ' + (mins / 60).toFixed(1) + 'h' : 'last ' + mins + 'm';
        }
      } catch (e) {}
      const chg = ref > 0 ? ((price / ref) - 1) * 100 : 0;
      const usdEl = mv.querySelector('[data-share-mov-usd]');
      if (usdEl && price > 0) usdEl.textContent = '$' + price.toFixed(2);
      const chgEl = mv.querySelector('[data-share-mov-chg]');
      if (chgEl) {
        chgEl.textContent = (chg >= 0 ? '▲ +' : '▼ ') + Math.abs(chg).toFixed(2) + '%';
        chgEl.className = 'shares-mov-chg ' + (chg >= 0 ? 'up' : 'down');
      }
      const noteEl = mv.querySelector('[data-share-mov-note]');
      if (noteEl) noteEl.textContent = note;
    }

    /* hero KPI numbers, updated in place (no page rebuild) */
    try {
      const investedCoins = Math.max(0, heroValue - hero);
      const invEl = document.querySelector('[data-hero-invested]');
      if (invEl) invEl.textContent = money(investedCoins * 0.5) + ' USD';
      const accEl = document.querySelector('[data-hero-accrued]');
      if (accEl) accEl.textContent = '+' + money(hero * 0.5) + ' USD';
      const cntEl = document.querySelector('[data-hero-count]');
      if (cntEl) cntEl.textContent = String(((S.state && S.state.investments) || []).length);
    } catch (e) {}

    /* Whalecoin price ticker on the dashboard card */
    const price = P && P.sharePrice ? Number(P.sharePrice()) || 0 : 0;
    let ref = price, note = 'live price';
    try {
      const hist = (P && P.shareHistory) ? P.shareHistory() : [];
      if (hist.length >= 2) {
        ref = Number(hist[0].p) || price;
        const mins = Math.max(1, Math.round((Date.now() - Number(hist[0].t)) / 60000));
        note = mins >= 60 ? 'last ' + (mins / 60).toFixed(1) + 'h' : 'last ' + mins + 'm';
      }
    } catch (e) {}
    const tick = document.querySelector('[data-share-ticker]');
    if (tick) {
      const pxEl = tick.querySelector('[data-share-ticker-px]');
      if (pxEl && price > 0) pxEl.textContent = '$' + price.toFixed(2);
      const chg = ref > 0 ? ((price / ref) - 1) * 100 : 0;
      const cEl = tick.querySelector('[data-share-ticker-chg]');
      if (cEl) {
        cEl.textContent = (chg >= 0 ? '▲ +' : '▼ ') + Math.abs(chg).toFixed(2) + '%';
        cEl.className = 'sht-chg ' + (chg >= 0 ? 'up' : 'down');
      }
      const nEl = tick.querySelector('[data-share-ticker-note]');
      if (nEl) nEl.textContent = note;
    }
    const heroPx = document.querySelector('[data-hero-px]');
    if (heroPx && price > 0) heroPx.textContent = '$' + price.toFixed(2);

    /* live earnings graph on the dashboard card */
    const heroChart = document.getElementById('sharesHeroChart');
    if (heroChart && window.WC_LIVE_CHART) {
      try {
        const pts = heroSeries();
        const lastT = pts.length ? Number(pts[pts.length - 1].t) : 0;
        const nowMs = Date.now();
        if (heroValue > 0) {
          if (nowMs <= lastT) pts[pts.length - 1].v = heroValue;
          else pts.push({ t: nowMs, v: heroValue });
        }
        const invested = (S.state && S.state.investments || []).reduce((a, v) => a + (Number(v.amountCoins) || 0), 0);
        /* redraw only when the line really changed, so the graph does not flash */
        const sig = pts.length + ':' + Number(pts[pts.length - 1].v || 0).toFixed(2) + ':' + Number(invested || 0).toFixed(2) + ':' + Number(price || 0).toFixed(4);
        if (heroChart.__wcSig !== sig) {
          heroChart.__wcSig = sig;
          heroChart.innerHTML = WC_LIVE_CHART.svg(pts, {
            height: 132, unit: 'wc', wcRate: 0.5,
            lines: invested > 0 ? [{ price: invested, color: '#3AA0FF', title: 'INVESTED', style: 2 }] : []
          });
        }
      } catch (e) {}
    }

    const heroEl = document.querySelector('[data-share-hero-earn]');
    if (heroEl) {
      const completed = Number(heroEl.getAttribute('data-completed')) || 0;
      heroEl.textContent = tinyNum(hero + completed);
      const usdEl = document.querySelector('[data-share-earn-usd]');
      if (usdEl) usdEl.textContent = money((hero + completed) * 0.5);
      const big = document.querySelector('[data-share-earn-big]');
      if (big) big.textContent = tinyNum(hero + completed);
      const stat = document.querySelector('[data-share-earn]');
      if (stat) stat.textContent = '+' + tinyNum(hero + completed) + ' WC';
    }
  }

  function plansSig() {
    try {
      return JSON.stringify((S.state && S.state.plans || []).map((p) => [p.id, p.name, p.returnPct, p.durationValue, p.durationUnit, p.minUsd, p.maxUsd, p.enabled]));
    } catch (e) { return ''; }
  }

  /* the identity of the plan/investment set — a rebuild is only needed when
     this changes, never once per timer tick */
  function structSig() {
    try {
      var list = (S.state && S.state.investments) || [];
      return list.map(function (v) { return String(v.id) + ':' + String(v.status); }).join('|') +
        '#' + ((S.state && S.state.plans) || []).length;
    } catch (e) { return ''; }
  }

  function refreshLiveMount() {
    if (!S.state || !onSharesPage()) return;
    const live = document.getElementById('sharesLiveMount');
    if (live) live.innerHTML = heroHTML() + marketChartHTML() + activeMountHTML();
    const hist = document.getElementById('sharesHistoryMount');
    if (hist) hist.innerHTML = completedHTML();
    try { S.mountPerf(); } catch (e) {}
  }

  function init() {
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      const ok = patchViews() && patchDash() && patchAdmin();
      if (ok || tries > 30) clearInterval(iv);
      if (ok && typeof AFTER === 'object') {
        const prev = AFTER.invest;
        AFTER.invest = function (parts, params) {
          try { if (prev) prev(parts, params); } catch (e) {}
          if (onSharesPage()) {
            load(true).then(() => {
              const sig = plansSig();
              if (S.plansSig && S.plansSig !== sig) { S.plansSig = sig; try { render(); } catch (e) {} return; }
              S.plansSig = sig;
              const live = document.getElementById('sharesLiveMount');
              if (live && S.state) live.innerHTML = heroHTML() + marketChartHTML() + activeMountHTML();
              try { S.mountPerf(); } catch (e) {}
              try { paintShareExample(); } catch (e) {}
            });
          } else if (!S.state) {
            load(false).then(() => { if (S.state && (location.hash || '').startsWith('#/invest') && !onSharesPage()) { try { render(); } catch (e) {} } });
          }
        };
        const prevAdmin = AFTER.admin;
        AFTER.admin = function (parts, params) {
          try { if (prevAdmin) prevAdmin(parts, params); } catch (e) {}
          if ((parts[1] || '') === 'stocks') setTimeout(() => mountAdmin(false), 140);
        };
      }
    }, 200);
    /* Poll the plan data in the background. The page is only rebuilt when the
       set of plans/investments really changes — every other tick updates the
       numbers and charts in place, so nothing flashes or jumps. */
    setInterval(() => {
      if (!onSharesPage() || document.hidden) return;
      if (window.WC_QUIET && WC_QUIET.busy()) return;      /* never while the user is busy */
      load(true).then(() => {
        const sig = plansSig();
        if (S.plansSig && S.plansSig !== sig) {
          S.plansSig = sig;
          if (window.WC_QUIET) WC_QUIET.render(); else try { render(); } catch (e) {}
          return;
        }
        S.plansSig = sig;
        const st = structSig();
        if (st !== S.structSig) { S.structSig = st; refreshLiveMount(); }
      });
    }, 9000);
    setInterval(tickEarnings, 1000);
  }

  (function styles() {
    if (document.getElementById('wc-shares-style')) return;
    const st = document.createElement('style');
    st.id = 'wc-shares-style';
    st.textContent = `
    .shares-hero{position:relative;overflow:hidden;border-radius:18px;padding:16px;margin-bottom:12px;
      background:radial-gradient(circle at 88% 0%,rgba(46,230,201,.18),transparent 55%),linear-gradient(135deg,#07202b,#0a1a26);
      border:1px solid rgba(46,230,201,.22)}
    .shares-earn{font-size:28px;font-weight:800;letter-spacing:-.03em;color:#2ee6c9;line-height:1.15;font-variant-numeric:tabular-nums}
    .shares-earn-unit{font-size:13px;color:#8ba4b6;font-weight:700}
    .shares-hero-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:14px}
    .shares-hero-grid div{display:flex;flex-direction:column;gap:1px;padding:8px;border-radius:9px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.06);min-width:0}
    .shares-hero-grid span{font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:#8ba4b6;font-weight:700}
    .shares-hero-grid b{font-size:12.5px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .shares-marketcard .shares-price-row{display:flex;justify-content:space-between;align-items:flex-end;gap:10px;margin-top:8px}
    .wc-quick-row{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:10px 0 14px}
    .wc-quick-row .wc-quick-btn{display:flex;align-items:center;gap:9px;padding:12px 13px;border-radius:14px;text-decoration:none;
      background:linear-gradient(135deg,rgba(46,230,201,.13),rgba(58,160,255,.07));border:1px solid rgba(46,230,201,.30);color:#e9f4f9;
      transition:transform .15s ease,border-color .15s ease}
    .wc-quick-row .wc-quick-btn:active{transform:scale(.985)}
    .wc-quick-row .wc-quick-inv{background:linear-gradient(135deg,rgba(58,160,255,.15),rgba(139,123,255,.09));border-color:rgba(58,160,255,.34)}
    .wc-quick-row .wc-quick-ic{display:grid;place-items:center;width:34px;height:34px;border-radius:10px;flex:0 0 auto;
      background:rgba(46,230,201,.16);color:#2ee6c9}
    .wc-quick-row .wc-quick-inv .wc-quick-ic{background:rgba(58,160,255,.18);color:#7cc4ff}
    .wc-quick-row .wc-quick-t{display:flex;flex-direction:column;min-width:0;flex:1}
    .wc-quick-row .wc-quick-t b{font-size:13.5px;font-weight:750;letter-spacing:-.01em}
    .wc-quick-row .wc-quick-t small{font-size:10px;color:#8ba4b6;line-height:1.35}
    @media (max-width:430px){.wc-quick-row{grid-template-columns:1fr 1fr;gap:8px}
      .wc-quick-row .wc-quick-btn{padding:10px;border-radius:12px}
      .wc-quick-row .wc-quick-t small{display:none}}
    .shares-price{font-size:24px;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
    .shares-perfcard .shares-perf-pills{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0 8px}
    .shares-perf-chart{min-height:300px;margin-top:2px}
    .shares-chart{margin-top:6px}
    .shares-inv-livechart{margin-top:9px;border-radius:12px;overflow:hidden;background:#070d14;border:1px solid rgba(46,230,201,.14)}
    .shares-inv-livechart svg{display:block;width:100%;height:auto}
    .shares-inv-live{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:9px;padding:7px 9px;border-radius:10px;
      background:rgba(46,230,201,.10);border:1px solid rgba(46,230,201,.32);font-size:10.5px;color:var(--muted)}
    .shares-inv-live b.up{color:#2ee6a8;font-variant-numeric:tabular-nums;font-size:12px}
    .shares-inv-live .sil-label{font-weight:700;letter-spacing:.02em;color:var(--text)}
    .shares-inv-live .sil-dot{width:7px;height:7px;border-radius:50%;background:#2ee6a8;box-shadow:0 0 0 0 rgba(46,230,168,.6);animation:silPulse 1.6s infinite}
    .shares-inv-live .sil-sep{opacity:.4}
    .shares-inv-live .sil-px b{color:var(--text);font-variant-numeric:tabular-nums}
    .shares-inv-live .sil-px em{font-style:normal;font-weight:700;margin-left:3px;font-variant-numeric:tabular-nums}
    .shares-inv-live .sil-px em.up{color:#2ee6a8}
    .shares-inv-live .sil-px em.down{color:#ff5d7a}
    .shares-mov{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:9px;padding:7px 10px;border-radius:11px;
      background:rgba(46,230,201,.10);border:1px solid rgba(46,230,201,.32)}
    .shares-mov-dot{width:7px;height:7px;border-radius:50%;background:#2ee6a8;animation:silPulse 1.6s infinite}
    .shares-mov-label{font-size:9.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
    .shares-mov b{font-size:14px;font-variant-numeric:tabular-nums;color:var(--text)}
    .shares-mov-chg{font-size:11.5px;font-weight:800;font-variant-numeric:tabular-nums;padding:2px 7px;border-radius:99px}
    .shares-mov-chg.up{color:#0a2e26;background:#2ee6a8}
    .shares-mov-chg.down{color:#2e0a12;background:#ff5d7a}
    @keyframes silPulse{0%{box-shadow:0 0 0 0 rgba(46,230,168,.55)}70%{box-shadow:0 0 0 7px rgba(46,230,168,0)}100%{box-shadow:0 0 0 0 rgba(46,230,168,0)}}
    .shares-hero-ticker{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px;padding:8px 11px;border-radius:11px;
      background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.10)}
    .sht-dot{width:7px;height:7px;border-radius:50%;background:#2ee6a8;animation:silPulse 1.6s infinite;flex:0 0 auto}
    .sht-label{font-size:9.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#8ba4b6}
    .shares-hero-ticker b{font-size:16px;color:#e9f4f9;font-variant-numeric:tabular-nums}
    .sht-chg{font-size:11px;font-weight:800;padding:2px 7px;border-radius:99px;font-variant-numeric:tabular-nums}
    .sht-chg.up{color:#062b25;background:#2ee6a8}
    .sht-chg.down{color:#2e0a12;background:#ff5d7a}
    .shares-hero-chart{margin-top:10px;border-radius:12px;overflow:hidden;border:1px solid rgba(46,230,201,.16);background:#070d14}
    .shares-hero-chart svg{display:block;width:100%;height:auto}
    .shares-plog{margin-top:10px;border:1px solid var(--border);border-radius:11px;background:var(--surface-2);overflow:hidden}
    .shares-plog-head{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--border);
      font-size:11px;font-weight:750;color:var(--text)}
    .plog-cols,.plog-row{display:grid;grid-template-columns:1.1fr 1.15fr .95fr .95fr;gap:6px;align-items:center}
    .plog-cols{padding:5px 10px;font-size:8.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted-2);font-weight:800;background:rgba(255,255,255,.02)}
    .plog-rows{max-height:212px;overflow:auto}
    .plog-row{padding:6px 10px;border-top:1px solid var(--border);font-size:10.5px;font-variant-numeric:tabular-nums}
    .plog-row:first-child{border-top:none}
    .plog-day{display:flex;flex-direction:column;gap:1px;font-weight:700;color:var(--text)}
    .plog-day em{font-style:normal;font-weight:600;font-size:8.5px;color:var(--muted-2)}
    .plog-px{display:flex;flex-direction:column;gap:1px;color:var(--text)}
    .plog-px em{font-style:normal;font-size:8.5px;font-weight:800}
    .plog-px em.up,.plog-total.up{color:var(--success)}
    .plog-px em.down{color:var(--danger)}
    .plog-day-earn{color:var(--text)}
    .plog-total{text-align:right;font-weight:800;color:var(--text)}
    .plog-running{background:rgba(46,230,201,.08)}
    .plog-running .plog-day{color:var(--accent)}
    .plog-empty{padding:10px;font-size:10.5px;color:var(--muted)}
    @media (max-width:400px){.plog-cols,.plog-row{grid-template-columns:1fr 1fr .9fr .9fr;gap:4px;padding-left:8px;padding-right:8px}}
    .shares-svg{width:100%;height:auto;display:block;overflow:visible}
    .shares-axis{fill:#63798a;font-size:7.5px;font-variant-numeric:tabular-nums}
    .shares-chart-empty{height:90px;display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--muted)}
    .shares-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-top:8px}
    .shares-stats div{display:flex;flex-direction:column;gap:1px;padding:7px;border:1px solid var(--border);border-radius:8px;background:var(--surface-2);min-width:0}
    .shares-stats span{font-size:8.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted-2);font-weight:700}
    .shares-stats b{font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .shares-plan-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;margin-top:10px}
    .shares-plan{padding:12px;border:1px solid var(--border);border-radius:13px;background:var(--surface-2)}
    .shares-plan-meta{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-top:10px}
    .shares-plan-meta div{display:flex;flex-direction:column;gap:1px;min-width:0}
    .shares-plan-meta span{font-size:8.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted-2);font-weight:700}
    .shares-plan-meta b{font-size:10.5px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .shares-inv-list{display:flex;flex-direction:column;gap:10px;margin-top:10px}
    .shares-inv{padding:11px;border:1px solid var(--border);border-radius:12px;background:var(--surface-2)}
    .shares-inv-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:9px}
    .shares-inv-grid div{display:flex;flex-direction:column;gap:1px;min-width:0}
    .shares-inv-grid span{font-size:8.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted-2);font-weight:700}
    .shares-inv-grid b{font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .shares-progress{height:7px;border-radius:99px;background:rgba(255,255,255,.08);margin-top:10px;overflow:hidden}
    .shares-progress i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#2ee6c9,#3aa0ff)}
    .shares-note{display:flex;gap:7px;align-items:flex-start;margin-top:11px;padding:9px 10px;border-radius:9px;font-size:10.5px;
      line-height:1.6;color:var(--muted);background:rgba(46,230,201,.05);border:1px solid rgba(46,230,201,.16)}
    .shares-calc{margin-top:10px;padding:9px;border:1px solid var(--border);border-radius:9px;background:var(--surface-2)}
    .shares-calc .between{font-size:11px;padding:2px 0;color:var(--muted)}
    .shares-calc b{color:var(--text);font-variant-numeric:tabular-nums}
    .shares-calc b.up{color:var(--success)}
    .shares-hist{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--border)}
    .shares-hist:first-of-type{border-top:none}
    .shares-hist b{font-size:11.5px}
    .shares-hist b.up{color:var(--success)}
    .shares-admin-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:7px;margin:12px 0}
    .shares-admin-stats div{display:flex;flex-direction:column;gap:1px;padding:8px;border:1px solid var(--border);border-radius:9px;background:var(--surface-2);min-width:0}
    .shares-admin-stats span{font-size:8.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted-2);font-weight:700}
    .shares-admin-stats b{font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .shares-admin-table td{padding:5px 6px}
    .shares-mini{height:30px;padding:3px 5px;font-size:10.5px;min-width:60px}
    .shares-dash{display:block;margin:10px 0;text-decoration:none;color:inherit}
    .shares-dash-ic{width:32px;height:32px;border-radius:10px;display:flex;align-items:center;justify-content:center;
      background:rgba(139,123,255,.14);color:#8b7bff;flex:none}
    .shares-dash .up{color:var(--success)}
    @media(max-width:560px){.shares-plan-grid{grid-template-columns:1fr}.shares-hero-grid{grid-template-columns:1fr 1fr}.shares-stats{grid-template-columns:1fr 1fr}.shares-plan-meta{grid-template-columns:1fr 1fr}}
    `;
    document.head.appendChild(st);
  })();

  init();
})();
