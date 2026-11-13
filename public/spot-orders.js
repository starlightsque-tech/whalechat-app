/* =========================================================================
   WhaleChat spot orders — buy at the live Finnhub price
   On close the backend pays the admin-configured profit rate for the stock.
   Live prices are display-only and drive TP/SL triggers. TP/SL execution is
   atomic and server-side, so it works even when every app is closed.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  const S = window.WC_SPOT = window.WC_SPOT || {};
  S.mode = 'wc';
  S.ticker = '';

  function adminPct(t) {
    const s = (typeof INV !== 'undefined' && INV.stock) ? INV.stock(t) : null;
    if (!s) return 0;
    /* per-stock override, or the market-type rate set by the admin */
    if (typeof INV.effectiveProfitPct === 'function') return INV.effectiveProfitPct(s) || 0;
    const n = Number(s.profitPct);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  function lockedRate(h, t) {
    const n = Number(h && h.profitPct);
    if (Number.isFinite(n) && n >= 0) return n;
    return adminPct(t);
  }
  function payoutFor(invested, rate, gain) {
    const basis = Math.max(0, Number(invested) || 0);
    const g = Number(gain) || 0;
    const base = Math.max(0, basis + g);
    const profit = Math.round(base * (Math.max(0, Number(rate) || 0) / 100) * 100) / 100;
    return { gain: g, base, profit, payout: Math.round((basis + profit) * 100) / 100 };
  }

  S.preview = function () {
    const el = document.getElementById('spotAmount');
    const pv = document.getElementById('spotPreview');
    if (!el || !pv) return;
    const q = qFor(S.ticker);
    if (!q || !(q.price > 0)) { pv.textContent = 'Waiting for a live Finnhub quote…'; return; }
    const live = Number(q.price);
    const pct = adminPct(S.ticker);
    const v = Number(el.value) || 0;
    let shares = 0, cost = 0, usdAmt = 0;
    if (S.mode === 'usd') { usdAmt = v; shares = v / live; cost = v / 0.5; }
    else if (S.mode === 'wc') { cost = v; usdAmt = v * 0.5; shares = usdAmt / live; }
    else { shares = v; usdAmt = shares * live; cost = usdAmt / 0.5; }
    const out = payoutFor(cost, pct, 0);
    pv.innerHTML = `<b>${usdAmt.toLocaleString(undefined, { style: 'currency', currency: 'USD' })}</b> = <b>${cost.toFixed(2)} WC</b> · ${shares.toLocaleString(undefined, { maximumFractionDigits: 6 })} shares · live ${px(S.ticker, live)} · closes at <b>+${pct}%</b> of capital + gain · payout now <b>${out.payout.toFixed(2)} WC</b>`;
  };

  function ticketHTML(ticker) {
    const s = INV.stock(ticker);
    const q = qFor(ticker);
    const h = holdingFor(ticker);
    if (!s) return '';
    const live = q ? Number(q.price) : 0;
    const pct = adminPct(ticker);
    const tpHint = live > 0 ? (live * 1.05).toFixed(4) : 'price';
    const slHint = live > 0 ? (live * 0.95).toFixed(4) : 'price';
    return `<div class="card" id="spotTicketCard">
      <div class="between" style="align-items:flex-start;gap:10px">
        <div><div class="card-title" style="margin:0">Spot · buy ${escSpot(label(ticker))}</div>
          <div class="tiny muted" style="margin-top:2px">Live Finnhub market ${live > 0 ? px(ticker, live) + ' (' + (live * 2).toFixed(2) + ' WC)' : 'waiting for quote'} · closes at <b>+${pct}%</b> of capital + market gain</div></div>
        <span class="badge badge-success">Spot</span>
      </div>
      <div class="lt-modebtns" style="margin-top:11px">
        <button type="button" class="${S.mode === 'wc' ? 'on' : ''}" data-act="spot-mode" data-mode="wc">Invest WC</button>
        <button type="button" class="${S.mode === 'usd' ? 'on' : ''}" data-act="spot-mode" data-mode="usd">Invest USD</button>
        <button type="button" class="${S.mode === 'shares' ? 'on' : ''}" data-act="spot-mode" data-mode="shares">Shares</button>
      </div>
      <div class="field" style="margin-top:9px"><label class="label" id="spotAmountLabel">${S.mode === 'usd' ? 'Investment amount (USD)' : S.mode === 'wc' ? 'Investment amount (WC)' : 'Number of shares'}</label>
        <div class="input-wrap"><span class="inv-prefix" id="spotPrefix">${S.mode === 'usd' ? '$' : S.mode === 'wc' ? 'WC' : 'sh'}</span>
          <input class="input" id="spotAmount" type="number" step="0.01" min="0" placeholder="0"/></div>
        <div class="tiny muted" id="spotPreview" style="margin-top:5px">Enter a WC amount or a share quantity — the total is deducted from your wallet immediately.</div>
      </div>
      <div class="row" style="gap:8px;align-items:flex-start">
        <div class="field grow">
          <label class="label between" style="gap:6px"><span>Take Profit</span>
            <span class="tiny muted" style="display:flex;gap:4px;align-items:center">on <input type="checkbox" id="spotTpOn" checked style="accent-color:var(--accent)"/></span></label>
          <input class="input" id="spotTp" type="number" step="0.01" min="0" placeholder="${tpHint}" disabled/>
        </div>
        <div class="field grow">
          <label class="label between" style="gap:6px"><span>Stop Loss</span>
            <span class="tiny muted" style="display:flex;gap:4px;align-items:center">on <input type="checkbox" id="spotSlOn" checked style="accent-color:var(--accent)"/></span></label>
          <input class="input" id="spotSl" type="number" step="0.01" min="0" placeholder="${slHint}" disabled/>
        </div>
      </div>
      <div class="tiny muted" style="margin:-2px 0 10px;line-height:1.55">Tick TP / SL to enter a target. The backend checks every open position once per second against the live market; when a level is hit it closes the position and pays the locked admin profit rate. Live prices are display and trigger only.</div>
      <button class="btn btn-primary" data-act="spot-buy" style="width:100%">${typeof ic === 'function' ? ic('trend', 15) : ''} Buy ${escSpot(label(ticker))} · ${pct}% locked profit</button>
      ${h ? positionHTML(ticker, h, q) : ''}
    </div>`;
  }

  function positionHTML(ticker, h, q) {
    const shares = Number(h.shares) || 0;
    const avg = Number(h.avgPrice) || 0;
    const price = q && q.price > 0 ? Number(q.price) : avg;
    const invested = Number(h.investedCoins) || ((shares * avg) / 0.5);
    const rate = lockedRate(h, ticker);
    const gain = (shares * (price - avg)) / 0.5;
    const out = payoutFor(invested, rate, gain);
    const marketValue = (shares * price) / 0.5;
    return `<div class="spot-position" id="spotPosition" data-spot="${ticker}">
      <div class="between"><div class="card-title" style="margin:0">Your open position</div>
        <span class="badge badge-success">+${out.profit.toFixed(2)} WC locked</span></div>
      <div class="spot-grid">
        <div><span>Symbol</span><b>${escSpot(label(ticker))}</b></div>
        <div><span>Quantity</span><b data-spot-qty>${shares.toLocaleString(undefined, { maximumFractionDigits: 6 })}</b></div>
        <div><span>Entry price</span><b data-spot-entry>${px(ticker, avg)}</b></div>
        <div><span>Live market</span><b data-spot-market>${px(ticker, price)}</b></div>
        <div><span>Invested</span><b data-spot-invested>${invested.toFixed(2)} WC <span class="tiny muted">(${((Number(h.investedUsd) || invested * 0.5)).toFixed(2)} USD)</span></b></div>
        <div><span>Market value (display)</span><b data-spot-value>${marketValue.toFixed(2)} WC</b></div>
        <div><span>Market gain</span><b class="${gain >= 0 ? 'up' : 'down'}" data-spot-gain>${gain >= 0 ? '+' : '−'}${Math.abs(gain).toFixed(2)} WC</b></div>
        <div><span>Payout on close</span><b class="up" data-spot-payout>${out.payout.toFixed(2)} WC</b></div>
        <div><span>Profit on close</span><b class="up" data-spot-pnl>+${out.profit.toFixed(2)} WC <span class="tiny">(${rate}% of ${(out.base).toFixed(2)})</span></b></div>
        <div><span>Take Profit</span><b data-spot-tp>${Number(h.takeProfitPrice) > 0 ? px(ticker, h.takeProfitPrice) : '—'}</b></div>
        <div><span>Stop Loss</span><b data-spot-sl>${Number(h.stopLossPrice) > 0 ? px(ticker, h.stopLossPrice) : '—'}</b></div>
      </div>
      <div class="row" style="gap:7px;margin-top:9px">
        <button class="btn btn-danger grow" data-act="spot-sell" data-t="${escSpot(ticker)}">Sell now · close position</button>
        <button class="btn btn-ghost grow" data-act="spot-toggle-tpsl" data-t="${escSpot(ticker)}">TP / SL</button>
      </div>
      <div class="spot-tpsl-edit" id="spotTpSlEditor" hidden data-t="${escSpot(ticker)}">
        <div class="row" style="gap:8px">
          <div class="field grow" style="margin:0">
            <label class="label between" style="gap:6px"><span>Take Profit price</span>
              <span class="tiny muted" style="display:flex;gap:4px;align-items:center">on <input type="checkbox" id="spotPosTpOn" ${Number(h.takeProfitPrice) > 0 ? 'checked' : ''} style="accent-color:var(--accent)"/></span></label>
            <input class="input" id="spotInlineTp" type="number" step="0.01" min="0" value="${Number(h.takeProfitPrice) > 0 ? h.takeProfitPrice : ''}" placeholder="optional" ${Number(h.takeProfitPrice) > 0 ? '' : 'disabled'}/></div>
          <div class="field grow" style="margin:0">
            <label class="label between" style="gap:6px"><span>Stop Loss price</span>
              <span class="tiny muted" style="display:flex;gap:4px;align-items:center">on <input type="checkbox" id="spotPosSlOn" ${Number(h.stopLossPrice) > 0 ? 'checked' : ''} style="accent-color:var(--accent)"/></span></label>
            <input class="input" id="spotInlineSl" type="number" step="0.01" min="0" value="${Number(h.stopLossPrice) > 0 ? h.stopLossPrice : ''}" placeholder="optional" ${Number(h.stopLossPrice) > 0 ? '' : 'disabled'}/></div>
        </div>
        <div class="row" style="gap:8px;margin-top:8px">
          <button class="btn btn-sm btn-primary grow" data-act="spot-save-tpsl" data-t="${escSpot(ticker)}">Save TP / SL</button>
          <button class="btn btn-sm btn-ghost" data-act="spot-clear-tpsl" data-t="${escSpot(ticker)}">Clear</button>
        </div>
        <div class="tiny muted" style="margin-top:5px">TP must be above the current market price, SL below. When either level is hit the backend closes the position and pays the locked admin profit rate — even with the app closed.</div>
      </div>
      <div class="tiny muted center" style="margin-top:5px">Payout = capital + (capital + market gain) × ${rate}% profit · credited instantly</div>
    </div>`;
  }

  function spotHistoryHTML(limit) {
    const u = (typeof me === 'function') ? me() : null;
    if (!u) return '';
    const rows = (DB.trades || []).filter((t) => t && t.userId === u.id && t.type === 'spot' && t.status === 'Completed')
      .sort((a, b) => (b.closedAt || b.createdAt || 0) - (a.closedAt || a.createdAt || 0))
      .slice(0, limit || 6);
    if (!rows.length) return '';
    return `<div class="card" id="spotHistoryCard">
      <div class="between"><div class="card-title" style="margin:0">Order history</div>
        <a href="#/invest/orders" class="tiny link">View all</a></div>
      <div class="inv-list">${rows.map((t) => {
        const live = Number(t.marketPriceUsd) || Number(t.priceUsd) || 0;
        const pl = Number(t.plCoins) || 0;
        const isSell = t.side === 'sell';
        return `<div class="inv-row" style="align-items:flex-start">
          <div class="grow" style="min-width:0">
            <div class="small" style="font-weight:650">${isSell ? 'Sell' : 'Buy'} ${escSpot(t.ticker)}
              <span class="tiny muted">· ${escSpot(t.closeReason || 'Filled')}</span></div>
            <div class="tiny muted">${(Number(t.shares) || 0).toLocaleString(undefined, { maximumFractionDigits: 6 })} sh @ ${usd(t.priceUsd)}${isSell ? ' · market ' + usd(live) : ''}</div>
          </div>
          <div style="text-align:right">
            <div class="tiny ${isSell ? (pl >= 0 ? 'up' : 'down') : 'muted'}">${isSell ? (pl >= 0 ? '+' : '−') + Math.abs(pl).toFixed(2) + ' WC' : '−' + (Number(t.coins) || 0).toFixed(2) + ' WC'}</div>
            <div class="tiny muted">${new Date(t.closedAt || t.createdAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
          </div></div>`;
      }).join('')}</div>
    </div>`;
  }

  function mountStock() {
    const m = (location.hash || '').match(/^#\/invest\/stock\/([A-Z0-9._]+)/i);
    if (!m) return;
    S.ticker = m[1].toUpperCase();
    const content = document.getElementById('content');
    const host = document.getElementById('ltTicketMount');
    if (!content) return;
    try {
      const st = INV.stock(S.ticker);
      const admin = me() && me().role === 'admin';
      if (st && INV.classEnabled && INV.classOf && !INV.classEnabled(INV.classOf(st)) && !admin) return;
    } catch (e) {}
    if (document.getElementById('spotTicketCard')) { S.paint(); return; }
    /* keep the Rise / Fall ticket — spot investing is an additional flow */
    const box = document.createElement('div');
    box.id = 'spotTicketHost';
    box.innerHTML = ticketHTML(S.ticker) + spotHistoryHTML(4);
    if (host && host.parentNode) host.parentNode.insertBefore(box, host);
    else content.insertBefore(box, content.firstChild);
    const amt = document.getElementById('spotAmount');
    if (amt) amt.addEventListener('input', S.preview);
    ['spotTpOn', 'spotSlOn'].forEach((id) => {
      const cb = document.getElementById(id);
      const input = document.getElementById(id === 'spotTpOn' ? 'spotTp' : 'spotSl');
      if (!cb || !input) return;
      const sync = () => { input.disabled = !cb.checked; if (!cb.checked) input.value = ''; };
      cb.addEventListener('change', sync);
      sync();
    });
    S.preview();
  }

  function allPositionsHTML() {
    let hs = [];
    try { hs = INV.holdings(me().id); } catch (e) {}
    if (!hs.length) return '';
    return `<div class="card" id="spotPositionsCard">
      <div class="between"><div class="card-title" style="margin:0">Spot positions</div>
        <span class="tiny muted">${hs.length} open</span></div>
      ${hs.map((h) => {
        const q = qFor(h.ticker);
        const rate = lockedRate(h, h.ticker);
        const invested = Number(h.investedCoins) || ((Number(h.shares) || 0) * (Number(h.avgPrice) || 0)) / 0.5;
        const hp = Number((q && q.price) || h.avgPrice);
        const hg = ((Number(h.shares) || 0) * (hp - (Number(h.avgPrice) || 0))) / 0.5;
        const out = payoutFor(invested, rate, hg);
        return `<div class="spot-row" data-spot-row="${escSpot(h.ticker)}">
          <div class="grow" style="min-width:0"><b>${escSpot(label(h.ticker))}</b>
            <div class="tiny muted">${Number(h.shares).toLocaleString(undefined, { maximumFractionDigits: 6 })} shares · live ${px(h.ticker, (q && q.price) || h.avgPrice)}</div>
            <div class="tiny up">Payout ${out.payout.toFixed(2)} WC · +${out.profit.toFixed(2)} profit</div></div>
          <button class="btn btn-sm btn-danger" data-act="spot-sell" data-t="${escSpot(h.ticker)}">Sell</button>
          <button class="btn btn-sm btn-ghost" data-act="spot-edit" data-t="${escSpot(h.ticker)}">TP/SL</button>
        </div>`;
      }).join('')}
    </div>`;
  }

  function mountDashboard() {
    if (!document.querySelector('.inv-hero')) return;
    const hasPos = document.getElementById('spotPositionsCard');
    const hasHist = document.getElementById('spotHistoryCard');
    if (hasPos && hasHist) return;
    const html = (hasPos ? '' : allPositionsHTML()) + (hasHist ? '' : spotHistoryHTML(6));
    if (!html) return;
    const host = document.createElement('div');
    host.id = 'spotPositionsHost';
    host.innerHTML = html;
    const anchor = document.querySelector('.inv-actions');
    const chart = document.querySelector('.inv-chartcard');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(host, anchor.nextSibling);
    else if (chart && chart.parentNode) chart.parentNode.insertBefore(host, chart);
    else document.getElementById('content').appendChild(host);
  }

  S.paint = function () {
    const el = document.getElementById('spotPosition');
    if (!el) return;
    const h = holdingFor(S.ticker); if (!h) return;
    const q = qFor(S.ticker); if (!q) return;
    const shares = Number(h.shares) || 0, avg = Number(h.avgPrice) || 0;
    const price = Number(q.price) || avg;
    const invested = Number(h.investedCoins) || (shares * avg / 0.5);
    const rate = lockedRate(h, S.ticker);
    const gain = shares * (price - avg) / 0.5;
    const out = payoutFor(invested, rate, gain);
    const marketValue = shares * price / 0.5;
    const set = (sel, txt) => { const n = el.querySelector(sel); if (n) n.textContent = txt; };
    set('[data-spot-qty]', shares.toLocaleString(undefined, { maximumFractionDigits: 6 }));
    set('[data-spot-entry]', px(S.ticker, avg));
    set('[data-spot-market]', px(S.ticker, price));
    set('[data-spot-invested]', invested.toFixed(2) + ' WC ($' + (invested * 0.5).toFixed(2) + ')');
    set('[data-spot-value]', marketValue.toFixed(2) + ' WC');
    set('[data-spot-payout]', out.payout.toFixed(2) + ' WC');
    const gn = el.querySelector('[data-spot-gain]');
    if (gn) { gn.textContent = (gain >= 0 ? '+' : '−') + Math.abs(gain).toFixed(2) + ' WC'; gn.className = gain >= 0 ? 'up' : 'down'; }
    const pn = el.querySelector('[data-spot-pnl]');
    if (pn) { pn.textContent = '+' + out.profit.toFixed(2) + ' WC (' + rate + '% of ' + out.base.toFixed(2) + ')'; pn.className = 'up'; }
  };

  if (typeof App !== 'undefined') {
    App.spotMode = function (id, ds) {
      S.mode = ds.mode === 'shares' ? 'shares' : ds.mode === 'wc' ? 'wc' : 'usd';
      document.querySelectorAll('[data-act="spot-mode"]').forEach((b) => b.classList.toggle('on', b.getAttribute('data-mode') === S.mode));
      const pre = document.getElementById('spotPrefix'); if (pre) pre.textContent = S.mode === 'usd' ? '$' : S.mode === 'wc' ? 'WC' : 'sh';
      const lab = document.getElementById('spotAmountLabel'); if (lab) lab.textContent = S.mode === 'usd' ? 'Investment amount (USD)' : S.mode === 'wc' ? 'Investment amount (WC)' : 'Number of shares';
      S.preview();
    };

    App.spotBuy = async function () {
      if (typeof Remote === 'undefined' || !Remote.enabled) return tmsg('Connect the sync server to place spot orders', 'err');
      const amt = Number((document.getElementById('spotAmount') || {}).value) || 0;
      if (!(amt > 0)) return tmsg('Enter an amount or quantity', 'err');
      const tp = Number((document.getElementById('spotTp') || {}).value) || 0;
      const sl = Number((document.getElementById('spotSl') || {}).value) || 0;
      const body = { userId: me().id, ticker: S.ticker, tpPrice: tp, slPrice: sl };
      if (S.mode === 'usd') body.amountUsd = amt;
      else if (S.mode === 'wc') body.amountCoins = amt;
      else body.shares = amt;
      try {
        const r = await apiJSON('/api/market/spot/buy', { method: 'POST', body: JSON.stringify(body) }, 25000);
        if (!r.res || !r.res.ok || !r.data || !r.data.ok) return tmsg((r.data && r.data.error) || 'Buy failed', 'err');
        await Remote.refresh(true);
        tmsg('Bought ' + Number(r.data.order.shares).toLocaleString(undefined, { maximumFractionDigits: 6 }) + ' ' + label(S.ticker), 'ok');
        render();
      } catch (e) { tmsg('Buy failed: ' + e.message, 'err'); }
    };

    App.spotSell = async function (id, ds) {
      if (typeof Remote === 'undefined' || !Remote.enabled) return tmsg('Connect the sync server to sell', 'err');
      const ticker = ds.t || S.ticker;
      const h = holdingFor(ticker);
      if (!h) return tmsg('No open position', 'err');
      if (typeof confirmDialog === 'function') {
        const ok = await confirmDialog({ title: 'Sell ' + label(ticker) + '?', body: `Sell ${Number(h.shares).toLocaleString(undefined, { maximumFractionDigits: 6 })} shares at the current live price?`, ok: 'Sell now', danger: true });
        if (!ok) return;
      }
      try {
        const r = await apiJSON('/api/market/spot/sell', { method: 'POST', body: JSON.stringify({ userId: me().id, ticker }) }, 25000);
        if (!r.res || !r.res.ok || !r.data || !r.data.ok) return tmsg((r.data && r.data.error) || 'Sell failed', 'err');
        await Remote.refresh(true);
        tmsg('Sold · ' + Number(r.data.payout).toFixed(2) + ' WC ($' + Number(r.data.payout * 0.5).toFixed(2) + ') credited', 'ok');
        render();
      } catch (e) { tmsg('Sell failed: ' + e.message, 'err'); }
    };

    App.spotSaveTpsl = async function (id, ds) {
      const ticker = ds.t || S.ticker;
      const tpOn = document.getElementById('spotPosTpOn');
      const slOn = document.getElementById('spotPosSlOn');
      const tp = (tpOn && !tpOn.checked) ? 0 : Number((document.getElementById('spotInlineTp') || {}).value) || 0;
      const sl = (slOn && !slOn.checked) ? 0 : Number((document.getElementById('spotInlineSl') || {}).value) || 0;
      try {
        const r = await apiJSON('/api/market/spot/tpsl', { method: 'POST', body: JSON.stringify({ userId: me().id, ticker, tpPrice: tp, slPrice: sl }) }, 20000);
        if (!r.res || !r.res.ok || !r.data || !r.data.ok) return tmsg((r.data && r.data.error) || 'Update failed', 'err');
        await Remote.refresh(true); tmsg('TP / SL updated', 'ok'); render();
      } catch (e) { tmsg('Update failed: ' + e.message, 'err'); }
    };

    App.spotClearTpsl = function (id, ds) {
      const ed = document.getElementById('spotTpSlEditor');
      if (!ed) return;
      const tp = document.getElementById('spotInlineTp');
      const sl = document.getElementById('spotInlineSl');
      if (tp) tp.value = ''; if (sl) sl.value = '';
      App.spotSaveTpsl(id, ds);
    };

    App.spotToggleTpsl = function () {
      const ed = document.getElementById('spotTpSlEditor');
      if (!ed) return;
      ed.hidden = !ed.hidden;
      if (ed.hidden) return;
      [['spotPosTpOn', 'spotInlineTp'], ['spotPosSlOn', 'spotInlineSl']].forEach(([cbId, inId]) => {
        const cb = document.getElementById(cbId);
        const input = document.getElementById(inId);
        if (!cb || !input) return;
        const sync = () => { input.disabled = !cb.checked; if (!cb.checked) input.value = ''; };
        if (!cb.__spBound) { cb.addEventListener('change', sync); cb.__spBound = true; }
        sync();
      });
      const i = document.getElementById('spotInlineTp'); if (i && !i.disabled) i.focus();
    };

    App.spotEdit = function (id, ds) {
      const ticker = ds.t || S.ticker;
      const h = holdingFor(ticker); if (!h) return tmsg('No open position', 'err');
      const q = qFor(ticker);
      openModal(modalShell('TP / SL · ' + label(ticker), `
        <div class="tiny muted" style="margin-bottom:10px">Live price ${q ? px(ticker, q.price) : '—'}. TP must be above, SL below.</div>
        <div class="field"><label class="label between"><span>Take Profit price</span>
            <span class="tiny muted" style="display:flex;gap:4px;align-items:center">on <input type="checkbox" id="spotEditTpOn" ${Number(h.takeProfitPrice) > 0 ? 'checked' : ''} style="accent-color:var(--accent)"/></span></label>
          <input class="input" id="spotEditTp" type="number" step="0.01" value="${Number(h.takeProfitPrice) > 0 ? h.takeProfitPrice : ''}" placeholder="optional" ${Number(h.takeProfitPrice) > 0 ? '' : 'disabled'}/></div>
        <div class="field"><label class="label between"><span>Stop Loss price</span>
            <span class="tiny muted" style="display:flex;gap:4px;align-items:center">on <input type="checkbox" id="spotEditSlOn" ${Number(h.stopLossPrice) > 0 ? 'checked' : ''} style="accent-color:var(--accent)"/></span></label>
          <input class="input" id="spotEditSl" type="number" step="0.01" value="${Number(h.stopLossPrice) > 0 ? h.stopLossPrice : ''}" placeholder="optional" ${Number(h.stopLossPrice) > 0 ? '' : 'disabled'}/></div>`,
        `<button class="btn btn-ghost" data-close style="flex:1">Cancel</button>
         <button class="btn btn-primary" id="spotTpSave" style="flex:1">Save</button>`), { locked: false });
      [['spotEditTpOn', 'spotEditTp'], ['spotEditSlOn', 'spotEditSl']].forEach(([cbId, inId]) => {
        const cb = document.getElementById(cbId);
        const input = document.getElementById(inId);
        if (!cb || !input) return;
        cb.addEventListener('change', () => { input.disabled = !cb.checked; if (!cb.checked) input.value = ''; });
      });
      document.getElementById('spotTpSave').onclick = async () => {
        const tpOn = document.getElementById('spotEditTpOn');
        const slOn = document.getElementById('spotEditSlOn');
        const tp = (tpOn && !tpOn.checked) ? 0 : Number(document.getElementById('spotEditTp').value) || 0;
        const sl = (slOn && !slOn.checked) ? 0 : Number(document.getElementById('spotEditSl').value) || 0;
        try {
          const r = await apiJSON('/api/market/spot/tpsl', { method: 'POST', body: JSON.stringify({ userId: me().id, ticker, tpPrice: tp, slPrice: sl }) }, 20000);
          if (!r.res || !r.res.ok || !r.data || !r.data.ok) return tmsg((r.data && r.data.error) || 'Update failed', 'err');
          closeModal(); await Remote.refresh(true); tmsg('TP / SL updated', 'ok'); render();
        } catch (e) { tmsg('Update failed: ' + e.message, 'err'); }
      };
    };
  }

  function escSpot(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  if (typeof AFTER === 'object') {
    const prev = AFTER.invest;
    AFTER.invest = function (parts, params) {
      try { if (prev) prev(parts, params); } catch (e) {}
      setTimeout(() => {
        try {
          if ((location.hash || '').startsWith('#/invest/stock/')) mountStock();
          else mountDashboard();
        } catch (e) {}
      }, 110);
    };
  }

  (function styles() {
    if (document.getElementById('spot-order-style')) return;
    const st = document.createElement('style');
    st.id = 'spot-order-style';
    st.textContent = `
    .spot-position{margin-top:12px;padding:10px;border:1px solid var(--border);border-radius:12px;background:var(--surface-2)}
    .spot-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:8px}
    .spot-grid div{display:flex;flex-direction:column;gap:1px}
    .spot-grid span{font-size:9.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted-2);font-weight:700}
    .spot-grid b{font-size:11.5px;font-variant-numeric:tabular-nums}
    .spot-row{display:flex;gap:8px;align-items:center;padding:9px 0;border-top:1px solid var(--border)}
    .spot-row:first-of-type{border-top:none}
    .spot-tpsl-edit{margin-top:9px;padding:9px;border:1px dashed var(--border);border-radius:10px;background:var(--surface)}
    @media(max-width:420px){.spot-grid{grid-template-columns:1fr 1fr}}
    `;
    document.head.appendChild(st);
  })();

  setInterval(() => { try { if (document.getElementById('spotPosition')) S.paint(); } catch (e) {} }, 2000);
})();
