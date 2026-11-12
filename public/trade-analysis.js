/* =========================================================================
   WhaleChat active trade analysis
   - TradingView technical-analysis widget (gauge + stats) for the traded symbol
   - TradingView mini chart showing real-time price movement (green up / red down)
   - live earnings / losses ticking in real time
   - red Buy + blue Sell controls attached below both charts (Sell turns blue
     only while the trade is in profit; red while it is running a loss)
   No Alpaca or Finnhub chart is rendered on the stock page any more.
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined') return;
  const TA = window.WC_TA = window.WC_TA || {};
  const TECH_URL = 'https://widgets.tradingview-widget.com/w/en/tv-technical-analysis.js';
  const MINI_URL = 'https://widgets.tradingview-widget.com/w/en/tv-mini-chart.js';
  TA.interval = '15';
  TA.ticker = '';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function apiPath(p) {
    try { if (typeof Remote !== 'undefined' && Remote && Remote.enabled) return Remote.url(p); } catch (e) {}
    return p;
  }
  async function postJSON(pathname, body, timeout) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout || 25000);
    try {
      const res = await fetch(apiPath(pathname), {
        method: 'POST', signal: ctrl.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(() => null);
      return { res, data };
    } finally { clearTimeout(timer); }
  }
  function tmsg(msg, type) { if (typeof toast === 'function') toast(msg, type || 'ok'); }
  function meId() { try { return me().id; } catch (e) { return ''; } }
  function holding(ticker) { try { return INV.holding(ticker, meId()); } catch (e) { return null; } }
  function quote(ticker) { try { return INV.quote(ticker); } catch (e) { return null; } }
  function usdText(v) { return (typeof usd === 'function') ? usd(v) : '$' + (Number(v) || 0).toFixed(2); }
  function px(ticker, v) {
    try { return INV.priceText ? INV.priceText(ticker, v) : usdText(v); } catch (e) { return usdText(v); }
  }

  function symbolFor(ticker) {
    const t = String(ticker || '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
    let ex = '';
    try { ex = String((INV.stock(t) || {}).exchange || '').toUpperCase(); } catch (e) {}
    const known = { NASDAQ: 'NASDAQ', NYSE: 'NYSE', AMEX: 'AMEX', ARCA: 'AMEX', BATS: 'BATS', OTC: 'OTC' };
    const prefix = known[ex] || 'NASDAQ';
    return prefix + ':' + t;
  }

  /* ------------------------------- scripts -------------------------------- */
  let scriptPromise = null;
  function loadModule(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.type = 'module';
      s.src = src;
      s.async = true;
      s.onload = () => resolve(src);
      s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.appendChild(s);
      setTimeout(() => resolve(src), 9000);
    });
  }
  function ensureScripts() {
    if (!scriptPromise) {
      scriptPromise = Promise.all([loadModule(TECH_URL), loadModule(MINI_URL)])
        .then(() => { TA.loaded = true; return true; })
        .catch((e) => { TA.error = e.message; return false; });
    }
    return scriptPromise;
  }

  /* -------------------------------- markup -------------------------------- */
  function rootHTML(ticker, sym) {
    return `<div class="ta-root" id="taRoot" data-ticker="${esc(ticker)}">
      <div class="ta-head">
        <div>
          <div class="ta-title">Active trade analysis</div>
          <div class="ta-sub">${esc(symbolFor(ticker))} · ${TA.interval}-min technical rating · real-time market chart</div>
        </div>
        <span class="ta-live"><i></i>Live</span>
      </div>

      <div class="ta-chart-block">
        <div class="ta-chart-label">Technical analysis</div>
        <div class="ta-tech" id="taTech">
          <tv-technical-analysis symbol="${esc(sym)}" interval="${TA.interval}"
            ratings-display-mode="gauge-and-stats" ratings-mode="multiple"></tv-technical-analysis>
        </div>
      </div>

      <div class="ta-chart-block ta-mini-block" id="taMiniBlock">
        <div class="ta-chart-label">Live price movement <span class="ta-trend" id="taTrend">—</span></div>
        <div class="ta-mini" id="taMini">
          <tv-mini-chart symbol="${esc(sym)}"></tv-mini-chart>
        </div>
      </div>

      <div class="ta-ledger" id="taLedger">
        <div class="ta-side"><span>Trade value</span><b id="taValue">—</b></div>
        <div class="ta-side"><span>Entry price</span><b id="taEntry">—</b></div>
        <div class="ta-side"><span>Live price</span><b id="taPrice">—</b></div>
      </div>
      <div class="ta-pnl" id="taPnl"><span class="ta-pnl-label">No active trade</span><b class="ta-pnl-value">—</b>
        <span class="ta-pnl-note">Buy below to open a trade and start counting earnings in real time.</span></div>

      <div class="ta-actions">
        <button class="btn ta-buy" data-act="ta-buy" data-t="${esc(ticker)}">Buy</button>
        <button class="btn ta-sell" id="taSellBtn" data-act="ta-sell" data-t="${esc(ticker)}" disabled>Sell</button>
        <button class="btn ta-tpsl" data-act="ta-tpsl" data-t="${esc(ticker)}" id="taTpslBtn" disabled>TP / SL</button>
      </div>
      <div class="ta-foot" id="taFoot">The red Buy button opens a trade · the Sell button turns blue while you are in profit and ends the trade at the live price.</div>
    </div>`;
  }

  /* --------------------------------- mount -------------------------------- */
  TA.mount = function (host, ticker, tf) {
    if (!host || !ticker) return;
    const t = String(ticker).toUpperCase();
    if (host.getAttribute('data-ta') === '1' && host.querySelector('#taRoot')) {
      TA.ticker = t;
      TA.paint();
      return;
    }
    TA.ticker = t;
    TA.tf = tf || '1D';
    host.__wcLwc = true;
    host.removeAttribute('data-chart');
    host.classList.add('wc-ta-host');
    host.classList.remove('wc-chart-host');
    const card = host.closest('.inv-pricecard');
    if (card) card.classList.add('wc-ta-mode');
    const sym = symbolFor(t);
    host.setAttribute('data-ta', '1');
    host.innerHTML = rootHTML(t, sym);

    try {
      if (window.WC_MARKET) window.WC_MARKET.chartMeta = { ticker: t, tf: TA.tf, source: 'analysis', at: Date.now() };
    } catch (e) {}

    ensureScripts().then((ok) => {
      if (!ok) {
        const mini = document.getElementById('taMini');
        if (mini) mini.innerHTML = '<div class="ta-widget-fallback">TradingView widgets could not load on this network — live prices are still shown above.</div>';
        const tech = document.getElementById('taTech');
        if (tech) tech.innerHTML = '<div class="ta-widget-fallback">Technical rating unavailable offline.</div>';
      }
    });

    const sell = document.getElementById('taSellBtn');
    const tpsl = document.getElementById('taTpslBtn');
    if (sell) sell.disabled = !holding(t);
    if (tpsl) tpsl.disabled = !holding(t);
    TA.paint();
  };

  /* ------------------------------ live paint ------------------------------- */
  TA.paint = function () {
    const root = document.getElementById('taRoot');
    if (!root) return;
    const ticker = TA.ticker;
    const q = quote(ticker);
    const h = holding(ticker);
    const price = q && Number(q.price) > 0 ? Number(q.price) : 0;
    const lastPx = TA._lastPrice;
    const dir = price && lastPx ? (price > lastPx ? 1 : price < lastPx ? -1 : 0) : 0;
    if (price) TA._lastPrice = price;

    const set = (id, txt) => { const n = document.getElementById(id); if (n) n.textContent = txt; };
    if (price > 0) set('taPrice', px(ticker, price));
    else set('taPrice', '—');

    const trend = document.getElementById('taTrend');
    const miniBlock = document.getElementById('taMiniBlock');
    const mini = document.getElementById('taMini');
    const cls = dir > 0 || (!dir && q && Number(q.changePct) >= 0) ? 'up' : 'down';
    [trend, miniBlock, mini].forEach((n) => {
      if (!n) return;
      n.classList.remove('up', 'down');
      n.classList.add(cls);
    });
    if (trend) trend.textContent = cls === 'up' ? '▲ rising' : '▼ falling';
    if (q) {
      const chg = Number(q.changePct) || 0;
      if (trend) trend.textContent = (chg >= 0 ? '▲ +' : '▼ ') + chg.toFixed(2) + '% today';
    }

    const sell = document.getElementById('taSellBtn');
    const tpsl = document.getElementById('taTpslBtn');
    if (sell) sell.disabled = !h;
    if (tpsl) tpsl.disabled = !h;

    const pnlEl = document.getElementById('taPnl');
    if (!h) {
      set('taValue', '—');
      set('taEntry', '—');
      if (pnlEl) {
        pnlEl.className = 'ta-pnl';
        pnlEl.innerHTML = '<span class="ta-pnl-label">No active trade</span><b class="ta-pnl-value">—</b>' +
          '<span class="ta-pnl-note">Buy below to open a trade — earnings and losses then count here in real time.</span>';
      }
      if (sell) sell.className = 'btn ta-sell';
      if (sell) sell.textContent = 'Sell';
      return;
    }

    const shares = Number(h.shares) || 0;
    const entry = Number(h.avgPrice) || 0;
    const investedUsd = Number(h.investedUsd) > 0 ? Number(h.investedUsd) : shares * entry;
    const valueUsd = shares * (price || entry);
    const plUsd = valueUsd - investedUsd;
    const plCoins = plUsd / 0.5;
    const plPct = investedUsd > 0 ? (plUsd / investedUsd) * 100 : 0;
    const up = plUsd >= 0;

    set('taValue', usdText(valueUsd) + ' · ' + (valueUsd / 0.5).toFixed(2) + ' WC');
    set('taEntry', px(ticker, entry));

    if (sell) {
      sell.className = 'btn ta-sell ' + (up ? 'profit' : 'loss');
      sell.textContent = up ? 'Sell · take profit' : 'Sell · stop loss';
    }
    if (pnlEl) {
      pnlEl.className = 'ta-pnl ' + (up ? 'up' : 'down');
      pnlEl.innerHTML =
        '<span class="ta-pnl-label">' + (up ? 'Earnings' : 'Losses') + '</span>' +
        '<b class="ta-pnl-value">' + (up ? '+' : '−') + usdText(Math.abs(plUsd)) +
        ' <i>(' + (up ? '+' : '−') + Math.abs(plCoins).toFixed(2) + ' WC · ' + (up ? '+' : '−') + Math.abs(plPct).toFixed(2) + '%)</i></b>' +
        '<span class="ta-pnl-note">' + (up ? 'Counting up live until you sell or a TP/SL level closes the trade.' : 'Counting against the trade live — sell to stop the loss or wait for your stop loss.') + '</span>';
    }
  };

  const timer = setInterval(() => {
    try { if (document.getElementById('taRoot') && !document.hidden) TA.paint(); } catch (e) {}
  }, 1000);

  /* --------------------------------- buy ---------------------------------- */
  if (typeof App !== 'undefined') {
    App.taBuy = function (id, ds) {
      const ticker = (ds && ds.t) || TA.ticker;
      if (typeof Remote === 'undefined' || !Remote.enabled) return tmsg('Connect the sync server to trade', 'err');
      const q = quote(ticker);
      const live = q && Number(q.price) > 0 ? Number(q.price) : 0;
      if (!live) return tmsg('Waiting for a live quote', 'err');
      const last = Number(TA.lastUsd) > 0 ? Number(TA.lastUsd) : 100;
      openModal(modalShell('Buy ' + ticker, `
        <div class="tiny muted" style="margin-bottom:10px">Live price ${px(ticker, live)} · ${(live * 2).toFixed(2)} WC. 1 WC = $0.50.</div>
        <div class="field"><label class="label">Amount in USD</label>
          <div class="input-wrap"><span class="inv-prefix">$</span>
            <input class="input" id="taBuyUsd" type="number" step="0.01" min="1" value="${last}"/></div>
          <div class="tiny muted" id="taBuyPreview" style="margin-top:5px"></div></div>
        <div class="row" style="gap:8px">
          <div class="field grow"><label class="label">Take profit (%)</label>
            <input class="input" id="taBuyTp" type="number" step="0.1" min="0" placeholder="optional"/></div>
          <div class="field grow"><label class="label">Stop loss (%)</label>
            <input class="input" id="taBuySl" type="number" step="0.1" min="0" placeholder="optional"/></div>
        </div>
        <div class="field"><label class="label">Due time</label>
          <select class="input" id="taBuyDue">
            <option value="0">No expiry</option>
            <option value="15">15 minutes</option>
            <option value="60">1 hour</option>
            <option value="240">4 hours</option>
            <option value="1440">1 day</option>
            <option value="10080">7 days</option>
          </select></div>
        <div class="tiny muted">TP/SL are watched on the backend every second and close the whole position at the live price.</div>`,
        `<button class="btn btn-ghost" data-close style="flex:1">Cancel</button>
         <button class="btn btn-primary" id="taBuyGo" style="flex:1">Buy now</button>`), { locked: false });

      const amountEl = document.getElementById('taBuyUsd');
      const preview = () => {
        const usdAmt = Number(amountEl && amountEl.value) || 0;
        const pv = document.getElementById('taBuyPreview');
        if (!pv) return;
        pv.innerHTML = usdAmt > 0
          ? '<b>' + usdText(usdAmt) + '</b> = <b>' + (usdAmt / 0.5).toFixed(2) + ' WC</b> · ' + (usdAmt / live).toFixed(6) + ' shares'
          : 'Enter a USD amount.';
      };
      if (amountEl) amountEl.addEventListener('input', preview);
      preview();

      document.getElementById('taBuyGo').onclick = async () => {
        const amountUsd = Number((document.getElementById('taBuyUsd') || {}).value) || 0;
        if (!(amountUsd >= 1)) return tmsg('Enter at least $1', 'err');
        const tpPct = Number((document.getElementById('taBuyTp') || {}).value) || 0;
        const slPct = Number((document.getElementById('taBuySl') || {}).value) || 0;
        const dueMin = Number((document.getElementById('taBuyDue') || {}).value) || 0;
        const body = { userId: meId(), ticker, amountUsd };
        if (tpPct > 0) body.tpPrice = Math.round(live * (1 + tpPct / 100) * 10000) / 10000;
        if (slPct > 0) body.slPrice = Math.round(live * (1 - slPct / 100) * 10000) / 10000;
        if (dueMin > 0) body.dueTime = Date.now() + dueMin * 60000;
        try {
          const r = await postJSON('/api/market/spot/buy', body, 30000);
          if (!r.res || !r.res.ok || !r.data || !r.data.ok) return tmsg((r.data && r.data.error) || 'Buy failed', 'err');
          TA.lastUsd = amountUsd;
          closeModal();
          try { await Remote.refresh(true); } catch (e) {}
          tmsg('Bought ' + Number(r.data.order.shares).toLocaleString(undefined, { maximumFractionDigits: 6 }) + ' ' + ticker, 'ok');
          if (typeof render === 'function') render();
        } catch (e) { tmsg('Buy failed: ' + e.message, 'err'); }
      };
    };

    /* ------------------------------- sell --------------------------------- */
    App.taSell = async function (id, ds) {
      const ticker = (ds && ds.t) || TA.ticker;
      const h = holding(ticker);
      if (!h) return tmsg('No open position', 'err');
      if (typeof Remote === 'undefined' || !Remote.enabled) return tmsg('Connect the sync server to sell', 'err');
      const q = quote(ticker);
      const price = q && Number(q.price) > 0 ? Number(q.price) : Number(h.avgPrice) || 0;
      const invested = Number(h.investedUsd) > 0 ? Number(h.investedUsd) : (Number(h.shares) || 0) * Number(h.avgPrice);
      const value = (Number(h.shares) || 0) * price;
      const pl = value - invested;
      const up = pl >= 0;
      if (typeof confirmDialog === 'function') {
        const ok = await confirmDialog({
          title: (up ? 'Take profit · ' : 'Stop loss · ') + ticker + '?',
          body: 'Sell ' + Number(h.shares).toLocaleString(undefined, { maximumFractionDigits: 6 }) + ' shares at the live price ' + px(ticker, price) +
            '. ' + (up ? 'Earnings ' : 'Losses ') + (up ? '+' : '−') + usdText(Math.abs(pl)) + '.',
          ok: up ? 'Take profit' : 'Sell now',
          danger: !up
        });
        if (!ok) return;
      }
      try {
        const r = await postJSON('/api/market/spot/sell', { userId: meId(), ticker }, 30000);
        if (!r.res || !r.res.ok || !r.data || !r.data.ok) return tmsg((r.data && r.data.error) || 'Sell failed', 'err');
        try { await Remote.refresh(true); } catch (e) {}
        tmsg('Sold · ' + Number(r.data.payout).toFixed(2) + ' WC (' + usdText(Number(r.data.payout) * 0.5) + ') credited', 'ok');
        if (typeof render === 'function') render();
      } catch (e) { tmsg('Sell failed: ' + e.message, 'err'); }
    };

    App.taTpsl = function (id, ds) {
      const ticker = (ds && ds.t) || TA.ticker;
      if (typeof App.spotEdit === 'function') return App.spotEdit(null, { t: ticker });
      tmsg('TP / SL is available from the position panel below', 'err');
    };
  }

  /* -------------------------------- styles -------------------------------- */
  (function styles() {
    if (document.getElementById('wc-ta-style')) return;
    const st = document.createElement('style');
    st.id = 'wc-ta-style';
    st.textContent = `
    .wc-ta-mode .inv-seg{display:none}
    .wc-ta-host{min-height:320px}
    .ta-root{display:flex;flex-direction:column;gap:10px;padding:2px 0 4px}
    .ta-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
    .ta-title{font-size:13px;font-weight:750;letter-spacing:-.01em}
    .ta-sub{font-size:10.5px;color:var(--muted);margin-top:2px;line-height:1.45}
    .ta-live{display:inline-flex;align-items:center;gap:5px;font-size:9px;font-weight:800;letter-spacing:.08em;
      text-transform:uppercase;color:var(--success);border:1px solid rgba(34,197,94,.3);
      background:rgba(34,197,94,.1);border-radius:99px;padding:3px 8px;white-space:nowrap}
    .ta-live i{width:6px;height:6px;border-radius:50%;background:#22c55e;animation:taPulse 1.2s ease-in-out infinite}
    @keyframes taPulse{0%,100%{opacity:.35;transform:scale(.8)}50%{opacity:1;transform:scale(1.15)}}
    .ta-chart-block{border:1px solid var(--border);border-radius:12px;background:var(--surface-2);padding:8px 9px 6px}
    .ta-chart-label{font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted-2);font-weight:750;
      display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px}
    .ta-tech{min-height:170px;display:flex;justify-content:center;align-items:center}
    .ta-tech tv-technical-analysis,.ta-mini tv-mini-chart{display:block;width:100%}
    .ta-mini-block{transition:border-color .2s,box-shadow .2s}
    .ta-mini-block.up{border-color:rgba(34,197,94,.38);box-shadow:0 0 0 1px rgba(34,197,94,.10),0 10px 26px rgba(34,197,94,.06)}
    .ta-mini-block.down{border-color:rgba(239,68,68,.40);box-shadow:0 0 0 1px rgba(239,68,68,.10),0 10px 26px rgba(239,68,68,.06)}
    .ta-trend{font-size:10px;font-weight:750}
    .ta-mini-block.up .ta-trend{color:var(--success)} .ta-mini-block.down .ta-trend{color:var(--danger)}
    .ta-mini{min-height:120px}
    .ta-widget-fallback{padding:22px 12px;text-align:center;font-size:11.5px;color:var(--muted);line-height:1.6}
    .ta-ledger{display:grid;grid-template-columns:repeat(3,1fr);gap:7px}
    .ta-side{display:flex;flex-direction:column;gap:1px;padding:7px 9px;border:1px solid var(--border);border-radius:9px;background:var(--surface-2)}
    .ta-side span{font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-2);font-weight:750}
    .ta-side b{font-size:11.5px;font-variant-numeric:tabular-nums}
    .ta-pnl{display:flex;flex-direction:column;gap:2px;padding:10px 11px;border-radius:11px;border:1px solid var(--border);background:var(--surface-2)}
    .ta-pnl-label{font-size:9.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted-2);font-weight:800}
    .ta-pnl-value{font-size:19px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.15}
    .ta-pnl-value i{font-style:normal;font-size:11px;font-weight:650;color:var(--muted)}
    .ta-pnl-note{font-size:10.5px;color:var(--muted);line-height:1.5}
    .ta-pnl.up{border-color:rgba(34,197,94,.3);background:rgba(34,197,94,.06)}
    .ta-pnl.up .ta-pnl-value{color:var(--success)}
    .ta-pnl.down{border-color:rgba(239,68,68,.32);background:rgba(239,68,68,.06)}
    .ta-pnl.down .ta-pnl-value{color:var(--danger)}
    .ta-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:2px}
    .ta-actions .btn{min-height:46px;flex:1 1 130px;font-weight:800;letter-spacing:.01em}
    .ta-buy{background:linear-gradient(135deg,#ef4444,#b91c1c);border:1px solid rgba(239,68,68,.5);color:#fff;
      box-shadow:0 10px 24px rgba(239,68,68,.20)}
    .ta-buy:hover{background:linear-gradient(135deg,#f05252,#c81e1e)}
    .ta-sell{background:rgba(255,255,255,.05);border:1px solid var(--border);color:var(--muted)}
    .ta-sell.profit{background:linear-gradient(135deg,#3aa0ff,#1d6fd8);border-color:rgba(58,160,255,.55);color:#fff;
      box-shadow:0 10px 24px rgba(58,160,255,.24)}
    .ta-sell.profit:hover{background:linear-gradient(135deg,#4aa8ff,#2480e8)}
    .ta-sell.loss{background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.4);color:#ffb4b4}
    .ta-sell:disabled{opacity:.45;box-shadow:none}
    .ta-tpsl{flex:0 1 96px!important;background:rgba(255,255,255,.04);border:1px solid var(--border);color:var(--muted)}
    .ta-foot{font-size:10px;color:var(--muted-2);line-height:1.55}
    @media(max-width:520px){
      .ta-ledger{grid-template-columns:1fr 1fr}
      .ta-side:last-child{grid-column:1/-1}
      .ta-actions .btn{flex:1 1 100%}
      .ta-tpsl{flex:1 1 100%!important}
      .ta-pnl-value{font-size:17px}
    }`;
    document.head.appendChild(st);
  })();
})();
