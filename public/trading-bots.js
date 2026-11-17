/* =========================================================================
   WhaleChat Trading Bots — marketplace, configuration and live dashboard
   All trading runs server-side (bots.js) so the bot keeps working while the
   app is closed. This module only renders state and calls the bot API.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  const B = window.WC_BOTS = window.WC_BOTS || {};
  B.state = B.state || null;
  B.admin = B.admin || null;
  B.loading = false;
  B.loadedAt = 0;
  B.adminLoading = false;
  B.adminLoadedAt = 0;

  const CYCLE_TEXT = { daily: '24 hrs', weekly: 'week', monthly: 'month', yearly: 'year', one_time: 'one-time' };
  const DURS = [['daily', '24 hours'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['yearly', 'Yearly']];
  function tp(t, d) {
    if (t && t.prices && t.prices[d] != null) return Number(t.prices[d]) || 0;
    const f = { daily: 0.1, weekly: 0.35, monthly: 1, yearly: 10 };
    return Math.round((Number(t && t.priceUsd) || 0) * f[d] * 100) / 100;
  }
  function escB(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function num(v, n) { return (Number(v) || 0).toFixed(n == null ? 2 : n); }
  function money(v) { return '$' + num(v, 2); }
  function cycleText(c) { return CYCLE_TEXT[c] || 'month'; }
  function when(ms) { try { return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) { return '—'; } }
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

  /* --------------------------------- loading -------------------------------- */
  async function load(force) {
    if (B.loading && B.pending) return B.pending;
    if (!force && B.state && Date.now() - B.loadedAt < 4000) return B.state;
    if (typeof Remote === 'undefined' || !Remote.enabled) { B.loading = false; return B.state; }
    B.loading = true;
    B.pending = (async () => {
      try {
        const r = await api('/api/bots/state?userId=' + encodeURIComponent(uidNow()), {}, 12000);
        if (r.data && r.data.ok) { B.state = r.data; B.loadedAt = Date.now(); }
      } catch (e) { console.error('bot state', e); }
      finally { B.loading = false; B.pending = null; }
      return B.state;
    })();
    return B.pending;
  }

  async function loadAdmin(force) {
    if (!isAdmin()) return null;
    if (B.adminLoading && B.adminPending) return B.adminPending;
    if (!force && B.admin && Date.now() - B.adminLoadedAt < 5000) return B.admin;
    B.adminLoading = true;
    B.adminPending = (async () => {
      try {
        const r = await api('/api/bots/admin?adminId=' + encodeURIComponent(uidNow()), {}, 12000);
        if (r.data && r.data.ok) { B.admin = r.data; B.adminLoadedAt = Date.now(); }
      } catch (e) { console.error('bot admin', e); }
      finally { B.adminLoading = false; B.adminPending = null; }
      return B.admin;
    })();
    return B.adminPending;
  }

  /* --------------------------------- markup --------------------------------- */
  function statusBadge(session) {
    if (!session) return '<span class="bot-badge off"><i></i> Offline</span>';
    if (session.status === 'running') return '<span class="bot-badge on"><i></i> Bot Running</span>';
    if (session.status === 'cooling') return '<span class="bot-badge cool"><i></i> Cooling down</span>';
    return '<span class="bot-badge paused"><i></i> Paused</span>';
  }

  function initialsOf(name) {
    return String(name || 'Bot').split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]).join('').toUpperCase() || 'B';
  }
  function avatarHTML(t, size) {
    const sz = size || 40;
    if (t && t.avatar) return `<img src="${t.avatar}" alt="" style="width:${sz}px;height:${sz}px;border-radius:12px;object-fit:cover;flex:none"/>`;
    return `<span class="bot-avatar-fb" style="width:${sz}px;height:${sz}px;font-size:${Math.round(sz * 0.34)}px">${initialsOf(t && t.name)}</span>`;
  }

  function accessBanner() {
    const s = B.state || {};
    if (s.botAccess) {
      return '<div class="tiny up" style="margin:8px 0;line-height:1.6">Bot Assisted Trading is unlocked (one-time). Pick any bot, choose 24 hours, weekly, monthly or yearly, then subscribe. The fee is taken from your investment trade capital and renews automatically while you have balance. If your balance runs out the bot turns off until you renew it manually.</div>';
    }
    const price = window.WC_SUBS ? window.WC_SUBS.price('botassist') : 19.99;
    return '<div class="card" style="margin:10px 0"><b>Unlock Bot Assisted Trading · ' + money(price) + ' one-time</b>' +
      '<div class="tiny muted" style="margin:4px 0 8px">Pay once, then see every bot trader and subscribe to any of them by the day, week, month or year.</div>' +
      '<button class="btn btn-sm btn-primary" data-act="bot-unlock">Unlock for ' + money(price) + '</button></div>';
  }

  function tierCard(t) {
    const owned = !!t.owned;
    const cycle = cycleText(t.billingCycle);
    const disabled = t.enabled === false;
    const access = !!(B.state && B.state.botAccess);
    const sub = t.subscription || null;
    const lowest = Math.min.apply(null, DURS.map((d) => tp(t, d[0])));
    const footHTML = owned
      ? `<div class="between" style="gap:8px"><div>
            <div class="bot-price">${money(sub && sub.priceUsd)}<span class="tiny muted"> / ${cycleText(sub && sub.billingCycle)}</span></div>
            <div class="tiny muted">Renews ${sub && sub.expiresAt ? when(sub.expiresAt) : '—'} · auto from trade capital</div></div>
          <span class="badge badge-success" style="white-space:nowrap">Subscribed</span></div>`
      : !access
        ? `<div class="tiny muted">From ${money(lowest)} · unlock Bot Assisted Trading (one-time) to subscribe</div>`
        : `${t.lapsedAt ? '<div class="tiny down" style="margin-bottom:6px">Expired — renew manually to resume trading</div>' : ''}
          <div class="row" style="gap:6px"><select class="input grow" id="botDur_${escB(t.id)}">${DURS.map((d) => `<option value="${d[0]}" ${d[0] === 'monthly' ? 'selected' : ''}>${d[1]} · ${money(tp(t, d[0]))}</option>`).join('')}</select>
          <button class="btn btn-sm btn-primary" data-act="bot-subscribe" data-id="${escB(t.id)}" ${disabled ? 'disabled' : ''}>${t.lapsedAt ? 'Renew' : 'Subscribe'}</button></div>`;
    return `<div class="bot-tier ${owned ? 'owned' : ''} ${disabled ? 'disabled' : ''}">
      <div class="between" style="align-items:flex-start;gap:8px">
        <div class="row" style="gap:9px;align-items:flex-start;min-width:0">
          ${avatarHTML(t, 42)}
          <div style="min-width:0">
            <div class="bot-tier-name">${escB(t.name)}
              ${t.hot ? '<span class="badge badge-warn" style="font-size:9px;margin-left:4px">HOT</span>' : ''}</div>
            <div class="tiny muted">${t.username ? '@' + escB(t.username) : 'WhaleChat bot'}</div>
            <div class="tiny muted" style="margin-top:2px">${escB(t.blurb || '')}</div>
          </div>
        </div>
        <span class="badge ${owned ? 'badge-success' : 'badge'}">${num(t.accuracy, 0)}%</span>
      </div>
      <div class="bot-acc"><i style="width:${Math.min(100, Math.max(0, Number(t.accuracy) || 0))}%"></i></div>
      <div class="tiny muted" style="margin-top:4px">Simulated trade accuracy</div>
      <div class="bot-tier-foot" style="display:block">
        ${footHTML}
      </div>
    </div>`;
  }

  function perfSVG(session) {
    const alloc = Math.max(0.01, Number(session.allocatedCoins) || 0.01);
    const trades = (session.trades || []).slice().reverse();
    const pts = [{ t: session.startedAt || Date.now(), cap: alloc, pnl: 0 }];
    trades.forEach((tr) => {
      const cap = Number(tr.poolAfter);
      if (Number.isFinite(cap)) pts.push({ t: Number(tr.at) || Date.now(), cap, pnl: cap - alloc });
    });
    if (pts.length === 1) pts.push({ t: Date.now(), cap: Number(session.poolCoins) || alloc, pnl: (Number(session.poolCoins) || alloc) - alloc });
    const W = 320, H = 132, topY = 10, topH = 54, botY = 84, botH = 34;
    const caps = pts.map((p) => p.cap);
    let capMin = Math.min.apply(null, caps), capMax = Math.max.apply(null, caps);
    if (capMax - capMin < alloc * 0.01) { const pad = Math.max(0.5, alloc * 0.01); capMin -= pad; capMax += pad; }
    const padC = (capMax - capMin) * 0.12; capMin -= padC; capMax += padC;
    const pnls = pts.map((p) => p.pnl);
    let pMax = Math.max.apply(null, pnls.concat([0])), pMin = Math.min.apply(null, pnls.concat([0]));
    if (pMax - pMin < 0.01) { pMax = 0.5; pMin = -0.5; }
    const padP = (pMax - pMin) * 0.18; pMax += padP; pMin -= padP;
    const xAt = (i) => 6 + (i / Math.max(1, pts.length - 1)) * (W - 44);
    const yCap = (v) => topY + topH - ((v - capMin) / (capMax - capMin)) * topH;
    const yPnl = (v) => botY + botH - ((v - pMin) / (pMax - pMin)) * botH;
    const line = (fn, val) => pts.map((p, i) => (i ? 'L' : 'M') + xAt(i).toFixed(1) + ' ' + fn(val(p)).toFixed(1)).join(' ');
    const capPath = line(yCap, (p) => p.cap);
    const areaPath = capPath + ' L' + xAt(pts.length - 1).toFixed(1) + ' ' + (topY + topH) + ' L' + xAt(0).toFixed(1) + ' ' + (topY + topH) + ' Z';
    const pnlPath = line(yPnl, (p) => p.pnl);
    const lastPnl = pts[pts.length - 1].pnl;
    const pnlColor = lastPnl >= 0 ? '#22c55e' : '#ef4444';
    const zeroY = yPnl(0).toFixed(1);
    const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));
    const tLabel = (ms) => { try { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } };
    return `<svg class="bot-perf-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Bot capital and cumulative profit chart">
      <defs><linearGradient id="botCapFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#2ee6c9" stop-opacity=".28"/><stop offset="100%" stop-color="#2ee6c9" stop-opacity="0"/>
      </linearGradient></defs>
      <text x="6" y="8" class="bot-perf-lbl">Allocated capital (USD)</text>
      <text x="${W - 6}" y="8" text-anchor="end" class="bot-perf-val">$${fmt(pts[pts.length - 1].cap * 0.5)}</text>
      <path d="${areaPath}" fill="url(#botCapFill)"/>
      <path d="${capPath}" fill="none" stroke="#2ee6c9" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
      <text x="6" y="${botY - 4}" class="bot-perf-lbl">Cumulative P/L (USD)</text>
      <text x="${W - 6}" y="${botY - 4}" text-anchor="end" class="bot-perf-val" style="fill:${pnlColor}">${lastPnl >= 0 ? '+' : '−'}$${fmt(Math.abs(lastPnl) * 0.5)}</text>
      <line x1="6" y1="${zeroY}" x2="${W - 38}" y2="${zeroY}" stroke="rgba(255,255,255,.14)" stroke-dasharray="3 3"/>
      <path d="${pnlPath}" fill="none" stroke="${pnlColor}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
      <text x="${W - 38}" y="${topY + 10}" class="bot-perf-axis">${fmt(capMax)}</text>
      <text x="${W - 38}" y="${topY + topH}" class="bot-perf-axis">${fmt(capMin)}</text>
      <text x="${W - 38}" y="${botY + 8}" class="bot-perf-axis">${fmt(pMax)}</text>
      <text x="${W - 38}" y="${botY + botH}" class="bot-perf-axis">${fmt(pMin)}</text>
      <text x="6" y="${H - 2}" class="bot-perf-axis">${tLabel(pts[0].t)}</text>
      <text x="${W - 38}" y="${H - 2}" text-anchor="end" class="bot-perf-axis">${tLabel(pts[pts.length - 1].t)}</text>
    </svg>`;
  }

  function accountHTML() {
    const st = B.state || {};
    const acc = st.account || { capitalCoins: 0, profitCoins: 0, totalPayoutCoins: 0 };
    const session = st.session;
    const owned = (st.tiers || []).filter((t) => t.owned && t.enabled !== false);
    const running = session && session.status === 'running';
    const cooling = session && session.status === 'cooling';
    const startForm = !session ? `<div class="bot-account-start">
      <div class="bot-account-grid">
        <div class="field" style="margin:0"><label class="label">Bot assistant</label>
          <select class="input" id="botTier">${owned.length ? owned.map((t) => `<option value="${escB(t.id)}">${escB(t.name)}${t.username ? ' @' + escB(t.username) : ''}</option>`).join('') : '<option value="">Subscribe to an assistant first</option>'}</select></div>
        <div class="field" style="margin:0"><label class="label">Top-up from stock balance to start (USD)</label>
          <input class="input" id="botStartTopup" type="number" min="0" step="0.01" value="${acc.capitalCoins < 5 ? 100 : ''}" placeholder="${acc.capitalCoins < 5 ? 'e.g. 100' : '0'}"/>
          <div class="tiny muted" style="margin-top:3px">Capital now ${money((acc.capitalCoins)*0.5)} · available ${money((st.balance)*0.5)}</div></div>
        <div class="field" style="margin:0"><label class="label">Minimum per trade (USD)</label>
          <input class="input" id="botMin" type="number" min="1" step="0.01" value="${num(acc.capitalCoins > 0 ? Math.max(1, acc.capitalCoins * 0.05) : 5)}"/></div>
        <div class="field" style="margin:0"><label class="label">Maximum per trade (USD)</label>
          <input class="input" id="botMax" type="number" min="1" step="0.01" value="${num(acc.capitalCoins > 0 ? Math.max(1, acc.capitalCoins * 0.25) : 50)}"/></div>
        <div class="field" style="margin:0"><label class="label">Stop after (minutes, optional)</label>
          <input class="input" id="botDuration" type="number" min="0" step="1" placeholder="No limit"/></div>
      </div>
      <button class="btn btn-primary" data-act="bot-start" style="width:100%;margin-top:10px" ${owned.length ? '' : 'disabled'}>${typeof ic === 'function' ? ic('play', 15) : ''} Start trading now</button>
      <div class="tiny muted" style="margin-top:6px;line-height:1.6">The bot trades real stocks from the available market. Each trade stake comes from the capital balance. Profit = stake × price move % × leverage; payout = stake + profit − (stake × ${(st.settings || {}).tradeFeePct != null ? st.settings.tradeFeePct : 0.5}% trade fee), and the payout goes to the profit balance. Trades run every ${(st.settings || {}).intervalMin || 5} minutes.</div>
    </div>` : '';
    return `<div class="card" id="botAccountCard">
      <div class="between" style="align-items:flex-start;gap:10px">
        <div><div class="card-title" style="margin:0">Bot trading account</div>
          <div class="tiny muted">Two balances: trading capital and profit. Transfers go to your stock trading balance.</div></div>
        ${session ? statusBadge(session) : '<span class="badge">Ready</span>'}
      </div>
      <div class="bot-balance-grid">
        <div><span>Bot capital balance</span><b data-bot-capital>${money((acc.capitalCoins)*0.5)}</b><i>${num(acc.capitalCoins)} WC</i></div>
        <div><span>Bot profit balance</span><b class="up" data-bot-profit>${money((acc.profitCoins)*0.5)}</b><i>${num(acc.profitCoins)} WC</i></div>
        <div><span>Total payouts</span><b>${money((acc.totalPayoutCoins)*0.5)}</b><i>all bot trades</i></div>
      </div>
      <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
        <button class="btn btn-sm btn-primary" data-act="bot-topup">${typeof ic === 'function' ? ic('plus', 14) : ''} Top up</button>
        <button class="btn btn-sm btn-soft" data-act="bot-transfer">${typeof ic === 'function' ? ic('send', 14) : ''} Transfer</button>
        <button class="btn btn-sm btn-ghost" data-act="bot-history">${typeof ic === 'function' ? ic('clock', 14) : ''} History</button>
        <button class="btn btn-sm ${running ? 'btn-danger' : 'btn-primary'}" data-act="bot-toggle">${running ? 'Turn off bot' : 'Turn on bot'}</button>
      </div>
      ${acc.capitalCoins < 5 ? `<div class="bot-cooling" style="margin-top:10px"><b>Bot trading capital is ${money((acc.capitalCoins)*0.5)}</b>
        <span>Top up at least 5 WC from your stock trading balance, then press Start trading now.</span>
        <button class="btn btn-sm btn-primary" data-act="bot-topup">Top up bot capital</button></div>` : ''}
      ${cooling ? `<div class="bot-cooling"><b>Cooling down — ${escB(session.coolingReason || 'waiting for capital')}</b>
        <span>Top up the capital balance, then resume trading. Capital ${money((session.capitalCoins)*0.5)} · profit ${money((session.profitCoins)*0.5)}.</span>
        <button class="btn btn-sm btn-primary" data-act="bot-resume">Resume trading</button></div>` : ''}
      ${startForm}
      ${running ? `<div class="tiny muted" style="margin-top:8px;line-height:1.6">Bot is trading. Stop it below to hold the remaining capital and profit in the bot balances.</div>` : ''}
    </div>`;
  }

  function sessionHTML(session) {
    if (!session) return '';
    const up = Number(session.profitCoins) >= 0;
    const pct = session.allocatedCoins > 0 ? Math.max(0, Math.min(150, (session.poolCoins / session.allocatedCoins) * 100)) : 0;
    return `<div class="card bot-live" id="botSessionCard">
      <div class="between" style="align-items:flex-start">
        <div class="row" style="gap:9px;align-items:center;min-width:0">
          ${avatarHTML({ name: session.tierName, avatar: session.tierAvatar }, 40)}
          <div style="min-width:0"><div class="card-title" style="margin:0">${escB(session.tierName)}</div>
            <div class="tiny muted" style="margin-top:2px">${session.tierUsername ? '@' + escB(session.tierUsername) + ' · ' : ''}${session.tradeCount} automated trade${session.tradeCount === 1 ? '' : 's'} · every ${session.intervalMin} min</div></div>
        </div>
        ${statusBadge(session)}
      </div>
      <div class="bot-stats">
        <div><span>Capital balance</span><b data-bot-pool>${money((session.capitalCoins)*0.5)}</b></div>
        <div><span>Profit balance</span><b class="up" data-bot-pnl>${money((session.profitCoins)*0.5)}</b></div>
        <div><span>Wins / losses</span><b>${num(session.totalProfitCoins)} / ${money((session.totalLossCoins)*0.5)}</b></div>
        <div><span>Next trade</span><b data-bot-next>${session.status === 'running' ? 'counting…' : '—'}</b></div>
      </div>
      <div class="bot-poolbar"><i style="width:${pct}%"></i></div>
      <div class="tiny muted" style="margin-top:4px">Started ${when(session.startedAt)} · initial allocation ${money((session.allocatedCoins)*0.5)}</div>
      <div class="bot-perf">
        <div class="between" style="margin-bottom:4px"><b style="font-size:11.5px">Session performance</b>
          <span class="tiny muted">allocated capital · cumulative P/L</span></div>
        ${perfSVG(session)}
      </div>
      <div class="row" style="gap:8px;margin-top:12px">
        <button class="btn btn-danger grow" data-act="bot-stop">Stop bot</button>
        <button class="btn btn-ghost" data-act="bot-refresh">${typeof ic === 'function' ? ic('refresh', 14) : ''}</button>
      </div>
      <div class="bot-log">
        <div class="between" style="margin-bottom:6px"><b style="font-size:11.5px">Automated trade log</b>
          <span class="tiny muted">${session.trades.length ? 'latest first' : 'waiting for the first trade'}</span></div>
        ${session.trades.length ? session.trades.slice(0, 12).map((t) => `<div class="bot-log-row">
          <div class="grow" style="min-width:0"><b>${escB(t.ticker)}</b>
            <div class="tiny muted">${escB(t.side)} · stake ${money((t.stakeCoins)*0.5)} · payout ${money((t.payoutCoins || (t.stakeCoins + t.pnlCoins))*0.5)} · ${when(t.at)}</div></div>
          <span class="${t.win ? 'up' : 'down'}">${t.win ? '+' : '−'}${money((Math.abs(t.pnlCoins))*0.5)}</span>
        </div>`).join('') : '<div class="tiny muted" style="padding:8px 0">The worker trades on its interval even while this app is closed. Come back in a few minutes.</div>'}
      </div>
    </div>`;
  }

  function historyHTML() {
    const h = (B.state && B.state.history) || [];
    if (!h.length) return '';
    return `<div class="card" id="botHistoryCard">
      <div class="card-title" style="margin:0 0 8px">Previous sessions</div>
      ${h.map((s) => {
        const up = Number(s.profitCoins) >= 0;
        return `<div class="bot-hist-row">
          <div class="grow" style="min-width:0"><b>${escB(s.tierName)}</b>
            <div class="tiny muted">${when(s.startedAt)} → ${when(s.stoppedAt)} · ${escB(s.stopReason || 'stopped')}</div></div>
          <div style="text-align:right"><b class="${up ? 'up' : 'down'}">${up ? '+' : '−'}${money((Math.abs(s.profitCoins))*0.5)}</b>
            <div class="tiny muted">${money((s.poolCoins)*0.5)} returned</div></div>
        </div>`;
      }).join('')}
    </div>`;
  }

  function autoSecureHTML() {
    const a = (B.state && B.state.autoSecure) || { active: false, enabled: false, priceCoins: 40, billedAs: 'monthly', securedCount: 0, securedCoins: 0 };
    /* the shared registry is the single source of truth for "subscribed" */
    const shared = (typeof window.WC_SUBS !== 'undefined' && window.WC_SUBS) ? window.WC_SUBS : null;
    const sharedRec = shared ? shared.record('autosecure') : null;
    const sharedOn = shared ? shared.is('autosecure') : false;
    const subscribedAnywhere = (a.active || sharedOn);
    const on = (a.active && a.enabled) || (sharedOn && !(sharedRec && sharedRec.paused));
    return `<div class="card" id="botAutoCard">
      <div class="between" style="align-items:flex-start;gap:10px">
        <div><div class="card-title" style="margin:0">Auto Secure Take Profit</div>
          <div class="tiny muted" style="margin-top:3px">Bot tool · watches every active trade and locks available profit even while you are offline.</div></div>
        <span class="badge ${on ? 'badge-success' : subscribedAnywhere ? 'badge-warn' : ''}">${on ? 'Subscribed' : subscribedAnywhere ? 'Paused' : 'Not subscribed'}</span>
      </div>
      <div class="bot-autosecure-grid">
        <div><span class="tiny muted">Secured profits</span><b><span data-bot-secured>${money(a.securedCoins * 0.5)}</span></b></div>
        <div><span class="tiny muted">Entries to claim</span><b data-bot-secured-count>${num(a.securedCount, 0)}</b></div>
        <div><span class="tiny muted">Tool price</span><b>${money((a.priceCoins)*0.5)} / ${escB(a.billedAs || 'monthly')}</b></div>
        <div><span class="tiny muted">Expires</span><b>${a.expiresAt ? when(a.expiresAt) : '—'}</b></div>
      </div>
      <div class="tiny muted" style="margin-top:8px;line-height:1.6">
        When profit is available the bot secures it and re-bases the trade so it cannot be lost. Secured profit is <b>not credited automatically</b> —
        open <b>Orders</b> and press <b>Take profit</b> on each secured entry to add it to your balance.
      </div>
      <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
        ${subscribedAnywhere
          ? `<button class="btn btn-sm ${on ? 'btn-ghost' : 'btn-primary'}" data-act="bot-auto-toggle">${on ? 'Turn off auto secure' : 'Turn on auto secure'}</button>
             ${sharedRec && sharedRec.source && sharedRec.source !== 'bots'
               ? `<span class="tiny up" style="align-self:center">Subscribed from ${escB(sharedRec.source === 'tools' ? 'the Tools page' : 'the stock page')} — no extra charge</span>`
               : `<button class="btn btn-sm btn-ghost" data-act="bot-auto-subscribe">Renew tool</button>`}`
          : `<button class="btn btn-sm btn-primary" data-act="bot-auto-subscribe">Subscribe · ${money((a.priceCoins)*0.5)} / ${escB(a.billedAs || 'monthly')}</button>`}
        ${a.securedCount ? `<a class="btn btn-sm btn-soft" href="#/invest/orders">Claim secured profit</a>` : ''}
      </div>
    </div>`;
  }

  B.view = function () {
    if (!B.state) {
      load(false).then(() => { if (B.state) render(); });
      const offline = (typeof Remote !== 'undefined' && !Remote.enabled);
      if (offline) return `<div class="page-head"><div class="between">
        <div class="row" style="gap:10px;align-items:center"><a href="#/invest" class="btn-icon">${ic('back', 18)}</a>
          <div class="section-title" style="margin:0">Trading Bots</div></div></div></div>
        <div class="card"><div class="card-title" style="margin:0">Sync server required</div>
          <div class="tiny muted" style="margin-top:6px;line-height:1.6">Bots trade on the server so they keep working while the app is closed. Connect the sync server from Settings to use the bot marketplace.</div></div>`;
      return `<div class="page-head"><div class="between">
        <div class="row" style="gap:10px;align-items:center"><a href="#/invest" class="btn-icon">${ic('back', 18)}</a>
          <div class="section-title" style="margin:0">Trading Bots</div></div></div></div>
        <div class="card"><div class="tiny muted">Loading bot marketplace…</div></div>`;
    }
    const tiers = B.state.tiers || [];
    return `<div class="page-head"><div class="between">
      <div class="row" style="gap:10px;align-items:center"><a href="#/invest" class="btn-icon">${ic('back', 18)}</a>
        <div><div class="section-title" style="margin:0">Trading Bots</div>
          <div class="tiny muted">Automated simulated trading · runs while you are offline</div></div></div>
      <div class="row" style="gap:8px"><span class="badge">${money((B.state.balance)*0.5)}</span>
        <button class="btn btn-sm btn-ghost" data-act="bot-refresh">${ic('refresh', 14)} Refresh</button></div>
    </div></div>

    <div id="botAccountMount">${accountHTML()}</div>
    <div id="botSessionMount">${sessionHTML(B.state.session)}</div>

    ${autoSecureHTML()}

    <div class="card" id="botMarketCard">
      <div class="between"><div class="card-title" style="margin:0">Bot marketplace</div>
        <span class="tiny muted">Paid from your investment trade capital: ${money(B.state.investUsd)}</span></div>
      ${accessBanner()}
      <div class="bot-grid">${tiers.map(tierCard).join('')}</div>
      <div class="bot-disclaimer">${ic('shield', 13)} <span>Bot trading is simulated for demonstration. Accuracy is a target hit-rate, not a guarantee. Capital is reserved and isolated while the bot runs.</span></div>
    </div>

    <div id="botHistoryMount">${historyHTML()}</div>
    ${B.state.session ? `<div class="card"><div class="tiny muted" style="line-height:1.65">Your allocated capital is <b>locked</b> while the bot is running, so it cannot be spent on manual trades. Press <b>Stop Bot</b> any time to return the remaining capital (including profits or losses) to your available balance.</div></div>` : ''}`;
  };

  function dashCard() {
    const s = B.state;
    const sess = s && s.session;
    const running = sess && sess.status === 'running';
    const owned = s ? (s.tiers || []).filter((t) => t.owned).length : 0;
    const acc = (s && s.account) || { capitalCoins: 0, profitCoins: 0 };
    return `<div class="card bot-dash">
      <div class="between" style="align-items:flex-start">
        <div class="row" style="gap:9px;align-items:center">
          <span class="bot-dash-ic">${typeof ic === 'function' ? ic('trend', 16) : ''}</span>
          <div><div class="card-title" style="margin:0">Bot trading dashboard</div>
            <div class="tiny muted">${running ? 'Bot running · ' + num(sess.capitalCoins) + ' WC capital' : (owned ? owned + ' tier' + (owned === 1 ? '' : 's') + ' owned · ready to configure' : 'Subscribe to an automated bot tier')}</div></div>
        </div>
        ${statusBadge(sess)}
      </div>
      <div class="bot-dash-bals">
        <span>Capital <b>${money((acc.capitalCoins)*0.5)}</b></span>
        <span>Profit <b class="up">${money((acc.profitCoins)*0.5)}</b></span>
      </div>
      ${s && s.autoSecure && s.autoSecure.active ? `<div class="tiny ${s.autoSecure.enabled ? 'up' : 'muted'}" style="margin-top:6px">
        ${s.autoSecure.enabled ? 'Auto Secure ON' : 'Auto Secure paused'} · <b data-bot-secured>${money(s.autoSecure.securedCoins * 0.5)}</b> secured ·
        <span data-bot-secured-count>${s.autoSecure.securedCount}</span> to claim
      </div>` : ''}
      ${running ? `<div class="row" style="gap:8px;margin-top:7px;flex-wrap:wrap">
        <span class="tiny ${Number(sess.profitCoins) >= 0 ? 'up' : 'down'}"><b>${Number(sess.profitCoins) >= 0 ? '+' : '−'}${money((Math.abs(Number(sess.profitCoins) || 0))*0.5)}</b> bot P/L</span>
        <span class="tiny muted">${num(sess.tradeCount)} trade${Number(sess.tradeCount) === 1 ? '' : 's'}</span>
        ${sess.trades && sess.trades.length ? `<span class="tiny muted">last ${escB(sess.trades[0].ticker || '')} <b class="${Number(sess.trades[0].pnlCoins) >= 0 ? 'up' : 'down'}">${Number(sess.trades[0].pnlCoins) >= 0 ? '+' : '−'}${money((Math.abs(Number(sess.trades[0].pnlCoins) || 0))*0.5)}</b></span>` : ''}
      </div>` : ''}
      <a class="btn btn-sm btn-primary" href="#/invest/bots" style="margin-top:9px;width:100%">Open bot trading dashboard</a>
    </div>`;
  }

  /* ------------------------------ admin markup ------------------------------ */
  function adminCard() {
    return `<div class="card" id="botAdminCard">
      <div class="between" style="align-items:flex-start;gap:10px">
        <div><div class="card-title" style="margin:0">Trading bots · pricing &amp; speed</div>
          <div class="tiny muted" style="margin-top:3px">Edit tier pricing, billing cycle, accuracy and how fast offline bots place trades.</div></div>
        <span class="badge badge-accent">Admin</span>
      </div>
      <div id="botAdminBody"><div class="tiny muted" style="margin-top:10px">Loading bot configuration…</div></div>
    </div>`;
  }

  function adminTierRow(t) {
    return `<tr data-bot-tier="${escB(t.id)}">
      <td>
        <div class="bot-admin-assist">
          <span data-bot-avatar>${avatarHTML(t, 34)}</span>
          <div style="min-width:0"><b data-bot-name>${escB(t.name)}</b>
            <div class="tiny muted" data-bot-username>${t.username ? '@' + escB(t.username) : 'no username'}</div></div>
        </div>
        <input type="hidden" data-f="name" value="${escB(t.name)}"/>
        <input type="hidden" data-f="username" value="${escB(t.username || '')}"/>
        <input type="hidden" data-f="avatar" value="${escB(t.avatar || '')}"/>
        <input type="hidden" data-f="blurb" value="${escB(t.blurb || '')}"/>
      </td>
      <td><input class="input bot-mini" data-f="accuracy" type="number" min="1" max="100" step="1" value="${num(t.accuracy, 0)}"/></td>
      <td><input class="input bot-mini" data-f="price_daily" type="number" min="0" step="0.01" value="${num(tp(t, 'daily'))}"/></td>
      <td><input class="input bot-mini" data-f="price_weekly" type="number" min="0" step="0.01" value="${num(tp(t, 'weekly'))}"/></td>
      <td><input class="input bot-mini" data-f="price_monthly" type="number" min="0" step="0.01" value="${num(tp(t, 'monthly'))}"/></td>
      <td><input class="input bot-mini" data-f="price_yearly" type="number" min="0" step="0.01" value="${num(tp(t, 'yearly'))}"/></td>
      <td><input class="input bot-mini" data-f="intervalMin" type="number" min="0" max="10080" step="1" value="${Number(t.intervalMin) || 0}" placeholder="global"/></td>
      <td><label class="checkline" style="margin:0"><input type="checkbox" data-f="hot" ${t.hot ? 'checked' : ''}/></label></td>
      <td><label class="checkline" style="margin:0"><input type="checkbox" data-f="enabled" ${t.enabled !== false ? 'checked' : ''}/></label></td>
      <td><button class="btn btn-xs btn-ghost" data-act="bot-edit-assistant" data-id="${escB(t.id)}">Edit</button></td>
    </tr>`;
  }

  function dtLocal(ms) {
    if (!ms) return '';
    const d = new Date(Number(ms));
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function subsAdminHTML(a) {
    const subs = (a && a.subscriptions) || [];
    const head = '<div class="card-title" style="margin:16px 0 4px">Bot subscriptions · renewal dates &amp; amounts</div><div class="tiny muted" style="margin-bottom:6px">Change a subscriber\'s duration, amount or next renewal date. Leave the amount unchanged to keep following the bot price list.</div>';
    if (!subs.length) return head + '<div class="tiny muted">No bot subscriptions yet.</div>';
    return head + `<div class="table-wrap"><table class="tbl"><thead><tr><th>User / bot</th><th>Duration</th><th>Amount ($)</th><th>Renews on</th><th>Auto</th><th>Status</th><th></th></tr></thead><tbody>
      ${subs.map((s) => {
        const amt = s.priceOverride != null ? s.priceOverride : s.priceUsd;
        return `<tr data-bot-sub="${escB(s.id)}"><td>@${escB(s.username)}<div class="tiny muted">${escB(s.tierName)}</div></td>
          <td><select class="input bot-mini" data-sf="billingCycle">${DURS.map((d) => `<option value="${d[0]}" ${s.billingCycle === d[0] ? 'selected' : ''}>${d[1]}</option>`).join('')}</select></td>
          <td><input class="input bot-mini" data-sf="priceUsd" data-orig="${num(amt)}" type="number" min="0" step="0.01" value="${num(amt)}"/></td>
          <td><input class="input" data-sf="expiresAt" type="datetime-local" value="${dtLocal(s.expiresAt)}"/></td>
          <td><input type="checkbox" data-sf="autoRenew" ${s.autoRenew ? 'checked' : ''}/></td>
          <td>${escB(s.status)}</td>
          <td><button class="btn btn-xs btn-primary" data-act="bot-admin-sub-save" data-id="${escB(s.id)}">Save</button></td></tr>`;
      }).join('')}</tbody></table></div>`;
  }

  function adminBodyHTML(a) {
    if (!a) return '<div class="tiny muted" style="margin-top:10px">Could not load bot configuration.</div>';
    const s = a.settings || {};
    const intervals = [[1, 'Every minute'], [5, 'Every 5 minutes'], [15, 'Every 15 minutes'], [30, 'Every 30 minutes'], [60, 'Hourly'], [240, 'Every 4 hours'], [1440, 'Daily']];
    return `<div class="bot-admin-stats">
        <div><span>Active subscriptions</span><b>${a.stats.subscriptions}</b></div>
        <div><span>Running bots</span><b>${a.stats.running}</b></div>
        <div><span>Reserved capital</span><b>${money((a.stats.reservedCoins)*0.5)}</b></div>
        <div><span>Subscription revenue</span><b>${money((a.stats.revenueCoins)*0.5)}</b></div>
      </div>
      <div class="between" style="margin-top:12px;gap:8px;flex-wrap:wrap">
        <div class="tiny muted">Add trading assistants with their own username and profile picture. Mark them HOT to feature them in the marketplace.</div>
        <button class="btn btn-sm btn-primary" data-act="bot-add-assistant">+ Add bot assistant</button>
      </div>
      <div class="table-wrap"><table class="tbl bot-admin-table"><thead><tr><th>Assistant</th><th>Accuracy %</th><th>24 hrs ($)</th><th>Weekly ($)</th><th>Monthly ($)</th><th>Yearly ($)</th><th>Speed (min)</th><th>Hot</th><th>Live</th><th></th></tr></thead><tbody>
        ${a.tiers.map(adminTierRow).join('')}
      </tbody></table></div>
      ${subsAdminHTML(a)}
      <div class="bot-admin-grid">
        <div class="field"><label class="label">Offline trade speed (default)</label>
          <select class="input" id="botCfgInterval">${intervals.map(([v, l]) => `<option value="${v}" ${Number(s.intervalMin) === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <div class="tiny muted" style="margin-top:4px">Used when a tier has no speed override. Applies to new sessions.</div></div>
        <div class="field"><label class="label">Minimum allocation (WC)</label>
          <input class="input" id="botCfgMinCap" type="number" min="1" step="1" value="${s.minCapitalCoins}"/></div>
        <div class="field"><label class="label">Auto-stop threshold (% left)</label>
          <input class="input" id="botCfgMinPool" type="number" min="1" max="100" step="1" value="${s.minPoolPct}"/></div>
        <div class="field"><label class="label">Stake per trade (% of pool)</label>
          <input class="input" id="botCfgStake" type="number" min="1" max="100" step="1" value="${s.stakePct}"/></div>
        <div class="field"><label class="label">Price move on a win (%)</label>
          <input class="input" id="botCfgWin" type="number" min="0.1" step="0.1" value="${s.winPct}"/></div>
        <div class="field"><label class="label">Price move on a loss (%)</label>
          <input class="input" id="botCfgLoss" type="number" min="0.1" step="0.1" value="${s.lossPct}"/></div>
        <div class="field"><label class="label">Leverage (x)</label>
          <input class="input" id="botCfgLev" type="number" min="1" max="100" step="1" value="${s.leverage != null ? s.leverage : 5}"/></div>
        <div class="field"><label class="label">Trade fee (% of stake, taken from payout)</label>
          <input class="input" id="botCfgFee" type="number" min="0" max="50" step="0.1" value="${s.tradeFeePct != null ? s.tradeFeePct : 0.5}"/>
          <div class="tiny muted" style="margin-top:4px">profit = stake × move % × leverage · payout = stake + profit − fee</div></div>
        <div class="field"><label class="label">Auto Secure price (USD)</label>
          <input class="input" id="botCfgAutoPrice" type="number" min="0" step="0.01" value="${Number((a.autoSecure || {}).priceUsd != null ? a.autoSecure.priceUsd : s.autoSecurePriceUsd) || 20}"/>
          <div class="tiny muted" style="margin-top:4px">Charged as ${money(((Number((a.autoSecure || {}).priceUsd) || Number(s.autoSecurePriceUsd) || 20) * 2)*0.5)} (1 WC = $0.50).</div></div>
        <div class="field"><label class="label">Auto Secure billing cycle</label>
          <select class="input" id="botCfgAutoCycle">
            ${['daily', 'weekly', 'monthly', 'one_time'].map((c) => `<option value="${c}" ${((a.autoSecure || {}).billingCycle || s.autoSecureCycle) === c ? 'selected' : ''}>${c.replace('_', '-')}</option>`).join('')}
          </select>
          <div class="tiny muted" style="margin-top:4px">Applies to new subscriptions and renewals.</div></div>
      </div>
      <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
        <button class="btn btn-primary" data-act="bot-admin-save">${ic('check', 14)} Save bot settings</button>
        <button class="btn btn-ghost" data-act="bot-admin-reload">${ic('refresh', 14)} Reload</button>
      </div>
      <div class="tiny muted" style="margin-top:8px;line-height:1.6">Speed changes apply to sessions started after saving. Existing running sessions keep their interval until the user stops and starts again.</div>`;
  }

  async function mountAdmin(force) {
    const body = document.getElementById('botAdminBody');
    if (!body) return;
    const a = await loadAdmin(force);
    if (body.isConnected) body.innerHTML = adminBodyHTML(a);
  }

  /* -------------------------------- actions -------------------------------- */
  if (typeof App !== 'undefined') {
    App.botRefresh = async function () {
      await load(true);
      await loadAdmin(true);
      render();
      tmsg('Bot status refreshed', 'ok');
    };

    App.botUnlock = async function () {
      const S = window.WC_SUBS;
      if (!S) return tmsg('Subscriptions are still loading, try again', 'err');
      if (!S.is('botassist')) {
        const price = S.price('botassist');
        if (typeof confirmDialog === 'function') {
          const ok = await confirmDialog({ title: 'Unlock Bot Assisted Trading?', body: money(price) + ' one-time payment from your investment trade capital. You will not be charged for this again.', ok: 'Unlock' });
          if (!ok) return;
        }
        const r = await S.subscribe('botassist', { source: 'tools', method: 'credit', noRender: true });
        if (!r.ok && !r.already) return tmsg(r.error || 'Could not unlock', 'err');
        try { if (typeof persist === 'function') persist(true); } catch (e) {}
        await new Promise((res) => setTimeout(res, 2000));
      }
      B.loadedAt = 0;
      await load(true);
      render();
      tmsg('Bot Assisted Trading unlocked — pick a bot to subscribe', 'ok');
    };

    App.botSubscribe = async function (id) {
      const t = (B.state && B.state.tiers || []).find((x) => x.id === id);
      if (!t) return tmsg('Bot tier not found', 'err');
      if (typeof Remote === 'undefined' || !Remote.enabled) return tmsg('Connect the sync server to subscribe', 'err');
      if (!(B.state && B.state.botAccess)) return tmsg('Unlock Bot Assisted Trading first (one-time payment)', 'err');
      const durEl = document.getElementById('botDur_' + id);
      const duration = (durEl && durEl.value) || 'monthly';
      const durLabel = (DURS.find((d) => d[0] === duration) || [duration, duration])[1];
      const price = tp(t, duration);
      if (typeof confirmDialog === 'function') {
        const ok = await confirmDialog({
          title: 'Subscribe to ' + t.name + '?',
          body: `${money(price)} for ${durLabel.toLowerCase()} will be deducted from your investment trade capital. It renews automatically while you have balance; if your balance runs out the bot turns off until you renew it manually.`,
          ok: 'Subscribe'
        });
        if (!ok) return;
      }
      try {
        const r = await api('/api/bots/subscribe', { method: 'POST', body: JSON.stringify({ userId: uidNow(), tierId: id, duration }) }, 25000);
        if (!r.res || !r.res.ok || !r.data || !r.data.ok) return tmsg((r.data && r.data.error) || 'Subscription failed', 'err');
        await Remote.refresh(true);
        await load(true);
        tmsg(t.name + ' unlocked — allocate capital to start it', 'ok');
        render();
      } catch (e) { tmsg('Subscription failed: ' + e.message, 'err'); }
    };

    App.botStart = async function () {
      if (typeof Remote === 'undefined' || !Remote.enabled) return tmsg('Connect the sync server to start the bot', 'err');
      const tierEl = document.getElementById('botTier');
      const topupEl = document.getElementById('botStartTopup');
      const minEl = document.getElementById('botMin');
      const maxEl = document.getElementById('botMax');
      const durEl = document.getElementById('botDuration');
      const tierId = tierEl ? tierEl.value : '';
      if (!tierId) return tmsg('Select a bot assistant you own', 'err');
      const topup = (Number(topupEl && topupEl.value) || 0) * 2; // USD -> WC
      const capitalNow = Number((B.state && B.state.account && B.state.account.capitalCoins) || 0);
      if (!(topup > 0) && capitalNow < 5) {
        tmsg('Bot trading capital is $0.00 — top up at least $2.50 to start', 'err');
        return App.botTopup();
      }
      const minTrade = (Number(minEl && minEl.value) || 0) * 2; // USD -> WC
      const maxTrade = (Number(maxEl && maxEl.value) || 0) * 2; // USD -> WC
      const duration = Number(durEl && durEl.value) || 0;
      if (!(minTrade > 0) || maxTrade < minTrade) return tmsg('Set a valid minimum and maximum amount per trade', 'err');
      if (typeof confirmDialog === 'function') {
        const ok = await confirmDialog({
          title: 'Start trading now?',
          body: `${tierEl.options[tierEl.selectedIndex].text} will trade real stocks between ${num(minTrade)} and ${money((maxTrade)*0.5)} per trade${duration ? ', then stop after ' + duration + ' minutes' : ''}. Payouts go to the bot profit balance.`,
          ok: 'Start trading'
        });
        if (!ok) return;
      }
      try {
        const r = await api('/api/bots/start', { method: 'POST', body: JSON.stringify({
          userId: uidNow(), tierId, topupCoins: topup, minTradeCoins: minTrade, maxTradeCoins: maxTrade, durationMinutes: duration
        }) }, 25000);
        if (!r.res || !r.res.ok || !r.data || !r.data.ok) return tmsg((r.data && r.data.error) || 'Could not start bot', 'err');
        await Remote.refresh(true);
        await load(true);
        tmsg('Bot trading started — real stocks will be traded automatically', 'ok');
        render();
      } catch (e) { tmsg('Could not start bot: ' + e.message, 'err'); }
    };

    App.botResume = async function () {
      if (typeof Remote === 'undefined' || !Remote.enabled) return tmsg('Connect the sync server to resume', 'err');
      try {
        const r = await api('/api/bots/resume', { method: 'POST', body: JSON.stringify({ userId: uidNow() }) }, 20000);
        if (!r.res || !r.res.ok || !r.data || !r.data.ok) return tmsg((r.data && r.data.error) || 'Could not resume', 'err');
        await Remote.refresh(true); await load(true); tmsg('Bot resumed', 'ok'); render();
      } catch (e) { tmsg('Could not resume: ' + e.message, 'err'); }
    };

    App.botToggle = async function () {
      const sess = B.state && B.state.session;
      const acc = (B.state && B.state.account) || { capitalCoins: 0 };
      if (sess && sess.status === 'running') return App.botStop();
      if (sess && sess.status === 'cooling') return App.botResume();
      if (!(Number(acc.capitalCoins) >= 5)) return App.botTopup();
      const form = document.getElementById('botTier');
      if (form) { try { form.scrollIntoView({ behavior: 'smooth', block: 'center' }); form.focus(); } catch (e) {} }
      tmsg('Set your trade limits and press Start trading now', 'ok');
    };

    App.botStop = async function () {
      if (typeof Remote === 'undefined' || !Remote.enabled) return tmsg('Connect the sync server to stop the bot', 'err');
      if (typeof confirmDialog === 'function') {
        const ok = await confirmDialog({
          title: 'Stop the bot?',
          body: 'Trading stops immediately. The remaining capital and profit stay in the bot balances so you can transfer or top up later.',
          ok: 'Stop bot', danger: true
        });
        if (!ok) return;
      }
      try {
        const r = await api('/api/bots/stop', { method: 'POST', body: JSON.stringify({ userId: uidNow() }) }, 25000);
        if (!r.res || !r.res.ok || !r.data || !r.data.ok) return tmsg((r.data && r.data.error) || 'Could not stop bot', 'err');
        await Remote.refresh(true); await load(true);
        tmsg('Bot stopped — capital and profit remain in the bot balances', 'ok');
        render();
      } catch (e) { tmsg('Could not stop bot: ' + e.message, 'err'); }
    };

    App.botTopup = function () {
      const acc = (B.state && B.state.account) || { capitalCoins: 0 };
      openModal(modalShell('Top up bot trading capital', `
        <div class="tiny muted" style="margin-bottom:10px;line-height:1.6">Move funds from your <b>stock trading balance</b> (${money((B.state && B.state.balance)*0.5)}) into the bot trading capital balance.</div>
        <div class="bot-balance-grid" style="margin-top:0">
          <div><span>Bot capital now</span><b>${money((acc.capitalCoins)*0.5)}</b></div>
          <div><span>Stock trading balance</span><b>${money((B.state && B.state.balance)*0.5)}</b></div>
        </div>
        <div class="field" style="margin-top:12px"><label class="label">Top-up amount (USD)</label>
          <div class="input-wrap"><span class="inv-prefix">$</span><input class="input" id="botTopupUsd" type="number" min="0.5" step="0.01" placeholder="10.00"/></div>
          <div class="tiny muted" style="margin-top:4px">1 WC = $0.50</div></div>`,
        `<button class="btn btn-ghost" data-close style="flex:1">Cancel</button><button class="btn btn-primary" id="botTopupSend" style="flex:1">Send top-up</button>`), { locked: false });
      const btn = document.getElementById('botTopupSend');
      if (btn) btn.onclick = async () => {
        const usd = Number((document.getElementById('botTopupUsd') || {}).value) || 0;
        if (!(usd > 0)) return tmsg('Enter an amount', 'err');
        try {
          const r = await api('/api/bots/topup', { method: 'POST', body: JSON.stringify({ userId: uidNow(), amountUsd: usd }) }, 20000);
          if (!r.res || !r.res.ok || !r.data || !r.data.ok) return tmsg((r.data && r.data.error) || 'Top-up failed', 'err');
          closeModal(); await Remote.refresh(true); await load(true); tmsg('Bot capital topped up', 'ok'); render();
        } catch (e) { tmsg('Top-up failed: ' + e.message, 'err'); }
      };
    };

    App.botTransfer = function () {
      const acc = (B.state && B.state.account) || { capitalCoins: 0, profitCoins: 0 };
      openModal(modalShell('Transfer from bot balances', `
        <div class="tiny muted" style="margin-bottom:10px;line-height:1.6">Choose which bot balance to transfer from. Funds go to your stock trading balance.</div>
        <div class="field"><label class="label">Transfer from</label>
          <select class="input" id="botTransferSource">
            <option value="capital">Bot trading capital · ${money((acc.capitalCoins)*0.5)}</option>
            <option value="profit">Bot profit balance · ${money((acc.profitCoins)*0.5)}</option>
          </select></div>
        <div class="field"><label class="label">Amount (USD)</label>
          <div class="input-wrap"><span class="inv-prefix">$</span><input class="input" id="botTransferUsd" type="number" min="0.01" step="0.01" placeholder="10.00"/></div>
          <div class="tiny muted" style="margin-top:4px">1 WC = $0.50</div></div>`,
        `<button class="btn btn-ghost" data-close style="flex:1">Cancel</button><button class="btn btn-primary" id="botTransferSend" style="flex:1">Send</button>`), { locked: false });
      const btn = document.getElementById('botTransferSend');
      if (btn) btn.onclick = async () => {
        const source = (document.getElementById('botTransferSource') || {}).value || 'capital';
        const usd = Number((document.getElementById('botTransferUsd') || {}).value) || 0;
        if (!(usd > 0)) return tmsg('Enter an amount', 'err');
        try {
          const r = await api('/api/bots/transfer', { method: 'POST', body: JSON.stringify({ userId: uidNow(), source, amountUsd: usd }) }, 20000);
          if (!r.res || !r.res.ok || !r.data || !r.data.ok) return tmsg((r.data && r.data.error) || 'Transfer failed', 'err');
          closeModal(); await Remote.refresh(true); await load(true); tmsg('Transfer sent to your stock trading balance', 'ok'); render();
        } catch (e) { tmsg('Transfer failed: ' + e.message, 'err'); }
      };
    };

    App.botHistory = async function () {
      if (typeof Remote === 'undefined' || !Remote.enabled) return tmsg('Connect the sync server to view history', 'err');
      try {
        const r = await api('/api/bots/history?userId=' + encodeURIComponent(uidNow()), {}, 15000);
        const h = (r.data && r.data.ok) ? r.data : { events: (B.state && B.state.events) || [], sessions: [], txs: [] };
        const ev = (h.events || []).slice(0, 120);
        const txs = (h.txs || []).slice(0, 60);
        openModal(modalShell('Bot trading history', `
          <div class="tiny muted" style="margin-bottom:10px">Top-ups, transfers, trade payouts, subscription renewals, start/stop and cooling events.</div>
          <div class="card-title" style="margin:0 0 6px">Bot events</div>
          <div class="bot-log" style="max-height:260px;overflow:auto">
            ${ev.length ? ev.map((e) => `<div class="bot-log-row"><div class="grow" style="min-width:0"><b>${escB(e.type)}</b>
              <div class="tiny muted">${escB(e.label || '')} · ${when(e.at)}</div></div>
              <span class="${e.amountCoins >= 0 ? 'up' : 'down'}">${e.amountCoins ? (e.amountCoins > 0 ? '+' : '−') + num(Math.abs(e.amountCoins)) + ' WC' : ''}</span></div>`).join('') : '<div class="tiny muted">No bot events yet.</div>'}
          </div>
          <div class="card-title" style="margin:14px 0 6px">Subscription &amp; renewal records</div>
          <div class="bot-log" style="max-height:160px;overflow:auto">
            ${txs.length ? txs.map((t) => `<div class="bot-log-row"><div class="grow"><div class="tiny muted">${escB(t.label || t.type)} · ${when(t.createdAt)}</div></div>
              <span class="${Number(t.coins) >= 0 ? 'up' : 'down'}">${Number(t.coins) >= 0 ? '+' : '−'}${money((Math.abs(Number(t.coins) || 0))*0.5)}</span></div>`).join('') : '<div class="tiny muted">No subscription records yet.</div>'}
          </div>`,
          `<button class="btn btn-ghost" data-close style="width:100%">Close</button>`), { locked: false });
      } catch (e) { tmsg('Could not load history: ' + e.message, 'err'); }
    };

    App.botAutoSubscribe = async function () {
      /* shared subscription guard — never charge a user twice for the same tool */
      const shared = (typeof window.WC_SUBS !== 'undefined' && window.WC_SUBS) ? window.WC_SUBS : null;
      const sharedRec = shared ? shared.record('autosecure') : null;
      const alreadyHere = shared ? shared.is('autosecure') : false;
      if (alreadyHere && sharedRec && sharedRec.source && sharedRec.source !== 'bots') {
        return tmsg('Auto Secure is already subscribed from the Tools page — nothing more to pay', 'ok');
      }
      if (typeof Remote === 'undefined' || !Remote.enabled) {
        /* offline mode: record the subscription locally so every page agrees */
        if (!shared) return tmsg('Connect the sync server to subscribe', 'err');
        const local = await shared.subscribe('autosecure', { source: 'bots', method: 'credit' });
        if (local.already) return tmsg('Auto Secure is already subscribed', 'ok');
        if (!local.ok) return tmsg(local.error === 'cancelled' ? 'Subscription cancelled' : (local.error || 'Subscription failed'), 'err');
        tmsg('Auto Secure is ON — available profit will be secured for you', 'ok');
        return render();
      }
      const a = (B.state && B.state.autoSecure) || {};
      if (alreadyHere) {
        /* billed elsewhere already — just make sure the engine knows about it */
        try {
          await api('/api/bots/auto-secure/subscribe', { method: 'POST', body: JSON.stringify({ userId: uidNow(), activateOnly: true }) }, 25000);
          await load(true);
        } catch (e) {}
        tmsg('Auto Secure is already subscribed — synced across every page', 'ok');
        return render();
      }
      if (typeof confirmDialog === 'function') {
        const ok = await confirmDialog({
          title: 'Subscribe to Auto Secure Take Profit?',
          body: `${money((a.priceCoins)*0.5)} will be deducted from your balance (${money(a.priceUsd)} / ${escB(a.billedAs || 'monthly')}). The bot will secure profit on your active trades even while you are offline.`,
          ok: 'Subscribe'
        });
        if (!ok) return;
      }
      try {
        const r = await api('/api/bots/auto-secure/subscribe', { method: 'POST', body: JSON.stringify({ userId: uidNow() }) }, 25000);
        if (!r.res || !r.res.ok || !r.data || !r.data.ok) return tmsg((r.data && r.data.error) || 'Subscription failed', 'err');
        await Remote.refresh(true);
        await load(true);
        /* mirror the server record into the shared registry so the Tools page
           and the stock page show it as subscribed (no second payment) */
        if (shared) {
          const auto = (B.state && B.state.autoSecure) || {};
          shared.set('autosecure', {
            active: true, paused: auto.enabled === false,
            expiresAt: Number(auto.expiresAt) || (Date.now() + 30 * 864e5),
            price: Number(auto.priceUsd) || shared.price('autosecure'),
            priceCoins: Number(auto.priceCoins) || 0,
            paidUsd: 0, source: 'bots', mirroredAt: Date.now()
          }, { silent: true });
          shared.reconcile({ silent: true });
        }
        tmsg('Auto Secure is ON across the bots page, tools page and stock page', 'ok');
        render();
      } catch (e) { tmsg('Subscription failed: ' + e.message, 'err'); }
    };

    App.botAutoToggle = async function () {
      if (typeof Remote === 'undefined' || !Remote.enabled) return tmsg('Connect the sync server to change this tool', 'err');
      const cur = (B.state && B.state.autoSecure) || {};
      try {
        const r = await api('/api/bots/auto-secure/toggle', { method: 'POST', body: JSON.stringify({ userId: uidNow(), enabled: !cur.enabled }) }, 20000);
        if (!r.res || !r.res.ok || !r.data || !r.data.ok) return tmsg((r.data && r.data.error) || 'Could not update the tool', 'err');
        await load(true);
        tmsg(r.data.autoSecure && r.data.autoSecure.enabled ? 'Auto secure turned on' : 'Auto secure turned off', 'ok');
        render();
      } catch (e) { tmsg('Could not update the tool: ' + e.message, 'err'); }
    };

    App.botAdminReload = function () { mountAdmin(true); };

    function resizeAvatar(file, cb) {
      try {
        const reader = new FileReader();
        reader.onload = () => {
          const img = new Image();
          img.onload = () => {
            try {
              const size = 160;
              const c = document.createElement('canvas');
              c.width = size; c.height = size;
              const ctx = c.getContext('2d');
              const s = Math.min(img.width, img.height);
              ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
              cb(c.toDataURL('image/jpeg', 0.82));
            } catch (e) { cb(''); }
          };
          img.onerror = () => cb('');
          img.src = reader.result;
        };
        reader.onerror = () => cb('');
        reader.readAsDataURL(file);
      } catch (e) { cb(''); }
    }

    function openAssistantModal(t) {
      const isNew = !t;
      const av = { data: t && t.avatar ? t.avatar : '' };
      const body = `<div class="row" style="gap:12px;align-items:center;margin-bottom:12px">
          <span id="baAvatarPreview">${avatarHTML({ name: (t && t.name) || 'Bot', avatar: av.data }, 64)}</span>
          <div class="grow"><label class="label">Profile picture</label>
            <input class="input" id="baAvatarFile" type="file" accept="image/*"/>
            <div class="tiny muted" style="margin-top:4px">Square JPG/PNG, resized to 160×160 automatically. <button type="button" class="link" id="baAvatarClear">Remove</button></div></div>
        </div>
        <div class="field"><label class="label">Assistant name</label><input class="input" id="baName" maxlength="60" value="${escB((t && t.name) || '')}" placeholder="e.g. Tokyo Scalper"/></div>
        <div class="field"><label class="label">Bot username</label><input class="input" id="baUsername" maxlength="40" value="${escB((t && t.username) || '')}" placeholder="e.g. tokyo_scalper"/></div>
        <div class="field"><label class="label">Description</label><input class="input" id="baBlurb" maxlength="140" value="${escB((t && t.blurb) || '')}" placeholder="Short description shown to users"/></div>
        <label class="checkline"><input type="checkbox" id="baHot" ${t && t.hot ? 'checked' : ''}/> <span class="small">Mark as HOT trading assistant</span></label>
        <div class="tiny" id="baErr" style="color:var(--danger);min-height:16px;margin-top:6px"></div>`;
      openModal(modalShell(isNew ? 'Add bot assistant' : 'Edit bot assistant', body,
        `<button class="btn btn-ghost" data-close style="flex:1">Cancel</button>
         <button class="btn btn-primary" id="baSave" style="flex:1">${isNew ? 'Add assistant' : 'Save assistant'}</button>`), { locked: false });
      const preview = document.getElementById('baAvatarPreview');
      const file = document.getElementById('baAvatarFile');
      if (file) file.onchange = () => {
        const f = file.files && file.files[0];
        if (!f) return;
        resizeAvatar(f, (data) => {
          if (!data) { document.getElementById('baErr').textContent = 'Could not read that image.'; return; }
          av.data = data;
          preview.innerHTML = avatarHTML({ name: (document.getElementById('baName') || {}).value || 'Bot', avatar: data }, 64);
        });
      };
      const clear = document.getElementById('baAvatarClear');
      if (clear) clear.onclick = () => { av.data = ''; preview.innerHTML = avatarHTML({ name: 'Bot' }, 64); };
      const save = async () => {
        const name = String((document.getElementById('baName') || {}).value || '').trim();
        const username = String((document.getElementById('baUsername') || {}).value || '').trim().replace(/^@+/, '');
        const blurb = String((document.getElementById('baBlurb') || {}).value || '').trim();
        const hot = !!(document.getElementById('baHot') || {}).checked;
        const err = document.getElementById('baErr');
        if (!name) { if (err) err.textContent = 'Enter an assistant name.'; return; }
        if (username && !/^[A-Za-z0-9_.-]{2,40}$/.test(username)) { if (err) err.textContent = 'Username may use letters, numbers, dot, underscore and dash.'; return; }
        const row = isNew ? null : document.querySelector('[data-bot-tier="' + t.id + '"]');
        if (isNew) {
          const tbody = document.querySelector('.bot-admin-table tbody');
          if (!tbody) return;
          const rec = {
            id: 'ba_' + Date.now().toString(36), name, username, avatar: av.data, blurb, hot,
            accuracy: 50, priceUsd: 50, billingCycle: 'monthly', intervalMin: 0, enabled: true
          };
          tbody.insertAdjacentHTML('beforeend', adminTierRow(rec));
        } else if (row) {
          const set = (f, v) => { const el = row.querySelector('[data-f="' + f + '"]'); if (el) el.value = v; };
          set('name', name); set('username', username); set('avatar', av.data); set('blurb', blurb);
          const hotEl = row.querySelector('[data-f="hot"]'); if (hotEl) hotEl.checked = hot;
          const nEl = row.querySelector('[data-bot-name]'); if (nEl) nEl.textContent = name;
          const uEl = row.querySelector('[data-bot-username]'); if (uEl) uEl.textContent = username ? '@' + username : 'no username';
          const aEl = row.querySelector('[data-bot-avatar]'); if (aEl) aEl.innerHTML = avatarHTML({ name, avatar: av.data }, 34);
        }
        closeModal();
        await App.botAdminSave();
      };
      const btn = document.getElementById('baSave');
      if (btn) btn.onclick = save;
    }

    App.botAddAssistant = function () { openAssistantModal(null); };
    App.botEditAssistant = function (id, ds) {
      const tier = (B.admin && B.admin.tiers || []).find((x) => x.id === (ds && ds.id));
      if (!tier) return tmsg('Assistant not found', 'err');
      openAssistantModal(tier);
    };

    App.botAdminSubSave = async function (id) {
      if (!isAdmin()) return tmsg('Admin only', 'err');
      const row = document.querySelector('[data-bot-sub="' + id + '"]');
      if (!row) return;
      const f = (n) => row.querySelector('[data-sf="' + n + '"]');
      const body = { adminId: uidNow(), subId: id, billingCycle: f('billingCycle').value, autoRenew: f('autoRenew').checked };
      const pe = f('priceUsd');
      if (pe && pe.value !== pe.getAttribute('data-orig')) body.priceUsd = Number(pe.value);
      const ee = f('expiresAt');
      if (ee && ee.value) body.expiresAt = new Date(ee.value).getTime();
      try {
        const r = await api('/api/bots/admin/subscription', { method: 'POST', body: JSON.stringify(body) }, 20000);
        if (!r.res || !r.res.ok || !r.data || !r.data.ok) return tmsg((r.data && r.data.error) || 'Save failed', 'err');
        B.admin = r.data; B.adminLoadedAt = Date.now();
        mountAdmin(true);
        tmsg('Subscription updated', 'ok');
      } catch (e) { tmsg('Save failed: ' + e.message, 'err'); }
    };

    App.botAdminSave = async function () {
      if (!isAdmin()) return tmsg('Admin only', 'err');
      const tiers = [];
      document.querySelectorAll('[data-bot-tier]').forEach((row) => {
        const get = (f) => row.querySelector('[data-f="' + f + '"]');
        if (!get('accuracy')) return;
        tiers.push({
          id: row.getAttribute('data-bot-tier'),
          name: (get('name') && get('name').value) || '',
          username: (get('username') && get('username').value) || '',
          avatar: (get('avatar') && get('avatar').value) || '',
          blurb: (get('blurb') && get('blurb').value) || '',
          hot: !!(get('hot') && get('hot').checked),
          accuracy: Number(get('accuracy').value),
          prices: { daily: Number(get('price_daily').value), weekly: Number(get('price_weekly').value), monthly: Number(get('price_monthly').value), yearly: Number(get('price_yearly').value) },
          intervalMin: Number(get('intervalMin').value) || 0,
          enabled: get('enabled').checked
        });
      });
      const val = (id, dflt) => { const el = document.getElementById(id); return el ? Number(el.value) : dflt; };
      const settings = {
        intervalMin: val('botCfgInterval', 5),
        minCapitalCoins: val('botCfgMinCap', 5),
        minPoolPct: val('botCfgMinPool', 10),
        stakePct: val('botCfgStake', 20),
        winPct: val('botCfgWin', 4),
        lossPct: val('botCfgLoss', 6),
        leverage: val('botCfgLev', 5),
        tradeFeePct: val('botCfgFee', 0.5),
        autoSecurePriceUsd: val('botCfgAutoPrice', 20),
        autoSecureCycle: (document.getElementById('botCfgAutoCycle') || {}).value || 'monthly'
      };
      try {
        const r = await api('/api/bots/admin/config', { method: 'POST', body: JSON.stringify({ adminId: uidNow(), tiers, settings }) }, 20000);
        if (!r.res || !r.res.ok || !r.data || !r.data.ok) return tmsg((r.data && r.data.error) || 'Save failed', 'err');
        B.admin = r.data; B.adminLoadedAt = Date.now();
        B.loadedAt = 0;
        mountAdmin(true);
        tmsg('Bot pricing and speed saved', 'ok');
      } catch (e) { tmsg('Save failed: ' + e.message, 'err'); }
    };
  }

  /* ----------------------------- mount + polling ---------------------------- */
  function onBotsPage() { return (location.hash || '').startsWith('#/invest/bots'); }

  function patchViews() {
    if (typeof VIEWS === 'undefined' || !VIEWS.invest) return false;
    if (VIEWS.__wcBotsPatched) return true;
    const base = VIEWS.invest;
    VIEWS.invest = function (parts, params) {
      if ((parts[1] || '') === 'bots') return B.view();
      return base.apply(this, arguments);
    };
    VIEWS.__wcBotsPatched = true;
    return true;
  }

  function patchDash() {
    if (typeof INV === 'undefined' || !INV.viewDash) return false;
    if (INV.__wcBotsDash) return true;
    const base = INV.viewDash;
    INV.viewDash = function () {
      const html = base.apply(this, arguments);
      const anchor = '<div class="card inv-chartcard">';
      if (html.indexOf(anchor) === -1) return html;
      return html.replace(anchor, dashCard() + anchor);
    };
    INV.__wcBotsDash = true;
    return true;
  }

  function patchAdmin() {
    if (typeof INV === 'undefined' || !INV.viewAdminStocks) return false;
    if (INV.__wcBotsAdmin) return true;
    const base = INV.viewAdminStocks;
    INV.viewAdminStocks = function () {
      const html = base.apply(this, arguments);
      if (/Admin access only/.test(html)) return html;
      return html + adminCard();
    };
    INV.__wcBotsAdmin = true;
    return true;
  }

  function paintCountdown() {
    const el = document.querySelector('[data-bot-next]');
    if (!el) return;
    const s = B.state && B.state.session;
    if (!s || s.status !== 'running') { el.textContent = '—'; return; }
    const secs = Math.max(0, Math.round((Number(s.nextTradeAt) - Date.now()) / 1000));
    el.textContent = secs > 0 ? Math.floor(secs / 60) + 'm ' + String(secs % 60).padStart(2, '0') + 's' : 'placing trade…';
    const pool = document.querySelector('[data-bot-pool]');
    if (pool && B.state) pool.textContent = money(s.poolCoins * 0.5);
  }

  function paintAutoSecure() {
    const a = B.state && B.state.autoSecure;
    if (!a) return;
    document.querySelectorAll('[data-bot-secured]').forEach((el) => { el.textContent = money(a.securedCoins * 0.5); });
    document.querySelectorAll('[data-bot-secured-count]').forEach((el) => { el.textContent = num(a.securedCount, 0); });
  }

  function init() {
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      const ok = patchViews() && patchDash() && patchAdmin();
      if (ok || tries > 30) clearInterval(iv);
      if (ok) {
        if (typeof AFTER === 'object') {
          const prev = AFTER.invest;
          AFTER.invest = function (parts, params) {
            try { if (prev) prev(parts, params); } catch (e) {}
            if (onBotsPage()) {
              load(true).then(() => {
                const mount = document.getElementById('botSessionMount');
                const hist = document.getElementById('botHistoryMount');
                if (mount && B.state) mount.innerHTML = sessionHTML(B.state.session);
                if (hist && B.state) hist.innerHTML = historyHTML();
              });
            } else if (!B.state) {
              load(false).then(() => {
                if (B.state && (location.hash || '').startsWith('#/invest') && !onBotsPage()) { try { render(); } catch (e) {} }
              });
            }
          };
          const prevAdmin = AFTER.admin;
          AFTER.admin = function (parts, params) {
            try { if (prevAdmin) prevAdmin(parts, params); } catch (e) {}
            if ((parts[1] || '') === 'stocks') setTimeout(() => mountAdmin(false), 120);
          };
        }
      }
    }, 200);
    setInterval(paintCountdown, 1000);
    setInterval(paintAutoSecure, 1000);
    /* keep the main Invest dashboard's portfolio chart in sync with the bot */
    setInterval(async () => {
      if (document.hidden) return;
      const h = location.hash || '';
      if (!h.startsWith('#/invest') || h.startsWith('#/invest/bots') || h.startsWith('#/invest/shares')) return;
      const snap = (st) => st && st.session ? [st.session.id, st.session.poolCoins, st.session.tradeCount, st.session.status].join('|') : '';
      const before = snap(B.state);
      await load(true);
      const after = snap(B.state);
      if (before === after) return;
      try { if (typeof render === 'function') render(); } catch (e) {}
    }, 8000);
    /* live refresh while the bot page is open */
    setInterval(async () => {
      if (!onBotsPage() || document.hidden) return;
      const before = B.state && B.state.session ? B.state.session.poolCoins + '|' + B.state.session.tradeCount : '';
      await load(true);
      if (!onBotsPage() || !B.state) return;
      const mount = document.getElementById('botSessionMount');
      const hist = document.getElementById('botHistoryMount');
      if (mount) mount.innerHTML = sessionHTML(B.state.session);
      if (hist) hist.innerHTML = historyHTML();
      const after = B.state.session ? B.state.session.poolCoins + '|' + B.state.session.tradeCount : '';
      if (before && after && before !== after) tmsg('Bot activity updated', 'ok');
    }, 15000);
  }

  (function styles() {
    if (document.getElementById('wc-bot-style')) return;
    const st = document.createElement('style');
    st.id = 'wc-bot-style';
    st.textContent = `
    .bot-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-top:12px}
    .bot-dash-bals{display:flex;gap:14px;flex-wrap:wrap;margin-top:8px}
    .bot-dash-bals span{font-size:11px;color:var(--muted)}
    .bot-dash-bals b{color:var(--text);font-size:12.5px}
    .bot-balance-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px}
    .bot-balance-grid div{display:flex;flex-direction:column;gap:1px;padding:9px;border:1px solid var(--border);border-radius:10px;background:var(--surface-2);min-width:0}
    .bot-balance-grid span{font-size:9.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted-2);font-weight:700}
    .bot-balance-grid b{font-size:14px;font-variant-numeric:tabular-nums}
    .bot-balance-grid i{font-style:normal;font-size:10px;color:var(--muted)}
    .bot-account-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:9px;margin-top:10px}
    .bot-cooling{margin-top:10px;padding:10px;border-radius:10px;border:1px solid rgba(255,176,32,.35);background:rgba(255,176,32,.10);display:flex;flex-direction:column;gap:5px;font-size:11.5px}
    .bot-cooling b{font-size:12.5px}
    .bot-badge.cool{color:var(--warn);background:rgba(255,176,32,.12)}
    @media(max-width:560px){.bot-balance-grid{grid-template-columns:1fr 1fr}.bot-account-grid{grid-template-columns:1fr}}
    .bot-avatar-fb{display:inline-flex;align-items:center;justify-content:center;border-radius:12px;flex:none;
      background:linear-gradient(135deg,#2ee6c9,#3aa0ff);color:#03221d;font-weight:800;letter-spacing:-.02em}
    .bot-admin-assist{display:flex;gap:8px;align-items:center;min-width:170px}
    .bot-admin-assist b{display:block;font-size:12.5px;line-height:1.2}
    .bot-autosecure-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-top:10px}
    .bot-autosecure-grid div{display:flex;flex-direction:column;gap:1px;padding:8px;border:1px solid var(--border);border-radius:9px;background:var(--surface-2);min-width:0}
    .bot-autosecure-grid span{font-size:9px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted-2);font-weight:700}
    .bot-autosecure-grid b{font-size:12.5px;font-variant-numeric:tabular-nums}
    @media(max-width:560px){.bot-autosecure-grid{grid-template-columns:1fr 1fr}}
    .bot-tier{padding:12px;border:1px solid var(--border);border-radius:13px;background:var(--surface-2);display:flex;flex-direction:column;gap:2px}
    .bot-tier.owned{border-color:rgba(46,230,201,.38);background:linear-gradient(150deg,rgba(46,230,201,.07),var(--surface-2))}
    .bot-tier.disabled{opacity:.55}
    .bot-tier-name{font-size:13px;font-weight:750;letter-spacing:-.01em}
    .bot-acc{height:6px;border-radius:99px;background:rgba(255,255,255,.07);margin-top:10px;overflow:hidden}
    .bot-acc i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#2ee6c9,#3aa0ff)}
    .bot-tier-foot{display:flex;justify-content:space-between;align-items:flex-end;gap:8px;margin-top:12px}
    .bot-price{font-size:15px;font-weight:800;font-variant-numeric:tabular-nums}
    .bot-badge{display:inline-flex;align-items:center;gap:5px;font-size:9px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;
      padding:3px 8px;border-radius:99px;border:1px solid var(--border);color:var(--muted);white-space:nowrap}
    .bot-badge i{width:6px;height:6px;border-radius:50%;background:var(--muted);display:inline-block}
    .bot-badge.on{color:var(--success);border-color:rgba(34,197,94,.35);background:rgba(34,197,94,.10)}
    .bot-badge.on i{background:#22c55e;animation:wbotPulse 1.3s ease-in-out infinite}
    .bot-badge.paused{color:var(--warn);border-color:rgba(255,176,32,.35);background:rgba(255,176,32,.10)}
    .bot-badge.paused i{background:var(--warn)}
    @keyframes wbotPulse{0%,100%{opacity:.35;transform:scale(.8)}50%{opacity:1;transform:scale(1.25)}}
    .bot-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-top:11px}
    .bot-stats div{display:flex;flex-direction:column;gap:1px;padding:8px;border:1px solid var(--border);border-radius:9px;background:var(--surface)}
    .bot-stats span{font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-2);font-weight:700}
    .bot-stats b{font-size:12px;font-variant-numeric:tabular-nums}
    .bot-stats b.up{color:var(--success)} .bot-stats b.down{color:var(--danger)}
    .bot-perf{margin-top:10px;padding:9px 10px 6px;border:1px solid var(--border);border-radius:11px;background:var(--surface-2)}
    .bot-perf-svg{width:100%;height:142px;display:block;overflow:visible}
    .bot-perf-lbl{fill:#8ba4b6;font-size:8px;font-weight:700;letter-spacing:.05em;text-transform:uppercase}
    .bot-perf-val{fill:#e9f4f9;font-size:9px;font-weight:750;font-variant-numeric:tabular-nums}
    .bot-perf-axis{fill:#63798a;font-size:7.5px;font-variant-numeric:tabular-nums}
    .bot-poolbar{height:7px;border-radius:99px;background:rgba(255,255,255,.07);margin-top:10px;overflow:hidden}
    .bot-poolbar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#2ee6c9,#3aa0ff)}
    .bot-log{margin-top:12px;padding:10px;border:1px solid var(--border);border-radius:11px;background:var(--surface-2)}
    .bot-log-row{display:flex;align-items:center;gap:8px;padding:7px 0;border-top:1px solid var(--border)}
    .bot-log-row:first-of-type{border-top:none}
    .bot-log-row b{font-size:11.5px}
    .bot-log-row .up{color:var(--success);font-weight:700;font-size:11.5px;white-space:nowrap}
    .bot-log-row .down{color:var(--danger);font-weight:700;font-size:11.5px;white-space:nowrap}
    .bot-hist-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--border)}
    .bot-hist-row:first-of-type{border-top:none}
    .bot-hist-row b{font-size:11.5px} .bot-hist-row .up{color:var(--success)} .bot-hist-row .down{color:var(--danger)}
    .bot-disclaimer{display:flex;gap:7px;align-items:flex-start;margin-top:11px;padding:9px 10px;border-radius:9px;
      font-size:10.5px;line-height:1.6;color:var(--muted);background:rgba(255,176,32,.05);border:1px solid rgba(255,176,32,.16)}
    .bot-dash{display:block;margin:10px 0;text-decoration:none;color:inherit}
    .bot-dash-ic{width:32px;height:32px;border-radius:10px;display:flex;align-items:center;justify-content:center;
      background:rgba(46,230,201,.12);color:var(--accent);flex:none}
    .bot-admin-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin:12px 0}
    .bot-admin-stats div{display:flex;flex-direction:column;gap:1px;padding:8px;border:1px solid var(--border);border-radius:9px;background:var(--surface-2)}
    .bot-admin-stats span{font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-2);font-weight:700}
    .bot-admin-stats b{font-size:12px}
    .bot-admin-table td{padding:6px 8px}
    .bot-mini{height:30px;padding:3px 6px;font-size:11px;min-width:64px}
    .bot-admin-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:9px;margin-top:12px}
    @media(max-width:560px){.bot-grid{grid-template-columns:1fr}.bot-admin-table{font-size:10px}}
    `;
    document.head.appendChild(st);
  })();

  init();
})();
