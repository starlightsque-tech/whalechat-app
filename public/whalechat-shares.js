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
  function both(coins) { return num(coins) + ' WC (' + money(Number(coins) * 0.5) + ')'; }
  function bothEarn(coins) { return tinyNum(coins) + ' WC (' + (Math.abs(Number(coins)) < 1 ? '$' + (Number(coins) * 0.5).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') : money(Number(coins) * 0.5)) + ')'; }
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

  async function load(force) {
    if (S.loading && S.pending) return S.pending;
    if (!force && S.state && Date.now() - S.loadedAt < 4000) return S.state;
    if (typeof Remote === 'undefined' || !Remote.enabled) return S.state;
    S.loading = true;
    S.pending = (async () => {
      try {
        const r = await api('/api/shares/state?userId=' + encodeURIComponent(uidNow()), {}, 12000);
        if (r.data && r.data.ok) { S.state = r.data; S.loadedAt = Date.now(); }
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
        <div class="shares-price">$${num(last, 2)} <span class="tiny muted">(${num(last * 2, 2)} WC)</span></div>
        <div class="tiny muted" data-share-upd>${st && st.shareMarket ? 'updated ' + when(st.shareMarket.updatedAt) : ''}</div>
      </div>
      <div class="shares-chart">${svgChart(hist, { height: 130, color: chg >= 0 ? '#22c55e' : '#ef4444', prefix: '$' })}</div>
      <div class="shares-stats">
        <div><span>Share price</span><b data-share-px>$${num(last, 2)}</b></div>
        <div><span>In WC</span><b data-share-pxwc>${num(last * 2, 2)} WC</b></div>
        <div><span>Your shares</span><b>${num(st && st.summary ? st.summary.shares : 0, 4)}</b></div>
        <div><span>Holders' earning</span><b data-share-earn>+${tinyNum(st && st.summary ? st.summary.totalEarnedCoins : 0)} WC</b></div>
      </div>
    </div>`;
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
        <div><span>Active plans</span><b>${s.activeCount || 0}</b></div>
        <div><span>Invested</span><b>${num(s.investedCoins)} WC</b></div>
        <div><span>Accrued</span><b class="up">+${tinyNum(s.accruedCoins)} WC</b></div>
        <div><span>Share price</span><b>$${num(s.sharePriceUsd, 2)}</b></div>
      </div>
    </div>`;
  }

  function planCard(p) {
    return `<div class="shares-plan">
      <div class="between" style="align-items:flex-start"><b>${escS(p.name)}</b>
        <span class="badge badge-accent">${num(p.returnPct, 0)}%</span></div>
      <div class="tiny muted" style="margin-top:3px;line-height:1.5">${escS(p.blurb || '')}</div>
      <div class="shares-plan-meta">
        <div><span>Duration</span><b>${escS(p.durationLabel || (p.durationValue + ' ' + p.durationUnit))}</b></div>
        <div><span>Min</span><b>$${num(p.minUsd)} <i class="tiny muted">(${num(p.minCoins)} WC)</i></b></div>
        <div><span>Max</span><b>$${num(p.maxUsd)} <i class="tiny muted">(${num(p.maxCoins)} WC)</i></b></div>
      </div>
      <div class="tiny muted" style="margin-top:6px">Example: $100 → <b>$${num(100 + 100 * (Number(p.returnPct) || 0) / 100)}</b> at maturity</div>
      <button class="btn btn-primary btn-sm" style="width:100%;margin-top:9px" data-act="shares-open" data-id="${escS(p.id)}">
        Invest in ${escS(p.name)}
      </button>
    </div>`;
  }

  function investmentCard(v) {
    const eq = equitySeries(v.equityHistory);
    return `<div class="shares-inv">
      <div class="between" style="align-items:flex-start">
        <div><b>${escS(v.planName)}</b>
          <div class="tiny muted">${num(v.shares, 4)} shares @ $${num(v.entryPriceUsd)} · ${num(v.returnPct, 0)}% return</div></div>
        <span class="badge badge-warn">${left(v.remainingMs)}</span>
      </div>
      <div class="shares-inv-grid">
        <div><span>Invested</span><b>${both(v.amountCoins)}</b></div>
        <div><span>Earnings</span><b class="up" data-share-inv-earn data-start="${v.startAt}" data-end="${v.endAt}" data-amount="${v.amountCoins}" data-ret="${v.returnPct}" data-value="${v.amountCoins}">+${bothEarn(v.accruedCoins)}</b></div>
        <div><span>Current value</span><b data-share-inv-value data-start="${v.startAt}" data-end="${v.endAt}" data-amount="${v.amountCoins}" data-ret="${v.returnPct}">${both(v.currentValueCoins)}</b></div>
        <div><span>Target profit</span><b>+${bothEarn(v.targetProfitCoins)}</b></div>
      </div>
      <div class="shares-progress"><i style="width:${Math.max(0, Math.min(100, Number(v.progressPct) || 0))}%"></i></div>
      <div class="between tiny muted" style="margin-top:3px">
        <span>${num(v.progressPct, 1)}% complete</span><span>Matures ${when(v.endAt)}</span></div>
      <div class="shares-chart" style="margin-top:8px">${svgChart(eq, { height: 80, color: '#2ee6c9' })}</div>
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
          <div class="tiny muted" style="margin-top:3px">Principal + accrued profit, updated live every second. Finnhub feeds the market chart; plan ROI is accrued by the server.</div></div>
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
    const exProfit = 100 * exRate / 100;
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
        <div><span>2 · Plan return</span><b data-share-ex-rate>${num(exRate, 0)}%</b></div>
        <div><span>3 · Profit</span><b class="up" data-share-ex-profit>+$${num(exProfit)} · ${num(exProfit * 2)} WC</b></div>
        <div><span>4 · Maturity payout</span><b class="up" data-share-ex-payout>$${num(exPayout)} · ${num(exPayout * 2)} WC</b></div>
      </div>
      <div class="tiny muted" style="margin-top:8px;line-height:1.6">
        Example: invest <b>$100 (200 WC)</b> in a <b data-share-ex-rate-inline>${num(p.returnPct, 0)}%</b> plan for
        <b>${escS(p.durationLabel || 'the plan duration')}</b>. At maturity the app credits
        <b data-share-ex-profit-inline>+$${num(exProfit)} (${num(exProfit * 2)} WC)</b> profit plus your <b>$100</b> principal —
        total <b data-share-ex-payout-inline>$${num(exPayout)} (${num(exPayout * 2)} WC)</b>. 1 WC = $0.50.
      </div>
      <div class="tiny muted" style="margin-top:4px">Profit accrues daily over the plan duration and is paid automatically when the plan matures. The example assumes the plan is held to maturity.</div>
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
    const profitUsd = usd * rate / 100;
    const payoutUsd = usd + profitUsd;
    const set = (sel2, txt) => { const el = document.querySelector(sel2); if (el) el.textContent = txt; };
    set('[data-share-ex-principal]', '$' + num(usd) + ' · ' + num(usd * 2) + ' WC');
    set('[data-share-ex-rate]', rate + '%');
    set('[data-share-ex-rate-inline]', rate + '%');
    set('[data-share-ex-profit]', '+$' + num(profitUsd) + ' · ' + num(profitUsd * 2) + ' WC');
    set('[data-share-ex-payout]', '$' + num(payoutUsd) + ' · ' + num(payoutUsd * 2) + ' WC');
    set('[data-share-ex-profit-inline]', '+$' + num(profitUsd) + ' (' + num(profitUsd * 2) + ' WC)');
    set('[data-share-ex-payout-inline]', '$' + num(payoutUsd) + ' (' + num(payoutUsd * 2) + ' WC)');
  }
  S.paintExample = paintShareExample;

  S.view = function () {
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
      <div class="row" style="gap:8px"><span class="badge">${num(S.state.balance)} WC</span>
        <button class="btn btn-sm btn-ghost" data-act="shares-refresh">${ic('refresh', 14)} Refresh</button></div>
    </div></div>

    <div id="sharesLiveMount">${heroHTML()}${marketChartHTML()}${activeMountHTML()}</div>
    ${planPerfHTML()}
    ${exampleHTML(plans)}

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
      <div class="tiny muted" style="margin-bottom:10px;line-height:1.6">Share price <b>$${num(price)} (${num(price * 2)} WC)</b> · ${p.returnPct}% fixed return · ${escS(p.durationLabel)}.</div>
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
      <div class="tiny muted" style="margin-top:6px">Balance ${num(S.state.balance)} WC. WC = USD ÷ 0.50.</div>`,
      `<button class="btn btn-ghost" data-close style="flex:1">Cancel</button>
       <button class="btn btn-primary" data-act="shares-invest" data-id="${escS(p.id)}" style="flex:1">Buy shares</button>`), { width: '480px' });
    const inp = document.getElementById('sharesUsd');
    if (inp) {
      inp.addEventListener('input', () => {
        const usd = Number(inp.value) || 0;
        const cost = usd / 0.5;
        const qty = price > 0 ? usd / price : 0;
        const profit = usd * (Number(p.returnPct) || 0) / 100;
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
      <th>Plan</th><th>Min USD</th><th>Max USD</th><th>Duration</th><th>Return %</th><th>Live</th><th></th>
    </tr></thead><tbody id="sharesPlanRows">${a.plans.map(planRow).join('')}</tbody></table></div>
    <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
      <button class="btn btn-ghost btn-sm" data-act="shares-plan-add">${ic('plus', 14)} Add plan</button>
      <button class="btn btn-primary btn-sm" data-act="shares-admin-save">${ic('check', 14)} Save plans</button>
      <button class="btn btn-ghost btn-sm" data-act="shares-admin-reload">${ic('refresh', 14)} Reload</button>
    </div>
    <div class="tiny muted" style="margin-top:8px;line-height:1.6">Saved plans appear on every user's <b>WhaleChat Shares</b> page immediately. Minimum/maximum amounts, duration and return % are copied into each new investment, and the maturity payout uses the plan's return. Duration uses days, months (30 days) or years (365 days). Active investments keep the terms they were purchased under.</div>`;
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
      if (typeof Remote === 'undefined' || !Remote.enabled) return tmsg('Connect the sync server to invest', 'err');
      const amt = Number((document.getElementById('sharesUsd') || {}).value) || 0;
      if (!(amt > 0)) return tmsg('Enter a USD amount', 'err');
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

  /* live earning counter — recalculates once per second between server polls */
  function tickEarnings() {
    if (!onSharesPage()) return;
    const now = Date.now();
    let hero = 0;
    document.querySelectorAll('[data-share-inv-earn]').forEach((el) => {
      const start = Number(el.getAttribute('data-start')) || 0;
      const end = Number(el.getAttribute('data-end')) || 0;
      const amount = Number(el.getAttribute('data-amount')) || 0;
      const ret = Number(el.getAttribute('data-ret')) || 0;
      if (!(end > start) || !(amount > 0)) return;
      const target = amount * ret / 100;
      const elapsed = Math.max(0, Math.min(end - start, now - start));
      const accrued = target * (elapsed / (end - start));
      hero += accrued;
      el.textContent = '+' + bothEarn(accrued);
      const val = document.querySelector('[data-share-inv-value][data-start="' + start + '"]');
      if (val) val.textContent = both(amount + accrued);
    });
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
    setInterval(() => {
      if (!onSharesPage() || document.hidden) return;
      load(true).then(() => {
        const sig = plansSig();
        if (S.plansSig && S.plansSig !== sig) { S.plansSig = sig; try { render(); } catch (e) {} return; }
        S.plansSig = sig;
        refreshLiveMount();
      });
    }, 6000);
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
    .shares-price{font-size:24px;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
    .shares-perfcard .shares-perf-pills{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0 8px}
    .shares-perf-chart{min-height:300px;margin-top:2px}
    .shares-chart{margin-top:6px}
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
