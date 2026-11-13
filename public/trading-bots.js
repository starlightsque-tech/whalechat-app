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

  const CYCLE_TEXT = { daily: 'day', weekly: 'week', monthly: 'month', one_time: 'one-time' };
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
    return '<span class="bot-badge paused"><i></i> Paused</span>';
  }

  function tierCard(t) {
    const owned = !!t.owned;
    const cycle = cycleText(t.billingCycle);
    const disabled = t.enabled === false;
    return `<div class="bot-tier ${owned ? 'owned' : ''} ${disabled ? 'disabled' : ''}">
      <div class="between" style="align-items:flex-start;gap:8px">
        <div><div class="bot-tier-name">${escB(t.name)}</div>
          <div class="tiny muted" style="margin-top:2px">${escB(t.blurb || '')}</div></div>
        <span class="badge ${owned ? 'badge-success' : 'badge'}">${num(t.accuracy, 0)}%</span>
      </div>
      <div class="bot-acc"><i style="width:${Math.min(100, Math.max(0, Number(t.accuracy) || 0))}%"></i></div>
      <div class="tiny muted" style="margin-top:4px">Simulated trade accuracy</div>
      <div class="bot-tier-foot">
        <div>
          <div class="bot-price">${money(t.priceUsd)}<span class="tiny muted"> / ${cycle}</span></div>
          <div class="tiny muted">${num(t.priceCoins)} WC${t.intervalMin ? ' · every ' + t.intervalMin + ' min' : ''}</div>
        </div>
        ${owned
          ? `<span class="badge badge-success" style="white-space:nowrap">Owned</span>`
          : `<button class="btn btn-sm btn-primary" data-act="bot-subscribe" data-id="${escB(t.id)}" ${disabled ? 'disabled' : ''}>Subscribe</button>`}
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
      <text x="6" y="8" class="bot-perf-lbl">Allocated capital (WC)</text>
      <text x="${W - 6}" y="8" text-anchor="end" class="bot-perf-val">${fmt(pts[pts.length - 1].cap)} WC</text>
      <path d="${areaPath}" fill="url(#botCapFill)"/>
      <path d="${capPath}" fill="none" stroke="#2ee6c9" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
      <text x="6" y="${botY - 4}" class="bot-perf-lbl">Cumulative P/L (WC)</text>
      <text x="${W - 6}" y="${botY - 4}" text-anchor="end" class="bot-perf-val" style="fill:${pnlColor}">${lastPnl >= 0 ? '+' : '−'}${fmt(Math.abs(lastPnl))} WC</text>
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

  function sessionHTML(session) {
    if (!session) {
      const owned = (B.state && B.state.tiers || []).filter((t) => t.owned);
      return `<div class="card" id="botSessionCard">
        <div class="between"><div class="card-title" style="margin:0">Bot control</div>${statusBadge(null)}</div>
        ${owned.length ? `<div class="tiny muted" style="margin-top:6px;line-height:1.6">You own ${owned.length} bot tier${owned.length === 1 ? '' : 's'}. Allocate capital below and turn a bot on — it keeps trading while the app is closed.</div>
          <div class="field" style="margin-top:12px"><label class="label">Bot tier</label>
            <select class="input" id="botTier">${owned.map((t) => `<option value="${escB(t.id)}">${escB(t.name)} · ${num(t.accuracy, 0)}% accuracy</option>`).join('')}</select></div>
          <div class="field"><label class="label">Allocated trading capital (WC)</label>
            <div class="row" style="gap:6px">
              <input class="input grow" id="botAmount" type="number" min="0" step="0.01" placeholder="e.g. 100"/>
              <button class="btn btn-ghost btn-sm" data-act="bot-max">Max</button>
            </div>
            <div class="tiny muted" style="margin-top:4px">Available ${num(B.state.balance)} WC · reserved funds are locked from manual trading while the bot runs.</div></div>
          <button class="btn btn-primary" data-act="bot-start" style="width:100%">${typeof ic === 'function' ? ic('trend', 15) : ''} Turn On Bot</button>`
          : `<div class="tiny muted" style="margin-top:6px;line-height:1.6">Subscribe to a bot tier first. Your subscription unlocks the control panel and the automated trader.</div>`}
      </div>`;
    }
    const up = Number(session.profitCoins) >= 0;
    const pct = session.allocatedCoins > 0 ? Math.max(0, Math.min(150, (session.poolCoins / session.allocatedCoins) * 100)) : 0;
    return `<div class="card bot-live" id="botSessionCard">
      <div class="between" style="align-items:flex-start">
        <div><div class="card-title" style="margin:0">${escB(session.tierName)}</div>
          <div class="tiny muted" style="margin-top:2px">${session.tradeCount} automated trade${session.tradeCount === 1 ? '' : 's'} · every ${session.intervalMin} min</div></div>
        ${statusBadge(session)}
      </div>
      <div class="bot-stats">
        <div><span>Allocated capital</span><b data-bot-pool>${num(session.poolCoins)} WC</b></div>
        <div><span>Total P/L</span><b class="${up ? 'up' : 'down'}" data-bot-pnl>${up ? '+' : '−'}${num(Math.abs(session.profitCoins))} WC</b></div>
        <div><span>Wins / losses</span><b>${num(session.totalProfitCoins)} / ${num(session.totalLossCoins)} WC</b></div>
        <div><span>Next trade</span><b data-bot-next>${session.status === 'running' ? 'counting…' : '—'}</b></div>
      </div>
      <div class="bot-poolbar"><i style="width:${pct}%"></i></div>
      <div class="tiny muted" style="margin-top:4px">Started ${when(session.startedAt)} · initial allocation ${num(session.allocatedCoins)} WC</div>
      <div class="bot-perf">
        <div class="between" style="margin-bottom:4px"><b style="font-size:11.5px">Session performance</b>
          <span class="tiny muted">allocated capital · cumulative P/L</span></div>
        ${perfSVG(session)}
      </div>
      <div class="row" style="gap:8px;margin-top:12px">
        <button class="btn btn-danger grow" data-act="bot-stop">Stop Bot &amp; return capital</button>
        <button class="btn btn-ghost" data-act="bot-refresh">${typeof ic === 'function' ? ic('refresh', 14) : ''}</button>
      </div>
      <div class="bot-log">
        <div class="between" style="margin-bottom:6px"><b style="font-size:11.5px">Automated trade log</b>
          <span class="tiny muted">${session.trades.length ? 'latest first' : 'waiting for the first trade'}</span></div>
        ${session.trades.length ? session.trades.slice(0, 12).map((t) => `<div class="bot-log-row">
          <div class="grow" style="min-width:0"><b>${escB(t.ticker)}</b>
            <div class="tiny muted">${escB(t.side)} · stake ${num(t.stakeCoins)} WC · ${when(t.at)}</div></div>
          <span class="${t.win ? 'up' : 'down'}">${t.win ? '+' : '−'}${num(Math.abs(t.pnlCoins))} WC</span>
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
          <div style="text-align:right"><b class="${up ? 'up' : 'down'}">${up ? '+' : '−'}${num(Math.abs(s.profitCoins))} WC</b>
            <div class="tiny muted">${num(s.poolCoins)} WC returned</div></div>
        </div>`;
      }).join('')}
    </div>`;
  }

  function autoSecureHTML() {
    const a = (B.state && B.state.autoSecure) || { active: false, enabled: false, priceCoins: 40, billedAs: 'monthly', securedCount: 0, securedCoins: 0 };
    const on = a.active && a.enabled;
    return `<div class="card" id="botAutoCard">
      <div class="between" style="align-items:flex-start;gap:10px">
        <div><div class="card-title" style="margin:0">Auto Secure Take Profit</div>
          <div class="tiny muted" style="margin-top:3px">Bot tool · watches every active trade and locks available profit even while you are offline.</div></div>
        <span class="badge ${on ? 'badge-success' : a.active ? 'badge-warn' : ''}">${on ? 'ON' : a.active ? 'OFF' : 'Not subscribed'}</span>
      </div>
      <div class="bot-autosecure-grid">
        <div><span class="tiny muted">Secured profits</span><b><span data-bot-secured>${num(a.securedCoins)}</span> WC</b></div>
        <div><span class="tiny muted">Entries to claim</span><b data-bot-secured-count>${num(a.securedCount, 0)}</b></div>
        <div><span class="tiny muted">Tool price</span><b>${num(a.priceCoins)} WC / ${escB(a.billedAs || 'monthly')}</b></div>
        <div><span class="tiny muted">Expires</span><b>${a.expiresAt ? when(a.expiresAt) : '—'}</b></div>
      </div>
      <div class="tiny muted" style="margin-top:8px;line-height:1.6">
        When profit is available the bot secures it and re-bases the trade so it cannot be lost. Secured profit is <b>not credited automatically</b> —
        open <b>Orders</b> and press <b>Take profit</b> on each secured entry to add it to your balance.
      </div>
      <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
        ${a.active
          ? `<button class="btn btn-sm ${on ? 'btn-ghost' : 'btn-primary'}" data-act="bot-auto-toggle">${on ? 'Turn off auto secure' : 'Turn on auto secure'}</button>
             <button class="btn btn-sm btn-ghost" data-act="bot-auto-subscribe">Renew tool</button>`
          : `<button class="btn btn-sm btn-primary" data-act="bot-auto-subscribe">Subscribe · ${num(a.priceCoins)} WC / ${escB(a.billedAs || 'monthly')}</button>`}
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
      <div class="row" style="gap:8px"><span class="badge">${num(B.state.balance)} WC</span>
        <button class="btn btn-sm btn-ghost" data-act="bot-refresh">${ic('refresh', 14)} Refresh</button></div>
    </div></div>

    <div id="botSessionMount">${sessionHTML(B.state.session)}</div>

    ${autoSecureHTML()}

    <div class="card" id="botMarketCard">
      <div class="between"><div class="card-title" style="margin:0">Bot marketplace</div>
        <span class="tiny muted">Paid from your WC balance · ${B.state.coinsPerUsd} WC = $1</span></div>
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
    return `<a class="card bot-dash" href="#/invest/bots">
      <div class="between" style="align-items:flex-start">
        <div class="row" style="gap:9px;align-items:center">
          <span class="bot-dash-ic">${typeof ic === 'function' ? ic('trend', 16) : ''}</span>
          <div><div class="card-title" style="margin:0">Trading Bot Assistant</div>
            <div class="tiny muted">${running ? 'Bot running · ' + num(sess.poolCoins) + ' WC allocated' : (owned ? owned + ' tier' + (owned === 1 ? '' : 's') + ' owned · ready to configure' : 'Subscribe to an automated bot tier')}</div></div>
        </div>
        ${statusBadge(sess)}
      </div>
      ${s && s.autoSecure && s.autoSecure.active ? `<div class="tiny ${s.autoSecure.enabled ? 'up' : 'muted'}" style="margin-top:6px">
        ${s.autoSecure.enabled ? 'Auto Secure ON' : 'Auto Secure paused'} · <b data-bot-secured>${num(s.autoSecure.securedCoins)}</b> WC secured ·
        <span data-bot-secured-count>${s.autoSecure.securedCount}</span> to claim
      </div>` : ''}
      ${running ? `<div class="row" style="gap:8px;margin-top:7px;flex-wrap:wrap">
        <span class="tiny ${Number(sess.profitCoins) >= 0 ? 'up' : 'down'}"><b>${Number(sess.profitCoins) >= 0 ? '+' : '−'}${num(Math.abs(Number(sess.profitCoins) || 0))} WC</b> bot P/L</span>
        <span class="tiny muted">${num(sess.tradeCount)} trade${Number(sess.tradeCount) === 1 ? '' : 's'}</span>
        ${sess.trades && sess.trades.length ? `<span class="tiny muted">last ${escB(sess.trades[0].ticker || '')} <b class="${Number(sess.trades[0].pnlCoins) >= 0 ? 'up' : 'down'}">${Number(sess.trades[0].pnlCoins) >= 0 ? '+' : '−'}${num(Math.abs(Number(sess.trades[0].pnlCoins) || 0))} WC</b></span>` : ''}
      </div>` : ''}
      <div class="tiny" style="margin-top:8px;color:var(--accent);font-weight:650">Open Trading Bots →</div>
    </a>`;
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

  function adminBodyHTML(a) {
    if (!a) return '<div class="tiny muted" style="margin-top:10px">Could not load bot configuration.</div>';
    const s = a.settings || {};
    const intervals = [[1, 'Every minute'], [5, 'Every 5 minutes'], [15, 'Every 15 minutes'], [30, 'Every 30 minutes'], [60, 'Hourly'], [240, 'Every 4 hours'], [1440, 'Daily']];
    return `<div class="bot-admin-stats">
        <div><span>Active subscriptions</span><b>${a.stats.subscriptions}</b></div>
        <div><span>Running bots</span><b>${a.stats.running}</b></div>
        <div><span>Reserved capital</span><b>${num(a.stats.reservedCoins)} WC</b></div>
        <div><span>Subscription revenue</span><b>${num(a.stats.revenueCoins)} WC</b></div>
      </div>
      <div class="table-wrap"><table class="tbl bot-admin-table"><thead><tr><th>Tier</th><th>Accuracy %</th><th>Price (USD)</th><th>Billing cycle</th><th>Speed override (min)</th><th>Live</th></tr></thead><tbody>
        ${a.tiers.map((t) => `<tr data-bot-tier="${escB(t.id)}">
          <td style="font-weight:650">${escB(t.name)}<div class="tiny muted">${num(t.priceUsd * 2)} WC</div></td>
          <td><input class="input bot-mini" data-f="accuracy" type="number" min="1" max="100" step="1" value="${t.accuracy}"/></td>
          <td><input class="input bot-mini" data-f="priceUsd" type="number" min="0" step="0.01" value="${t.priceUsd}"/></td>
          <td><select class="input bot-mini" data-f="billingCycle">
            ${['daily', 'weekly', 'monthly', 'one_time'].map((c) => `<option value="${c}" ${t.billingCycle === c ? 'selected' : ''}>${c.replace('_', '-')}</option>`).join('')}
          </select></td>
          <td><input class="input bot-mini" data-f="intervalMin" type="number" min="0" max="10080" step="1" value="${Number(t.intervalMin) || 0}" placeholder="global"/></td>
          <td><label class="checkline" style="margin:0"><input type="checkbox" data-f="enabled" ${t.enabled !== false ? 'checked' : ''}/></label></td>
        </tr>`).join('')}
      </tbody></table></div>
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
        <div class="field"><label class="label">Gain on a win (% of stake)</label>
          <input class="input" id="botCfgWin" type="number" min="0.1" step="0.1" value="${s.winPct}"/></div>
        <div class="field"><label class="label">Loss on a loss (% of stake)</label>
          <input class="input" id="botCfgLoss" type="number" min="0.1" step="0.1" value="${s.lossPct}"/></div>
        <div class="field"><label class="label">Auto Secure price (USD)</label>
          <input class="input" id="botCfgAutoPrice" type="number" min="0" step="0.01" value="${Number((a.autoSecure || {}).priceUsd != null ? a.autoSecure.priceUsd : s.autoSecurePriceUsd) || 20}"/>
          <div class="tiny muted" style="margin-top:4px">Charged as ${num((Number((a.autoSecure || {}).priceUsd) || Number(s.autoSecurePriceUsd) || 20) * 2)} WC (1 WC = $0.50).</div></div>
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

    App.botSubscribe = async function (id) {
      const t = (B.state && B.state.tiers || []).find((x) => x.id === id);
      if (!t) return tmsg('Bot tier not found', 'err');
      if (typeof Remote === 'undefined' || !Remote.enabled) return tmsg('Connect the sync server to subscribe', 'err');
      if (typeof confirmDialog === 'function') {
        const ok = await confirmDialog({
          title: 'Subscribe to ' + t.name + '?',
          body: `${num(t.priceCoins)} WC (${money(t.priceUsd)} / ${cycleText(t.billingCycle)}) will be deducted from your balance. Simulated accuracy: ${num(t.accuracy, 0)}%.`,
          ok: 'Subscribe'
        });
        if (!ok) return;
      }
      try {
        const r = await api('/api/bots/subscribe', { method: 'POST', body: JSON.stringify({ userId: uidNow(), tierId: id }) }, 25000);
        if (!r.res || !r.res.ok || !r.data || !r.data.ok) return tmsg((r.data && r.data.error) || 'Subscription failed', 'err');
        await Remote.refresh(true);
        await load(true);
        tmsg(t.name + ' unlocked — allocate capital to start it', 'ok');
        render();
      } catch (e) { tmsg('Subscription failed: ' + e.message, 'err'); }
    };

    App.botMax = function () {
      const el = document.getElementById('botAmount');
      if (el && B.state) { el.value = num(B.state.balance); el.focus(); }
    };

    App.botStart = async function () {
      if (typeof Remote === 'undefined' || !Remote.enabled) return tmsg('Connect the sync server to start the bot', 'err');
      const tierEl = document.getElementById('botTier');
      const amtEl = document.getElementById('botAmount');
      const tierId = tierEl ? tierEl.value : '';
      const amount = Number(amtEl && amtEl.value) || 0;
      if (!(amount > 0)) return tmsg('Enter the capital the bot may trade with', 'err');
      if (B.state && amount > Number(B.state.balance)) return tmsg('Allocation exceeds your available balance', 'err');
      if (typeof confirmDialog === 'function') {
        const ok = await confirmDialog({
          title: 'Turn on the bot?',
          body: `${num(amount)} WC will be reserved and locked from manual trading. The bot trades automatically every ${(B.state.settings || {}).intervalMin || 5} minutes.`,
          ok: 'Turn On Bot'
        });
        if (!ok) return;
      }
      try {
        const r = await api('/api/bots/start', { method: 'POST', body: JSON.stringify({ userId: uidNow(), tierId, allocatedCoins: amount }) }, 25000);
        if (!r.res || !r.res.ok || !r.data || !r.data.ok) return tmsg((r.data && r.data.error) || 'Could not start bot', 'err');
        await Remote.refresh(true);
        await load(true);
        tmsg('Bot running — it trades even when the app is closed', 'ok');
        render();
      } catch (e) { tmsg('Could not start bot: ' + e.message, 'err'); }
    };

    App.botStop = async function () {
      if (typeof Remote === 'undefined' || !Remote.enabled) return tmsg('Connect the sync server to stop the bot', 'err');
      if (typeof confirmDialog === 'function') {
        const ok = await confirmDialog({
          title: 'Stop the bot?',
          body: 'Automated trading will stop immediately and the remaining allocated capital (plus profit or minus loss) returns to your available balance.',
          ok: 'Stop Bot', danger: true
        });
        if (!ok) return;
      }
      try {
        const r = await api('/api/bots/stop', { method: 'POST', body: JSON.stringify({ userId: uidNow() }) }, 25000);
        if (!r.res || !r.res.ok || !r.data || !r.data.ok) return tmsg((r.data && r.data.error) || 'Could not stop bot', 'err');
        await Remote.refresh(true);
        await load(true);
        tmsg(num(r.data.returnedCoins) + ' WC returned to your balance', 'ok');
        render();
      } catch (e) { tmsg('Could not stop bot: ' + e.message, 'err'); }
    };

    App.botAutoSubscribe = async function () {
      if (typeof Remote === 'undefined' || !Remote.enabled) return tmsg('Connect the sync server to subscribe', 'err');
      const a = (B.state && B.state.autoSecure) || {};
      if (typeof confirmDialog === 'function') {
        const ok = await confirmDialog({
          title: 'Subscribe to Auto Secure Take Profit?',
          body: `${num(a.priceCoins)} WC will be deducted from your balance (${money(a.priceUsd)} / ${escB(a.billedAs || 'monthly')}). The bot will secure profit on your active trades even while you are offline.`,
          ok: 'Subscribe'
        });
        if (!ok) return;
      }
      try {
        const r = await api('/api/bots/auto-secure/subscribe', { method: 'POST', body: JSON.stringify({ userId: uidNow() }) }, 25000);
        if (!r.res || !r.res.ok || !r.data || !r.data.ok) return tmsg((r.data && r.data.error) || 'Subscription failed', 'err');
        await Remote.refresh(true);
        await load(true);
        tmsg('Auto Secure is ON — available profit will be secured for you', 'ok');
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

    App.botAdminSave = async function () {
      if (!isAdmin()) return tmsg('Admin only', 'err');
      const tiers = [];
      document.querySelectorAll('[data-bot-tier]').forEach((row) => {
        const get = (f) => row.querySelector('[data-f="' + f + '"]');
        tiers.push({
          id: row.getAttribute('data-bot-tier'),
          accuracy: Number(get('accuracy').value),
          priceUsd: Number(get('priceUsd').value),
          billingCycle: get('billingCycle').value,
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
    if (pool && B.state) pool.textContent = num(s.poolCoins) + ' WC';
  }

  function paintAutoSecure() {
    const a = B.state && B.state.autoSecure;
    if (!a) return;
    document.querySelectorAll('[data-bot-secured]').forEach((el) => { el.textContent = num(a.securedCoins); });
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
