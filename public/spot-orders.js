/* =========================================================================
   WhaleChat spot orders — Buy / Sell at the live Finnhub price
   TP/SL are monitored and executed atomically by the backend market worker.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  const S = window.WC_SPOT = window.WC_SPOT || {};
  S.mode = 'usd';
  S.ticker = '';

  function apiPath(p) {
    try { if (typeof Remote !== 'undefined' && Remote && Remote.enabled) return Remote.url(p); } catch (e) {}
    return p;
  }
  async function apiJSON(pathname, opts, timeout) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout || 20000);
    try {
      const res = await fetch(apiPath(pathname), Object.assign({ signal: ctrl.signal, headers: { 'content-type': 'application/json' } }, opts || {}));
      const data = await res.json().catch(() => null);
      return { res, data };
    } finally { clearTimeout(timer); }
  }
  function tmsg(msg, type) { if (typeof toast === 'function') toast(msg, type || 'ok'); }
  function px(t, v) { return (typeof INV !== 'undefined' && INV.priceText) ? INV.priceText(t, v) : (typeof usd === 'function' ? usd(v) : String(v)); }
  function label(t) { return (typeof INV !== 'undefined' && INV.assetTicker) ? INV.assetTicker(t) : t; }
  function holdingFor(t) { try { return INV.holding(t, me().id); } catch (e) { return null; } }
  function qFor(t) { try { return INV.quote(t); } catch (e) { return null; } }

  S.preview = function () {
    const el = document.getElementById('spotAmount');
    const pv = document.getElementById('spotPreview');
    if (!el || !pv) return;
    const q = qFor(S.ticker);
    if (!q || !(q.price > 0)) { pv.textContent = 'Waiting for a live Finnhub quote…'; return; }
    const v = Number(el.value) || 0;
    let shares = 0, cost = 0, usdAmt = 0;
    if (S.mode === 'usd') { usdAmt = v; shares = v / q.price; cost = v / 0.5; }
    else if (S.mode === 'wc') { cost = v; usdAmt = v * 0.5; shares = usdAmt / q.price; }
    else { shares = v; usdAmt = shares * q.price; cost = usdAmt / 0.5; }
    pv.innerHTML = `<b>${usdAmt.toLocaleString(undefined, { style: 'currency', currency: 'USD' })}</b> = <b>${cost.toFixed(2)} WC</b> · ${shares.toLocaleString(undefined, { maximumFractionDigits: 6 })} shares · live ${px(S.ticker, q.price)} (${(q.price * 2).toFixed(2)} WC)`;
  };

  function ticketHTML(ticker) {
    const s = INV.stock(ticker);
    const q = qFor(ticker);
    const h = holdingFor(ticker);
    if (!s) return '';
    const price = q ? Number(q.price) : 0;
    return `<div class="card" id="spotTicketCard">
      <div class="between" style="align-items:flex-start;gap:10px">
        <div><div class="card-title" style="margin:0">Buy ${escSpot(label(ticker))}</div>
          <div class="tiny muted" style="margin-top:2px">Live selling price ${price > 0 ? px(ticker, price) + ' (' + (price * 2).toFixed(2) + ' WC)' : 'waiting for Finnhub quote'}</div></div>
        <span class="badge badge-success">Spot</span>
      </div>
      <div class="lt-modebtns" style="margin-top:11px">
        <button type="button" class="${S.mode === 'usd' ? 'on' : ''}" data-act="spot-mode" data-mode="usd">Invest USD</button>
        <button type="button" class="${S.mode === 'wc' ? 'on' : ''}" data-act="spot-mode" data-mode="wc">Invest WC</button>
        <button type="button" class="${S.mode === 'shares' ? 'on' : ''}" data-act="spot-mode" data-mode="shares">Shares</button>
      </div>
      <div class="field" style="margin-top:9px"><label class="label" id="spotAmountLabel">${S.mode === 'usd' ? 'Investment amount (USD)' : S.mode === 'wc' ? 'Investment amount (WC)' : 'Number of shares'}</label>
        <div class="input-wrap"><span class="inv-prefix" id="spotPrefix">${S.mode === 'usd' ? '$' : S.mode === 'wc' ? 'WC' : 'sh'}</span>
          <input class="input" id="spotAmount" type="number" step="0.01" min="0" placeholder="0"/></div>
        <div class="tiny muted" id="spotPreview" style="margin-top:5px">Enter a USD amount — WC is calculated at 1 WC = $0.50.</div>
      </div>
      <div class="row" style="gap:8px">
        <div class="field grow"><label class="label">Take Profit (optional)</label>
          <input class="input" id="spotTp" type="number" step="0.01" min="0" placeholder="${price > 0 ? (price * 1.05).toFixed(4) : 'price'}"/></div>
        <div class="field grow"><label class="label">Stop Loss (optional)</label>
          <input class="input" id="spotSl" type="number" step="0.01" min="0" placeholder="${price > 0 ? (price * 0.95).toFixed(4) : 'price'}"/></div>
      </div>
      <div class="tiny muted" style="margin:-2px 0 10px;line-height:1.55">TP/SL run on the backend every second and sell the whole position at the live price when hit.</div>
      <button class="btn btn-primary" data-act="spot-buy" style="width:100%">${typeof ic === 'function' ? ic('trend', 15) : ''} Buy ${escSpot(label(ticker))}</button>
      ${h ? positionHTML(ticker, h, q) : ''}
    </div>`;
  }

  function positionHTML(ticker, h, q) {
    const shares = Number(h.shares) || 0;
    const avg = Number(h.avgPrice) || 0;
    const price = q && q.price > 0 ? Number(q.price) : avg;
    const invested = Number(h.investedCoins) || ((shares * avg) / 0.5);
    const value = (shares * price) / 0.5;
    const pnl = value - invested;
    return `<div class="spot-position" id="spotPosition" data-spot="${ticker}">
      <div class="between"><div class="card-title" style="margin:0">Your position</div>
        <span class="badge ${pnl >= 0 ? 'badge-success' : 'badge-danger'}">${pnl >= 0 ? '+' : '−'}${Math.abs(pnl).toFixed(2)} WC</span></div>
      <div class="spot-grid">
        <div><span>Symbol</span><b>${escSpot(label(ticker))}</b></div>
        <div><span>Quantity</span><b data-spot-qty>${shares.toLocaleString(undefined, { maximumFractionDigits: 6 })}</b></div>
        <div><span>Entry price</span><b data-spot-entry>${px(ticker, avg)}</b></div>
        <div><span>Invested</span><b data-spot-invested>${invested.toFixed(2)} WC <span class="tiny muted">(${((Number(h.investedUsd) || invested * 0.5)).toFixed(2)} USD)</span></b></div>
        <div><span>Live value</span><b data-spot-value>${value.toFixed(2)} WC <span class="tiny muted">(${(value * 0.5).toFixed(2)} USD)</span></b></div>
        <div><span>P/L</span><b class="${pnl >= 0 ? 'up' : 'down'}" data-spot-pnl>${pnl >= 0 ? '+' : '−'}${Math.abs(pnl).toFixed(2)} WC <span class="tiny">(${pnl >= 0 ? '+' : '−'}$${Math.abs(pnl * 0.5).toFixed(2)})</span></b></div>
        <div><span>Take Profit</span><b>${Number(h.takeProfitPrice) > 0 ? px(ticker, h.takeProfitPrice) : '—'}</b></div>
        <div><span>Stop Loss</span><b>${Number(h.stopLossPrice) > 0 ? px(ticker, h.stopLossPrice) : '—'}</b></div>
      </div>
      <div class="row" style="gap:7px;margin-top:9px">
        <button class="btn btn-danger grow" data-act="spot-sell" data-t="${escSpot(ticker)}">Sell now</button>
        <button class="btn btn-ghost grow" data-act="spot-toggle-tpsl" data-t="${escSpot(ticker)}">TP / SL</button>
      </div>
      <div class="spot-tpsl-edit" id="spotTpSlEditor" hidden data-t="${escSpot(ticker)}">
        <div class="row" style="gap:8px">
          <div class="field grow" style="margin:0"><label class="label">Take Profit</label>
            <input class="input" id="spotInlineTp" type="number" step="0.01" min="0" value="${Number(h.takeProfitPrice) > 0 ? h.takeProfitPrice : ''}" placeholder="optional"/></div>
          <div class="field grow" style="margin:0"><label class="label">Stop Loss</label>
            <input class="input" id="spotInlineSl" type="number" step="0.01" min="0" value="${Number(h.stopLossPrice) > 0 ? h.stopLossPrice : ''}" placeholder="optional"/></div>
        </div>
        <div class="row" style="gap:8px;margin-top:8px">
          <button class="btn btn-sm btn-primary grow" data-act="spot-save-tpsl" data-t="${escSpot(ticker)}">Save TP / SL</button>
          <button class="btn btn-sm btn-ghost" data-act="spot-clear-tpsl" data-t="${escSpot(ticker)}">Clear</button>
        </div>
        <div class="tiny muted" style="margin-top:5px">TP must be above entry, SL below. The backend executes the first level hit.</div>
      </div>
      <div class="tiny muted center" style="margin-top:5px">Payout WC = (quantity × exit USD) ÷ 0.50 · credited instantly</div>
    </div>`;
  }

  function mountStock() {
    const m = (location.hash || '').match(/^#\/invest\/stock\/([A-Z0-9._]+)/i);
    if (!m) return;
    S.ticker = m[1].toUpperCase();
    const content = document.getElementById('content');
    const host = document.getElementById('ltTicketMount');
    if (!content) return;
    if (document.getElementById('spotTicketCard')) { S.paint(); return; }
    const old = document.getElementById('ltTicket');
    if (old) old.remove();                       /* replace the leveraged order form */
    const box = document.createElement('div');
    box.id = 'spotTicketHost';
    box.innerHTML = ticketHTML(S.ticker);
    if (host) host.insertBefore(box, host.firstChild);
    else content.insertBefore(box, content.firstChild);
    const amt = document.getElementById('spotAmount');
    if (amt) amt.addEventListener('input', S.preview);
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
        return `<div class="spot-row" data-spot-row="${escSpot(h.ticker)}">
          <div class="grow" style="min-width:0"><b>${escSpot(label(h.ticker))}</b>
            <div class="tiny muted">${Number(h.shares).toLocaleString(undefined, { maximumFractionDigits: 6 })} shares · entry ${px(h.ticker, h.avgPrice)}</div>
            <div class="tiny ${((q && q.price) || h.avgPrice) >= h.avgPrice ? 'up' : 'down'}">Value ${(((Number(h.shares) || 0) * ((q && q.price) || h.avgPrice)) / 0.5).toFixed(2)} WC</div></div>
          <button class="btn btn-sm btn-danger" data-act="spot-sell" data-t="${escSpot(h.ticker)}">Sell</button>
          <button class="btn btn-sm btn-ghost" data-act="spot-edit" data-t="${escSpot(h.ticker)}">TP/SL</button>
        </div>`;
      }).join('')}
    </div>`;
  }

  function mountDashboard() {
    if (!document.querySelector('.inv-hero')) return;
    if (document.getElementById('spotPositionsCard')) return;
    const html = allPositionsHTML();
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
    const value = shares * price / 0.5;
    const pnl = value - invested;
    const set = (sel, txt) => { const n = el.querySelector(sel); if (n) n.textContent = txt; };
    set('[data-spot-qty]', shares.toLocaleString(undefined, { maximumFractionDigits: 6 }));
    set('[data-spot-entry]', px(S.ticker, avg));
    set('[data-spot-invested]', invested.toFixed(2) + ' WC ($' + (invested * 0.5).toFixed(2) + ')');
    set('[data-spot-value]', value.toFixed(2) + ' WC ($' + (value * 0.5).toFixed(2) + ')');
    const pn = el.querySelector('[data-spot-pnl]');
    if (pn) { pn.textContent = (pnl >= 0 ? '+' : '−') + Math.abs(pnl).toFixed(2) + ' WC (' + (pnl >= 0 ? '+' : '−') + '$' + Math.abs(pnl * 0.5).toFixed(2) + ')'; pn.className = pnl >= 0 ? 'up' : 'down'; }
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
      const tp = Number((document.getElementById('spotInlineTp') || {}).value) || 0;
      const sl = Number((document.getElementById('spotInlineSl') || {}).value) || 0;
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
      if (!ed.hidden) { const i = document.getElementById('spotInlineTp'); if (i) i.focus(); }
    };

    App.spotEdit = function (id, ds) {
      const ticker = ds.t || S.ticker;
      const h = holdingFor(ticker); if (!h) return tmsg('No open position', 'err');
      const q = qFor(ticker);
      openModal(modalShell('TP / SL · ' + label(ticker), `
        <div class="tiny muted" style="margin-bottom:10px">Live price ${q ? px(ticker, q.price) : '—'}. TP must be above, SL below.</div>
        <div class="field"><label class="label">Take Profit price</label>
          <input class="input" id="spotEditTp" type="number" step="0.01" value="${Number(h.takeProfitPrice) > 0 ? h.takeProfitPrice : ''}" placeholder="optional"/></div>
        <div class="field"><label class="label">Stop Loss price</label>
          <input class="input" id="spotEditSl" type="number" step="0.01" value="${Number(h.stopLossPrice) > 0 ? h.stopLossPrice : ''}" placeholder="optional"/></div>`,
        `<button class="btn btn-ghost" data-close style="flex:1">Cancel</button>
         <button class="btn btn-primary" id="spotTpSave" style="flex:1">Save</button>`), { locked: false });
      document.getElementById('spotTpSave').onclick = async () => {
        const tp = Number(document.getElementById('spotEditTp').value) || 0;
        const sl = Number(document.getElementById('spotEditSl').value) || 0;
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
