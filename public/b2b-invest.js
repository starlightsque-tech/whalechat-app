/* =========================================================================
   WhaleChat B2B Investing Account
   - USD trade-capital dashboard (1 WC = $0.50, same cash ledger)
   - all available digital assets with separate Buy and Sell actions
   - multi-asset Buy page: pick one or many assets, enter USD amounts, confirm
   - multi-asset Sell page: pick from current holdings, confirm and receive WC payout
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  const B2B = window.WC_B2B = window.WC_B2B || {};

  function escB(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function num(v, d) { return (Number(v) || 0).toFixed(d == null ? 2 : d); }
  function money(v) { return '$' + num(v, 2); }
  function wcText(v) { return num(v) + ' WC'; }
  function user() { try { return me(); } catch (e) { return null; } }
  function liveCoins() { return Number((user() && user().balance) || 0); }
  function liveUsd() { return liveCoins() * 0.5; }
  function allAssets() { try { return (INV.stocks() || []).filter((s) => s && s.ticker); } catch (e) { return []; } }
  function qFor(t) { try { return INV.quote(t) || null; } catch (e) { return null; } }
  function myHoldings() { try { return (INV.holdings(user().id) || []).filter((h) => h && h.ticker && Number(h.shares) > 0); } catch (e) { return []; } }
  function holdingFor(t) { return myHoldings().find((h) => String(h.ticker).toUpperCase() === String(t).toUpperCase()) || null; }
  function label(t) { try { return INV.assetTicker ? INV.assetTicker(t) : t; } catch (e) { return t; } }
  function tmsg(msg, type) { if (typeof toast === 'function') toast(msg, type || 'ok'); }
  function apiPath(p) { try { if (typeof Remote !== 'undefined' && Remote && Remote.enabled) return Remote.url(p); } catch (e) {} return p; }
  async function api(pathname, opts, timeout) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout || 25000);
    try {
      const res = await fetch(apiPath(pathname), Object.assign({ signal: ctrl.signal, headers: { 'content-type': 'application/json' } }, opts || {}));
      const data = await res.json().catch(() => null);
      return { res, data };
    } finally { clearTimeout(timer); }
  }
  function go2(hash) { try { go(hash); } catch (e) { location.hash = '#/' + String(hash).replace(/^#?\/?/, ''); } }

  function positionValueUsd(h) {
    const q = qFor(h.ticker);
    return (Number(h.shares) || 0) * Number((q && q.price) || h.avgPrice || 0);
  }
  function positionPnlUsd(h) {
    const q = qFor(h.ticker);
    const px = Number((q && q.price) || h.avgPrice || 0);
    return ((px - (Number(h.avgPrice) || px)) * (Number(h.shares) || 0));
  }
  function totalHoldingsUsd() { return myHoldings().reduce((s, h) => s + positionValueUsd(h), 0); }
  function totalPnlUsd() { return myHoldings().reduce((s, h) => s + positionPnlUsd(h), 0); }

  function assetRow(s, opts) {
    const o = opts || {};
    const q = qFor(s.ticker) || { price: 0, changePct: 0 };
    const h = holdingFor(s.ticker);
    const up = Number(q.changePct) >= 0;
    return `<div class="b2b-asset-row">
      <a class="b2b-asset-main" href="#/invest/stock/${escB(s.ticker)}">
        ${typeof INV.logoHTML === 'function' ? INV.logoHTML(s, 30) : ''}
        <div class="grow" style="min-width:0">
          <b>${escB(label(s.ticker))}</b>
          <div class="tiny muted ellipsis">${escB(s.name || '')}</div>
        </div>
        <div style="text-align:right">
          <b>${money(q.price)}</b>
          <div class="tiny ${up ? 'up' : 'down'}">${up ? '+' : '−'}${num(Math.abs(Number(q.changePct) || 0), 2)}%</div>
          <div class="tiny muted">${wcText(Number(q.price) / 0.5)}</div>
        </div>
      </a>
      <div class="b2b-asset-actions">
        <button class="btn btn-sm btn-primary" data-act="b2b-buy" data-t="${escB(s.ticker)}">Buy</button>
        <button class="btn btn-sm btn-danger" data-act="b2b-sell" data-t="${escB(s.ticker)}" ${h ? '' : 'disabled'}>Sell</button>
      </div>
      ${o.showHolding && h ? `<div class="b2b-asset-holding tiny muted">You own ${num(h.shares, 6)} shares · value ${money(positionValueUsd(h))} (${wcText(positionValueUsd(h) / 0.5)})</div>` : ''}
    </div>`;
  }

  function heroHTML() {
    const capUsd = liveUsd();
    const capCoins = liveCoins();
    const holdingsUsd = totalHoldingsUsd();
    const pnl = totalPnlUsd();
    const total = capUsd + holdingsUsd;
    return `<div class="card b2b-hero">
      <div class="between" style="align-items:flex-start;gap:10px">
        <div><div class="tiny muted">B2B investing account · trade capital</div>
          <div class="b2b-capital">${money(capUsd)}</div>
          <div class="tiny muted">${wcText(capCoins)} available · 1 WC = $0.50</div></div>
        <span class="badge badge-success">Active</span>
      </div>
      <div class="b2b-hero-grid">
        <div><span>Holdings value</span><b>${money(holdingsUsd)}</b><i>${wcText(holdingsUsd / 0.5)}</i></div>
        <div><span>Unrealized P/L</span><b class="${pnl >= 0 ? 'up' : 'down'}">${pnl >= 0 ? '+' : '−'}${money(Math.abs(pnl))}</b><i>${wcText(pnl / 0.5)}</i></div>
        <div><span>Total account</span><b>${money(total)}</b><i>${wcText(total / 0.5)}</i></div>
        <div><span>Holdings</span><b>${myHoldings().length}</b><i>assets owned</i></div>
      </div>
      <div class="b2b-actions">
        <button class="btn btn-primary grow" data-act="b2b-go-buy">${typeof ic === 'function' ? ic('trend', 16) : ''} Buy assets</button>
        <button class="btn btn-danger grow" data-act="b2b-go-sell">${typeof ic === 'function' ? ic('wallet', 16) : ''} Sell assets</button>
        <a class="btn btn-ghost" href="#/invest/b2b/assets">All assets</a>
      </div>
    </div>`;
  }

  function holdingsHTML() {
    const hs = myHoldings();
    if (!hs.length) return `<div class="card"><div class="between"><div class="card-title" style="margin:0">Your asset holdings</div><span class="tiny muted">0 open</span></div>
      <div class="b2b-empty">You don't own any assets yet. Choose <b>Buy assets</b> to add your first holding.</div></div>`;
    return `<div class="card"><div class="between"><div class="card-title" style="margin:0">Your asset holdings</div>
      <a href="#/invest/orders" class="tiny muted">Orders</a></div>
      ${hs.map((h) => {
        const q = qFor(h.ticker) || { price: h.avgPrice };
        const valueUsd = positionValueUsd(h);
        const pnl = positionPnlUsd(h);
        return `<div class="b2b-holding-row">
          <a class="b2b-asset-main" href="#/invest/stock/${escB(h.ticker)}">
            <div class="grow" style="min-width:0"><b>${escB(label(h.ticker))}</b>
              <div class="tiny muted">${num(h.shares, 6)} shares · entry ${money(h.avgPrice)} (${wcText(Number(h.avgPrice) / 0.5)})</div></div>
            <div style="text-align:right"><b>${money(valueUsd)}</b>
              <div class="tiny ${pnl >= 0 ? 'up' : 'down'}">${pnl >= 0 ? '+' : '−'}${money(Math.abs(pnl))}</div>
              <div class="tiny muted">${wcText(valueUsd / 0.5)}</div></div>
          </a>
          <div class="b2b-asset-actions">
            <button class="btn btn-sm btn-primary" data-act="b2b-buy" data-t="${escB(h.ticker)}">Buy more</button>
            <button class="btn btn-sm btn-danger" data-act="b2b-sell" data-t="${escB(h.ticker)}">Sell</button>
          </div>
        </div>`;
      }).join('')}
    </div>`;
  }

  function dashboard() {
    const assets = allAssets();
    const preview = assets.slice(0, 10);
    return `<div class="page-head"><div class="between">
      <div class="row" style="gap:10px;align-items:center"><a href="#/invest" class="btn-icon">${ic('back', 18)}</a>
        <div><div class="section-title" style="margin:0">B2B Investing</div>
          <div class="tiny muted">Stock trading account · USD trade capital · digital assets</div></div></div>
      <a href="#/invest/b2b/assets" class="btn btn-sm btn-ghost">All assets</a>
    </div></div>
    ${heroHTML()}
    ${holdingsHTML()}
    <div class="card">
      <div class="between"><div class="card-title" style="margin:0">Available digital assets</div>
        <a href="#/invest/b2b/assets" class="tiny muted">View all ${assets.length} →</a></div>
      <div class="b2b-asset-list">${preview.length ? preview.map((s) => assetRow(s, { showHolding: true })).join('') : '<div class="b2b-empty">No assets listed yet.</div>'}</div>
    </div>`;
  }

  function buyPage(params) {
    const assets = allAssets();
    const preselect = String((params && params.ticker) || '').toUpperCase();
    return `<div class="page-head"><div class="between">
      <div class="row" style="gap:10px;align-items:center"><a href="#/invest/b2b" class="btn-icon">${ic('back', 18)}</a>
        <div><div class="section-title" style="margin:0">Buy assets</div>
          <div class="tiny muted">Select one or more assets, enter USD amounts, then confirm</div></div></div>
      <span class="badge">${money(liveUsd())} available</span>
    </div></div>
    <div class="card">
      <div class="between"><div class="card-title" style="margin:0">Select assets</div><span class="tiny muted" id="b2bBuyCount">0 selected</span></div>
      <div class="b2b-pick-list">
        ${assets.map((s) => {
          const q = qFor(s.ticker) || { price: 0 };
          const checked = preselect === String(s.ticker).toUpperCase();
          return `<div class="b2b-pick-row" data-b2b-row="${escB(s.ticker)}">
            <label class="b2b-check"><input type="checkbox" data-b2b-pick data-t="${escB(s.ticker)}" ${checked ? 'checked' : ''}/></label>
            <div class="grow" style="min-width:0"><b>${escB(label(s.ticker))}</b>
              <div class="tiny muted">${escB(s.name || '')} · ${money(q.price)} (${wcText(Number(q.price) / 0.5)})</div></div>
            <div class="b2b-amount-wrap"><span>$</span>
              <input class="input" type="number" min="0" step="0.01" placeholder="USD" data-b2b-usd data-t="${escB(s.ticker)}" ${checked ? '' : 'disabled'}/></div>
          </div>`;
        }).join('')}
      </div>
    </div>
    <div class="card b2b-summary">
      <div class="between"><span class="tiny muted">Selected assets</span><b id="b2bSelCount">0</b></div>
      <div class="between"><span class="tiny muted">Total investment</span><b id="b2bSelUsd">$0.00</b></div>
      <div class="between"><span class="tiny muted">WC cost (USD ÷ 0.50)</span><b id="b2bSelWc">0 WC</b></div>
      <div class="between"><span class="tiny muted">Balance after purchase</span><b id="b2bSelAfter">${money(liveUsd())}</b></div>
      <button class="btn btn-primary" data-act="b2b-buy-confirm" style="width:100%;margin-top:10px">Confirm purchase</button>
      <div class="tiny muted" style="margin-top:6px">Each purchase is executed at the current live price and appears in your holdings immediately.</div>
    </div>`;
  }

  function sellPage(params) {
    const hs = myHoldings();
    const preselect = String((params && params.ticker) || '').toUpperCase();
    return `<div class="page-head"><div class="between">
      <div class="row" style="gap:10px;align-items:center"><a href="#/invest/b2b" class="btn-icon">${ic('back', 18)}</a>
        <div><div class="section-title" style="margin:0">Sell assets</div>
          <div class="tiny muted">Select holdings to close at the live price</div></div></div>
      <span class="badge">${money(liveUsd())} trade capital</span>
    </div></div>
    <div class="card">
      <div class="between"><div class="card-title" style="margin:0">Your holdings</div><span class="tiny muted" id="b2bSellCount">0 selected</span></div>
      ${hs.length ? `<div class="b2b-pick-list">${hs.map((h) => {
        const q = qFor(h.ticker) || { price: h.avgPrice };
        const valueUsd = positionValueUsd(h);
        const pnl = positionPnlUsd(h);
        const checked = preselect === String(h.ticker).toUpperCase();
        return `<div class="b2b-pick-row" data-b2b-sell-row="${escB(h.ticker)}">
          <label class="b2b-check"><input type="checkbox" data-b2b-sell-pick data-t="${escB(h.ticker)}" data-value="${valueUsd}" ${checked ? 'checked' : ''}/></label>
          <div class="grow" style="min-width:0"><b>${escB(label(h.ticker))}</b>
            <div class="tiny muted">${num(h.shares, 6)} shares · entry ${money(h.avgPrice)} · live ${money(q.price)}</div></div>
          <div style="text-align:right"><b>${money(valueUsd)}</b>
            <div class="tiny ${pnl >= 0 ? 'up' : 'down'}">${pnl >= 0 ? '+' : '−'}${money(Math.abs(pnl))}</div>
            <div class="tiny muted">${wcText(valueUsd / 0.5)} payout</div></div>
        </div>`;
      }).join('')}</div>` : `<div class="b2b-empty">No holdings to sell. <a class="link" href="#/invest/b2b/buy">Buy assets first</a>.</div>`}
    </div>
    <div class="card b2b-summary">
      <div class="between"><span class="tiny muted">Selected holdings</span><b id="b2bSellSelCount">0</b></div>
      <div class="between"><span class="tiny muted">Estimated payout</span><b id="b2bSellUsd">$0.00</b></div>
      <div class="between"><span class="tiny muted">Credited to wallet</span><b id="b2bSellWc">0 WC</b></div>
      <button class="btn btn-danger" data-act="b2b-sell-confirm" style="width:100%;margin-top:10px">Confirm sale</button>
      <div class="tiny muted" style="margin-top:6px">Selected positions are closed at the live effective price. Payout = shares × price ÷ 0.50 and is credited instantly.</div>
    </div>`;
  }

  function assetsPage() {
    const assets = allAssets();
    return `<div class="page-head"><div class="between">
      <div class="row" style="gap:10px;align-items:center"><a href="#/invest/b2b" class="btn-icon">${ic('back', 18)}</a>
        <div><div class="section-title" style="margin:0">All digital assets</div>
          <div class="tiny muted">${assets.length} available · tap an asset to open its chart</div></div></div>
      <div class="row" style="gap:6px"><a href="#/invest/b2b/buy" class="btn btn-sm btn-primary">Buy</a><a href="#/invest/b2b/sell" class="btn btn-sm btn-danger">Sell</a></div>
    </div></div>
    <div class="card"><div class="b2b-asset-list">${assets.length ? assets.map((s) => assetRow(s, { showHolding: true })).join('') : '<div class="b2b-empty">No assets listed.</div>'}</div></div>`;
  }

  B2B.view = function (sub, params) {
    if (sub === 'buy') return buyPage(params);
    if (sub === 'sell') return sellPage(params);
    if (sub === 'assets') return assetsPage();
    return dashboard();
  };

  /* ------------------------------ selection UI ----------------------------- */
  function selectedBuy() {
    const out = [];
    document.querySelectorAll('[data-b2b-pick]:checked').forEach((cb) => {
      const t = cb.getAttribute('data-t');
      const inp = document.querySelector('[data-b2b-usd][data-t="' + t + '"]');
      const usd = Number(inp && inp.value) || 0;
      out.push({ ticker: t, usd });
    });
    return out;
  }
  function paintBuySummary() {
    const sel = selectedBuy();
    const valid = sel.filter((x) => x.usd > 0);
    const totalUsd = valid.reduce((a, x) => a + x.usd, 0);
    const totalWc = totalUsd / 0.5;
    const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
    set('b2bBuyCount', sel.length + ' selected');
    set('b2bSelCount', sel.length);
    set('b2bSelUsd', money(totalUsd));
    set('b2bSelWc', wcText(totalWc));
    set('b2bSelAfter', money(Math.max(0, liveUsd() - totalUsd)));
  }
  function selectedSell() {
    const out = [];
    document.querySelectorAll('[data-b2b-sell-pick]:checked').forEach((cb) => {
      out.push({ ticker: cb.getAttribute('data-t'), value: Number(cb.getAttribute('data-value')) || 0 });
    });
    return out;
  }
  function paintSellSummary() {
    const sel = selectedSell();
    const usd = sel.reduce((a, x) => a + x.value, 0);
    const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
    set('b2bSellCount', sel.length + ' selected');
    set('b2bSellSelCount', sel.length);
    set('b2bSellUsd', money(usd));
    set('b2bSellWc', wcText(usd / 0.5));
  }
  B2B.bind = function () {
    document.querySelectorAll('[data-b2b-pick]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const inp = document.querySelector('[data-b2b-usd][data-t="' + cb.getAttribute('data-t') + '"]');
        if (inp) {
          inp.disabled = !cb.checked;
          if (cb.checked) { inp.focus(); }
          else inp.value = '';
        }
        paintBuySummary();
      });
    });
    document.querySelectorAll('[data-b2b-usd]').forEach((inp) => inp.addEventListener('input', paintBuySummary));
    document.querySelectorAll('[data-b2b-sell-pick]').forEach((cb) => cb.addEventListener('change', paintSellSummary));
    paintBuySummary();
    paintSellSummary();
  };

  if (typeof App !== 'undefined') {
    App.b2bGoBuy = function () { go2('invest/b2b/buy'); };
    App.b2bGoSell = function () { go2('invest/b2b/sell'); };
    App.b2bBuy = function (id, ds) { go2('invest/b2b/buy?ticker=' + encodeURIComponent((ds && ds.t) || '')); };
    App.b2bSell = function (id, ds) {
      if (!holdingFor((ds && ds.t) || '')) return tmsg('You do not own this asset yet', 'err');
      go2('invest/b2b/sell?ticker=' + encodeURIComponent((ds && ds.t) || ''));
    };

    App.b2bBuyConfirm = async function () {
      if (typeof Remote === 'undefined' || !Remote.enabled) return tmsg('Connect the sync server to buy assets', 'err');
      const picks = selectedBuy().filter((x) => x.usd > 0);
      if (!picks.length) return tmsg('Select at least one asset and enter a USD amount', 'err');
      const totalUsd = picks.reduce((a, x) => a + x.usd, 0);
      if (totalUsd > liveUsd() + 1e-9) return tmsg('Total exceeds your ' + money(liveUsd()) + ' stock trading capital', 'err');
      if (typeof confirmDialog === 'function') {
        const ok = await confirmDialog({ title: 'Confirm purchase', body: `Buy ${picks.length} asset${picks.length === 1 ? '' : 's'} for ${money(totalUsd)} (${wcText(totalUsd / 0.5)}) at the live prices?`, ok: 'Confirm purchase' });
        if (!ok) return;
      }
      let done = 0; const errors = [];
      for (const p of picks) {
        try {
          const r = await api('/api/market/spot/buy', { method: 'POST', body: JSON.stringify({ userId: user().id, ticker: p.ticker, amountUsd: p.usd }) });
          if (!r.res || !r.res.ok || !r.data || !r.data.ok) throw new Error((r.data && r.data.error) || 'failed');
          done++;
        } catch (e) { errors.push(label(p.ticker) + ': ' + e.message); }
      }
      try { await Remote.refresh(true); } catch (e) {}
      tmsg(done + ' purchase' + (done === 1 ? '' : 's') + ' completed' + (errors.length ? ' · ' + errors.length + ' failed' : ''), errors.length ? 'err' : 'ok');
      if (errors.length && errors.length < picks.length) tmsg(errors[0], 'err');
      go2('invest/b2b');
    };

    App.b2bSellConfirm = async function () {
      if (typeof Remote === 'undefined' || !Remote.enabled) return tmsg('Connect the sync server to sell assets', 'err');
      const picks = selectedSell();
      if (!picks.length) return tmsg('Select at least one holding to sell', 'err');
      const totalUsd = picks.reduce((a, x) => a + x.value, 0);
      if (typeof confirmDialog === 'function') {
        const ok = await confirmDialog({ title: 'Confirm sale', body: `Sell ${picks.length} holding${picks.length === 1 ? '' : 's'} at the live price? Estimated payout ${money(totalUsd)} (${wcText(totalUsd / 0.5)}).`, ok: 'Confirm sale', danger: true });
        if (!ok) return;
      }
      let done = 0, payout = 0; const errors = [];
      for (const p of picks) {
        try {
          const r = await api('/api/market/spot/sell', { method: 'POST', body: JSON.stringify({ userId: user().id, ticker: p.ticker }) });
          if (!r.res || !r.res.ok || !r.data || !r.data.ok) throw new Error((r.data && r.data.error) || 'failed');
          done++; payout += Number(r.data.payout) || 0;
        } catch (e) { errors.push(label(p.ticker) + ': ' + e.message); }
      }
      try { await Remote.refresh(true); } catch (e) {}
      tmsg(done + ' sale' + (done === 1 ? '' : 's') + ' completed · ' + wcText(payout) + ' payout credited' + (errors.length ? ' · ' + errors.length + ' failed' : ''), errors.length ? 'err' : 'ok');
      go2('invest/b2b');
    };
  }

  /* ---------------------------- route + mounting --------------------------- */
  function patchViews() {
    if (typeof VIEWS === 'undefined' || !VIEWS.invest) return false;
    if (VIEWS.__wcB2BPatched) return true;
    const base = VIEWS.invest;
    VIEWS.invest = function (parts, params) {
      if ((parts[1] || '') === 'b2b') return B2B.view(parts[2] || '', params);
      return base.apply(this, arguments);
    };
    VIEWS.__wcB2BPatched = true;
    return true;
  }
  function b2bDashCard() {
    const capUsd = liveUsd();
    const hs = myHoldings();
    const pnl = totalPnlUsd();
    return `<a class="card b2b-dash" href="#/invest/b2b">
      <div class="between" style="align-items:flex-start">
        <div class="row" style="gap:9px;align-items:center">
          <span class="b2b-dash-ic">${typeof ic === 'function' ? ic('wallet', 16) : ''}</span>
          <div><div class="card-title" style="margin:0">B2B Investing Account</div>
            <div class="tiny muted">${money(capUsd)} trade capital · ${hs.length} holding${hs.length === 1 ? '' : 's'} · ${pnl >= 0 ? '+' : '−'}${money(Math.abs(pnl))} P/L</div></div>
        </div>
        <span class="badge badge-success">Buy / Sell</span>
      </div>
      <div class="tiny" style="margin-top:8px;color:var(--accent);font-weight:650">Open B2B account →</div>
    </a>`;
  }
  function patchDash() {
    if (typeof INV === 'undefined' || !INV.viewDash) return false;
    if (INV.__wcB2BDash) return true;
    const base = INV.viewDash;
    INV.viewDash = function () {
      const html = base.apply(this, arguments);
      const anchor = '<div class="card inv-chartcard">';
      if (html.indexOf(anchor) === -1) return html + b2bDashCard();
      return html.replace(anchor, b2bDashCard() + anchor);
    };
    INV.__wcB2BDash = true;
    return true;
  }

  function init() {
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      const ok = patchViews() && patchDash();
      if (ok || tries > 40) clearInterval(iv);
      if (ok && typeof AFTER === 'object') {
        const prev = AFTER.invest;
        AFTER.invest = function (parts, params) {
          try { if (prev) prev(parts, params); } catch (e) {}
          const sub = parts[1] || '';
          if (sub === 'b2b') setTimeout(() => { try { B2B.bind(); } catch (e) {} }, 60);
        };
      }
    }, 180);
  }

  (function styles() {
    if (document.getElementById('wc-b2b-style')) return;
    const st = document.createElement('style');
    st.id = 'wc-b2b-style';
    st.textContent = `
    .b2b-hero{background:radial-gradient(circle at 90% 0%,rgba(46,230,201,.18),transparent 55%),linear-gradient(135deg,#07202b,#0a1a26);border-color:rgba(46,230,201,.22)}
    .b2b-capital{font-size:30px;font-weight:800;letter-spacing:-.03em;color:#2ee6c9;line-height:1.15}
    .b2b-hero-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin-top:12px}
    .b2b-hero-grid div{display:flex;flex-direction:column;gap:1px;padding:8px;border-radius:9px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);min-width:0}
    .b2b-hero-grid span{font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:#8ba4b6;font-weight:700}
    .b2b-hero-grid b{font-size:12.5px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .b2b-hero-grid i{font-style:normal;font-size:9.5px;color:#8ba4b6}
    .b2b-hero-grid b.up{color:var(--success)} .b2b-hero-grid b.down{color:var(--danger)}
    .b2b-actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
    .b2b-asset-list{display:flex;flex-direction:column;margin-top:6px}
    .b2b-asset-row,.b2b-holding-row{padding:9px 0;border-top:1px solid var(--border)}
    .b2b-asset-row:first-child,.b2b-holding-row:first-child{border-top:none}
    .b2b-asset-main{display:flex;gap:9px;align-items:center;text-decoration:none;color:inherit;min-width:0}
    .b2b-asset-main b{font-size:11.5px}
    .b2b-asset-actions{display:flex;gap:6px;margin-top:7px;margin-left:39px}
    .b2b-asset-actions .btn{flex:0 0 auto;min-width:74px}
    .b2b-asset-holding{margin-top:5px;margin-left:39px}
    .b2b-empty{padding:16px 4px;font-size:11px;color:var(--muted);line-height:1.6}
    .b2b-pick-list{margin-top:8px}
    .b2b-pick-row{display:flex;gap:9px;align-items:center;padding:9px 0;border-top:1px solid var(--border)}
    .b2b-pick-row:first-child{border-top:none}
    .b2b-check{flex:none}
    .b2b-check input{width:18px;height:18px;accent-color:var(--accent)}
    .b2b-amount-wrap{display:flex;align-items:center;gap:2px;border:1px solid var(--border);border-radius:9px;padding:0 6px;background:var(--surface-2);width:112px;flex:none}
    .b2b-amount-wrap span{font-size:11px;color:var(--muted)}
    .b2b-amount-wrap .input{border:none;background:transparent;padding:7px 2px;height:auto;width:100%;font-size:12px}
    .b2b-summary .between{font-size:11.5px;padding:3px 0;color:var(--muted)}
    .b2b-summary b{color:var(--text);font-variant-numeric:tabular-nums}
    .b2b-dash{display:block;margin:10px 0;text-decoration:none;color:inherit}
    .b2b-dash-ic{width:32px;height:32px;border-radius:10px;display:flex;align-items:center;justify-content:center;background:rgba(58,160,255,.14);color:#6bb6ff;flex:none}
    .b2b-asset-main .up{color:var(--success)} .b2b-asset-main .down{color:var(--danger)}
    @media(max-width:520px){.b2b-amount-wrap{width:92px}.b2b-hero-grid{grid-template-columns:1fr 1fr}}
    `;
    document.head.appendChild(st);
  })();

  init();
})();
